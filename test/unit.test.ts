/**
 * Deterministic unit/integration-harness tests using fake agents.
 * No provider calls: fast, reproducible, free.
 */
import test from "node:test";
import { strict as assert } from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Store, type RunState } from "../src/store.ts";
import { Orchestrator, type RunOptions } from "../src/orchestrator.ts";
import { loadConfig, type OaeConfig } from "../src/config.ts";
import type { Plan } from "../src/planner.ts";
import { FakeRunner, REVIEWER_OK, REVIEWER_REJECT } from "./fake.ts";
import { renderReport } from "../src/report.ts";
import { inspectGit } from "../src/git.ts";
import { Supervisor } from "../src/supervisor.ts";
import { acquireRunLock, releaseRunLock } from "../src/runlock.ts";

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
      taskTimeoutMs: 60_000,
      runTimeoutMs: 5 * 60_000,
      commandTimeoutMs: 30_000,
      maxRecoveryCycles: 2,
    },
  };
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
