# ARCHITECTURE

## Overview

OAE is a thin, deterministic orchestration layer on top of the OpenCode v2 service.
All "intelligence" (implementation, review, planning refinement) is performed by real
OpenCode agent sessions; OAE owns sequencing, evidence, supervision and safety.

```
                     ┌─────────────────────────────────────────────────┐
 request ───────────▶│ Orchestrator                                    │
                     │  1. prepareGit (branch oae/auto-<id>)           │
                     │  2. plan (model-assisted w/ deterministic      │
                     │     fallback)                                   │
                     │  3. dispatch coder session ──┐                  │
                     │     ├─ awaitCompletion ◀─────│── OpenCodeRunner │
                     │     ├─ runValidators (own    │   (real OpenCode │
                     │     │  process, hard timeout)│    sessions via  │
                     │     ├─ dispatch reviewer ────┘    client)       │
                     │     └─ commit on run branch                     │
                     │  4. final validators + report                   │
                     └───────┬─────────────────────────────────────────┘
                             │ Supervision ticker (every pollMs)
                     ┌───────▼─────────────────────────────────────────┐
                     │ Supervisor (pure state inspection; not an LLM)  │
                     │  idle ≥ diagnoseMs → diagnose + context         │
                     │  idle ≥ recoverMs  → interrupt + re-dispatch    │
                     │  limits exceeded   → quarantine                 │
                     └─────────────────────────────────────────────────┘
```

## Modules

| Module | Responsibility |
| --- | --- |
| `index.ts` | CLI; wires config/store/orchestrator; prints report |
| `orchestrator.ts` | Task execution loop; dependency order; bounded concurrency; commits |
| `supervisor.ts` | Watchdog; produces `SweepAction` (diagnose/recover/quarantine) |
| `opencode.ts` | `AgentRunner` seam + `OpenCodeRunner` (real service sessions); message parsing |
| `planner.ts` | Stack detection (`package.json`, `pyproject.toml`, `requirements.txt`, `go.mod`); validator discovery; plan via model with deterministic fallback |
| `store.ts` | `.oae/state.json` (full run state) + `events.jsonl` (append-only audit) |
| `git.ts` | Inspect/prepare/commit; baseline exclusion; diff helpers |
| `validators.ts` | Run configured checks as child processes with hard timeouts |
| `report.ts` | Evidence-based report from the store + git history |
| `publish.ts` | GitHub publication via git push / REST — authorization-gated |
| `config.ts` | Defaults + `.oae/config.json` overrides |
| `setup.ts` | Installs `.opencode/skills/*` and the `oae-reviewer` agent into a target project |
| `util.ts` | `runCommand` child-process helper with hard timeouts; atomic JSON writes; JSONL append |

## Key design decisions

1. **AgentRunner seam.** The orchestrator depends on an `AgentRunner` interface
   (`prompt`, `awaitCompletion`, `interrupt`, `transcriptTail`, `sessionId`), not on
   the OpenCode client directly. Real sessions are driven by `OpenCodeRunner`; tests
   inject `FakeRunner`. This is why the supervision logic is fully testable without
   provider calls.
2. **Deterministic supervisor.** The watchdog is *not* an LLM agent, so it cannot
   suffer the stalls it detects. Policy is time-based on verifiable progress signals
   (message-count/context changes recorded from `GET /api/session/{id}/context`).
3. **Independent review by a separate session.** The reviewer is a second OpenCode
   session with a read-only agent definition (`edit`/`write` denied). It reviews the
   uncommitted diff and returns a JSON verdict; a rejection drives rework with the
   findings as refined instructions.
4. **State in files, not memory.** `Store` persists every task, attempt, decision,
   validator result and event. A run can be inspected or resumed after a crash.
5. **Version pinning.** `@opencode/client` is pinned to exactly `2.0.29`, matching the
   installed CLI. Only endpoints present in the service's own `/openapi.json` are used.

## Session protocol (verified live, v2.0.29)

- Session creation: `session.create({ title, location: { directory } })`.
- The agent works in the target project directory; completion is observed by polling
  `session.active()` (the session id leaves the active map) and by reading the
  `session.context` message list.
- Messages use `{ type, content[] }` (assistant parts: `reasoning | tool | text`);
  an `idle` message with `outcome: "failed"` maps to a failed run (e.g. provider
  quota errors) and triggers the standard retry/backoff path.
- Interruption: `session.interrupt()` — used by the supervisor for recovery.

## Failure containment

| Failure | Containment |
| --- | --- |
| Agent stalls (no progress) | Supervisor interrupt + re-dispatch with refined instructions |
| Repeated stalls | Task quarantined (`blocked`); other tasks continue |
| Validator failure | Attempt rejected; findings drive rework; task never marked done |
| Reviewer rejection | Findings become refined instructions for the next attempt |
| Provider error (e.g. quota) | `idle.outcome=failed` → failed attempt → retry/backoff |
| Dependency failure | Dependent tasks blocked deterministically |
| Run timeout | Pending tasks cancelled; partial state persisted |
