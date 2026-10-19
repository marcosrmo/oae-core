/**
 * Runtime factory: the ONLY place that instantiates a concrete provider.
 * index.ts (CLI) asks for a runtime; orchestrator/planner consume the
 * abstract Provider contract. A run selects the backend via --provider or
 * OAE_PROVIDER (default: the OpenCode adapter). "nvidia-direct" never
 * spawns, queries or depends on an OpenCode service and its module graph
 * holds no @opencode/client — selection is resolved BEFORE any OpenCode
 * import happens (dynamic imports load only the selected adapter).
 */
import type { Provider } from "./providers/contract.ts";
import type { OpenCodeProvider } from "./providers/opencode.ts";

/** Runtime-neutral service endpoint. Adapter SDK types may NOT cross this
 * boundary (review finding F1); adapters map their native endpoint internally. */
export interface RuntimeEndpoint {
  url: string;
}

export interface Runtime {
  provider: Provider;
  /** Service endpoint (diagnostics only; the contract stays opaque). */
  endpoint?: RuntimeEndpoint;
}

export interface RuntimeOptions {
  /** Explicit backend selection. Default (and "opencode"): OpenCode adapter. */
  selection?: string;
}

export type KnownSelection = "opencode" | "nvidia-direct";

/**
 * Resolve a selection string (flag/env value) to the known set. Unknown
 * values are a configuration error — an honest early throw, never a
 * silent fallback to a different backend.
 */
export function normalizeProviderSelection(raw: string | undefined | null): KnownSelection {
  const v = String(raw ?? "opencode").trim().toLowerCase();
  if (v === "" || v === "opencode" || v === "default") return "opencode";
  if (v === "nvidia-direct" || v === "nvidia" || v === "nvidia_direct") return "nvidia-direct";
  throw new Error(`unknown provider selection "${String(raw)}" — valid: opencode | nvidia-direct`);
}

/**
 * Materialize the selected runtime:
 *  - "opencode": the OpenCode service (spawn-or-connect) or an explicit
 *    OAE_OPENCODE_URL endpoint — unchanged historical behavior; a failing
 *    connect throws so callers forfeit early and truthfully;
 *  - "nvidia-direct": the direct NVIDIA adapter; requires only
 *    OAE_NVIDIA_API_KEY (fail-fast, secret-free error when absent).
 * Health probing is the adapter's concern.
 */
export async function createRuntime(opts?: RuntimeOptions): Promise<Runtime> {
  const selection = normalizeProviderSelection(opts?.selection);
  if (selection === "nvidia-direct") {
    const { NVIDIAProvider } = await import("./providers/nvidia.ts");
    const provider = await NVIDIAProvider.start();
    return { provider, endpoint: { url: NVIDIA_BASE_URL_SAFE } };
  }
  const { OpenCodeProvider: OC } = await import("./providers/opencode.ts");
  const provider = await OC.start();
  return { provider, endpoint: { url: provider.url } };
}

/** Neutral NVIDIA endpoint surfaced for diagnostics (contract stays opaque). */
const NVIDIA_BASE_URL_SAFE = "https://integrate.api.nvidia.com/v1";
