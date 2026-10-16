/**
 * Run lock: refuses a second concurrent OAE run in the same project directory.
 * This is the deterministic backstop of the anti-recursion model — an OAE coder
 * session that (despite prompt rules) tries to launch a nested `oae run` in the
 * project it is working on gets refused here, because the outer run still holds
 * the lock (pid alive). See docs/SECURITY.md ("Anti-recursion") and D13.
 *
 * Lock file: <project>/.oae/run.lock — JSON { pid, runId, startedAt }.
 * Stale locks (pid no longer alive) are reclaimed automatically.
 * `--force` overrides a live foreign lock (explicit operator action only).
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { nowISO } from "./util.ts";

export interface RunLockInfo {
  pid: number;
  runId: string;
  startedAt: string;
  /**
   * Random per-acquisition token. It lets the owner prove a lock is still its
   * own (pid alone can be reused by the OS); the token is never interpreted as
   * a secret — it is only an ownership witness.
   */
  token?: string;
}

function lockFile(projectDir: string): string {
  return join(projectDir, ".oae", "run.lock");
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Read the current lock, if any. Never throws. */
export async function readRunLock(projectDir: string): Promise<RunLockInfo | undefined> {
  try {
    const parsed = JSON.parse(await readFile(lockFile(projectDir), "utf8")) as RunLockInfo;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export interface RunLockResult {
  ok: boolean;
  /** Refusal reason (present when ok === false). */
  reason?: string;
}

/** Try to acquire the run lock for this directory. Never throws. */
export async function acquireRunLock(
  projectDir: string,
  runId: string,
  opts: { force?: boolean } = {},
): Promise<RunLockResult> {
  const file = lockFile(projectDir);
  let prev: RunLockInfo | undefined;
  try { prev = JSON.parse(await readFile(file, "utf8")) as RunLockInfo; } catch { /* no lock */ }
  if (
    prev && !opts.force &&
    Number.isInteger(prev.pid) && prev.pid !== process.pid && pidAlive(prev.pid)
  ) {
    return {
      ok: false,
      reason:
        `an OAE run is already active in this directory ` +
        `(run ${prev.runId}, pid ${prev.pid}, started ${prev.startedAt}); ` +
        `concurrent/nested runs are refused — wait for it to finish ` +
        `or remove a stale ${file} manually if you are certain it is dead`,
    };
  }
  try {
    await mkdir(join(projectDir, ".oae"), { recursive: true });
    const info: RunLockInfo = { pid: process.pid, runId, startedAt: nowISO(), token: randomUUID() };
    await writeFile(file, JSON.stringify(info, null, 2), "utf8");
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `cannot write run lock: ${(e as Error).message}` };
  }
}

/** Release the lock — only if it is still ours (never remove a foreign lock). */
export async function releaseRunLock(projectDir: string, runId: string): Promise<void> {
  const file = lockFile(projectDir);
  try {
    const cur = JSON.parse(await readFile(file, "utf8")) as RunLockInfo;
    // never remove a lock that belongs to another run, nor — defensively — one
    // held by another process: a pid we do not own must keep its lock
    if (cur.runId !== runId) return;
    if (Number.isInteger(cur.pid) && cur.pid !== process.pid) return;
    await rm(file, { force: true });
  } catch { /* already gone */ }
}
