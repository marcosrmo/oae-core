/**
 * OAE CLI — entrypoint.
 *
 *   node src/index.ts run "<request>"  --dir <project> [--model providerID/modelID] [--force]
 *   node src/index.ts plan "<request>" --dir <project>
 *   node src/index.ts status --dir <project>
 *   node src/index.ts report --dir <project>
 *   node src/index.ts init   --dir <project>   (installs .opencode config + skills)
 *   node src/index.ts publish --dir <project> [--repo <name>] [--public]
 *
 * `run`/`plan` hold .oae/run.lock — a second concurrent run in the same
 * directory is refused (anti-recursion, D13). --force overrides a live lock.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfig, defaultConfig } from "./config.ts";
import { Store } from "./store.ts";
import { Orchestrator, type RunOptions } from "./orchestrator.ts";
import { connect } from "./opencode.ts";
import { renderReport } from "./report.ts";
import { inspectGit } from "./git.ts";
import { checkRemote, publish } from "./publish.ts";
import { installIntoProject } from "./setup.ts";
import { acquireRunLock, releaseRunLock } from "./runlock.ts";

function arg(name: string, i: number, argv: string[]): string | undefined {
  const idx = argv.indexOf(name);
  return idx >= 0 ? argv[idx + 1] : i >= 0 ? undefined : undefined;
}
function flag(name: string, argv: string[]): boolean {
  return argv.includes(name);
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
      try {
        // auto-install the reviewer agent + skills when missing (idempotent)
        try {
          await readFile(join(dir, ".opencode", "opencode.json"), "utf8");
        } catch {
          await installIntoProject(dir);
          console.log(`(oae-reviewer agent + skills installed into ${dir})`);
        }
        const store = await Store.create(dir, runId, request);
        const { client } = await connect();
        const orch = new Orchestrator(client, store, { config, dryRun: flag("--dry-run", argv) });
        const { state } = await orch.run(request);
        const report = await renderReport(store);
        await writeFile(join(dir, ".oae", "REPORT.md"), report, "utf8");
        console.log(report);
        console.log(`\n(report saved: ${join(dir, ".oae", "REPORT.md")})`);
        return state.status === "done" ? 0 : 1;
      } finally {
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
      for (const t of store.state.tasks) {
        console.log(`${t.id}\t${t.status}\t${t.title}${t.blockedReason ? `\t(${t.blockedReason})` : ""}`);
      }
      console.log(`run: ${store.state.status}`);
      return 0;
    }
    case "report": {
      const store = await Store.loadLatest(dir);
      if (!store) { console.log("no runs found"); return 1; }
      console.log(await renderReport(store));
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
      console.log("commands: run | plan | status | report | init | publish");
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => { console.error(err); process.exit(1); },
);
