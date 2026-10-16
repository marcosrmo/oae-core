/**
 * OAE configuration. Defaults are defined here; a project may override via
 * `.oae/config.json` inside the target project directory.
 * Never contains secrets — model selection is by id, auth stays with OpenCode.
 */
import { join } from "node:path";
import { readJson } from "./util.ts";

export interface RecoveryConfig {
  /** Time without verifiable progress before the supervisor starts a diagnosis. */
  diagnoseMs: number;      // default 7 min
  /** Time without verifiable progress before a controlled recovery. */
  recoverMs: number;       // default 10 min
  /** Poll interval for progress signals. */
  pollMs: number;          // default 5 s
  /** Max dispatch attempts per task (including recovery attempts). */
  maxAttempts: number;     // default 3
  /** Backoff between attempts. */
  backoffMs: number;       // default 5 s
  /** Hard wall-clock limit for one task. */
  taskTimeoutMs: number;   // default 30 min
  /** Hard wall-clock limit for the whole run. */
  runTimeoutMs: number;    // default 2 h
  /** Hard timeout for a single command executed by a validator. */
  commandTimeoutMs: number;// default 5 min
  /** Max recovery attempts before a task is quarantined (anti-recursion). */
  maxRecoveryCycles: number; // default 2
  /** Re-asks to the reviewer when its verdict is unparseable and validators pass (no coder attempt spent). */
  maxReviewReasks: number; // default 1
  /** Provider 429/401 gates: retries that preserve the engineering attempt budget. */
  maxProviderRetries: number; // default 3
  /** Base wait for provider backoff (doubles per retry, capped at 120 s). */
  providerBackoffMs: number; // default 30 s
}

export interface OaeConfig {
  projectDir: string;
  /** providerID/modelID; null = service default. */
  model: { providerID: string; id: string } | null;
  coderAgent: string;
  reviewerAgent: string;
  plannerAgent: string;
  concurrency: number;
  recovery: RecoveryConfig;
  /** Explicit validator overrides; when empty they are auto-detected. */
  validators: { name: string; cmd: string; args: string[] }[];
}

export function defaultRecovery(): RecoveryConfig {
  return {
    diagnoseMs: 7 * 60_000,
    recoverMs: 10 * 60_000,
    pollMs: 5_000,
    maxAttempts: 3,
    backoffMs: 5_000,
    taskTimeoutMs: 30 * 60_000,
    runTimeoutMs: 2 * 60 * 60_000,
    commandTimeoutMs: 5 * 60_000,
    maxRecoveryCycles: 2,
    maxReviewReasks: 1,
    maxProviderRetries: 3,
    providerBackoffMs: 30_000,
  };
}

export function defaultConfig(projectDir: string): OaeConfig {
  return {
    projectDir,
    model: null,
    coderAgent: "build",
    reviewerAgent: "oae-reviewer",
    plannerAgent: "plan",
    concurrency: 1,
    recovery: defaultRecovery(),
    validators: [],
  };
}

export async function loadConfig(projectDir: string): Promise<OaeConfig> {
  const base = defaultConfig(projectDir);
  const file = join(projectDir, ".oae", "config.json");
  const overrides = await readJson<Partial<OaeConfig>>(file);
  if (!overrides) return base;
  return {
    ...base,
    ...overrides,
    projectDir,
    recovery: { ...base.recovery, ...(overrides.recovery ?? {}) },
    validators: overrides.validators ?? base.validators,
  };
}
