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
