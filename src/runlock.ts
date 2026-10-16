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
import { join } from "node:path";
import { nowISO } from "./util.ts";

export interface RunLockInfo {
  pid: number;
  runId: string;
  startedAt: string;
}

function lockFile(projectDir: string): string {
  return join(projectDir, ".oae", "run.lock");
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
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
    const info: RunLockInfo = { pid: process.pid, runId, startedAt: nowISO() };
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
    if (cur.runId !== runId) return;
    await rm(file, { force: true });
  } catch { /* already gone */ }
}
