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
