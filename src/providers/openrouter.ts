/**
 * OpenRouter direct provider (Onda 2, stage 2): OpenAI-compatible chat
 * completions against https://openrouter.ai/api/v1 through the SAME shared
 * transport used by nvidia-direct — no second SSE parser, no second tool
 * loop, NO @opencode/client import anywhere in this module's graph and no
 * OpenCode process or service of any kind.
 *
 * OpenRouter specifics honored (docs, verified 2026-10-19):
 *  - `: OPENROUTER PROCESSING` SSE comments are keepalives; the shared parser
 *    already ignores comment lines;
 *  - usage arrives automatically in the final chunk (legacy
 *    `stream_options.include_usage` is deprecated and has no effect there),
 *    so the transport is started with includeUsage:false;
 *  - mid-stream failures arrive as top-level `error` SSE events — handled by
 *    the shared parser (classified via the central HTTP table);
 *  - optional `HTTP-Referer`/`X-Title` attribution headers are NOT sent:
 *    no invented site URL; the Authorization header stays the only
 *    credential-bearing surface.
 *
 * Auth: `OPENROUTER_API_KEY` (primary) or `OAE_OPENROUTER_API_KEY` (legacy
 * plan name), read at provider start. The key travels only in the transport's
 * Authorization header; it is never logged, echoed into errors, or persisted
 * into state.json / JSONL rollouts.
 *
 * Model: REQUIRED per effort — OpenRouter model ids are `author/slug` and no
 * default is invented here. Select with `--model openrouter/<author>/<slug>`;
 * the runner sends `opts.model.id` verbatim ("author/slug"), matching the
 * CLI ref grammar (providerID = "openrouter", id = "author/slug").
 *
 * Selection is explicit (OAE_PROVIDER / --provider openrouter-direct in
 * runtime.ts) — the default provider stays the OpenCode adapter.
 */
import type { Provider, SessionOptions } from "./contract.ts";
import { HttpAgentRunner } from "./http/runner.ts";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenRouterOptions {
  /** Explicit key (tests); otherwise the env (OPENROUTER_API_KEY first). */
  apiKey?: string;
  /** Injectable fetch for offline tests. */
  fetchImpl?: typeof fetch;
  /** Base URL override (tests/gateways). */
  baseUrl?: string;
}

export class OpenRouterProvider implements Provider {
  readonly id = "openrouter-direct";
  private apiKey: string;
  private fetchImpl: typeof fetch | undefined;
  private baseUrl: string;

  private constructor(apiKey: string, fetchImpl?: typeof fetch, baseUrl?: string) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl ?? OPENROUTER_BASE_URL;
  }

  /** Fails fast with a clear, secret-free configuration error when the key
   * is absent — same honest semantics as nvidia-direct. */
  static start(opts?: OpenRouterOptions): OpenRouterProvider {
    const apiKey = opts?.apiKey ?? process.env.OPENROUTER_API_KEY ?? process.env.OAE_OPENROUTER_API_KEY;
    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error(
        "openrouter-direct: configuration error — OPENROUTER_API_KEY is not set. " +
        "Export it in the environment (e.g. `export OPENROUTER_API_KEY=...`); " +
        "never paste the key into prompts, .oae/config.json, or CLI arguments. " +
        "The OpenCode adapter remains available: --provider opencode (default).",
      );
    }
    return new OpenRouterProvider(apiKey, opts?.fetchImpl, opts?.baseUrl);
  }

  async createSession(opts: SessionOptions): Promise<HttpAgentRunner> {
    // NO invented default: OpenRouter aggregates many providers and a model
    // id is author/slug — an arbitrary guess would silently bill the wrong
    // model. A configured run without a model is a configuration error.
    if (!opts.model?.id) {
      throw new Error(
        "openrouter-direct: configuration error — no model selected. " +
        "Pass --model openrouter/<author>/<slug> (e.g. --model openrouter/z-ai/glm-4.6); " +
        "model ids are not invented by the provider.",
      );
    }
    const runner = new HttpAgentRunner({
      provider: this.id,
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      model: opts.model.id,
      agent: opts.agent,
      // tools only for the coder role — parity with nvidia-direct (plan §4)
      toolsEnabled: opts.tools === true,
      root: opts.directory,
      promptText: opts.promptText,
      toolExecutor: opts.toolExecutor,
      maxToolRounds: opts.maxToolRounds,
      includeUsage: false,
      fetchImpl: this.fetchImpl,
    });
    // awaited: dispatch failures (auth/network/HTTP status) surface here
    await runner.begin();
    return runner;
  }

  /** Cheap liveness probe (GET /models): no model call, no tokens. Etapa 3
   * (C1): honors the optional test-injectable fetch; default stays the
   * global fetch so plain start() callers are untouched. detail carries
   * ONLY the status — never headers/body/key. */
  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}/models`;
    try {
      const signal = AbortSignal.timeout(10_000);
      const res = await (this.fetchImpl ?? fetch).call(globalThis, url, {
        method: "GET",
        headers: {
          "authorization": `Bearer ${this.apiKey}`,
          "accept": "application/json",
        },
        signal,
      });
      // detail intentionally carries ONLY the status — never headers/body
      return { ok: res.ok, detail: `GET ${url.replace(this.baseUrl, "<openrouter>")} → ${res.status}` };
    } catch (e) {
      return { ok: false, detail: String((e as Error)?.message ?? e) };
    }
  }
}
