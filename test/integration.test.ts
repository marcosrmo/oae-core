/**
 * Integration test against the REAL OpenCode service (v2.0.29) using the
 * configured provider. Uses one tiny coder task and one reviewer session.
 * Marked with { timeout } and skipped automatically when the service is
 * unreachable or no provider is authenticated.
 */
import test from "node:test";
import { strict as assert } from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { loadConfig, type OaeConfig } from "../src/config.ts";
import { createRuntime } from "../src/runtime.ts";
import { installIntoProject } from "../src/setup.ts";
import type { Plan } from "../src/planner.ts";

async function serviceAvailable(): Promise<boolean> {
  try {
    const { provider } = await createRuntime();
    const hc = await provider.healthCheck?.();
    return Boolean(hc?.ok ?? provider);
  } catch {
    return false;
  }
}

test("integration: real OpenCode session implements and reviews a change", { timeout: 900_000 }, async (t) => {
  const ok = await serviceAvailable();
  if (!ok) return t.skip("OpenCode service/provider unavailable");
  const dir = await mkdtemp(join(tmpdir(), "oae-int-"));
  try {
    // seed a tiny node project
    await writeFile(join(dir, "index.js"), "module.exports = { add: (a, b) => a + b };\n");
    await writeFile(join(dir, "test.js"), "const { add } = require('./index.js');\nconsole.assert(add(1, 2) === 3, 'add broken');\nconsole.log('tests ok');\n");
    const config: OaeConfig = {
      ...(await loadConfig(dir)),
      model: { providerID: "openrouter", id: "z-ai/glm-5.3-flash" },
      validators: [{ name: "test", cmd: "node", args: ["test.js"] }],
      reviewerAgent: "oae-reviewer",
      concurrency: 1,
      recovery: {
        ...(await loadConfig(dir)).recovery,
        diagnoseMs: 5 * 60_000,
        recoverMs: 8 * 60_000,
        maxAttempts: 2,
        taskTimeoutMs: 12 * 60_000,
        runTimeoutMs: 20 * 60_000,
        commandTimeoutMs: 2 * 60_000,
      },
    };
    await installIntoProject(dir); // defines oae-reviewer agent (read-only)
    const store = await Store.create(dir, "int-1", "add sub() to index.js");
    const plan: Plan = {
      summary: "add a sub function",
      stack: "node",
      validators: [],
      tasks: [{
        id: "task-1",
        title: "add sub()",
        instructions: [
          "Add a `sub(a, b)` function to index.js (module.exports it) and extend test.js to assert sub(5,2) === 3.",
          "Do not change anything else.",
        ].join("\n"),
        dependsOn: [],
        acceptance: [
          "index.js exports sub and test.js asserts sub(5,2) === 3",
          "node test.js prints 'tests ok' and adds no failure output",
        ],
      }],
      decisions: [],
    };
    const { provider } = await createRuntime();
    const orch = new Orchestrator(provider, store, { config, plan, sweepIntervalMs: 60_000 });
    const { state } = await orch.run("add sub() to index.js");
    const task = state.tasks[0];
    // the code must actually exist — proof beyond session claims
    const index = await readFile(join(dir, "index.js"), "utf8");
    const testFile = await readFile(join(dir, "test.js"), "utf8");
    assert.ok(index.includes("sub"), "sub() implemented in index.js");
    assert.ok(testFile.includes("sub"), "test.js updated");
    // real validator ran
    const last = state.validatorResults["test"]?.at(-1);
    assert.ok(last, "validator executed");
    assert.equal(last?.code, 0);
    // sessions were real OpenCode sessions
    const codeAttempt = task.attempts.find((a) => a.kind === "code");
    assert.ok(codeAttempt?.sessionId.startsWith("ses_"), "real session id");
    assert.ok(["done", "blocked"].includes(task.status), `task status: ${task.status}`);
    // with a trivial task and a real provider, expect done
    assert.equal(task.status, "done", `summary: ${state.summary}`);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});
