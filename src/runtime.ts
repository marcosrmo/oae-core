/**
 * Runtime factory: the ONLY place that instantiates a concrete provider.
 * index.ts (CLI) asks for a runtime; orchestrator/planner consume the
 * abstract Provider contract. Adding a new provider means registering it
 * here — nothing else in the codebase imports adapter SDKs.
 */
import type { Provider } from "./providers/contract.ts";
import type { Endpoint } from "@opencode/client/service";
import { OpenCodeProvider } from "./providers/opencode.ts";

export interface Runtime {
  provider: Provider;
  /** Service endpoint (diagnostics only; the contract stays opaque). */
  endpoint?: Endpoint;
}

/**
 * Materialize the default runtime: the OpenCode service (spawn-or-connect)
 * or an explicit OAE_OPENCODE_URL endpoint. Health probing is the adapter's
 * concern; a failing connect throws here so callers forfeit early and truthfully.
 */
export async function createRuntime(): Promise<Runtime> {
  const provider = await OpenCodeProvider.start();
  return { provider };
}
