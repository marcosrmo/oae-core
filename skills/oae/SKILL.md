---
name: OAE Mission Runner
description: Launch and track OAE Core (Orchestrated Autonomous Engineering) missions from inside an OpenCode session — start a run, poll status, read the evidence report, and respect the anti-recursion rules.
---

# Running OAE missions from OpenCode

OAE Core (installed as the `oae` CLI) is the orchestrated autonomous engineering
harness shipped with this repository: it owns planning, execution, review,
validation, supervision and traceability. Agent intelligence is not built in —
agent sessions currently run through its **integrated OpenCode v2 engine
adapter** (the only engine adapter implemented; other engines remain planned).
Given one engineering request, it plans, dispatches real OpenCode agent sessions
(coder + independent read-only reviewer) through the running OpenCode service,
runs the project's own validators, and commits on an isolated `oae/auto-*` git
branch — supervised by a deterministic watchdog with hard attempt/time limits.

## Anti-recursion rules (read first — mandatory)

1. **Are you inside an OAE run?** If your prompt says "You are the coder agent
   of an autonomous engineering run", "independent reviewer", or "planning
   agent for an autonomous engineering run" — you were dispatched BY OAE.
   Never invoke the OAE CLI, never start another mission, never create
   orchestration sessions. Just do your task and reply.
2. **One run per directory.** The CLI refuses a second concurrent run via
   `.oae/run.lock` (`.oae/run.lock` holds a live pid while a run is active).
   Do not delete or bypass that file; wait for the active run to finish.
3. OAE never pushes, publishes or touches git remotes; do not do it on its behalf.

## Am I working for OAE, or directly in OpenCode?

- If your prompt opens with "You are the coder agent of an autonomous
  engineering run", "independent reviewer" or "planning agent for an autonomous
  engineering run", you **are inside an OAE run** — see the anti-recursion rules.
- Otherwise you are working **directly in OpenCode**: you may launch and observe
  OAE missions, but your own work is not orchestrated, supervised or recorded by
  OAE. Say which one it is when you report status.
- A running `oae dashboard --follow` is only a **viewer** that re-reads
  `<target>/.oae/`. Its presence does not prove the orchestrator is alive: the
  orchestrator is the `oae run` process. Check `oae status`, which reports
  `interrupted` (not a stale `running`) when the lock owner process is gone.

## Launching a mission (from a normal OpenCode session)

```sh
# if the CLI is on PATH (globally installed / npm link):
oae run "<one-sentence engineering request>" --dir <target-project> --model <providerID/modelID>

# from a checkout, without installing:
node <path-to-this-oae-checkout>/src/index.ts run "<request>" --dir <target-project> --model <providerID/modelID>
```

- `--dir` defaults to the current working directory; point it at the project
  that should receive the change.
- `run` auto-installs the `oae-reviewer` agent + skills into the target's
  `.opencode/` when missing (idempotent); `oae init --dir <target>` does it explicitly.
- Useful flags: `--model providerID/modelID` (default: service default model),
  `--dry-run` (plan only), `--concurrency N`, `--quiet` (no live progress).
- The command is long-running (minutes to hours). Start it in the background
  and poll — do not block a foreground shell on it.

## Watching progress in real time

`oae run` prints **live progress to stderr** as real events are persisted —
planning, task/attempt start, agent activity, validators, review, retry,
recovery, provider errors, interruption and completion. Each line carries a
timestamp, a state tag and the task/attempt when applicable:

```
[13:08:19Z] [planning]    run started — make the CLI installable (model openrouter/z-ai/glm-5.3-flash)
[13:08:19Z] [running]     plan ready — 1 task(s)
[13:08:19Z] [waiting]     task-1#1   attempt 1 dispatched (agent build, kind code) — waiting for the session
[13:08:25Z] [running]     task-1#1   agent activity: messages=4 lastType=assistant tools=edit
[13:09:10Z] [validating]  validator typecheck: exit=0 — ok
[13:09:12Z] [failed]      provider error (HTTP 429): Provider request failed with HTTP 429
[13:12:00Z] [completed]   run finished: done — 1/1 tasks completed
```

States: `planning`, `running`, `waiting`, `validating`, `recovering`,
`interrupted`, `failed`, `completed` (plus `info`/`unknown` for neutral or
unrecognised events).

- stdout stays the final report, so `oae run > report.md` is safe.
- There is **no artificial keep-alive**: no event means no line. Silence is real
  silence, not a hidden heartbeat, and never "probably still working".
- **There is no push channel from OAE into the OpenCode TUI in v2.0.29.** Do not
  claim live streaming inside a chat. To follow a mission from a session, run it
  in the background and poll with a bounded loop (below).

## Tracking a mission

- `oae status --dir <target>` — task list + the **effective** run status
  (`interrupted` when the lock owner is gone, never a stale `running`); exits
  non-zero on failure
- `oae dashboard --dir <target>` — deterministic snapshot of the run
  (`--follow` refreshes in a TTY; `--detail` shows the full timeline)
- `oae reconcile --dir <target>` — persist an orphaned run as `interrupted`
  (archives the original under `.oae/history/`; never deletes evidence)
- `oae report --dir <target>` — evidence-based final report
- `oae history --dir <target>` — current + archived runs
- `<target>/.oae/state.json` — machine-readable run state: tasks, attempts
  (session IDs included), git branch, validator results, decisions
- `<target>/.oae/events.jsonl` — append-only audit log (the same events the live
  progress feed renders)
- `<target>/.oae/REPORT.md` — final report file after `run` completes

### Background run + bounded polling (recommended inside OpenCode)

```powershell
# start it in the background; progress goes to a log
Start-Process -FilePath oae `
  -ArgumentList 'run','"<request>"','--dir','<target>' `
  -RedirectStandardOutput "$env:TEMP\oae-run.out" `
  -RedirectStandardError  "$env:TEMP\oae-progress.log"

# bounded polling: a few times per minute at most — never an infinite loop
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 15
  $line = oae status --dir <target> | Select-String '^run: '
  Write-Output $line
  if ($line -match 'run: (done|failed|interrupted|cancelled)') { break }
}
```

- Poll a few times per minute at most. `oae status`/`oae dashboard` read local
  files only: no service calls, no provider calls, no tokens consumed.
- Stop as soon as the status is terminal, then read `oae report` (and
  `$env:TEMP\oae-progress.log` for the full live feed).

## Acting on results safely

- Agent commits land on the run branch `oae/auto-<id>`; the user's checked-out
  branch is never modified. Merge or cherry-pick from the run branch only with
  explicit user approval.
- Pre-existing uncommitted user work is preserved and excluded from OAE commits.
- Never run `oae publish` without explicit user authorization for that exact action.
