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
import { redact, redactTruncatedTail } from "../../progress.ts";

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
  /** Send `stream_options.include_usage` (OpenAI spec). OpenRouter ignores
   * this legacy field (usage arrives automatically in the final chunk), so
   * its adapter sets false to keep the wire as clean as its docs demand. */
  includeUsage?: boolean;
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
  /** R1: one raw SSE line (UNTERMINATED or already terminated in the same
   * chunk) ≤ 128 KiB, enforced in two places: the residual waiting for a
   * newline cannot exceed the cap while accumulating (memory bounded by cap
   * + one incoming chunk), and drainBuffer/EOF-flush re-check each complete
   * line BEFORE processLine/JSON.parse — so a hostile single-chunk giant
   * line cannot even be parsed. Legit `data:` lines are a few KiB at most
   * (SSE requires delimiters per event). Line cap ≐ NOT event cap: an event
   * with several lines each under the cap still parses. */
  sseLineBytes: 131_072,
  /** Non-streaming SUCCESS body cap ≤ 4 MiB (A1): read incrementally and
   * rejected as a controlled protocol error when exceeded — the raw body is
   * never materialized past the cap. Generous ceiling: a legit reply with
   * several tool calls stays far below (stream roundContentBytes is 1 MiB). */
  successBodyBytes: 4_000_000,
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
  private includeUsage: boolean;

  constructor(cfg: TransportConfig) {
    this.provider = cfg.provider;
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.apiKey = cfg.apiKey;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.includeUsage = cfg.includeUsage ?? true;
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
    if (stream && this.includeUsage) bodyObj.stream_options = { include_usage: true };
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
        // carries the real gateway diagnostic (A1: bounded read, cap enforced)
        const probe = await readBounded(res, 300, opts.signal, true);
        if (probe.text.toLowerCase().includes("stream")) {
          this.streamingDisabled = true;
          bodyObj.stream = false;
          delete bodyObj.stream_options;
          const res2 = await this.doFetch(opts.model, bodyObj, opts.signal);
          if (res2.ok) return res2;
          throw await this.errorFrom(res2, opts.signal);
        }
        // R2: the probe text may be cutting at its own 300-byte cap —
        // redactTruncatedTail masks a stem fragment straddling that boundary
        throw new ProviderError(classifyHttpFailure(res.status), this.provider, redactTruncatedTail(`HTTP ${res.status}: ${probe.text}`), res.status);
      }
      throw await this.errorFrom(res, opts.signal);
    })();

    return {
      dispatched: (async () => {
        await resPromise;
      })(),
      consume: async () => {
        if (consumedStarted) throw new Error("transport round already consumed");
        consumedStarted = true;
        const res = await resPromise;
        if (res.status >= 400) throw await this.errorFrom(res, opts.signal); // retry path race
        try {
          const ct = res.headers.get("content-type") ?? "";
          const looksSse = ct.includes("text/event-stream");
          const looksJson = ct.includes("application/json");
          const useSse = looksSse || (!looksJson && typeof bodyObj.stream === "boolean" && bodyObj.stream);
          if (useSse) return await parseSseBody(res, this.provider, opts.signal);
          // A1: the success body is read incrementally with a hard cap — a
          // hostile/oversized body CANNOT be materialized in full; reading
          // stops at the cap and the round fails as a controlled error
          const raw = await readBounded(res, TRANSPORT_CAPS.successBodyBytes, opts.signal);
          if (raw.truncated) {
            throw new ProviderError("protocol", this.provider, `non-streaming response exceeded the ${TRANSPORT_CAPS.successBodyBytes} byte cap (consumed ${raw.bytesRead} bytes; body not fully read)`);
          }
          return parseNonStreamReply(raw.text, this.provider);
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

  private async errorFrom(res: Response, signal?: AbortSignal): Promise<ProviderError> {
    // Etapa 3: the body is finished with after the excerpt — cancelWhenDone
    // releases the connection; excerpt text and classification are built
    // exactly as before
    const excerpt = await readBounded(res, TRANSPORT_CAPS.errorExcerptBytes, signal, true);
    // R2: excerpt.text is CUT at the 2 KB cap, so a secret straddling the
    // boundary escapes plain redact() (needs ≥8 chars after its stem) —
    // redactTruncatedTail masks the trailing stem fragment first; the static
    // truncation note is appended only afterward
    const message = `${redactTruncatedTail(`HTTP ${res.status}: ${excerpt.text}`)}${excerpt.truncated ? ` …(body truncated, >${TRANSPORT_CAPS.errorExcerptBytes} bytes — further data not read)` : ""}`;
    return new ProviderError(classifyHttpFailure(res.status), this.provider, message, res.status);
  }
}

/** A1: incrementally reads AT MOST cap bytes of a body into memory and stops
 * at the cap (memory bounded by cap + one chunk; a chunk is decoded BEFORE
 * the cap check, so a single oversized wire chunk is materialized whole —
 * real HTTP chunks are small). Truncation is detected from `consumed > cap`.
 *
 * CANCELLATION: rounds consumed via open().consume() cancel the reader in
 * their finally. Error-body and 400-probe callers OWN their cleanup: pass
 * `cancelWhenDone` to have this function release the body connection as
 * soon as it stops reading (Etapa 3 / hygiene): cancel failures are
 * swallowed and can never mask the caller's original error/success result.
 * The success round path deliberately does NOT cancel here (consume's
 * finally owns the reader lifecycle there).
 *
 * read errors, aborted/interrupted streams and, when a signal is given, an
 * interrupt during the read all degrade into honest fallback text — never an
 * unbounded host-controlled buffer. With real fetch the request signal aborts
 * the body stream itself, so this guard mainly closes the mock-vs-real gap.
 * Etapa 3 (C2): also reused by the OpenCode adapter's raw-fetch error shim
 * (same bounded read semantics, exported for `src/opencode.ts`). */
export async function readBounded(
  res: Response,
  cap: number,
  signal?: AbortSignal,
  cancelWhenDone = false,
): Promise<{ text: string; bytesRead: number; truncated: boolean }> {
  const body = res.body;
  if (!body) return { text: "(empty body)", bytesRead: 0, truncated: false };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let consumed = 0;
  let truncated = false;
  let result: { text: string; bytesRead: number; truncated: boolean };
  try {
    for (;;) {
      // R4: with a signal, an interrupt during the read no longer hangs on a
      // mock that never resolves (real fetch aborts the body stream itself)
      const r = await (signal
        ? readWithSignal(reader.read(), signal, () => new Error("read aborted (session interrupted)"))
        : reader.read());
      const { done, value } = r;
      if (done) break;
      consumed += value.byteLength;
      if (text.length < cap) {
        text += decoder.decode(value, { stream: true });
        if (text.length > cap) text = text.slice(0, cap); // byte-boundary overshoot
      }
      if (consumed > cap) { truncated = true; break; } // cap reached: stop reading
    }
    result = { text, bytesRead: consumed, truncated };
  } catch {
    // read error / interrupted stream: partial text is still useful context
    if (!text) text = signal?.aborted ? "(read aborted by interrupt)" : "(unreadable body)";
    const note = text.startsWith("(") ? "" : `…(read interrupted after ${consumed} bytes)`;
    result = { text: text + note, bytesRead: consumed, truncated: true };
  } finally {
    // Etapa 3: error/probe callers release the connection here (cap already
    // reached or stream finished) — AFTER the excerpt was collected, BEFORE
    // returning to the caller; cancel failures are swallowed so they never
    // mask the excerpt or the error being built from it
    if (cancelWhenDone) await reader.cancel().catch(() => undefined);
  }
  return result;
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
    // R2: scrub + FULL redact FIRST, then cut — redaction before truncation
    // can never CREATE a token fragment at the cut; a full token already got
    // [redacted] before the 160-char message cap ever sees it
    throw new ProviderError("protocol", provider, redact(`malformed non-streaming JSON body: ${truncateBytes(redactTruncatedTail(raw), 160)}`));
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
  // A4: same flood protection as the SSE path — a non-streaming body with
  // more than the slot cap fails as a controlled protocol error; memory
  // cannot grow with an arbitrarily long tool_calls array
  if (raw.length > TRANSPORT_CAPS.toolSlotsMax) {
    throw new ProviderError("protocol", provider, `response announced more than ${TRANSPORT_CAPS.toolSlotsMax} tool calls (non-streaming; likely malformed gateway response)`);
  }
  const out: ChatToolCall[] = [];
  for (const item of raw) {
    const t = item as Record<string, unknown>;
    const fn = (t.function ?? {}) as Record<string, unknown>;
    const args = typeof fn.arguments === "string" ? fn.arguments : (typeof fn.arguments === "object" && fn.arguments !== null ? JSON.stringify(fn.arguments) : "");
    const name = typeof fn.name === "string" ? fn.name : "";
    // R3: parity with the SSE path — a structurally empty item (no function
    // name AND no arguments, e.g. a gateway that ships a bare placeholder)
    // is dropped instead of being delivered as `name:""` (which the SSE path
    // already filters). Valid calls inside the cap are untouched.
    if (!name && !args) continue;
    if (args.length > TRANSPORT_CAPS.toolArgsBytes) throw new ProviderError("protocol", provider, "Malformed response: tool-call arguments exceed the cap");
    out.push({
      id: typeof t.id === "string" ? t.id : `call_${out.length}`,
      name,
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
    /** One complete SSE line, terminated or the EOF-residual (audit F5).
     * R1 (FIXED): every raw line AND the unterminated residual are capped
     * per sseLineBytes (checks in drainBuffer, the read loop and the EOF
     * flush); roundContentBytes still bounds only delta.content. */
    const processLine = (line: string): void => {
      if (!line || line.startsWith(":")) return; // SSE comment / keepalive
      if (!line.startsWith("data:")) return;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") { sawDone = true; return; }
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        // R2: redact + tail-scrub BEFORE the 160-char cut (same ordering
        // rationale as parseNonStreamReply)
        throw new ProviderError("protocol", provider, redact(`malformed SSE data line: ${truncateBytes(redactTruncatedTail(payload), 160)}`));
      }
      // OpenRouter mid-stream failure: after the 200 commit the error arrives
      // as an SSE event with a TOP-LEVEL error field and finish_reason
      // "error" — failing to catch this would present a failed round as
      // "completed with empty content". Classified by the central engine.
      if (obj.error !== undefined && obj.error !== null) {
        const err = obj.error as Record<string, unknown>;
        const detail = typeof err === "string" ? err : typeof err.message === "string" ? err.message : JSON.stringify(err);
        const code = typeof err.code === "number" ? err.code : undefined;
        throw new ProviderError(
          code !== undefined ? classifyHttpFailure(code) : "unavailable",
          provider,
          redact(`mid-stream provider error${code !== undefined ? ` (code ${code})` : ""}: ${detail}`),
          code,
        );
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
    // R1: per-LINE framing cap (terminated or not), checked BEFORE
    // processLine so a hostile single-chunk giant line is never even parsed;
    // the loop ALSO checks the UNTERMINATED residual to bound accumulation
    // (cap + one incoming chunk, same accounting as readBounded)
    const lineCapExceeded = (): ProviderError =>
      new ProviderError("protocol", provider, `SSE framing: a raw line exceeded the ${TRANSPORT_CAPS.sseLineBytes} byte cap (terminated or not; likely malformed or hostile stream)`);
    const drainBuffer = (): void => {
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
        if (line.length > TRANSPORT_CAPS.sseLineBytes) throw lineCapExceeded();
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
      if (buffer.length > TRANSPORT_CAPS.sseLineBytes) throw lineCapExceeded();
    }
    // F5: a final SSE line without its "\n" terminator is REAL data — flush
    // the residual buffer at EOF so "[DONE]" (or the last delta) without a
    // trailing newline is honored instead of silently dropped
    if (!sawDone && buffer) {
      if (buffer.length > TRANSPORT_CAPS.sseLineBytes) throw lineCapExceeded();
      processLine(buffer.replace(/\r$/, ""));
    }
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
