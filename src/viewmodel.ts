/**
 * Deterministic projection: <project>/.oae/state.json + events.jsonl → RunView.
 *
 * The panel never talks to the OpenCode service and never calls an LLM —
 * every number displayed here is read back from OAE's own persisted state
 * and event log. Derivation rules are pure functions of that data plus an
 * injectable clock, so the projection is reproducible and testable.
 *
 * Semantics enforced by this module:
 *  - zero is distinguished from unknown: a missing usage record yields
 *    `unknown: true` and contributes nothing, instead of faking zeros;
 *  - attempts are never double-counted (state.attempts is the single source
 *    of truth for tokens; events only drive the timeline);
 *  - unknown event kinds are preserved as opaque timeline entries rather
 *    than dropped, so older/newer event logs remain readable.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readJson } from "./util.ts";
import { readRunLock } from "./runlock.ts";
import { effectiveStatus, lastEvidenceAt, probeOwner } from "./reconcile.ts";
import type { Attempt, RunState } from "./store.ts";
import type { OaeEvent } from "./events.ts";

export type RunViewLevel = "info" | "warn" | "error" | "success";

/** Token metrics of one attempt with a provenance flag. */
export interface TokenView {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** false = confirmed values read from the service; true = not recorded. */
  unknown: boolean;
}

export interface AttemptView {
  id: number;
  kind: string;
  agent: string;
  outcome: string;
  sessionId: string;
  startedAt: string;
  endedAt?: string;
  elapsedMs?: number;
  tokens?: TokenView;
}

export interface TaskView {
  id: string;
  title: string;
  status: string;
  attempts: AttemptView[];
  codeAttempts: number;
  recoveryCycles: number;
  commit?: string;
  blockedReason?: string;
}

export interface TimelineView {
  at: string;
  type: string;
  label: string;
  level: RunViewLevel;
  /** Task/attempt scoping when applicable. */
  scope?: string;
}

export interface RunView {
  id: string;
  request: string;
  projectDir: string;
  status: string;
  /** Derived operational phase while status="running"; terminal otherwise. */
  phase: RunPhase;
  /** True when a `running` run was reclassified because its lock owner is gone. */
  orphaned?: boolean;
  /** Owner liveness evidence backing the (possibly reclassified) status. */
  ownerState?: "alive" | "dead" | "unknown";
  ownerReason?: string;
  startedAt: string;
  endedAt?: string;
  elapsedMs: number;
  nowMs: number;
  tasks: TaskView[];
  timeline: TimelineView[];
  validators: { name: string; code: number | null; timedOut: boolean; at: string }[];
  providerErrors: { at: string; runnerKind: string; httpStatus?: number; message: string; tokensUnknown?: boolean }[];
  retries: { at: string; taskId?: string; attemptNo?: number; reason: string; waitMs?: number }[];
  tokens: { totals: TokenView; recordedAttempts: number; attemptsWithTokens: number };
  lastConfirmedActivity?: { at: string; label: string };
  /** seconds since the last confirmed activity (running runs only). */
  secondsSinceActivity?: number;
  /** no verifiable progress for this many ms (derived alert, not a fact by itself). */
  stallMs?: number;
  summary?: string;
}

export type RunPhase =
  | "inicializando" | "planejando" | "executando" | "validando" | "revisando"
  | "em nova tentativa" | "aguardando" | "sem progresso detectável"
  | "concluída" | "falhou" | "interrompida (processo ausente)" | "cancelada";

async function readEventsFile(projectDir: string): Promise<OaeEvent[]> {
  try {
    const raw = await readFile(join(projectDir, ".oae", "events.jsonl"), "utf8");
    return raw.trim().split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as OaeEvent; } catch { return { at: "", kind: "unparseable" }; } });
  } catch {
    return [];
  }
}

function parseTokens(evidence: Record<string, string>): TokenView | undefined {
  const raw = evidence?.["tokens"];
  if (!raw) return undefined;
  try {
    const t = JSON.parse(raw) as { input?: number; output?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number; cost?: number | null };
    return { input: t.input ?? 0, output: t.output ?? 0, reasoning: t.reasoning ?? 0, cacheRead: t.cacheRead ?? 0, cacheWrite: t.cacheWrite ?? 0, cost: t.cost ?? 0, unknown: false };
  } catch {
    return undefined;
  }
}

const UNKNOWN_TOKENS: TokenView = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unknown: true };

export function sumTokens(parts: TokenView[]): TokenView {
  const totals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const p of parts) {
    totals.input += p.input; totals.output += p.output; totals.reasoning += p.reasoning;
    totals.cacheRead += p.cacheRead; totals.cacheWrite += p.cacheWrite; totals.cost += p.cost;
  }
  const unknown = parts.length === 0 || parts.some((p) => p.unknown);
  return { ...totals, unknown };
}

function attemptView(a: Attempt): AttemptView {
  return {
    id: a.id, kind: a.kind, agent: a.agent, outcome: a.outcome, sessionId: a.sessionId,
    startedAt: a.startedAt, endedAt: a.endedAt,
    elapsedMs: a.endedAt ? Math.max(0, Date.parse(a.endedAt) - Date.parse(a.startedAt)) : undefined,
    tokens: parseTokens(a.evidence),
  };
}

function num(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}

function str(x: unknown): string | undefined {
  if (typeof x === "string") return x;
  if (typeof x === "number" && Number.isFinite(x)) return String(x);
  return undefined;
}

const KIND_LABEL: Record<string, string> = {
  run_started: "run_started",
  plan_ready: "plan_ready",
  task_added: "task_added",
  task_updated: "task_updated",
  attempt_added: "agent started",
  attempt_finished: "agent finished",
  agent_progress: "agent activity",
  retry_scheduled: "retry scheduled",
  session_interrupted: "session interrupted",
  provider_error: "provider error",
  validator: "validator",
  decision: "decision",
  supervisor_diagnose: "supervisor diagnosis (no verifiable progress)",
  supervisor_recover: "supervisor recovery (interrupted stalled agent)",
  supervisor_quarantine: "supervisor quarantine (limits reached)",
  task_error: "task error",
  run_finished: "run finished",
  run_reconciled: "run reconciled (owner process gone)",
  unparseable: "unparseable event line",
};

function levelOf(kind: string, ev: OaeEvent): RunViewLevel {
  switch (kind) {
    case "provider_error":
    case "task_error":
    case "supervisor_quarantine":
      return "error";
    case "session_interrupted":
    case "supervisor_diagnose":
    case "supervisor_recover":
      return "warn";
    case "retry_scheduled":
      return "warn";
    case "validator":
      return ev.code === 0 && !ev.timedOut ? "success" : "error";
    case "attempt_finished":
      return ["completed", "approved"].includes(str(ev.outcome) ?? "") ? "success" : "error";
    case "run_finished":
      return ev.status === "done" ? "success" : "error";
    case "run_reconciled":
      return "warn";
    default:
      return "info";
  }
}

/** Timeline labels built from event data only (deterministic narration). */
function evLabel(kind: string, ev: OaeEvent, attemptAgent: Map<string, string>): string {
  switch (kind) {
    case "run_started": return `run started: ${str(ev.request) ?? ""}`.slice(0, 120);
    case "plan_ready": return `plan ready (${str(ev.tasks) ?? "?"} tasks)`;
    case "task_added": return `task added ${str(ev.taskId)}: ${(str(ev.title) ?? "").slice(0, 60)}`;
    case "task_updated": return `task ${str(ev.taskId)} → ${str(ev.status) ?? "?"}`;
    case "attempt_added": return `agent started: attempt ${str(ev.attemptId) ?? "?"} (kind ${str(ev.attemptKind) ?? "?"} — ${attemptAgent.get(`${str(ev.taskId)}:${str(ev.attemptId)}`) ?? "?"})`;
    case "attempt_finished": {
      const sec = Math.round((num(ev.elapsedMs) ?? 0) / 1000);
      return `agent finished: attempt ${str(ev.attemptId) ?? "?"} (${str(ev.attemptKind) ?? "?"}) → ${str(ev.outcome) ?? "?"} [${sec}s]`;
    }
    case "agent_progress": return `activity: ${(str(ev.detail) ?? "").slice(0, 80)}`;
    case "provider_error": return `provider error${num(ev.httpStatus) ? ` (HTTP ${ev.httpStatus})` : ""}: ${(str(ev.message) ?? "").replace(/^provider\/run error: |^runner error: /, "").slice(0, 110)}`;
    case "session_interrupted": return `session interrupted (attempt ${str(ev.attemptId)})`;
    case "retry_scheduled": return `retry scheduled: ${(str(ev.reason) ?? "").slice(0, 70)} (wait ${Math.round((num(ev.waitMs) ?? 0) / 1000)}s)`;
    case "validator": return `validator ${str(ev.name)}: exit=${str(ev.code)}${ev.timedOut ? " (TIMED OUT)" : ""}`;
    case "decision": return `decision [${str(ev.kind)}] by ${str(ev.by)}`;
    case "supervisor_diagnose": return `supervisor diagnosis: task ${str(ev.taskId)} idle ${Math.round((num(ev.idleMs) ?? 0) / 1000)}s`;
    case "supervisor_recover": return `supervisor recovery: task ${str(ev.taskId)} idle ${Math.round((num(ev.idleMs) ?? 0) / 1000)}s`;
    case "supervisor_quarantine": return `supervisor quarantine: task ${str(ev.taskId)}`;
    case "task_error": return `task error ${str(ev.taskId)}: ${(str(ev.error) ?? "").slice(0, 100)}`;
    case "run_finished": return `run finished: ${str(ev.status)}`;
    case "run_reconciled": return `run reconciled: ${str(ev.from) ?? "?"} → ${str(ev.to) ?? "interrupted"} (${str(ev.reason) ?? "owner gone"})`;
    case "unparseable": return "unparseable event line";
    default: {
      const label = str(ev.kind) ? `event: ${ev.kind}` : "event";
      return label;
    }
  }
}

/** Derive the operational phase from the event tail + task states. Pure. */
function derivePhase(state: RunState, status: string, events: OaeEvent[], nowMs: number, stallThresholdMs: number): { phase: RunPhase; stallMs?: number } {
  if (status === "done") return { phase: "concluída" };
  if (status === "failed") return { phase: "falhou" };
  if (status === "cancelled") return { phase: "cancelada" };
  if (status === "interrupted") return { phase: "interrompida (processo ausente)" };
  if (status === "running" && events.length === 0) return { phase: "inicializando" };
  const hasPlan = state.tasks.length > 0 || events.some((e) => e.kind === "plan_ready");
  if (!hasPlan) return { phase: "planejando" };

  // last confirmed activity anywhere in the event log (progress, attempt end, validator)
  const activityKinds = new Set(["agent_progress", "attempt_finished", "validator"]);
  let lastActivityAt = 0;
  let lastActivityLabel = "";
  for (const e of events) {
    if (activityKinds.has(e.kind)) {
      const t = Date.parse(e.at);
      if (Number.isFinite(t) && t >= lastActivityAt) { lastActivityAt = t; lastActivityLabel = e.kind; }
    }
  }
  // legacy runs without agent telemetry: the latest event of any kind is the
  // only verifiable signal available (weaker, but not dismissed)
  if (lastActivityAt === 0 && events.length) {
    for (const e of events) {
      const t = Date.parse(e.at);
      if (Number.isFinite(t) && t >= lastActivityAt) { lastActivityAt = t; lastActivityLabel = e.kind; }
    }
  }
  const stallMs = lastActivityAt > 0 ? Math.max(0, nowMs - lastActivityAt) : undefined;
  const stalled = stallMs !== undefined && stallMs > stallThresholdMs;

  // rework markers after the last attempt_added mean "preparing a retry"
  const lastAttemptAdded = events.findLast((e) => e.kind === "attempt_added");
  const lastAttemptAddedIdx = lastAttemptAdded ? events.indexOf(lastAttemptAdded) : -1;
  const afterLastAttempt = events.slice(lastAttemptAddedIdx + 1);
  const reworkMarkers = new Set(["retry_scheduled", "provider_error", "session_interrupted", "supervisor_recover", "supervisor_quarantine"]);

  // a running attempt means an agent is actively working (or stalled)
  const anyRunningAttempt = state.tasks.some((t) => t.attempts.some((a) => a.outcome === "running"));
  if (anyRunningAttempt) {
    // a still-open attempt is NOT proof of work: past the stall threshold we
    // report "sem progresso detectável" even while an attempt is running
    if (stalled) return { phase: "sem progresso detectável", stallMs };
    return { phase: "executando", stallMs };
  }
  // no running attempt: the task loop is between agents
  if (afterLastAttempt.some((e) => reworkMarkers.has(e.kind))) return { phase: "em nova tentativa", stallMs };
  if (stalled && lastActivityAt > 0) return { phase: "sem progresso detectável", stallMs };
  const lastValidator = events.findLast((e) => e.kind === "validator");
  const lastAgentFinished = events.findLast((e) => e.kind === "attempt_finished");
  if (lastValidator && (!lastAgentFinished || Date.parse(lastValidator.at) >= Date.parse(lastAgentFinished.at))) {
    return { phase: "validando", stallMs };
  }
  return { phase: "aguardando", stallMs };
}

export async function loadRunView(projectDir: string, opts?: { nowMs?: number; stallThresholdMs?: number; isAlive?: (pid: number) => boolean }): Promise<RunView | undefined> {
  const nowMs = opts?.nowMs ?? Date.now();
  const stallThresholdMs = opts?.stallThresholdMs ?? 7 * 60_000;
  const state = await readJson<RunState>(join(projectDir, ".oae", "state.json"));
  if (!state) return undefined;
  const events = await readEventsFile(projectDir);
  // owner liveness evidence: a `running` run whose lock owner is provably gone
  // is projected as `interrupted` — the panel must never show a dead run as active
  const owner = probeOwner(await readRunLock(projectDir), opts?.isAlive);
  const eff = effectiveStatus(state, owner);

  // Attempt views: agent names come from state (events lack them).
  const attemptAgent = new Map<string, string>();
  for (const t of state.tasks) {
    for (const a of t.attempts) attemptAgent.set(`${t.id}:${a.id}`, a.agent);
  }
  const tasks: TaskView[] = state.tasks.map((t) => ({
    id: t.id, title: t.title, status: t.status,
    attempts: t.attempts.map((a) => attemptView(a)),
    codeAttempts: t.attempts.filter((a) => a.kind === "code" || a.kind === "recovery").length,
    recoveryCycles: t.recoveryCycles,
    commit: t.commit, blockedReason: t.blockedReason,
  }));

  const timeline: TimelineView[] = events
    .filter((e) => e.kind !== "agent_progress" || Boolean(e.detail))
    .map((e) => ({
      at: str(e.at) ?? "",
      type: str(e.kind) ?? "event",
      label: evLabel(str(e.kind) ?? "event", e, attemptAgent),
      level: levelOf(str(e.kind) ?? "event", e),
      scope: str(e.taskId) ? `${e.taskId}` : undefined,
    }));

  const providerErrors = events.filter((e) => e.kind === "provider_error").map((e) => ({
    at: str(e.at) ?? "", runnerKind: str(e.runnerKind) ?? "?",
    httpStatus: num(e.httpStatus), message: (str(e.message) ?? "").slice(0, 300),
    tokensUnknown: typeof e.tokensUnknown === "boolean" ? e.tokensUnknown : undefined,
  }));
  const retries = events.filter((e) => e.kind === "retry_scheduled").map((e) => ({
    at: str(e.at) ?? "", taskId: str(e.taskId), attemptNo: num(e.attemptNo),
    reason: str(e.reason) ?? "", waitMs: num(e.waitMs),
  }));

  const validators = Object.values(state.validatorResults).flat();
  const tokenParts = state.tasks.flatMap((t) => t.attempts.map((a) => parseTokens(a.evidence)).filter((x): x is TokenView => Boolean(x)));
  const totals = sumTokens(tokenParts);
  // partial telemetry: totals over known values only must not be presented
  // as complete knowledge (confirmed zeros never become "unknown", but a
  // run where some attempts lack usage records shows an unknown tail)
  const recordedAttempts = state.tasks.reduce((n, t) => n + t.attempts.length, 0);
  if (recordedAttempts > tokenParts.length || tokenParts.some((p) => p.unknown)) {
    totals.unknown = true;
  }

  // last confirmed activity (from the timeline; running runs only)
  let lastConfirmed: { at: string; label: string } | undefined;
  for (const t of timeline) {
    if (["agent_progress", "attempt_finished", "validator"].includes(t.type)) lastConfirmed = { at: t.at, label: t.label };
  }
  // legacy runs (pre-instrumentation) have no agent telemetry at all: fall
  // back to the latest event line so stall detection still works, clearly
  // labelled as a weaker signal
  if (eff.status === "running" && !lastConfirmed && timeline.length) {
    const last = timeline.at(-1)!;
    lastConfirmed = { at: last.at, label: `${last.label} (sem telemetria de agente nesta execução)` };
  }
  let secondsSinceActivity: number | undefined;
  let stallMs: number | undefined;
  if (eff.status === "running" && lastConfirmed) {
    secondsSinceActivity = Math.max(0, Math.round((nowMs - Date.parse(lastConfirmed.at)) / 1000));
    if (secondsSinceActivity * 1000 > stallThresholdMs) stallMs = secondsSinceActivity * 1000;
  }
  const derivedPhase = derivePhase(state, eff.status, events, nowMs, stallThresholdMs);
  // a projected (not yet persisted) interruption is bounded by the last
  // recorded evidence, exactly like the persisted reconciliation — never "now"
  const displayEndedAt = state.endedAt ?? (eff.orphaned ? lastEvidenceAt(state) : undefined);

  return {
    id: state.id,
    request: state.request,
    projectDir,
    status: eff.status,
    phase: derivedPhase.phase,
    orphaned: eff.orphaned,
    ownerState: owner.state,
    ownerReason: eff.orphaned ? eff.reason : undefined,
    startedAt: state.startedAt,
    endedAt: displayEndedAt,
    elapsedMs: Math.max(0, (displayEndedAt ? Date.parse(displayEndedAt) : nowMs) - Date.parse(state.startedAt)),
    nowMs,
    tasks,
    timeline,
    validators,
    providerErrors,
    retries,
    tokens: {
      totals,
      recordedAttempts,
      attemptsWithTokens: tokenParts.length,
    },
    lastConfirmedActivity: lastConfirmed,
    secondsSinceActivity,
    stallMs,
    summary: state.summary,
  };
}
