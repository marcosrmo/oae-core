# ENVIRONMENT AUDIT

Date: 2026-10-16 · Auditor: OAE build agent · Method: direct inspection of the live environment, official OpenCode V2 documentation (`https://opencode.ai/v2/docs/`), and the installed OpenAPI document. No configuration was modified.

## Confirmed environment

| Component | Value | Evidence |
| --- | --- | --- |
| OS | Windows 10 Pro 10.0.19045 | `Get-ComputerInfo` |
| Shell | PowerShell 5.1 (`PSVersionTable` 5.1.19041.6456) | `$PSVersionTable` |
| Terminal context | VS Code (`TERM_PROGRAM=vscode`, `COLORTERM=truecolor`) | env vars |
| Node.js | v24.19.0 — native TypeScript type-stripping confirmed working (`node file.ts` runs `.ts` directly) | `node --version` + probe run |
| npm | 11.17.0 | `npm --version` |
| pnpm | 11.21.0 | `pnpm --version` |
| bun | **not installed** | probe |
| Git | 2.55.0.windows.4 | `git --version` |
| OpenCode | **v2.0.29** (CLI binary: `@opencode/cli`, Go binary at `AppData\Roaming\npm\node_modules\@opencode\cli\bin\opencode.exe`) | `opencode --version` |
| OpenCode service | running, `http://127.0.0.1:49374`, pid 12796, `persistentPty: false` | `opencode service status`, `opencode api get /api/info` |

## OpenCode v2.0.29 — capabilities confirmed against the installed version

All items below were verified against the **running service**, not against newer-version docs.

### Service API (from the service's own `/openapi.json`)
- Session lifecycle: `POST /api/session` (accepts `agent`, `model`, `location: {directory}`, `metadata`, `permissions`), `POST /api/session/{id}/prompt` (text/files/agents/skills attachments), `POST /api/session/{id}/interrupt` (`resume` query), `POST /api/experimental/session/{id}/wait`, `DELETE /api/session/{id}`, fork, revert, compact, inbox, forms.
- Observation: `GET /api/session/{id}`, `GET /api/session/active`, `GET /api/session/{id}/log`, `GET /api/session/{id}/context`, `GET /api/event` (SSE), `GET /api/session/{id}/diff`.
- Agents: `GET /api/agent` — built-ins: `build` (primary, tools allowed), `plan` (primary, **read-only**: `edit` denied), `general`, `explore` (subagent, read-only+shell), `compaction`, `title`, `summary`.
- VCS: `/api/vcs/status`, `/api/vcs/diff`, `/api/vcs/branch`, `/api/worktree`.
- Permissions: per-session rulesets (`POST /api/session` body `permissions`) plus per-agent rules in config.
- Skills: `GET /api/skill` lists builtin `opencode`, `report`, and user skills; loaded via `skill` tool.

### Official client library
- `@opencode/client@2.0.29` on npm — exact version match with the installed CLI. Verified live:
  - `Service.ensure()` from `@opencode/client/service` discovers/reuses the running service (no extra server start needed).
  - `OpenCode.make({ baseUrl, headers: Service.headers(endpoint) })` builds a typed client; auth is HTTP Basic (`opencode:<password>` from `service.json`), injected by the client, never exposed.
  - Session round-trip tested live: `session.create({title, location:{directory}})`, `session.log()`, `session.interrupt()` all succeeded (probe session `ses_ebcc596ecffe3Bxz8Byx2h9zWY`).
- Service registration file: `%USERPROFILE%\.local\state\opencode\service.json` (`id`, `version`, `url`, `pid`, `password`). The client reads it; callers never touch the secret.

### Providers / models
- Authenticated providers (via `opencode auth list`): **Groq, Nvidia, OpenRouter** (API keys stored by OpenCode; never read or printed by this audit).
- Available model providers through the API: `groq`, `nvidia`, `opencode` (internal), `openrouter`.
- No provider/model is hard-coded in OAE; the model is resolved at runtime (config → API default).

### MCP servers (global config `~/.config/opencode/opencode.jsonc`)
- `playwright` — connected.
- `rea` (REA 6.5.0) — connected; ~207 tools (native/managed/Electron analysis, debugger sessions: GDB/Rizin/Frida, browser scenario, network captures).
- Decision: **OAE does not depend on REA or playwright.** REA is not needed for source-repository engineering (per its own skill: "Skip REA for ordinary source-repository architecture analysis"). The system only requires tools OpenCode ships natively (read/edit/shell/git).

### Agents, skills, permissions in global config
- Global `opencode.jsonc` defines no custom agents, no plugins, no project overrides; `mcp.servers` + `mcp.timeout` only. Nothing was modified.
- Built-in skills surfaced by `/api/skill`: `opencode`, `report`, `reverse-engineer-anything`.
- Skill format for this version (docs/skills): `.opencode/skills/<id>/SKILL.md` with frontmatter `name`/`description`; IDs derive from path; permissions via `skill` action rules.

## Git / GitHub
- Git identity configured (user.name/email — present in global config).
- `gh` CLI: **not installed**. GitHub publication must go through `git` over HTTPS and/or the GitHub REST API.
- Git Credential Manager: credential for host `github.com` **present** (user `marcosrmo`, password present in the OS credential store — never printed). Verified via `git credential fill` with redacted output.
- No GitHub token in env (`GITHUB_TOKEN`/`GH_TOKEN` absent). Public repo list for `marcosrmo` does **not** contain `opencode-autonomous-engineering`; no public repo to reuse (a private repo could still exist and was checked during publish).
- Working directory `Documents\Projetos` is not itself a Git repo; it contains several project folders (some may be repos — OAE treats each target project independently and never touches siblings).

## Incompatibilities, limitations and workarounds

| Finding | Impact | Decision / workaround |
| --- | --- | --- |
| Windows PowerShell 5.1 is the shell; no bash | Scripts must be PowerShell/Node cross-platform | All runtime code is Node; no bash scripts |
| Node without build tooling | No ts-node/bun | Use Node 24 native TS type-stripping (no build step); `typescript` kept as devDependency only for `tsc --noEmit` typecheck |
| OpenCode version is 2.0.29 (not newest) | Newer endpoints (e.g. `/api/vcs/init`) may behave differently | Lock `@opencode/client` to exactly `2.0.29`; rely only on endpoints present in the installed service's own OpenAPI; pin file `docs/pinned-openapi-paths.md` not needed — audit is the record |
| `gh` CLI absent | Repo creation / issue publishing via `gh` impossible | Publish via git push over HTTPS (GCM credential) and GitHub REST API only when the user authorizes it |
| No project-local OpenCode config audited for existing projects | Agents must not disturb user projects | OAE writes only its own files (`.oae/`, `.opencode/` inside the **target demo project** it is asked to work on) |
| `session.wait` is under `/api/experimental/` | Endpoint could change | Supervisor uses polling of `session.active()`/`session.log()` with bounded timeouts; `wait` used opportunistically |
| Local service port is dynamic | Hard-coding the port would be fragile | Always resolve via `Service.ensure()` at runtime |
| `persistentPty: false` in service info | Persistent terminal feature unavailable | Not used; commands run through agent sessions and validator child-processes with hard timeouts |

## Security posture established by the audit
- Secrets (service password, provider API keys, GitHub credentials) are read only by the OpenCode client / git credential store, never logged, never persisted to `.oae/`, never included in reports.
- `.env` files: read access in the default agents is already `ask`-gated by OpenCode built-in permissions; OAE does not change that.
- All shell execution by the orchestrator runs with hard timeouts and captured output; reviewer sessions are created **read-only** (edit/write denied at agent level).

## Compatibility verdict
The environment fully supports the planned minimal architecture: Node 24 + `@opencode/client@2.0.29` (typed, official, version-matched) driving the running service; git for state isolation; no new MCP, plugin or standalone service required.
