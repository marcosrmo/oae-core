/**
 * Deterministic fake agents for unit tests. Same AgentRunner contract as
 * OpenCodeRunner; no provider calls, fully reproducible. Deliberately
 * implements the CONTRACT (src/contracts.ts), proving the seam is
 * adapter-independent.
 */
import type { AgentRunner, AgentRunResult, ProgressSignal } from "../src/contracts.ts";
import { nowISO } from "../src/util.ts";

export type FakeBehavior =
  | { type: "complete"; output: string; workMs?: number }
  | { type: "hang" }                    // never completes on its own; ends when interrupted
  | { type: "error"; output?: string }  // runner failure
  ;

export class FakeRunner implements AgentRunner {
  readonly runtime = "fake";
  readonly sessionId: string;
  behavior: FakeBehavior;
  prompts: string[] = [];
  signals: ProgressSignal[] = [];
  interrupted = false;
  private waiters: ((r: AgentRunResult) => void)[] = [];

  constructor(sessionId: string, behavior: FakeBehavior) {
    this.sessionId = sessionId;
    this.behavior = behavior;
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    if (this.behavior.type === "complete") {
      const out = this.behavior.output;
      const workMs = this.behavior.workMs ?? 30;
      setTimeout(() => this.settle({ outcome: "completed", output: out, signals: this.signals }), workMs);
      this.signals.push({ at: nowISO(), kind: "message", detail: "prompt sent" });
    } else if (this.behavior.type === "error") {
      const out = this.behavior.output ?? "runner error: simulated";
      setTimeout(() => this.settle({ outcome: "failed", output: out, signals: this.signals }), 20);
    }
    // type "hang": nothing is scheduled; only interrupt() settles it
  }

  async awaitCompletion(timeoutMs: number, _onProgress?: (s: ProgressSignal) => void): Promise<AgentRunResult> {
    if (this.interrupted) return { outcome: "interrupted", output: "", signals: this.signals };
    if (this.behavior.type === "hang") {
      // never settles on its own; honors the timeout like the real runner does
      return new Promise<AgentRunResult>((res) => {
        this.waiters.push(res);
        setTimeout(() => {
          const i = this.waiters.indexOf(res);
          if (i >= 0) { this.waiters.splice(i, 1); res({ outcome: "interrupted", output: "", signals: this.signals }); }
        }, timeoutMs);
      });
    }
    return new Promise<AgentRunResult>((res) => this.waiters.push(res));
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    this.settle({ outcome: "interrupted", output: "", signals: this.signals });
  }

  private settle(r: AgentRunResult): void {
    const ws = this.waiters; this.waiters = [];
    for (const w of ws) w(r);
  }

  async transcriptTail(_max: number): Promise<string> {
    return this.prompts.map((p) => `[user] ${p.slice(0, 200)}`).join("\n") || "(empty)";
  }
}

export const REVIEWER_OK = '{"verdict":"approve","findings":[],"summary":"ok"}';
export const REVIEWER_REJECT = (text: string) =>
  JSON.stringify({ verdict: "reject", findings: [{ severity: "major", text }], summary: "rejected" });
