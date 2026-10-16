/**
 * Terminal dashboard renderer — deterministic templates over a RunView.
 *
 * Constraints enforced here (mission §4-§8):
 *  - zero LLM calls: every line is built from the projection;
 *  - colors only when the caller says a TTY is present (CI/redirect safe);
 *  - readable without interactivity; `--detail` adds the full timeline;
 *  - unknown metrics are shown as unknown, confirmed zeros as zero.
 */
import type { RunView, TimelineView } from "./viewmodel.ts";

export interface RenderOptions {
  /** Emit ANSI color codes (true only for a real TTY). */
  colors?: boolean;
  /** Maximum terminal width (columns). */
  width?: number;
  /** Show the full timeline and per-attempt rows. */
  detail?: boolean;
  /** Limit timeline lines shown in summary mode (default 12). */
  timelineLimit?: number;
}

type Palette = { info: string; warn: string; error: string; success: string; dim: string; bold: string; reset: string };

function palette(colors: boolean): Palette {
  return colors
    ? { info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m", success: "\x1b[32m", dim: "\x1b[90m", bold: "\x1b[1m", reset: "\x1b[0m" }
    : { info: "", warn: "", error: "", success: "", dim: "", bold: "", reset: "" };
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m < 60) return sec ? `${m}m${String(sec).padStart(2, "0")}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

function tokensLine(v: { input: number; output: number; reasoning: number; cacheRead: number; cost: number; unknown: boolean }): string {
  if (v.unknown) return "unknown (no usage recorded)";
  return `${v.input} in / ${v.output} out / ${v.reasoning} reasoning / cache-read ${v.cacheRead}`;
}

function truncateCell(s: string, max: number): string {
  const one = s.replace(/[\r\n]+/g, " ").trim();
  return one.length <= max ? one : one.slice(0, max - 1) + "…";
}

export function renderSummary(view: RunView, opts: RenderOptions = {}): string {
  const width = Math.max(60, Math.min(160, opts.width ?? 100));
  const c = palette(opts.colors ?? false);
  const out: string[] = [];
  const bar = "─".repeat(width);

  // ---- header ----
  const executed = formatDuration(view.elapsedMs);
  out.push(`${c.bold}OAE ${view.id}${c.reset}  ·  ${view.phase}  ·  ${view.status}${view.status === "running" ? `  ·  ${executed}` : `  ·  ${executed}${view.endedAt ? ` (fim ${view.endedAt.slice(11, 19)}Z)` : ""}`}`);
  out.push(`${c.dim}${truncateCell(view.request, width - 2)}${c.reset}`);
  out.push(bar);

  // ---- current work ----
  const lastAttempt = view.tasks.flatMap((t) => t.attempts).at(-1);
  if (view.status === "running" && lastAttempt && lastAttempt.outcome === "running") {
    out.push(`${c.info}agente ativo:${c.reset} ${lastAttempt.agent} (attempt ${lastAttempt.id}, ${lastAttempt.kind}, sessão ${lastAttempt.sessionId.slice(0, 18)}…)`);
  }
  if (view.lastConfirmedActivity) {
    const ago = view.secondsSinceActivity !== undefined ? ` — há ${formatDuration(view.secondsSinceActivity * 1000)}` : "";
    out.push(`${c.dim}última atividade confirmada:${c.reset} ${truncateCell(view.lastConfirmedActivity.label, width - 32)}${ago}`);
  }
  if (view.stallMs !== undefined) {
    out.push(`${c.warn}⚠ sem progresso detectável há ${formatDuration(view.stallMs)}${c.reset}`);
  }

  // ---- alerts ----
  const alerts: string[] = [];
  for (const p of view.providerErrors.slice(-5)) {
    alerts.push(`HTTP ${p.httpStatus ?? "—"} [${p.runnerKind}]${p.at ? ` @${p.at.slice(11, 19)}Z` : ""}: ${truncateCell(p.message.replace(/^(provider\/run|runner) error: |^provider\/run error: /, ""), Math.max(40, width - 46))}`);
  }
  if (view.tasks.some((t) => t.blockedReason)) {
    for (const t of view.tasks.filter((x) => x.blockedReason).slice(-4)) {
      alerts.push(`tarefa ${t.id} bloqueada: ${truncateCell(t.blockedReason ?? "", 80)}`);
    }
  }
  if (alerts.length) {
    out.push(`${c.error}alertas:${c.reset}`);
    for (const a of alerts.slice(-4)) out.push(`  ${c.error}▸${c.reset} ${a}`);
  }

  // ---- tasks ----
  if (view.tasks.length) {
    out.push("");
    out.push(`${c.bold}tarefas${c.reset}`);
    for (const t of view.tasks) {
      const icon = t.status === "done" ? `${c.success}✔${c.reset}` : t.status === "blocked" ? `${c.error}✗${c.reset}` : t.status === "failed" ? `${c.error}✗${c.reset}` : `${c.info}•${c.reset}`;
      const codeRe = t.codeAttempts > 1 ? ` (tentativas de código: ${t.codeAttempts})` : "";
      out.push(` ${icon} ${t.id} ${t.status.padEnd(11)} ${truncateCell(t.title, width - 30)}${codeRe}${t.commit ? `  commit ${String(t.commit).slice(0, 7)}` : ""}`);
    }
  }

  // ---- validators ----
  if (view.validators.length) {
    out.push("");
    out.push(`${c.bold}validações${c.reset}`);
    for (const v of view.validators.slice(-6)) {
      const ok = v.code === 0 && !v.timedOut;
      out.push(`  ${ok ? `${c.success}✔${c.reset}` : `${c.error}✗${c.reset}`} ${v.name}: exit=${v.code}${v.timedOut ? " (timeout)" : ""} @${v.at.slice(11, 19)}Z`);
    }
  }

  // ---- tokens ----
  out.push("");
  out.push(`${c.bold}consumo${c.reset}  (tentativas com telemetria: ${view.tokens.attemptsWithTokens}/${view.tokens.recordedAttempts})`);
  out.push(`  total: ${tokensLine(view.tokens.totals)}`);

  // ---- timeline ----
  const limit = opts.detail ? view.timeline.length : opts.timelineLimit ?? 12;
  const lines = view.timeline.slice(-limit);
  if (lines.length) {
    out.push("");
    out.push(`${c.bold}linha do tempo${c.reset}${opts.detail ? "" : ` (últimos ${lines.length} eventos)`}`);
    if (!opts.detail && view.timeline.length > lines.length) {
      out.push(`  ${c.dim}… ${view.timeline.length - lines.length} eventos anteriores omitidos${c.reset}`);
    }
    for (const t of lines) out.push(...timelineLine(t, width, c));
  }

  // ---- footer ----
  if (view.summary) {
    out.push(bar);
    out.push(`${c.bold}resumo${c.reset}  ${truncateCell(view.summary, width - 8)}`);
  }
  return out.join("\n");
}

function timelineLine(t: TimelineView, width: number, c: Palette): string[] {
  const mark = t.level === "error" ? `${c.error}✗${c.reset}` : t.level === "warn" ? `${c.warn}⚠${c.reset}` : t.level === "success" ? `${c.success}✔${c.reset}` : `${c.dim}·${c.reset}`;
  const time = t.at.slice(11, 19);
  const wrapMax = width - 14;
  const label = truncateCell(t.label, wrapMax);
  return [` ${mark} ${c.dim}${time}Z${c.reset} ${label}`];
}

/** Compact final-result paragraph for the end of a run (uses real outcomes). */
export function renderResultLine(view: RunView, opts: RenderOptions = {}): string {
  const c = palette(opts.colors ?? false);
  const done = view.tasks.filter((t) => t.status === "done").length;
  const failed = view.tasks.filter((t) => ["failed", "blocked"].includes(t.status)).length;
  const valOk = view.validators.length ? view.validators.every((v) => v.code === 0 && !v.timedOut) : undefined;
  const warn = view.status === "running" ? `${c.warn}EM EXECUÇÃO — resultado ainda indefinido${c.reset}` :
    view.phase === "concluída" ? `${c.success}CONCLUÍDA${c.reset}` : `${c.error}FALHOU/BLOQUEADA${c.reset}`;
  return `status: ${warn} · tarefas: ${done} concluídas${failed ? `, ${failed} bloqueadas/failed` : ""}${valOk !== undefined ? ` · validadores: ${valOk ? "ok" : "falhou"}` : ""} · ${formatDuration(view.elapsedMs)} · tokens: ${view.tokens.totals.unknown ? "desconhecido" : `${view.tokens.totals.input} in/${view.tokens.totals.output} out`}`;
}
