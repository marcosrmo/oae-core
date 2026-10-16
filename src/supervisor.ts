/**
 * Supervisor: independent, deterministic watchdog (not an LLM agent, so it
 * cannot suffer the same stalls as the agents it supervises).
 *
 * Policy (configurable):
 *  - signals: agent message activity, task state changes, validator runs.
 *  - no verifiable progress for diagnoseMs (default 7 min): diagnose + prepare
 *    recovery context.
 *  - no verifiable progress for recoverMs (default 10 min): controlled
 *    recovery — interrupt the stalled session (via the supported interrupt
 *    API) and let the orchestrator dispatch a fresh agent with refined
 *    instructions; bounded by maxRecoveryCycles and maxAttempts.
 * Legitimate long operations are respected via per-operation timeouts in
 * validators/runCommand; the supervisor only reacts to *global* task stalls.
 */
import { nowISO, truncate } from "./util.ts";
import type { AgentRunner, ProgressSignal } from "./opencode.ts";
import type { Store, Task } from "./store.ts";
import type { RecoveryConfig } from "./config.ts";

export interface SupervisedRun {
  taskId: string;
  runner: AgentRunner;
  lastSignalAt: number;
  diagnosed: boolean;
  diagnosis?: string;
  recovered: boolean;
  signals: ProgressSignal[];
}

export type SweepAction =
  | { type: "none" }
  | { type: "diagnose"; taskId: string; context: string }
  | { type: "recover"; taskId: string; context: string }
  | { type: "quarantine"; taskId: string; reason: string };

export interface Clock { now(): number }

export class Supervisor {
  private runs = new Map<string, SupervisedRun>();
  private recovery: RecoveryConfig;
  private store: Store;
  private clock: Clock;

  constructor(recovery: RecoveryConfig, store: Store, clock: Clock = { now: () => Date.now() }) {
    this.recovery = recovery;
    this.store = store;
    this.clock = clock;
  }

  register(taskId: string, runner: AgentRunner): SupervisedRun {
    const existing = this.runs.get(taskId);
    if (existing) {
      // fresh session for the same task resets the stall window
      existing.runner = runner;
      existing.lastSignalAt = this.clock.now();
      existing.diagnosed = false;
      existing.diagnosis = undefined;
      existing.recovered = false;
      existing.signals = [];
      return existing;
    }
    const run: SupervisedRun = {
      taskId,
      runner,
      lastSignalAt: this.clock.now(),
      diagnosed: false,
      recovered: false,
      signals: [],
    };
    this.runs.set(taskId, run);
    return run;
  }

  /** Called by the orchestrator whenever observable state moves forward. */
  noteSignal(taskId: string, signal: ProgressSignal): void {
    const run = this.runs.get(taskId);
    if (!run) return;
    run.signals.push(signal);
    run.lastSignalAt = this.clock.now();
    run.diagnosed = false;
  }

  unregister(taskId: string): void {
    this.runs.delete(taskId);
  }

  idleMs(taskId: string): number {
    const run = this.runs.get(taskId);
    return run ? this.clock.now() - run.lastSignalAt : 0;
  }

  /**
   * One supervision sweep over all supervised runs.
   * Deterministic: pure state inspection + supported interrupt API.
   */
  async sweep(): Promise<SweepAction[]> {
    const actions: SweepAction[] = [];
    for (const [taskId, run] of this.runs) {
      const idleMs = this.clock.now() - run.lastSignalAt;
      if (idleMs < this.recovery.diagnoseMs) continue;

      if (idleMs < this.recovery.recoverMs) {
        if (!run.diagnosed) {
          run.diagnosed = true;
          const diagnosis = await this.diagnose(run);
          run.diagnosis = diagnosis;
          await this.store.event("supervisor_diagnose", { taskId, idleMs });
          actions.push({ type: "diagnose", taskId, context: diagnosis });
        }
        continue;
      }

      if (run.recovered) continue; // recovery already triggered for this run
      const task = this.store.state.tasks.find((t) => t.id === taskId);
      const codeAttempts = task?.attempts.filter((a) => a.kind === "code" || a.kind === "recovery").length ?? 0;
      const recoveryCycles = task?.recoveryCycles ?? 0;
      if (recoveryCycles >= this.recovery.maxRecoveryCycles || codeAttempts >= this.recovery.maxAttempts) {
        await this.store.event("supervisor_quarantine", { taskId, idleMs, codeAttempts, recoveryCycles });
        // interrupt the stalled session so the orchestrator loop is not stuck on it
        await run.runner.interrupt().catch(() => undefined);
        actions.push({ type: "quarantine", taskId, reason: `recovery limit (cycles=${recoveryCycles}, attempts=${codeAttempts})` });
        this.unregister(taskId);
        continue;
      }

      run.recovered = true;
      // controlled recovery: interrupt the stalled session through the
      // supported API; the orchestrator will observe the interrupted outcome
      // and dispatch a fresh agent with refined instructions.
      await run.runner.interrupt().catch(() => undefined);
      const tail = await run.runner.transcriptTail(6).catch(() => "(unavailable)");
      if (!run.diagnosis) run.diagnosis = "no verifiable progress (no diagnosis available)";
      await this.store.event("supervisor_recover", { taskId, idleMs, diagnosis: run.diagnosis });
      await this.store.decide({
        by: "supervisor",
        kind: "technical",
        text: `Recovering stalled task ${taskId} after ${Math.round(idleMs / 1000)}s without progress`,
        rationale: run.diagnosis,
      });
      actions.push({
        type: "recover",
        taskId,
        context: buildRecoveryContext(run.diagnosis, tail),
      });
      this.unregister(taskId);
    }
    return actions;
  }

  private async diagnose(run: SupervisedRun): Promise<string> {
    const tail = await run.runner.transcriptTail(6).catch(() => "(unavailable)");
    const idle = Math.round((this.clock.now() - run.lastSignalAt) / 1000);
    return [
      `No verifiable progress for ${idle}s (threshold ${this.recovery.diagnoseMs / 1000}s).`,
      `Signals observed: ${run.signals.length ? run.signals.slice(-3).map((s) => `${s.kind}@${s.at}`).join("; ") : "none"}.`,
      `Transcript tail:`,
      truncate(tail, 1200),
    ].join("\n");
  }

  statusLine(): string {
    const parts: string[] = [];
    for (const [taskId, run] of this.runs) {
      parts.push(`${taskId}: idle=${Math.round((this.clock.now() - run.lastSignalAt) / 1000)}s`);
    }
    return parts.join("; ");
  }
}

export function buildRecoveryContext(diagnosis: string, tail: string): string {
  return [
    `RECOVERY DISPATCH — the previous attempt stalled and was interrupted by the supervisor.`,
    `Diagnosis: ${diagnosis}`,
    `Transcript tail:`,
    truncate(tail, 2000),
    "",
    "Recover with: (1) re-read the acceptance criteria, (2) reduce scope to the smallest verifiable step,",
    "(3) name the files you will touch before editing, (4) run a validator after each step.",
    "Do not repeat the same failed approach; pick a materially different strategy.",
  ].join("\n");
}

export function timestamp(): string { return nowISO(); }
