/**
 * Provider contract: one object per agent engine/runtime ("opencode" today,
 * "direct-api" in Onda 2, adapters may follow). A Provider OWNS the connection
 * to its runtime and manufactures sessions that satisfy the AgentRunner
 * contract. Orchestrator/planner/index never import provider SDKs directly —
 * only this interface and runtime.ts (the factory).
 */
import type {
  AgentRunner,
  ProviderModelRef,
} from "../contracts.ts";

export type {
  AgentRunner,
  AgentRunResult,
  ProgressSignal,
  ProviderError,
  ProviderErrorKind,
  ProviderModelRef,
  SessionUsage,
} from "../contracts.ts";

/** Options for starting ONE agent session (planner/coder/reviewer roles). */
export interface SessionOptions {
  /** Directory the session operates on (the target project). */
  directory: string;
  /** Session title (visible in the runtime's own session list). */
  title: string;
  /** Agent/role name as understood by the runtime (e.g. "plan", "build"). */
  agent: string;
  /** Explicit model selection; null = runtime default. */
  model?: ProviderModelRef | null;
  /** First user text dispatched at creation (awaited; rejects surface immediately). */
  promptText: string;
}

/** One provider runtime. Implementations must be single-connection friendly. */
export interface Provider {
  /** Runtime adapter id ("opencode", ...). Used in logs and session records. */
  readonly id: string;
  /** Create ONE session and dispatch its first prompt. Awaited prompt: a
   * rejected prompt (auth/provider error) throws — never masked as success. */
  createSession(opts: SessionOptions): Promise<AgentRunner>;
  /** Cheap liveness probe against the runtime, when supported. */
  healthCheck?(): Promise<{ ok: boolean; detail?: string }>;
}
