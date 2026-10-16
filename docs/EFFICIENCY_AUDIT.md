# EFFICIENCY AUDIT — OAE autonomous loop

Date: 2026-10-16 · Trigger: operator interrupted `run-mvazafl3` (self-hosting mission)
after 17m10s without completing a "simple" task, requesting an evidence-based
efficiency audit of the whole execution loop.

Method: reconstruction from persisted run state (`.oae/state.json`,
`.oae/events.jsonl`), live OpenCode service data (`GET /api/session/{id}`,
`/api/session/active`, per-session `context`), source reading of every OAE
module, the installed service's own OpenAPI document, and official docs
(OpenCode v2, Claude Code). No metric below is estimated; where telemetry was
unavailable, that is stated.

## 1. Interrupted run — reconstructed timeline (`run-mvazafl3`)

Request: "make the repository's CLI globally installable" (3 concrete edits +
verification). Started 13:03:17Z on branch `oae/auto-mvazafsd`, interrupted by
operator at 13:20:27Z (elapsed 17m10s).

| Step | Session (agent) | Wall clock | Tokens in/out/reason/cache-read | Result |
| --- | --- | --- | --- | --- |
| Plan | `ses_ebb30b64` (`plan`) | 13:03:18 → abandoned at the 5-min cap 13:08:19; kept running orphaned until 13:17:27 (**+9 min**) | 9,182 / 2,758 / 10,305 / 53,824 | produced a complete, valid plan JSON at 13:17:27 that **no one ever read**; orchestrator used the fallback plan |
| Code | `ses_ebb2c1b0` (`build`) | 13:08:19 → 13:20:27 (interrupted) | 7,593 / 1,802 / 3,393 / 157,696 | real progress (11 read/grep, 3 edits, 6 shell calls; shebang + `files` + README done), killed mid-verification |
| Review | — | never reached | — | — |

Session totals observed (assistant turns ≈ model calls): planner 5 turns /
11 tool calls; coder 14 turns / 19 tool calls. Run totals: **19 model turns,
30 tool calls, 16,775 input / 4,560 output / 13,698 reasoning / 211,520
cache-read tokens** — with zero tasks completed and nothing committed
(baseline-preserving design held; partial work preserved as WIP commit
`b25f3ce` on the run branch).

Reference (completed micro-run `run-mvayyizx`, sandbox "add sub()"):
6m09s wall, 3 sessions, 13 model turns / 18 tool calls,
15,295 in / 2,508 out / 4,203 reasoning / 82,496 cache-read. Planner session
finished in 81s with a **valid 3-task plan JSON** — and it was still
discarded (see §2.1).

## 2. Root causes (confirmed, with evidence)

### 2.1 The model-assisted planner never worked — 2 of 2 real runs fell back

- **Sandbox run:** the planner returned a 4,014-character JSON plan in 81s.
  `OpenCodeRunner.finalOutput()` applied `truncate(text, 4000)` — cutting the
  JSON mid-structure — and `planWithModel`'s regex/parse then failed, so the
  deterministic single-task fallback was used. Verified empirically: the full
  text parses (3 tasks); the 4,000-char truncation does not
  (`Expected ',' or ']' ... at position 3574`).
- **Self-hosting run:** `awaitCompletion(5 min)` expired, returned
  `interrupted`, and — because the deadline branch never called
  `interrupt()` — the session kept running on the service for 9 more minutes
  and eventually produced a complete plan that was never read.

Net effect: every run pays full planning latency + tokens **and then plans
with the fallback anyway**. For the interrupted run that is 5 minutes of
critical-path latency and a 10,305-reasoning-token session for nothing.

### 2.2 Empty "success" — a failed dispatch looks like a completed attempt

`OpenCodeRunner.start()` sent the initial prompt fire-and-forget
(`void …prompt().catch(() => undefined)`). If the prompt request fails
(provider 402, auth, transport), the session never activates; the first poll
sees "not active" and reports `completed` with an **empty output**. The
orchestrator had no empty-output check, so the attempt went to validators +
an independent review session reviewing *nothing*, then rework looped until
`maxAttempts`. One silent dispatch failure could burn up to 3 full
validate+review cycles.

### 2.3 No telemetry

`state.json` records time (attempt started/ended) but **no tokens, no cost,
no model-call counts, no planner-fallback reason**. The service exposes all
of it (`GET /api/session/{id}` → tokens per session; verified live), but OAE
never queried it. The planner's fallback was indistinguishable from a
model-generated plan in the event log.

### 2.4 Heavy observation loop

`awaitCompletion` polled every 2.5s: one **full-transcript** `context` fetch
plus one `active()` fetch per tick (~48 req/min; the payload grows with the
session). At completion the transcript was fetched three more times
(observe + idleOutcomeFailed + finalOutput). The service offers
`GET /api/event` (SSE) and `POST /api/experimental/session/{id}/wait` —
both present in the installed 2.0.29 OpenAPI — none used.

### 2.5 Supervisor cannot tell "slow" from "stuck"

The only progress signal is a change in the message list (count + last id).
A legitimately long shell command (e.g. `npm install` > 7 min) produces no
message changes; the supervisor would diagnose at 7 min and interrupt +
redispatch a **fresh** session at 10 min, discarding near-complete work —
exactly the trajectory the interrupted coder was on (last message 13:16:21;
diagnosis would have fired ~13:23). There is no per-turn cap either: only
wall-clock bounds exist.

### 2.6 What is persisted vs. rebuilt

Persisted: tasks, attempts (session id, outcome, summary, files), decisions,
validator results, git baseline. Rebuilt or lost every time: the planner's
output (discarded on any parse failure), token usage (never captured),
recovery context (in-memory only — lost on crash), stack detection
(re-run per dispatch), the reviewer diff (fresh each review).

## 3. Fase-2 audit questions — answered

1. **Model calls:** per assistant turn ≈ one model call with full context.
   Interrupted run: 19 turns (planner 5, coder 14). Reference run: 13.
2. **Sessions/agents:** 2 (`plan`, `build`) in the interrupted run —
   reviewer never reached; 3 (`plan`, `build`, `oae-reviewer`) in the
   reference run. All real `ses_*` sessions on the service.
3. **Tokens:** per-session numbers in §1 from `GET /api/session/{id}`.
   Caveats: `cost` is 0 for the nvidia provider (not a reliable dollar
   figure); cache-write is always 0 on this provider; OAE itself recorded
   nothing (fixed now — see §5).
4. **Progress vs. repetition:** planner 100% wasted (2/2 fallback, §2.1);
   coder progressed steadily (edits + verification shells); no repeated
   file analysis observed within a session (cache-read >> input confirms
   effective prompt caching by the service).
5. **Slow vs. blocked:** no — the supervisor only sees message-list changes
   (§2.5). Confirmed by code; no counter-evidence in either run.
6. **Excess polling:** yes — §2.4. Redundant planning: the fallback replans
   nothing but discards the model plan (§2.1). Excess tools: the reference
   reviewer ran 5 shell calls to judge a 4-line diff (~196s — the longest
   step of that run).
7. **Persisted/reused vs. rebuilt:** §2.6.
8. **Failure handling:** validator timeouts are hard and recorded (good);
   store writes are atomic (good — proven by the interrupt: state intact);
   deadline expiry leaked the session (§2.1, fixed); failed prompts looked
   like empty success (§2.2, fixed); token-limit and empty responses had no
   dedicated handling (partially fixed: empty output now bounded-retried).
9. **Cost/time measurable?** Time per attempt: yes (already persisted).
   Tokens: yes, from the service — now recorded per attempt. Dollars: not
   reliably on this provider (reports 0); report tokens + latency.

## 4. OpenCode (2.0.29, installed) vs. Claude Code — sources and comparison

Sources actually consulted for this section:
- Installed service OpenAPI, extracted live via `opencode api get /openapi.json`
  (verified endpoints: `/api/event`, `/api/experimental/session/{id}/wait`,
  `/api/session/{id}/compact`, `/api/experimental/session/stats`,
  `/api/session/{id}` with `tokens`).
- `https://opencode.ai/v2/docs/api` (operation list), `/v2/docs/skills`,
  `/v2/docs/build/client` (async iterables for streaming endpoints).
- `https://code.claude.com/docs/en/sub-agents`, `https://code.claude.com/docs/en/costs`
  (official Claude Code docs; the product is closed-source — behavior is
  cited from documentation only, not from code).
- Live session data from the running service (all sessions above).

| Capability | OpenCode 2.0.29 (verified live) | Claude Code (documented) | OAE implication |
| --- | --- | --- | --- |
| Wait for completion | `POST …/session/{id}/wait`; `GET /api/event` SSE; client has async iterables | internal | replace 2.5s full-transcript polling |
| Context compaction | `POST …/session/{id}/compact`; `Session.Message.Compaction` (running/completed/failed) | `/compact` with custom focus instructions; auto-compact window per subagent (`autoCompactWindow`) | long coder sessions; must watch for compaction messages |
| Per-session usage | `GET /api/session/{id}` → tokens + cost; `GET /api/experimental/session/stats` → steps, tools, per-model (account level) | `/usage`: local cost estimate, cache hit/miss **with likely cause**, attribution per subagent/skill/MCP, `--max-budget-usd` hard cap | record per attempt (done); budget caps are OAE's job |
| Subagent limits | none built-in per run | `maxTurns` per subagent, partial output on cap, **resumable** | add per-attempt turn caps + resume instead of fresh redispatch |
| Model routing | per-session `model` (OAE uses one for all agents); variants (default/high…) exist | per-subagent `model` (Haiku for cheap tasks), `effort` levels, `CLAUDE_CODE_SUBAGENT_MODEL` | planner/reviewer on a cheaper model+variant |
| Lean research agents | every session loads project config/skills | built-in Explore/Plan **omit CLAUDE.md + git snapshot** to stay cheap | trim planner/reviewer initial context |
| Isolation | worktree API exists (`/api/worktree`) | `isolation: worktree` per subagent | OAE roadmap already wants per-task worktrees |
| Memory | none beyond session | `memory: user/project/local` persistent scopes | cross-run learning is future work |
| Telemetry export | stats endpoint (account level) | OpenTelemetry per-user export; analytics APIs | OAE keeps its own per-attempt ledger (simpler, sufficient) |

Both systems rely on the same economics: prompt caching makes *stable*
context cheap and *rewritten* context expensive; compaction trades a summary
call for future turns; delegation isolates verbose output in a sub-context.
Claude Code's most transferable ideas for OAE: per-agent model/effort
routing, hard per-agent turn caps with resumable partial output, and usage
attribution per component. OpenCode's own service already exposes the data
(`wait`, SSE, per-session tokens) — OAE was simply not using it.

## 5. Fixes implemented in this audit (small, safe, unit-verified)

| # | Change | Evidence basis | Test |
| --- | --- | --- | --- |
| 1 | `awaitCompletion` deadline now calls `interrupt()` — no orphan sessions | planner ran 9 min after abandonment | "runner deadline expiry interrupts the session" |
| 2 | `finalOutput` truncation 4,000 → 20,000 chars | 4,014-char plan destroyed by 14 chars | "long plan output survives (no 4000-char truncation)" |
| 3 | `start()` awaits the prompt — dispatch errors surface immediately instead of empty "success" | fire-and-forget `.catch(() => undefined)` | "runner start surfaces a rejected prompt" |
| 4 | Empty/blank coder output = failed attempt (decision recorded, **no reviewer session spent**), bounded by `maxAttempts` | §2.2 | "empty coder response is retried…", "all attempts empty: … zero review sessions" |
| 5 | Per-attempt token telemetry (`runner.usage()` → `GET /api/session/{id}`) stored in `attempt.evidence.tokens` for coder and reviewer | §2.3 | "per-attempt token telemetry is recorded…" |
| 6 | Completion path fetches the transcript once (cached from the poll) instead of three times; poll interval 2.5s → 5s | §2.4 | "…context is fetched once" |

All 22 unit tests pass (16 prior + 6 new), `tsc --noEmit` clean. Existing
protections (run lock, prompt guards, git baseline/branch, attempt limits,
independent review) are covered by the prior 16 tests and unchanged.

## 6. Proposed architecture (not yet implemented)

**A. Minimal reusable context.** Split context into (1) stable project
brief (stack, validators, conventions — computed once per run, stored in
`state.json`), (2) per-task instruction block (already the case), (3) the
diff/verification evidence passed to the reviewer. Give planner/reviewer
sessions a leaner initial load (no full skills advertisement) mirroring
Claude Code's Explore/Plan pattern. Cache `detectStack` + validator discovery
per run. Invalidation: recompute only when `git status` changes the file set
that defines them (package.json / config files).

**B. Progress-oriented orchestration.** Subscribe to `GET /api/event` (SSE)
instead of polling; treat *verifiable* progress — file changes on the run
branch, validator runs, new commits — as supervisor signals (not just
message churn), so a slow-but-productive agent (long npm install) is not
interrupted; add per-attempt turn caps via assistant-message counting with
partial-output salvage (finish the attempt, keep the diff, refine) instead
of always re-dispatching from zero.

**C. Economical agent strategy.** Per-agent model/variant config
(`plannerModel`, `reviewerModel` defaulting to a flash model; coder on the
primary). Skip the planner for small requests (request ≤ N chars or
single-file targets → direct single-task plan, no session). Review-on-risk:
full independent review for multi-file/branch-affecting changes; a cheap
validator-only gate for 1-file mechanical changes — reviewer stays mandatory
for anything the validators cannot prove.

**D. Telemetry and limits.** (partly done) Per-attempt tokens are now
recorded; add: model-call/turn counts per attempt, per-run rollup in the
final report, `--max-tokens` / `--max-model-calls` run limits with
predictable stop (cancel in-flight sessions, mark run `failed: limit`), and
planner-outcome events (`planner_model_used` / `planner_fallback:<reason>`).

**E. Safety.** All existing guarantees preserved by design — the changes
above touch only how agents are driven and measured, never branch/baseline/
lock/review invariants. Resume-from-state (roadmap v0.2) remains the answer
for crash recovery; `state.json` is crash-safe today (atomic writes).

## 7. Benchmark (same task before/after)

Baseline (`run-mvayyizx`, before the fixes): sandbox "add sub()" — 6m09s,
planner wasted (fallback), no telemetry recorded. After-fix re-run of the
identical request in a fresh sandbox: see `docs/EFFICIENCY_AUDIT.md` §7
results appended after the benchmark execution (same task, same model,
same validators).

| Metric | Before (run-mvayyizx) | After (run-mvb…) |
| --- | --- | --- |
| (filled after the benchmark run) | | |
