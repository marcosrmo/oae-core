/**
 * Shared chat-completions HTTP transport for direct providers (Onda 2).
 *
 * OpenAI-compatible wire format over plain fetch — NO SDK, no
 * `@opencode/client`, no opencode process anywhere in this file's import
 * graph. Unit tests inject `fetchImpl` and run fully offline.
 *
 * Semantics (docs/onda2-plan.md §3):
 * - streaming SSE (delta.content, finish_reason, [DONE]) as default;
 *   a gateway that rejects streaming with a 400 mentioning "stream" gets one
 *   transparent non-streaming retry and the session stays non-streaming;
 * - non-OK responses and thrown fetch errors map through the SINGLE central
 *   classification engine (contracts.ts) — 401/403→auth, 429→rateLimit,
 *   5xx→unavailable, other 4xx→protocol, net errors by message;
 * - error strings are redacted at construction (never echo an Authorization
 *   header the gateway might bounce back);
 * - bounded buffers: unbounded model dumps cannot balloon memory.
 */
import { classifyHttpFailure, classifyProviderError, ProviderError } from "../../contracts.ts";
import { redact } from "../../progress.ts";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatToolCall {
  id: string;
  name: string;
  arguments: string; // raw JSON, validated by the tool executor
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  toolCalls?: ChatToolCall[]; // assistant messages only
  toolCallId?: string;        // tool messages only
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ChatReply {
  content: string;
  toolCalls?: ChatToolCall[];
  finishReason?: string;
  usage?: ChatUsage;
}

export interface TransportConfig {
  /** Classification label, e.g. "nvidia-direct". */
  provider: string;
  /** e.g. "https://integrate.api.nvidia.com/v1" (no trailing slash). */
  baseUrl: string;
  /** Secret: travels ONLY in the transport's Authorization header construction. */
  apiKey: string;
  /** Injectable for offline tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Hard caps: bounded buffers, never unbounded memory. */
export const TRANSPORT_CAPS = {
  /** Accumulated assistant content per round ≤ 1 MiB. */
  roundContentBytes: 1_000_000,
  /** One tool-call arguments blob ≤ 64 KiB. */
  toolArgsBytes: 64_000,
  /** Distinct tool_call slots (indexes) per round ≤ 32 — a legit reply carries
   * a handful of calls; an index flood from a broken/hostile gateway must
   * fail as a controlled protocol error instead of growing memory (F3). */
  toolSlotsMax: 32,
  /** Error-body excerpt echoed into a classified error message ≤ 2 KiB. */
  errorExcerptBytes: 2_000,
} as const;

interface WireChatMessage {
  role: ChatRole;
  content: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

function wire(messages: ChatMessage[]): WireChatMessage[] {
  return messages.map((m): WireChatMessage => {
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content,
        tool_calls: m.toolCalls.map((t) => ({
          id: t.id, type: "function", function: { name: t.name, arguments: t.arguments },
        })),
      };
    }
    if (m.role === "tool") return { role: "tool", content: m.content, tool_call_id: m.toolCallId ?? "" };
    return { role: m.role, content: m.content };
  });
}

function mapUsage(u: Record<string, unknown> | undefined): ChatUsage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const comp = (u.completion_tokens_details ?? {}) as Record<string, unknown>;
  return {
    input: num(u.prompt_tokens),
    output: num(u.completion_tokens),
    reasoning: num(comp.reasoning_tokens ?? (u as Record<string, unknown>).reasoning_tokens),
    cacheRead: num(details.cached_tokens),
    cacheWrite: 0,
  };
}

export class HttpTransport {
  private fetchImpl: typeof fetch;
  private provider: string;
  private baseUrl: string;
  /** Sticky non-streaming mode after a gateway refused streaming (quirk). */
  private streamingDisabled = false;

  constructor(cfg: TransportConfig) {
    this.provider = cfg.provider;
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.apiKey = cfg.apiKey;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  /** Held by the transport only; never rendered, logged, serialized or echoed
   * into an error (all error paths redact at construction). */
  private apiKey: string;

  /**
   * Open a chat-completions request. Split lifecycle so runners can surface
   * dispatch failures (auth/network/…) immediately at session creation while
   * the model keeps generating in the background:
   *   open(...)  → returns { dispatched, consume() }
   *   dispatched → resolved right after a successful (2xx) response starts;
   *   consume()  → parses the body into a normalized ChatReply.
   */
  open(opts: {
    model: string;
    messages: ChatMessage[];
    tools?: ToolSchema[];
    signal: AbortSignal;
  }): { dispatched: Promise<void>; consume: () => Promise<ChatReply> } {
    let consumedStarted = false;
    const stream = !this.streamingDisabled;

    const bodyObj: Record<string, unknown> = {
      model: opts.model,
      messages: wire(opts.messages),
      stream,
    };
    if (stream) bodyObj.stream_options = { include_usage: true };
    if (opts.tools?.length) {
      bodyObj.tools = opts.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      bodyObj.tool_choice = "auto";
    }

    const resPromise: Promise<Response> = (async () => {
      const res = await this.doFetch(opts.model, bodyObj, opts.signal);
      if (res.ok) return res;
      // gateway refused streaming → one transparent non-streaming retry
      if (stream && res.status === 400) {
        // F4: the excerpt is read EXACTLY once — a body already consumed can
        // never be re-read, so either the retry happens or the error message
        // carries the real gateway diagnostic
        const excerpt = await readExcerpt(res, 300);
        if (excerpt.toLowerCase().includes("stream")) {
          this.streamingDisabled = true;
          bodyObj.stream = false;
          delete bodyObj.stream_options;
          const res2 = await this.doFetch(opts.model, bodyObj, opts.signal);
          if (res2.ok) return res2;
          throw await this.errorFrom(res2);
        }
        throw new ProviderError(classifyHttpFailure(res.status), this.provider, redact(`HTTP ${res.status}: ${excerpt}`), res.status);
      }
      throw await this.errorFrom(res);
    })();

    return {
      dispatched: (async () => {
        await resPromise;
      })(),
      consume: async () => {
        if (consumedStarted) throw new Error("transport round already consumed");
        consumedStarted = true;
        const res = await resPromise;
        if (res.status >= 400) throw await this.errorFrom(res); // retry path race
        try {
          const ct = res.headers.get("content-type") ?? "";
          const looksSse = ct.includes("text/event-stream");
          const looksJson = ct.includes("application/json");
          const useSse = looksSse || (!looksJson && typeof bodyObj.stream === "boolean" && bodyObj.stream);
          if (useSse) return await parseSseBody(res, this.provider, opts.signal);
          const raw = await readAll(res);
          return parseNonStreamReply(raw, this.provider);
        } finally {
          res.body?.cancel().catch(() => undefined);
        }
      },
    };
  }

  /** Full round in one call (convenience for single-shot consumers/tests). */
  async chat(opts: {
    model: string;
    messages: ChatMessage[];
    tools?: ToolSchema[];
    signal: AbortSignal;
  }): Promise<ChatReply> {
    const h = this.open(opts);
    await h.dispatched;
    return h.consume();
  }

  private async doFetch(_model: string, bodyObj: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    const url = `${this.baseUrl}/chat/completions`;
    try {
      return await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          "accept": bodyObj.stream ? "text/event-stream" : "application/json",
        },
        body: JSON.stringify(bodyObj),
        signal,
      });
    } catch (e) {
      throw classifyProviderError(e, this.provider);
    }
  }

  private async errorFrom(res: Response): Promise<ProviderError> {
    const excerpt = await readExcerpt(res, TRANSPORT_CAPS.errorExcerptBytes);
    const message = redact(`HTTP ${res.status}: ${excerpt}`);
    return new ProviderError(classifyHttpFailure(res.status), this.provider, message, res.status);
  }
}

async function readExcerpt(res: Response, maxBytes: number): Promise<string> {
  try {
    const text = await res.text();
    return truncateBytes(text, maxBytes);
  } catch {
    return "(unreadable error body)";
  }
}

async function readAll(res: Response): Promise<string> {
  try { return await res.text(); } catch { return "(unreadable body)"; }
}

function truncateBytes(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…(truncated)`;
}

// ── body parsers ────────────────────────────────────────────────────────────

export function parseNonStreamReply(raw: string, provider: string): ChatReply {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new ProviderError("protocol", provider, redact(`malformed non-streaming JSON body: ${truncateBytes(raw, 160)}`));
  }
  const choices = Array.isArray(obj.choices) ? (obj.choices as Record<string, unknown>[]) : [];
  const choice = choices.find((c) => c.index === 0) ?? choices[0];
  if (!choice) throw new ProviderError("protocol", provider, "Malformed response: no choices[] entry");
  const message = (choice.message ?? {}) as Record<string, unknown>;
  const content = typeof message.content === "string" ? message.content : "";
  const toolCalls = wireToolCalls(message.tool_calls, provider);
  const finish = typeof choice.finish_reason === "string" ? choice.finish_reason : undefined;
  const usage = mapUsage(obj.usage as Record<string, unknown> | undefined);
  if (!content && (!toolCalls || toolCalls.length === 0)) {
    throw new ProviderError("protocol", provider, "Malformed response: empty content and no tool calls");
  }
  return { content, toolCalls, finishReason: finish, usage };
}

function wireToolCalls(raw: unknown, provider: string): ChatToolCall[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ChatToolCall[] = [];
  for (const item of raw) {
    const t = item as Record<string, unknown>;
    const fn = (t.function ?? {}) as Record<string, unknown>;
    const args = typeof fn.arguments === "string" ? fn.arguments : (typeof fn.arguments === "object" && fn.arguments !== null ? JSON.stringify(fn.arguments) : "");
    if (args.length > TRANSPORT_CAPS.toolArgsBytes) throw new ProviderError("protocol", provider, "Malformed response: tool-call arguments exceed the cap");
    out.push({
      id: typeof t.id === "string" ? t.id : `call_${out.length}`,
      name: typeof fn.name === "string" ? fn.name : "",
      arguments: args,
    });
  }
  return out.length ? out : undefined;
}

async function parseSseBody(res: Response, provider: string, signal: AbortSignal): Promise<ChatReply> {
  if (!res.body) throw new ProviderError("protocol", provider, "Empty stream body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const aborted = (): ProviderError => new ProviderError("unavailable", provider, "stream aborted before completion (interrupt or deadline)");
  let buffer = "";
  let content = "";
  let finishReason: string | undefined;
  let usage: ChatUsage | undefined;
  let sawDone = false;
  const toolSlots: Record<number, { id: string; name: string; args: string }> = {};
  const toolOrder: number[] = [];

  try {
    /** One complete SSE line, terminated or the EOF-residual (audit F5). */
    const processLine = (line: string): void => {
      if (!line || line.startsWith(":")) return; // SSE comment / keepalive
      if (!line.startsWith("data:")) return;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") { sawDone = true; return; }
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        throw new ProviderError("protocol", provider, redact(`malformed SSE data line: ${truncateBytes(payload, 160)}`));
      }
      const choices = Array.isArray(obj.choices) ? (obj.choices as Record<string, unknown>[]) : [];
      const choice = choices.find((c) => c.index === 0) ?? choices[0];
      if (choice) {
        const delta = (choice.delta ?? {}) as Record<string, unknown>;
        if (typeof delta.content === "string" && delta.content) {
          content += delta.content;
          if (content.length > TRANSPORT_CAPS.roundContentBytes) {
            throw new ProviderError("protocol", provider, `stream content exceeded the ${TRANSPORT_CAPS.roundContentBytes} byte cap`);
          }
        }
        mergeToolCallDelta(delta.tool_calls, toolSlots, toolOrder, provider);
        if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
      }
      const u = mapUsage(obj.usage as Record<string, unknown> | undefined);
      if (u) usage = u;
    };
    const drainBuffer = (): void => {
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
        processLine(line);
        if (sawDone) return;
      }
    };
    for (;;) {
      const r = await readWithSignal(reader.read(), signal, () => aborted());
      if (r.done) break;
      buffer += decoder.decode(r.value, { stream: true });
      drainBuffer();
      if (sawDone) break;
    }
    // F5: a final SSE line without its "\n" terminator is REAL data — flush
    // the residual buffer at EOF so "[DONE]" (or the last delta) without a
    // trailing newline is honored instead of silently dropped
    if (!sawDone && buffer) processLine(buffer.replace(/\r$/, ""));
  } finally {
    reader.cancel().catch(() => undefined);
  }

  const toolCalls = toolOrder
    .map((i) => ({ slot: toolSlots[i]!, index: i }))
    .filter((t) => t.slot && (t.slot.name || t.slot.args))
    .map((t) => ({ id: t.slot.id || `call_${t.index}`, name: t.slot.name, arguments: t.slot.args }));
  if (!sawDone && !finishReason) {
    // truncated/cut stream: neither the [DONE] terminator nor a finish
    // reason arrived — never present partial content as a completed reply
    throw new ProviderError("protocol", provider, "stream ended prematurely (no [DONE] and no finish_reason)");
  }
  if (!content && toolCalls.length === 0) {
    // finished (with or without [DONE]) but truly empty — honest empty reply
    return { content: "", finishReason, usage };
  }
  for (const t of toolCalls) {
    if (t.arguments.length > TRANSPORT_CAPS.toolArgsBytes) {
      throw new ProviderError("protocol", provider, "Malformed response: tool-call arguments exceed the cap");
    }
  }
  return { content, toolCalls: toolCalls.length ? toolCalls : undefined, finishReason, usage };
}

function mergeToolCallDelta(
  raw: unknown,
  slots: Record<number, { id: string; name: string; args: string }>,
  order: number[],
  provider: string,
): boolean {
  if (!Array.isArray(raw)) return false;
  let touched = false;
  for (const item of raw) {
    const d = item as Record<string, unknown>;
    const idx = typeof d.index === "number" ? d.index : order.length;
    if (!slots[idx]) {
      // F3: controlled protocol error on index flood — memory cannot grow
      // unbounded no matter how the stream misbehaves
      if (order.length >= TRANSPORT_CAPS.toolSlotsMax) {
        throw new ProviderError("protocol", provider, `stream announced more than ${TRANSPORT_CAPS.toolSlotsMax} distinct tool-call indexes (likely malformed gateway response)`);
      }
      slots[idx] = { id: "", name: "", args: "" };
      order.push(idx);
    }
    const slot = slots[idx]!;
    if (typeof d.id === "string" && d.id) slot.id = d.id;
    const fn = (d.function ?? {}) as Record<string, unknown>;
    if (typeof fn.name === "string" && fn.name && !slot.name) slot.name = fn.name;
    if (typeof fn.arguments === "string" && fn.arguments) {
      slot.args += fn.arguments;
      if (slot.args.length > TRANSPORT_CAPS.toolArgsBytes) {
        throw new ProviderError("protocol", provider, "Malformed response: tool-call arguments exceed the cap");
      }
      touched = true;
    }
  }
  return touched;
}

/** Race a promise against abort; never leaves dangling abort listeners. */
function readWithSignal<T>(p: Promise<T>, signal: AbortSignal, onAbort: () => Error): Promise<T> {
  if (signal.aborted) return Promise.reject(onAbort());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const fireAbort = (): void => {
      if (settled) return;
      settled = true;
      reject(onAbort());
    };
    const cleanup = (): void => signal.removeEventListener("abort", fireAbort);
    signal.addEventListener("abort", fireAbort, { once: true });
    p.then(
      (v) => { if (!settled) { settled = true; cleanup(); resolve(v); } },
      (e) => { if (!settled) { settled = true; cleanup(); reject(e); } },
    );
  });
}
