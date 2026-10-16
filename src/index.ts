#!/usr/bin/env node
/**
 * OAE CLI — entrypoint.
 *
 *   node src/index.ts run "<request>"  --dir <project> [--model providerID/modelID] [--force]
 *   node src/index.ts plan "<request>" --dir <project>
 *   node src/index.ts status --dir <project>
 *   node src/index.ts report --dir <project>
 *   node src/index.ts dashboard --dir <project> [--follow] [--detail]
 *   node src/index.ts history --dir <project>
 *   node src/index.ts init   --dir <project>   (installs .opencode config + skills)
 *   node src/index.ts publish --dir <project> [--repo <name>] [--public]
 *
 * `run`/`plan` hold .oae/run.lock — a second concurrent run in the same
 * directory is refused (anti-recursion, D13). --force overrides a live lock.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sleep } from "./util.ts";
import { loadConfig, defaultConfig } from "./config.ts";
import { Store } from "./store.ts";
import { Orchestrator, type RunOptions } from "./orchestrator.ts";
import { connect } from "./opencode.ts";
import { renderReport } from "./report.ts";
import { inspectGit } from "./git.ts";
import { checkRemote, publish } from "./publish.ts";
import { installIntoProject } from "./setup.ts";
import { acquireRunLock, releaseRunLock, readRunLock } from "./runlock.ts";
import { effectiveStatus, finalizeAbandonedRun, probeOwner, reconcileRun } from "./reconcile.ts";
import { createProgressReporter } from "./progress.ts";
import { loadRunView } from "./viewmodel.ts";
import { renderSummary, renderResultLine, type RenderOptions } from "./dashboard.ts";
import { listRunHistory, type HistoryEntry } from "./history.ts";
import { formatDuration } from "./dashboard.ts";

function arg(name: string, i: number, argv: string[]): string | undefined {
  const idx = argv.indexOf(name);
  return idx >= 0 ? argv[idx + 1] : i >= 0 ? undefined : undefined;
}
function flag(name: string, argv: string[]): boolean {
  return argv.includes(name);
}

const isTTY = process.stdout.isTTY === true;
const renderOpts: RenderOptions = { colors: isTTY, width: isTTY ? Math.min(160, process.stdout.columns ?? 100) : 100 };

function printEventHistory(runs: HistoryEntry[]): void {
  for (const r of runs) {
    const dur = r.durationMs !== undefined ? formatDuration(r.durationMs) : "—";
    const prov = r.provider ? ` · provider: ${[r.provider.http429 ? `429×${r.provider.http429}` : null, r.provider.http401 ? `401×${r.provider.http401}` : null].filter(Boolean).join(", ")}` : "";
    console.log(`${r.source === "current" ? "*" : " "} ${r.id.padEnd(16)} ${r.status.padEnd(8)} ${dur.padEnd(7)} tasks ${r.tasksDone}/${r.tasksTotal}${r.tasksBlocked ? ` (blocked: ${r.tasksBlocked})` : ""}${prov}  ${r.request.slice(0, 46)}`);
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const dir = resolve(arg("--dir", 0, argv) ?? process.cwd());
  const configBase = await loadConfig(dir);

  if (flag("--model", argv)) {
    const m = arg("--model", 0, argv);
    if (m && m.includes("/")) {
      const [providerID, ...rest] = m.split("/");
      configBase.model = { providerID, id: rest.join("/") };
    }
  }

  switch (cmd) {
    case "run": {
      const request = argv.slice(1).filter((a) => !a.startsWith("--") && a !== argv[argv.indexOf("--dir") + 1])[0];
      if (!request) { console.error('usage: oae run "<request>" --dir <project>'); return 2; }
      const config = { ...configBase, concurrency: Number(arg("--concurrency", 0, argv) ?? configBase.concurrency) };
      await mkdir(join(dir, ".oae"), { recursive: true });
      // one run per directory — deterministic anti-recursion backstop (D13)
      const runId = `run-${Date.now().toString(36)}`;
      const lock = await acquireRunLock(dir, runId, { force: flag("--force", argv) });
      if (!lock.ok) { console.error(`oae: refusing to start: ${lock.reason}`); return 3; }

      // Crash safety (Fase 0): an exception inside run() or an interrupt during
      // the run must NEVER leave state.json stuck at "running" for a process
      // that no longer exists — that is exactly how run-mvazafl3 became orphaned.
      let store: Store | undefined;
      let unsubscribe: (() => void) | undefined;
      let finalized = false;
      const finalize = async (reason: string): Promise<void> => {
        if (finalized) return; // idempotent: catch path and signal path can both fire
        finalized = true;
        try { if (store) await finalizeAbandonedRun(store, reason); } catch { /* best effort */ }
      };
      const onSignal = (sig: string) => {
        void finalize(`received ${sig}`).finally(() => {
          void releaseRunLock(dir, runId).finally(() => process.exit(130));
        });
      };
      const onInt = () => onSignal("SIGINT");
      const onTerm = () => onSignal("SIGTERM");
      const onUncaught = (err: unknown) => onSignal(`uncaught exception: ${String((err as Error)?.message ?? err)}`);
      process.once("SIGINT", onInt);
      process.once("SIGTERM", onTerm);
      process.once("uncaughtException", onUncaught);
      try {
        // auto-install the reviewer agent + skills when missing (idempotent)
        try {
          await readFile(join(dir, ".opencode", "opencode.json"), "utf8");
        } catch {
          await installIntoProject(dir);
          console.log(`(oae-reviewer agent + skills installed into ${dir})`);
        }
        store = await Store.create(dir, runId, request);
        // Fase V: live progress for humans. It is driven by REAL persisted
        // events (the subscriber runs after each append) and goes to stderr, so
        // stdout stays the final report; `--quiet` turns it off for scripts.
        if (!flag("--quiet", argv)) {
          unsubscribe = store.onEvent(createProgressReporter({ colors: isTTY }));
        }
        const { client } = await connect();
        const orch = new Orchestrator(client, store, { config, dryRun: flag("--dry-run", argv) });
        const { state } = await orch.run(request);
        const report = await renderReport(store);
        await writeFile(join(dir, ".oae", "REPORT.md"), report, "utf8");
        console.log(report);
        console.log(`\n(report saved: ${join(dir, ".oae", "REPORT.md")})`);
        return state.status === "done" ? 0 : 1;
      } catch (e) {
        await finalize(`run() threw: ${String((e as Error)?.message ?? e)}`);
        throw e;
      } finally {
        unsubscribe?.();
        process.removeListener("SIGINT", onInt);
        process.removeListener("SIGTERM", onTerm);
        process.removeListener("uncaughtException", onUncaught);
        await releaseRunLock(dir, runId);
      }
    }
    case "plan": {
      const request = argv.slice(1).filter((a) => !a.startsWith("--"))[0] ?? "";
      const config = configBase;
      await mkdir(join(dir, ".oae"), { recursive: true });
      const runId = `plan-${Date.now().toString(36)}`;
      const lock = await acquireRunLock(dir, runId, { force: flag("--force", argv) });
      if (!lock.ok) { console.error(`oae: refusing to start: ${lock.reason}`); return 3; }
      try {
        const store = await Store.create(dir, runId, request);
        const { client } = await connect();
        const orch = new Orchestrator(client, store, { config, dryRun: true });
        await orch.run(request);
        console.log(JSON.stringify(store.state.tasks, null, 2));
        return 0;
      } finally {
        await releaseRunLock(dir, runId);
      }
    }
    case "status": {
      const store = await Store.loadLatest(dir);
      if (!store) { console.log("no runs found"); return 1; }
      // owner liveness evidence: a dead owner is never reported as active
      const eff = effectiveStatus(store.state, probeOwner(await readRunLock(dir)));
      for (const t of store.state.tasks) {
        console.log(`${t.id}\t${t.status}\t${t.title}${t.blockedReason ? `\t(${t.blockedReason})` : ""}`);
      }
      console.log(`run: ${eff.status}`);
      if (eff.orphaned) console.log(`  (órfã: ${eff.reason}; rode \`oae reconcile --dir ${dir}\`)`);
      return 0;
    }
    case "dashboard":
    case "watch": {
      const follow = flag("--follow", argv);
      const detail = flag("--detail", argv);
      firstRun: {
        const view = await loadRunView(dir);
        if (!view) { console.log("no runs found"); return 1; }
        if (!follow || !isTTY) {
          // snapshot + result line: CI/redirect-safe, exits immediately
          console.log(renderSummary(view, { ...renderOpts, detail }));
          console.log("");
          console.log(renderResultLine(view, renderOpts));
          break firstRun;
        }
        // follow mode: refresh only on change (no busy repaints), poll the
        // local .oae files at 1s — never the OpenCode service, never an LLM.
        // The wait is a plain sleep: NO signal listeners are registered here
        // (a per-iteration SIGINT handler registration used to leak ~1
        // listener/second and swallowed Ctrl+C) — Ctrl+C keeps Node's default
        // behavior and terminates the process; the .oae state is never
        // touched by that.
        process.stdout.write("\x1b[2J\x1b[H");
        let lastRender = "";
        for (;;) {
          const v = await loadRunView(dir);
          if (v) {
            const text = renderSummary(v, { ...renderOpts, detail }) + "\n\n" + renderResultLine(v, renderOpts);
            if (text !== lastRender) {
              process.stdout.write("\x1b[H\x1b[2J" + text + "\n");
              lastRender = text;
            }
            if (v.status !== "running") {
              process.stdout.write(`\n(entrada encerrada — ${v.status}). Use \`oae history\` para execuções anteriores.\n`);
              return v.status === "done" ? 0 : 1;
            }
          }
          await sleep(1000);
        }
      }
      return 0;
    }
    case "history": {
      const runs = await listRunHistory(dir);
      if (!runs.length) { console.log("no runs found"); return 1; }
      printEventHistory(runs);
      return 0;
    }
    case "report": {
      const store = await Store.loadLatest(dir);
      if (!store) { console.log("no runs found"); return 1; }
      const eff = effectiveStatus(store.state, probeOwner(await readRunLock(dir)));
      if (eff.orphaned) store.state.status = eff.status; // display-only; nothing is persisted
      console.log(await renderReport(store));
      return 0;
    }
    case "reconcile": {
      // explicit, additive, idempotent: archives the pre-reconciliation
      // snapshot, then writes the terminal status an orphaned run never got
      const r = await reconcileRun(dir);
      if (r.action === "reconciled") {
        console.log(`reconciled ${r.runId}: running → ${r.status} (${r.reason})`);
        console.log(`  snapshot preservado em ${r.archiveDir}`);
        if (r.attemptsMarked) console.log(`  tentativas em aberto marcadas como interrupted: ${r.attemptsMarked}`);
      } else {
        console.log(`nada a reconciliar: ${r.status ?? "sem estado"} (${r.reason})`);
      }
      return 0;
    }
    case "init": {
      await installIntoProject(dir);
      console.log(`OAE installed into ${dir}`);
      return 0;
    }
    case "publish": {
      const remote = await checkRemote(configBase);
      console.log(`remote: ${remote.hasRemote ? remote.url : "none"}`);
      const repoName = arg("--repo", 0, argv) ?? "opencode-autonomous-engineering";
      const st = await inspectGit(dir);
      const r = await publish(configBase, repoName, { createRepo: !remote.hasRemote, private: !flag("--public", argv) });
      console.log(r.pushed ? `pushed ${st.branch} → ${r.repoUrl}` : `publish failed: ${r.error}`);
      return r.pushed ? 0 : 1;
    }
    default:
      console.log("commands: run | plan | status | report | init | publish | dashboard | history | reconcile");
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => { console.error(err); process.exit(1); },
);
