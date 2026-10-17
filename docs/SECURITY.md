# SECURITY

## Secret handling

| Secret | Where it lives | Who reads it |
| --- | --- | --- |
| OpenCode service password | `%USERPROFILE%\.local\state\opencode\service.json` | `@opencode/client` only (HTTP Basic); never logged, never persisted by OAE |
| Provider API keys (Groq/Nvidia/OpenRouter) | OpenCode auth store | OpenCode service only; never read by OAE |
| GitHub credentials | OS credential store (Git Credential Manager) | `git push` only, via credential helper; never printed |

OAE never reads, stores, or logs any of these. Nothing in `.oae/` or in reports
contains credentials.

## Agent permissions

- **Reviewer agent (`oae-reviewer`)** — read-only by construction. Its agent
  definition (installed into the target project by `oae init`) uses the singular
  `agent` config key with a `permission` map denying `edit`, `write`, `task`,
  `webfetch`, `websearch` and `browser`.

  **Bash allowlist — exact strings only (audit 2026-10-17).** The allowlist keeps
  `"*": "deny"` and allows only full fixed commands: `git status`, `pwd`, `ls`,
  `npm test`, `node --version`. Rationale, proven by live negative tests against
  the OpenCode 1.19.3 server: the server matches a command by its first token
  against each pattern, so any wildcard entry (e.g. `cat *`, `grep *`,
  `git diff*`) let the reviewer write files via shell redirection and pipes —
  `grep 123 > f.txt`, `git diff > f.txt`, `cat f | tee f2.txt` and
  `cat > f.js << EOF … EOF` all executed with write side effects. After the fix,
  the same vectors returned `error/blocked` (tool state) and no files were
  created (verified: `hack*` file count 0 in the test project). File reading by
  the reviewer is expected to use OpenCode's native read/glob/grep tools, which
  are not shell-mediated.

  **Resolution-key hazard (fixed).** On OpenCode 1.19.x the plural `agents`
  config key is partially merged and the `permission` map inside it is silently
  dropped — with the legacy key the reviewer ran with `edit`/`write` enabled.
  `oae init` now writes the singular `agent` key and purges any legacy
  `agents.oae-reviewer` entry. Resolution is asserted via
  `opencode debug agent oae-reviewer` (tools deny: True) and by end-to-end
  negative tests through real API sessions against the 1.19.3 server
  (2026-10-17; evidence scripts under `/tmp/oae-work/negtest*.mjs`, see
  `docs/TEST_REPORT.md` "Lab audit" section).

- **Coder agent** — the OpenCode `build` agent under OpenCode's own permission
  system. File mutations are additionally contained by the git branch
  (`oae/auto-<runid>`) and the baseline-preservation rules below.

## File-system safety

- OAE writes only: `.oae/` (its own state) and `.opencode/` (skills + agent
  definitions) **inside the target project it was explicitly pointed at**.
- It never touches sibling projects; the parent directory is not assumed to be a repo.
- All shell execution (validators) runs as child processes with hard timeouts and
  captured output (`stdout`/`stderr` truncated in the store).

## Git safety

- **Baseline preservation.** Before any agent runs, the set of pre-existing
  uncommitted files is recorded. Every OAE commit (`git add -A` + `restore --staged`
  for baseline files + `git commit`) excludes them. Test:
  "git preservation: user uncommitted work is never committed by OAE".
- **Branch isolation.** All agent work lands on `oae/auto-<timestamp>`; the user's
  checkout branch is never modified. No `git reset --hard`, no `git checkout -- .`,
  no destructive git operations anywhere in the codebase.

## Anti-recursion (D13)

An OAE run dispatches OpenCode agent sessions; those sessions must never launch
further OAE runs. Four layers:

1. The `oae` OpenCode skill (this package, `skills/oae/SKILL.md`) opens with the
   rule: sessions dispatched *by* an OAE run never invoke the OAE CLI.
2. Coder, reviewer and planner prompts carry an explicit no-nested-run rule.
3. `run` and `plan` hold `.oae/run.lock` (pid + runId) for the duration of the
   run. A second concurrent run in the same directory is refused with exit
   code 3; locks whose pid is no longer alive are reclaimed automatically;
   `--force` overrides a live lock as an explicit operator action.
4. Every run is bounded regardless: maxAttempts (3), maxRecoveryCycles (2),
   taskTimeoutMs (30 min), runTimeoutMs (2 h), commandTimeoutMs (5 min).

## Publication

`oae publish` is **authorization-gated**: it is only invoked on explicit user
instruction (not part of autonomous runs). It pushes the current branch over HTTPS
using the credential helper and, when needed, creates the repository via the GitHub
REST API. Repos are private by default; `--public` opts out explicitly.

## Network surface

The only network traffic during a run is: OpenCode service (localhost) ↔ provider
API (via OpenCode), plus `git push` if the user authorized publication. No telemetry,
no third-party calls from OAE itself.
