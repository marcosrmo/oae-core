# ROADMAP

Status: **v0.1.0 — core system complete and tested** (13/13 unit + 1/1 integration).

## Done (v0.1.0)
- [x] Environment audit (docs/ENVIRONMENT_AUDIT.md)
- [x] Orchestrator: plan → dispatch → supervise → validate → review → consolidate
- [x] OpenCode integration via official client (real sessions, interrupt, context polling)
- [x] Deterministic supervisor (diagnose / recover / quarantine)
- [x] Persistent store (`.oae/state.json` + `events.jsonl`)
- [x] Git safety (branch isolation, baseline preservation)
- [x] Validators with hard timeouts
- [x] Independent read-only reviewer
- [x] Planner (model-assisted + deterministic fallback)
- [x] Evidence-based final report
- [x] Skills package (autonomous-engineering, independent-review, blocked-task-recovery)
- [x] 13 deterministic unit tests + 1 real integration test
- [x] OpenCode→OAE direction: `oae` skill (launch/track missions from inside
      OpenCode) + anti-recursion guards and run lock (D12/D13; unit tested)
- [x] Efficiency audit of the autonomous loop + evidence-backed fixes:
      planner output no longer truncated (model plans now parse), deadline
      expiry interrupts the session (no orphans), empty responses never sent
      to review, per-attempt token telemetry, single-transcript completion
      fetch (D14; docs/EFFICIENCY_AUDIT.md)

## Next (v0.2)
- [ ] Run resumption: `oae resume --dir .` continuing an interrupted run from `.oae/state.json`
- [ ] Parallel tasks with per-task worktrees (isolate concurrent agent file edits)
- [ ] Progress streaming to the terminal (live task/validator status)
- [ ] Cost/latency tracking per attempt (model usage from session context)

## Later
- [ ] Multi-run dashboard (aggregate `.oae/` across projects)
- [ ] Reviewer modes: security-focused review profile, performance profile
- [ ] Auto-generated PR descriptions from the run report
- [ ] Windows service / background daemon mode for long-running requests

## Non-goals (explicit)
- Not a CI system: OAE is invoked explicitly for a request.
- Not a code-quality linter: review quality comes from the configured model.
- Not a secrets manager: all credentials remain in OpenCode/OS stores.
