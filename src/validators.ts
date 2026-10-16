/**
 * Validators: run the project's own checks (tests/typecheck/build) with hard
 * timeouts. Results are recorded in the store so the final report is evidence,
 * not assertion.
 */
import type { OaeConfig } from "./config.ts";
import { runCommand } from "./util.ts";
import type { Store } from "./store.ts";

export interface ValidatorResult {
  name: string;
  cmd: string;
  code: number | null;
  timedOut: boolean;
  output: string;
}

export async function runValidators(cfg: OaeConfig, store?: Store): Promise<ValidatorResult[]> {
  const results: ValidatorResult[] = [];
  for (const v of cfg.validators) {
    const r = await runCommand(v.cmd, v.args, { cwd: cfg.projectDir, timeoutMs: cfg.recovery.commandTimeoutMs });
    results.push({
      name: v.name,
      cmd: `${v.cmd} ${v.args.join(" ")}`,
      code: r.code,
      timedOut: r.timedOut,
      output: (r.stdout + "\n" + r.stderr).slice(-4000),
    });
    await store?.recordValidator(v.name, r.code, r.timedOut);
  }
  return results;
}
