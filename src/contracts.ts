/**
 * OAE Core internal contracts (runtime-neutral).
 *
 * These types are the stable boundary every provider adapter must honor:
 * session-level operations (AgentRunner), shared result/progress/usage shapes
 * and the structured model reference. NO SDK-specific type may leak through
 * this file — adapter payloads (e.g. the OpenCode service transcript) are
 * mapped into these neutral shapes by the adapter itself.
 *
 * Onda 1 scope: contracts + the OpenCode adapter behind them. A second
 * provider (direct API) lands in Onda 2 and must satisfy the same contract
 * tests; nothing in this file may mention a specific provider.
 */

/** Structured model reference — already implicit in OaeConfig; now a contract. */
export interface ProviderModelRef {
  providerID: string;
  id: string;
}

/** One verifiable liveness/progress observation from a session. */
export interface ProgressSignal {
  at: string;          // ISO timestamp of the newest verifiable signal
  kind: string;        // e.g. "message", "state", "tool"
  detail: string;
}

/** Token/cost usage of one session as reported by the provider runtime. */
export interface SessionUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  /** null when the provider does not report cost (unknown ≠ confirmed zero). */
  cost: number | null;
}

/** Final outcome of one supervised wait on a session. */
export interface AgentRunResult {
  outcome: "completed" | "interrupted" | "failed";
  output: string;      // final assistant text ("" is a real possibility: dispatch failure)
  signals: ProgressSignal[];
}

/**
 * One agent session, one task. The stable seam historically located in
 * src/opencode.ts (see git history): deterministic fake agents in tests and
 * future provider adapters (direct API in Onda 2) implement exactly this.
 */
export interface AgentRunner {
  /** Runtime adapter identifier (e.g. "opencode", "fake"); auditable in logs. */
  readonly runtime: string;
  readonly sessionId: string;
  /** Follow-up user text on an already-created session. */
  prompt(text: string): Promise<void>;
  /** Wait for completion/failure/interruption; never resolves "completed" lightly (see outcome docs). */
  awaitCompletion(timeoutMs: number, onProgress?: (s: ProgressSignal) => void): Promise<AgentRunResult>;
  /** Controlled stop of the underlying session (idempotent; best effort). */
  interrupt(): Promise<void>;
  /** Bounded recent transcript, human-readable. Never throws. */
  transcriptTail(maxMessages: number): Promise<string>;
  /** Token/cost usage as reported by the runtime; null when unavailable. */
  usage?(): Promise<SessionUsage | null>;
}

/** Explicit, categorized provider-side errors (auth/rate/unavailable/protocol/unknown). */
export type ProviderErrorKind = "auth" | "rateLimit" | "unavailable" | "protocol" | "unknown";

export class ProviderError extends Error {
  kind: ProviderErrorKind;
  provider: string;
  httpStatus?: number;

  constructor(kind: ProviderErrorKind, provider: string, message: string, httpStatus?: number) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.provider = provider;
    this.httpStatus = httpStatus;
  }
}

/**
 * Canonical HTTP status → ProviderErrorKind table. ONE table for every
 * provider transport (Onda 2 direct adapters consume exactly this); message
 * heuristics stay in classifyProviderError on top of it. 401/403 → auth,
 * 429 → rateLimit, 5xx → unavailable, 4xx → protocol.
 */
export function classifyHttpFailure(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rateLimit";
  if (status >= 500) return "unavailable";
  if (status >= 400) return "protocol";
  return "unknown";
}

/** Maps a thrown error (or raw message) into the categorized contract. */
export function classifyProviderError(err: unknown, provider: string): ProviderError {
  if (err instanceof ProviderError) return err;
  const message = String((err as Error)?.message ?? err ?? "unknown error");
  const m = message.match(/HTTP\s+(\d{3})/i);
  const status = m ? Number(m[1]) : undefined;
  let kind: ProviderErrorKind = "unknown";
  if (status === 401 || status === 403 || /unauthori[sz]ed|auth/i.test(message)) kind = "auth";
  else if (status === 429 || /rate limit/i.test(message)) kind = "rateLimit";
  else if (/unavailable|ENOTFOUND|ECONNREFUSED|ECONNRESET|timeout|no response/i.test(message)) kind = "unavailable";
  else if (status !== undefined) kind = classifyHttpFailure(status);
  return new ProviderError(kind, provider, message, status);
}
