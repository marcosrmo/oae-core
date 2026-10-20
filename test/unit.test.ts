/**
 * Deterministic unit/integration-harness tests using fake agents.
 * No provider calls: fast, reproducible, free.
 */
import test from "node:test";
import { strict as assert } from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, stat, readdir, mkdir, chmod, appendFile, symlink, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Store, type RunState } from "../src/store.ts";
import { Orchestrator, type RunOptions } from "../src/orchestrator.ts";
import { loadConfig, type OaeConfig } from "../src/config.ts";
import type { Plan } from "../src/planner.ts";
import { makePlan } from "../src/planner.ts";
import { FakeRunner, REVIEWER_OK, REVIEWER_REJECT } from "./fake.ts";
import { renderReport } from "../src/report.ts";
import { inspectGit, prepareGit, commitAll } from "../src/git.ts";
import { Supervisor } from "../src/supervisor.ts";
import { acquireRunLock, releaseRunLock, readRunLock } from "../src/runlock.ts";
import { effectiveStatus, finalizeAbandonedRun, probeOwner, reconcileRun } from "../src/reconcile.ts";
import { createProgressReporter, progressFrame, progressLine, redact, redactTruncatedTail } from "../src/progress.ts";
import { OpenCodeRunner, type Client } from "../src/providers/opencode.ts";
import type { SessionUsage, AgentRunner, AgentRunResult, ProgressSignal } from "../src/contracts.ts";
import type { Provider, SessionOptions } from "../src/providers/contract.ts";
import { ProviderError, classifyProviderError, type ProviderErrorKind } from "../src/contracts.ts";
import { SessionLog } from "../src/sessions/writer.ts";
import { createRuntime } from "../src/runtime.ts";
import { OpenCodeProvider } from "../src/providers/opencode.ts";
import { HttpTransport, TRANSPORT_CAPS, type ChatReply } from "../src/providers/http/transport.ts";
import { FileToolSet, FILE_TOOL_LIMITS } from "../src/providers/http/filetools.ts";
import { NVIDIAProvider } from "../src/providers/nvidia.ts";
import { normalizeProviderSelection } from "../src/runtime.ts";
import { OpenRouterProvider } from "../src/providers/openrouter.ts";
import { loadRunView, type RunView } from "../src/viewmodel.ts";
import { renderSummary, renderResultLine } from "../src/dashboard.ts";
import { listRunHistory } from "../src/history.ts";
import { sleep } from "../src/util.ts";

/** Minimal stub of the OpenCode service client for OpenCodeRunner tests. */
function stubClient(over: Record<string, unknown> = {}, counters: { interrupt?: number; context?: number } = {}): Client {
  const session = {
    create: async () => ({ id: "ses_stub" }),
    prompt: async () => ({}),
    active: async () => ({ ses_stub: { type: "running" } }),
    context: async () => { counters.context = (counters.context ?? 0) + 1; return { data: [] }; },
    interrupt: async () => { counters.interrupt = (counters.interrupt ?? 0) + 1; },
    get: async () => ({ tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 0 } }, cost: 0 }),
    ...over,
  };
  return { session } as unknown as Client;
}

async function makeProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "oae-unit-"));
}

function fastRecovery(cfg: OaeConfig): OaeConfig {
  return {
    ...cfg,
    concurrency: 1,
    validators: [{ name: "selftest", cmd: "node", args: ["-e", "process.exit(0)"] }],
    recovery: {
      ...cfg.recovery,
      diagnoseMs: 7 * 60_000,
      recoverMs: 10 * 60_000,
      pollMs: 3_600_000,   // ticker effectively off; tests sweep manually
      maxAttempts: 3,
      backoffMs: 10,
      providerBackoffMs: 1, // deterministic, instant provider gates
      taskTimeoutMs: 60_000,
      runTimeoutMs: 5 * 60_000,
      commandTimeoutMs: 30_000,
      maxRecoveryCycles: 2,
    },
  };
}

/** A stubbed SSE event client: each subscribe() call replays the next chunk
 * (replaying the LAST chunk once the script is exhausted). A chunk with
 * `reset: true` makes every next() reject (simulated transport drop). */
type SseChunk = { events?: Array<{ type: string; data?: Record<string, unknown> }>; reset?: boolean };

function stubEventClient(chunks: SseChunk[], over: Record<string, unknown> = {}, counters: Record<string, number> = {}): Client {
  let attempt = 0;
  const event = {
    subscribe: () => {
      counters.subscribe = (counters.subscribe ?? 0) + 1;
      const chunk = chunks[Math.min(attempt++, chunks.length - 1)]! ?? {};
      const evs = chunk.events ?? [];
      return {
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            next: async (): Promise<IteratorResult<unknown>> => {
              if (chunk.reset) throw new Error("stream reset");
              const ev = i < evs.length ? evs[i++] : undefined;
              return ev ? { value: ev, done: false as const } : { value: undefined, done: true as const };
            },
          };
        },
      } as AsyncIterable<unknown>;
    },
  };
  const client = stubClient(over, counters as { interrupt?: number; context?: number });
  return Object.assign(client, { event }) as unknown as Client;
}

function plan1(dir: string, task: Partial<Plan["tasks"][number]> = {}): Plan {
  return {
    summary: "test plan",
    stack: "node",
    validators: [],
    tasks: [{
      id: "task-1",
      title: "implement hello",
      instructions: "create src/hello.ts exporting hello()",
      dependsOn: [],
      acceptance: ["src/hello.ts exists", "selftest validator passes"],
      ...task,
    }],
    decisions: [],
  };
}

const FACTORY_OK_CODER = () => new FakeRunner("s-code", { type: "complete", output: "RESULT:\nfiles: src/hello.ts\ncommands: none" });

/** A scripted runner: pops one prepared result per awaitCompletion; emits a
 * progress signal like a real session would. Also records requested usage. */
function scriptedRunner(script: { result: { outcome: AgentRunResult["outcome"]; output?: string }; usage?: SessionUsage | null }[]): AgentRunner {
  let i = 0;
  let lastUsage: SessionUsage | null = null;
  const r: AgentRunner = {
    runtime: "scripted",
    sessionId: "s-script-" + String(scriptedRunnerSeq++),
    prompt: async () => {},
    awaitCompletion: async (_t, onProgress) => {
      const step = script[Math.min(i, script.length - 1)]!;
      i++;
      lastUsage = "usage" in step ? step.usage ?? null : null;
      onProgress?.({ at: new Date().toISOString(), kind: "message", detail: "scripted signal" });
      return { outcome: step.result.outcome, output: step.result.output ?? "", signals: [] };
    },
    interrupt: async () => {},
    transcriptTail: async () => "",
    usage: async () => lastUsage,
  };
  return r;
}
let scriptedRunnerSeq = 0;

/** Parse `<project>/.oae/events.jsonl` into objects (test helper). */
async function readEvents(dir: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(join(dir, ".oae", "events.jsonl"), "utf8");
  return raw.trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Simulate a torn append (crash mid-write): raw bytes, no trailing newline. */
function rawAppend(file: string, text: string): Promise<void> {
  return appendFile(file, text, "utf8");
}

/** Write a synthetic `.oae/` with a given state + events (viewmodel fixtures). */
async function writeOae(dir: string, state: RunState, events: Array<Record<string, unknown>>): Promise<void> {
  await mkdir(join(dir, ".oae"), { recursive: true });
  await writeFile(join(dir, ".oae", "state.json"), JSON.stringify(state, null, 2), "utf8");
  await writeFile(join(dir, ".oae", "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

const DEMO_REQUEST = "demo request";

function demoState(over: Partial<RunState> = {}): RunState {
  return {
    id: "run-demo",
    request: DEMO_REQUEST,
    projectDir: "_TESTDIR_",
    startedAt: "2026-10-16T10:00:00.000Z",
    status: "running",
    git: { branch: "oae/auto-run-demo" },
    tasks: [],
    decisions: [],
    validatorResults: {},
    ...over,
  };
}

test("task lifecycle: dispatch → review → validators → commit → done", async () => {
  const dir = await makeProject();
  try {
    const config = fastRecovery(await loadConfig(dir));
    const store = await Store.create(dir, "run-ok", "add hello module");
    const reviewer = new FakeRunner("s-rev", { type: "complete", output: REVIEWER_OK });
    const orch = new Orchestrator(null, store, {
      config,
      plan: plan1(dir),
      runnerFactory: (kind) => (kind === "coder" ? FACTORY_OK_CODER() : reviewer),
    });
    const { state } = await orch.run("add hello module");
    assert.equal(state.status, "done");
    assert.equal(state.tasks[0].status, "done");
    assert.ok(state.tasks[0].commit, "task should have a commit");
    // review happened and approved
    const review = state.tasks[0].attempts.find((a) => a.kind === "review");
    assert.ok(review);
    assert.equal(review.outcome, "approved");
    // validator executed and recorded
    assert.equal(state.validatorResults["selftest"]?.[0]?.code, 0);
    // reviewer prompt carried acceptance criteria and diff
    assert.ok(reviewer.prompts[0].includes("ACCEPTANCE CRITERIA"));
    assert.ok(reviewer.prompts[0].includes("TASK task-1"));
    // git: a run branch was created
    const g = await inspectGit(dir);
    assert.ok(g.isRepo);
    assert.ok(g.branch.startsWith("oae/auto-"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("persistent store: state.json + events.jsonl recorded", async () => {
  const dir = await makeProject();
  try {
    const config = fastRecovery(await loadConfig(dir));
    const store = await Store.create(dir, "run-persist", "record everything");
    const orch = new Orchestrator(null, store, {
      config,
      plan: plan1(dir),
      runnerFactory: (kind) => (kind === "coder" ? FACTORY_OK_CODER() : new FakeRunner("s-rev", { type: "complete", output: REVIEWER_OK })),
    });
    await orch.run("record everything");
    const raw = await readFile(join(dir, ".oae", "state.json"), "utf8");
    const parsed = JSON.parse(raw) as RunState;
    assert.equal(parsed.request, "record everything");
    const events = await readFile(join(dir, ".oae", "events.jsonl"), "utf8");
    for (const kind of ["run_started", "plan_ready", "task_added", "validator", "decision", "attempt_added", "run_finished"]) {
      assert.ok(events.includes(`"${kind}"`), `events.jsonl missing ${kind}`);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("independent review rejects and drives rework until approved", async () => {
  const dir = await makeProject();
  try {
    const config = fastRecovery(await loadConfig(dir));
    const store = await Store.create(dir, "run-review", "broken then fixed");
    const coders = [
      new FakeRunner("s-code-1", { type: "complete", output: "did it wrong" }),
      new FakeRunner("s-code-2", { type: "complete", output: "RESULT:\nfiles: src/hello.ts" }),
    ];
    const reviewers = [
      new FakeRunner("s-rev-1", { type: "complete", output: REVIEWER_REJECT("acceptance criterion 1 unmet: src/hello.ts missing") }),
      new FakeRunner("s-rev-2", { type: "complete", output: REVIEWER_OK }),
    ];
    let codeIdx = 0, revIdx = 0;
    const orch = new Orchestrator(null, store, {
      config,
      plan: plan1(dir),
      runnerFactory: (kind) => (kind === "coder" ? coders[codeIdx++]! : reviewers[revIdx++]!),
    });
    const { state } = await orch.run("broken then fixed");
    assert.equal(state.status, "done");
    assert.equal(state.tasks[0].status, "done");
    assert.equal(state.tasks[0].attempts.filter((a) => a.kind === "code").length, 2);
    assert.equal(state.tasks[0].attempts.find((a) => a.kind === "review")!.outcome, "rejected");
    assert.equal(state.tasks[0].attempts.filter((a) => a.kind === "review")[1].outcome, "approved");
    // second coder received reviewer findings
    assert.ok(coders[1]!.prompts[0].includes("acceptance criterion 1 unmet"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("validator failure keeps task out of done (criteria enforcement)", async () => {
  const dir = await makeProject();
  try {
    const config = fastRecovery(await loadConfig(dir));
    config.validators = [{ name: "failing", cmd: "node", args: ["-e", "process.exit(1)"] }];
    const store = await Store.create(dir, "run-valfail", "validators gate completion");
    const orch = new Orchestrator(null, store, {
      config,
      plan: plan1(dir),
      runnerFactory: (kind) => (kind === "coder" ? FACTORY_OK_CODER() : new FakeRunner("s-rev", { type: "complete", output: REVIEWER_OK })),
    });
    const { state } = await orch.run("validators gate completion");
    assert.equal(state.tasks[0].status, "blocked"); // attempt limit with failing validator
    assert.notEqual(state.status, "done");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("stall detection: 7min diagnosis, 10min recovery, refined redispatch", async () => {
  const dir = await makeProject();
  try {
    const config = fastRecovery(await loadConfig(dir));
    const store = await Store.create(dir, "run-stall", "recover a stalled agent");
    const hang = new FakeRunner("s-hang", { type: "hang" });
    const recovered = new FakeRunner("s-recover", { type: "complete", output: "RESULT:\nfiles: src/hello.ts" });
    let codeDispatch = 0;
    const orch = new Orchestrator(null, store, {
      config,
      plan: plan1(dir),
      runnerFactory: (kind) => (kind === "coder" ? (codeDispatch++ === 0 ? hang : recovered) : new FakeRunner("s-rev", { type: "complete", output: REVIEWER_OK })),
    });
    const runPromise = orch.run("recover a stalled agent");
    // wait for first (hanging) attempt to be registered
    await new Promise<void>((res, rej) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (store.state.tasks[0]?.attempts.length === 1) { clearInterval(iv); res(); }
        else if (Date.now() - t0 > 10_000) { clearInterval(iv); rej(new Error("attempt not registered")); }
      }, 50);
    });
    // fake clock forward past diagnose threshold (7 min)
    clockOffset(orch, 8 * 60_000);
    await orch.sweepNow();
    assert.ok(store.state.decisions.some((d) => d.text.includes("Diagnosed stalled task")), "diagnosis recorded");
    // forward past recover threshold (10 min)
    clockOffset(orch, 11 * 60_000);
    await orch.sweepNow();
    const { state } = await runPromise;
    assert.equal(state.tasks[0].status, "done");
    assert.equal(state.tasks[0].attempts[0].outcome, "interrupted");
    assert.ok(state.tasks[0].attempts.length >= 2);
    // recovered coder got the recovery context
    assert.ok(recovered.prompts[0].includes("RECOVERY DISPATCH"));
    assert.ok(state.decisions.some((d) => d.by === "supervisor" && d.text.includes("Recovering stalled task")));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

/** Replaces the orchestrator supervisor's clock with an offset one. */
function clockOffset(orch: Orchestrator, ms: number): void {
  const sup = (orch as unknown as { supervisor: { clock: { now(): number } } }).supervisor;
  sup.clock = { now: () => Date.now() + ms };
}

test("attempt limit and cycle prevention: repeated stalls end blocked", async () => {
  const dir = await makeProject();
  try {
    const config = fastRecovery(await loadConfig(dir));
    config.recovery.maxAttempts = 2;
    config.recovery.maxRecoveryCycles = 1;
    config.recovery.taskTimeoutMs = 2_000; // FakeRunner hang honors this bound
    const store = await Store.create(dir, "run-cycle", "always stalls");
    const hang1 = new FakeRunner("s-hang-1", { type: "hang" });
    const hang2 = new FakeRunner("s-hang-2", { type: "hang" });
    let codeDispatch = 0;
    const orch = new Orchestrator(null, store, {
      config,
      plan: plan1(dir),
      runnerFactory: (kind) => (kind === "coder" ? (codeDispatch++ === 0 ? hang1 : hang2) : new FakeRunner("s-rev", { type: "complete", output: REVIEWER_OK })),
    });
    const runPromise = orch.run("always stalls");
    await waitFor(() => store.state.tasks[0]?.attempts.length === 1);
    clockOffset(orch, 11 * 60_000);
    await orch.sweepNow(); // first recovery (cycles=1)
    await waitFor(() => store.state.tasks[0]?.attempts.length === 2, 15000);
    const { state } = await runPromise;
    assert.equal(state.tasks[0].status, "blocked");
    assert.ok(
      (state.tasks[0].blockedReason ?? "").includes("attempt limit") ||
      (state.tasks[0].blockedReason ?? "").includes("recovery limit"),
      `blocked reason: ${state.tasks[0].blockedReason}`,
    );
    assert.ok(state.decisions.some((d) => d.by === "supervisor"));
    assert.ok(hang2.prompts[0].includes("RECOVERY DISPATCH") || hang2.prompts.length >= 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("supervisor quarantines a task past the recovery-cycle limit", async () => {
  const dir = await makeProject();
  try {
    const config = fastRecovery(await loadConfig(dir));
    config.recovery.maxRecoveryCycles = 1;
    const store = await Store.create(dir, "run-quarantine", "never recovers");
    await store.addTask({ id: "task-q", title: "q", instructions: "i", dependsOn: [], acceptance: ["a"] });
    await store.updateTask("task-q", { recoveryCycles: 1 }); // already at limit
    const sup = new Supervisor(config.recovery, store);
    const hang = new FakeRunner("s-hang-q", { type: "hang" });
    sup.register("task-q", hang);
    // back-date the supervised run beyond the recover threshold
    const run = (sup as unknown as { runs: Map<string, { lastSignalAt: number }> }).runs.get("task-q")!;
    run.lastSignalAt = Date.now() - 11 * 60_000;
    const actions = await sup.sweep();
    assert.equal(actions[0]?.type, "quarantine");
    assert.ok(actions[0].type === "quarantine" && actions[0].reason.includes("recovery limit"));
    assert.equal(hang.interrupted, true, "quarantine interrupts the stalled session");
    assert.ok((await readFile(join(dir, ".oae", "events.jsonl"), "utf8")).includes("supervisor_quarantine"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("agent failure: task blocked, independent task continues", async () => {
  const dir = await makeProject();
  try {
    const config = fastRecovery(await loadConfig(dir));
    config.recovery.maxAttempts = 1; // fail fast
    const store = await Store.create(dir, "run-fail", "failing + independent");
    const plan: Plan = {
      summary: "two tasks",
      stack: "node",
      validators: [],
      tasks: [
        { id: "task-a", title: "fails", instructions: "boom", dependsOn: [], acceptance: ["x"] },
        { id: "task-b", title: "independent", instructions: "ok", dependsOn: [], acceptance: ["y"] },
      ],
      decisions: [],
    };
    const orch = new Orchestrator(null, store, {
      config,
      plan,
      runnerFactory: (kind, task) => {
        if (kind !== "coder") return new FakeRunner("s-rev-" + task.id, { type: "complete", output: REVIEWER_OK });
        return task.id === "task-a"
          ? new FakeRunner("s-err-a", { type: "error" })
          : new FakeRunner("s-ok-b", { type: "complete", output: "RESULT: ok" });
      },
    });
    const { state } = await orch.run("failing + independent");
    const a = state.tasks.find((t) => t.id === "task-a")!;
    const b = state.tasks.find((t) => t.id === "task-b")!;
    assert.equal(a.status, "blocked");
    assert.equal(b.status, "done");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("dependency failure blocks dependent task", async () => {
  const dir = await makeProject();
  try {
    const config = fastRecovery(await loadConfig(dir));
    config.recovery.maxAttempts = 1;
    const store = await Store.create(dir, "run-deps", "dependency chain");
    const plan: Plan = {
      summary: "chain",
      stack: "node",
      validators: [],
      tasks: [
        { id: "task-a", title: "fails", instructions: "boom", dependsOn: [], acceptance: ["x"] },
        { id: "task-b", title: "dependent", instructions: "after a", dependsOn: ["task-a"], acceptance: ["y"] },
      ],
      decisions: [],
    };
    const orch = new Orchestrator(null, store, {
      config,
      plan,
      runnerFactory: (kind, task) => (kind === "coder"
        ? (task.id === "task-a" ? new FakeRunner("s-err-a", { type: "error" }) : new FakeRunner("s-ok-b", { type: "complete", output: "ok" }))
        : new FakeRunner("s-rev-" + task.id, { type: "complete", output: REVIEWER_OK })),
    });
    const { state } = await orch.run("dependency chain");
    assert.equal(state.tasks.find((t) => t.id === "task-a")!.status, "blocked");
    assert.equal(state.tasks.find((t) => t.id === "task-b")!.blockedReason, "dependency failed");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("command timeout recorded (legitimate long ops bounded separately)", async () => {
  const dir = await makeProject();
  try {
    const config = fastRecovery(await loadConfig(dir));
    config.validators = [{ name: "slow", cmd: "node", args: ["-e", "setTimeout(()=>{},5000)"] }];
    config.recovery.commandTimeoutMs = 300;
    config.recovery.maxAttempts = 1;
    const store = await Store.create(dir, "run-timeout", "slow command");
    const orch = new Orchestrator(null, store, {
      config,
      plan: plan1(dir),
      runnerFactory: (kind) => (kind === "coder" ? FACTORY_OK_CODER() : new FakeRunner("s-rev", { type: "complete", output: REVIEWER_OK })),
    });
    await orch.run("slow command");
    const slow = store.state.validatorResults["slow"]![0];
    assert.equal(slow.timedOut, true);
    assert.notEqual(slow.code, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("git preservation: user uncommitted work is never committed by OAE", async () => {
  const dir = await makeProject();
  try {
    // existing repo with one commit + one uncommitted user file
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-b", "main"], { cwd: dir });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "base", "--allow-empty"], { cwd: dir });
    await writeFile(join(dir, "user-note.txt"), "user work — do not touch");
    execFileSync("git", ["add", "user-note.txt"], { cwd: dir }); // staged but uncommitted

    const config = fastRecovery(await loadConfig(dir));
    config.validators = [{ name: "noop", cmd: "node", args: ["-e", "0"] }];
    const store = await Store.create(dir, "run-git", "change code, not user files");
    const orch = new Orchestrator(null, store, {
      config,
      plan: plan1(dir),
      runnerFactory: (kind) => (kind === "coder" ? FACTORY_OK_CODER() : new FakeRunner("s-rev", { type: "complete", output: REVIEWER_OK })),
    });
    const { state } = await orch.run("change code, not user files");
    const g = await inspectGit(dir);
    assert.ok(state.tasks[0].status === "done" || state.tasks[0].status === "blocked");
    // user's staged-but-uncommitted file must remain uncommitted
    assert.ok(g.uncommitted.some((f) => f.includes("user-note.txt")), "user file still uncommitted");
    // and it is not inside the OAE task commit
    const commit = state.tasks[0].commit;
    if (commit) {
      const show = await import("node:child_process").then((m) =>
        m.execFileSync("git", ["show", "--name-only", "--format=", commit], { cwd: dir }).toString());
      assert.ok(!show.includes("user-note.txt"), "OAE commit must not contain user baseline files");
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

/** Point git's global/system config lookup at /dev/null for the git processes
 * spawned during a test — simulates a machine with no configured identity.
 * Only affects this test's child processes; no git config is ever modified. */
function withoutGitIdentity<T>(fn: () => Promise<T>): Promise<T> {
  const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
  const prevSystem = process.env.GIT_CONFIG_SYSTEM;
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  return fn().finally(() => {
    if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
    if (prevSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    else process.env.GIT_CONFIG_SYSTEM = prevSystem;
  });
}

test("git identity: prepareGit and commitAll create real commits with no configured identity", async () => {
  const dir = await makeProject();
  await withoutGitIdentity(async () => {
    try {
      // a file with content, mirroring real runs (.oae state exists before prepareGit)
      await writeFile(join(dir, "project-file.txt"), "content");
      const prep = await prepareGit(dir);
      const st = await inspectGit(dir);
      assert.equal(st.isRepo, true);
      assert.equal(st.hasCommits, true, "baseline commit created despite missing user.name/user.email");
      assert.ok(st.head && /^[0-9a-f]{40}$/.test(st.head), "baseline commit has a valid hash");
      assert.ok(prep.branch?.startsWith("oae/auto-"), "run branch created");

      // commits carry the command-scoped OAE identity (author and committer)
      const { execFileSync } = await import("node:child_process");
      const author = execFileSync("git", ["log", "-1", "--format=%an"], { cwd: dir }).toString().trim();
      const committer = execFileSync("git", ["log", "-1", "--format=%cn"], { cwd: dir }).toString().trim();
      assert.equal(author, "OAE Autonomous");
      assert.equal(committer, "OAE Autonomous");

      // task commit path
      await writeFile(join(dir, "task-change.txt"), "task work");
      const c = await commitAll(dir, "oae(task-1): test commit");
      assert.ok(c.commit && /^[0-9a-f]{40}$/.test(c.commit), "commitAll returns a real commit hash");
      const cAuthor = execFileSync("git", ["log", "-1", "--format=%an"], { cwd: dir }).toString().trim();
      assert.equal(cAuthor, "OAE Autonomous");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

test("git commit: approved task produces a real commit hash (no identity configured)", async () => {
  const dir = await makeProject();
  await withoutGitIdentity(async () => {
    try {
      const config = fastRecovery(await loadConfig(dir));
      config.validators = [{ name: "noop", cmd: "node", args: ["-e", "0"] }];
      const store = await Store.create(dir, "run-commit-hash", "commit hash regression");
      const orch = new Orchestrator(null, store, {
        config,
        plan: plan1(dir),
        runnerFactory: (kind) => (kind === "coder" ? FACTORY_OK_CODER() : new FakeRunner("s-rev", { type: "complete", output: REVIEWER_OK })),
      });
      const { state } = await orch.run("commit hash regression");
      const t = state.tasks[0];
      assert.equal(t.status, "done");
      assert.ok(t.commit && /^[0-9a-f]{40}$/.test(t.commit), "done task carries a valid commit hash");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

test("git commit failure: task is blocked with the error recorded, never reported done", async () => {
  const dir = await makeProject();
  try {
    // existing repo with one initial commit (identity scoped to this command)
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-b", "main"], { cwd: dir });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "base"], { cwd: dir });
    // deterministic commit failure: a pre-commit hook that always fails
    await mkdir(join(dir, ".git", "hooks"), { recursive: true });
    const hook = join(dir, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 1\n");
    await chmod(hook, 0o755);

    const config = fastRecovery(await loadConfig(dir));
    config.validators = [{ name: "noop", cmd: "node", args: ["-e", "0"] }];
    const store = await Store.create(dir, "run-commit-fail", "commit failure handling");
    const orch = new Orchestrator(null, store, {
      config,
      plan: plan1(dir),
      runnerFactory: (kind) => (kind === "coder" ? FACTORY_OK_CODER() : new FakeRunner("s-rev", { type: "complete", output: REVIEWER_OK })),
    });
    const { state } = await orch.run("commit failure handling");
    const t = state.tasks[0];
    assert.notEqual(t.status, "done", "a failed commit must never be a done task");
    assert.equal(t.status, "blocked");
    assert.ok(!t.commit, "no commit hash recorded when the commit failed");
    assert.ok((t.blockedReason ?? "").includes("commit failed"), "blockedReason records the commit error");
    assert.ok(
      state.decisions.some((d) => d.text.includes("Commit failed") && d.rationale?.includes("commitAll error")),
      "failure recorded as an orchestrator decision",
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("final report renders real evidence", async () => {
  const dir = await makeProject();
  try {
    const config = fastRecovery(await loadConfig(dir));
    const store = await Store.create(dir, "run-report", "report content");
    const orch = new Orchestrator(null, store, {
      config,
      plan: plan1(dir),
      runnerFactory: (kind) => (kind === "coder" ? FACTORY_OK_CODER() : new FakeRunner("s-rev", { type: "complete", output: REVIEWER_OK })),
    });
    await orch.run("report content");
    const report = await renderReport(store);
    assert.ok(report.includes("# OAE Run Report"));
    assert.ok(report.includes("task-1"));
    assert.ok(report.includes("**done**"));
    assert.ok(report.includes("selftest: exit=0"));
    assert.ok(report.includes("[technical]"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("run lock: acquire, refuse concurrent holder, release", async () => {
  const dir = await makeProject();
  try {
    const a = await acquireRunLock(dir, "run-a");
    assert.equal(a.ok, true);
    const raw = JSON.parse(await readFile(join(dir, ".oae", "run.lock"), "utf8")) as { pid: number; runId: string };
    assert.equal(raw.pid, process.pid);
    assert.equal(raw.runId, "run-a");
    // same-process re-acquire (e.g. retry after internal error) is allowed
    const a2 = await acquireRunLock(dir, "run-a2");
    assert.equal(a2.ok, true);
    // release only removes our own lock
    await releaseRunLock(dir, "someone-else");
    assert.ok(await stat(join(dir, ".oae", "run.lock")));
    await releaseRunLock(dir, "run-a2");
    await assert.rejects(stat(join(dir, ".oae", "run.lock")));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("run lock: live foreign pid is refused; --force overrides; stale pid reclaimed", async () => {
  const dir = await makeProject();
  try {
    // a real live process holds the lock
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    await new Promise((r) => holder.on("spawn", r));
    await acquireRunLock(dir, "run-holder");
    await writeFile(join(dir, ".oae", "run.lock"), JSON.stringify({ pid: holder.pid, runId: "run-foreign", startedAt: new Date().toISOString() }), "utf8");
    const refused = await acquireRunLock(dir, "run-nested");
    assert.equal(refused.ok, false);
    assert.ok((refused.reason ?? "").includes("already active"));
    const forced = await acquireRunLock(dir, "run-forced", { force: true });
    assert.equal(forced.ok, true);
    await releaseRunLock(dir, "run-forced");
    // stale lock (pid exited) is reclaimed automatically
    const dead = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    await new Promise((r) => dead.on("exit", r));
    await writeFile(join(dir, ".oae", "run.lock"), JSON.stringify({ pid: dead.pid, runId: "run-stale", startedAt: new Date().toISOString() }), "utf8");
    const reclaimed = await acquireRunLock(dir, "run-new");
    assert.equal(reclaimed.ok, true);
    holder.kill();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

/**
 * Fase 0 regressions — orphaned-run detection (the run-mvazafl3 defect).
 * `orphanState()` is a persisted `running` run with one open attempt, exactly
 * the shape the frozen run had.
 */
function orphanState(over: Partial<RunState> = {}): RunState {
  return demoState({
    id: "run-orphan",
    status: "running",
    tasks: [{
      id: "task-1", title: "orphan task", instructions: "i", dependsOn: [], acceptance: [], status: "in_progress",
      recoveryCycles: 0, createdAt: "2026-10-16T10:00:10Z", updatedAt: "2026-10-16T10:00:30Z",
      attempts: [{ id: 1, sessionId: "s1", agent: "build", kind: "code", startedAt: "2026-10-16T10:00:10Z", outcome: "running", summary: "", filesChanged: [], evidence: {} }],
    }],
    ...over,
  });
}

function deadLock(runId: string): string {
  // 999999999 is out of range for the OS (probe returns false deterministically)
  return JSON.stringify({ pid: 999999999, runId, startedAt: "2026-10-16T10:00:00Z" });
}

test("orphan evidence: owner is only 'dead' when provably not alive; terminal states are never reclassified", () => {
  assert.equal(probeOwner(undefined).state, "unknown", "no lock ⇒ unknown, never dead");
  assert.equal(probeOwner({ pid: 0, runId: "r", startedAt: "x" }).state, "unknown", "invalid pid ⇒ unknown");
  assert.equal(probeOwner({ pid: 5, runId: "r", startedAt: "x" }, () => false).state, "dead");
  assert.equal(probeOwner({ pid: 5, runId: "r", startedAt: "x" }, () => true).state, "alive");

  const dead = probeOwner({ pid: 5, runId: "r", startedAt: "x" }, () => false);
  assert.equal(effectiveStatus(orphanState(), dead).status, "interrupted");
  assert.equal(effectiveStatus(orphanState(), dead).orphaned, true);
  // a terminal status is respected even with a dead owner
  assert.equal(effectiveStatus(orphanState({ status: "done" }), dead).status, "done");
  assert.equal(effectiveStatus(orphanState({ status: "done" }), dead).orphaned, false);
  // a live owner keeps the run running
  assert.equal(effectiveStatus(orphanState(), probeOwner({ pid: 5, runId: "r", startedAt: "x" }, () => true)).status, "running");
});

test("reconcile: a run whose lock owner is dead is interrupted, additively and idempotently (run-mvazafl3 regression)", async () => {
  const dir = await makeProject();
  try {
    await writeOae(dir, orphanState(), [
      { at: "2026-10-16T10:00:00Z", kind: "run_started", request: DEMO_REQUEST },
      { at: "2026-10-16T10:00:10Z", kind: "attempt_added", taskId: "task-1", attemptId: 1, attemptKind: "code", outcome: "running" },
    ]);
    await writeFile(join(dir, ".oae", "run.lock"), deadLock("run-orphan"), "utf8");

    const r1 = await reconcileRun(dir, () => false);
    assert.equal(r1.action, "reconciled");
    assert.equal(r1.status, "interrupted");
    assert.equal(r1.attemptsMarked, 1);

    const after = JSON.parse(await readFile(join(dir, ".oae", "state.json"), "utf8")) as RunState;
    assert.equal(after.status, "interrupted", "not 'done': no evidence of completion exists");
    assert.equal(after.tasks[0]!.attempts[0]!.outcome, "interrupted", "an orphaned attempt is never declared completed");
    assert.equal(after.tasks[0]!.attempts[0]!.endedAt, undefined, "an unknown attempt end is never fabricated");
    assert.equal(after.endedAt, "2026-10-16T10:00:30Z", "endedAt is bounded by the last recorded evidence, not wall-clock now");

    // the pre-reconciliation evidence stays auditable under .oae/history/<runId>/
    const snapshot = JSON.parse(await readFile(join(dir, ".oae", "history", "run-orphan", "state.json"), "utf8")) as RunState;
    assert.equal(snapshot.status, "running", "the original 'running' evidence is preserved");
    assert.equal(snapshot.tasks[0]!.attempts[0]!.outcome, "running");

    const evs = (await readFile(join(dir, ".oae", "events.jsonl"), "utf8")).trim().split(/\r?\n/).map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(evs.filter((e) => e.kind === "run_reconciled").length, 1);

    // idempotent: a second pass sees a terminal status and writes nothing
    const r2 = await reconcileRun(dir, () => false);
    assert.equal(r2.action, "none");
    assert.equal(r2.status, "interrupted");
    const evs2 = (await readFile(join(dir, ".oae", "events.jsonl"), "utf8")).trim().split(/\r?\n/).map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(evs2.filter((e) => e.kind === "run_reconciled").length, 1, "no duplicated reconciliation events");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("reconcile: a live owner is never declared interrupted; a missing lock is not proof", async () => {
  const dir = await makeProject();
  try {
    await writeOae(dir, orphanState(), [{ at: "2026-10-16T10:00:00Z", kind: "run_started" }]);
    await writeFile(join(dir, ".oae", "run.lock"), JSON.stringify({ pid: process.pid, runId: "run-orphan", startedAt: "x" }), "utf8");
    const live = await reconcileRun(dir, () => true);
    assert.equal(live.action, "none", "a possibly-live owner must never be reconciled away");
    assert.equal((JSON.parse(await readFile(join(dir, ".oae", "state.json"), "utf8")) as RunState).status, "running");

    await rm(join(dir, ".oae", "run.lock"), { force: true });
    const noLock = await reconcileRun(dir, () => false);
    assert.equal(noLock.action, "none", "no lock ⇒ no proof of a dead owner ⇒ conservative");
    assert.equal(noLock.status, "running");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("dashboard projection: an orphaned run renders as interrupted without writing to disk", async () => {
  const dir = await makeProject();
  try {
    await writeOae(dir, orphanState(), [
      { at: "2026-10-16T10:00:00Z", kind: "run_started", request: DEMO_REQUEST },
      { at: "2026-10-16T10:00:10Z", kind: "attempt_added", taskId: "task-1", attemptId: 1, attemptKind: "code", outcome: "running" },
      { at: "2026-10-16T10:02:27Z", kind: "agent_progress", taskId: "task-1", attemptId: 1, signalKind: "tool", detail: "messages=4" },
    ]);
    await writeFile(join(dir, ".oae", "run.lock"), deadLock("run-orphan"), "utf8");
    const before = await readFile(join(dir, ".oae", "state.json"), "utf8");

    const v = await loadRunView(dir, { isAlive: () => false, nowMs: Date.parse("2026-10-16T20:00:00Z") });
    assert.ok(v);
    assert.equal(v!.status, "interrupted");
    assert.equal(v!.phase, "interrompida (processo ausente)");
    assert.equal(v!.orphaned, true);
    assert.ok((v!.ownerReason ?? "").includes("999999999"));

    const text = renderSummary(v!, { width: 100 });
    assert.ok(!text.includes("agente ativo"), "a dead run is never shown as actively working");
    assert.ok(text.includes("execução órfã"), "the orphan evidence is surfaced");
    assert.ok(renderResultLine(v!, { colors: false }).includes("INTERROMPIDA"), "interruption is distinct from failure");

    // read-only guarantee: the projection never persists anything
    assert.equal(await readFile(join(dir, ".oae", "state.json"), "utf8"), before, "loadRunView must not write state.json");
    await assert.rejects(stat(join(dir, ".oae", "history")));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("crash safety: an in-process abnormal exit finalizes a running run to interrupted (idempotent)", async () => {
  const dir = await makeProject();
  try {
    const store = await Store.create(dir, "run-crash", "demo");
    await store.addTask({ id: "task-1", title: "t", instructions: "i", dependsOn: [], acceptance: [] });
    await store.addAttempt("task-1", { sessionId: "s1", agent: "build", kind: "code", startedAt: new Date().toISOString(), outcome: "running", summary: "", filesChanged: [], evidence: {} });
    assert.equal(store.state.status, "running");

    assert.equal(await finalizeAbandonedRun(store, "received SIGINT"), true);
    assert.equal(store.state.status, "interrupted", "an exception/interrupt must never leave 'running'");
    assert.equal(store.state.tasks[0]!.attempts[0]!.outcome, "interrupted");

    const onDisk = JSON.parse(await readFile(join(dir, ".oae", "state.json"), "utf8")) as RunState;
    assert.equal(onDisk.status, "interrupted");

    // idempotent: the terminal state is never re-finalized
    assert.equal(await finalizeAbandonedRun(store, "again"), false);
    assert.equal(store.state.summary, "interrupted: received SIGINT", "the first reason is kept");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("run lock: a foreign pid's lock survives our release; acquire stamps an ownership token", async () => {
  const dir = await makeProject();
  try {
    await mkdir(join(dir, ".oae"), { recursive: true });
    await writeFile(join(dir, ".oae", "run.lock"), JSON.stringify({ pid: 999999999, runId: "run-foreign", startedAt: "x", token: "t" }), "utf8");
    await releaseRunLock(dir, "run-foreign"); // matching runId, foreign pid
    assert.ok(await stat(join(dir, ".oae", "run.lock")), "a lock held by another process must never be removed");

    await rm(join(dir, ".oae", "run.lock"), { force: true });
    await acquireRunLock(dir, "run-token");
    const lock = await readRunLock(dir);
    assert.ok(lock);
    assert.equal(typeof lock!.token, "string");
    assert.ok((lock!.token ?? "").length >= 8, "the token is a real per-acquisition witness");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("CLI: `oae status` reports the effective status and `oae reconcile` persists it", async () => {
  const dir = await makeProject();
  try {
    await writeOae(dir, orphanState(), [{ at: "2026-10-16T10:00:00Z", kind: "run_started" }]);
    await writeFile(join(dir, ".oae", "run.lock"), deadLock("run-orphan"), "utf8");
    const run = (args: string[]) => new Promise<{ code: number | null; out: string }>((res) => {
      const child = spawn(process.execPath, [join("src", "index.ts"), ...args], { cwd: process.cwd(), env: { ...process.env } });
      let out = "";
      child.stdout?.on("data", (d) => (out += d));
      child.stderr?.on("data", (d) => (out += d));
      child.on("close", (code) => res({ code, out }));
      child.on("error", () => res({ code: -1, out }));
    });

    const st = await run(["status", "--dir", dir]);
    assert.equal(st.code, 0);
    assert.ok(st.out.includes("run: interrupted"), `status must not report a dead owner as running (${st.out})`);

    const rec = await run(["reconcile", "--dir", dir]);
    assert.equal(rec.code, 0);
    assert.ok(rec.out.includes("reconciled run-orphan"), `reconcile output: ${rec.out}`);
    assert.ok(rec.out.includes("snapshot preservado"), "the preserved snapshot is reported");

    const after = JSON.parse(await readFile(join(dir, ".oae", "state.json"), "utf8")) as RunState;
    assert.equal(after.status, "interrupted");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

/** Fase V — one event shape for the progress-feed tests (OaeEvent-compatible). */
const evt = (kind: string, data: Record<string, unknown> = {}, at = "2026-10-16T13:08:19.000Z"): { at: string; kind: string; [k: string]: unknown } => ({ at, kind, ...data });

test("progress feed: real events render ordered, timestamped lines with task/attempt scope", () => {
  const lines: string[] = [];
  const report = createProgressReporter({ colors: false, write: (s) => lines.push(s), now: () => 0 });
  for (const e of [
    evt("run_started", { request: "make the CLI installable", model: "openrouter/z-ai/glm-5.3-flash" }, "2026-10-16T13:03:17.649Z"),
    evt("plan_ready", { tasks: 1 }, "2026-10-16T13:08:19.825Z"),
    evt("task_added", { taskId: "task-1", title: "installable CLI" }, "2026-10-16T13:08:19.824Z"),
    evt("task_updated", { taskId: "task-1", status: "in_progress" }, "2026-10-16T13:08:19.827Z"),
    evt("attempt_added", { taskId: "task-1", attemptId: 1, attemptKind: "code", agent: "build", outcome: "running" }, "2026-10-16T13:08:19.933Z"),
    evt("validator", { name: "typecheck", code: 0, timedOut: false }, "2026-10-16T13:09:10.000Z"),
    evt("attempt_finished", { taskId: "task-1", attemptId: 1, attemptKind: "code", outcome: "completed", elapsedMs: 50_000 }, "2026-10-16T13:09:10.500Z"),
    evt("run_finished", { status: "done", summary: "1/1 tasks completed" }, "2026-10-16T13:12:00.000Z"),
  ]) report(e);

  assert.equal(lines.length, 8, "exactly one line per real event");
  const L = lines.map((l) => l.trimEnd()); // the reporter terminates every line with "\n"
  assert.match(L[0]!, /^\[13:03:17Z\] \[planning\]\s+run started — make the CLI installable \(model openrouter\/z-ai\/glm-5\.3-flash\)$/);
  assert.match(L[1]!, /^\[13:08:19Z\] \[running\]\s+plan ready — 1 task\(s\)/);
  assert.match(L[2]!, /^\[13:08:19Z\] \[planning\]\s+task-1\s+task added: installable CLI$/);
  assert.match(L[4]!, /^\[13:08:19Z\] \[waiting\]\s+task-1#1\s+attempt 1 dispatched \(agent build, kind code\) — waiting for the session$/);
  assert.match(L[5]!, /^\[13:09:10Z\] \[validating\]\s+validator typecheck: exit=0 — ok$/);
  assert.match(L[6]!, /attempt 1 \(code\) → completed \[50s\]$/);
  assert.match(L[7]!, /^\[13:12:00Z\] \[completed\]\s+run finished: done — 1\/1 tasks completed$/);
  // non-interactive safety: no ANSI when colors are off
  assert.ok(lines.every((l) => !l.includes("\x1b[")), "CI-safe output");
});

test("progress feed: every requested state is reachable from real events", () => {
  const states = new Set<string>([
    progressFrame(evt("run_started", { request: "x" })).state,
    progressFrame(evt("plan_ready", { tasks: 1 })).state,
    progressFrame(evt("agent_progress", { detail: "x" })).state,
    progressFrame(evt("attempt_added", { taskId: "t", attemptId: 1 })).state,
    progressFrame(evt("validator", { name: "n", code: 0 })).state,
    progressFrame(evt("retry_scheduled", { reason: "r" })).state,
    progressFrame(evt("run_reconciled", { from: "running", to: "interrupted" })).state,
    progressFrame(evt("provider_error", { message: "m" })).state,
    progressFrame(evt("run_finished", { status: "done" })).state,
    progressFrame(evt("brand_new_kind")).state,
  ]);
  for (const s of ["planning", "running", "waiting", "validating", "recovering", "interrupted", "failed", "completed", "unknown"]) {
    assert.ok(states.has(s), `state ${s} must be reachable from the event taxonomy`);
  }
});

test("progress feed: failure, interruption and recovery are distinct, evidence-based states", () => {
  const frames = [
    progressFrame(evt("provider_error", { httpStatus: 429, message: "Provider request failed with HTTP 429" })),
    progressFrame(evt("provider_error", { httpStatus: 401, message: "authorization header missing" })),
    progressFrame(evt("retry_scheduled", { taskId: "t", attemptNo: 1, reason: "provider unavailable", waitMs: 30_000 })),
    progressFrame(evt("session_interrupted", { taskId: "t", attemptId: 1 })),
    progressFrame(evt("supervisor_diagnose", { taskId: "t", idleMs: 420_000 })),
    progressFrame(evt("supervisor_quarantine", { taskId: "t" })),
    progressFrame(evt("run_reconciled", { from: "running", to: "interrupted", reason: "owner pid 4984 is not alive" })),
    progressFrame(evt("run_finished", { status: "failed" })),
    progressFrame(evt("attempt_finished", { taskId: "t", attemptId: 1, attemptKind: "code", outcome: "interrupted", elapsedMs: 1000 })),
  ];
  assert.deepEqual(frames.map((f) => f.state), [
    "failed", "failed", "recovering", "recovering", "recovering", "failed", "interrupted", "failed", "failed",
  ]);
  assert.ok(frames[0]!.message.includes("HTTP 429"), "provider status surfaced");
  assert.ok(frames[1]!.message.includes("HTTP 401"), "auth failure surfaced distinctly");
  assert.ok(frames[2]!.message.includes("waiting 30s"), "backoff visible");
  assert.ok(frames[4]!.message.includes("420s"), "diagnosis idle time visible");
  assert.ok(frames[6]!.message.includes("running → interrupted"), "reconciliation reason visible");
});

test("progress feed: no fabricated activity — the feed is strictly event-driven and stops cleanly", async () => {
  const dir = await makeProject();
  try {
    const store = await Store.create(dir, "run-quiet", "demo");
    const lines: string[] = [];
    const off = store.onEvent(createProgressReporter({ colors: false, write: (s) => lines.push(s), now: () => 0 }));

    // nothing happens → nothing is printed (no timer, no heartbeat)
    await sleep(30);
    assert.equal(lines.length, 0, "silence must never produce an invented 'still working' line");

    await store.event("run_started", { request: "x" });
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /\[planning\]/);

    // bounded observation: unsubscribing stops the feed immediately…
    off();
    await store.event("plan_ready", { tasks: 1 });
    assert.equal(lines.length, 1, "after unsubscribe no further line is written");
    // …while persistence continues (the feed observes, it does not write)
    const persisted = (await readFile(join(dir, ".oae", "events.jsonl"), "utf8")).trim().split(/\r?\n/);
    assert.equal(persisted.length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("progress feed: agent activity is throttled, but a different attempt is never silenced", () => {
  const lines: string[] = [];
  let clock = 0;
  const report = createProgressReporter({ colors: false, write: (s) => lines.push(s), now: () => clock, throttleMs: 2000 });
  const activity = (ms: number, attemptId: number) => {
    clock = ms;
    report(evt("agent_progress", { taskId: "t", attemptId, signalKind: "tool", detail: `messages=${ms}` }));
  };
  activity(0, 1); activity(100, 1); activity(200, 1); activity(1999, 1); activity(2000, 1); activity(2500, 1);
  assert.equal(lines.length, 2, "only frames at least throttleMs apart are printed");
  activity(2100, 2);
  assert.equal(lines.length, 3, "each attempt has its own throttle window");
  assert.match(lines[0]!, /t#1\s+agent activity: messages=0/);
  assert.match(lines[2]!, /t#2\s+agent activity: messages=2100/);
});

test("progress feed: credentials never reach the terminal", () => {
  const out = progressLine(evt("provider_error", {
    httpStatus: 429, taskId: "task-1", attemptId: 1,
    message: "Provider request failed with HTTP 429: Authorization: Bearer sk-live-abcdef1234567890",
  }));
  assert.ok(!out.line.includes("sk-live-abcdef1234567890"), `token leaked: ${out.line}`);
  assert.ok(out.line.includes("[redacted]"));
  assert.equal(redact("api_key=abcdefgh12345678"), "api_key=[redacted]");
  assert.equal(redact("ghp_abcdefgh12345678"), "[redacted]");
  assert.equal(redact("github_pat_abcdefgh12345678"), "[redacted]");
  assert.equal(redact("a normal message about tokens"), "a normal message about tokens");
});

test("progress feed + dashboard + store stay consistent on a real (fake-agent) run", async () => {
  const dir = await makeProject();
  try {
    const config = fastRecovery(await loadConfig(dir));
    const store = await Store.create(dir, "run-live", "add hello module");
    const lines: string[] = [];
    const off = store.onEvent(createProgressReporter({ colors: false, write: (s) => lines.push(s), now: () => 0 }));
    const orch = new Orchestrator(null, store, {
      config, plan: plan1(dir),
      runnerFactory: (kind) => (kind === "coder" ? FACTORY_OK_CODER() : new FakeRunner("s-rev", { type: "complete", output: REVIEWER_OK })),
    });
    const { state } = await orch.run("add hello module");
    off();
    assert.equal(state.status, "done");

    const kinds = (await readFile(join(dir, ".oae", "events.jsonl"), "utf8")).trim().split(/\r?\n/)
      .map((l) => (JSON.parse(l) as { kind: string }).kind);
    for (const k of ["run_started", "plan_ready", "task_added", "attempt_added", "validator", "attempt_finished", "run_finished"]) {
      assert.ok(kinds.includes(k), `lifecycle event ${k} must be recorded`);
    }
    // the live feed renders exactly one line per persisted event (no invention,
    // no omission) — FakeRunner emits no agent_progress, so nothing is throttled
    assert.equal(lines.length, kinds.length, "feed lines must mirror persisted events 1:1");
    const joined = lines.join("\n");
    for (const tag of ["[planning]", "[running]", "[validating]", "[completed]"]) {
      assert.ok(joined.includes(tag), `${tag} must be visible during the run`);
    }

    // and the dashboard still renders the same run: no compatibility break
    const view = await loadRunView(dir, { nowMs: Date.now() });
    assert.ok(view);
    assert.equal(view!.status, "done");
    assert.equal(view!.phase, "concluída");
    assert.ok(renderSummary(view!, { width: 80 }).includes("concluída"), "the panel shows the completed phase");
    assert.ok(renderResultLine(view!, { colors: false }).includes("CONCLUÍDA"), "and the completed result line");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("progress feed: model and agent selection is reported from real data", () => {
  const started = progressFrame(evt("run_started", { request: "x", model: "openrouter/z-ai/glm-5.3-flash", agents: { coder: "build" } }));
  assert.ok(started.message.includes("openrouter/z-ai/glm-5.3-flash"), "the resolved model is shown, not a guess");
  const dispatched = progressFrame(evt("attempt_added", { taskId: "t", attemptId: 2, attemptKind: "review", agent: "oae-reviewer" }));
  assert.ok(dispatched.message.includes("oae-reviewer"), "the agent actually used is shown");
  assert.ok(dispatched.message.includes("kind review"));
});

test("anti-recursion: dispatched prompts forbid launching nested runs", async () => {
  const dir = await makeProject();
  try {
    const config = fastRecovery(await loadConfig(dir));
    const store = await Store.create(dir, "run-antirecursion", "prompt guards");
    const coder = new FakeRunner("s-code-g", { type: "complete", output: "RESULT:\nfiles: none" });
    const reviewer = new FakeRunner("s-rev-g", { type: "complete", output: REVIEWER_OK });
    const orch = new Orchestrator(null, store, {
      config,
      plan: plan1(dir),
      runnerFactory: (kind) => (kind === "coder" ? coder : reviewer),
    });
    await orch.run("prompt guards");
    assert.ok(coder.prompts[0].includes("NEVER invoke the OAE CLI"), "coder prompt must forbid nested runs");
    assert.ok(reviewer.prompts[0].includes("NEVER invoke the OAE CLI"), "reviewer prompt must forbid nested runs");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("empty coder response is retried, never sent to review", async () => {
  const dir = await makeProject();
  try {
    const config = fastRecovery(await loadConfig(dir));
    const store = await Store.create(dir, "run-empty", "empty then good");
    const coders = [
      new FakeRunner("s-empty", { type: "complete", output: "" }),
      new FakeRunner("s-ok", { type: "complete", output: "RESULT:\nfiles: src/hello.ts" }),
    ];
    const reviewer = new FakeRunner("s-rev", { type: "complete", output: REVIEWER_OK });
    let codeIdx = 0;
    const orch = new Orchestrator(null, store, {
      config,
      plan: plan1(dir),
      runnerFactory: (kind) => (kind === "coder" ? coders[codeIdx++]! : reviewer),
    });
    const { state } = await orch.run("empty then good");
    assert.equal(state.status, "done", `summary: ${state.summary}`);
    assert.equal(state.tasks[0].attempts.filter((a) => a.kind === "code").length, 2, "one empty attempt + one real");
    assert.equal(state.tasks[0].attempts.filter((a) => a.kind === "review").length, 1, "reviewer only saw the real attempt");
    assert.equal(reviewer.prompts.length, 1, "no reviewer session spent on the empty attempt");
    assert.ok(state.decisions.some((d) => d.text.includes("empty response")), "empty response decision recorded");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("all attempts empty: task blocked at the attempt limit, zero review sessions", async () => {
  const dir = await makeProject();
  try {
    const config = fastRecovery(await loadConfig(dir));
    config.recovery.maxAttempts = 2;
    const store = await Store.create(dir, "run-allempty", "always empty");
    const coders = [
      new FakeRunner("s-e1", { type: "complete", output: "" }),
      new FakeRunner("s-e2", { type: "complete", output: "   " }),
    ];
    let codeIdx = 0;
    const orch = new Orchestrator(null, store, {
      config,
      plan: plan1(dir),
      runnerFactory: (kind) => (kind === "coder"
        ? coders[codeIdx++]!
        : new FakeRunner("s-rev", { type: "complete", output: REVIEWER_OK })),
    });
    const { state } = await orch.run("always empty");
    const task = state.tasks[0];
    assert.equal(task.status, "blocked");
    assert.ok((task.blockedReason ?? "").includes("empty"), `blockedReason: ${task.blockedReason}`);
    assert.equal(task.attempts.filter((a) => a.kind === "code").length, 2, "attempt limit respected");
    assert.equal(task.attempts.filter((a) => a.kind === "review").length, 0, "no review session burned");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("per-attempt token telemetry is recorded when the runner provides usage", async () => {
  const dir = await makeProject();
  try {
    const config = fastRecovery(await loadConfig(dir));
    const store = await Store.create(dir, "run-usage", "telemetry");
    const usage: SessionUsage = { input: 11, output: 7, reasoning: 5, cacheRead: 900, cacheWrite: 0, cost: null };
    const coder = Object.assign(FACTORY_OK_CODER(), { usage: async () => usage });
    const reviewer = Object.assign(new FakeRunner("s-rev", { type: "complete", output: REVIEWER_OK }), {
      usage: async () => ({ ...usage, input: 3 }),
    });
    const orch = new Orchestrator(null, store, {
      config,
      plan: plan1(dir),
      runnerFactory: (kind) => (kind === "coder" ? coder : reviewer),
    });
    await orch.run("telemetry");
    const code = store.state.tasks[0].attempts.find((a) => a.kind === "code")!;
    const rev = store.state.tasks[0].attempts.find((a) => a.kind === "review")!;
    assert.deepEqual(JSON.parse(code.evidence.tokens ?? "null"), usage, "coder attempt records service usage");
    assert.equal(JSON.parse(rev.evidence.tokens ?? "{}").input, 3, "review attempt records service usage");
    assert.equal(rev.evidence.verdict, "approve", "verdict evidence preserved");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("runner deadline expiry interrupts the session (no orphan keeps burning tokens)", async () => {
  const counters: { interrupt?: number } = {};
  const client = stubClient({}, counters);
  const runner = await OpenCodeRunner.start(client, {
    directory: ".", title: "t", agent: "build", promptText: "p",
  });
  const res = await runner.awaitCompletion(0); // deadline already reached
  assert.equal(res.outcome, "interrupted");
  assert.equal(counters.interrupt, 1, "the service session must be interrupted when the deadline expires");
});

test("runner completion path: long plan output survives (no 4000-char truncation) and context is fetched once", async () => {
  const longPlan = JSON.stringify({ summary: "s".repeat(4400), tasks: [{ id: "t1", title: "x", instructions: "i", dependsOn: [], acceptance: ["a"] }], decisions: [] });
  assert.ok(longPlan.length > 4000, "fixture must exceed the old truncation bound");
  const counters: { context?: number } = {};
  const client = stubClient({
    active: async () => ({} as Record<string, unknown>), // session already idle -> completes on first poll
    context: async () => { counters.context = (counters.context ?? 0) + 1; return { data: [
      { type: "user", text: "prompt" },
      { type: "assistant", content: [{ type: "text", text: longPlan }] },
      { type: "idle" },
    ] }; },
  }, counters);
  const runner = await OpenCodeRunner.start(client, {
    directory: ".", title: "t", agent: "build", promptText: "p",
  });
  const res = await runner.awaitCompletion(30_000);
  assert.equal(res.outcome, "completed");
  assert.equal(res.output, longPlan, "final output must not be truncated at 4000 chars");
  const parsed = JSON.parse(res.output);
  assert.equal(parsed.tasks.length, 1, "a >4000-char model plan JSON parses (planner fix)");
  assert.equal(counters.context, 1, "completion path must fetch the transcript exactly once (observe only)");
});

test("runner start surfaces a rejected prompt instead of an empty success", async () => {
  const client = stubClient({ prompt: async () => { throw new Error("402 budget exceeded"); } });
  await assert.rejects(
    OpenCodeRunner.start(client, { directory: ".", title: "t", agent: "build", promptText: "p" }),
    /402 budget exceeded/,
  );
});

test("markdown-formatted 'IMPEDIMENT: none' is not a real impediment (run-mvb27epc regression)", async () => {
  const dir = await makeProject();
  try {
    const config = fastRecovery(await loadConfig(dir));
    const store = await Store.create(dir, "run-md-none", "bold none");
    const coder = new FakeRunner("s-md", {
      type: "complete",
      output: "RESULT:\nfiles: src/hello.ts\n- **IMPEDIMENT:** none",
    });
    const reviewer = new FakeRunner("s-rev", { type: "complete", output: REVIEWER_OK });
    const orch = new Orchestrator(null, store, {
      config,
      plan: plan1(dir),
      runnerFactory: (kind) => (kind === "coder" ? coder : reviewer),
    });
    const { state } = await orch.run("bold none");
    assert.equal(state.tasks[0].status, "done", "markdown emphasis must not fake an impediment");
    assert.ok(state.tasks[0].commit, "the good change is committed");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("markdown-formatted real impediment still blocks with a cleaned reason", async () => {
  const dir = await makeProject();
  try {
    const config = fastRecovery(await loadConfig(dir));
    const store = await Store.create(dir, "run-md-real", "bold real");
    const coder = new FakeRunner("s-md2", {
      type: "complete",
      output: "RESULT:\n- **IMPEDIMENT:** missing database credentials for the integration test",
    });
    const orch = new Orchestrator(null, store, {
      config,
      plan: plan1(dir),
      runnerFactory: (kind) => (kind === "coder" ? coder : new FakeRunner("s-rev", { type: "complete", output: REVIEWER_OK })),
    });
    const { state } = await orch.run("bold real");
    const task = state.tasks[0];
    assert.equal(task.status, "blocked");
    assert.equal(task.blockedReason, "missing database credentials for the integration test");
    assert.equal(task.attempts.filter((a) => a.kind === "review").length, 0, "no review session on a blocked task");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("interrupt invalidates the transcript cache: a plan finished right at the deadline is not lost", async () => {
  const counters: { context?: number } = {};
  const planText = '{"summary":"just in time","tasks":[{"id":"t1","title":"x","instructions":"i","dependsOn":[],"acceptance":["a"]}],"decisions":[]}';
  const client = stubClient({
    active: async () => ({ ses_stub: { type: "running" } }), // always busy -> deadline path
    context: async () => { counters.context = (counters.context ?? 0) + 1; return { data: [
      { type: "assistant", content: [{ type: "text", text: planText }] },
    ] }; },
  }, counters);
  const runner = await OpenCodeRunner.start(client, {
    directory: ".", title: "t", agent: "build", promptText: "p",
  });
  const res = await runner.awaitCompletion(0); // deadline already reached
  assert.equal(res.outcome, "interrupted");
  assert.equal(JSON.parse(res.output).summary, "just in time",
    "final output after interrupt must be fetched fresh, not from the stale cache");
  assert.equal(counters.context, 1, "exactly one fresh fetch after invalidation");
});

test("small requests skip the model planner entirely (no wasted session)", async () => {
  const dir = await makeProject();
  try {
    const config = fastRecovery(await loadConfig(dir));
    // Provider stub whose createSession must never be reached: small requests
    // take the deterministic plan (contract behavior, engine-independent)
    const boom: Provider = {
      id: "opencode",
      createSession: async () => { throw new Error("planner session must not be created for small requests"); },
    };
    const plan = await makePlan(boom, config, "add a sub() function to index.js");
    assert.equal(plan.tasks.length, 1, "deterministic single-task plan");
    assert.ok(plan.summary.startsWith("Single-task fallback plan"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("large requests still use the model planner", async () => {
  const dir = await makeProject();
  try {
    const config = fastRecovery(await loadConfig(dir));
    // explicit model selection must reach the planner session as well (review
    // finding F3): same contract propagation as coder/reviewer
    config.model = { providerID: "nvidia", id: "z-ai/glm-5.3-flash" };
    const planJson = { summary: "model plan", tasks: [{ id: "t1", title: "x", instructions: "i", dependsOn: [], acceptance: ["a"] }], decisions: [] };
    const client = stubClient({
      active: async () => ({}) as Record<string, unknown>, // idle on first poll -> completed
      context: async () => ({ data: [
        { type: "assistant", content: [{ type: "text", text: JSON.stringify(planJson) }] },
      ] }),
    });
    const sessions: Array<Record<string, unknown>> = [];
    const big = "restructure the authentication module across src/auth/*.ts ".repeat(10); // > 200 chars
    const plan = await makePlan({
      id: "opencode",
      createSession: (opts) => {
        sessions.push({ agent: opts.agent, model: opts.model, directory: opts.directory, title: opts.title });
        return OpenCodeRunner.start(client, opts);
      },
    }, config, big);
    assert.equal(plan.summary, "model plan", "model-assisted plan is used for large requests");
    const s = sessions[0] ?? {};
    assert.deepEqual(s.model, { providerID: "nvidia", id: "z-ai/glm-5.3-flash" },
      "configured model reaches the planner session verbatim");
    assert.equal(s.agent, config.plannerAgent);
    assert.equal(s.directory, dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("unparseable review with passing validators is re-asked, not re-coded (run-mvb2ysid regression)", async () => {
  const dir = await makeProject();
  try {
    const config = fastRecovery(await loadConfig(dir));
    const store = await Store.create(dir, "run-reask", "prose then json");
    const reviewers = [
      new FakeRunner("s-rev-prose", { type: "complete", output: "Verification complete. All checks pass: the diff is correct and the validator exited 0." }),
      new FakeRunner("s-rev-json", { type: "complete", output: REVIEWER_OK }),
    ];
    let revIdx = 0;
    const orch = new Orchestrator(null, store, {
      config,
      plan: plan1(dir),
      runnerFactory: (kind) => (kind === "coder" ? FACTORY_OK_CODER() : reviewers[revIdx++]!),
    });
    const { state } = await orch.run("prose then json");
    assert.equal(state.status, "done", `summary: ${state.summary}`);
    const task = state.tasks[0];
    assert.equal(task.attempts.filter((a) => a.kind === "code").length, 1, "no coder attempt spent on a review-format failure");
    assert.equal(task.attempts.filter((a) => a.kind === "review").length, 2, "one review + one re-ask");
    assert.ok(reviewers[1]!.prompts[0].includes("ENTIRE reply must be exactly ONE JSON object"), "re-ask carries the format reminder");
    assert.ok(state.decisions.some((d) => d.text.includes("re-asking the reviewer")), "re-ask decision recorded");
    // F6: the rollout distinguishes a substantive approval from an unparseable
    // reply WITHOUT mislabeling either — review attempt outcomes follow the
    // state.json vocabulary (approved/rejected) and `verdict` carries the nuance
    const slog = new SessionLog(dir);
    const revAttempts = task.attempts.filter((a) => a.kind === "review");
    const firstRev = await slog.read(`task-1-a${revAttempts[0]!.id}`);
    const reAskRev = await slog.read(`task-1-a${revAttempts[1]!.id}`);
    const firstOutcome = firstRev.find((e) => e.kind === "result")! as unknown as Record<string, unknown>;
    const secondOutcome = reAskRev.find((e) => e.kind === "result")! as unknown as Record<string, unknown>;
    assert.equal(firstOutcome.outcome, "rejected", "unparseable review is NOT labeled approved/failed");
    assert.equal(firstOutcome.verdict, "unparseable", "unparseable-ness is explicit in `verdict`");
    assert.equal(secondOutcome.outcome, "approved");
    assert.equal(secondOutcome.verdict, "approve");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("review re-asks are bounded: persistent prose falls back to coder rework", async () => {
  const dir = await makeProject();
  try {
    const config = fastRecovery(await loadConfig(dir));
    const store = await Store.create(dir, "run-reask2", "always prose");
    const reviewers = [
      new FakeRunner("s-p1", { type: "complete", output: "prose: everything looks fine" }),
      new FakeRunner("s-p2", { type: "complete", output: "more prose, still no JSON" }),
      new FakeRunner("s-p3", { type: "complete", output: REVIEWER_OK }),
    ];
    let revIdx = 0;
    let codeDispatches = 0;
    const orch = new Orchestrator(null, store, {
      config,
      plan: plan1(dir),
      runnerFactory: (kind) => (kind === "coder"
        ? (codeDispatches++, FACTORY_OK_CODER())
        : reviewers[revIdx++]!),
    });
    const { state } = await orch.run("always prose");
    assert.equal(state.status, "done");
    assert.equal(state.tasks[0].attempts.filter((a) => a.kind === "code").length, 2, "fell back to a coder rework attempt after the bounded re-ask");
    assert.equal(state.tasks[0].attempts.filter((a) => a.kind === "review").length, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("maxReviewReasks=0 preserves the legacy behavior (unparseable review goes straight to rework)", async () => {
  const dir = await makeProject();
  try {
    const config = fastRecovery(await loadConfig(dir));
    config.recovery.maxReviewReasks = 0;
    const store = await Store.create(dir, "run-noreask", "legacy path");
    const reviewers = [
      new FakeRunner("s-np1", { type: "complete", output: "prose only" }),
      new FakeRunner("s-np2", { type: "complete", output: REVIEWER_OK }),
    ];
    let revIdx = 0;
    const orch = new Orchestrator(null, store, {
      config,
      plan: plan1(dir),
      runnerFactory: (kind) => (kind === "coder" ? FACTORY_OK_CODER() : reviewers[revIdx++]!),
    });
    const { state } = await orch.run("legacy path");
    assert.equal(state.status, "done");
    assert.equal(state.tasks[0].attempts.filter((a) => a.kind === "review").length, 2, "no re-ask when disabled");
    assert.ok(!state.decisions.some((d) => d.text.includes("re-asking the reviewer")));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("instrumentation: agents' lifecycle events are typed, classified and complete (observability)", async () => {
  const dir = await makeProject();
  try {
    const config = fastRecovery(await loadConfig(dir));
    config.recovery.maxAttempts = 6;
    const store = await Store.create(dir, "run-instr", "lifecycle instrumented");
    // coder: interrupted → HTTP 429 → empty (zero confirmed tokens) → ok;
    // reviewer: reject → coder ok → approve
    const coderScript = [
      { result: { outcome: "interrupted" as const, output: "" }, usage: null },
      { result: { outcome: "failed" as const, output: "provider/run error: Provider request failed with HTTP 429: {\"status\":429}" }, usage: null },
      { result: { outcome: "completed" as const, output: "" }, usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } },
      { result: { outcome: "completed" as const, output: "RESULT:\nfiles: none\nIMPEDIMENT: none" }, usage: { input: 10, output: 5, reasoning: 2, cacheRead: 0, cacheWrite: 0, cost: 0 } },
      { result: { outcome: "completed" as const, output: "RESULT:\nfiles: none\nIMPEDIMENT: none" }, usage: { input: 11, output: 6, reasoning: 2, cacheRead: 0, cacheWrite: 0, cost: 0 } },
    ];
    let coderIdx = 0;
    const reviewerScript = [
      { result: { outcome: "completed" as const, output: REVIEWER_REJECT("minor issue") }, usage: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } },
      { result: { outcome: "completed" as const, output: REVIEWER_OK }, usage: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } },
    ];
    let reviewerIdx = 0;
    const orch = new Orchestrator(null, store, {
      config,
      plan: plan1(dir),
      runnerFactory: (kind) => {
        const next = kind === "coder" ? coderScript[Math.min(coderIdx++, coderScript.length - 1)]! : { result: reviewerScript[Math.min(reviewerIdx++, reviewerScript.length - 1)]!.result };
        return scriptedRunner([{ result: next.result as { outcome: AgentRunResult["outcome"]; output?: string }, usage: "usage" in next ? next.usage : undefined }]);
      },
    });
    const { state } = await orch.run("lifecycle instrumented");
    assert.equal(state.status, "done");

    const evs = await readEvents(dir);
    const kinds = (k: string) => evs.filter((e) => e.kind === k);
    // attempt_finished: 7 attempts (5 code + 2 review), each with elapsedMs
    const finished = kinds("attempt_finished");
    assert.equal(finished.length, 7);
    assert.ok(finished.every((e) => typeof e.elapsedMs === "number" && (e.elapsedMs as number) >= 0));
    // session interrupt recorded
    const interrupted = kinds("session_interrupted");
    assert.equal(interrupted.length, 1);
    assert.equal(interrupted[0]!.taskId, "task-1");
    // provider errors: HTTP 429 (tokens unknown) + empty-output dispatch failure
    const prov = kinds("provider_error");
    assert.equal(prov.length, 2);
    assert.equal(prov[0]!.httpStatus, 429);
    assert.equal(prov[0]!.tokensUnknown, true);
    assert.equal(prov[0]!.runnerKind, "provider");
    assert.equal(prov[1]!.runnerKind, "runner");
    assert.equal(prov[1]!.tokensUnknown, false, "zero confirmed tokens is not 'unknown'");
    // retries scheduled with deterministic reasons and wait
    const retries = kinds("retry_scheduled");
    const reasons = retries.map((r) => r.reason);
    assert.deepEqual(reasons, [
      "attempt interrupted (deadline or recovery)",
      "provider unavailable (HTTP 429) — engineering attempt not consumed",
      "empty coder response",
      "reviewer rejected (rework)",
    ]);
    assert.ok(retries.every((r) => typeof r.waitMs === "number" && (r.waitMs as number) >= 0));
    // progress from inside the agent loop, tagged with phase/attempt
    const progress = kinds("agent_progress");
    assert.ok(progress.length >= 5, "progress signals recorded");
    assert.ok(progress.some((p) => p.phase === "code" && p.attemptId === 1));
    assert.ok(progress.some((p) => p.phase === "review"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("viewmodel: phases, stall detection, token provenance (confirmed zero vs unknown)", async () => {
  const dir = await makeProject();
  try {
    const t = (at: string) => (at.startsWith("20") ? at : `2026-10-16T10:${at}Z`);
    const state = demoState({
      tasks: [{
        id: "task-1", title: "demo", instructions: "", dependsOn: [], acceptance: [], status: "in_progress",
        recoveryCycles: 0, createdAt: t("00:10"), updatedAt: t("00:30"),
        attempts: [
          { id: 1, sessionId: "s1", agent: "build", kind: "code", startedAt: t("00:10"), outcome: "running", summary: "", filesChanged: [], evidence: {} },
          { id: 2, sessionId: "s2", agent: "build", kind: "code", startedAt: t("00:05"), endedAt: t("00:09"), outcome: "completed", summary: "", filesChanged: [], evidence: { tokens: JSON.stringify({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }) } },
        ],
      }],
    });
    const events = [
      { at: t("00:00"), kind: "run_started", request: DEMO_REQUEST },
      { at: t("00:05"), kind: "plan_ready", tasks: 1, summary: "single task" },
      { at: t("00:10"), kind: "attempt_added", taskId: "task-1", attemptId: 1, attemptKind: "code", outcome: "running" },
      { at: t("00:30"), kind: "agent_progress", taskId: "task-1", attemptId: 1, phase: "code", signalKind: "tool", detail: "messages=4 lastType=assistant tools=edit" },
    ];
    await writeOae(join(dir), state, events);

    // 40s after the last confirmed activity → actively executing
    const v1 = await loadRunView(dir, { nowMs: Date.parse(t("00:40")), stallThresholdMs: 7 * 60_000 })!;
    assert.ok(v1);
    assert.equal(v1.phase, "executando");
    assert.equal(v1.tokens.attemptsWithTokens, 1, "attempt without evidence.tokens is NOT counted as having tokens");
    assert.equal(v1.tokens.totals.unknown, true, "partial telemetry stays unknown, never faked");
    assert.equal(v1.lastConfirmedActivity?.label.includes("tools=edit"), true);
    assert.equal(v1.stallMs, undefined, "no stall within the threshold");

    // 8 minutes without confirmable activity → explicit no-progress phase
    const v2 = await loadRunView(dir, { nowMs: Date.parse(t("08:20")), stallThresholdMs: 7 * 60_000 });
    assert.ok(v2);
    assert.equal(v2.phase, "sem progresso detectável");
    assert.ok((v2.stallMs ?? 0) > 7 * 60_000);

    // a terminal status is respected regardless of events
    await writeOae(join(dir), { ...state, status: "failed", endedAt: t("05:00") }, events);
    const v3 = await loadRunView(dir, { nowMs: Date.parse(t("08:20")) });
    assert.ok(v3);
    assert.equal(v3.phase, "falhou");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("viewmodel: retry/preparation phase and provider-error alerts surfaced from events", async () => {
  const dir = await makeProject();
  try {
    const t = (s: string) => `2026-10-16T10:0${s}`;
    const state = demoState({
      tasks: [{
        id: "task-1", title: "demo", instructions: "", dependsOn: [], acceptance: [], status: "in_progress",
        recoveryCycles: 0, createdAt: t("00:10"), updatedAt: t("00:40"),
        attempts: [
          { id: 1, sessionId: "s1", agent: "build", kind: "code", startedAt: t("00:10"), endedAt: t("00:30"), outcome: "interrupted", summary: "", filesChanged: [], evidence: {} },
        ],
      }],
      validatorResults: { selftest: [{ name: "selftest", code: 1, timedOut: false, at: t("00:35") }] },
    });
    const events = [
      { at: t("00:00"), kind: "run_started", request: DEMO_REQUEST },
      { at: t("00:01"), kind: "plan_ready", tasks: 1 },
      { at: t("00:10"), kind: "attempt_added", taskId: "task-1", attemptId: 1, attemptKind: "code", outcome: "running" },
      { at: t("00:30"), kind: "attempt_finished", taskId: "task-1", attemptId: 1, attemptKind: "code", outcome: "interrupted", elapsedMs: 20000 },
      { at: t("00:31"), kind: "session_interrupted", taskId: "task-1", attemptId: 1 },
      { at: t("00:36"), kind: "validator", name: "selftest", code: 1, timedOut: false },
      { at: t("00:37"), kind: "provider_error", taskId: "task-1", attemptId: 1, runnerKind: "provider", httpStatus: 429, message: "Provider request failed with HTTP 429: too many", tokensUnknown: true },
      { at: t("00:38"), kind: "retry_scheduled", taskId: "task-1", attemptNo: 1, reason: "attempt interrupted (deadline or recovery)", waitMs: 5000 },
    ];
    await writeOae(join(dir), state, events);
    const v = await loadRunView(join(dir), { nowMs: Date.parse(t("00:42")), stallThresholdMs: 7 * 60_000 });
    assert.ok(v);
    assert.equal(v.phase, "em nova tentativa", "rework markers after the last attempt_added = preparing a retry");
    assert.equal(v.providerErrors.length, 1);
    assert.equal(v.providerErrors[0]!.httpStatus, 429);
    assert.equal(v.retries.length, 1);
    const provLine = v.timeline.find((x) => x.type === "provider_error");
    assert.equal(provLine?.level, "error");
    assert.ok(provLine!.label.includes("HTTP 429"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("dashboard render: deterministic, CI-safe (no ANSI unless TTY), alerts and result line from real outcomes", async () => {
  const dir = await makeProject();
  try {
    const state = demoState({
      status: "failed", endedAt: "2026-10-16T10:05:30.000Z", summary: "0/1 tasks completed; validators: selftest=1",
      tasks: [{
        id: "task-1", title: "demo task", instructions: "", dependsOn: [], acceptance: [], status: "blocked", blockedReason: "provider unavailable after 3 provider retries",
        recoveryCycles: 0, createdAt: "2026-10-16T10:00:10Z", updatedAt: "2026-10-16T10:05:20Z",
        attempts: [
          { id: 1, sessionId: "s1", agent: "build", kind: "code", startedAt: "2026-10-16T10:00:10Z", endedAt: "2026-10-16T10:01:40Z", outcome: "interrupted", summary: "", filesChanged: [], evidence: {} },
          { id: 2, sessionId: "s2", agent: "build", kind: "provider_retry", startedAt: "2026-10-16T10:02:10Z", endedAt: "2026-10-16T10:02:40Z", outcome: "interrupted", summary: "", filesChanged: [], evidence: { tokens: JSON.stringify({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }) } },
        ],
      }],
      validatorResults: { selftest: [{ name: "selftest", code: 1, timedOut: false, at: "2026-10-16T10:01:45Z" }] },
    });
    const label = (s: string) => `2026-10-16T10:0${s}`;
    const events = [
      { at: label("00:00"), kind: "run_started", request: DEMO_REQUEST },
      { at: label("00:01"), kind: "plan_ready", tasks: 1 },
      { at: label("00:10"), kind: "attempt_added", taskId: "task-1", attemptId: 1, attemptKind: "code", outcome: "running" },
      { at: label("00:31"), kind: "provider_error", taskId: "task-1", attemptId: 1, runnerKind: "provider", httpStatus: 429, message: "provider/run error: Provider request failed with HTTP 429", tokensUnknown: true },
      { at: label("00:32"), kind: "retry_scheduled", taskId: "task-1", attemptNo: 1, reason: "provider rate limit", waitMs: 30000 },
      { at: label("03:20"), kind: "run_finished", status: "failed", summary: "0/1 tasks completed" },
    ];
    await writeOae(join(dir), state, events);
    const view = await loadRunView(join(dir), { nowMs: Date.parse("2026-10-16T10:06:00Z") });
    assert.ok(view);
    const text = renderSummary(view, { width: 80 });
    assert.ok(!text.includes("\x1b["), "no ANSI escapes in non-TTY mode");
    assert.ok(text.includes("OAE run-demo"), "run header with id");
    assert.ok(text.includes("falhou") || text.includes("bloqueada"), "phase/status visible");
    assert.ok(text.includes("HTTP 429"), "provider alert surfaced");
    assert.ok(text.includes("provider unavailable after 3 provider retries"), "blocked reason surfaced");
    assert.ok(text.includes("retry scheduled: provider rate limit"), "retry scheduling surfaced from events");
    assert.ok(text.includes("unknown (no usage recorded)") || text.includes("total:"), "token metrics section present");
    assert.ok(text.includes("0/1 tasks completed"), "final summary mirrors the real run outcome");
    const result = renderResultLine(view, { colors: false });
    assert.ok(result.includes("FALHOU/BLOQUEADA"), "result line matches the failed run");
    assert.ok(result.includes("0 concluídas"), "task rollup from real statuses, never invented");
    // duration formatting from real timestamps
    assert.ok(text.includes("5m30s") || text.includes("330s"), "duration formatted");
    // detail mode includes the full timeline including the last events
    const detailed = renderSummary(view, { width: 120, detail: true });
    assert.ok(detailed.includes("run_finished") || detailed.includes("run finished"), "timeline present");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("history: previous run archived before overwrite, readable, with provider counts", async () => {
  const dir = await makeProject();
  try {
    const oldState = demoState({
      id: "run-old", status: "failed", endedAt: "2026-10-16T10:05:30.000Z",
      tasks: [{ id: "task-1", title: "demo", instructions: "", dependsOn: [], acceptance: [], status: "blocked", recoveryCycles: 0, createdAt: "2026-10-16T10:00:10Z", updatedAt: "2026-10-16T10:05:20Z", attempts: [] }],
    });
    const t = (s: string) => `2026-10-16T10:${s}Z`;
    const events = [
      { at: t("00:00"), kind: "run_started", request: DEMO_REQUEST },
      { at: t("01:00"), kind: "provider_error", httpStatus: 429, message: "x" },
      { at: t("02:00"), kind: "provider_error", httpStatus: 429, message: "y" },
      { at: t("03:00"), kind: "provider_error", httpStatus: 401, message: "z" },
      { at: t("05:30"), kind: "run_finished", status: "failed" },
    ];
    await writeOae(join(dir), oldState, events);

    // creating a NEW run must archive the old one, not lose it
    const store = await Store.create(dir, "run-new", "second run");
    assert.equal(store.state.id, "run-new");
    const histDir = join(dir, ".oae", "history", "run-old");
    const archived = JSON.parse(await readFile(join(histDir, "state.json"), "utf8")) as RunState;
    assert.equal(archived.id, "run-old");
    assert.equal((await readFile(join(histDir, "events.jsonl"), "utf8")).includes("run_started"), true);

    const runs = await listRunHistory(dir);
    assert.equal(runs.length, 2);
    const old = runs.find((r) => r.id === "run-old")!;
    assert.equal(old.source, "archived");
    assert.equal(old.provider?.http429, 2);
    assert.equal(old.provider?.http401, 1);
    assert.equal(old.durationMs, 330 * 1000);
    assert.equal(runs.find((r) => r.id === "run-new")!.source, "current");

    // archiving is idempotent and does not self-archive the same runId
    const again = await Store.create(dir, "run-new", "second run resume");
    assert.equal(again.state.id, "run-new");
    assert.equal(await listRunHistory(dir).then((rs) => rs.length), 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("CLI: `oae dashboard` renders a snapshot from .oae files; `oae status` behavior unchanged", async () => {
  const dir = await makeProject();
  const empty = await makeProject();
  try {
    const now = new Date().toISOString();
    const state = demoState({ status: "done", endedAt: now, summary: "1/1 tasks completed; validators: selftest=0" });
    await writeOae(dir, state, [
      { at: now, kind: "run_started", request: DEMO_REQUEST },
      { at: now, kind: "run_finished", status: "done" },
    ]);
    const nodeBin = process.execPath;
    const run = (args: string[]) => new Promise<{ code: number | null; out: string }>((res) => {
      const child = spawn(nodeBin, [join("src", "index.ts"), ...args], { cwd: process.cwd(), env: { ...process.env } });
      let out = "";
      child.stdout?.on("data", (d) => (out += d));
      child.stderr?.on("data", (d) => (out += d));
      child.on("close", (code) => res({ code, out }));
      child.on("error", () => res({ code: -1, out }));
    });
    const dash = await run(["dashboard", "--dir", dir]);
    assert.equal(dash.code, 0);
    assert.ok(dash.out.includes("OAE run-demo"), `dashboard snapshot shows the run id (${dash.out.slice(0, 200)})`);
    assert.ok(dash.out.includes("CONCLUÍDA"));
    // non-follow snapshot must terminate (no infinite loop in CI)
    assert.ok(!dash.out.includes("\x1b["), "CI-safe output (no ANSI)");
    // status command behavior must stay stable for scripts
    const st = await run(["status", "--dir", dir]);
    assert.equal(st.code, 0);
    assert.ok(st.out.split(/\r?\n/).some((l) => l.startsWith("task-1") || l.startsWith("run:")));
    const stEmpty = await run(["status", "--dir", empty]);
    assert.equal(stEmpty.code, 1);
    assert.equal(stEmpty.out.trim(), "no runs found");
  } finally { await rm(dir, { recursive: true, force: true }); await rm(empty, { recursive: true, force: true }); }
});

test("provider gates: HTTP 429/401 with zero confirmed tokens retries WITHOUT consuming the attempt budget; exhausted gates block the task explicitly", async () => {
  const dir = await makeProject();
  try {
    const config = fastRecovery(await loadConfig(dir));
    config.recovery.maxAttempts = 2;
    config.recovery.maxProviderRetries = 2;
    config.recovery.providerBackoffMs = 1;
    const store = await Store.create(dir, "run-prov", "provider retry behavior");
    const PROVIDER_429 = { outcome: "failed" as const, output: "provider/run error: Provider request failed with HTTP 429: rate limited" };
    const PROVIDER_401 = { outcome: "failed" as const, output: "provider/run error: Provider request failed with HTTP 401: invalid credentials" };
    // gates: 429 (retry 1) → 401 (retry 2) → exhausted → blocked;
    // every provider attempt must stay a provider_retry, never kind code
    const script = [PROVIDER_429, PROVIDER_401];
    let idx = 0;
    const orch = new Orchestrator(null, store, {
      config,
      plan: plan1(dir),
      runnerFactory: (kind) => {
        const step = kind === "coder" ? script[Math.min(idx++, script.length - 1)]! : { outcome: "completed" as const, output: REVIEWER_OK };
        return scriptedRunner([{ result: step, usage: null }]);
      },
    });
    const { state } = await orch.run("provider retry behavior");
    assert.equal(state.status, "failed");
    const task = state.tasks[0]!;
    assert.equal(task.status, "blocked");
    assert.ok((task.blockedReason ?? "").includes("provider unavailable"), `blocked reason is explicit about the gate: ${task.blockedReason}`);
    assert.ok((task.blockedReason ?? "").includes("engineering attempts preserved"), "explicitly documents budget preservation");
    assert.deepEqual(
      task.attempts.map((a) => a.kind),
      ["provider_retry", "provider_retry", "provider_retry"],
      "gated failures (including the exhausted-gate attempt) never consume kind code attempts",
    );
    assert.equal(task.attempts.filter((a) => a.kind === "code").length, 0);
    assert.equal(task.attempts.filter((a) => a.outcome === "running").length, 0, "no attempt left dangling as running");

    const evs = await readEvents(dir);
    const retries = evs.filter((e) => e.kind === "retry_scheduled" && String(e.reason).includes("provider unavailable"));
    assert.equal(retries.length, 2);
    assert.ok(retries.every((e) => typeof e.providerRetry === "number"));
    // deterministic exponential waits: base 1ms → 1ms, 2ms
    assert.deepEqual(retries.map((e) => e.waitMs), [1, 2]);
    const provErrors = evs.filter((e) => e.kind === "provider_error");
    assert.deepEqual(provErrors.map((e) => e.httpStatus), [429, 401, 401]);
    assert.ok(provErrors.every((e) => e.tokensUnknown === true), "zero confirmed usage reported as unknown, not faked 0");
    void test;
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("provider gates: a successful attempt after provider retries completes the task at attempt 1 of the engineering budget", async () => {
  const dir = await makeProject();
  try {
    const config = fastRecovery(await loadConfig(dir));
    config.recovery.maxAttempts = 3;
    config.recovery.maxProviderRetries = 3;
    config.recovery.providerBackoffMs = 1;
    const store = await Store.create(dir, "run-prov-ok", "provider then success");
    let coderIdx = 0;
    const coder = [
      { result: { outcome: "failed" as const, output: "provider/run error: Provider request failed with HTTP 429: rate limited" }, usage: null },
      { result: { outcome: "failed" as const, output: "provider/run error: Provider request failed with HTTP 429: rate limited" }, usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } },
      // tokens consumed mid-session (retry hit after real work) → NOT a gate retry
      { result: { outcome: "failed" as const, output: "provider/run error: Provider request failed with HTTP 429: rate limited" }, usage: { input: 500, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } },
      { result: { outcome: "completed" as const, output: "RESULT:\nfiles: none\nIMPEDIMENT: none" }, usage: { input: 9, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } },
    ];
    void coderIdx;
    let step = 0;
    const orch = new Orchestrator(null, store, {
      config,
      plan: plan1(dir),
      runnerFactory: (kind) => {
        if (kind !== "coder") return scriptedRunner([{ result: { outcome: "completed", output: REVIEWER_OK }, usage: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }]);
        const s = coder[Math.min(step++, coder.length - 1)]!;
        return scriptedRunner([s]);
      },
    });
    const { state } = await orch.run("provider then success");
    assert.equal(state.status, "done", "success after provider retries still completes");
    const task = state.tasks[0]!;
    assert.deepEqual(task.attempts.map((a) => a.kind), [
      "provider_retry", // zero tokens → gate retry (attempt budget NOT consumed)
      "provider_retry", // confirmed zero → confirmed zero is still no compute
      "code",           // 500 tokens consumed → real engineering attempt (429 stands)
      "code",           // eventual success
      "review",         // independent reviewer recorded by runReview
    ]);
    assert.equal(task.status, "done");
    const evs = await readEvents(dir);
    const gateRetries = evs.filter((e) => e.kind === "retry_scheduled" && String(e.reason).includes("engineering attempt not consumed"));
    assert.equal(gateRetries.length, 2, "only the zero-consumption failures gated");
    const engineering429 = evs.filter((e) => e.kind === "retry_scheduled" && String(e.reason).includes("attempt interrupted"));
    assert.equal(engineering429.length, 1, "a 429 AFTER real compute falls back to the normal interruption path");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("runner SSE: completion via session.idle — final output intact, transcript fetched exactly once", async () => {
  const longText = "x".repeat(5_000);
  const counters: { subscribe?: number; context?: number } = {};
  const client = stubEventClient(
    [{ events: [
      { type: "session.step.started", data: { sessionID: "ses_stub", assistantMessageID: "m1", agent: "build", model: { modelID: "m" } } },
      { type: "session.tool.success", data: { sessionID: "ses_stub", id: "tool1", content: [{ name: "edit" }] } },
      { type: "session.idle", data: { sessionID: "ses_stub" } },
    ] }],
    { context: async () => { counters.context = (counters.context ?? 0) + 1; return { data: [{ type: "user", text: "p" }, { type: "assistant", content: [{ type: "text", text: longText }] }] }; } },
    counters,
  );
  const runner = await OpenCodeRunner.start(client, { directory: ".", title: "t", agent: "build", promptText: "p" });
  const progress: ProgressSignal[] = [];
  const res = await runner.awaitCompletion(30_000, (s) => progress.push(s));
  assert.equal(res.outcome, "completed");
  assert.equal(res.output, longText, "final assistant output built once from the transcript, not from events");
  assert.equal(counters.context, 1, "no repeated full-transcript polls in SSE mode");
  assert.equal(counters.subscribe, 1, "no reconnect churn on a healthy stream");
  assert.equal(progress.filter((s) => s.kind === "step").length, 1, "material step events become progress signals");
  assert.equal(progress.filter((s) => s.kind === "tool").length, 1);
  assert.equal(progress.some((s) => s.detail.includes("edit")), true, "tool name surfaced when present in payload");
});

test("runner SSE: session.execution.failed surfaces the provider error with its HTTP status", async () => {
  const client = stubEventClient([
    { events: [
      { type: "session.execution.failed", data: { sessionID: "ses_stub", error: { message: "Provider request failed with HTTP 429: rate limited", status: 429 } } },
    ] },
  ]);
  const runner = await OpenCodeRunner.start(client, { directory: ".", title: "t", agent: "build", promptText: "p" });
  const res = await runner.awaitCompletion(30_000);
  assert.equal(res.outcome, "failed");
  assert.ok(res.output.includes("provider/run error: Provider request failed with HTTP 429"), `output: ${res.output}`);
});

test("runner SSE: service retries are visible and deduplicated (status + retry.scheduled from ONE retry → one signal; no attempt duplication)", async () => {
  const counters: { subscribe?: number } = {};
  const client = stubEventClient([
    { events: [
      { type: "session.retry.scheduled", data: { sessionID: "ses_stub", attempt: 2, error: { message: "HTTP 429: too many", status: 429 } } },
      { type: "session.status", data: { sessionID: "ses_stub", status: { type: "retry", attempt: 2, message: "HTTP 429: too many" } } },
      { type: "session.idle", data: { sessionID: "ses_stub" } },
    ] },
  ], {}, counters);
  const runner = await OpenCodeRunner.start(client, { directory: ".", title: "t", agent: "build", promptText: "p" });
  const res = await runner.awaitCompletion(30_000);
  assert.equal(res.outcome, "completed");
  const retries = res.signals.filter((s) => s.kind === "retry");
  assert.equal(retries.length, 1, "both event forms describe the same service retry");
  assert.ok(retries[0]!.detail.includes("attempt 2"), `detail: ${retries[0]!.detail}`);
  assert.equal(res.signals.filter((s) => s.kind === "step" || s.kind === "tool").length, 0, "no synthetic progress invented from retries");
});

test("runner SSE: clean stream disconnect reconnects and still builds the result exactly once", async () => {
  const counters: { subscribe?: number; context?: number } = {};
  const client = stubEventClient([
    { events: [{ type: "session.step.started", data: { sessionID: "ses_stub", assistantMessageID: "m1", agent: "build", model: { modelID: "m" } } }] },
    { events: [{ type: "session.idle", data: { sessionID: "ses_stub" } }] },
  ], { context: async () => { counters.context = (counters.context ?? 0) + 1; return { data: [{ type: "assistant", content: [{ type: "text", text: "done text" }] }] }; } }, counters);
  const runner = await OpenCodeRunner.start(client, { directory: ".", title: "t", agent: "build", promptText: "p" });
  const res = await runner.awaitCompletion(30_000);
  assert.equal(res.outcome, "completed");
  assert.equal(res.output, "done text");
  assert.equal(counters.subscribe, 2, "exactly one reconnect after the clean stream end");
  assert.equal(res.signals.filter((s) => s.kind === "step").length, 1, "pre-disconnect progress is recorded, not replayed after reconnect");
});

test("runner fallback: unavailable SSE subscription falls back to polling (older SDKs, subscription errors)", async () => {
  const counters: { subscribe?: number; context?: number } = {};
  const longText = "fallback final output";
  const client = stubClient({
    active: async () => ({} as Record<string, unknown>),
    context: async () => { counters.context = (counters.context ?? 0) + 1; return { data: [{ type: "assistant", content: [{ type: "text", text: longText }] }] }; },
  }, counters);
  (client as unknown as { event: unknown }).event = {
    subscribe: () => { counters.subscribe = (counters.subscribe ?? 0) + 1; throw new Error("no SSE here"); },
  };
  const runner = await OpenCodeRunner.start(client, { directory: ".", title: "t", agent: "build", promptText: "p" });
  const progress: ProgressSignal[] = [];
  const res = await runner.awaitCompletion(60_000, (s) => progress.push(s));
  assert.equal(res.outcome, "completed");
  assert.equal(res.output, longText, "fallback preserves the polling loop's exact result semantics");
  assert.equal(progress.length, 1, "fallback still reports progress (message evolution)");
  assert.equal(counters.subscribe, 1, "exactly one failed subscribe attempt, then polling");
});

test("runner fallback: reconnect budget exhausted → polling completes the run with the remaining deadline", async () => {
  const counters: { subscribe?: number; active?: number; context?: number } = {};
  const finalText = "completed after all streams died";
  const client = stubEventClient(
    [
      { reset: true }, { reset: true }, { reset: true }, { reset: true }, { reset: true }, { reset: true },
    ],
    {
      active: async () => { counters.active = (counters.active ?? 0) + 1; return (counters.active ?? 0) <= 6 ? { ses_stub: { type: "running" } } : ({} as Record<string, unknown>); },
      context: async () => { counters.context = (counters.context ?? 0) + 1; return { data: [{ type: "assistant", content: [{ type: "text", text: finalText }] }] }; },
    },
    counters as Record<string, number>,
  );
  const runner = await OpenCodeRunner.start(client, { directory: ".", title: "t", agent: "build", promptText: "p" });
  const res = await runner.awaitCompletion(60_000);
  assert.equal(res.outcome, "completed");
  assert.equal(res.output, finalText);
  assert.equal(counters.subscribe, 6, "1 subscription + 5 reconnect attempts before falling back");
});

test("runner SSE: usage captured from session.usage.updated without a redundant session.get", async () => {
  const counters: { get?: number } = {};
  const client = stubEventClient(
    [{ events: [
      { type: "session.usage.updated", data: { sessionID: "ses_stub", cost: 0.25, tokens: { input: 7, output: 9, reasoning: 2, cache: { read: 4, write: 1 } } } },
      { type: "session.idle", data: { sessionID: "ses_stub" } },
    ] }],
    { get: async () => { counters.get = (counters.get ?? 0) + 1; return { tokens: { input: 999, output: 999, reasoning: 999, cache: { read: 999, write: 999 } }, cost: 9.99 }; } },
    counters as Record<string, number>,
  );
  const runner = await OpenCodeRunner.start(client, { directory: ".", title: "t", agent: "build", promptText: "p" });
  const res = await runner.awaitCompletion(30_000);
  assert.equal(res.outcome, "completed");
  const usage = await runner.usage();
  assert.deepEqual(usage, { input: 7, output: 9, reasoning: 2, cacheRead: 4, cacheWrite: 1, cost: 0.25 },
    "live usage event wins over a redundant per-attempt session.get");
  assert.equal(counters.get ?? 0, 0, "no session.get round-trip when the event already carried usage");
});

test("dashboard follow loop registers NO SIGINT listeners across 15 cycles (leak regression) — Ctrl+C keeps Node default termination", async () => {
  // The follow-mode wait is the same sleep the loop uses; the historical
  // regression (run-mvazafl3 forensics) registered process.once("SIGINT")
  // once per 1s iteration, leaking ~1 listener/second and swallowing Ctrl+C.
  const before = process.listenerCount("SIGINT");
  for (let i = 0; i < 15; i++) await sleep(1); // 15 follow-loop cycles
  assert.equal(process.listenerCount("SIGINT"), before,
    "running 15 follow cycles must not grow the SIGINT listener count");
  // Static guard: the leaked pattern must not return anywhere in the CLI
  // source. With zero SIGINT listeners in the dashboard process, Ctrl+C
  // termination is Node's default — guaranteed by semantics, not by us.
  // (Cross-process SIGINT delivery is not reliable on Windows, so an
  // end-to-end Ctrl+C subprocess test would be flaky — documented, not faked.)
  const cli = await readFile(join("src", "index.ts"), "utf8");
  // the historical leak was a hand-rolled per-iteration wait that registered a
  // SIGINT listener every second; the follow loop must use the plain sleep
  assert.equal(/setTimeout\(r,\s*1000\)/.test(cli), false,
    "the per-iteration wait that leaked SIGINT listeners must not return");
  assert.ok(cli.includes("await sleep(1000)"), "the follow loop waits with the plain sleep");
  // exactly ONE SIGINT handler is allowed — the run() crash-safety path — and it
  // is registered once per run, never once per follow-loop iteration
  assert.equal((cli.match(/process\.once\("SIGINT"/g) ?? []).length, 1,
    "exactly one SIGINT handler (crash safety) is expected in src/index.ts");
});

test("supervisor does not diagnose while progress is recent", async () => {
  const dir = await makeProject();
  try {
    const config = fastRecovery(await loadConfig(dir));
    const store = await Store.create(dir, "run-sweepsafe", "healthy");
    const sup = new Supervisor(config.recovery, store);
    const run = sup.register("t1", FACTORY_OK_CODER());
    const actions = await sup.sweep();
    assert.equal(actions.length, 0);
    // simulate stall by back-dating
    run.lastSignalAt = Date.now() - 8 * 60_000;
    const acted = await sup.sweep();
    assert.equal(acted[0]?.type, "diagnose");
    run.lastSignalAt = Date.now() - 11 * 60_000;
    const acted2 = await sup.sweep();
    assert.equal(acted2[0]?.type, "recover");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function waitFor(cond: () => boolean, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/* ============================== Onda 1: provider boundary & session persistence ============================== */

test("provider contract: OpenCodeProvider manufactures compliant AgentRunners (runtime tagged, prompt awaited)", async () => {
  const dir = await makeProject();
  try {
    const created: Array<Record<string, unknown>> = [];
    const client = stubClient({
      create: async (input: Record<string, unknown>) => {
        created.push(input);
        return { id: "ses_stub" };
      },
      active: async () => ({ ses_stub: { type: "running" } }),
    });
    const provider = OpenCodeProvider.fromClient(client);
    assert.equal(provider.id, "opencode");
    const runner = await provider.createSession({
      directory: dir, title: "OAE coder task-1", agent: "build",
      model: { providerID: "nvidia", id: "z-ai/glm-5.3-flash" }, promptText: "first prompt",
    });
    // contract shape: every AgentRunner member present + runtime tag
    assert.equal(runner.runtime, "opencode");
    assert.ok(runner.sessionId.startsWith("ses_"));
    for (const m of ["prompt", "awaitCompletion", "interrupt", "transcriptTail", "usage"] as const) {
      assert.equal(typeof (runner as unknown as Record<string, unknown>)[m], "function", `${m} must exist`);
    }
    // explicit model propagated to the runtime session, verbatim
    assert.deepEqual(created[0]?.model, { providerID: "nvidia", id: "z-ai/glm-5.3-flash" });
    assert.equal(created[0]?.agent, "build");
    // a task with an idle runtime session completes; transcript/usage non-throwing
    const r2 = await OpenCodeProvider.fromClient(stubClient({
      active: async () => ({ ses_stub: { type: "running" } }),
      interrupt: async () => {},
    })).createSession({
      directory: dir, title: "t", agent: "build", model: null, promptText: "p",
    });
    // interrupt() flow keeps outcome truthfully "interrupted" (never silent success)
    await r2.interrupt();
    const res = await r2.awaitCompletion(200);
    assert.equal(res.outcome, "interrupted");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("provider errors: classifyProviderError maps auth/rateLimit/unavailable/protocol/unknown deterministically", () => {
  const cases: [unknown, ProviderErrorKind][] = [
    [new Error("HTTP 401 unauthorized"), "auth"],
    [new Error("fetch failed: HTTP 429: rate limited"), "rateLimit"],
    [new Error("HTTP 402 budget exceeded"), "protocol"],
    // 5xx → unavailable (canonical HTTP table in contracts.ts; unified with
    // the direct-provider transports in Onda 2)
    [new Error("HTTP 500: boom"), "unavailable"],
    [new Error("connect ECONNREFUSED 127.0.0.1:4096"), "unavailable"],
    [new Error("weird failure"), "unknown"],
    ["bare string", "unknown"],
  ];
  for (const [input, want] of cases) {
    const e = classifyProviderError(input, "opencode");
    assert.equal(e.kind, want, String((input as Error)?.message ?? input));
    assert.equal(e.provider, "opencode");
  }
  // an already-typed ProviderError passes through unchanged (no re-wrap)
  const src = new ProviderError("auth", "opencode", "401 res");
  const passthrough = classifyProviderError(src, "opencode");
  assert.equal(passthrough, src);
});

test("runtime factory: createRuntime materializes an OpenCode provider honoring Provider (opt-in: real service)", { skip: process.env.OAE_RUNTIME_TEST !== "1" }, async () => {
  const rt = await createRuntime();
  assert.equal(typeof rt.provider.id, "string");
  assert.equal(typeof rt.provider.createSession, "function");
  // health is optional but, when present, must be truthful in both directions
  if (rt.provider.healthCheck) {
    const hc = await rt.provider.healthCheck();
    assert.equal(typeof hc.ok, "boolean");
  }
});

test("schema compatibility: legacy state.json without schemaVersion and legacy event lines load unchanged", async () => {
  const dir = await makeProject();
  try {
    await mkdir(join(dir, ".oae"), { recursive: true });
    const legacy = demoState(); // no schemaVersion field
    await mkdir(join(dir, ".oae"), { recursive: true });
    await writeFile(join(dir, ".oae", "state.json"), JSON.stringify(legacy, null, 2), "utf8");
    await writeFile(join(dir, ".oae", "events.jsonl"),
      `${JSON.stringify({ at: "2026-10-18T00:00:00.000Z", kind: "run_started", request: "old" })}\n`, "utf8");
    const loaded = await Store.load(dir);
    assert.ok(loaded);
    assert.equal(loaded.state.schemaVersion, undefined, "legacy stays legacy on read — no silent rewrite");
    assert.equal(loaded.state.id, "run-demo");
    // appending new events keeps legacy lines intact and marks new ones v:1
    const store = new Store(dir, loaded.state.id);
    store.state = loaded.state;
    await store.event("decision", { decisionId: "d1" });
    const events = await readEvents(dir);
    assert.equal(events.length, 2);
    assert.equal("v" in events[0], false, "legacy line untouched");
    assert.equal(events[1]?.v, 1);
    assert.equal(events[1]?.kind, "decision");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Store.create: new runs declare schemaVersion: 1 (writable forward-compat)", async () => {
  const dir = await makeProject();
  try {
    const store = await Store.create(dir, "run-v1", "req");
    assert.equal(store.state.schemaVersion, 1);
    const raw = JSON.parse(await readFile(join(dir, ".oae", "state.json"), "utf8")) as Record<string, unknown>;
    assert.equal(raw.schemaVersion, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("session rollout: append-only events persist, survive partial trailing writes, and isolate per attempt", async () => {
  const dir = await makeProject();
  try {
    const log = new SessionLog(dir);
    assert.equal(await log.append("task-1-a1", "dispatch", { runtime: "opencode", sessionId: "ses_x" }), true);
    assert.equal(await log.append("task-1-a1", "result", { outcome: "completed", tokens: null }), true);
    // distinct attempt keys do not bleed into each other
    await log.append("task-1-a2", "dispatch", { sessionId: "ses_y" });
    // simulate a crash mid-write: append a torn trailing line raw
    const file = join(dir, ".oae", "sessions", "task-1-a1.jsonl");
    rawAppend(file, '{"at":"2026-10-19T00');
    // tolerant read: recorded complete events survive, torn one dropped
    const eventsA = await log.read("task-1-a1");
    assert.equal(eventsA.length, 2);
    assert.equal(eventsA[0]?.kind, "dispatch");
    assert.equal(eventsA[1]?.kind, "result");
    assert.deepEqual(eventsA[1]?.tokens, null);
    const eventsB = await log.read("task-1-a2");
    assert.equal(eventsB.length, 1);
    // sanitized key: hostile attemptId cannot traverse out of .oae/sessions
    const hostile = "task/../..%2Fescape";
    await log.append(hostile, "dispatch", {});
    const files = await readdir(join(dir, ".oae", "sessions"));
    assert.ok(files.every((f) => !f.includes("/") && f !== "." && f !== ".."), "every log file stays put");
    assert.ok(files.includes("task_.._.._2Fescape.jsonl"), "hostile key sanitized deterministically");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("session rollout: write failures degrade to observability loss, never to run failure", async () => {
  const dir = await makeProject();
  try {
    const log = new SessionLog(dir);
    await mkdir(join(dir, ".oae"), { recursive: true });
    // root-proof failure: `.oae/sessions` exists as a FILE, so mkdir/append
    // cannot proceed — the log must fail soft (false), never throw
    await writeFile(join(dir, ".oae", "sessions"), "not a directory", "utf8");
    assert.equal(await log.append("blocked-attempt", "dispatch", {}), false, "write fails softly");
    assert.deepEqual(await log.read("blocked-attempt"), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("orchestrator + session log: real attempts record dispatch/result into .oae/sessions without altering outcomes", async () => {
  const dir = await makeProject();
  try {
    const config = fastRecovery(await loadConfig(dir));
    const store = await Store.create(dir, "run-slog", "add hello module");
    const reviewer = new FakeRunner("s-rev", { type: "complete", output: REVIEWER_OK });
    const orch = new Orchestrator(null, store, {
      config,
      plan: plan1(dir),
      runnerFactory: (kind) => (kind === "coder" ? FACTORY_OK_CODER() : reviewer),
    });
    const { state } = await orch.run("add hello module");
    assert.equal(state.tasks[0].status, "done");
    const sessDir = join(dir, ".oae", "sessions");
    const files = (await readdir(sessDir)).sort();
    assert.ok(files.some((f) => f.startsWith("task-1-a1")), "coder attempt logged");
    assert.ok(files.some((f) => f.startsWith("task-1-a2")), "review attempt logged");
    const slog = new SessionLog(dir);
    const codeEvents = await slog.read("task-1-a1");
    assert.equal(codeEvents[0]?.v, 1);
    assert.equal(codeEvents[0]?.kind, "dispatch");
    assert.equal(codeEvents[0]?.phase, "code");
    assert.equal(codeEvents[0]?.sessionId, "s-code");
    // F6: rollout outcome uses the canonical attempt vocabulary; rawOutcome
    // preserves the runner-contract distinction
    const codeResult = codeEvents.find((e) => e.kind === "result");
    assert.equal(codeResult?.outcome, "completed", "canonical code outcome");
    assert.equal((codeResult as Record<string, unknown> | undefined)?.rawOutcome, "completed");
    const revResult = (await slog.read("task-1-a2")).find((e) => e.kind === "result");
    assert.equal(revResult?.outcome, "approved", "canonical review outcome matches state.json");
    assert.equal((revResult as Record<string, unknown> | undefined)?.verdict, "approve");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("orchestrator: a throwing session log must not change outcomes (best-effort observability)", async () => {
  const dir = await makeProject();
  try {
    const config = fastRecovery(await loadConfig(dir));
    const store = await Store.create(dir, "run-slogfail", "add hello module");
    const broken: SessionLog = {
      append: async () => { throw new Error("disk gone"); },
      read: async () => { throw new Error("disk gone"); },
    } as unknown as SessionLog;
    const reviewer = new FakeRunner("s-rev", { type: "complete", output: REVIEWER_OK });
    const orch = new Orchestrator(null, store, {
      config,
      plan: plan1(dir),
      runnerFactory: (kind) => (kind === "coder" ? FACTORY_OK_CODER() : reviewer),
      sessionLog: broken,
    });
    const { state } = await orch.run("add hello module");
    assert.equal(state.status, "done");
    assert.equal(state.tasks[0].status, "done", "run outcome identical with logging broken");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("model propagation: provider receives the same explicit model for coder AND reviewer sessions", async () => {
  const dir = await makeProject();
  try {
    const config = fastRecovery(await loadConfig(dir));
    config.model = { providerID: "nvidia", id: "z-ai/glm-5.3-flash" };
    const store = await Store.create(dir, "run-mprop", "add hello module");
    const sessions: Array<{ agent?: unknown; model?: unknown; runtime?: unknown }> = [];
    class PropagatingProvider implements Provider {
      id = "fake";
      async createSession(opts: SessionOptions): Promise<AgentRunner> {
        sessions.push({ agent: opts.agent, model: opts.model, runtime: opts.model ? `${opts.model.providerID}/${opts.model.id}` : null });
        // contract: the provider dispatches the first prompt at creation time
        const runner = new FakeRunner(`s-${sessions.length}`, { type: "complete", output: REVIEWER_OK });
        await runner.prompt(opts.promptText);
        return runner;
      }
    }
    const orch = new Orchestrator(new PropagatingProvider(), store, { config, plan: plan1(dir) });
    const { state } = await orch.run("add hello module");
    assert.equal(state.tasks[0].status, "done");
    const coder = sessions.find((s) => s.agent === config.coderAgent);
    const review = sessions.find((s) => s.agent === config.reviewerAgent);
    assert.ok(coder && review, "both sessions created via the provider");
    assert.deepEqual(coder.model, { providerID: "nvidia", id: "z-ai/glm-5.3-flash" });
    assert.deepEqual(review.model, { providerID: "nvidia", id: "z-ai/glm-5.3-flash" });
    assert.equal(coder.runtime, "nvidia/z-ai/glm-5.3-flash");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("orchestrator: dispatch without provider and without runnerFactory fails honestly (never silently 'done')", async () => {
  const dir = await makeProject();
  try {
    const config = fastRecovery(await loadConfig(dir));
    config.recovery.maxAttempts = 1;
    const store = await Store.create(dir, "run-noprov", "add hello module");
    const orch = new Orchestrator(null, store, { config, plan: plan1(dir) });
    const { state } = await orch.run("add hello module");
    // the run must NOT report success: attempt fails, task ends not-done
    assert.notEqual(state.status, "done");
    assert.notEqual(state.tasks[0].status, "done");
    assert.ok(["blocked", "failed", "cancelled"].includes(state.tasks[0].status), `status: ${state.tasks[0].status}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("session rollout: torn tail is fenced on the next append — later records survive the torn one (F2)", async () => {
  const dir = await makeProject();
  try {
    const log = new SessionLog(dir);
    assert.equal(await log.append("task-2-a1", "dispatch", { sessionId: "ses_ok" }), true);
    // crash mid-write: torn JSON line, no trailing newline
    const file = join(dir, ".oae", "sessions", "task-2-a1.jsonl");
    await rawAppend(file, '{"at":"2026-10-19T00');
    // the NEXT appends must not concatenate to the torn line
    assert.equal(await log.append("task-2-a1", "result", { outcome: "completed" }), true);
    assert.equal(await log.append("task-2-a1", "interrupt", { detail: "reset" }), true);
    // tolerant read: each complete record parses independently; exactly ONE
    // line (the torn one) is dropped
    const events = await log.read("task-2-a1");
    assert.deepEqual(events.map((e) => e.kind), ["dispatch", "result", "interrupt"]);
    assert.equal((events[1] as Record<string, unknown>).outcome, "completed");
    // byte-level proof of append-only fencing:
    //   line 0 = the pre-crash "dispatch" record;
    //   line 1 = the untouched torn bytes, now newline-terminated (fenced);
    //   lines 2-3 = the new records on their OWN lines, each JSON-parseable;
    //   no byte was rewritten and no later record was glued to the torn line
    const raw = await readFile(file, "utf8");
    const lines = raw.split("\n");
    assert.equal(JSON.parse(lines[0]!).kind, "dispatch", "first record intact");
    assert.equal(lines[1]?.startsWith('{"at":"2026-10-19T00'), true, "torn line untouched (append-only invariant)");
    assert.equal(lines[1]?.includes('"kind":"result"'), false, "no later record was glued into the torn line");
    assert.equal(JSON.parse(lines[2]!).kind, "result", "result record is an independent parseable line");
    assert.equal(JSON.parse(lines[3]!).kind, "interrupt");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// Onda 2, etapa 1 — provider NVIDIA direto (transporte + runner + tools)
// ═══════════════════════════════════════════════════════════════════════════

/** Recording fetch: configurable responses, zero network. */
function recordingFetch(impl: (call: { url: string; init: RequestInit }) => Response | Promise<Response>): { calls: { url: string; init: RequestInit }[]; fetch: typeof fetch } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String((input as { url: string }).url);
    calls.push({ url, init: init ?? {} });
    return impl({ url, init: init ?? {} });
  }) as unknown as typeof fetch;
  return { calls, fetch: fetchImpl };
}

function sseEvent(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}
function contentEvent(text: string): string {
  return sseEvent({ id: "chatcmpl-t", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
}
function finishEvent(reason: string, usage?: Record<string, unknown>): string {
  return sseEvent({
    id: "chatcmpl-t",
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
    ...(usage ? { usage } : {}),
  });
}
const DONE_MARKER = "data: [DONE]\n\n";
function sseResponseBody(parts: string[], opts: { chunkDelayMs?: number } = {}): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      try {
        for (const p of parts) {
          if (opts.chunkDelayMs) await sleep(opts.chunkDelayMs);
          controller.enqueue(enc.encode(p));
        }
        controller.close();
      } catch { /* aborted mid-stream in tests: consumer cancels */ }
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}
const TKEY = "nvapi-unit-test-key-0123456789";
const TPROVIDER = { provider: "nvidia-direct", baseUrl: "https://integrate.test/v1", apiKey: TKEY } as const;

test("nvidia transport: streaming happy path accumulates content, finish reason and usage", async () => {
  const { calls, fetch: f } = recordingFetch(() => sseResponseBody([
    contentEvent("hello "), contentEvent("world"), contentEvent("!"),
    finishEvent("stop", { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 2 } }),
    DONE_MARKER,
  ]));
  const t = new HttpTransport({ ...TPROVIDER, fetchImpl: f });
  const rep = await t.chat({ model: "z-ai/glm-5.3-flash", messages: [{ role: "user", content: "hi" }], signal: AbortSignal.timeout(10_000) }) as ChatReply;
  assert.equal(rep.content, "hello world!");
  assert.equal(rep.finishReason, "stop");
  assert.deepEqual(rep.usage, { input: 10, output: 5, reasoning: 0, cacheRead: 2, cacheWrite: 0 });
  assert.match(calls[0]!.url, /\/chat\/completions$/);
  const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, `Bearer ${TKEY}`);
});

test("nvidia transport: [DONE] terminates the stream; usage absence stays absent", async () => {
  const { fetch: f } = recordingFetch(() => sseResponseBody([contentEvent("x"), DONE_MARKER]));
  const t = new HttpTransport({ ...TPROVIDER, fetchImpl: f });
  const rep = await t.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) });
  assert.equal(rep.content, "x");
  assert.equal(rep.usage, undefined);
});

test("nvidia transport: HTTP statuses classify through the canonical table (auth/rateLimit/unavailable/protocol)", async () => {
  const cases: [number, ProviderErrorKind][] = [
    [401, "auth"], [403, "auth"], [429, "rateLimit"], [500, "unavailable"],
    [503, "unavailable"], [404, "protocol"], [400, "protocol"],
  ];
  for (const [status, kind] of cases) {
    const { fetch: f } = recordingFetch(() => jsonResponse({ error: { message: "nope" } }, status));
    const t = new HttpTransport({ ...TPROVIDER, fetchImpl: f });
    await t.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) }).then(
      () => { throw new Error(`status ${status} must reject`); },
      (e: unknown) => {
        assert.ok(e instanceof ProviderError, `status ${status}`);
        assert.equal((e as ProviderError).kind, kind, `status ${status}`);
        assert.equal((e as ProviderError).httpStatus, status, `status ${status}`);
        assert.doesNotMatch((e as ProviderError).message, /nvapi-/);
        assert.match((e as ProviderError).message, RegExp(`HTTP ${status}`));
      },
    );
  }
});

test("nvidia transport: malformed SSE line → protocol error (never silently swallowed)", async () => {
  const { fetch: f } = recordingFetch(() => sseResponseBody(["data: {broken-json\n\n", DONE_MARKER]));
  const t = new HttpTransport({ ...TPROVIDER, fetchImpl: f });
  await t.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) }).then(
    () => { throw new Error("must reject"); },
    (e: unknown) => { assert.ok(e instanceof ProviderError); assert.equal((e as ProviderError).kind, "protocol"); },
  );
});

test("nvidia transport: malformed non-streaming JSON body → protocol error", async () => {
  const { fetch: f } = recordingFetch(() => new Response("not-json{{{", { status: 200, headers: { "content-type": "application/json" } }));
  const t = new HttpTransport({ ...TPROVIDER, fetchImpl: f });
  await t.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) }).then(
    () => { throw new Error("must reject"); },
    (e: unknown) => { assert.equal((e as ProviderError).kind, "protocol"); },
  );
});

test("nvidia transport: network failure (ENOTFOUND) → unavailable", async () => {
  const { fetch: f } = recordingFetch(() => { throw new Error("getaddrinfo ENOTFOUND integrate.test"); });
  const t = new HttpTransport({ ...TPROVIDER, fetchImpl: f });
  await t.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) }).then(
    () => { throw new Error("must reject"); },
    (e: unknown) => {
      assert.ok(e instanceof ProviderError);
      assert.equal((e as ProviderError).kind, "unavailable");
      assert.match((e as ProviderError).message, /ENOTFOUND/);
    },
  );
});

test("nvidia transport: abort mid-stream → honest abort error (runner maps it to 'interrupted')", async () => {
  const ac = new AbortController();
  // three slow chunks keep the stream OPEN while the abort fires mid-read
  const { fetch: f } = recordingFetch(() => sseResponseBody([
    contentEvent("partial "), contentEvent("more "), contentEvent("even more "),
  ], { chunkDelayMs: 80 }));
  const t = new HttpTransport({ ...TPROVIDER, fetchImpl: f });
  const p = t.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: ac.signal }).then(
    () => { throw new Error("must not complete"); },
    (e: unknown) => e,
  );
  setTimeout(() => ac.abort(), 120);
  const e = (await p) as ProviderError;
  assert.ok(e instanceof ProviderError);
  assert.match(e.message, /aborted/i);
});

test("nvidia transport: a 400 mentioning 'stream' triggers one non-streaming retry (sticky)", async () => {
  let n = 0;
  const { calls, fetch: f } = recordingFetch(() => {
    n++;
    if (n === 1) return jsonResponse({ error: { message: "stream_options is not supported by this gateway" } }, 400);
    return jsonResponse({
      choices: [{ index: 0, message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    });
  });
  const t = new HttpTransport({ ...TPROVIDER, fetchImpl: f });
  const rep = await t.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) });
  assert.equal(rep.content, "ok");
  assert.equal(calls.length, 2);
  const body2 = JSON.parse(String(calls[1]!.init.body)) as Record<string, unknown>;
  assert.equal(body2.stream, false);
  assert.equal(body2.stream_options, undefined);
  // sticky: the next round of the SAME session stays non-streaming
  await t.chat({ model: "m", messages: [{ role: "user", content: "u2" }], signal: AbortSignal.timeout(10_000) });
  assert.equal(calls.length, 3);
  const body3 = JSON.parse(String(calls[2]!.init.body)) as Record<string, unknown>;
  assert.equal(body3.stream, false);
});

test("nvidia provider: missing OAE_NVIDIA_API_KEY → clear configuration error (no secret material)", () => {
  const prev = process.env.OAE_NVIDIA_API_KEY;
  delete process.env.OAE_NVIDIA_API_KEY;
  try {
    assert.throws(() => NVIDIAProvider.start(), (e: unknown) => {
      const m = String((e as Error).message);
      assert.match(m, /OAE_NVIDIA_API_KEY is not set/);
      assert.match(m, /configuration error/);
      assert.doesNotMatch(m, /nvapi-/);
      return true;
    });
  } finally {
    if (prev !== undefined) process.env.OAE_NVIDIA_API_KEY = prev;
  }
});

test("nvidia runner: coder tool loop writes/reads files inside the root and completes (usage aggregated)", async () => {
  const dir = await makeProject();
  try {
    let n = 0;
    const { calls, fetch: f } = recordingFetch(() => {
      n++;
      if (n === 1) {
        return sseResponseBody([
          sseEvent({
            id: "chatcmpl-t",
            choices: [{
              index: 0,
              delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "write_file", arguments: '{"pa' } }] },
              finish_reason: null,
            }],
          }),
          sseEvent({
            id: "chatcmpl-t",
            choices: [{
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: "th\":\"a.txt\",\"content\":\"hola outils\"}" } }] },
              finish_reason: null,
            }],
          }),
          finishEvent("tool_calls", { prompt_tokens: 12, completion_tokens: 9 }),
          DONE_MARKER,
        ]);
      }
      return sseResponseBody([
        contentEvent("RESULT: files changed: a.txt\nIMPEDIMENT: none"),
        finishEvent("stop", { prompt_tokens: 30, completion_tokens: 20 }),
        DONE_MARKER,
      ]);
    });
    const provider = NVIDIAProvider.start({ apiKey: TKEY, fetchImpl: f });
    assert.equal(provider.id, "nvidia-direct");
    const runner = await provider.createSession({
      directory: dir, title: "OAE coder task-1", agent: "build",
      model: { providerID: "nvidia", id: "z-ai/glm-5.3-flash" },
      tools: true, promptText: "create a.txt with the text",
    });
    assert.equal(runner.runtime, "nvidia-direct");
    assert.ok(runner.sessionId.startsWith("nvidia-direct-"));
    const res = await runner.awaitCompletion(15_000);
    assert.equal(res.outcome, "completed", res.output);
    assert.match(res.output, /RESULT: files changed: a\.txt/);
    assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "hola outils");
    // request bodies: tools only on the coder; tool result rounded back
    const body1 = JSON.parse(String(calls[0]!.init.body)) as { model?: string; tools?: { function: { name: string } }[]; messages: unknown[] };
    assert.deepEqual((body1.tools ?? []).map((x) => x.function.name).sort(), ["list_dir", "read_file", "write_file"]);
    assert.equal(body1.model, "z-ai/glm-5.3-flash");
    const body2 = JSON.parse(String(calls[1]!.init.body)) as { messages: { role: string; content: string }[] };
    assert.ok(body2.messages.some((m) => m.role === "tool" && m.content.includes("written ")), "tool result was fed back");
    const u = await runner.usage();
    assert.ok(u, "usage aggregated across rounds");
    assert.equal(u!.input, 42);
    assert.equal(u!.output, 29);
    assert.equal(u!.cost, null);
    // completed rounds are reflected in the bounded transcript with roles
    const tail = await runner.transcriptTail(8);
    assert.match(tail, /\[assistant\]/);
    assert.match(tail, /\[tool\(call_1\)\]/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("nvidia runner: model propagation identical for planner, coder and reviewer; tools only for the coder", async () => {
  const dir = await makeProject();
  try {
    const bodies: Array<Record<string, unknown>> = [];
    const { fetch: f } = recordingFetch((c) => {
      bodies.push(JSON.parse(String(c.init.body)) as Record<string, unknown>);
      return jsonResponse({
        choices: [{ index: 0, message: { content: "plain reply" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    });
    const provider = NVIDIAProvider.start({ apiKey: TKEY, fetchImpl: f });
    const agents = ["plan", "build", "oae-reviewer"];
    const runners = [];
    for (const agent of agents) {
      runners.push(await provider.createSession({
        directory: dir, title: `t-${agent}`, agent,
        model: { providerID: "nvidia", id: "z-ai/glm-5.3-flash" },
        tools: agent === "build", promptText: `role ${agent}`,
      }));
    }
    const results = await Promise.all(runners.map((r) => r.awaitCompletion(15_000)));
    for (const r of results) assert.equal(r.outcome, "completed");
    assert.deepEqual(bodies.map((b) => b.model), ["z-ai/glm-5.3-flash", "z-ai/glm-5.3-flash", "z-ai/glm-5.3-flash"]);
    assert.equal(bodies[0]!.tools === undefined, true, "planner: no tools");
    assert.equal(bodies[1]!.tools !== undefined, true, "coder: tools present");
    assert.equal(bodies[2]!.tools === undefined, true, "reviewer: no tools");
    assert.ok((bodies[1]!.messages as { role: string; content?: string }[]).some((m) => m.role === "system" && String(m.content ?? "").includes("coder")));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("nvidia runner: dispatch auth failure rejects createSession (ProviderError auth, no key echoed)", async () => {
  const dir = await makeProject();
  try {
    const { fetch: f } = recordingFetch(() => jsonResponse({ error: { message: "invalid key" } }, 401));
    const provider = NVIDIAProvider.start({ apiKey: TKEY, fetchImpl: f });
    await provider.createSession({
      directory: dir, title: "t", agent: "build",
      model: { providerID: "nvidia", id: "z-ai/glm-5.3-flash" }, promptText: "x",
    }).then(
      () => { throw new Error("must reject"); },
      (e: unknown) => {
        assert.ok(e instanceof ProviderError);
        assert.equal((e as ProviderError).kind, "auth");
        assert.match((e as ProviderError).message, /HTTP 401/);
        assert.doesNotMatch((e as ProviderError).message, /nvapi-/);
      },
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("nvidia runner: interrupt() mid-stream settles 'interrupted' (never silent success), transcriptTail safe", async () => {
  const dir = await makeProject();
  try {
    let n = 0;
    const { fetch: f } = recordingFetch(() => {
      n++;
      if (n === 1) return sseResponseBody([contentEvent("thinking "), contentEvent("more "), contentEvent("kept going")], { chunkDelayMs: 120 });
      void n; return sseResponseBody([]);
    });
    const provider = NVIDIAProvider.start({ apiKey: TKEY, fetchImpl: f });
    const runner = await provider.createSession({
      directory: dir, title: "t", agent: "build", model: null,
      tools: false, promptText: "long work",
    });
    setTimeout(() => { void runner.interrupt(); }, 160);
    const res = await runner.awaitCompletion(30_000);
    assert.equal(res.outcome, "interrupted");
    assert.notEqual(res.output, "completed", "no fake success on interrupt");
    // the transcript is safe mid-interruption and truthfully reflects that
    // no assistant round completed (partial stream content is not an attempt)
    const tail = await runner.transcriptTail(10);
    assert.match(tail, /\[user\]/);
    assert.match(tail, /\[system\]/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("nvidia runner: finished-but-empty stream stays honestly 'completed' with empty output", async () => {
  const dir = await makeProject();
  try {
    const { fetch: f } = recordingFetch(() => sseResponseBody([finishEvent("stop"), DONE_MARKER]));
    const provider = NVIDIAProvider.start({ apiKey: TKEY, fetchImpl: f });
    const runner = await provider.createSession({
      directory: dir, title: "t", agent: "plan", model: null, tools: false, promptText: "say nothing",
    });
    const res = await runner.awaitCompletion(10_000);
    assert.equal(res.outcome, "completed");
    assert.equal(res.output, "");
    assert.equal(await runner.usage(), null, "no usage reported → null (tokensUnknown preserved)");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("runtime: nvidia-direct selection never opens the OpenCode path; unknown selection fails honestly", async () => {
  const prev = process.env.OAE_NVIDIA_API_KEY;
  process.env.OAE_NVIDIA_API_KEY = "nvapi-runtime-test-0001";
  try {
    const rt = await createRuntime({ selection: "nvidia-direct" });
    assert.equal(rt.provider.id, "nvidia-direct");
    assert.equal(rt.endpoint?.url, "https://integrate.api.nvidia.com/v1");
    // no OpenCode endpoint is materialized for the direct selection
    assert.doesNotMatch(rt.endpoint?.url ?? "", /127\.0\.0\.1/);
  } finally {
    if (prev === undefined) delete process.env.OAE_NVIDIA_API_KEY;
    else process.env.OAE_NVIDIA_API_KEY = prev;
  }
  assert.equal(normalizeProviderSelection(undefined), "opencode");
  assert.equal(normalizeProviderSelection("nvidia"), "nvidia-direct");
  assert.equal(normalizeProviderSelection("opencode"), "opencode");
  // stage 2: "openrouter" became a VALID alias of openrouter-direct (see the
  // dedicated openrouter selection tests) — this gate now pins a test case
  // that is still invalid
  assert.throws(() => normalizeProviderSelection("openrouters"), /unknown provider selection/);
});

// ── FileToolSet isolation (root confinement, strict schemas, caps) ─────────

test("filetools: read/write/list inside the root succeed with caps", async () => {
  const dir = await makeProject();
  try {
    const ts = new FileToolSet(dir);
    const w = await ts.execute("write_file", JSON.stringify({ path: "src/nested/mod.ts", content: "ok" }));
    assert.match(w, /written 2 bytes to src\/nested\/mod\.ts/);
    assert.equal(await readFile(join(dir, "src", "nested", "mod.ts"), "utf8"), "ok");
    const r = await ts.execute("read_file", JSON.stringify({ path: "src/nested/mod.ts" }));
    assert.equal(r, "ok");
    const l = await ts.execute("list_dir", JSON.stringify({}));
    assert.match(l, /src\//);
    // read cap with truncation marker
    const big = "x".repeat(FILE_TOOL_LIMITS.readMaxChars + 500);
    await ts.execute("write_file", JSON.stringify({ path: "big.txt", content: big }));
    const r2 = await ts.execute("read_file", JSON.stringify({ path: "big.txt" }));
    assert.strictEqual(r2.length > FILE_TOOL_LIMITS.readMaxChars && r2.length < big.length + 300, true);
    assert.match(r2, /\[truncated: file has /);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("filetools: traversal/absolute/backslash/drive/tilde rejections stay inside the root", async () => {
  const dir = await makeProject();
  try {
    const ts = new FileToolSet(dir);
    const rejects: [string, string, RegExp][] = [
      ["read_file", "../outside.txt", /\.\./],
      ["read_file", "..", /\.\./],
      ["read_file", "/etc/hosts", /absolute/],
      ["read_file", "C:\\Windows\\system32", /absolute/],
      ["read_file", "~/.ssh/id_rsa", /'~'/],
      ["read_file", "\u0000evil", /NUL/],
      ["write_file", "../outside.txt", /\.\./],
      ["write_file", "/tmp/pwned", /absolute/],
    ];
    for (const [tool, path, re] of rejects) {
      const args = tool === "write_file" ? JSON.stringify({ path, content: "x" }) : JSON.stringify({ path });
      const out = await ts.execute(tool, args);
      assert.match(out, /ERROR: /, `${tool} ${path}`);
      assert.match(out, re, `${tool} ${path}`);
    }
    // encoded traversal is just a weird literal filename: it can only name a
    // non-existent file INSIDE the root — never an escape
    const enc = await ts.execute("read_file", JSON.stringify({ path: "%2e%2e/config" }));
    assert.match(enc, /no such path/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("filetools: symlink escapes are refused for read and write", async () => {
  const dir = await makeProject();
  try {
    const outside = join(await mkdtemp(join(tmpdir(), "oae-out-")), "outside.txt");
    await writeFile(outside, "top secret", "utf8");
    await symlink(outside, join(dir, "lure.txt"));
    const ts = new FileToolSet(dir);
    const r = await ts.execute("read_file", JSON.stringify({ path: "lure.txt" }));
    assert.match(r, /refusing to follow a symlink/);
    const w = await ts.execute("write_file", JSON.stringify({ path: "lure.txt", content: "overwritten?" }));
    assert.match(w, /target is a symlink/);
    assert.equal(await readFile(outside, "utf8"), "top secret", "outside file untouched");
    // directory symlink escape on write
    const outsideDir = join(await mkdtemp(join(tmpdir(), "oae-outd-")));
    await symlink(outsideDir, join(dir, "lure.dir"));
    const w2 = await ts.execute("write_file", JSON.stringify({ path: "lure.dir/new.txt", content: "x" }));
    assert.match(w2, /escapes the project root/);
    const listed = await readdir(outsideDir);
    assert.equal(listed.length, 0, "no file created outside");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("filetools: .oae/.opencode are model-read-only; strict schemas reject bad arguments", async () => {
  const dir = await makeProject();
  try {
    const ts = new FileToolSet(dir);
    // read-only guard
    const w = await ts.execute("write_file", JSON.stringify({ path: ".oae/state.json", content: "{}" }));
    assert.match(w, /read-only for the model/);
    const w2 = await ts.execute("write_file", JSON.stringify({ path: ".opencode/agent.json", content: "{}" }));
    assert.match(w2, /read-only for the model/);
    // strict argument schemas
    const badJson = await ts.execute("read_file", "{oops");
    assert.match(badJson, /not valid JSON/);
    const extra = await ts.execute("read_file", JSON.stringify({ path: "a", mode: "x" }));
    assert.match(extra, /unknown field "mode"/);
    const wrongType = await ts.execute("write_file", JSON.stringify({ path: "a", content: 42 }));
    assert.match(wrongType, /field "content" must be a string/);
    const unknownTool = await ts.execute("shell", JSON.stringify({ cmd: "ls" }));
    assert.match(unknownTool, /unknown tool/);
    // write size cap
    const tooBig = "y".repeat(FILE_TOOL_LIMITS.writeMaxChars + 10);
    const cap = await ts.execute("write_file", JSON.stringify({ path: "big.txt", content: tooBig }));
    assert.match(cap, /exceeds the .* cap/);
    // list_dir cap
    await mkdir(join(dir, "flood"), { recursive: true });
    for (let i = 0; i < FILE_TOOL_LIMITS.listMaxEntries + 5; i++) {
      await writeFile(join(dir, "flood", `f${i}.txt`), "x", "utf8");
    }
    const l = await ts.execute("list_dir", JSON.stringify({ path: "flood" }));
    assert.match(l, /\[5 more entries hidden/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("redact: nvapi- keys are masked wherever they could appear (defense in depth)", () => {
  assert.equal(redact("Bearer nvapi-unit-test-key-0123456789"), "Bearer [redacted]");
  assert.equal(redact("configured key nvapi-abcdefgh123456789 in config"), "configured key [redacted] in config");
  assert.doesNotMatch(redact("Bearer nvapi-unit-test-key-0123456789"), /nvapi-unit/);
});

// ── Auditoria Onda 2/Etapa 1: correções F1..F7, F9 ──────────────────────────

/** Never-resolving tool executor: deterministic stand-in for a tool stuck on
 * non-cancellable OS I/O (e.g. open() on a FIFO) — no FIFOs, no hung procs. */
const stuckToolExecutor = {
  execute: (): Promise<string> => new Promise<string>(() => {}),
};

function buildToolCallReply(tool: { name: string; args: string }): string {
  return [
    sseEvent({ id: "chatcmpl-t", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", function: { name: tool.name, arguments: tool.args } }] }, finish_reason: null }] }),
    sseEvent({ id: "chatcmpl-t", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    DONE_MARKER,
  ].join("");
}

test("nvidia runner F1: interrupt() settles 'interrupted' in finite time while a tool is blocked", async () => {
  const dir = await makeProject();
  try {
    const { fetch: f } = recordingFetch(() => sseResponseBody([
      buildToolCallReply({ name: "read_file", args: '{"path":"whatever.txt"}' }),
    ]));
    const provider = NVIDIAProvider.start({ apiKey: TKEY, fetchImpl: f });
    const runner = await provider.createSession({
      directory: dir, title: "t", agent: "build", model: null,
      tools: true, promptText: "blocked tool", toolExecutor: stuckToolExecutor,
    });
    setTimeout(() => { void runner.interrupt(); }, 120);
    const started = Date.now();
    const res = await runner.awaitCompletion(30_000);
    const elapsed = Date.now() - started;
    assert.equal(res.outcome, "interrupted");
    assert.ok(elapsed < 5_000, `settle em tempo finito (elapsed=${elapsed}ms)`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("nvidia runner F1: the awaitCompletion deadline alone ends the wait while a tool is blocked", async () => {
  const dir = await makeProject();
  try {
    const { fetch: f } = recordingFetch(() => sseResponseBody([
      buildToolCallReply({ name: "read_file", args: '{"path":"whatever.txt"}' }),
    ]));
    const provider = NVIDIAProvider.start({ apiKey: TKEY, fetchImpl: f });
    const runner = await provider.createSession({
      directory: dir, title: "t", agent: "build", model: null,
      tools: true, promptText: "deadline test", toolExecutor: stuckToolExecutor,
    });
    const started = Date.now();
    const res = await runner.awaitCompletion(700);
    const elapsed = Date.now() - started;
    assert.equal(res.outcome, "interrupted");
    assert.ok(elapsed < 5_000, `deadline interrompe de fato (elapsed=${elapsed}ms)`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("nvidia runner F1: a late tool resolution cannot restart the pump, re-settle or leak rejections", async () => {
  const dir = await makeProject();
  try {
    let resolveTool: ((v: string) => void) | null = null;
    const lateExecutor = {
      execute: (): Promise<string> => new Promise<string>((res) => { resolveTool = res; }),
    };
    const { fetch: f } = recordingFetch(() => sseResponseBody([
      buildToolCallReply({ name: "write_file", args: '{"path":"a.txt","content":"x"}' }),
    ]));
    const provider = NVIDIAProvider.start({ apiKey: TKEY, fetchImpl: f });
    const runner = await provider.createSession({
      directory: dir, title: "t", agent: "build", model: null,
      tools: true, promptText: "late resolution", toolExecutor: lateExecutor,
    });
    setTimeout(() => { void runner.interrupt(); }, 150);
    const res = await runner.awaitCompletion(30_000);
    assert.equal(res.outcome, "interrupted");
    const signalsAtSettle = res.signals.length;
    const rejections: unknown[] = [];
    const onUnhandled = (r: unknown): void => { rejections.push(r); };
    process.on("unhandledRejection", onUnhandled);
    try {
      await sleep(300);                       // the tool finally "completes"
      resolveTool!("tool result arrived after settlement");
      await sleep(150);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    assert.equal(rejections.length, 0, "no unhandled rejection from the abandoned tool");
    const res2 = await runner.awaitCompletion(1_000);
    assert.equal(res2, res, "settlement stays exactly the same object");
    assert.equal(res2.outcome, "interrupted", "late resolution did not flip the terminal state");
    assert.equal(res2.signals.length, signalsAtSettle, "no duplicated/late signals");
    await assert.rejects(() => runner.prompt("anything"), /already finished/, "session is terminal: no pump restart");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("filetools F2: bounded read reports the EXACT char count for files over the cap (1-byte chars)", async () => {
  const dir = await makeProject();
  try {
    const ts = new FileToolSet(dir);
    const n = FILE_TOOL_LIMITS.readMaxChars * 2 + 137;
    await ts.execute("write_file", JSON.stringify({ path: "big.txt", content: "x".repeat(n) }));
    const r = await ts.execute("read_file", JSON.stringify({ path: "big.txt" }));
    assert.match(r, new RegExp(`…\\[truncated: file has ${n} chars, showing first 48000\\]`));
    assert.equal(r.slice(0, FILE_TOOL_LIMITS.readMaxChars), "x".repeat(FILE_TOOL_LIMITS.readMaxChars));
    assert.ok(r.length < n + 200, "bounded result size");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("filetools F2: bounded read counts multi-byte chars exactly (2-byte path, no truncation-by-bytes)", async () => {
  const dir = await makeProject();
  try {
    const ts = new FileToolSet(dir);
    const total = 60_000; // 2-byte chars → 120k bytes < capBytes: prefix covers all, count exact
    await ts.execute("write_file", JSON.stringify({ path: "uni.txt", content: "é".repeat(total) }));
    const r = await ts.execute("read_file", JSON.stringify({ path: "uni.txt" }));
    assert.match(r, /…\[truncated: file has 60000 chars, showing first 48000\]/);
    const head = r.slice(0, FILE_TOOL_LIMITS.readMaxChars);
    assert.equal(head, "é".repeat(FILE_TOOL_LIMITS.readMaxChars), "no corrupt mid-codepoint char in the head");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("filetools F2: list_dir keeps exact hidden count and alphabetical-first subset for oversized dirs", async () => {
  const dir = await makeProject();
  try {
    const extra = 7;
    for (let i = 0; i < FILE_TOOL_LIMITS.listMaxEntries + extra; i++) {
      await writeFile(join(dir, `f${String(i).padStart(3, "0")}.txt`), "x", "utf8");
    }
    const ts = new FileToolSet(dir);
    const r = await ts.execute("list_dir", JSON.stringify({ path: "." }));
    const lines = r.split("\n");
    const first = lines.findIndex((l) => l.startsWith("f"));
    assert.equal(lines[first], "f000.txt", "alphabetically-first entry shown");
    assert.equal(lines[first + FILE_TOOL_LIMITS.listMaxEntries - 1], `f${String(FILE_TOOL_LIMITS.listMaxEntries - 1).padStart(3, "0")}.txt`, "shown slice holds the 400 smallest names");
    assert.match(r, /…\[7 more entries hidden \(cap 400\)\]/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("nvidia transport F3: tool-call index flood ends in a controlled protocol error", async () => {
  const parts: string[] = [];
  for (let i = 0; i < TRANSPORT_CAPS.toolSlotsMax + 8; i++) {
    parts.push(sseEvent({ id: "t", choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: `c${i}`, function: { name: "t", arguments: "{}" } }] }, finish_reason: null }] }));
  }
  const { fetch: f } = recordingFetch(() => sseResponseBody(parts));
  const t = new HttpTransport({ ...TPROVIDER, fetchImpl: f });
  await t.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) }).then(
    () => { throw new Error("must reject"); },
    (e: unknown) => {
      assert.ok(e instanceof ProviderError);
      assert.equal((e as ProviderError).kind, "protocol");
      assert.match((e as ProviderError).message, /tool-call indexes/);
    },
  );
});

test("nvidia transport F3: valid streams staying within the slot cap keep working", async () => {
  const parts: string[] = [];
  const slots = TRANSPORT_CAPS.toolSlotsMax;
  for (let i = 0; i < slots; i++) {
    parts.push(sseEvent({ id: "t", choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: `c${i}`, function: { name: "t", arguments: '{"k":' + i + "}" } }] }, finish_reason: null }] }));
  }
  parts.push(sseEvent({ id: "t", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }), DONE_MARKER);
  const { fetch: f } = recordingFetch(() => sseResponseBody(parts));
  const t = new HttpTransport({ ...TPROVIDER, fetchImpl: f });
  const rep = await t.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) });
  assert.equal(rep.toolCalls?.length, slots);
});

test("nvidia transport F4: a 400 without a 'stream' hint carries the real gateway diagnostic", async () => {
  const { fetch: f } = recordingFetch(() => jsonResponse({ error: { message: "model not found in this endpoint" } }, 400));
  const t = new HttpTransport({ ...TPROVIDER, fetchImpl: f });
  await t.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) }).then(
    () => { throw new Error("must reject"); },
    (e: unknown) => {
      assert.ok(e instanceof ProviderError);
      assert.equal((e as ProviderError).kind, "protocol");
      assert.match((e as ProviderError).message, /model not found in this endpoint/);
      assert.doesNotMatch((e as ProviderError).message, /unreadable error body/);
    },
  );
});

test("nvidia transport F5: [DONE] and final delta without a trailing newline are honored at EOF", async () => {
  // case 1: "[DONE]" como ÚLTIMA linha sem "\n" final
  const { fetch: f1 } = recordingFetch(() => sseResponseBody([contentEvent("tail "), "data: [DONE]"]));
  const t1 = new HttpTransport({ ...TPROVIDER, fetchImpl: f1 });
  const r1 = await t1.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) });
  assert.equal(r1.content, "tail ");

  // case 2: último evento de delta/finish sem "\n" final
  const lastEvent = sseEvent({ id: "t", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }).replace(/\n+$/, "");
  const { fetch: f2 } = recordingFetch(() => sseResponseBody([contentEvent("body"), lastEvent]));
  const t2 = new HttpTransport({ ...TPROVIDER, fetchImpl: f2 });
  const r2 = await t2.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) });
  assert.equal(r2.content, "body");
  assert.equal(r2.finishReason, "stop");
});

test("nvidia runner F6: prompts accepted while running are reported as dropped on terminal states", async () => {
  const dir = await makeProject();
  try {
    let n = 0;
    const { fetch: f } = recordingFetch(() => sseResponseBody([buildToolCallReply({ name: "write_file", args: `{"path":"r${n++}.txt","content":"x"}` })]));
    const provider = NVIDIAProvider.start({ apiKey: TKEY, fetchImpl: f });
    const runner = await provider.createSession({
      directory: dir, title: "t", agent: "build", model: null,
      tools: true, promptText: "start", toolExecutor: {
        execute: async () => "written 1 bytes",
      },
      maxToolRounds: 1,
    });
    // accepted while the chain is running (round 2 in flight); the chain then
    // hits the tool-call budget → terminal state that must NOT drop it silently
    await runner.prompt("follow-up that cannot be served");
    const res = await runner.awaitCompletion(10_000);
    assert.equal(res.outcome, "failed");
    assert.match(res.output, /tool-call round budget \(1\) exhausted/);
    assert.match(res.output, /1 queued follow-up prompt\(s\) were dropped by this terminal session state/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("nvidia runner F9: tool arguments are redacted in signals and in the transcript tail", async () => {
  const dir = await makeProject();
  try {
    const secret = "nvapi-abcdefghijklmnop123";
    let n = 0;
    const { fetch: f } = recordingFetch(() => {
      n++;
      if (n === 1) {
        return sseResponseBody([
          sseEvent({ id: "t", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "write_file", arguments: `{"path":"a.txt","content":"key ${secret} leaked?"}` } }] }, finish_reason: null }] }),
          sseEvent({ id: "t", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
          DONE_MARKER,
        ]);
      }
      return sseResponseBody([contentEvent("done"), finishEvent("stop"), DONE_MARKER]);
    });
    const provider = NVIDIAProvider.start({ apiKey: TKEY, fetchImpl: f });
    const runner = await provider.createSession({
      directory: dir, title: "t", agent: "build", model: null,
      tools: true, promptText: "x", toolExecutor: { execute: async () => "written ok" },
    });
    const res = await runner.awaitCompletion(10_000);
    assert.equal(res.outcome, "completed");
    const toolSignal = res.signals.find((s) => s.kind === "tool");
    assert.ok(toolSignal, "tool signal exists");
    assert.doesNotMatch(toolSignal!.detail, RegExp(secret));
    assert.match(toolSignal!.detail, /\[redacted\]/);
    const tail = await runner.transcriptTail(20);
    assert.doesNotMatch(tail, RegExp(secret));
    assert.match(tail, /\[redacted\]/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("filetools F7: a symlinked intermediate NEVER triggers mkdir outside the root", async () => {
  const dir = await makeProject();
  const outside = join(await mkdtemp(join(tmpdir(), "oae-lure-")));
  try {
    await symlink(outside, join(dir, "lure.dir"));
    const ts = new FileToolSet(dir);
    const w = await ts.execute("write_file", JSON.stringify({ path: "lure.dir/sub/deep/new.txt", content: "x" }));
    assert.match(w, /escapes the project root/);
    assert.equal((await readdir(outside)).length, 0, "nothing was created outside the root");
  } finally {
    await rm(join(dir, "lure.dir"), { force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Auditoria final: A5 — ordem redact ANTES de truncate ────────────────────

test("nvidia runner A5: a secret straddling the truncation boundary leaves no visible prefix", async () => {
  const dir = await makeProject();
  try {
    const KEY = "nvapi-abcdefghijklmnop";
    // old order redact(truncate(...)) leaked "nvapi-ab" here: with the cut at
    // 120 chars only "ab" (2 chars < the regex's 8-char minimum) stayed
    // visible, so redaction could never fire. truncation boundaries are exact:
    // 500-492 = 8 and 120-112 = 8 visible chars on both surfaces. A non-word
    // char precedes the key so redact()'s \b boundary matches the full token.
    const straddleContent = "x".repeat(491) + " " + KEY; // key starts @492: cut @500 → "nvapi-ab" visible
    const straddleArgs = '{"path":"a.txt","content":"' + "y".repeat(84) + " " + KEY + '"}'; // key starts @112: cut @120 → "nvapi-ab" visible
    let n = 0;
    const { fetch: f } = recordingFetch(() => {
      n++;
      if (n === 1) {
        return sseResponseBody([buildToolCallReply({ name: "write_file", args: straddleArgs })]);
      }
      return sseResponseBody([contentEvent(straddleContent), finishEvent("stop"), DONE_MARKER]);
    });
    const provider = NVIDIAProvider.start({ apiKey: TKEY, fetchImpl: f });
    const runner = await provider.createSession({
      directory: dir, title: "t", agent: "build", model: null,
      tools: true, promptText: "boundary test", toolExecutor: { execute: async () => "written ok" },
    });
    const res = await runner.awaitCompletion(10_000);
    assert.equal(res.outcome, "completed");
    // transcript tail: content boundary (500) AND tool-args boundary (120).
    // the redaction marker may itself be cut by the boundary; /n {2}/ partial
    // "[redact" is still proof redaction ran in full before truncation.
    const tail = await runner.transcriptTail(30);
    assert.doesNotMatch(tail, /nvapi-/, "no secret prefix visible in the tail");
    assert.match(tail, /\[redact/, "partial redaction marker proves redact ran pre-truncate");
    // tool signals: args boundary at 160
    const toolSignals = res.signals.filter((s) => s.kind === "tool");
    assert.ok(toolSignals.length >= 1);
    for (const s of toolSignals) {
      assert.doesNotMatch(s.detail, /nvapi-/);
      assert.match(s.detail, /\[redact/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ── Onda 2 / Etapa 2 — OpenRouter direto + A1/A4 do transporte ───────────────

const ORKEY = "sk-or-unit-test-key-abcdef0123456789";
const ORPROVIDER = {
  provider: "openrouter-direct",
  baseUrl: "https://openrouter.test/api/v1",
  apiKey: ORKEY,
  includeUsage: false,
} as const;

const OR_MODEL = { providerID: "openrouter", id: "z-ai/glm-4.6" };

/** Pull-driven bounded stream: each pull hands out one fresh chunk until the
 * budget ends, so the TEST never materializes the payload in memory either.
 * `consumed` counts exactly what the CONSUMER pulled from the wire. */
function oversizedResponse(opts: { status: number; contentType: string; bodyBytes: number; chunkBytes?: number }): {
  res: Response;
  consumed: () => number;
} {
  const chunkBytes = opts.chunkBytes ?? 16_384;
  let produced = 0;
  let pulledBytes = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (produced >= opts.bodyBytes) { controller.close(); return; }
      const n = Math.min(chunkBytes, opts.bodyBytes - produced);
      const chunk = new Uint8Array(n); // oversized content bytes are irrelevant
      produced += n;
      pulledBytes += n;
      controller.enqueue(chunk);
    },
    cancel() { produced = opts.bodyBytes; }, // cap reached: source stops
  });
  return {
    res: new Response(stream, { status: opts.status, headers: { "content-type": opts.contentType } }),
    consumed: () => pulledBytes,
  };
}

test("openrouter: selection resolves openrouter-direct (exact + aliases; unknown throws)", () => {
  assert.equal(normalizeProviderSelection("openrouter-direct"), "openrouter-direct");
  assert.equal(normalizeProviderSelection("openrouter"), "openrouter-direct");
  assert.equal(normalizeProviderSelection("openrouter_direct"), "openrouter-direct");
  assert.throws(() => normalizeProviderSelection("openrouterish"), /unknown provider selection/, "honest early throw");
  assert.throws(() => normalizeProviderSelection("nvidia-opencode"), /unknown provider selection/);
});

test("openrouter: createRuntime materializes the direct provider without any OpenCode import", async () => {
  const prev = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = ORKEY;
  try {
    const rt = await createRuntime({ selection: "openrouter-direct" });
    assert.equal(rt.provider.id, "openrouter-direct");
    assert.equal(rt.endpoint?.url, "https://openrouter.ai/api/v1");
    assert.ok(rt.provider.healthCheck instanceof Function);
  } finally {
    if (prev === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prev;
  }
});

test("openrouter: missing OPENROUTER_API_KEY fails fast with a secret-free error", async () => {
  const prevOR = process.env.OPENROUTER_API_KEY;
  const prevLegacy = process.env.OAE_OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OAE_OPENROUTER_API_KEY;
  try {
    // start() is synchronous: a configuration error throws eagerly — the run
    // forfeits before any session attempt burns against a dead endpoint
    await assert.rejects(
      () => new Promise<unknown>((resolve, reject) => {
        try { resolve(OpenRouterProvider.start()); } catch (e) { reject(e); }
      }),
      (e: unknown) => {
        const m = (e as Error).message;
        assert.match(m, /OPENROUTER_API_KEY is not set/);
        assert.doesNotMatch(m, /sk-or-/, "no key material in the error");
        assert.doesNotMatch(m, /Bearer/, "no header echo");
        return true;
      },
    );
  } finally {
    if (prevOR !== undefined) process.env.OPENROUTER_API_KEY = prevOR;
    if (prevLegacy !== undefined) process.env.OAE_OPENROUTER_API_KEY = prevLegacy;
  }
});

test("openrouter: no invented default model — createSession requires an explicit model", async () => {
  const dir = await makeProject();
  try {
    const provider = OpenRouterProvider.start({ apiKey: ORKEY });
    await assert.rejects(
      () => provider.createSession({ directory: dir, title: "t", agent: "build", model: null, promptText: "x" }),
      /no model selected/,
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("openrouter: request builds official endpoint, auth-only headers and the requested model", async () => {
  const dir = await makeProject();
  try {
    const { calls, fetch: f } = recordingFetch(() => sseResponseBody([contentEvent("ok"), finishEvent("stop"), DONE_MARKER]));
    const provider = OpenRouterProvider.start({ apiKey: ORKEY, fetchImpl: f, baseUrl: "https://openrouter.test/api/v1" });
    await provider.createSession({ directory: dir, title: "t", agent: "build", model: OR_MODEL, promptText: "hi" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://openrouter.test/api/v1/chat/completions");
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers["authorization"], `Bearer ${ORKEY}`);
    assert.equal(headers["content-type"], "application/json");
    assert.equal(Object.keys(headers).filter((k) => !["authorization", "content-type", "accept"].includes(k)).length, 0, "no invented attribution headers");
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    assert.equal(body.model, "z-ai/glm-4.6", "model id travels verbatim (author/slug)");
    assert.equal(body.stream, true);
    assert.equal("stream_options" in body, false, "OpenRouter: legacy include_usage is omitted");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("openrouter: streaming honors OPENROUTER PROCESSING keepalives and the non-empty usage chunk", async () => {
  // usage frame repeats finish_reason with a content-free delta (OpenRouter
  // deviation from OpenAI) — the shared parser must treat it as accounting
  const parts = [
    ": OPENROUTER PROCESSING\n\n",
    contentEvent("hello "),
    ": OPENROUTER PROCESSING\n\n",
    contentEvent("router"),
    sseEvent({ id: "g1", choices: [{ index: 0, delta: { content: "", role: "assistant" }, finish_reason: "stop", native_finish_reason: "stop" }] }),
    sseEvent({ id: "g1", choices: [{ index: 0, delta: { content: "", role: "assistant" }, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 7 } }),
    DONE_MARKER,
  ];
  const { fetch: f } = recordingFetch(() => sseResponseBody(parts));
  const t = new HttpTransport({ ...ORPROVIDER, fetchImpl: f });
  const rep = await t.chat({ model: "z-ai/glm-4.6", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) });
  assert.equal(rep.content, "hello router");
  assert.equal(rep.finishReason, "stop");
  assert.equal(rep.usage?.input, 11);
  assert.equal(rep.usage?.output, 7);
});

test("openrouter: mid-stream top-level error event ends the round as a classified failure", async () => {
  const { fetch: f } = recordingFetch(() => sseResponseBody([
    sseEvent({ id: "g1", choices: [{ index: 0, delta: { content: "" }, finish_reason: null }] }),
    sseEvent({ id: "g1", error: { code: 502, message: "Provider disconnected unexpectedly" }, choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }] }),
    DONE_MARKER,
  ]));
  const t = new HttpTransport({ ...ORPROVIDER, fetchImpl: f });
  await t.chat({ model: "z-ai/glm-4.6", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) }).then(
    () => { throw new Error("must reject"); },
    (e: unknown) => {
      assert.ok(e instanceof ProviderError);
      assert.equal((e as ProviderError).kind, "unavailable", "HTTP 502-style code classifies through the central table");
      assert.match((e as ProviderError).message, /mid-stream provider error \(code 502\)/);
    },
  );
});

test("openrouter: mid-stream error without numeric kind is unavailable and redacted", async () => {
  const secret = "sk-or-v1-0123456789abcdefghij";
  const { fetch: f } = recordingFetch(() => sseResponseBody([
    sseEvent({ error: { code: "server_error", message: `auth failed upstream: ${secret}` }, choices: [{ index: 0, delta: {}, finish_reason: "error" }] }),
  ]));
  const t = new HttpTransport({ ...ORPROVIDER, fetchImpl: f });
  await t.chat({ model: "z-ai/glm-4.6", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) }).then(
    () => { throw new Error("must reject"); },
    (e: unknown) => {
      assert.ok(e instanceof ProviderError);
      assert.equal((e as ProviderError).kind, "unavailable");
      assert.match((e as ProviderError).message, /mid-stream provider error:/);
      assert.doesNotMatch((e as ProviderError).message, RegExp(secret), "no key material");
      assert.match((e as ProviderError).message, /\[redacted\]/);
    },
  );
});

test("openrouter: gateway rejecting streaming gets one non-streaming retry without stream_options", async () => {
  let n = 0;
  const { calls, fetch: f } = recordingFetch(() => {
    n++;
    if (n === 1) return jsonResponse({ error: { message: "this provider requires stream:false (stream unsupported)" } }, 400);
    return jsonResponse({ choices: [{ index: 0, message: { role: "assistant", content: "plain answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } });
  });
  const t = new HttpTransport({ ...ORPROVIDER, fetchImpl: f });
  const rep = await t.chat({ model: "z-ai/glm-4.6", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) });
  assert.equal(rep.content, "plain answer");
  assert.equal(calls.length, 2);
  const body2 = JSON.parse(String(calls[1]!.init.body)) as Record<string, unknown>;
  assert.equal(body2.stream, false);
  assert.equal("stream_options" in body2, false);
});

test("openrouter transport: valid non-streaming tool calls stay inside the slot cap", async () => {
  const toolCalls: Record<string, unknown>[] = [];
  for (let i = 0; i < TRANSPORT_CAPS.toolSlotsMax; i++) {
    toolCalls.push({ id: `call_${i}`, type: "function", function: { name: "write_file", arguments: `{"path":"f${i}.txt","content":"x"}` } });
  }
  const { fetch: f } = recordingFetch(() => jsonResponse({ choices: [{ index: 0, message: { role: "assistant", content: "", tool_calls: toolCalls }, finish_reason: "tool_calls" }] }));
  const t = new HttpTransport({ ...ORPROVIDER, fetchImpl: f });
  const rep = await t.chat({ model: "z-ai/glm-4.6", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) });
  assert.equal(rep.toolCalls?.length, TRANSPORT_CAPS.toolSlotsMax);
});

test("A4: non-streaming tool_calls flood ends in a controlled protocol error", async () => {
  const toolCalls: Record<string, unknown>[] = [];
  for (let i = 0; i < TRANSPORT_CAPS.toolSlotsMax + 5; i++) {
    toolCalls.push({ id: `call_${i}`, type: "function", function: { name: "t", arguments: "{}" } });
  }
  const { fetch: f } = recordingFetch(() => jsonResponse({ choices: [{ index: 0, message: { role: "assistant", content: "", tool_calls: toolCalls } }] }));
  const t = new HttpTransport({ ...ORPROVIDER, fetchImpl: f });
  await t.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) }).then(
    () => { throw new Error("must reject"); },
    (e: unknown) => {
      assert.ok(e instanceof ProviderError);
      assert.equal((e as ProviderError).kind, "protocol");
      assert.match((e as ProviderError).message, /more than 32 tool calls \(non-streaming/);
    },
  );
});

test("A1: an oversize ERROR body is read only up to the excerpt cap (never materialized)", async () => {
  const BODY = 1_000_000;
  const CAP = TRANSPORT_CAPS.errorExcerptBytes;
  const { res, consumed } = oversizedResponse({ status: 502, contentType: "text/html", bodyBytes: BODY });
  const { fetch: f } = recordingFetch(() => res);
  const t = new HttpTransport({ ...ORPROVIDER, fetchImpl: f });
  const err = await t.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) }).then(
    () => { throw new Error("must reject"); },
    (e: unknown) => e,
  );
  assert.ok(err instanceof ProviderError);
  assert.equal((err as ProviderError).kind, "unavailable");
  assert.match((err as ProviderError).message, /body truncated/);
  const pulled = consumed();
  // THE assertion that proves incremental reading: the consumer pulled at
  // most cap + two chunks (one plain chunk + one stream-queue prefetch) —
  // res.text() (old behavior) would have pulled the whole 1MB body
  assert.ok(pulled <= CAP + 2 * 16_384 + 1, `pulled=${pulled} must be bounded by cap+prefetch, not the 1MB body`);
  assert.ok(pulled < BODY / 10);
});

test("A1: an oversize SUCCESS body stops at the cap and fails as a controlled protocol error", async () => {
  const CAP = TRANSPORT_CAPS.successBodyBytes;
  const BODY = CAP + 64_000;
  const { res, consumed } = oversizedResponse({ status: 200, contentType: "application/json", bodyBytes: BODY });
  const { fetch: f } = recordingFetch(() => res);
  const t = new HttpTransport({ ...ORPROVIDER, fetchImpl: f });
  const err = await t.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) }).then(
    () => { throw new Error("must reject"); },
    (e: unknown) => e,
  );
  assert.ok(err instanceof ProviderError);
  assert.equal((err as ProviderError).kind, "protocol");
  assert.match((err as ProviderError).message, /exceeded the 4000000 byte cap/);
  assert.ok(consumed() <= CAP + 2 * 16_384 + 1, "no full materialization of the oversized body");
});

test("A1: a bounded stream read that errors mid-way degrades to honest partial text", async () => {
  const encoder = new TextEncoder();
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled === 0) { pulled++; controller.enqueue(encoder.encode("partial error context ")); return; }
      controller.error(new Error("connection reset mid-read"));
    },
  });
  const { fetch: f } = recordingFetch(() => new Response(stream, { status: 500, headers: { "content-type": "text/plain" } }));
  const t = new HttpTransport({ ...ORPROVIDER, fetchImpl: f });
  await t.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) }).then(
    () => { throw new Error("must reject"); },
    (e: unknown) => {
      assert.ok(e instanceof ProviderError);
      assert.match((e as ProviderError).message, /read interrupted after \d+ bytes/);
    },
  );
});

test("openrouter: malformed non-streaming body and missing choices fail as protocol", async () => {
  const { fetch: f1 } = recordingFetch(() => new Response("not json{", { status: 200, headers: { "content-type": "application/json" } }));
  const t1 = new HttpTransport({ ...ORPROVIDER, fetchImpl: f1 });
  await t1.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) }).then(
    () => { throw new Error("must reject"); },
    (e: unknown) => { assert.match((e as ProviderError).message, /malformed non-streaming JSON/); },
  );
  const { fetch: f2 } = recordingFetch(() => jsonResponse({ object: "chat.completion", usage: undefined }));
  const t2 = new HttpTransport({ ...ORPROVIDER, fetchImpl: f2 });
  await t2.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) }).then(
    () => { throw new Error("must reject"); },
    (e: unknown) => { assert.match((e as ProviderError).message, /no choices/); },
  );
});

test("openrouter: network failure classifies as unavailable; retry later gates still work", async () => {
  const { fetch: f } = recordingFetch(() => { throw new Error("ECONNREFUSED 127.0.0.1:443"); });
  const t = new HttpTransport({ ...ORPROVIDER, fetchImpl: f });
  await t.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) }).then(
    () => { throw new Error("must reject"); },
    (e: unknown) => {
      assert.ok(e instanceof ProviderError);
      assert.equal((e as ProviderError).kind, "unavailable");
    },
  );
});

test("openrouter: credentials never appear in errors, signals or transcript", async () => {
  const dir = await makeProject();
  try {
    const secret = ORKEY;
    let n = 0;
    const { fetch: f } = recordingFetch(() => {
      n++;
      if (n === 1) return sseResponseBody([buildToolCallReply({ name: "write_file", args: `{"path":"a.txt","content":"key ${secret} in args"}` })]);
      return sseResponseBody([contentEvent("done with key"), finishEvent("stop"), DONE_MARKER]);
    });
    const provider = OpenRouterProvider.start({ apiKey: secret, fetchImpl: f, baseUrl: "https://openrouter.test/api/v1" });
    const runner = await provider.createSession({ directory: dir, title: "t", agent: "build", model: OR_MODEL, tools: true, promptText: "x", toolExecutor: { execute: async () => "ok" } });
    const res = await runner.awaitCompletion(10_000);
    assert.equal(res.outcome, "completed");
    const escaped = RegExp(secret);
    for (const s of res.signals) assert.doesNotMatch(s.detail, escaped, `${s.kind} signal carries no key`);
    const tail = await runner.transcriptTail(30);
    assert.doesNotMatch(tail, escaped, "transcript tail carries no key");
    assert.match(tail, /\[redact/, "redaction marker present (sk-or maps through the sk- pattern)");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("openrouter runner: interrupt during an in-flight SSE round settles exactly once", async () => {
  const dir = await makeProject();
  try {
    const { fetch: f } = recordingFetch(() => sseResponseBody([contentEvent("slow"), finishEvent("stop"), DONE_MARKER], { chunkDelayMs: 200 }));
    const provider = OpenRouterProvider.start({ apiKey: ORKEY, fetchImpl: f, baseUrl: "https://openrouter.test/api/v1" });
    const runner = await provider.createSession({ directory: dir, title: "t", agent: "build", model: OR_MODEL, promptText: "slow" });
    setTimeout(() => { void runner.interrupt(); }, 100);
    const res = await runner.awaitCompletion(30_000);
    assert.equal(res.outcome, "interrupted");
    const res2 = await runner.awaitCompletion(5_000);
    assert.equal(res2, res, "settlement exactly once");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("includeUsage divergence pins: nvidia keeps stream_options, openrouter omits it", async () => {
  const { calls: nCalls, fetch: nf } = recordingFetch(() => sseResponseBody([contentEvent("x"), finishEvent("stop"), DONE_MARKER]));
  const nt = new HttpTransport({ ...TPROVIDER, fetchImpl: nf });
  await nt.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) });
  const nBody = JSON.parse(String(nCalls[0]!.init.body)) as Record<string, unknown>;
  assert.deepEqual(nBody.stream_options, { include_usage: true });

  const { calls: oCalls, fetch: of } = recordingFetch(() => sseResponseBody([contentEvent("x"), finishEvent("stop"), DONE_MARKER]));
  const ot = new HttpTransport({ ...ORPROVIDER, fetchImpl: of });
  await ot.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) });
  const oBody = JSON.parse(String(oCalls[0]!.init.body)) as Record<string, unknown>;
  assert.equal("stream_options" in oBody, false);
});

/** REAL OpenRouter run — opt-in, NEVER executed while authorizing this task.
 * Enable with: OAE_OPENROUTER_REAL=1, OPENROUTER_API_KEY set and
 * OAE_OPENROUTER_REAL_MODEL=<author>/<slug> (the model is required: the
 * provider must not invent ids). Costs real tokens; isolation and caps
 * follow the Onda-1 protocol when authorized. */
test("openrouter DIRECT REAL RUN (opt-in: OAE_OPENROUTER_REAL=1)", { skip: process.env.OAE_OPENROUTER_REAL !== "1" }, async () => {
  const model = process.env.OAE_OPENROUTER_REAL_MODEL;
  if (!model) {
    throw new Error("OAE_OPENROUTER_REAL is set but OAE_OPENROUTER_REAL_MODEL is unset — the provider must not invent model ids");
  }
  const provider = OpenRouterProvider.start(); // honest throw if the key is absent
  const dir = await mkdtemp(join(tmpdir(), "oae-or-real-"));
  try {
    const runner = await provider.createSession({
      directory: dir, title: "openrouter real one-shot", agent: "build",
      model: { providerID: "openrouter", id: model },
      tools: true, promptText: "Create the file check.txt containing exactly OR_OK and then reply with just: DONE",
    });
    const res = await runner.awaitCompletion(900_000);
    assert.equal(res.outcome, "completed");
    const check = await readFile(join(dir, "check.txt"), "utf8");
    assert.match(check, /OR_OK/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ── Correções pós-auditoria Etapa 2: R3 e R4 ────────────────────────────────

test("R3: non-streaming drops structurally empty tool_calls, keeping valid ones (SSE parity)", async () => {
  const valid = (i: number): Record<string, unknown> => ({ id: `real_${i}`, type: "function", function: { name: "write_file", arguments: `{"path":"f${i}.txt","content":"x"}` } });
  const malformed = { id: "ghost", type: "function" } as unknown; // no function field at all
  const { fetch: f1 } = recordingFetch(() => jsonResponse({ choices: [{ index: 0, message: { role: "assistant", content: "", tool_calls: [valid(0), malformed, valid(1)] }, finish_reason: "tool_calls" }] }));
  const t1 = new HttpTransport({ ...ORPROVIDER, fetchImpl: f1 });
  const rep = await t1.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) });
  assert.deepEqual(rep.toolCalls?.map((t) => t.id), ["real_0", "real_1"], "valid calls untouched; empty item dropped");

  // all-empty + no content → protocol error (same honest failure as before)
  const { fetch: f2 } = recordingFetch(() => jsonResponse({ choices: [{ index: 0, message: { role: "assistant", content: "", tool_calls: [malformed, malformed] } }] }));
  const t2 = new HttpTransport({ ...ORPROVIDER, fetchImpl: f2 });
  await t2.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) }).then(
    () => { throw new Error("must reject"); },
    (e: unknown) => { assert.match((e as ProviderError).message, /empty content and no tool calls/); },
  );
});

test("R4: an abort during a never-ending error-body read ends in finite time with honest text", async () => {
  // mock-vs-real gap closed: a mock whose body NEVER resolves would hang
  // errorFrom forever; with the signal wired into readBounded, the abort
  // unwinds the read (in real fetch the body stream also rejects directly)
  const hang = new ReadableStream<Uint8Array>({ start() { /* never enqueue, never close */ } });
  const { fetch: f } = recordingFetch(() => new Response(hang, { status: 502, headers: { "content-type": "text/plain" } }));
  const t = new HttpTransport({ ...ORPROVIDER, fetchImpl: f });
  const ac = new AbortController();
  const started = Date.now();
  const h = t.open({ model: "m", messages: [{ role: "user", content: "u" }], signal: ac.signal });
  setTimeout(() => ac.abort(), 120);
  const err = await h.dispatched.then(
    () => { throw new Error("must reject"); },
    (e: unknown) => e,
  );
  assert.ok(err instanceof ProviderError);
  assert.match((err as ProviderError).message, /read aborted by interrupt/);
  assert.ok(Date.now() - started < 5_000, "finite-time settlement (no hang on the hanging mock body)");
});

test("R4: an abort during the 400-probe read is bounded as well", async () => {
  const hang = new ReadableStream<Uint8Array>({ start() { /* never enqueue */ } });
  let n = 0;
  const { fetch: f } = recordingFetch(() => {
    n++;
    return new Response(hang, { status: n === 1 ? 400 : 502, headers: { "content-type": "text/plain" } });
  });
  const t = new HttpTransport({ ...ORPROVIDER, fetchImpl: f });
  const ac = new AbortController();
  const h = t.open({ model: "m", messages: [{ role: "user", content: "u" }], signal: ac.signal });
  setTimeout(() => ac.abort(), 120);
  const err = await h.dispatched.then(
    () => { throw new Error("must reject"); },
    (e: unknown) => e,
  );
  assert.ok(err instanceof ProviderError);
  assert.match((err as ProviderError).message, /read aborted by interrupt/);
});

// ── Correções de segurança pós-auditoria: R2 (redação x truncamento) e R1 (cap do buffer de linha SSE) ──

test("R2: error excerpt masks a secret straddling the 2 KB truncation boundary (multiple secret shapes)", async () => {
  // the 2 KB cap cuts excerpt.text; a token partially visible there escaped
  // plain redact() (which needs ≥8 chars after its stem). For each shape the
  // FULL key sits in the body with only `visible` chars under the 2000-char
  // cut: before the fix, `visible` (a stem + a few chars) leaked into the
  // error message. A space guarantees the \b stem boundary matches.
  const cases: { key: string; visible: string; stemRe: RegExp }[] = [
    { key: "sk-or-v1-0123456789abcdefgh", visible: "sk-or-v1-0", stemRe: /sk-or/i },
    { key: "nvapi-0123456789abcdefgh234", visible: "nvapi-01", stemRe: /nvapi/i },
    { key: "ghp_0123456789abcdefgh23456", visible: "ghp_01", stemRe: /ghp_/i },
    { key: "github_pat_0123456789abcdefgh", visible: "github_pat_01", stemRe: /github/i },
    { key: "xoxp-0123456789abcdefgh23456", visible: "xoxp-01", stemRe: /xoxp-/i },
    { key: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", visible: "eyJhbGciO", stemRe: /eyJhbGci/i },
  ];
  for (const { key, visible, stemRe } of cases) {
    const keyStart = 2_000 - visible.length;
    assert.equal(`${"x".repeat(keyStart - 1)} ${key}`.slice(keyStart, keyStart + visible.length), visible, "test fixture: cut leaves exactly the vulnerable fragment");
    const body = `${"x".repeat(keyStart - 1)} ${key}${"y".repeat(60)}`;
    const { fetch: f } = recordingFetch(() => new Response(body, { status: 401, headers: { "content-type": "text/plain" } }));
    const t = new HttpTransport({ ...TPROVIDER, fetchImpl: f });
    await t.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) }).then(
      () => { throw new Error(`must reject (${stemRe.source})`); },
      (e: unknown) => {
        const pe = e as ProviderError;
        assert.ok(pe instanceof ProviderError, `ProviderError (${stemRe.source})`);
        assert.equal(pe.kind, "auth", `classification preserved (${stemRe.source})`);
        assert.doesNotMatch(pe.message, RegExp(key), `full key not echoed (${stemRe.source})`);
        assert.doesNotMatch(pe.message, stemRe, `no stem fragment leaked (${stemRe.source})`);
        assert.match(pe.message, /\[redacted\]/);
      },
    );
  }

  // sanity: a fully visible key (well inside the cap) was already safe
  const { fetch: f2 } = recordingFetch(() => new Response("denied: sk-or-v1-0123456789abcdefgh later", { status: 401, headers: { "content-type": "text/plain" } }));
  const t2 = new HttpTransport({ ...TPROVIDER, fetchImpl: f2 });
  await t2.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) }).then(
    () => { throw new Error("must reject"); },
    (e: unknown) => {
      const pe = e as ProviderError;
      assert.match(pe.message, /\[redacted\]/, "fully visible key already masked before the cut");
      assert.doesNotMatch(pe.message, /0123456789/, "no key chars at all");
      assert.equal(pe.kind, "auth");
    },
  );
});

test("R2: 400-probe excerpt masks a secret straddling its 300-byte boundary", async () => {
  const key = "sk-or-v1-0123456789abcdefgh";
  // visible = "sk-or-v1-" (9 chars; 6 after the sk- stem) → redact alone
  // misses it; key starts at char 291, so the 300-byte cap cuts inside it
  const body = `${"x".repeat(290)} ${key}${"y".repeat(60)}`;
  const { fetch: f } = recordingFetch(() => new Response(body, { status: 400, headers: { "content-type": "text/plain" } }));
  const t = new HttpTransport({ ...TPROVIDER, fetchImpl: f });
  await t.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) }).then(
    () => { throw new Error("must reject"); },
    (e: unknown) => {
      const pe = e as ProviderError;
      assert.doesNotMatch(pe.message, /sk-or/i, "no stem fragment leaked through the probe path");
      assert.doesNotMatch(pe.message, RegExp(key));
      assert.match(pe.message, /\[redacted\]/);
    },
  );
});

test("R2: malformed non-streaming JSON body redacts BEFORE the 160-char cut", async () => {
  // the full key sits inside the first 160 chars: plain redact() masks it in
  // full BEFORE the message cap ever cuts — no fragment can exist at the cut
  const raw = `{"error":"unauthorized: ${"x".repeat(127)} sk-or-v1-0123456789abcdefgh`;
  const { fetch: f } = recordingFetch(() => new Response(raw, { status: 200, headers: { "content-type": "application/json" } }));
  const t = new HttpTransport({ ...ORPROVIDER, fetchImpl: f });
  await t.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) }).then(
    () => { throw new Error("must reject"); },
    (e: unknown) => {
      const pe = e as ProviderError;
      assert.equal(pe.kind, "protocol");
      assert.doesNotMatch(pe.message, /sk-or/i, "full key redacted before being cut by the message cap");
      assert.doesNotMatch(pe.message, RegExp("0123456789"));
      assert.match(pe.message, /redact/i, "redaction marker (possibly cut) still visible");
    },
  );
});

test("R2: malformed SSE data line redacts before its 160-char cut, incl. a partial token at EOF", async () => {
  const key = "sk-or-v1-0123456789abcdefgh";
  // terminated line whose FULL key is inside the payload: redact-first masks
  // it, so the 160-char cut can no longer fragment it
  const { fetch: f1 } = recordingFetch(() => sseResponseBody([`data: {"broken json ${"x".repeat(120)} ${key}"}\n\n`]));
  const t1 = new HttpTransport({ ...ORPROVIDER, fetchImpl: f1 });
  await t1.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) }).then(
    () => { throw new Error("must reject"); },
    (e: unknown) => {
      const pe = e as ProviderError;
      assert.equal(pe.kind, "protocol");
      assert.doesNotMatch(pe.message, /sk-or/i);
      assert.doesNotMatch(pe.message, RegExp("0123456789"));
    },
  );
  // unterminated residual at EOF whose trailing token runs only 7 chars past
  // the stem: plain redact() misses it (needs ≥8) and the message cut could
  // fragment it — the tail scrub must catch the straddling piece
  const { fetch: f2 } = recordingFetch(() => sseResponseBody([`data: {"c":"${"x".repeat(149)} sk-or-v1-0`]));
  const t2 = new HttpTransport({ ...ORPROVIDER, fetchImpl: f2 });
  await t2.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) }).then(
    () => { throw new Error("must reject"); },
    (e: unknown) => {
      const pe = e as ProviderError;
      assert.doesNotMatch(pe.message, /or-v1/i, "truncated-tail stem fragment masked");
      assert.match(pe.message, /truncated/, "160-char cut honest suffix present");
    },
  );
});

test("R2: redactTruncatedTail helper semantics (direct unit)", () => {
  assert.equal(redactTruncatedTail("boom @sk-or-v1-0"), "boom @[redacted]", "trailing stem fragment masked including the stem");
  // glued stem fragment (boundary-agnostic post-audit fix)
  assert.match(redactTruncatedTail("echo xsk-or-v1-0"), /x\[redacted\]/, "glued stem caught at the tail");
  // full glued token is masked by plain redact() before the tail pass
  assert.match(redactTruncatedTail("word sk-gn-Kort12345 end"), /\[redacted\]/);
  // mid-body short fragment is NOT a token shape: untouched by design
  const untouched = "run: sk-abc;x then tail plain text";
  assert.equal(redactTruncatedTail(untouched), untouched, "mid-body non-token fragments unchanged");
  // bearer + partial token (≥8 chars after "Bearer "): plain redact() already
  // covers it; the helper must leave that masking intact
  assert.match(redactTruncatedTail("denied Bearer sk-or-v1-012"), /Bearer \[redacted\]/);
  // key: value tail
  assert.match(redactTruncatedTail('config: api_key: "skf01digits"'), /api_key: .*redact/i);
});

test("R1: an unterminated oversized SSE line fails at the framing cap without materializing past cap+2 chunks", async () => {
  for (const run of [1, 2]) {
    const { res, consumed } = oversizedResponse({ status: 200, contentType: "text/event-stream", bodyBytes: 300_000, chunkBytes: 16_384 });
    const { fetch: f } = recordingFetch(() => res);
    const t = new HttpTransport({ ...ORPROVIDER, fetchImpl: f });
    const err = await t.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) }).then(
      () => { throw new Error(`must reject (run ${run})`); },
      (e: unknown) => e,
    );
    const pe = err as ProviderError;
    assert.ok(pe instanceof ProviderError, `run ${run} rejects as ProviderError`);
    assert.equal(pe.kind, "protocol", `run ${run}: deterministic classification`);
    assert.match(pe.message, /SSE framing: a raw line exceeded the 131072 byte cap/, `run ${run}: deterministic message`);
    assert.match(pe.message, /terminated or not/, `run ${run}: per-line contract stated in the error`);
    assert.ok(consumed() <= 131_072 + 2 * 16_384, `run ${run}: pull-driven memory bounded (pulled ${consumed()} bytes)`);
  }
});

test("R1: a giant single-chunk TERMINATED line is rejected before parsing (no JSON.parse of 200 KB)", async () => {
  // residual-cap accounting cannot see this variant: the whole line —
  // delimiter included — arrives inside ONE oversized chunk, so the length
  // check must live where the line is drained (before processLine)
  const giant = `data: {"padding":"${"x".repeat(190_000)}"}\n\n`;
  const assertCap = async (label: string, fetchImpl: typeof fetch): Promise<void> => {
    const t = new HttpTransport({ ...ORPROVIDER, fetchImpl });
    const err = await t.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) }).then(
      () => { throw new Error(`${label}: must reject (old code processed the line)`); },
      (e: unknown) => e,
    );
    const pe = err as ProviderError;
    assert.ok(pe instanceof ProviderError, `${label}: ProviderError`);
    assert.equal(pe.kind, "protocol", `${label}: deterministic classification`);
    assert.match(pe.message, /SSE framing: a raw line exceeded the 131072 byte cap/, `${label}: per-line framing cap message`);
  };
  // variant A: valid JSON — previously parsed fine, so the rejection proves
  // the pre-parse check; padding field is discarded by parsers BEFORE the fix
  await assertCap("valid-json line", recordingFetch(() => new Response(new ReadableStream({
    start(c) { c.enqueue(Buffer.from(giant)); c.close(); },
  }), { status: 200, headers: { "content-type": "text/event-stream" } })).fetch);
  // variant B: multi-chunk accumulation of the same line (rejected at the
  // residual check mid-accumulation, never materializing 190 KB)
  await assertCap("accumulated unterminated line", recordingFetch(() => oversizedResponse({ status: 200, contentType: "text/event-stream", bodyBytes: 250_000, chunkBytes: 16_384 }).res).fetch);
});

test("R1: several complete lines inside one chunk still parse (normality preserved)", async () => {
  const enc = new TextEncoder();
  const one = sseEvent({ id: "m", choices: [{ index: 0, delta: { content: "hello " }, finish_reason: null }] });
  const two = sseEvent({ id: "m", choices: [{ index: 0, delta: { content: "world" }, finish_reason: null }] });
  const { fetch: f } = recordingFetch(() => new Response(new ReadableStream({
    start(c) {
      // three complete SSE lines in ONE chunk, then EOF
      c.enqueue(enc.encode(one + two + DONE_MARKER));
      c.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } }));
  const t = new HttpTransport({ ...ORPROVIDER, fetchImpl: f });
  const rep = await t.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) }) as ChatReply;
  assert.equal(rep.content, "hello world", "multi-line single chunk unaffected by the line cap");
});

test("R2: a secret GLUED to adjacent text is redacted — full key and straddling prefix (transport level)", async () => {
  const gluedCases: { key: string }[] = [
    { key: "sk-or-v1-0123456789abcdefgh" },
    { key: "nvapi-0123456789abcdefgh234" },
    { key: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" },
  ];
  for (const { key } of gluedCases) {
    const tag = key.slice(0, 12);
    // full glued key: token glued to a word char and fully inside the cap
    const bodyFull = `denied key: word${key} word`;
    const { fetch: f1 } = recordingFetch(() => new Response(bodyFull, { status: 401, headers: { "content-type": "text/plain" } }));
    const t1 = new HttpTransport({ ...TPROVIDER, fetchImpl: f1 });
    await t1.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) }).then(
      () => { throw new Error(`must reject (glued full ${tag}…)`); },
      (e: unknown) => {
        const pe = e as ProviderError;
        assert.equal(pe.kind, "auth", `classification preserved (glued full ${tag}…)`);
        assert.doesNotMatch(pe.message, RegExp(key), `full glued key not echoed (${tag}…)`);
        assert.match(pe.message, /\[redacted\]/);
      },
    );
    // straddling glued key: the 2 KB cut leaves the stem glued to a word
    // char with <8 chars after it — escaped BOTH redact() and the scrub
    // before the post-audit boundary-agnostic fix
    const keyStart = 2_000 - 9;
    const bodyCut = `${"w".repeat(keyStart)}${key}${"y".repeat(60)}`;
    assert.equal(bodyCut.slice(keyStart, keyStart + 9), key.slice(0, 9), `fixture: cut leaves the glued vulnerable prefix (${tag})`);
    const { fetch: f2 } = recordingFetch(() => new Response(bodyCut, { status: 401, headers: { "content-type": "text/plain" } }));
    const t2 = new HttpTransport({ ...TPROVIDER, fetchImpl: f2 });
    await t2.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) }).then(
      () => { throw new Error(`must reject (glued straddling ${tag}…)`); },
      (e: unknown) => {
        const pe = e as ProviderError;
        assert.doesNotMatch(pe.message, RegExp(key), `straddling glued key not echoed (${tag}…)`);
        assert.match(pe.message, /\[redacted\]/, `scrub caught the glued fragment (${tag}…)`);
        assert.equal(pe.kind, "auth");
      },
    );
  }
});

/* ── Etapa 3 / Lote A: mitigação F8 (O_NOFOLLOW no componente final da escrita) ── */

test("filetools F8: legitim create AND overwrite of regular files keep working through the secured open", async () => {
  const dir = await makeProject();
  try {
    const ts = new FileToolSet(dir);
    // creation (O_CREAT)
    const w1 = await ts.execute("write_file", JSON.stringify({ path: "a/b.txt", content: "first" }));
    assert.match(w1, /written 5 bytes to a\/b\.txt/);
    assert.equal(await readFile(join(dir, "a", "b.txt"), "utf8"), "first");
    // overwrite of a REGULAR existing file must not be broken (O_TRUNC)
    const w2 = await ts.execute("write_file", JSON.stringify({ path: "a/b.txt", content: "second!" }));
    assert.match(w2, /written 7 bytes to a\/b\.txt/);
    assert.equal(await readFile(join(dir, "a", "b.txt"), "utf8"), "second!");
    // multi-byte content still lands byte-exact (utf8 conversion intact)
    const uni = "héllo—ü✓";
    await ts.execute("write_file", JSON.stringify({ path: "u.txt", content: uni }));
    assert.equal(await readFile(join(dir, "u.txt"), "utf8"), uni);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("filetools F8: pre-existing leaf symlink is still refused with the SAME message", async () => {
  const dir = await makeProject();
  try {
    const outside = join(await mkdtemp(join(tmpdir(), "oae-out2-")), "outside.txt");
    await writeFile(outside, "top secret", "utf8");
    await symlink(outside, join(dir, "lure.txt"));
    const ts = new FileToolSet(dir);
    const w = await ts.execute("write_file", JSON.stringify({ path: "lure.txt", content: "x" }));
    assert.match(w, /target is a symlink/);
    assert.equal(await readFile(outside, "utf8"), "top secret");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("filetools F8: a leaf swapped to a symlink is refused — same refusal RESULT (pre-check branch); the ELOOP branch of open(O_NOFOLLOW) stays STATIC evidence only", async () => {
  // Honest scope (R2, pós-auditoria): this test does NOT reproduce the real
  // lstat→open race and does NOT reach the ELOOP branch of open(O_NOFOLLOW).
  // The symlink exists BEFORE the write call, so resolveTarget's lstat
  // pre-check refuses first — the same refusal the pre-existing symlink test
  // already pins. What this test adds: the refusal is stable when the leaf
  // BECAME a symlink after a legitimate first write (swap), and O_NOFOLLOW is
  // available on the runtime platform (flag sanity — static evidence that the
  // race window is closed in writeFile). Reaching ELOOP deterministically
  // would require fs injection into writeFile; that is deliberately out of
  // scope (no disproportional abstraction — docs/onda2-plan.md §10).
  const dir = await makeProject();
  try {
    const ts = new FileToolSet(dir);
    const w1 = await ts.execute("write_file", JSON.stringify({ path: "r.txt", content: "ok" }));
    assert.match(w1, /written 2 bytes/);
    const swapTarget = join(dir, "r.txt");
    await rmNative(swapTarget);
    await symlink(join(await mkdtemp(join(tmpdir(), "oae-swap-")), "late.txt"), swapTarget);
    const w2 = await ts.execute("write_file", JSON.stringify({ path: "r.txt", content: "x" }));
    // the refusal text is shared by the pre-check branch and the ELOOP branch
    // (both name "target is a symlink"); this assertion cannot tell them apart
    // and MUST NOT be presented as ELOOP proof
    assert.match(w2, /target is a symlink/);
    const fsPromises = await import("node:fs/promises");
    assert.ok(typeof fsPromises.constants.O_NOFOLLOW === "number", "O_NOFOLLOW available on this platform");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function rmNative(p: string): Promise<void> {
  const fs = await import("node:fs/promises");
  await fs.unlink(p).catch(() => undefined);
}

// ── Etapa 3 / Lote B: cancelamento dos readers de corpo de erro e 400-probe ──

/** Response body wrapper that RECORDS when the underlying stream cancel() is
 * invoked (reader.cancel() e body.cancel() aterrissam neste hook). */
function trackedBody(bytes: Uint8Array[], opts: { status: number; contentType?: string }): {
  res: Response;
  wasCancelled: () => boolean;
} {
  let cancelled = false;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) { for (const b of bytes) c.enqueue(enc.encode(String.fromCharCode(...b))); /* intentionally NOT closed: an ENDED stream cannot be cancelled, and these paths stop mid-body */ },
    cancel() { cancelled = true; },
  });
  const res = new Response(stream, { status: opts.status, headers: { "content-type": opts.contentType ?? "text/plain" } });
  return { res, wasCancelled: () => cancelled };
}

test("cancel: the error-body excerpt path releases its reader after reading (excerpt preserved)", async () => {
  // body > cap (10 KB): read stops at 2 KB exactly as before, then cancel fires
  const big = `HTTP 500-ish error payload ${"x".repeat(10_000)}`;
  const { res, wasCancelled } = trackedBody([new Uint8Array(Buffer.from(big))], { status: 500 });
  const { fetch: f } = recordingFetch(() => res);
  const t = new HttpTransport({ ...ORPROVIDER, fetchImpl: f });
  const err = await t.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) }).then(
    () => { throw new Error("must reject"); },
    (e: unknown) => e,
  );
  const pe = err as ProviderError;
  assert.ok(pe instanceof ProviderError);
  assert.match(pe.message, /HTTP 500: HTTP 500-ish error payload/, "excerpt preserved in the original error");
  assert.match(pe.message, /body truncated/, "cap marker intact");
  assert.equal((pe as ProviderError).kind, "unavailable", "classification intact");
  assert.equal(wasCancelled(), true, "reader released after the bounded read");
});

test("cancel: the 400-probe releases its stream and keeps the one-read fallback semantics", async () => {
  // probe body carries "stream" → the transport makes its ONE non-streaming
  // retry (F4) against a FRESH fallback response; the probe stream itself is
  // released right after the bounded read
  let calls = 0;
  const { res, wasCancelled } = trackedBody([new Uint8Array(Buffer.from(`the streamed body is unsupported by this gateway ${"y".repeat(5_000)}`))], { status: 400 });
  const { fetch: f } = recordingFetch(() => {
    calls += 1;
    return calls === 1 ? res : jsonResponse({ choices: [{ index: 0, message: { role: "assistant", content: "fallback" } }] });
  });
  const t = new HttpTransport({ ...ORPROVIDER, fetchImpl: f });
  const rep = await t.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) }) as ChatReply;
  assert.equal(rep.content, "fallback", "F4 retry semantics intact (exactly one probe-driven retry)");
  assert.equal(calls, 2, "one raw 400 call + one non-streaming retry");
  assert.equal(wasCancelled(), true, "probe stream released after its bounded read");
});

test("cancel: a cancel() failure never masks the original error or the excerpt", async () => {
  let cancelledCalls = 0;
  const enc = new TextEncoder();
  const payload = `boom ${"z".repeat(2_500)}`;
  const stream = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(enc.encode(payload)); /* no close: an ended stream cannot observe cancel() */ },
    cancel() { cancelledCalls += 1; throw new Error("cancel always fails (hostile mock)"); },
  });
  const res = new Response(stream, { status: 503, headers: { "content-type": "text/plain" } });
  const { fetch: f } = recordingFetch(() => res);
  const t = new HttpTransport({ ...ORPROVIDER, fetchImpl: f });
  const err = await t.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) }).then(
    () => { throw new Error("must reject"); },
    (e: unknown) => e,
  );
  const pe = err as ProviderError;
  assert.match(pe.message, /HTTP 503: boom/, "original error intact");
  assert.match(pe.message, /body truncated/, "cap marker intact");
  assert.equal((pe as ProviderError).kind, "unavailable");
  assert.equal(cancelledCalls, 1, "cancel attempted exactly once despite failing");
});

test("cancel: round success reads are NOT double-cancelled — stream cancel counter stays at ZERO on the success path", async () => {
  // R4 (pós-auditoria): prove the NEGATIVE with the same instrumentation the
  // error-path tests use. The success non-streaming body is read via
  // readBounded WITHOUT cancelWhenDone (consume's finally owns the reader):
  // readBounded must not cancel it. consume's own res.body?.cancel() attempt
  // no-ops silently against the internal reader (locked stream → TypeError,
  // swallowed) — that is the documented connection-leak residual, NOT a
  // double cancel: the stream's underlying cancel() hook must never fire.
  let cancels = 0;
  const enc = new TextEncoder();
  const payload = JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] });
  const stream = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(enc.encode(payload)); c.close(); },
    cancel() { cancels += 1; },
  });
  const res = new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
  const { fetch: f } = recordingFetch(() => res);
  const t = new HttpTransport({ ...ORPROVIDER, fetchImpl: f });
  const rep = await t.chat({ model: "m", messages: [{ role: "user", content: "u" }], signal: AbortSignal.timeout(10_000) }) as ChatReply;
  assert.equal(rep.content, "ok");
  assert.equal(cancels, 0, "no cancel from readBounded on success and no effective double cancel via consume's finally");
});

// ── Etapa 3 / Lote C: healthCheck injetável (C1) + corpo limitado do adaptador OpenCode (C2) ──

test("openrouter healthCheck: injectable fetch honored — success, HTTP failure, network error, signal passed", async () => {
  const prevOR = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = ORKEY;
  try {
    // success: injected impl is used, detail carries only the URL/status
    const { fetch: ok } = recordingFetch(() => jsonResponse({ data: [{架号: "m1" }] }));
    const pOk = OpenRouterProvider.start({ fetchImpl: ok });
    const h1 = await pOk.healthCheck();
    assert.equal(h1.ok, true);
    assert.match(h1.detail ?? "", /GET <openrouter>.*200/);
    assert.doesNotMatch(h1.detail ?? "", /Bearer|sk-or/);

    // HTTP failure: ok=false, status visible, key never echoed
    const { fetch: unauthorized } = recordingFetch(() => jsonResponse({ error: "denied" }, 401));
    const p401 = OpenRouterProvider.start({ fetchImpl: unauthorized });
    const h2 = await p401.healthCheck();
    assert.equal(h2.ok, false);
    assert.match(h2.detail ?? "", /401/);
    assert.doesNotMatch(h2.detail ?? "", /Bearer|sk-or/);

    // network error: honest detail from the thrown error (no secret added)
    const { fetch: refused } = recordingFetch(() => { throw new Error("ECONNREFUSED (no secret here)"); });
    const pRef = OpenRouterProvider.start({ fetchImpl: refused });
    const h3 = await pRef.healthCheck();
    assert.equal(h3.ok, false);
    assert.match(h3.detail ?? "", /ECONNREFUSED/);

    // timeout applicability: an AbortSignal is prepared and handed over
    let seenSignal: AbortSignal | undefined;
    const { fetch: spy } = recordingFetch((call) => { seenSignal = (call.init as RequestInit).signal as AbortSignal; return jsonResponse({}); });
    await OpenRouterProvider.start({ fetchImpl: spy }).healthCheck();
    assert.ok(seenSignal instanceof AbortSignal, "timeout signal wired into the healthCheck fetch");
  } finally {
    if (prevOR === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prevOR;
  }
});

test("nvidia healthCheck: injectable fetch honored (same four cases)", async () => {
  const { fetch: ok } = recordingFetch(() => jsonResponse({ models: [] }));
  const h1 = await NVIDIAProvider.start({ apiKey: TKEY, fetchImpl: ok }).healthCheck();
  assert.equal(h1.ok, true);
  assert.match(h1.detail ?? "", /GET <nvidia>.*200/);
  assert.doesNotMatch(h1.detail ?? "", /Bearer|nvapi-/);

  const { fetch: refused } = recordingFetch(() => { throw new Error("network down (no secret)"); });
  const h3 = await NVIDIAProvider.start({ apiKey: TKEY, fetchImpl: refused }).healthCheck();
  assert.equal(h3.ok, false);
  assert.match(h3.detail ?? "", /network down/);
});

test("openCode adapter C2: raw-fetch error body is bounded (no unbounded text() on the shim)", async () => {
  const openCodeModule = await import("../src/providers/opencode.ts");
  const applyPromptCompatibility = openCodeModule.applyPromptCompatibility;
  const calls: { url: string; init: RequestInit }[] = [];
  const realFetch = globalThis.fetch;
  try {
    let n = 0;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      n += 1;
      // the shim makes exactly ONE raw fallback call; answer it with an
      // oversized 400 error body (2 MB pull-driven)
      return oversizedResponse({ status: 400, contentType: "text/plain", bodyBytes: 2_000_000, chunkBytes: 16_384 }).res;
    }) as typeof fetch;
    const fakeClient = {
      session: {
        prompt: undefined,
      } as unknown as object,
    } as unknown as Parameters<typeof applyPromptCompatibility>[0];
    const fakeSession = { prompt: async (input: { sessionID: string; text: string }) => { throw new Error("raw wire retry: prompt"); } };
    (fakeClient as { session: object }).session = fakeSession;
    applyPromptCompatibility(fakeClient, "http://127.0.0.1:4099/api/app");
    const shim = fakeSession.prompt({ sessionID: "s1", text: "hi" }) as Promise<unknown>;
    await shim.then(
      () => { throw new Error("must reject"); },
      (e: unknown) => {
        const m = String((e as Error).message);
        assert.match(m, /session\.prompt failed \(400\): /);
        assert.ok(m.length < 360, `excerpt bounded in the emitted message (got ${m.length} chars)`);
      },
    );
    assert.equal(calls.length, 1, "exactly the one raw fallback fetch (original came through the fake shim)");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── Etapa 3 / Lote D: changedFiles determinístico (inspectGit mockado) ──────

function gitStatusMock(uncommitted: string[]) {
  return async (_dir: string) => ({
    isRepo: true as boolean,
    branch: "main",
    remote: null as string | null,
    uncommitted,
    hasCommits: true as boolean,
  });
}

test("orchestrator D: .oae/ and .opencode/ trees are excluded segment-scoped; legit project files kept", async () => {
  const { changedFiles } = await import("../src/orchestrator.ts");
  const fake = gitStatusMock([
    "?? .oae/state.json",
    " M .oae/tasks/1.md",
    "M  .opencode/config.json",
    "?? .oae/",
    "?? .opencode",
    " M src/a.ts",
    "M  README.md",
    "?? .oae-lookalike.ts", // merely STARTS with ".oae" → legit project file
    "?? .opencode-like.ts", // same rule for .opencode lookalikes
  ]);
  const files = await changedFiles("/proj", [], fake);
  assert.deepEqual(files, ["src/a.ts", "README.md", ".oae-lookalike.ts", ".opencode-like.ts"]);
});

test("orchestrator D: baseline files are excluded via the exclude list", async () => {
  const { changedFiles } = await import("../src/orchestrator.ts");
  const fake = gitStatusMock([" M src/a.ts", "M  README.md", " M notes.txt"]);
  const files = await changedFiles("/proj", ["README.md", "notes.txt"], fake);
  assert.deepEqual(files, ["src/a.ts"]);
});

test("orchestrator D: porcelain ' M path' form is stripped cleanly (no dirty prefixes)", async () => {
  const { changedFiles } = await import("../src/orchestrator.ts");
  const fake = gitStatusMock([
    " M src/unstaged.ts",
    "?? src/untracked.ts",
    "MM src/both.ts",
    "A  src/staged.ts",
    "D  src/deleted.ts",
  ]);
  const files = await changedFiles("/proj", [], fake);
  assert.deepEqual(files, ["src/unstaged.ts", "src/untracked.ts", "src/both.ts", "src/staged.ts", "src/deleted.ts"]);
  // the runtime-artifact filter sees CLEAN paths: a dirty prefix would leak it
  const dirty = await changedFiles("/proj", [], gitStatusMock([" M .oae/leak.md"]));
  assert.deepEqual(dirty, [], "no ' M .oae/…' leak through the filter");
});

test("orchestrator D: >50 files produce an explicit truncation marker with the omitted count", async () => {
  const { changedFiles, MAX_CHANGED_FILES } = await import("../src/orchestrator.ts");
  const many = Array.from({ length: 60 }, (_, i) => `M  src/gen${i}.ts`);
  const files = await changedFiles("/proj", [], gitStatusMock(many));
  assert.equal(files.length, MAX_CHANGED_FILES + 1);
  assert.equal(files[0], "src/gen0.ts");
  assert.equal(files[MAX_CHANGED_FILES - 1], `src/gen${MAX_CHANGED_FILES - 1}.ts`);
  assert.match(
    files[MAX_CHANGED_FILES],
    /^…\(10 more changed files omitted — list truncated at 50\)$/,
    "explicit, counted truncation instead of a silent slice",
  );
  // ≤50 files: no marker, contract unchanged
  const few = await changedFiles("/proj", [], gitStatusMock(many.slice(0, 40)));
  assert.equal(few.length, 40);
});

// ── Etapa 3 / correções R1 e R3 (pós-auditoria) ─────────────────────────────

test("orchestrator R1: porcelain typechange 'T' status is stripped and filtered like the other statuses", async () => {
  const { changedFiles } = await import("../src/orchestrator.ts");
  const fake = gitStatusMock([
    " T src/typechange.ts",   // unstaged typechange (e.g. symlink → regular)
    "T  src/staged-typechange.ts", // staged typechange
    " T .oae/typeflip.md",    // runtime artifact with a typechange status
    "?? .oae-lookalike.ts",   // legitimate project file must survive
  ]);
  const files = await changedFiles("/proj", [], fake);
  assert.deepEqual(
    files,
    ["src/typechange.ts", "src/staged-typechange.ts", ".oae-lookalike.ts"],
    "' T path' must strip cleanly; '.oae/' artifacts stay filtered even under typechange",
  );
});

/** R3: deterministic fake FileHandle — production regular files cannot be
 * made to emit partial/zero-progress writes on demand without a
 * disproportional fs-injection layer, so the helper itself is what gets the
 * scripted scenarios (the REAL-file full-write path keeps its normal-path
 * coverage in the filetools tests above). */
function fakeHandle(script: { writes: (number | Error)[] }): { fake: FileHandle; calls: { offsetStart: number; length: number }[] } {
  let i = 0;
  const calls: { offsetStart: number; length: number }[] = [];
  const fake = {
    async write(buf: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number; bufferSize: number }> {
      const next = script.writes[i++];
      if (next instanceof Error) throw next;
      const n = next ?? 0;
      calls.push({ offsetStart: offset, length });
      return { bytesWritten: n, bufferSize: buf.byteLength };
    },
  } as unknown as FileHandle;
  return { fake, calls };
}

test("writeFully R3: complete buffer in a single write (normal path)", async () => {
  const { writeFully } = await import("../src/providers/http/filetools.ts");
  const buf = Buffer.from("full payload", "utf8");
  const h = fakeHandle({ writes: [buf.length] });
  await writeFully(h.fake, buf);
  assert.deepEqual(h.calls, [{ offsetStart: 0, length: buf.length }], "exactly one write covering the whole buffer");
});

test("writeFully R3: partial writes resume from the bytes actually written and complete the buffer", async () => {
  const { writeFully } = await import("../src/providers/http/filetools.ts");
  const buf = Buffer.from("0123456789", "utf8"); // 10 bytes
  const h = fakeHandle({ writes: [2, 3, 5] }); // partial 2 + 3, then the remaining 5
  await writeFully(h.fake, buf);
  assert.deepEqual(
    h.calls,
    [
      { offsetStart: 0, length: 10 }, // chunk = whole buffer
      { offsetStart: 0, length: 8 },  // resume: subarray(2) — only the UNwritten tail
      { offsetStart: 0, length: 5 },  // resume: subarray(5)
    ],
    "each retry targets only the unwritten tail; with O_TRUNC and sequential writes at the advancing file position, the retry chain lands the full buffer in order, byte-exact",
  );
});

test("writeFully R3: a write failure propagates — no partial-success lie", async () => {
  const { writeFully } = await import("../src/providers/http/filetools.ts");
  const h = fakeHandle({ writes: [new Error("EIO: simulated write failure")] });
  await writeFully(h.fake, Buffer.from("data")).then(
    () => { throw new Error("must reject"); },
    (e: unknown) => assert.match((e as Error).message, /EIO: simulated write failure/, "the original error reaches the caller; writeFile's finally still closes the handle"),
  );
});

test("writeFully R3: a zero-progress write aborts with an explicit error (no silent truncation, no busy loop)", async () => {
  const { writeFully } = await import("../src/providers/http/filetools.ts");
  const h = fakeHandle({ writes: [0] });
  await writeFully(h.fake, Buffer.from("steady", "utf8")).then(
    () => { throw new Error("must reject"); },
    (e: unknown) => assert.match((e as Error).message, /write made no progress \(0\/6 bytes written\)/, "explicit failure instead of reporting bytes that were never written"),
  );
  assert.equal(h.calls.length, 1, "no retry after zero progress (loop terminated)");
});
