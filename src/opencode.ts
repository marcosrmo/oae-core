/**
 * OpenCode integration layer. Uses the official @opencode/client (version
 * pinned to the installed CLI v2.0.29). The `AgentRunner` interface is the seam
 * that allows deterministic fake agents in tests without touching OpenCode.
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
}

export class OpenCodeRunner implements AgentRunner {
  readonly sessionId: string;
  private client: Client;
  private signals: ProgressSignal[] = [];
  private interrupted = false;
  private lastCtxKey = "";

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
    // prompt triggers the agent run; failure surfaces on the poll loop
    void client.session.prompt({ sessionID: session.id, text: opts.promptText }).catch(() => undefined);
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
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2_500));
        await this.observe(onProgress);
        if (this.interrupted) break;
        const active = (await this.client.session.active()) as unknown as Record<string, unknown>;
        if (!Object.prototype.hasOwnProperty.call(active, this.sessionId)) {
          const idleFailed = await this.idleOutcomeFailed();
          if (idleFailed && !this.interrupted) {
            return {
              outcome: "failed",
              output: `provider/run error: ${idleFailed}`,
              signals: this.signals,
            };
          }
          return {
            outcome: this.interrupted ? "interrupted" : "completed",
            output: await this.finalOutput(),
            signals: this.signals,
          };
        }
      }
      return { outcome: "interrupted", output: await this.finalOutput(), signals: this.signals };
    } catch (e) {
      return { outcome: "failed", output: `runner error: ${(e as Error).message}`, signals: this.signals };
    }
  }

  /** Records verifiable progress: message list evolution (count + newest id/role). */
  private async observe(onProgress?: (s: ProgressSignal) => void): Promise<void> {
    try {
      const raw = await this.client.session.context({ sessionID: this.sessionId }) as unknown;
      const msgs = msgList(raw);
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

  /** The service appends an "idle" message whose outcome may be "failed". */
  private async idleOutcomeFailed(): Promise<string | null> {
    try {
      const msgs = msgList(await this.client.session.context({ sessionID: this.sessionId }) as unknown);
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
      const msgs = msgList(await this.client.session.context({ sessionID: this.sessionId }) as unknown);
      const assistants = msgs.filter((m) => role(m) === "assistant" && text(m));
      return truncate(text(assistants[assistants.length - 1] ?? {}), 4000);
    } catch {
      return "";
    }
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    try { await this.client.session.interrupt({ sessionID: this.sessionId }); } catch { /* already idle */ }
  }

  async transcriptTail(maxMessages: number): Promise<string> {
    try {
      const msgs = msgList(await this.client.session.context({ sessionID: this.sessionId }) as unknown);
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
