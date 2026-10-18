# REA MCP 6.5.0 — instalação e validação no OpenCode 1.19.3 (2026-10-17)

Ambiente: VPS Ubuntu 24.04, usuário `dev`. Prioridade NVMe. OpenCode: `opencode-ai@1.19.3` (`/usr/bin/opencode`), config global `~/.config/opencode/opencode.jsonc` (JSONC com JSON puro).

## O que foi instalado

- `rea-agents@6.5.0` no cache do npm (válido via `npm view --json`): `latest`, `binários` `rea`/`rea-agents`. Depois **instalado globalmente** via nvm/nodes `v24.22.0`:
  - bin: `/home/dev/.nvm/versions/node/v24.22.0/bin/rea`
  - entry MCP: `/home/dev/.nvm/versions/node/v24.22.0/lib/node_modules/rea-agents/scripts/rea.mjs`
  - subcomandos vistos: `setup [--client opencode --yes] [--dry-run] [--format json]`, `mcp add|doctor`, `doctor`, `--mcp` (stdio), `uninstall`
- Skill REA instalada em `~/.agents/skills/reverse-engineer-anything` — `installed_version: 42`, `installed_tool_count: 207`, state `aligned` (existe dentre arquivos "installed_version" e "installed_tool_count").

## Configuração OpenCode aplicada

Chave correta no 1.19.3: `mcp` (não `mcpServers`) servidor local:

```jsonc
"mcp": {
  "rea": { "type": "local", "command": ["node", "/home/dev/.nvm/versions/node/v24.22.0/lib/node_modules/rea-agents/scripts/rea.mjs", "mcp"], "enabled": true }
}
```

Backups da config: `opencode.jsonc.pre-rea-20261017-211145` (REA setup original escreveu `npx -y rea-agents@6.5.0 mcp`), `opencode.jsonc.pre-rea-direct-212813`, `opencode.jsonc.rea.backup` — todos `chmod 600`. Nota: o `setup` REA original também congelou nuance: o `command` dele (npx) era lento (~7,4s init) junto com `mcp list` TUI; trocamos pelo caminho direto e o init caiu para ~5,8s.

## Evidências

- `npx -y rea-agents@6.5.0 mcp doctor --format json` → `healthy: true`, adapter `production-stdio`, `protocol 2025-11-25`, `207 tools, 6 prompts`, uma única instância, `request_flow` tool `binary_session` ok, catálogo hash `405725e736ec...`. `doctor` global infelizmente mostra `healthy:false` por **engines externos ausentes** (Ghidra/IDA/jadx — `missing_analysis_engine`).
- Handshake stdio direto (`/tmp/oae-work/mcp-probe.mjs`): `initialize` ~5,8–7,4s, `tools/list` +2,5s (≈8,5s até o tools list completo) — **o REA server em si é pesado para ligar**.
- `opencode mcp debug rea` (TUI): `MCP server rea is not a remote server` — prova de que a config é lida.
- **Validação end-to-end FUNCIONAL** via `opencode run` (TUI/CLI mode, `agent build`):
  ```
  ⚙ rea_binary_session Unknown
  RESULTADO: open=false; providers: macOS nativo, artifact-graph, dotnet, Ghidra, Hopper, IDA; Ghidra/Hopper indisponíveis (GHIDRA_INSTALL_DIR ausente, /opt/hopper/bin/Hopper não executável).
  ```
  → o modelo chamou tool REA e obteve resposta real do servidor MCP.
- Ciclo de vida: o processo `node .../rea.mjs mcp` nasce no boot do `opencode run`/TUI e **termina junto com a execução** (observado `ps` durante e após).

## Achado principal (limitação)

**Modo `opencode serve` headless 1.19.3 NÃO carrega MCP servers**:
- Config lida (CLI `mcp debug` sabe do `rea`), mas o processo serve não faz spawn de nenhum filho `rea.mjs` (nem no boot, nem na criação de sessão via API, nem durante turno do modelo com prompt real).
- Sessão via API (`/api/session` + `prompt`, `agent build`) completou com lista de tools nativa (`apply_patch, bash, edit, glob, grep, question, read, skill, todowrite, webfetch, websearch, write`) — **nenhuma tool rea**.
- Em contrapartida, `opencode run` (CLI, sobe servidor interno) expõe as 207 tools e as chamadas funcionam.

## Log/provas nesta pasta

- `serve-rea.log` / `serve-rea2.log` — logs de serve (boot, porta 4097).
- `mcp-list.log`, `mcp-debug.log` — capturas script(1) do TUI 1.19.3.
- `mcp-probe.mjs` — handshake MCP direto com medidas de tempo.
- `rea-oc-test2.mjs` — prova de sessão via API (fallback sem tools rea) — título `rea-oc-serve2`.
- `run-rea.log` — spoke do `opencode run` "ok" (valida ciclo).

## Consequências para o OAE

- Os agentes headless do OAE (via serve 1.19.3) **não podem usar REA MCP direto**; qualquer uso do REA em missões deve passar por execuções CLI (ex.: `opencode run` sub-agente), ou um plugin que faça bridging de tools (alternativa a validar depois).
- Bench: init REA ~6s + tools/list ~2,5s por processo — usar cache (uma instância por `opencode run`) e evitar processos por chamada (custo de latência por turno).
- Config global não alterada fora da chave `mcp`; nenhum dado do provider tocado; backups todos preservados.
