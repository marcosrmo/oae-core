# OAE — OpenCode Autonomous Engineering

A reusable autonomous software engineering system built on the **OpenCode v2 service API**.
Give it a request (`"add a sub() function to index.js"`) and it plans, dispatches real
OpenCode agents to implement it, runs the project's own validators, submits every change
to an independent read-only reviewer, and commits — supervised by a deterministic
watchdog that detects stalls, interrupts and re-dispatches with refined instructions.

- Runtime: **Node ≥ 24** (native TypeScript, no build step) · Windows/Linux/macOS
- Integration: `@opencode/client@2.0.29` driving the running OpenCode service
- State: plain files (`.oae/state.json` + `events.jsonl`) — resumable, auditable
- Isolation: all work happens on a dedicated `oae/auto-*` git branch; pre-existing
  user changes are never committed or discarded

## Requirements

- Node.js ≥ 24 (uses built-in TS type-stripping)
- A running OpenCode v2 service (`opencode service status`) with at least one
  authenticated provider (`opencode auth list`)
- Git available on PATH

## Install

```pwsh
git clone <repo-url>
cd opencode-autonomous-engineering
npm install
npm run typecheck        # tsc --noEmit
npm test                 # 13 deterministic unit tests (no provider calls)
npm run test:integration  # 1 real end-to-end test against the live service
```

## Usage

```pwsh
# inside any target project directory
node <path-to-oae>/src/index.ts init   --dir .      # install .opencode/skills + reviewer agent
node <path-to-oae>/src/index.ts run    --dir . "add a sub() function with a test"
node <path-to-oae>/src/index.ts plan   --dir . "..."   # plan only (dry run)
node <path-to-oae>/src/index.ts status --dir .
node <path-to-oae>/src/index.ts report --dir .         # evidence-based final report
node <path-to-oae>/src/index.ts publish --dir .        # requires explicit authorization
```

Useful flags: `--model providerID/modelID` (default: service default model),
`--dry-run`, `--concurrency N` (parallel tasks, default 1), `--force`
(override a live `.oae/run.lock`).

## Running from inside OpenCode

`oae init` also installs a project-local OpenCode skill — `oae` (from
[`skills/oae/SKILL.md`](skills/oae/SKILL.md)) — into the target project's
`.opencode/skills/`. Any OpenCode agent working in that project can then
discover the skill and follow it to launch OAE missions and track their
results, with anti-recursion rules (never invoke OAE from inside an
OAE-dispatched session; one run per directory via `.oae/run.lock`).

## Project layout

```
src/
  index.ts         CLI entrypoint (run | plan | status | report | init | publish)
  orchestrator.ts  plan → dispatch → supervise → validate → review → consolidate
  supervisor.ts    deterministic watchdog: diagnose / recover / quarantine
  opencode.ts      OpenCode integration (sessions via official client)
  planner.ts       stack detection, validator discovery, plan generation
  store.ts         persistent run state (.oae/)
  git.ts           branch isolation, baseline preservation, commits
  validators.ts    run project checks with hard timeouts
  report.ts        final evidence-based report
  publish.ts       GitHub publication (only with explicit authorization)
  config.ts        defaults + project overrides (.oae/config.json)
  setup.ts         installs project-local skills + reviewer agent
  util.ts          runCommand (hard timeouts), atomic JSON writes, JSONL append
  runlock.ts        one-run-per-directory lock (anti-recursion backstop)
skills/            agent procedures (autonomous-engineering, independent-review,
                   blocked-task-recovery) + the `oae` skill for launching and
                   tracking missions from inside OpenCode
test/              unit tests (fake agents) + real integration test
docs/              architecture, recovery, security, decisions, test report
```

## Safety model

- **Baseline preservation** — files dirty before the run are excluded from every commit.
- **Branch isolation** — agents work on `oae/auto-<id>`; the user's branch is untouched.
- **Read-only reviewer** — the reviewer agent has `edit`/`write` denied at the agent level.
- **Hard timeouts** — every validator command, agent session and run is time-bounded.
- **Anti-recursion** — OAE-dispatched sessions never launch OAE; one run per
  directory is enforced by `.oae/run.lock` (see docs/SECURITY.md).
- **No secrets in artifacts** — service password, provider keys and GitHub credentials
  are handled by OpenCode/credential store, never logged or persisted.

See `docs/SECURITY.md` and `docs/RECOVERY.md` for the full model.
