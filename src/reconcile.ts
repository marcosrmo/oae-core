/**
 * Reconciliation — the safety net that stops an OAE run from staying "active"
 * forever when its owner process is gone.
 *
 * Root cause it addresses (Fase 0): the terminal state and the lock are only
 * written on the normal path (`Orchestrator.run()` end, `index.ts` finally).
 * A process killed abnormally — or an unhandled throw inside `run()` — leaves
 * `state.json` at `running` with an open attempt while `.oae/run.lock` points
 * at a pid that no longer exists.
 *
 * Evidence rules (never invent an outcome):
 *  - a terminal status (done/failed/cancelled/interrupted) is never touched;
 *  - a `running` run is declared orphaned only when a `run.lock` exists AND its
 *    owner pid is provably not alive — absence of a lock is NOT proof;
 *  - a pid the OS still reports as alive is not proof of identity on its own,
 *    so it is treated conservatively: a possibly-live owner is never declared
 *    interrupted here (the pid-reuse limitation is documented, not guessed away);
 *  - the persisted reconciliation is ADDITIVE: the pre-reconciliation snapshot
 *    is archived under `.oae/history/<runId>/` before the terminal status is
 *    written, and a `run_reconciled` event records the exact evidence;
 *  - it is IDEMPOTENT: a second call sees a terminal status and does nothing.
 *
 * The read-side projection (`effectiveStatus`) is pure and mutates nothing, so
 * `status`/`dashboard`/`report` can show the truth without rewriting history.
 */
import { join } from "node:path";
import { appendJsonl, nowISO, readJson, writeJsonAtomic } from "./util.ts";
import { pidAlive, readRunLock, type RunLockInfo } from "./runlock.ts";
import { archiveRunSnapshot } from "./history.ts";
import type { RunState, RunStatus } from "./store.ts";

/** Owner liveness of a run, as far as the evidence can prove. */
export type OwnerState = "alive" | "dead" | "unknown";

export interface OwnerEvidence {
  state: OwnerState;
  pid?: number;
  runId?: string;
  startedAt?: string;
  reason: string;
}

/**
 * Classify the lock's owner. `isAlive` is injectable for deterministic tests.
 * Returns "unknown" (never "dead") whenever liveness cannot be proven, so a
 * false "interrupted" is impossible from missing evidence alone.
 */
export function probeOwner(lock: RunLockInfo | undefined, isAlive: (pid: number) => boolean = pidAlive): OwnerEvidence {
  if (!lock) return { state: "unknown", reason: "no run.lock present" };
  const pid = lock.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    return { state: "unknown", runId: lock.runId, reason: "lock has no valid pid" };
  }
  if (!isAlive(pid)) {
    return { state: "dead", pid, runId: lock.runId, startedAt: lock.startedAt, reason: `run.lock owner pid ${pid} is not alive` };
  }
  return { state: "alive", pid, runId: lock.runId, startedAt: lock.startedAt, reason: `run.lock owner pid ${pid} is alive` };
}

export interface EffectiveStatus {
  status: RunStatus;
  /** True when a `running` run was reclassified because its owner is gone. */
  orphaned: boolean;
  reason?: string;
  owner: OwnerEvidence;
}

/** Pure projection: what SHOULD be reported, given the persisted state + owner evidence. */
export function effectiveStatus(state: RunState, owner: OwnerEvidence): EffectiveStatus {
  if (state.status !== "running") return { status: state.status, orphaned: false, owner };
  if (owner.state === "dead") {
    return { status: "interrupted", orphaned: true, reason: owner.reason, owner };
  }
  return { status: state.status, orphaned: false, owner };
}

/** Compute the effective status for a project dir (read-only; nothing is written). */
export async function readEffectiveStatus(
  projectDir: string,
  isAlive?: (pid: number) => boolean,
): Promise<{ state: RunState; effective: EffectiveStatus } | undefined> {
  const state = await readJson<RunState>(join(projectDir, ".oae", "state.json"));
  if (!state) return undefined;
  const lock = await readRunLock(projectDir);
  return { state, effective: effectiveStatus(state, probeOwner(lock, isAlive)) };
}

/**
 * Last timestamp the run can be *evidenced* to have been alive: the newest of
 * every attempt start/end and every task update. Used as `endedAt` when
 * reconciling, so a duration is never invented from wall-clock "now".
 */
export function lastEvidenceAt(state: RunState): string | undefined {
  const stamps: string[] = [];
  for (const t of state.tasks) {
    if (t.updatedAt) stamps.push(t.updatedAt);
    for (const a of t.attempts) {
      if (a.startedAt) stamps.push(a.startedAt);
      if (a.endedAt) stamps.push(a.endedAt);
    }
  }
  let best: string | undefined;
  let bestMs = -Infinity;
  for (const s of stamps) {
    const ms = Date.parse(s);
    if (Number.isFinite(ms) && ms >= bestMs) { bestMs = ms; best = s; }
  }
  return best;
}

export interface ReconcileResult {
  action: "none" | "reconciled";
  runId?: string;
  status?: string;
  reason?: string;
  archiveDir?: string;
  attemptsMarked?: number;
  owner: OwnerEvidence;
}

/**
 * Persist the reconciliation of an orphaned run (additive + idempotent).
 * Never removes the lock (it is evidence and is reclaimed automatically by the
 * next run because its pid is dead); never marks an attempt "completed".
 */
export async function reconcileRun(
  projectDir: string,
  isAlive?: (pid: number) => boolean,
): Promise<ReconcileResult> {
  const oaeDir = join(projectDir, ".oae");
  const stateFile = join(oaeDir, "state.json");
  const state = await readJson<RunState>(stateFile);
  const lock = await readRunLock(projectDir);
  const owner = probeOwner(lock, isAlive);
  if (!state) return { action: "none", reason: "no state.json", owner };

  const eff = effectiveStatus(state, owner);
  if (!eff.orphaned) {
    return { action: "none", runId: state.id, status: eff.status, reason: `not orphaned (${owner.reason})`, owner };
  }

  // preserve the pre-reconciliation evidence before touching anything
  const archiveDir = await archiveRunSnapshot(projectDir, state.id);

  // bound the end time by the last RECORDED evidence, captured BEFORE the loop
  // below stamps `now` onto open attempts (otherwise the evidence would be lost)
  const evidenceEnd = lastEvidenceAt(state);

  let attemptsMarked = 0;
  for (const t of state.tasks) {
    for (const a of t.attempts) {
      if (a.outcome === "running") {
        // an attempt whose owner died is interrupted, never completed: there is
        // no evidence of completion, and declaring one would be a fabrication.
        // Its end time stays unknown (no endedAt is invented) — the run-level
        // endedAt is the only bounded value.
        a.outcome = "interrupted";
        attemptsMarked++;
      }
    }
    if (t.status === "in_progress" || t.status === "awaiting_review" || t.status === "rework") {
      t.status = "blocked";
      t.blockedReason = `orchestrator process gone (${owner.reason})`;
      t.updatedAt = nowISO();
    }
  }

  state.status = "interrupted";
  // the true end time is unknown; bound it by the last recorded evidence so no
  // duration is fabricated from wall-clock "now"
  if (evidenceEnd) state.endedAt = evidenceEnd;
  state.summary = `reconciled: ${owner.reason}; no terminal state was persisted by the owner` +
    (evidenceEnd ? ` (endedAt bounded by last recorded evidence ${evidenceEnd})` : "");
  await writeJsonAtomic(stateFile, state);
  await appendJsonl(join(oaeDir, "events.jsonl"), {
    at: nowISO(),
    kind: "run_reconciled",
    runId: state.id,
    from: "running",
    to: "interrupted",
    ownerPid: owner.pid,
    reason: owner.reason,
    attemptsMarked,
  });

  return {
    action: "reconciled",
    runId: state.id,
    status: "interrupted",
    reason: owner.reason,
    archiveDir,
    attemptsMarked,
    owner,
  };
}

/**
 * Minimal structural view of the Store used by finalizeAbandonedRun — keeps
 * this module decoupled from the Store class while remaining testable.
 */
export interface PersistableRun {
  state: RunState;
  persist(): Promise<void>;
  event(kind: string, data: Record<string, unknown>): Promise<void>;
}

/**
 * In-process abnormal-exit handling: mark a still-`running` run as `interrupted`
 * and record why. Used by the CLI's crash/signal path so an exception or a
 * SIGINT during a run never leaves `state.json` stuck at `running`.
 * Idempotent: a terminal status is left untouched.
 */
export async function finalizeAbandonedRun(
  run: PersistableRun,
  reason: string,
): Promise<boolean> {
  if (run.state.status !== "running") return false;
  for (const t of run.state.tasks) {
    for (const a of t.attempts) {
      if (a.outcome === "running") {
        a.outcome = "interrupted";
        a.endedAt = a.endedAt ?? nowISO();
      }
    }
  }
  run.state.status = "interrupted";
  run.state.endedAt = run.state.endedAt ?? nowISO();
  run.state.summary = `interrupted: ${reason}`;
  await run.persist();
  await run.event("run_reconciled", { runId: run.state.id, from: "running", to: "interrupted", reason, inProcess: true });
  return true;
}
