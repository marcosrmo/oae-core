/**
 * Run history: previous runs must remain readable after a new run reuses
 * `.oae/state.json`. Store.create archives the previous state (and its event
 * log) into `.oae/history/<oldRunId>/` before overwriting — additive
 * preservation, never deletion.
 */
import { mkdir, readdir, readFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { readJson } from "./util.ts";
import type { RunState } from "./store.ts";

export interface HistoryEntry {
  id: string;
  request: string;
  status: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  tasksTotal: number;
  tasksDone: number;
  tasksBlocked: number;
  provider: { http429?: number; http401?: number } | undefined;
  source: "current" | "archived";
}

/** Archive a run's current state/events under `.oae/history/<runId>/` — used by
 * Store.create (before overwriting) and by reconciliation (before writing a
 * terminal status), so the original evidence stays auditable. Copy-based and
 * idempotent: a crash between copy and write never loses the original. */
export async function archiveRunSnapshot(projectDir: string, runId: string): Promise<string> {
  const dir = join(projectDir, ".oae");
  const dest = join(dir, "history", runId.replace(/[^\w.-]/g, "_"));
  await mkdir(dest, { recursive: true });
  await copyFile(join(dir, "state.json"), join(dest, "state.json")).catch(() => undefined);
  await copyFile(join(dir, "events.jsonl"), join(dest, "events.jsonl")).catch(() => undefined);
  return dest;
}

/** Archive previous state before Store.create overwrites it. Idempotent:
 * copy (not move) so a crash between copy and overwrite never loses the
 * original, and re-running on an existing archive is harmless. */
export async function archivePreviousRun(projectDir: string, newRunId: string): Promise<string | undefined> {
  if (!newRunId) return undefined;
  const dir = join(projectDir, ".oae");
  const previous = await readJson<RunState>(join(dir, "state.json"));
  if (!previous || previous.id === newRunId) return undefined;
  return archiveRunSnapshot(projectDir, previous.id);
}

async function readEvents(projectDir: string): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(join(projectDir, ".oae", "events.jsonl"), "utf8");
    return raw.trim().split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return {}; } });
  } catch { return []; }
}

function entryOf(st: RunState, source: HistoryEntry["source"], events: Array<Record<string, unknown>>): HistoryEntry {
  const providerErrors = events.filter((e) => e.kind === "provider_error");
  const count = (code: number) => providerErrors.filter((e) => e.httpStatus === code).length;
  return {
    id: st.id,
    request: st.request,
    status: st.status,
    startedAt: st.startedAt,
    endedAt: st.endedAt,
    durationMs: st.endedAt ? Math.max(0, Date.parse(st.endedAt) - Date.parse(st.startedAt)) : undefined,
    tasksTotal: st.tasks.length,
    tasksDone: st.tasks.filter((t) => t.status === "done").length,
    tasksBlocked: st.tasks.filter((t) => ["blocked", "failed", "cancelled"].includes(t.status)).length,
    provider: providerErrors.length ? { http429: count(429), http401: count(401) } : undefined,
    source,
  };
}

/** All runs we can see: current state.json + archived snapshots. */
export async function listRunHistory(projectDir: string): Promise<HistoryEntry[]> {
  const out: HistoryEntry[] = [];
  const current = await readJson<RunState>(join(projectDir, ".oae", "state.json"));
  if (current) out.push(entryOf(current, "current", await readEvents(projectDir)));
  const histDir = join(projectDir, ".oae", "history");
  let dirs: string[] = [];
  try { dirs = (await readdir(histDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* none yet */ }
  for (const d of dirs) {
    const st = await readJson<RunState>(join(histDir, d, "state.json"));
    // events of archived runs: the snapshot may not have been copied — derive provider counts from state only
    if (!st) continue;
    const evs = await readEventsFrom(join(histDir, d, "events.jsonl"));
    if (out.some((e) => e.id === st.id)) continue;
    out.push(entryOf(st, "archived", evs));
  }
  return out;
}

async function readEventsFrom(file: string): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(file, "utf8");
    return raw.trim().split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return {}; } });
  } catch { return []; }
}
