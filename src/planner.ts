/**
 * Planner: inspects the target project, resolves tech stack and validators,
 * then produces an executable plan. Plan generation uses a real OpenCode
 * planning session (agent `plan`, read-only) and falls back to a
 * deterministic single-task plan when the model's output cannot be parsed.
 */
import { join } from "node:path";
import { readJson } from "./util.ts";
import type { OaeConfig } from "./config.ts";
import type { Client } from "./opencode.ts";

export interface PlannedTask {
  id: string;
  title: string;
  instructions: string;
  dependsOn: string[];
  acceptance: string[];
}

export interface Plan {
  summary: string;
  stack: string;
  validators: { name: string; cmd: string; args: string[] }[];
  tasks: PlannedTask[];
  decisions: { kind: "technical" | "business-hypothesis" | "needs-approval"; text: string; rationale: string }[];
}

export async function detectStack(dir: string): Promise<string> {
  const checks: [string, () => Promise<boolean>][] = [];
  const has = async (f: string) => (await readJson(join(dir, f)) ?? (await readJson<unknown>(join(dir, f)))) !== undefined;
  const exists = async (f: string) => Boolean(await readJson(join(dir, f)) ?? false) || has(f);
  void exists;
  const pkg = await readJson<{ name?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(join(dir, "package.json"));
  const py = await readJson<unknown>(join(dir, "pyproject.toml")) ?? await readJson<unknown>(join(dir, "requirements.txt"));
  const go = await readJson<unknown>(join(dir, "go.mod"));
  void checks;
  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const parts = ["node"];
    if (deps.typescript) parts.push("typescript");
    if (deps.react) parts.push("react");
    if (deps.vitest) parts.push("vitest");
    if (deps.jest) parts.push("jest");
    return parts.join("+");
  }
  if (py) return "python";
  if (go) return "go";
  return "unknown";
}

/** Auto-detect validator commands for the detected stack. */
export function defaultValidators(dir: string, stack: string): { name: string; cmd: string; args: string[] }[] {
  if (stack.startsWith("node")) {
    const v: { name: string; cmd: string; args: string[] }[] = [
      { name: "test", cmd: "node", args: ["--test", "test/"] },
    ];
    if (stack.includes("typescript")) {
      v.unshift({ name: "typecheck", cmd: "npx", args: ["tsc", "--noEmit"] });
    }
    return v;
  }
  if (stack === "python") return [{ name: "test", cmd: "python", args: ["-m", "pytest", "-q"] }];
  if (stack === "go") return [{ name: "test", cmd: "go", args: ["test", "./..."] }];
  return [];
}

async function planWithModel(
  client: Client,
  config: OaeConfig,
  request: string,
  stack: string,
  validators: { name: string; cmd: string; args: string[] }[],
): Promise<Plan | undefined> {
  const runner = await import("./opencode.ts").then((m) => m.OpenCodeRunner.start(client, {
    directory: config.projectDir,
    title: "OAE plan",
    agent: config.plannerAgent,
    model: config.model,
    promptText: [
      "You are a planning agent for an autonomous engineering run.",
      `Detected stack: ${stack}. Configured validators: ${validators.map((v) => v.name).join(", ") || "none"}.`,
      "",
      "REQUEST:",
      request,
      "",
      "Respond with ONLY a JSON object (no markdown fences) shaped:",
      '{"summary":string,"tasks":[{"id":string,"title":string,"instructions":string,"dependsOn":string[],"acceptance":string[]}],"decisions":[{"kind":"technical"|"business-hypothesis"|"needs-approval","text":string,"rationale":string}]}',
      "Rules: max 5 tasks; each task implementable in one session; instructions must reference concrete files; acceptance criteria must be checkable commands or verifiable conditions; never invent financial/legal/commercial rules (mark such hypotheses kind='business-hypothesis').",
      "This is the planning step of one autonomous run: do not start other runs and do not invoke the OAE CLI; respond with the JSON only.",
    ].join("\n"),
  }));
  const result = await runner.awaitCompletion(5 * 60_000);
  const m = result.output.match(/\{[\s\S]*\}/);
  if (!m) return undefined;
  try {
    const parsed = JSON.parse(m[0]) as Partial<Plan>;
    if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) return undefined;
    const tasks = parsed.tasks.slice(0, 5).map((t, i) => ({
      id: t.id ?? `task-${i + 1}`,
      title: t.title ?? `Task ${i + 1}`,
      instructions: t.instructions ?? "",
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : [],
      acceptance: Array.isArray(t.acceptance) ? t.acceptance : ["no uncommitted regressions"],
    }));
    return {
      summary: parsed.summary ?? "plan from model",
      stack,
      validators,
      tasks,
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions.slice(0, 10) : [],
    };
  } catch {
    return undefined;
  }
}

function fallbackPlan(request: string, stack: string, validators: { name: string; cmd: string; args: string[] }[]): Plan {
  return {
    summary: `Single-task fallback plan: ${request.slice(0, 120)}`,
    stack,
    validators,
    tasks: [
      {
        id: "task-1",
        title: request.slice(0, 80),
        instructions: request,
        dependsOn: [],
        acceptance: [
          "changes verified with the project's validators",
          "no changes outside the files required by the request",
        ],
      },
    ],
    decisions: [],
  };
}

/**
 * Model planning is skipped for small requests: measured evidence (audit
 * 2026-10-16) shows planner sessions cost up to 5 minutes of critical-path
 * latency and ~11K tokens, and on small requests the deterministic plan is
 * exactly what the run executes anyway. Larger requests keep the model.
 */
export const PLANNER_MODEL_MIN_REQUEST = 200;

export async function makePlan(
  client: Client | null,
  config: OaeConfig,
  request: string,
): Promise<Plan> {
  const stack = await detectStack(config.projectDir);
  const validators = config.validators.length > 0 ? config.validators : defaultValidators(config.projectDir, stack);
  if (client && request.trim().length >= PLANNER_MODEL_MIN_REQUEST) {
    const p = await planWithModel(client, config, request, stack, validators).catch(() => undefined);
    if (p) return p;
  }
  return fallbackPlan(request, stack, validators);
}
