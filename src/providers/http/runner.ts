/**
 * HTTP AgentRunner for direct chat-completions providers (Onda 2).
 *
 * Stateful session over a stateless API: the message array IS the session.
 * Implements the SAME AgentRunner contract as the OpenCode adapter:
 *   - createSession dispatches the first prompt; dispatch failures (auth/
 *     network/HTTP status) reject BEFORE any attempt is consumed;
 *   - awaitCompletion settles exactly once (completed | interrupted | failed)
 *     with the OpenCode outcome vocabulary and error markers
 *     ("provider/run error:", "runner error:") so the orchestrator's failure
 *     classification and 429/401 gates work unchanged;
 *   - interrupt() aborts the in-flight request via AbortController;
 *   - usage() aggregates per-round token reports; null when none reported;
 *   - tool calls (coder only) execute the confined local file tools and the
 *     conversation continues round-by-round until a plain final text reply.
 *
 * No `@opencode/client`, no opencode process, no dynamic import of either.
 */
import { randomUUID } from "node:crypto";
import type { AgentRunResult, AgentRunner, ProgressSignal, SessionUsage } from "../../contracts.ts";
import { ProviderError } from "../../contracts.ts";
import { truncate } from "../../util.ts";
import { redact } from "../../progress.ts";
import { HttpTransport, type ChatMessage, type ChatReply, type ChatToolCall, type ToolSchema } from "./transport.ts";
import { FileToolSet, fileToolSpecs } from "./filetools.ts";

export interface HttpRunnerSpec {
  /** Runtime id, e.g. "nvidia-direct" (also the AgentRunner.runtime). */
  provider: string;
  baseUrl: string;
  apiKey: string;
  /** Model id sent verbatim in every request body. */
  model: string;
  /** Role name ("plan" | "build" | ...): shapes the default system prompt. */
  agent: string;
  toolsEnabled: boolean;
  /** Project root for the confined file tools (session directory). */
  root: string;
  /** First user text (dispatched by begin()); the orchestrator always sends it. */
  promptText: string;
  /** Overrides the default system prompt entirely (tests may use this). */
  systemPrompt?: string;
  /** Tool-call round budget per task attempt (default 12). */
  maxToolRounds?: number;
  /** Injectable file-tool executor (tests simulate non-cooperative tools). */
  toolExecutor?: ToolExecutor;
  /** Injectable fetch for offline tests. */
  fetchImpl?: typeof fetch;
  /** Send stream_options.include_usage (nvidia: yes; openrouter: no). */
  includeUsage?: boolean;
}

type RoundHandle = ReturnType<HttpTransport["open"]>;

/** Minimal surface the runner needs from the file-tool layer (audit F1:
 * the injection point also lets tests simulate a non-cooperative tool). */
export interface ToolExecutor {
  execute(name: string, rawArgs: string, signal?: AbortSignal): Promise<string>;
}

const SIGNALS_CAP = 500;

export class HttpAgentRunner implements AgentRunner {
  readonly runtime: string;
  readonly sessionId: string;
  private model: string;
  private messages: ChatMessage[] = [];
  private transport: HttpTransport;
  private tools: ToolSchema[] | undefined;
  private toolset: ToolExecutor | undefined;
  private maxToolRounds: number;
  private controller = new AbortController();
  private state: "idle" | "running" | "settled" = "idle";
  private result: AgentRunResult | null = null;
  private waiters: ((r: AgentRunResult) => void)[] = [];
  private signals: ProgressSignal[] = [];
  private onProgress: ((s: ProgressSignal) => void) | null = null;
  private usageAcc: SessionUsage | null = null;
  private hadUsage = false;
  private pendingUser: string[] = [];
  private interruptedFlag = false;
  private toolRounds = 0;
  /** Resolved by interrupt(): the pump races tool executions against it so a
   * non-cancellable tool (audit F1) can never delay settlement indefinitely. */
  private stoppedPromise: Promise<{ kind: "stopped" }> | null = null;
  private stoppedResolver: ((v: { kind: "stopped" }) => void) | null = null;

  constructor(spec: HttpRunnerSpec) {
    this.runtime = spec.provider;
    this.sessionId = `${spec.provider}-${randomUUID().slice(0, 8)}`;
    this.model = spec.model;
    this.maxToolRounds = spec.maxToolRounds ?? 12;
    this.transport = new HttpTransport({
      provider: spec.provider,
      baseUrl: spec.baseUrl,
      apiKey: spec.apiKey,
      fetchImpl: spec.fetchImpl,
      includeUsage: spec.includeUsage,
    });
    this.messages.push({ role: "system", content: spec.systemPrompt ?? defaultSystemPrompt(spec) });
    if (spec.toolsEnabled) {
      this.tools = fileToolSpecs();
      // injection point for tests: a non-cooperative tool executor can be
      // simulated deterministically without FIFOs or hung processes
      this.toolset = spec.toolExecutor ?? new FileToolSet(spec.root);
    }
    this.messages.push({ role: "user", content: spec.promptText });
  }

  /**
   * Dispatch the first prompt. Resolves as soon as the provider ACCEPTS the
   * request (2xx response started — parity with the OpenCode adapter's
   * awaited session.prompt); generation continues in the background until
   * awaitCompletion settles. A rejected dispatch throws here (auth/network/
   * HTTP status), never masked as success.
   */
  async begin(): Promise<void> {
    if (this.state !== "idle") throw new Error("session already started");
    this.state = "running";
    const first = this.transport.open({
      model: this.model,
      messages: this.messages,
      tools: this.tools,
      signal: this.controller.signal,
    });
    void this.pump(first).catch(() => undefined); // pump settles internally
    await first.dispatched;
  }

  /** Follow-up user text. While a chain is running it is queued and picked
   * up after the current final reply; a settled session refuses further
   * prompts (OAE never re-prompts a finished attempt — flagged honest). */
  async prompt(text: string): Promise<void> {
    if (this.state === "settled") throw new Error("session already finished — start a new session instead");
    if (this.state === "idle") throw new Error("session not started — create it via provider.createSession (the first prompt is dispatched there)");
    this.pendingUser.push(text);
  }

  async awaitCompletion(
    timeoutMs: number,
    onProgress?: (s: ProgressSignal) => void,
  ): Promise<AgentRunResult> {
    if (onProgress) this.onProgress = onProgress;
    const deadline = Date.now() + timeoutMs;
    if (this.result) return this.result;
    // audit behavior: at/past the deadline the interrupt takes precedence
    if (Date.now() >= deadline) {
      await this.interrupt();
      return this.result ?? { outcome: "interrupted", output: this.lastAssistantContent(), signals: this.signals };
    }
    const timer = setTimeout(() => { void this.interrupt().catch(() => undefined); }, deadline - Date.now());
    try {
      return await new Promise<AgentRunResult>((res) => {
        if (this.result) { res(this.result); return; }
        this.waiters.push(res);
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async interrupt(): Promise<void> {
    if (this.interruptedFlag) return;
    this.interruptedFlag = true;
    try { this.controller.abort(); } catch { /* idempotent */ }
    if (this.stoppedResolver) { this.stoppedResolver({ kind: "stopped" }); this.stoppedResolver = null; }
    if (this.state === "idle") {
      // never started: nothing in flight; settle honestly as interrupted
      this.settle({ outcome: "interrupted", output: "", signals: this.signals });
    }
  }

  async usage(): Promise<SessionUsage | null> {
    if (!this.hadUsage) return null;
    return this.usageAcc;
  }

  async transcriptTail(maxMessages: number): Promise<string> {
    try {
      const n = Math.max(1, Math.min(maxMessages, this.messages.length));
      const tail = this.messages.slice(-n);
      const lines = tail.map((m) => {
        const role = m.role === "tool" ? `tool(${m.toolCallId ?? ""})` : m.role;
        // A5: redact BEFORE truncation — a secret straddling the cut boundary
        // would otherwise leave a visible short prefix that the redact regex
        // (which needs ≥8 chars) can no longer match
        const tools = m.toolCalls?.map((t) => `→ ${redact(t.name)}(${truncate(redact(t.arguments), 120)})`).join(", ") ?? "";
        const body = truncate(redact(m.content), 500);
        return tools ? `[${role}] ${body} ${tools}` : `[${role}] ${body}`;
      });
      return lines.join("\n") || "(empty transcript)";
    } catch {
      return "(transcript unavailable)"; // contract: never throws
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async pump(first: RoundHandle): Promise<void> {
    let h = first;
    let round = 1;
    try {
      for (;;) {
        this.signal({ kind: "message", detail: `round ${round} dispatched (${this.model})` });
        const reply = await h.consume();
        this.absorbUsage(reply.usage);
        this.signal({
          kind: "message",
          detail: `round ${round} finished (${reply.finishReason ?? "no marker"}), ${reply.toolCalls?.length ?? 0} tool call(s)`,
        });
        const wantsTools = (reply.toolCalls?.length ?? 0) > 0 && this.toolset !== undefined;
        if (wantsTools && this.toolRounds >= this.maxToolRounds) {
          this.settle({
            outcome: "failed",
            output: `runner error: tool-call round budget (${this.maxToolRounds}) exhausted before a final answer${this.droppedFollowUpsNote()}`,
            signals: this.signals,
          });
          return;
        }
        if (wantsTools && this.toolset) {
          this.toolRounds++;
          this.pushAssistantRound(reply.content, reply.toolCalls!);
          for (const call of reply.toolCalls!) {
            if (this.interruptedFlag) {
              this.settle({ outcome: "interrupted", output: this.lastAssistantContent() + this.droppedFollowUpsNote(), signals: this.signals });
              return;
            }
            // redact before serialization: tool arguments are the only text
            // the model controls that transits signals/transcript raw (F9)
            // A5: redact before truncate (see transcriptTail note above)
            this.signal({ kind: "tool", detail: `${redact(call.name) || "?"} ${truncate(redact(call.arguments), 160)}` });
            const exec = this.toolset.execute(call.name, call.arguments, this.controller.signal);
            // F1: race the execution against stop. A tool that ignores
            // cancellation (e.g. open() on a FIFO — not signal-cancellable at
            // the OS level) can no longer block settlement: the interrupted
            // result wins the race and the late resolution is discarded so it
            // can never restart the pump or double-settle.
            const raced = await Promise.race([
              exec.then(
                (out): { kind: "done"; out: string } => ({ kind: "done", out }),
                (err: unknown): { kind: "err"; err: unknown } => ({ kind: "err", err }),
              ),
              this.waitStopped(),
            ]);
            if (raced.kind === "stopped") {
              void exec.then(() => undefined, () => undefined); // no unhandled rejection
              this.settle({ outcome: "interrupted", output: this.lastAssistantContent() + this.droppedFollowUpsNote(), signals: this.signals });
              return;
            }
            if (raced.kind === "err") throw raced.err;
            this.messages.push({ role: "tool", toolCallId: call.id, content: raced.out });
          }
          h = this.transport.open({
            model: this.model,
            messages: this.messages,
            tools: this.tools,
            signal: this.controller.signal,
          });
          round++;
          await h.dispatched;
          continue;
        }
        // queued follow-ups (prompt()) keep the chain alive before settling
        const pending = this.pendingUser;
        this.pendingUser = [];
        if (pending.length) {
          for (const t of pending) this.messages.push({ role: "user", content: t });
          h = this.transport.open({
            model: this.model,
            messages: this.messages,
            tools: this.tools,
            signal: this.controller.signal,
          });
          round++;
          await h.dispatched;
          continue;
        }
        this.settle({ outcome: "completed", output: reply.content, signals: this.signals });
        return;
      }
    } catch (e) {
      if (this.interruptedFlag || this.controller.signal.aborted) {
        this.settle({ outcome: "interrupted", output: this.lastAssistantContent() + this.droppedFollowUpsNote(), signals: this.signals });
        return;
      }
      // provider failures (classified by the central engine) keep the
      // "provider/run error:" marker so the orchestrator's 429/401 gates and
      // provider_error events work exactly as they do for the OpenCode path
      if (e instanceof ProviderError) {
        this.settle({ outcome: "failed", output: `provider/run error: ${e.message}${this.droppedFollowUpsNote()}`, signals: this.signals });
        return;
      }
      this.settle({ outcome: "failed", output: `runner error: ${String((e as Error)?.message ?? e)}${this.droppedFollowUpsNote()}`, signals: this.signals });
    }
  }

  private pushAssistantRound(content: string, toolCalls: ChatToolCall[]): void {
    this.messages.push({ role: "assistant", content, toolCalls });
  }

  /** Lazily created stop promise, already resolved if interrupt won earlier. */
  private waitStopped(): Promise<{ kind: "stopped" }> {
    if (!this.stoppedPromise) {
      this.stoppedPromise = new Promise<{ kind: "stopped" }>((res) => {
        this.stoppedResolver = res;
      });
      if (this.interruptedFlag) this.stoppedResolver?.({ kind: "stopped" });
      return this.stoppedPromise;
    }
    return this.stoppedPromise;
  }

  /** Follow-ups accepted while running are the user's words — a terminal
   * state (budget exhausted, failure, interruption) that would silently drop
   * them must say so in the result the orchestrator records (F6). */
  private droppedFollowUpsNote(): string {
    const n = this.pendingUser.length;
    this.pendingUser = [];
    return n > 0 ? ` (${n} queued follow-up prompt(s) were dropped by this terminal session state)` : "";
  }

  private lastAssistantContent(): string {
    const last = [...this.messages].reverse().find((m) => m.role === "assistant");
    return last?.content ?? "";
  }

  private absorbUsage(u: ChatReply["usage"]): void {
    if (!u) return;
    this.hadUsage = true;
    const acc = this.usageAcc ?? { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: null };
    acc.input += u.input;
    acc.output += u.output;
    acc.reasoning += u.reasoning;
    acc.cacheRead += u.cacheRead;
    acc.cacheWrite += u.cacheWrite;
    this.usageAcc = acc;
  }

  private signal(s: { kind: string; detail: string }): void {
    const bounded: ProgressSignal = { at: new Date().toISOString(), kind: s.kind, detail: s.detail };
    this.signals.push(bounded);
    if (this.signals.length > SIGNALS_CAP) this.signals.splice(0, this.signals.length - SIGNALS_CAP);
    try { this.onProgress?.(bounded); } catch { /* a failing consumer never crashes the session */ }
  }

  private settle(r: AgentRunResult): void {
    if (this.state === "settled") return; // build the result exactly once
    this.state = "settled";
    this.result = r;
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w(r);
  }
}

function defaultSystemPrompt(spec: HttpRunnerSpec): string {
  if (spec.toolsEnabled) {
    return [
      `You are the "${spec.agent}" agent (coder) of an autonomous engineering run operating through a direct chat API.`,
      "You can inspect and modify the project using the provided functions: read_file, write_file, list_dir.",
      "All paths are RELATIVE to the project root; absolute paths, '..' and symlinks are refused by the tool layer.",
      "The '.oae/' and '.opencode/' directories are read-only (they belong to the orchestrator).",
      "Investigate with the tools before editing; make small, verifiable changes.",
      "When the work is done, finish with a plain text reply (NO tool calls) containing the 'RESULT:' section requested by the user message.",
    ].join("\n");
  }
  return `You are the "${spec.agent}" agent of an autonomous engineering run (direct chat API). No tools are available: respond with plain text only.`;
}
