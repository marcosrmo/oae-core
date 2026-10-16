# RECOVERY

How OAE detects, interrupts and recovers from stalled agent sessions — and how a
failed run can be inspected and continued.

## What counts as progress

The supervisor only trusts **verifiable** progress signals. The signal wired to
the supervision clock is the **evolution of the session's message list**
(`GET /api/session/{id}/context`): message count, newest message id, tool usage
names — this includes the agent's own tool calls (file edits, shell commands),
so an agent actively working never looks idle. Additionally, task state changes
and validator executions are recorded in the store as evidence for the report
(with timestamps), and each validator command is bounded by its own hard
timeout (`commandTimeoutMs`).

LLM self-reports ("I'm almost done") are *not* progress signals.

## Supervision policy (defaults from `config.ts`)

| Threshold | Default | Action |
| --- | --- | --- |
| `pollMs` | 5 s | Supervision ticker interval |
| `diagnoseMs` | 7 min | Diagnose: capture transcript tail, record `supervisor_diagnose` event, prepare recovery context |
| `recoverMs` | 10 min | Controlled recovery: `session.interrupt()` on the stalled session; orchestrator re-dispatches a fresh agent with refined instructions |
| `maxAttempts` | 3 | Max dispatch attempts per task (code + recovery) |
| `maxRecoveryCycles` | 2 | Max recovery cycles before quarantine |
| `taskTimeoutMs` | 30 min | Hard wall-clock limit per task |
| `runTimeoutMs` | 2 h | Hard wall-clock limit for the whole run |
| `commandTimeoutMs` | 5 min | Hard timeout per validator command |

Legitimate long operations (installs, builds) are bounded by *their own* per-command
timeouts; the supervisor reacts only to *global* task stalls, so a slow `npm install`
inside its own timeout is not treated as a stall.

## Anti-recursion

Recovery can fail in loops (agent stalls again, re-dispatch, stall again…). Two
independent bounds stop this:

1. `maxAttempts` — attempts counted from the store, per task.
2. `maxRecoveryCycles` — recoveries counted per task.

When either bound is reached the task is **quarantined**: the stalled session is
interrupted, the task is marked `blocked` with the reason
(`recovery limit (cycles=N, attempts=M)`), and the run continues with the remaining
tasks. Independent tasks are never blocked by a quarantined sibling.

## Refined re-dispatch

The recovery context (`buildRecoveryContext`) gives the fresh agent:

- the diagnosis (idle time, observed signals, transcript tail of the stalled session);
- instructions to re-read acceptance criteria, reduce scope to the smallest verifiable
  step, name files before editing, run a validator after each step, and pick a
  materially different strategy.

Reviewer rejections are recycled the same way: findings become refined instructions
for the next code attempt.

## Inspecting / resuming a run

- `.oae/state.json` — full state: tasks, attempts (session ids, outcomes, files
  changed), decisions, validator results, git info (branch, baseline commit,
  pre-existing uncommitted files).
- `.oae/events.jsonl` — append-only audit trail (`run_started`, `plan_ready`,
  `supervisor_diagnose`, `supervisor_recover`, `supervisor_quarantine`, …).
- `node src/index.ts status --dir .` — task table.
- `node src/index.ts report --dir .` — evidence-based report.

## Git-level recovery

- Baseline: the branch and the pre-run HEAD are recorded; files dirty *before* the
  run are excluded from every OAE commit — they can never be lost by `git reset`.
- Agents work on `oae/auto-<timestamp>`; to abandon an OAE run, delete the branch.
  The user's original branch and uncommitted work are untouched.
