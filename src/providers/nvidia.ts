/**
 * NVIDIA direct provider (Onda 2, stage 1): OpenAI-compatible chat
 * completions against the NVIDIA integrate API. Governed exclusively by the
 * Provider contract — NO @opencode/client import anywhere in this module's
 * graph, no opencode process, no session server.
 *
 * Auth: `OAE_NVIDIA_API_KEY` from the environment, read at provider start.
 * The key travels only in the transport's Authorization header; it is never
 * logged, echoed into errors, or persisted into state.json / JSONL rollouts
 * (see transport redaction + redact() defense-in-depth).
 *
 * Selection is explicit (OAE_PROVIDER / --provider nvidia-direct in
 * runtime.ts) — the default provider stays the OpenCode adapter.
 */
import type { Provider, SessionOptions } from "./contract.ts";
import { HttpAgentRunner } from "./http/runner.ts";

export const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
/** Validated model of this stage (docs/onda2-plan.md §5): mission-verified. */
export const NVIDIA_DEFAULT_MODEL = "z-ai/glm-5.3-flash";

export interface NVIDIAOptions {
  /** Explicit key (tests); otherwise OAE_NVIDIA_API_KEY from the env. */
  apiKey?: string;
  /** Injectable fetch for offline tests. */
  fetchImpl?: typeof fetch;
  /** Base URL override (tests/gateways). */
  baseUrl?: string;
}

export class NVIDIAProvider implements Provider {
  readonly id = "nvidia-direct";
  private apiKey: string;
  private fetchImpl: typeof fetch | undefined;
  private baseUrl: string;

  private constructor(apiKey: string, fetchImpl?: typeof fetch, baseUrl?: string) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl ?? NVIDIA_BASE_URL;
  }

  /** Fails fast with a clear, secret-free configuration error when the key
   * is absent — a run configured for nvidia-direct forfeits early and
   * truthfully instead of burning attempts against a dead endpoint. */
  static start(opts?: NVIDIAOptions): NVIDIAProvider {
    const apiKey = opts?.apiKey ?? process.env.OAE_NVIDIA_API_KEY;
    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error(
        "nvidia-direct: configuration error — OAE_NVIDIA_API_KEY is not set. " +
        "Export it in the environment (e.g. `export OAE_NVIDIA_API_KEY=...`); " +
        "never paste the key into prompts, .oae/config.json, or CLI arguments. " +
        "The OpenCode adapter remains available: --provider opencode (default).",
      );
    }
    return new NVIDIAProvider(apiKey, opts?.fetchImpl, opts?.baseUrl);
  }

  async createSession(opts: SessionOptions): Promise<HttpAgentRunner> {
    const model = opts.model?.id ?? NVIDIA_DEFAULT_MODEL;
    const runner = new HttpAgentRunner({
      provider: this.id,
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      model,
      agent: opts.agent,
      // tools exist only when the orchestrator asks for the coder role;
      // planner and reviewer stay purely textual (docs/onda2-plan.md §4)
      toolsEnabled: opts.tools === true,
      root: opts.directory,
      promptText: opts.promptText,
      toolExecutor: opts.toolExecutor,
      maxToolRounds: opts.maxToolRounds,
      fetchImpl: this.fetchImpl,
    });
    // awaited: dispatch failures (auth/network/HTTP status) surface here,
    // at session creation — the same honest semantics as OpenCodeRunner.start
    await runner.begin();
    return runner;
  }

  /** Cheap liveness probe (GET /models): no model call, no tokens. */
  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}/models`;
    try {
      const signal = AbortSignal.timeout(10_000);
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "authorization": `Bearer ${this.apiKey}`,
          "accept": "application/json",
        },
        signal,
      });
      // detail intentionally carries ONLY the status — never headers/body
      return { ok: res.ok, detail: `GET ${url.replace(NVIDIA_BASE_URL, "<nvidia>")} → ${res.status}` };
    } catch (e) {
      return { ok: false, detail: String((e as Error)?.message ?? e) };
    }
  }
}
