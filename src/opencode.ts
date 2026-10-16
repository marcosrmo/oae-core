/**
 * OpenCode integration layer. Uses the official @opencode/client (version
 * pinned to the installed CLI v2.0.29). The `AgentRunner` interface is the seam
 * that allows deterministic fake agents in tests without touching OpenCode.
 *
 * Session lifecycle (completion/failure/progress/usage) is consumed
 * INCREMENTALLY from the service's event stream (`client.event.subscribe`,
 * SSE over GET /api/event) instead of full repeated context polls; the
 * polling loop remains only as the fallback (older SDKs without `event`,
 * unavailable subscription, or exhausted reconnects). Authoritative facts —
 * failure detail and final assistant output — are still read from the
 * session transcript exactly once, so the result semantics are identical
 * regardless of the mode used.
 *
 * Known limitations (documented, not invented around):
 *  - the event stream is live-only: an event missed while disconnected is
 *    not replayed; the ground-truth `session.active()` probe plus the
 *    transcript-based settle() recover it without duplicates;
 *  - service retries observed via events (`session.status {type:"retry"}`,
 *    `session.retry.scheduled`) are informational for observability; retry/attempt
 *    accounting authority stays in the orchestrator;
 *  - tool payloads are read defensively (loose shape) — unknown fields are
 *    not surfaced rather than guessed.
 */
import { OpenCode } from "@opencode/client";
import type { OpenCodeClient } from "@opencode/client";
import { Service } from "@opencode/client/service";
import type { Endpoint } from "@opencode/client/service";
import { nowISO, truncate } from "./util.ts";

export type Client = OpenCodeClient;

export async function connect(): Promise<{ client: Client; endpoint: Endpoint }> {
  const endpoint = await Service.ensure();
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
  return { client, endpoint };
}

export interface ProgressSignal {
  at: string;          // ISO timestamp of the newest verifiable signal
  kind: string;        // e.g. "message", "state"
  detail: string;
}

/** Token/cost usage of one session, as reported by the service (GET /api/session/{id}). */
export interface SessionUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number | null;
}

export interface AgentRunResult {
  outcome: "completed" | "interrupted" | "failed";
  output: string;      // final assistant text
  signals: ProgressSignal[];
}

/** Loose message shape from GET /api/session/{id}/context (verified live). */
interface CtxPart { type?: string; text?: string; name?: string }
interface CtxMessage {
  id?: string;
  type?: string;             // "user" | "assistant" | "system" | "idle"
  text?: string;             // user/system messages
  content?: CtxPart[];       // assistant messages: reasoning|tool|text parts
  error?: { message?: string } | null;
  finish?: string;
}

function msgList(raw: unknown): CtxMessage[] {
  return (Array.isArray(raw) ? raw : (raw as { data?: unknown[] }).data ?? []) as CtxMessage[];
}
function role(m: CtxMessage): string { return m.type ?? "?"; }
function text(m: CtxMessage): string {
  if (m.text) return m.text;
  return (m.content ?? []).filter((p) => p.type === "text" && p.text).map((p) => p.text!).join("\n");
}
function toolNames(m: CtxMessage): string {
  return (m.content ?? []).filter((p) => p.type === "tool").map((p) => p.name ?? "?").join(",");
}

/**
 * One agent session, one task. Completion = the session is no longer in
 * session.active() (the service's own notion of a busy session) after the
 * prompt was sent.
 */
export interface AgentRunner {
  readonly sessionId: string;
  prompt(text: string): Promise<void>;
  awaitCompletion(timeoutMs: number, onProgress?: (s: ProgressSignal) => void): Promise<AgentRunResult>;
  interrupt(): Promise<void>;
  transcriptTail(maxMessages: number): Promise<string>;
  /** Token/cost usage as reported by the service; null when unavailable. */
  usage?(): Promise<SessionUsage | null>;
}

export class OpenCodeRunner implements AgentRunner {
  readonly sessionId: string;
  private client: Client;
  private signals: ProgressSignal[] = [];
  private interrupted = false;
  private lastCtxKey = "";
  /** Last observed message list — reused at completion so the final context is fetched once. */
  private lastCtx: CtxMessage[] | null = null;
  /** Token usage captured from `session.usage.updated` events (SSE mode). */
  private usageFromEvent: SessionUsage | null = null;
  /** Last service-retry signature, so status/retry-scheduled pairs dedupe. */
  private lastRetryKey = "";

  private constructor(sessionId: string, client: Client) {
    this.sessionId = sessionId;
    this.client = client;
  }

  static async start(
    client: Client,
    opts: {
      directory: string;
      title: string;
      agent: string;
      model?: { providerID: string; id: string } | null;
      promptText: string;
    },
  ): Promise<OpenCodeRunner> {
    const session = await client.session.create({
      title: opts.title,
      agent: opts.agent,
      model: opts.model ?? undefined,
      location: { directory: opts.directory },
    });
    const runner = new OpenCodeRunner(session.id, client);
    // awaited: a rejected prompt (provider/auth error) surfaces immediately
    // instead of surfacing later as an empty "completed" attempt
    await client.session.prompt({ sessionID: session.id, text: opts.promptText });
    return runner;
  }

  async prompt(text: string): Promise<void> {
    await this.client.session.prompt({ sessionID: this.sessionId, text });
  }

  async awaitCompletion(
    timeoutMs: number,
    onProgress?: (s: ProgressSignal) => void,
  ): Promise<AgentRunResult> {
    const deadline = Date.now() + timeoutMs;
    try {
      // already at/beyond the deadline: the audit behavior (interrupt instead
      // of orphan token burn) takes precedence over subscribing
      if (Date.now() >= deadline) {
        await this.interrupt();
        return { outcome: "interrupted", output: await this.finalOutput(), signals: this.signals };
      }
      const sink = (this.client as unknown as { event?: { subscribe?: (o?: unknown) => AsyncIterable<unknown> } }).event;
      if (sink && typeof sink.subscribe === "function") {
        const viaSse = await this.sseAwaitCompletion(deadline, onProgress);
        if (viaSse) return viaSse;
        // SSE lost beyond the reconnect budget (or unsupported stream) —
        // fall back to the proven polling loop with the REMAINING budget
      }
      return await this.pollAwaitCompletion(deadline, onProgress);
    } catch (e) {
      return { outcome: "failed", output: `runner error: ${(e as Error).message}`, signals: this.signals };
    }
  }

  /**
   * SSE mode. Consume the service event stream incrementally for THIS
   * session only; map lifecycle events to completion/failure/progress.
   * The result is built exactly once (settle) — no event, reconnect or
   * watchdog can duplicate it. Returns null when the fallback should run.
   */
  private async sseAwaitCompletion(
    deadline: number,
    onProgress?: (s: ProgressSignal) => void,
  ): Promise<AgentRunResult | null> {
    const reconnectPauseMs = 100;
    let reconnects = 0;
    for (;;) {
      let sink: AsyncIterable<unknown>;
      try {
        // subscription unavailable (older SDK/broken endpoint) → the polling
        // fallback is the contract; this is not a mid-stream transport error
        sink = (this.client as unknown as { event?: { subscribe: (o?: unknown) => AsyncIterable<unknown> } }).event!.subscribe();
      } catch {
        return null;
      }
      let it: AsyncIterator<unknown> | undefined;
      try {
        it = sink[Symbol.asyncIterator]();
        // ground truth at (re)connect time: an already-idle session never
        // replays its past idle event — settle immediately instead of
        // waiting for the watchdog
        if (await this.probeInactive()) return await this.settle();
        let pending: Promise<{ value?: unknown; done?: boolean } | undefined> | null = null;
        for (;;) {
          if (this.interrupted) {
            return { outcome: "interrupted", output: await this.finalOutput(), signals: this.signals };
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            await this.interrupt();
            return { outcome: "interrupted", output: await this.finalOutput(), signals: this.signals };
          }
          if (!pending) pending = it.next() as Promise<{ value?: unknown; done?: boolean } | undefined>;
          const tick = watchdogTick(Math.min(remaining, 30_000));
          const raced = await Promise.race([pending, tick.promise]);
          tick.clear();
          if (this.interrupted) {
            return { outcome: "interrupted", output: await this.finalOutput(), signals: this.signals };
          }
          if (!raced) continue; // watchdog tick: re-checks happen next iteration
          pending = null;
          const r = raced as { value?: unknown; done?: boolean };
          if (r.done) break; // stream ended cleanly → reconnect below
          const mapped = await this.mapEvent(r.value, onProgress);
          if (mapped) return mapped; // result built exactly once
        }
      } catch {
        // transport error mid-stream → reconnect below
      }
      void it;
      reconnects++;
      if (reconnects > 5) return null; // reconnect budget exhausted → fallback
      await pause(reconnectPauseMs);
    }
  }

  /** Cheap ground truth: IS the session absent from the service's busy set? */
  private async probeInactive(): Promise<boolean> {
    try {
      const active = (await this.client.session.active()) as unknown as Record<string, unknown>;
      return !Object.prototype.hasOwnProperty.call(active, this.sessionId);
    } catch {
      return false; // transient: treat as active, the loop keeps watching
    }
  }

  /** Apply one stream event; returns a final result (once) or null to keep watching. */
  private async mapEvent(
    ev: unknown,
    onProgress?: (s: ProgressSignal) => void,
  ): Promise<AgentRunResult | null | undefined> {
    const e = ev as { type?: string; data?: Record<string, unknown> } | undefined;
    if (!e || typeof e.type !== "string") return undefined;
    const data = e.data ?? {};
    // strict per-session filter: the stream also carries unrelated sessions
    // (e.g. the human's own OpenCode sessions) — never react to those
    if (data.sessionID !== this.sessionId) return undefined;
    const note = (kind: string, detail: string): void => {
      const sig: ProgressSignal = { at: nowISO(), kind, detail };
      this.signals.push(sig);
      onProgress?.(sig);
    };
    switch (e.type) {
      case "session.idle":
      case "session.execution.succeeded":
        return await this.settle();
      case "session.status": {
        const st = data.status as { type?: string; attempt?: number; message?: string } | undefined;
        if (st?.type === "idle") return await this.settle();
        if (st?.type === "retry") {
          this.noteServiceRetry(st, note);
          return undefined;
        }
        note("session", `${st?.type ?? "status changed"}`);
        return undefined;
      }
      case "session.execution.failed": {
        // richer failure detail than the transcript-based settle: surface it
        // directly, keeping the same result shape as the fallback path
        const err = (data.error ?? {}) as { message?: string; status?: number };
        const msg = err.message ?? "unknown failure";
        return { outcome: "failed", output: `provider/run error: ${msg}`, signals: this.signals };
      }
      case "session.retry.scheduled": {
        const err = (data.error ?? {}) as { message?: string; status?: number };
        this.noteServiceRetry({ attempt: typeof data.attempt === "number" ? data.attempt : undefined, message: err.message ?? undefined }, note);
        return undefined;
      }
      case "session.step.started":
        note("step", `step started`);
        return undefined;
      case "session.step.ended": {
        const finish = typeof data.finish === "string" ? data.finish : "?";
        note("step", `step ended (finish=${finish})`);
        return undefined;
      }
      case "session.tool.success":
      case "session.tool.failed": {
        const content = data.content as Array<{ name?: string }> | undefined;
        const tool = content?.[0]?.name;
        note("tool", `${e.type === "session.tool.success" ? "tool succeeded" : "tool failed"}${tool ? `: ${tool}` : ""}`);
        return undefined;
      }
      case "session.usage.updated": {
        const t = (data.tokens ?? {}) as { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
        this.usageFromEvent = {
          input: t.input ?? 0,
          output: t.output ?? 0,
          reasoning: t.reasoning ?? 0,
          cacheRead: t.cache?.read ?? 0,
          cacheWrite: t.cache?.write ?? 0,
          cost: typeof data.cost === "number" ? data.cost : null,
        };
        return undefined;
      }
      default:
        // uninteresting for completion (text deltas, permission pings, …):
        // consuming them per-delta would be an event storm — documented
        return undefined;
    }
  }

  /** One service retry → one observability note (status+retry.scheduled dedupe by attempt+message). */
  private noteServiceRetry(
    st: { attempt?: number; message?: string },
    note: (kind: string, detail: string) => void,
  ): void {
    const key = `${st.attempt ?? "?"}:${st.message ?? ""}`;
    if (key === this.lastRetryKey) return;
    this.lastRetryKey = key;
    note("retry", `service retry attempt ${st.attempt ?? "?"}${st.message ? ` — ${st.message}` : ""}`);
  }

  /** Authoritative settle: the transcript decides failure vs completion, exactly like the fallback. */
  private async settle(): Promise<AgentRunResult> {
    const idleFailed = await this.idleOutcomeFailed();
    if (idleFailed && !this.interrupted) {
      return { outcome: "failed", output: `provider/run error: ${idleFailed}`, signals: this.signals };
    }
    return { outcome: this.interrupted ? "interrupted" : "completed", output: await this.finalOutput(), signals: this.signals };
  }

  /** Legacy polling loop, verbatim behavior. Uses the REMAINING deadline. */
  private async pollAwaitCompletion(deadline: number, onProgress?: (s: ProgressSignal) => void): Promise<AgentRunResult> {
    try {
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5_000));
        await this.observe(onProgress);
        if (this.interrupted) break;
        const active = (await this.client.session.active()) as unknown as Record<string, unknown>;
        if (!Object.prototype.hasOwnProperty.call(active, this.sessionId)) {
          return await this.settleForPoll();
        }
      }
      // deadline expired: stop the session too — otherwise it keeps running
      // (and consuming tokens) as an orphan nobody reads (audit 2026-10-16:
      // a planner session ran 9 extra minutes after being abandoned)
      await this.interrupt();
      return { outcome: "interrupted", output: await this.finalOutput(), signals: this.signals };
    } catch (e) {
      return { outcome: "failed", output: `runner error: ${(e as Error).message}`, signals: this.signals };
    }
  }

  /** Poll-path completion: keeps the original failure precedence. */
  private async settleForPoll(): Promise<AgentRunResult> {
    const idleFailed = await this.idleOutcomeFailed();
    if (idleFailed && !this.interrupted) {
      return { outcome: "failed", output: `provider/run error: ${idleFailed}`, signals: this.signals };
    }
    return { outcome: this.interrupted ? "interrupted" : "completed", output: await this.finalOutput(), signals: this.signals };
  }

  /** Records verifiable progress: message list evolution (count + newest id/role). */
  private async observe(onProgress?: (s: ProgressSignal) => void): Promise<void> {
    try {
      const raw = await this.client.session.context({ sessionID: this.sessionId }) as unknown;
      const msgs = msgList(raw);
      this.lastCtx = msgs;
      const last = msgs[msgs.length - 1];
      const tools = toolNames(last ?? {});
      const key = `${msgs.length}:${last?.id ?? ""}`;
      if (key !== this.lastCtxKey) {
        this.lastCtxKey = key;
        const sig: ProgressSignal = {
          at: nowISO(),
          kind: tools ? "tool" : "message",
          detail: `messages=${msgs.length} lastType=${role(last ?? {})}${tools ? ` tools=${tools}` : ""}`,
        };
        this.signals.push(sig);
        onProgress?.(sig);
      }
    } catch { /* transient transport errors: the next poll re-checks */ }
  }

  /** Latest known message list (cached from observe; fetched once if never observed). */
  private async messages(): Promise<CtxMessage[]> {
    if (this.lastCtx) return this.lastCtx;
    try {
      const raw = await this.client.session.context({ sessionID: this.sessionId }) as unknown;
      this.lastCtx = msgList(raw);
      return this.lastCtx;
    } catch {
      return [];
    }
  }

  /** The service appends an "idle" message whose outcome may be "failed". */
  private async idleOutcomeFailed(): Promise<string | null> {
    try {
      const msgs = await this.messages();
      const idle = msgs.filter((m) => role(m) === "idle").at(-1);
      if (idle && (idle as { outcome?: string }).outcome === "failed") {
        return idle.error?.message ?? "unknown failure";
      }
      return null;
    } catch {
      return null;
    }
  }

  private async finalOutput(): Promise<string> {
    try {
      const msgs = await this.messages();
      const assistants = msgs.filter((m) => role(m) === "assistant" && text(m));
      // generous bound: a valid model plan JSON measured 4014 chars and was
      // being destroyed by a 4000-char truncation (audit 2026-10-16);
      // attempt summaries are truncated separately by the orchestrator
      return truncate(text(assistants[assistants.length - 1] ?? {}), 20_000);
    } catch {
      return "";
    }
  }

  /** Token/cost usage of this session as reported by the service (per-attempt telemetry). */
  async usage(): Promise<SessionUsage | null> {
    // live capture from session.usage.updated is the same service truth,
    // obtained without a redundant session.get round-trip
    if (this.usageFromEvent) return this.usageFromEvent;
    try {
      const info = await this.client.session.get({ sessionID: this.sessionId }) as unknown as {
        tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
        cost?: number;
      };
      return {
        input: info.tokens?.input ?? 0,
        output: info.tokens?.output ?? 0,
        reasoning: info.tokens?.reasoning ?? 0,
        cacheRead: info.tokens?.cache?.read ?? 0,
        cacheWrite: info.tokens?.cache?.write ?? 0,
        cost: typeof info.cost === "number" ? info.cost : null,
      };
    } catch {
      return null;
    }
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    // the session just changed state (stopped/finishing) — the cached
    // transcript is stale; force one fresh fetch for final output/diagnosis
    // (audit 2026-10-16: a planner finished 590ms before the deadline and its
    // plan was lost to a 5s-stale cache)
    this.lastCtx = null;
    try { await this.client.session.interrupt({ sessionID: this.sessionId }); } catch { /* already idle */ }
  }

  async transcriptTail(maxMessages: number): Promise<string> {
    try {
      const msgs = await this.messages();
      return msgs
        .filter((m) => text(m))
        .slice(-maxMessages)
        .map((m) => `[${role(m)}] ${truncate(text(m), 500)}`)
        .join("\n");
    } catch {
      return "(transcript unavailable)";
    }
  }
}

/**
 * Watchdog tick for the SSE loop: resolves true after ms (or the early
 * clear() flag), detached (unref'd) so it never holds the process open.
 * The tick does NOT consume pending stream events — the same event beat is
 * resumed after the tick, so no event is dropped or processed twice.
 */
function watchdogTick(ms: number): { promise: Promise<{} | null>; clear: () => void } {
  let t: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<{} | null>((res) => {
    t = setTimeout(() => res({}), ms);
    if (t && typeof t.unref === "function") t.unref();
  });
  return { promise, clear: () => { if (t) clearTimeout(t); } };
}

/** Reconnect pause, detached the same way. */
function pause(ms: number): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(() => res(), ms);
    if (typeof t.unref === "function") t.unref();
  });
}
