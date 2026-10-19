/**
 * Orchestrator: plan → dispatch → supervise → validate → review → consolidate.
 * Dispatches coder/reviewer sessions over the real OpenCode service; every
 * mutation of the outside world goes through Store + git module.
 *
 * Supervision runs on a periodic ticker inside run(), independent from the
 * task loops, so a stalled agent is interrupted even while other work waits.
 */
import type { AgentRunner, ProviderModelRef, SessionUsage } from "./contracts.ts";
import type { Provider } from "./providers/contract.ts";
import { SessionLog } from "./sessions/writer.ts";
import type { OaeConfig } from "./config.ts";
import { Store, type Task, type RunState } from "./store.ts";
import type { Plan } from "./planner.ts";
import { makePlan, detectStack, defaultValidators } from "./planner.ts";
import { Supervisor, type SweepAction } from "./supervisor.ts";
import { runValidators, type ValidatorResult } from "./validators.ts";
import { classifyProviderFailure, isProviderUnavailableFailure } from "./events.ts";
import * as git from "./git.ts";
import { nowISO, truncate, sleep } from "./util.ts";

export interface RunOptions {
  config: OaeConfig;
  /** Pre-computed plan (used by tests); a plan is generated otherwise. */
  plan?: Plan;
  /** Dry run: build the plan and stop. */
  dryRun?: boolean;
  /** Deterministic injectable runners for tests. */
  runnerFactory?: (kind: "coder" | "reviewer", task: Task) => AgentRunner;
  /** Injectable session log (tests inject a temp-dir writer; null disables logging). */
  sessionLog?: SessionLog | null;
  /** Override supervision sweep interval (ms) for tests. */
  sweepIntervalMs?: number;
  /** Injectable clock for deterministic supervision tests. */
  clock?: { now(): number };
  /** Injectable wait (provider backoff) for deterministic tests. */
  sleepFn?: (ms: number) => Promise<void>;
}

const CODER_PROMPT = (task: Task, stack: string, validators: string[], refined?: string) => [
  "You are the coder agent of an autonomous engineering run.",
  `Project stack: ${stack}. Validators available: ${validators.join(", ") || "none"}.`,
  "",
  `TASK ${task.id}: ${task.title}`,
  "INSTRUCTIONS:",
  task.instructions,
  "",
  "ACCEPTANCE CRITERIA (all must hold):",
  ...task.acceptance.map((a, i) => `${i + 1}. ${a}`),
  "",
  refined ? `RECOVERY CONTEXT FROM SUPERVISOR:\n${refined}\n` : "",
  "PROCEDURE (mandatory):",
  "1. Investigate the existing code before editing anything.",
  "2. Make small, verifiable changes; touch only files required by the task.",
  "3. Run the project validators when relevant to your change.",
  "4. End your reply with a section 'RESULT:' listing: files changed, commands executed with outcomes,",
  "   and any impediment that blocked you (write 'IMPEDIMENT: <reason>' if blocked, or 'IMPEDIMENT: none' if not).",
  "5. Never declare completion without proof (command output or file evidence).",
  "6. NEVER modify or create files inside '.oae/' or '.opencode/' — those belong to the orchestrator.",
  "7. Do not create config files (package.json, tsconfig, etc.) unless the task explicitly requires them.",
  "8. NEVER invoke the OAE CLI (`oae`, `node src/index.ts`, `npm run start`) and never start another",
  "   autonomous engineering run — you are already inside one; nested runs are refused and waste resources.",
].join("\n");

const REVIEWER_PROMPT = (task: Task, diff: string, formatReminder?: boolean) => [
  ...(formatReminder
    ? ["REMINDER: your ENTIRE reply must be exactly ONE JSON object — no prose before or after it.",
       "Your previous reply was prose and could not be parsed; repeat the review and answer in JSON only.",
       ""]
    : []),
  "You are the independent reviewer of an autonomous engineering run.",
  "Review the changes below for: logical errors, regressions, security issues,",
  "architecture inconsistencies, and unmet acceptance criteria.",
  "",
  `TASK ${task.id}: ${task.title}`,
  "ACCEPTANCE CRITERIA:",
  ...task.acceptance.map((a, i) => `${i + 1}. ${a}`),
  "",
  "INSTRUCTIONS:",
  task.instructions,
  "",
  "DIFF (uncommitted changes):",
  diff || "(no textual diff — check the files directly)",
  "",
  "Respond with ONLY a JSON object (no markdown fences):",
  '{"verdict":"approve"|"reject","findings":[{"severity":"critical"|"major"|"minor","text":string}],"summary":string}',
  "Reject when any acceptance criterion is unmet or a critical/major finding exists.",
  "Evidence every finding with a file/line or command result.",
  "You are inside an autonomous engineering run: NEVER invoke the OAE CLI or start another run — judge only.",
].join("\n");

interface ReviewVerdict {
  verdict: "approve" | "reject";
  findings: { severity: string; text: string }[];
  summary: string;
}

export class Orchestrator {
  private supervisor: Supervisor;
  private provider: Provider | null;
  private store: Store;
  private opts: RunOptions;

  constructor(provider: Provider | null, store: Store, opts: RunOptions) {
    this.provider = provider;
    this.store = store;
    this.opts = opts;
    this.sleeper = opts.sleepFn ?? ((ms: number) => sleep(ms));
    this.sessionLog = opts.sessionLog === undefined ? new SessionLog(opts.config.projectDir) : (opts.sessionLog ?? null);
    this.supervisor = new Supervisor(opts.config.recovery, store, opts.clock ?? { now: () => Date.now() });
  }

  private sleeper: (ms: number) => Promise<void>;
  private sessionLog: SessionLog | null;

  /**
   * Best-effort per-attempt rollout record (.oae/sessions/<key>.jsonl).
   * Observability only: a logging failure is swallowed and must never
   * influence attempt outcomes (the persisted attempt in state.json
   * remains the authority).
   */
  private async recordSession(attempt: { id: number }, taskId: string, kind: string, data: Record<string, unknown>): Promise<void> {
    try { await this.sessionLog?.append(`${taskId}-a${attempt.id}`, kind, data); } catch { /* observability only */ }
  }

  async run(request: string): Promise<{ state: RunState }> {
    const cfg = this.opts.config;
    const started = Date.now();
    await this.store.event("run_started", {
      request: truncate(request, 300),
      // real selection, recorded once: model resolved at runtime (D9) and the
      // agent names actually used for each role
      model: cfg.model ? `${cfg.model.providerID}/${cfg.model.id}` : "service default",
      agents: { planner: cfg.plannerAgent, coder: cfg.coderAgent, reviewer: cfg.reviewerAgent },
      concurrency: cfg.concurrency,
    });

    // git: inspect and prepare (never discards user work)
    const prep = await git.prepareGit(cfg.projectDir);
    this.store.state.git = {
      branch: prep.branch ?? "",
      baselineCommit: prep.baseline,
      baselineUncommitted: prep.baselineUncommitted,
    };
    this.baselineUncommitted = prep.baselineUncommitted;
    await this.store.decide({
      by: "orchestrator",
      kind: "technical",
      text: `Prepared git: ${prep.status.isRepo ? `existing repo (branch ${prep.branch})` : "initialized new repo"}` +
        (prep.status.uncommitted.length ? `, ${prep.status.uncommitted.length} pre-existing uncommitted files preserved` : ", clean tree"),
      rationale: "Baseline preservation: user changes are never committed or discarded by OAE.",
    });

    // plan
    const plan = this.opts.plan ?? await makePlan(this.provider, cfg, request);
    for (const v of plan.validators) {
      if (!cfg.validators.find((x) => x.name === v.name)) cfg.validators.push(v);
    }
    for (const d of plan.decisions) await this.store.decide({ by: "planner", ...d });
    for (const t of plan.tasks) await this.store.addTask(t);
    await this.store.event("plan_ready", { tasks: plan.tasks.length, summary: plan.summary });
    if (this.opts.dryRun) {
      this.store.state.status = "done";
      this.store.state.summary = "dry run: plan only";
      this.store.state.endedAt = nowISO();
      await this.store.persist();
      return { state: this.store.state };
    }

    // supervision ticker (independent of task loops)
    const sweepMs = this.opts.sweepIntervalMs ?? cfg.recovery.pollMs;
    const ticker = setInterval(() => { void this.runSweep(); }, sweepMs);

    // execute in dependency order with bounded concurrency
    const pending = new Set(plan.tasks.map((t) => t.id));
    const inflight = new Map<string, Promise<void>>();
    try {
      while (pending.size > 0 || inflight.size > 0) {
        if (Date.now() - started > cfg.recovery.runTimeoutMs) {
          for (const id of pending) await this.store.updateTask(id, { status: "cancelled", blockedReason: "run timeout" });
          pending.clear();
        }
        for (const id of [...pending]) {
          if (inflight.size >= cfg.concurrency) break;
          const task = this.store.task(id);
          const depsDone = task.dependsOn.every((d) => this.store.task(d)?.status === "done");
          const depsFailed = task.dependsOn.some((d) => ["failed", "blocked", "cancelled"].includes(this.store.task(d)?.status ?? "pending"));
          if (depsFailed) {
            await this.store.updateTask(id, { status: "blocked", blockedReason: "dependency failed" });
            pending.delete(id);
            continue;
          }
          if (!depsDone) continue;
          pending.delete(id);
          inflight.set(id, this.executeTask(task).catch(async (e) => {
            await this.store.event("task_error", { taskId: id, error: String((e as Error).message) });
            await this.store.updateTask(id, { status: "failed", blockedReason: truncate(String((e as Error).message), 300) });
          }).finally(() => inflight.delete(id)));
        }
        if (inflight.size > 0) await Promise.race(inflight.values());
        else if (pending.size > 0) await sleep(200);
      }
    } finally {
      clearInterval(ticker);
      // final sweep to flush pending diagnoses/quarantines
      await this.runSweep();
    }

    // final validation + summary
    const validatorResults = await runValidators(cfg, this.store);
    const tasks = this.store.state.tasks;
    const doneCount = tasks.filter((t) => t.status === "done").length;
    const validatorsOk = validatorResults.every((v) => v.code === 0 && !v.timedOut);
    this.store.state.status = tasks.length > 0 && doneCount === tasks.length && validatorsOk ? "done" : "failed";
    this.store.state.summary =
      `${doneCount}/${tasks.length} tasks completed; validators: ` +
      (validatorResults.map((v) => `${v.name}=${v.code}${v.timedOut ? " (timeout)" : ""}`).join(", ") || "none configured");
    this.store.state.endedAt = nowISO();
    await this.store.persist();
    await this.store.event("run_finished", { status: this.store.state.status, summary: this.store.state.summary });
    return { state: this.store.state };
  }

  private sweeper?: { run(): Promise<void> };

  /** One supervision sweep; serialized to avoid overlapping interventions. */
  private sweeping = false;
  private async runSweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const actions = await this.supervisor.sweep();
      for (const a of actions) await this.handleSweepAction(a);
    } catch {
      // supervision errors must never crash the run
    } finally {
      this.sweeping = false;
    }
  }

  /** Used by tests to trigger supervision deterministically. */
  async sweepNow(): Promise<void> {
    await this.runSweep();
  }

  private async handleSweepAction(action: SweepAction): Promise<void> {
    switch (action.type) {
      case "diagnose":
        await this.store.decide({
          by: "supervisor", kind: "technical",
          text: `Diagnosed stalled task ${action.taskId}`,
          rationale: truncate(action.context, 400),
        });
        break;
      case "recover": {
        const task = this.store.task(action.taskId);
        task.recoveryCycles += 1;
        await this.store.updateTask(task.id, { recoveryCycles: task.recoveryCycles });
        this.recoveryContext.set(task.id, action.context);
        break;
      }
      case "quarantine": {
        const t = this.store.state.tasks.find((x) => x.id === action.taskId);
        if (t) await this.store.updateTask(t.id, { status: "blocked", blockedReason: action.reason });
        break;
      }
      case "none":
        break;
    }
  }

  private recoveryContext = new Map<string, string>();
  private baselineUncommitted: string[] = [];

  /**
   * Observability emit: an event write failure must never crash the run
   * (dashboard availability is never mission-critical).
   */
  private emit(kind: string, data: Record<string, unknown>): void {
    void this.store.event(kind, data).catch(() => undefined);
  }

  private async dispatch(kind: "coder" | "reviewer", task: Task, refined?: string, reviewFormatReminder?: boolean): Promise<{ runner: AgentRunner; prompt: string }> {
    const cfg = this.opts.config;
    const stack = await detectStack(cfg.projectDir);
    const validators = (cfg.validators.length ? cfg.validators : defaultValidators(cfg.projectDir, stack)).map((v) => `${v.cmd} ${v.args.join(" ")}`);
    const prompt = kind === "coder"
      ? CODER_PROMPT(task, stack, validators, refined)
      : REVIEWER_PROMPT(task, await git.diffUncommitted(cfg.projectDir), reviewFormatReminder);
    const agent = kind === "coder" ? cfg.coderAgent : cfg.reviewerAgent;
    if (this.opts.runnerFactory) {
      const runner = this.opts.runnerFactory(kind, task);
      await runner.prompt(prompt);
      return { runner, prompt };
    }
    const provider = this.provider;
    if (!provider) throw new Error("no provider runtime configured");
    const runner = await provider.createSession({
      directory: cfg.projectDir,
      title: `OAE ${kind} ${task.id}`,
      agent,
      model: cfg.model,
      // direct providers carry no built-in agent tooling: only the coder gets
      // the confined local file tools; planner/reviewer stay textual
      tools: kind === "coder",
      promptText: prompt,
    });
    return { runner, prompt };
  }

  private async collectUsage(runner: AgentRunner): Promise<SessionUsage | null> {
    if (!runner.usage) return null;
    try { return await runner.usage(); } catch { return null; }
  }

  /** One independent review session; records the attempt and returns the parsed verdict. */
  private async runReview(task: Task, formatReminder = false): Promise<{ verdict: ReviewVerdict | undefined }> {
    const cfg = this.opts.config;
    const rev = await this.dispatch("reviewer", task, undefined, formatReminder);
    this.supervisor.unregister(task.id); // reviewer is short; supervision stays on the coder path
    const revAttempt = await this.store.addAttempt(task.id, {
      sessionId: rev.runner.sessionId, agent: cfg.reviewerAgent, kind: "review",
      startedAt: nowISO(), outcome: "running", summary: "", filesChanged: [], evidence: {},
    });
    await this.recordSession(revAttempt, task.id, "dispatch", {
      taskId: task.id, attemptId: revAttempt.id, phase: "review", agent: cfg.reviewerAgent,
      runtime: rev.runner.runtime, sessionId: rev.runner.sessionId,
      model: cfg.model ? `${cfg.model.providerID}/${cfg.model.id}` : "service default",
    });
    const revRes = await rev.runner.awaitCompletion(5 * 60_000, (s) =>
      this.emit("agent_progress", { taskId: task.id, attemptId: revAttempt.id, phase: "review", signalKind: s.kind, detail: s.detail }));
    const verdict = parseVerdict(revRes.output);
    const revUsage = await this.collectUsage(rev.runner);
    await this.recordSession(revAttempt, task.id, "result", {
      taskId: task.id, attemptId: revAttempt.id, phase: "review",
      // canonical attempt vocabulary identical to finishAttempt; the `verdict`
      // field differentiates a substantive rejection (approve/reject parsed)
      // from an unparseable reply — information NOT collapsed into `outcome`
      outcome: verdict?.verdict === "approve" ? "approved" : "rejected",
      verdict: verdict?.verdict ?? "unparseable",
      runtime: rev.runner.runtime, sessionId: rev.runner.sessionId,
      output: truncate(revRes.output, 2000),
      tokens: revUsage ?? null,
    });
    await this.store.finishAttempt(task.id, revAttempt.id, {
      outcome: verdict?.verdict === "approve" ? "approved" : "rejected",
      summary: verdict?.summary ?? truncate(revRes.output, 500),
      evidence: {
        verdict: verdict?.verdict ?? "unparseable",
        findings: JSON.stringify(verdict?.findings ?? []),
        ...(revUsage ? { tokens: JSON.stringify(revUsage) } : {}),
      },
    });
    return { verdict };
  }

  private async executeTask(task: Task): Promise<void> {
    const cfg = this.opts.config;
    const taskStart = Date.now();
    await this.store.updateTask(task.id, { status: "in_progress" });

    let refined = this.recoveryContext.get(task.id);

    while (Date.now() - taskStart < cfg.recovery.taskTimeoutMs) {
      const codeAttempts = task.attempts.filter((a) => a.kind === "code" || a.kind === "recovery").length;
      if (codeAttempts >= cfg.recovery.maxAttempts) {
        await this.store.updateTask(task.id, { status: "blocked", blockedReason: `attempt limit (${cfg.recovery.maxAttempts}) reached` });
        return;
      }

      // --- coder attempt ---
      const attemptNo = codeAttempts + 1;
      const { runner } = await this.dispatch("coder", task, refined);
      refined = undefined;
      this.supervisor.register(task.id, runner);
      const attempt = await this.store.addAttempt(task.id, {
        sessionId: runner.sessionId, agent: cfg.coderAgent, kind: "code",
        startedAt: nowISO(), outcome: "running", summary: "", filesChanged: [], evidence: {},
      });
      await this.recordSession(attempt, task.id, "dispatch", {
        taskId: task.id, attemptId: attempt.id, phase: "code", agent: cfg.coderAgent,
        runtime: runner.runtime, sessionId: runner.sessionId,
        model: cfg.model ? `${cfg.model.providerID}/${cfg.model.id}` : "service default",
      });
      const res = await runner.awaitCompletion(cfg.recovery.taskTimeoutMs - (Date.now() - taskStart), (s) => {
        this.supervisor.noteSignal(task.id, s);
        // `signalKind` (not `kind`): Store.event's spread would otherwise
        // overwrite the event-type field with the signal kind
        this.emit("agent_progress", { taskId: task.id, attemptId: attempt.id, phase: "code", signalKind: s.kind, detail: s.detail });
      });
      const usage = await this.collectUsage(runner);
      const normalizedOutcome = res.outcome === "completed" ? "completed" : "interrupted";
      await this.recordSession(attempt, task.id, "result", {
        taskId: task.id, attemptId: attempt.id, phase: "code",
        // canonical attempt vocabulary (matches state.json's finishAttempt);
        // rawOutcome keeps the runner-contract distinction (failed vs interrupted)
        outcome: normalizedOutcome,
        rawOutcome: res.outcome,
        runtime: runner.runtime, sessionId: runner.sessionId,
        output: truncate(res.output, 2000),
        tokens: usage ?? null,
      });
      await this.store.finishAttempt(task.id, attempt.id, {
        outcome: res.outcome === "completed" ? "completed" : "interrupted",
        summary: truncate(res.output, 1000),
        filesChanged: await changedFiles(cfg.projectDir, this.baselineUncommitted),
        evidence: usage ? { tokens: JSON.stringify(usage) } : {},
      });
      if (res.outcome !== "completed") {
        // structured observability: interruption vs provider/runtime failure
        if (res.outcome === "interrupted") {
          this.emit("session_interrupted", { taskId: task.id, attemptId: attempt.id, sessionId: runner.sessionId, detail: truncate(res.output || "interrupted before completion", 300) });
          await this.recordSession(attempt, task.id, "interrupt", {
            taskId: task.id, attemptId: attempt.id, sessionId: runner.sessionId,
            detail: res.output ? truncate(res.output, 500) : "interrupted before completion",
          });
        } else {
          const f = classifyProviderFailure(res.output);
          this.emit("provider_error", {
            taskId: task.id, attemptId: attempt.id, sessionId: runner.sessionId,
            runnerKind: f.kind, httpStatus: f.httpStatus,
            message: truncate(f.message, 400),
            tokensUnknown: usage === null,
          });
          // Provider gates (HTTP 429/401) with no confirmed token usage mean
          // the provider never delivered compute: a bounded provider backoff
          // preserves the engineering attempt budget (mission §7-G; evidence:
          // benchmark runs where every attempt died on 429 with 0 tokens).
          const tokensConsumed = usage ? (usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite) > 0 : false;
          if (isProviderUnavailableFailure(f) && !tokensConsumed) {
            const provRetries = this.store.task(task.id).attempts.filter((a) => a.kind === "provider_retry").length;
            if (provRetries < cfg.recovery.maxProviderRetries) {
              const waitMs = Math.min(cfg.recovery.providerBackoffMs * 2 ** provRetries, 120_000);
              await this.store.patchAttempt(task.id, attempt.id, { kind: "provider_retry", outcome: "failed" });
              await this.store.decide({
                by: "orchestrator", kind: "technical",
                text: `Provider unavailable (HTTP ${f.httpStatus}) after attempt ${attemptNo} with no confirmed token usage`,
                rationale: "provider retry preserves the engineering attempt budget",
              });
              this.supervisor.unregister(task.id);
              this.emit("retry_scheduled", { taskId: task.id, attemptNo, reason: `provider unavailable (HTTP ${f.httpStatus}) — engineering attempt not consumed`, waitMs, providerRetry: provRetries + 1 });
              await this.sleeper(waitMs);
              continue;
            }
            // gate exhausted: block explicitly, re-classifying the failed
            // attempt first so the ledger matches the budget claim (it
            // consumed no confirmed compute either)
            await this.store.patchAttempt(task.id, attempt.id, { kind: "provider_retry", outcome: "failed" });
            await this.store.updateTask(task.id, {
              status: "blocked",
              blockedReason: `provider unavailable (HTTP ${f.httpStatus}) after ${cfg.recovery.maxProviderRetries} provider retries — engineering attempts preserved`,
            });
            this.supervisor.unregister(task.id);
            return;
          }
        }
        // supervisor recovery: sweep already produced refined instructions
        refined = this.recoveryContext.get(task.id) ??
          "The previous attempt was interrupted (timeout or recovery). Reduce scope and verify each step.";
        this.recoveryContext.delete(task.id);
        if (codeAttempts + 1 >= cfg.recovery.maxAttempts) {
          await this.store.updateTask(task.id, { status: "blocked", blockedReason: `attempt limit (${cfg.recovery.maxAttempts}) reached` });
          this.supervisor.unregister(task.id);
          return;
        }
        const waitMs = await backoffLite(cfg.recovery.backoffMs, attemptNo);
        this.emit("retry_scheduled", { taskId: task.id, attemptNo, reason: "attempt interrupted (deadline or recovery)", waitMs });
        continue;
      }
      if (!res.output.trim()) {
        // a "completed" session with no assistant text is a dispatch/provider
        // failure, not a code change — never send an empty attempt to review
        const f = classifyProviderFailure("runner error: empty completed response (no assistant text; provider/dispatch failure is the likely cause)");
        this.emit("provider_error", {
          taskId: task.id, attemptId: attempt.id, sessionId: runner.sessionId,
          runnerKind: "runner", httpStatus: undefined,
          message: f.message, tokensUnknown: usage === null,
        });
        await this.store.decide({
          by: "orchestrator", kind: "technical",
          text: `Task ${task.id} attempt ${attemptNo} produced an empty response`,
          rationale: "treated as a failed dispatch (no reviewer session spent); bounded by the attempt limit",
        });
        if (codeAttempts + 1 >= cfg.recovery.maxAttempts) {
          await this.store.updateTask(task.id, { status: "blocked", blockedReason: `attempt limit (${cfg.recovery.maxAttempts}) reached (empty responses)` });
          this.supervisor.unregister(task.id);
          return;
        }
        const waitMs = await backoffLite(cfg.recovery.backoffMs, attemptNo);
        this.emit("retry_scheduled", { taskId: task.id, attemptNo, reason: "empty coder response", waitMs });
        continue;
      }
      if (/IMPEDIMENT:/i.test(res.output)) {
        const imp = res.output.match(/IMPEDIMENT:[^\n]*/i)?.[0]?.trim() ?? "";
        // strip the label, then leading markdown emphasis/bullets/quotes
        // (a coder writing "**IMPEDIMENT:** none" must not be read as an
        // impediment named "** none" — benchmark run-mvb27epc)
        const real = imp
          .replace(/^IMPEDIMENT:\s*/i, "")
          .replace(/^[\s*_`>#-]+/, "")
          .trim();
        // treat anything starting with "none"/"no impediment"/"n/a" as no impediment
        if (real && !/^(none\b|n\/a\b|no impediment\b)/i.test(real)) {
          await this.store.updateTask(task.id, { status: "blocked", blockedReason: truncate(real, 300) });
          this.supervisor.unregister(task.id);
          return;
        }
      }

      // --- validation ---
      const validators = await runValidators(cfg, this.store);
      const validatorOk = validators.every((v) => v.code === 0 && !v.timedOut);

      // --- independent review ---
      let review = await this.runReview(task);
      // Bounded re-ask: an unparseable verdict with passing validators is a
      // review-format failure, not a code failure — never spend a coder
      // attempt on it (benchmark run-mvb2ysid burned two full coder attempts
      // on reviewers that answered in prose instead of the required JSON)
      let reviewReasks = 0;
      while (!review.verdict && validatorOk && reviewReasks < cfg.recovery.maxReviewReasks) {
        reviewReasks++;
        await this.store.decide({
          by: "orchestrator", kind: "technical",
          text: `Review of attempt ${attemptNo} returned no parseable verdict; re-asking the reviewer (${reviewReasks}/${cfg.recovery.maxReviewReasks})`,
          rationale: "validators pass and the code is unchanged — a review-format failure must not consume a coder attempt",
        });
        review = await this.runReview(task, true);
      }
      const verdict = review.verdict;
      if (!validatorOk || verdict?.verdict !== "approve") {
        refined = [
          `Previous attempt rejected. Validator results: ${validators.map((v) => `${v.name}=${v.code}`).join(", ")}.`,
          `Reviewer verdict: ${verdict?.verdict ?? "unparseable"}. Findings:`,
          ...(verdict?.findings ?? [{ severity: "unknown", text: "review output unparseable" }]).map((f) => `- [${f.severity}] ${f.text}`),
        ].join("\n");
        await this.store.decide({ by: "reviewer", kind: "technical", text: `Rejected task ${task.id} attempt ${attemptNo}`, rationale: refined });
        task = this.store.task(task.id);
        const waitMs = await backoffLite(cfg.recovery.backoffMs, attemptNo);
        this.emit("retry_scheduled", { taskId: task.id, attemptNo, reason: "reviewer rejected (rework)", verdict: verdict?.verdict ?? "unparseable", waitMs });
        continue;
      }

      // --- done: commit on the run branch ---
      const commit = await git.commitAll(cfg.projectDir, `oae(${task.id}): ${task.title}`, this.baselineUncommitted);
      if (commit.error) {
        // A real commit failure must never be reported as a completed task.
        // The agent's work stays on the run branch (uncommitted, never
        // discarded); the task is blocked with the recorded error.
        await this.store.decide({
          by: "orchestrator", kind: "technical",
          text: `Commit failed for task ${task.id}; task blocked, work preserved uncommitted on the run branch`,
          rationale: `commitAll error: ${commit.error}`,
        });
        await this.store.updateTask(task.id, { status: "blocked", blockedReason: `commit failed: ${commit.error}` });
        this.supervisor.unregister(task.id);
        return;
      }
      await this.store.updateTask(task.id, { status: "done", commit: commit.commit });
      await this.store.decide({
        by: "orchestrator", kind: "technical",
        text: `Task ${task.id} completed after ${attemptNo} attempt(s)`,
        rationale: `validators ok; reviewer approved; commit ${commit.commit ?? "(no changes)"}`,
      });
      this.supervisor.unregister(task.id);
      return;
    }

    await this.store.updateTask(task.id, { status: "blocked", blockedReason: "task timeout" });
    this.supervisor.unregister(task.id);
  }
}

async function changedFiles(dir: string, exclude: string[] = []): Promise<string[]> {
  const st = await git.inspectGit(dir);
  return st.uncommitted
    .filter((f) => !f.startsWith(".oae"))
    .map((f) => f.replace(/^[MARC?]+\s*/, ""))
    .filter((f) => !exclude.includes(f))
    .slice(0, 50);
}

function parseVerdict(output: string): ReviewVerdict | undefined {
  const m = output.match(/\{[\s\S]*\}/);
  if (!m) return undefined;
  try {
    const v = JSON.parse(m[0]) as ReviewVerdict;
    if (v.verdict === "approve" || v.verdict === "reject") return v;
    return undefined;
  } catch { return undefined; }
}

async function backoffLite(baseMs: number, attempt: number): Promise<number> {
  const wait = Math.min(baseMs * 2 ** (attempt - 1), 30_000);
  await sleep(wait);
  return wait;
}

export type { ValidatorResult };
