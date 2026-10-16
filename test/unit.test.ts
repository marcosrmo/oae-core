/**
 * Deterministic unit/integration-harness tests using fake agents.
 * No provider calls: fast, reproducible, free.
 */
import test from "node:test";
import { strict as assert } from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, stat, readdir, mkdir } from "node:fs/promises";
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
import { inspectGit } from "../src/git.ts";
import { Supervisor } from "../src/supervisor.ts";
import { acquireRunLock, releaseRunLock } from "../src/runlock.ts";
import { OpenCodeRunner, type Client, type SessionUsage, type AgentRunner, type AgentRunResult, type ProgressSignal } from "../src/opencode.ts";
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
    const boom: Client = {
      session: {
        create: async () => { throw new Error("planner session must not be created for small requests"); },
      },
    } as unknown as Client;
    const plan = await makePlan(boom, config, "add a sub() function to index.js");
    assert.equal(plan.tasks.length, 1, "deterministic single-task plan");
    assert.ok(plan.summary.startsWith("Single-task fallback plan"));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("large requests still use the model planner", async () => {
  const dir = await makeProject();
  try {
    const config = fastRecovery(await loadConfig(dir));
    const planJson = { summary: "model plan", tasks: [{ id: "t1", title: "x", instructions: "i", dependsOn: [], acceptance: ["a"] }], decisions: [] };
    const client = stubClient({
      active: async () => ({}) as Record<string, unknown>, // idle on first poll -> completed
      context: async () => ({ data: [
        { type: "assistant", content: [{ type: "text", text: JSON.stringify(planJson) }] },
      ] }),
    });
    const big = "restructure the authentication module across src/auth/*.ts ".repeat(10); // > 200 chars
    const plan = await makePlan(client, config, big);
    assert.equal(plan.summary, "model plan", "model-assisted plan is used for large requests");
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
  assert.equal(cli.includes('process.once("SIGINT"'), false,
    "per-iteration SIGINT registration reintroduced in src/index.ts");
  assert.equal(cli.includes('process.on("SIGINT"'), false,
    "global SIGINT handler reintroduced in src/index.ts");
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
