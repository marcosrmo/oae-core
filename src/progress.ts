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
 * secrets, but a provider error body could echo an Authorization header. */
export function redact(s: string): string {
  return s
    .replace(/(bearer\s+)[A-Za-z0-9._\-]{8,}/gi, "$1[redacted]")
    .replace(/\bnvapi-[A-Za-z0-9._\-]{8,}/g, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9._\-]{8,}/g, "[redacted]")
    .replace(/\b(sk|ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_\-]{8,}/g, "[redacted]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{8,}/g, "[redacted]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9._\-]{16,}/g, "[redacted]")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)["']?[A-Za-z0-9._\-]{8,}/gi, "$1[redacted]");
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
