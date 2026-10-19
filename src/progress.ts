/**
 * Live progress feed (Fase V): renders REAL OAE events as timestamped terminal
 * lines while `oae run` is working — so a long run is no longer silent until
 * its final report.
 *
 * Rules enforced here (and tested):
 *  - every line comes from an event that was actually persisted: the Store
 *    notifies subscribers only AFTER the append, so there is no fabricated
 *    "still working" output — silence means no event, never a fake heartbeat;
 *  - the feed is human-facing and goes to STDERR by default, so
 *    `oae run > report.md` keeps stdout as the final report only;
 *  - ANSI colors only when the caller says a real TTY is present (CI-safe);
 *  - `agent_progress` lines are throttled per attempt so a chatty session can
 *    never turn the terminal into an event storm;
 *  - every rendered string passes through `redact`: credentials and tokens
 *    never reach the terminal (they also never reach the event log).
 *
 * The states below are a *view* of the existing event taxonomy (D16) — no new
 * persisted state is introduced, and unknown kinds are shown as `unknown`
 * rather than guessed.
 */
import type { OaeEvent } from "./events.ts";

export type ProgressState =
  | "planning" | "running" | "waiting" | "validating" | "recovering"
  | "interrupted" | "failed" | "completed" | "unknown" | "info";

const STATE_COLOR: Record<ProgressState, string> = {
  planning: "\x1b[36m",
  running: "\x1b[36m",
  waiting: "\x1b[2m",
  validating: "\x1b[35m",
  recovering: "\x1b[33m",
  interrupted: "\x1b[33m",
  failed: "\x1b[31m",
  completed: "\x1b[32m",
  unknown: "\x1b[90m",
  info: "\x1b[90m",
};

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Mask anything credential-shaped. Defence in depth: events never carry
 * secrets, but a provider error body could echo an Authorization header.
 * Stem rules (nvapi-/sk-/gh*_stem/github_pat_/xox-/eyJ) historically used
 * \b before the stem; a secret glued to an adjacent word char (a gateway
 * echoing "xsk-or-v1-…") then escaped BOTH redact() and the truncation-boundary
 * scrub. Post-audit (2026-10-19) the \b is dropped on those stems: recognition
 * is now boundary-agnostic. Over-masking cost is bounded on purpose — every
 * rule still demands the stem plus ≥8 contiguous token chars (JWT ≥16), so a
 * legit prose fragment at most loses ONE token-shaped substring (e.g.
 * "task-01234567"); short non-token fragments like "task-02" stay visible. */
export function redact(s: string): string {
  return s
    .replace(/(bearer\s+)[A-Za-z0-9._\-]{8,}/gi, "$1[redacted]")
    .replace(/nvapi-[A-Za-z0-9._\-]{8,}/g, "[redacted]")
    .replace(/sk-[A-Za-z0-9._\-]{8,}/g, "[redacted]")
    .replace(/(sk|ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_\-]{8,}/g, "[redacted]")
    .replace(/github_pat_[A-Za-z0-9_]{8,}/g, "[redacted]")
    .replace(/xox[baprs]-[A-Za-z0-9-]{8,}/g, "[redacted]")
    .replace(/eyJ[A-Za-z0-9._\-]{16,}/g, "[redacted]")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)["']?[A-Za-z0-9._\-]{8,}/gi, "$1[redacted]");
}

/** R2 (truncation-boundary redaction): `redact()` needs ≥8 chars after a
 * secret's stem to match, so a token that a SIZE CAP cut in the middle
 * escapes it — a fragment like "sk-or-v1-" remains visible. Runs AFTER a
 * bounded excerpt was produced: masks any string END that starts with one
 * of the same redact()-recognized stems and runs to the end, however few
 * chars follow (plus the "…(truncated)" suffix truncateBytes may append).
 * Like redact() itself, the stem match is now boundary-agnostic, so a root
 * glued to a neighbor word ("xsk-or-v1-0") is caught too. Mid-body short
 * fragments are intentionally untouched: redact()'s ≥8-char rule already
 * classifies them as not token-shaped. The guarantee covers redact()-
 * RECOGNIZABLE secrets only (nvapi-/sk-/gh*_stem/github_pat_/xox-/eyJ/
 * bearer/"key: value"); keys with no recognizable stem and cuts INSIDE the
 * stem itself remain out of scope exactly as in redact() itself. */
export function redactTruncatedTail(s: string): string {
  const base = redact(s);
  const re = /((?:nvapi-|bearer\s+|sk-|(?:sk|ghp|gho|ghu|ghs|ghr)_|github_pat_|xox[baprs]-|eyJ|(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?))[A-Za-z0-9._\-]*(?:…\(truncated\))?\s*$/i;
  const m = base.match(re);
  // mask the whole tail INCLUDING the stem: a stem fragment like "sk-or-v1-"
  // is vendor-identifying material too (the audit probe flagged it); keeping
  // "[redacted]" alone is enough for diagnostics
  return m && m.index !== undefined ? `${base.slice(0, m.index)}[redacted]` : base;
}

function str(x: unknown): string | undefined {
  if (typeof x === "string") return x;
  if (typeof x === "number" && Number.isFinite(x)) return String(x);
  return undefined;
}
function num(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}
function clamp(s: string, max: number): string {
  const one = s.replace(/[\r\n]+/g, " ").trim();
  return one.length <= max ? one : one.slice(0, max - 1) + "…";
}
function secs(ms: number | undefined): string {
  return `${Math.round((ms ?? 0) / 1000)}s`;
}

export interface ProgressFrame {
  state: ProgressState;
  scope?: string;
  message: string;
  /** When set, consecutive frames with the same key are throttled by time. */
  throttleKey?: string;
}

/** Map one persisted event to a progress state + message. Pure. */
export function progressFrame(ev: OaeEvent): ProgressFrame {
  const d = ev as Record<string, unknown>;
  switch (ev.kind) {
    case "run_started":
      return { state: "planning", message: `run started — ${clamp(str(d.request) ?? "", 90)}${str(d.model) ? ` (model ${str(d.model)})` : ""}` };
    case "plan_ready":
      return { state: "running", message: `plan ready — ${str(d.tasks) ?? "?"} task(s)${str(d.summary) ? `: ${clamp(str(d.summary) ?? "", 70)}` : ""}` };
    case "task_added":
      return { state: "planning", scope: str(d.taskId), message: `task added: ${clamp(str(d.title) ?? "", 70)}` };
    case "task_updated":
      return { state: "running", scope: str(d.taskId), message: `task → ${str(d.status) ?? "?"}` };
    case "attempt_added":
      return {
        state: "waiting",
        scope: evScope(d),
        message: `attempt ${str(d.attemptId) ?? "?"} dispatched (agent ${str(d.agent) ?? "?"}, kind ${str(d.attemptKind) ?? "?"}) — waiting for the session`,
      };
    case "agent_progress":
      return {
        state: "running",
        scope: evScope(d),
        message: `agent activity: ${clamp(str(d.detail) ?? "", 100)}`,
        throttleKey: evScope(d),
      };
    case "attempt_finished": {
      const outcome = str(d.outcome) ?? "?";
      const bad = ["failed", "rejected", "interrupted"].includes(outcome);
      return {
        state: bad ? "failed" : "running",
        scope: evScope(d),
        message: `attempt ${str(d.attemptId) ?? "?"} (${str(d.attemptKind) ?? "?"}) → ${outcome} [${secs(num(d.elapsedMs))}]`,
      };
    }
    case "validator": {
      const ok = d.code === 0 && !d.timedOut;
      return {
        state: "validating",
        message: `validator ${str(d.name) ?? "?"}: exit=${str(d.code) ?? "?"}${d.timedOut ? " (TIMED OUT)" : ""}${ok ? " — ok" : " — failed"}`,
      };
    }
    case "decision":
      return { state: "info", message: `decision [${str(d.decisionKind) ?? str(d.kind) ?? "?"}] ${clamp(str(d.text) ?? "", 90)}` };
    case "retry_scheduled":
      return {
        state: "recovering",
        scope: str(d.taskId),
        message: `retry scheduled${num(d.attemptNo) ? ` (attempt ${d.attemptNo})` : ""}: ${clamp(str(d.reason) ?? "", 80)}${num(d.waitMs) ? ` — waiting ${secs(num(d.waitMs))}` : ""}`,
      };
    case "session_interrupted":
      return { state: "recovering", scope: evScope(d), message: `session interrupted (attempt ${str(d.attemptId) ?? "?"})` };
    case "supervisor_diagnose":
      return { state: "recovering", scope: str(d.taskId), message: `supervisor diagnose: idle ${secs(num(d.idleMs))} without verifiable progress` };
    case "supervisor_recover":
      return { state: "recovering", scope: str(d.taskId), message: `supervisor recovery: interrupted the stalled agent after ${secs(num(d.idleMs))}` };
    case "supervisor_quarantine":
      return { state: "failed", scope: str(d.taskId), message: `supervisor quarantine: limits reached` };
    case "provider_error":
      return {
        state: "failed",
        scope: evScope(d),
        message: `provider error${num(d.httpStatus) ? ` (HTTP ${d.httpStatus})` : ""}: ${clamp(str(d.message) ?? "", 100)}`,
      };
    case "task_error":
      return { state: "failed", scope: str(d.taskId), message: `task error: ${clamp(str(d.error) ?? "", 90)}` };
    case "run_finished": {
      const st = str(d.status) ?? "?";
      return {
        state: st === "done" ? "completed" : "failed",
        message: `run finished: ${st}${str(d.summary) ? ` — ${clamp(str(d.summary) ?? "", 90)}` : ""}`,
      };
    }
    case "run_reconciled":
      return {
        state: "interrupted",
        message: `run reconciled: ${str(d.from) ?? "?"} → ${str(d.to) ?? "interrupted"} (${clamp(str(d.reason) ?? "", 80)})`,
      };
    default:
      return { state: "unknown", message: `event ${ev.kind}` };
  }
}

function evScope(d: Record<string, unknown>): string | undefined {
  const task = str(d.taskId);
  const attempt = str(d.attemptId);
  if (!task) return undefined;
  return attempt ? `${task}#${attempt}` : task;
}

/** Format one event as a single terminal line (undefined when nothing to show). */
export function progressLine(ev: OaeEvent, colors = false): { line: string; frame: ProgressFrame } {
  const frame = progressFrame(ev);
  const time = `[${(ev.at ?? "").slice(11, 19) || "--:--:--"}Z]`;
  const tagPlain = `[${frame.state}]`.padEnd(13);
  const scopeCell = frame.scope ? `${frame.scope}`.padEnd(13) : "";
  const paint = (code: string, s: string) => (colors ? `${code}${s}${RESET}` : s);
  const line = `${paint(DIM, time)} ${paint(STATE_COLOR[frame.state], tagPlain)}${scopeCell}${redact(frame.message)}`;
  return { line, frame };
}

export interface ProgressReporterOptions {
  /** ANSI colors (true only for a real TTY). */
  colors?: boolean;
  /** Sink for complete lines; defaults to stderr (stdout stays the report). */
  write?: (s: string) => void;
  /** Injectable clock for deterministic throttling tests. */
  now?: () => number;
  /** Minimum ms between two throttled frames with the same scope (default 2 s). */
  throttleMs?: number;
}

/**
 * Build the Store event subscriber that prints progress. Returning the
 * subscriber (instead of having it write straight to process.stderr) keeps it
 * fully testable: tests inject `write` and `now`.
 */
export function createProgressReporter(opts: ProgressReporterOptions = {}): (rec: Record<string, unknown>) => void {
  const colors = opts.colors ?? false;
  const write = opts.write ?? ((s: string) => { process.stderr.write(s); });
  const now = opts.now ?? (() => Date.now());
  const throttleMs = opts.throttleMs ?? 2000;
  const last = new Map<string, number>();
  return (rec: Record<string, unknown>): void => {
    const { line, frame } = progressLine(rec as OaeEvent, colors);
    if (frame.throttleKey) {
      const t = now();
      const prev = last.get(frame.throttleKey);
      if (prev !== undefined && t - prev < throttleMs) return;
      last.set(frame.throttleKey, t);
    }
    write(line.endsWith("\n") ? line : line + "\n");
  };
}
