/**
 * Append-only session/tattempt event persistence (Onda 1).
 *
 * Each attempt gets ONE jsonl file at `.oae/sessions/<attemptKey>.jsonl`
 * (attemptKey derived from taskId+attemptId and session id, sanitized).
 * Writes are append-only; a failed or interrupted write can only truncate
 * the LAST line, and the tolerant reader drops incomplete trailing records
 * instead of failing. Recording is best-effort: a session-log failure must
 * never break or falsify a run — it is observability, not authority.
 */
import { mkdir, appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { nowISO } from "../util.ts";

const SESSIONS_DIRNAME = "sessions";

/** One persisted session event (open record; unknown fields preserved). */
export interface SessionEvent {
  at: string;
  v: 1;
  kind: string; // "dispatch" | "result" | "interrupt" | "progress" | ...
  [key: string]: unknown;
}

function safeKey(key: string): string {
  // chars outside the safe set are the absolute worst case: they can pollute
  // the filename — they never escape the sessions/ directory (join + filter)
  const s = key.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
  return s.length > 0 ? s : "unnamed";
}

export class SessionLog {
  private projectDir: string;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
  }

  private dir(): string {
    return join(this.projectDir, ".oae", SESSIONS_DIRNAME);
  }

  /**
   * Append one event for an attempt. Returns true when persisted, false when
   * recording failed (never throws; the caller decides what visibility a
   * dropped observability record deserves).
   */
  async append(attemptId: string, kind: string, data: Record<string, unknown> = {}): Promise<boolean> {
    const rec: SessionEvent = { ...data, at: nowISO(), v: 1, kind };
    try {
      await mkdir(this.dir(), { recursive: true });
      await appendFile(join(this.dir(), safeKey(attemptId) + ".jsonl"), JSON.stringify(rec) + "\n", "utf8");
      return true;
    } catch {
      return false; // best-effort observability: never breaks the run
    }
  }

  /** Tolerant read: drops empty and partially-written trailing lines silently. */
  async read(attemptId: string): Promise<SessionEvent[]> {
    let raw: string;
    try {
      raw = await readFile(join(this.dir(), safeKey(attemptId) + ".jsonl"), "utf8");
    } catch {
      return []; // no log yet (or unreadable) — absence is a fact, not an error
    }
    const out: SessionEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as { at?: string; kind?: string } & Record<string, unknown>;
        if (!rec || typeof rec.kind !== "string") continue;
        out.push({ ...(rec as object), at: rec.at ?? "", v: 1, kind: rec.kind });
      } catch {
        continue; // incomplete trailing record (crash mid-write) — drop, not fail
      }
    }
    return out;
  }
}
