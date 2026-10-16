---
name: OAE Mission Runner
description: Launch and track OAE (OpenCode Autonomous Engineering) missions from inside an OpenCode session — start a run, poll status, read the evidence report, and respect the anti-recursion rules.
---

# Running OAE missions from OpenCode

OAE is the autonomous engineering orchestrator shipped with this repository.
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
  `--dry-run` (plan only), `--concurrency N`.
- The command is long-running (minutes to hours). Start it in the background
  and poll — do not block a foreground shell on it.

## Tracking a mission

- `oae status --dir <target>` — task list + run status (also exits non-zero on failure)
- `oae report --dir <target>` — evidence-based final report
- `<target>/.oae/state.json` — machine-readable run state: tasks, attempts
  (session IDs included), git branch, validator results, decisions
- `<target>/.oae/events.jsonl` — append-only audit log (task/attempt/validator/supervisor events)
- `<target>/.oae/REPORT.md` — final report file after `run` completes

## Acting on results safely

- Agent commits land on the run branch `oae/auto-<id>`; the user's checked-out
  branch is never modified. Merge or cherry-pick from the run branch only with
  explicit user approval.
- Pre-existing uncommitted user work is preserved and excluded from OAE commits.
- Never run `oae publish` without explicit user authorization for that exact action.
