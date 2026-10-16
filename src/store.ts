/**
 * Persistent run store. Everything the orchestrator, supervisor and report
 * need lives here so a failed/interrupted run can be resumed and audited.
 *
 * Layout inside the target project:
 *   <project>/.oae/state.json    — current run state (atomic writes)
 *   <project>/.oae/events.jsonl  — append-only event log
 */
import { join } from "node:path";
import { appendJsonl, nowISO, readJson, writeJsonAtomic } from "./util.ts";
import { archivePreviousRun } from "./history.ts";

export type TaskStatus =
  | "pending" | "in_progress" | "awaiting_review" | "rework"
  | "done" | "failed" | "blocked" | "cancelled";

export interface Attempt {
  id: number;
  sessionId: string;
  agent: string;
  kind: "code" | "review" | "recovery" | "diagnosis" | "provider_retry";
  startedAt: string;
  endedAt?: string;
  outcome: "running" | "completed" | "failed" | "interrupted" | "rejected" | "approved";
  summary: string;
  filesChanged: string[];
  evidence: Record<string, string>;  // name -> note/extract
}

export interface Task {
  id: string;
  title: string;
  instructions: string;
  dependsOn: string[];
  acceptance: string[];
  status: TaskStatus;
  attempts: Attempt[];
  recoveryCycles: number;
  createdAt: string;
  updatedAt: string;
  blockedReason?: string;
  commit?: string;
}

export interface Decision {
  id: string;
  at: string;
  by: "orchestrator" | "supervisor" | "reviewer" | "coder" | "planner";
  kind: "technical" | "business-hypothesis" | "needs-approval";
  text: string;
  rationale: string;
}

export type RunStatus = "running" | "done" | "failed" | "cancelled" | "interrupted";

export interface RunState {
  id: string;
  request: string;
  projectDir: string;
  startedAt: string;
  endedAt?: string;
  status: RunStatus;
  git: { branch: string; baselineCommit?: string; baselineUncommitted?: string[]; worktree?: string };
  tasks: Task[];
  decisions: Decision[];
  validatorResults: Record<string, { name: string; code: number | null; timedOut: boolean; at: string }[]>;
  summary?: string;
}

export class Store {
  private file: string;
  private eventsFile: string;
  state!: RunState;

  constructor(projectDir: string, runId: string) {
    const dir = join(projectDir, ".oae");
    this.file = join(dir, "state.json");
    this.eventsFile = join(dir, "events.jsonl");
  }

  static async create(projectDir: string, runId: string, request: string): Promise<Store> {
    const s = new Store(projectDir, runId);
    const existing = await Store.load(projectDir, runId);
    if (existing && existing.state.id === runId) return existing; // resume the same run
    // a NEW run replaces the previous one — archive it first (additive
    // preservation; `oae history` keeps it readable after the overwrite)
    await archivePreviousRun(projectDir, runId);
    s.state = {
      id: runId,
      request,
      projectDir,
      startedAt: nowISO(),
      status: "running",
      git: { branch: "" },
      tasks: [],
      decisions: [],
      validatorResults: {},
    };
    await s.persist();
    return s;
  }

  /** Loads state.json for the latest run in the project (used by status/report/resume). */
  static async load(projectDir: string, _runId?: string): Promise<Store | undefined> {
    const s = new Store(projectDir, _runId ?? "");
    const state = await readJson<RunState>(s.file);
    if (!state) return undefined;
    s.state = state;
    return s;
  }

  static async loadLatest(projectDir: string): Promise<Store | undefined> {
    return Store.load(projectDir);
  }

  async persist(): Promise<void> {
    await writeJsonAtomic(this.file, this.state);
  }

  async event(kind: string, data: Record<string, unknown>): Promise<void> {
    await appendJsonl(this.eventsFile, { ...data, at: nowISO(), kind });
  }

  task(id: string): Task {
    const t = this.state.tasks.find((x) => x.id === id);
    if (!t) throw new Error(`Unknown task ${id}`);
    return t;
  }

  async addTask(t: Omit<Task, "attempts" | "recoveryCycles" | "createdAt" | "updatedAt" | "status">): Promise<Task> {
    const task: Task = {
      ...t,
      status: "pending",
      attempts: [],
      recoveryCycles: 0,
      createdAt: nowISO(),
      updatedAt: nowISO(),
    };
    this.state.tasks.push(task);
    await this.persist();
    await this.event("task_added", { taskId: task.id, title: task.title });
    return task;
  }

  async updateTask(id: string, patch: Partial<Task>): Promise<Task> {
    const t = this.task(id);
    Object.assign(t, patch, { updatedAt: nowISO() });
    await this.persist();
    await this.event("task_updated", { taskId: id, status: t.status, patch: Object.keys(patch) });
    return t;
  }

  async addAttempt(taskId: string, a: Omit<Attempt, "id">): Promise<Attempt> {
    const t = this.task(taskId);
    const attempt: Attempt = { ...a, id: t.attempts.length + 1 };
    t.attempts.push(attempt);
    t.updatedAt = nowISO();
    await this.persist();
    await this.event("attempt_added", { taskId, attemptId: attempt.id, attemptKind: a.kind, outcome: a.outcome });
    return attempt;
  }

  /** Non-observational attempt patch (kind/outcome corrections by the orchestrator). */
  async patchAttempt(taskId: string, attemptId: number, patch: Partial<Attempt>): Promise<void> {
    const t = this.task(taskId);
    const a = t.attempts.find((x) => x.id === attemptId);
    if (!a) throw new Error(`Unknown attempt ${attemptId} on ${taskId}`);
    Object.assign(a, patch);
    t.updatedAt = nowISO();
    await this.persist();
  }

  async finishAttempt(taskId: string, attemptId: number, patch: Partial<Attempt>): Promise<void> {
    const t = this.task(taskId);
    const a = t.attempts.find((x) => x.id === attemptId);
    if (!a) throw new Error(`Unknown attempt ${attemptId} on ${taskId}`);
    const startedAt = a.startedAt;
    Object.assign(a, patch, { endedAt: nowISO() });
    t.updatedAt = nowISO();
    await this.persist();
    const elapsedMs = Math.max(0, Date.parse(a.endedAt!) - Date.parse(startedAt));
    await this.event("attempt_finished", {
      taskId, attemptId, attemptKind: a.kind, outcome: a.outcome,
      sessionId: a.sessionId, elapsedMs,
    });
  }

  async decide(d: Omit<Decision, "id" | "at">): Promise<Decision> {
    const dec: Decision = { ...d, id: "dec-" + (this.state.decisions.length + 1), at: nowISO() };
    this.state.decisions.push(dec);
    await this.persist();
    await this.event("decision", { decisionId: dec.id, kind: dec.kind, by: dec.by });
    return dec;
  }

  async recordValidator(name: string, code: number | null, timedOut: boolean): Promise<void> {
    const list = this.state.validatorResults[name] ?? [];
    list.push({ name, code, timedOut, at: nowISO() });
    this.state.validatorResults[name] = list;
    await this.persist();
    await this.event("validator", { name, code, timedOut });
  }
}
