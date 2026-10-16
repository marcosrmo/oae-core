# DECISIONS

Architectural decisions taken during the build, with rationale. Newer entries may
supersede older ones; superseded entries are kept for context.

## D1 — Orchestrate via the official `@opencode/client`, not raw HTTP
- **Decision:** use `@opencode/client@2.0.29` (exact match with the installed CLI)
  driving the running service discovered by `Service.ensure()`.
- **Alternatives:** raw `fetch` against the REST API; spawning `opencode run` CLI.
- **Rationale:** typed client, version-matched, handles service discovery + HTTP
  Basic auth (service password) without exposing the secret; spawning a second
  CLI process per agent would duplicate service management.
- **Evidence:** live probe (`session.create`, `session.log`, `session.interrupt`);
  integration test passes real sessions end-to-end.

## D2 — Deterministic supervisor outside the LLM loop
- **Decision:** the watchdog is plain TypeScript state inspection (message-context
  polling), not an agent.
- **Rationale:** an LLM supervisor can stall exactly like the agents it watches.
  A time-based policy on verifiable signals is reproducible and cheap.

## D3 — AgentRunner seam for testability
- **Decision:** orchestrator depends on an `AgentRunner` interface; tests inject
  `FakeRunner` with deterministic behaviors (`complete`, `hang`, `error`).
- **Rationale:** makes supervision/rework/quarantine logic testable without provider
  calls; 13 deterministic tests run in ~2 minutes.

## D4 — Independent reviewer as a separate read-only session
- **Decision:** a second OpenCode session with an `oae-reviewer` agent that denies
  `edit`/`write`, reviews the uncommitted diff, returns a JSON verdict.
- **Rationale:** review separated from authoring catches regressions; read-only
  prevents the reviewer from "fixing" things by itself, keeping single-writer flow.

## D5 — State in plain files under `.oae/`
- **Decision:** `state.json` + append-only `events.jsonl`; no database.
- **Rationale:** zero-dependency, inspectable with any tool, crash-resumable, and
  trivially auditable — matching the evidence-based reporting requirement.

## D6 — Git as the safety boundary
- **Decision:** dedicated `oae/auto-<runid>` branch per run; baseline uncommitted
  files recorded and excluded from every OAE commit.
- **Alternatives:** worktrees per agent (rejected: more moving parts on Windows);
  stash (rejected: mutating the user's stash is a destructive-looking operation).
- **Rationale:** user work can never be lost; abandoning a run = deleting a branch.

## D7 — Node 24 native TypeScript, no build step
- **Decision:** run `.ts` directly (type-stripping); `typescript` only as a
  devDependency for `tsc --noEmit`.
- **Constraint:** TypeScript parameter properties are not supported by
  type-stripping — constructor-assigned fields must be declared explicitly.

## D8 — Plan generation: model-assisted with deterministic fallback
- **Decision:** ask the model for a JSON plan; validate it; fall back to a
  heuristic plan (stack detection + validator discovery) on any failure.
- **Rationale:** planning is a "best effort" step; a run must never fail because the
  model returned prose instead of JSON.

## D9 — Provider/model selection at runtime, never hard-coded
- **Decision:** `--model providerID/modelID` flag or `.oae/config.json`; otherwise
  the service default.
- **Note:** the service default (`openrouter/meta/muse-spark-open`) returned a
  402 in-flight budget error during early integration runs; `z-ai/glm-5.3-flash`
  via OpenRouter worked. Documented in TEST_REPORT I-01.

## D10 — No new MCPs/plugins for the core system
- **Decision:** OAE uses only OpenCode native tools (read/edit/shell/git).
- **Rationale:** the global MCP servers (`playwright`, `rea`) are not needed for
  source-repository engineering; fewer dependencies, fewer failure modes.

## D11 — Publication is authorization-gated
- **Decision:** `oae publish` exists but is never invoked autonomously; repo
  creation/push requires explicit user approval. Repos private by default.

## D12 — OpenCode↔OAE integration: skill + existing CLI (no MCP)
- **Decision:** the mechanism by which an OpenCode agent operates OAE is the
  **existing CLI invoked through OpenCode's shell tool**, made *discoverable*
  by a project-local OpenCode skill (`oae`, shipped in `skills/oae/SKILL.md`
  and installed into target projects by `oae init`). The skill documents how to
  launch a mission (`oae run`), track it (`oae status`/`report`,
  `.oae/state.json`, `.oae/events.jsonl`) and the anti-recursion rules.
- **Alternatives rejected:**
  - *MCP server exposing `oae_run`/`oae_status`/`oae_report` tools* — no
    concrete benefit: runs are long-lived (minutes to hours) and file-state
    based, so the CLI already provides async start + polling; MCP would only
    wrap the same child process while adding a server, config surface and
    timeout semantics (`mcp.timeout`) that fit poorly with hour-long runs.
  - *Plugin (custom tool)* — same wrapping cost, plus the plugin API is the
    most volatile surface across versions.
  - *Custom command (`.opencode/command`)* — user-invokable TUI UX, not the
    agent path; can be added later without changing this decision.
- **Rationale:** uses only native, stable v2 mechanisms (skills surface via
  `GET /api/skill` and load via the `skill` tool — verified in
  docs/ENVIRONMENT_AUDIT.md); zero new processes, zero global config changes;
  the agent keeps full inspection powers (files, exit codes, git) over runs.
- **Direction matters:** the pre-existing `@opencode/client` integration (D1)
  is OAE *driving* the OpenCode service. D12 is the opposite direction —
  OpenCode *operating* OAE. Both are required for self-hosting.

## D13 — Anti-recursion: layered, deterministic guards
- **Decision:** an OAE run must never (transitively) launch OAE runs. Layers:
  1. *Skill rule* — `oae` skill's first section forbids invoking OAE from
     inside an OAE-dispatched session.
  2. *Prompt guards* — coder/reviewer/planner prompts explicitly forbid
     launching nested runs (test: "anti-recursion: dispatched prompts ...").
  3. *Run lock* — `run`/`plan` hold `.oae/run.lock` (pid + runId); a second
     concurrent run in the same directory is refused (exit 3), stale locks
     (dead pid) are reclaimed, `--force` is the explicit operator override
     (tests: "run lock: ...").
  4. *Pre-existing hard bounds* — maxAttempts, maxRecoveryCycles, task and run
     timeouts bound every run regardless.
- **Rationale:** prompt rules alone are probabilistic; the lock makes the
  same-directory case (the realistic recursion vector: a coder session
  shelling out in its own project) deterministically refused while the outer
  run is alive. Cross-directory recursion is bounded by layer 4.

## D14 — Efficiency fixes from the 2026-10-16 loop audit (docs/EFFICIENCY_AUDIT.md)
- **Decision:** five small, evidence-backed fixes; the bigger architecture
  (SSE, per-agent models, turn caps, resume) is documented as a proposal only.
  1. Deadline expiry now *interrupts* the session — an abandoned planner had
     run 9 extra minutes as an orphan producing a plan nobody read.
  2. `finalOutput` truncation raised 4,000 → 20,000 chars — a valid 4,014-char
     plan JSON was being destroyed by 14 characters, silently forcing the
     deterministic fallback in 2/2 real runs.
  3. `start()` awaits the session prompt: dispatch failures (e.g. provider
     402) surface immediately instead of as empty "completed" attempts.
  4. Empty coder output is treated as a failed attempt (recorded, retried,
     never sent to review) and bounded by maxAttempts.
  5. Per-attempt token telemetry (`GET /api/session/{id}`) recorded in
     `attempt.evidence.tokens`; completion fetches the transcript once; poll
     interval 5s.
- **Rationale:** every fix maps to a measured failure mode in
  docs/EFFICIENCY_AUDIT.md; each is covered by a dedicated unit test.

## D15 — Post-benchmark loop fixes 7–10 and the installable CLI (2026-10-16)
- **Fixes 7–9** (commit `22ffe49`, exposed by benchmark `run-mvb27epc`):
  IMPEDIMENT extraction strips markdown emphasis; `interrupt()` invalidates
  the transcript cache; model planning skipped for requests < 200 chars
  (`PLANNER_MODEL_MIN_REQUEST`).
- **Fix 10** (commit `e0c7ce2`, exposed by benchmark `run-mvb2ysid`): a
  reviewer verdict that is *unparseable* while the validators pass is a
  review-format failure → one bounded re-ask to the reviewer with a format
  reminder (`config.recovery.maxReviewReasks`, default 1), never spending a
  coder attempt on it. Benchmark evidence: 2 of 3 reviews answered in
  prose with no JSON object anywhere in the output (verified in the
  session context), costing 2 whole coder attempts on already-correct code.
  A parser cannot recover output that is not there; re-asking is the
  proven recovery. Legacy behavior preserved with `maxReviewReasks: 0`.
- **Installable CLI** (commits `5b0fa06`, `311aae1`): the prefix-install
  check that interrupted self-hosting run-mvazafl3 never reached proved a
  `.ts` bin cannot run from `node_modules` — Node throws
  `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` (v24.16.0). Resolution:
  `tsconfig.build.json` emits `dist/` using `rewriteRelativeImportExtensions`
  (5.7+); `bin` points at `dist/index.js`; `files: ["dist", "skills"]`;
  `prepare: npm run build` runs on `npm pack` so the tarball ships built.
  Verified end-to-end: pack (20 files) → `npm install --prefix` →
  `node_modules/.bin/oae.cmd status --dir` → `no runs found`.
  This supersedes D7's "no build step" for *installation only* — the
  dev/repo workflow still runs `.ts` directly.
- **CLI status semantics kept:** `oae status` with no prior state prints
  `no runs found` and exits 1 — unix precedent (`grep` on no match);
  scripts must treat exit 1 as "no state yet", not an internal error.
- **Provider rate-limit incident (benchmarks `run-mvb4b2ov` and
  `run-mvb4xohu`):** after a day of heavy use of `nvidia/z-ai/glm-5.3`,
  every coder attempt across both runs failed with HTTP 429 (one further
  attempt failed with HTTP 401 "authorization header missing",
  coinciding with a confirmed OpenCode service restart), 0 tokens per
  attempt. Existing bounds behaved correctly (bounded retries, transparent
  report) but attempt budget *is* consumed by provider errors; a
  structured 429-aware backoff that does not spend attempts is recorded as
  future work (EFFICIENCY_AUDIT §6). Not implemented without a
  reproducible test. Benchmarking was deliberately stopped after the
  second confirmation.

## D16 — Operational observability: typed events, deterministic panel, SSE-first runner (2026-10-16)

Delivers the observability mission (stages 1–6; stage 7 = this decision +
EFFICIENCY_AUDIT §8). Motivation: §3 "No telemetry" — a run could only be
understood by re-reading JSON manually, and §2.4's polling loop fetched the
full session context every 5 s per attempt.

**A. Typed event layer (additive, never rewritten).** `src/events.ts` names the
event kinds; new events (`attempt_finished`, `agent_progress`,
`retry_scheduled`, `session_interrupted`, `provider_error`) extend
`events.jsonl` WITHOUT renaming historical kinds — older logs stay readable,
and no migration exists to get wrong. A real payload collision was found and
fixed at the emit sites: `Store.event` spreads data over the line, so nested
`kind` fields (attempt kind, progress-signal kind) silently overwrote the
event-type field → renamed `attemptKind` / `signalKind`. Provider failures are
classified by stable markers (`classifyProviderFailure`), with confirmed-zero
tokens kept distinct from unknown usage.

**B. Deterministic projection + panel (no LLM, no observer agent).**
`viewmodel.ts` projects `state.json` + `events.jsonl` → `RunView` with
operational phases (inicializando … concluída/falhou), stall detection, and
token provenance rules (zero-confirmed vs unknown; legacy runs fall back to
the latest event labeled as weaker evidence). `dashboard.ts` renders it from
templates: ANSI only for a real TTY, width-capped, alerts from real events.
A still-open attempt is NOT proof of work: past the stall threshold the phase
becomes "sem progresso detectável". Alternatives explicitly rejected per the
mission's own constraints (§4-G): an LLM-summary observer agent (token
consumer — the exact failure mode audited in §2.4) and panels fed by repeated
service transcription queries.

**C. History preservation.** `Store.create` used to blindly overwrite
`.oae/state.json`; now a NEW run archives the previous `state.json` +
`events.jsonl` into `.oae/history/<runId>/` (copy-based, idempotent) and
resumes only the same runId. `oae history` lists current + archived runs with
provider 429/401 counts. `oae status` output is unchanged for scripts.

**D. SSE-first runner with reconnect and polling fallback.** Verified live
that `@opencode/client` 2.0.29 exposes `client.event.subscribe()` (SSE over
GET /api/event). `awaitCompletion` consumes the stream incrementally for its
session only (strict sessionID filter): `session.idle`/`status idle`/
`execution.succeeded` settle; `execution.failed` surfaces the provider error
with its HTTP status; service retries are observability signals, deduped by
attempt+message; step/tool events generate progress signals; text deltas are
deliberately NOT consumed (event storm); `usage.updated` carries token usage
so `usage()` skips a redundant `session.get`. Reconnect budget: 5, 100 ms
pause; an unavailable subscription falls back IMMEDIATELY to the verbatim
polling loop with the remaining deadline (indisponibility ≠ transport error);
deadline expiry still interrupts to avoid orphan tokens. The transcript
decides failure vs completion exactly once (`settle`), identical semantics in
both modes — no attempt duplication, no lost final output.

**E. Orchestator authority over the attempt budget.** Provider gates
(`maxProviderRetries` default 3, `providerBackoffMs` default 30 s doubling to
a 120 s cap): an HTTP 429/401 failure with zero confirmed tokens is
re-classified `provider_retry` (new Attempt kind, excluded from
`codeAttempts`) — an engineering attempt is NOT consumed, closes D15's
recorded future work; gates exhausted → task blocked "provider unavailable
after N provider retries — engineering attempts preserved"; a 429 AFTER real
compute (500 confirmed tokens) falls back to the normal engineering path.
Events: `provider_error` + `retry_scheduled` with `providerRetry` counters.

**F. Trade-offs / limitations (documented, not worked around silently).**
(1) SSE is live-only: a missed event while disconnected is not replayed —
recovered by the `session.active()` ground-truth probe at (re)connect plus
the watchdog; (2) progress is SELECTIVE: only material lifecycle events
(steps, tools, retries, usage) — in-progress tool silence looks like no
signal until the next event, and the supervisor's stall verdict remains
time-based; (3) service retry counting from events is informational only;
(4) dashboard `--follow` polls the local .oae files at 1 s, never the
service; (5) real-run validation classified in EFFICIENCY_AUDIT §8 — SSE
feasibility was probed live on the running service (read-only), but runner
behavior under live runs is so far unit-verified only, deliberately: no
provider benchmarks were to be relaunched after the 429 incident (D15).
