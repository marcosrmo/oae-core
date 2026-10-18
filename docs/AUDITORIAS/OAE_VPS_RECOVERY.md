# Resgate do OAE antes da recriação da VPS

Data: 2026-10-18 · Branch/fonte: `main` @ `05afa66` (local) · Remote: `origin/main` @ `6c5b043`
VPS atual: Ubuntu 24.04, usuário `dev`, 1 GB RAM / 2 GB swap (crítica).

## Estado do projeto

- Repositório: `/home/dev/projetos/oae-inspecao` (OAE Core), remoto `git@github.com:marcosrmo/opencode-autonomous-engineering.git`.
- 3 commits locais à frente do remoto no momento do resgate (`b8a24b4` fix(cli), `2927dfd` fix(security), `05afa66` docs: record OAE compatibility and security audit) + este commit.
- `npm run typecheck` ✓ · `npm run build` ✓ · `npm test` **61/61** ✓ (baseline Onda 0, evidência em `docs/AUDITORIAS/onda0-test.log`).

## Estado real das Ondas

- **Onda 0: concluída.** Baseline 61/61 testes; log preservado em `docs/AUDITORIAS/onda0-test.log`.
- **Onda 1: PENDENTE — não concluída.** O servidor respondeu, o prompt foi aceito (204), mas a execução real de ferramentas REA não foi comprovada. A única tentativa com o runner corrigido foi abortada (RAM crítica + `opencode serve` fora do ar). Evidências: `docs/AUDITORIAS/onda1/run-report.json` (turn sem tool-calls, SSE encerrado por timeout) e `docs/AUDITORIAS/onda1/events-aborted-20261018-0148.ndjson`.

## Runner da Onda 1 (corrigido e auditado)

- Corrigido: `scripts/onda1/v2runner.mjs` — SHA-256 `3de4d1e70df520f411ce714d90e2d8a6795c9a7c44061b95ac2e53ee214c969a` (original em `/tmp/oae-work/onda1/v2runner.mjs`, inalterado).
- Original de referência: `scripts/onda1/v2runner.orig-0675958.mjs` — SHA-256 `0675958727f1942b55f54d45324752e6dc46edb00eda4cf2ebef134806636b39`.
- Correções aplicadas: (C) rotação de `events.ndjson` com timestamp antes da limpeza; (A) `dir` repassado nas chamadas de estado MCP no fluxo `--cold`; (B) watcher SSE iniciado antes do `prompt_async` + registro incremental via `trace()`; timeout do prompt 45→90 s; extração de tool-calls/`rea_hit` da transcrição; removida linha inócua `args.promptFile`; caminho de erro sem 204 grava relatório antes de encerrar.
- Defeito conhecido do ambiente (não do runner): diagnóstico de repetição de resumos = loop de **compação** do OpenCode 1.19.3 em sessão saturada (~252–267K tokens), sem prompt injection. Sessão afetada: `ses_eb8664b9affetB4vKHTPvBo73s`.

## Investigação REA MCP (relatórios consolidados)

- `docs/AUDITORIAS/REPORT.md` — auditoria OAE × OpenCode 1.19.3 (compat de eventos/prompt, permissões do revisor, missão end-to-end de teste com revisão real `verdict=approve`).
- `docs/AUDITORIAS/REA-MCP-REPORT.md` — integração REA MCP no 1.19.3.
- `docs/AUDITORIAS/REA-OPTIONS-REPORT.md` — comparação de opções de exposição das tools REA (custo de contexto, code mode).

## Ambiente da VPS a recriar

| Item | Valor observado |
|---|---|
| SO / RAM | Ubuntu 24.04, 1 GB RAM / 2 GB swap — **insuficiente**; nova VPS deve ter mais RAM (≥2 GB recomendado) |
| Node.js | v24.22.0 via nvm (`~/.nvm/versions/node/v24.22.0`) |
| OpenCode CLI | `opencode-ai` 1.19.3 em `/usr/bin/opencode` |
| OAE CLI | `opencode-autonomous-engineering@0.1.0` global (instalada do tarball local `/tmp/oae-work/opencode-autonomous-engineering-0.1.0.tgz`; regenerável com `npm pack`) |
| REA MCP | `rea-agents@6.5.0` global |
| Servidor OpenCode | `opencode serve --port 4097 --hostname 127.0.0.1` (histórico em `/tmp/oae-work/p.txt`, `serve-rea3.log`) |

### Configurações que precisarão ser recriadas (valores não registrados por segurança)

- `~/.config/opencode/opencode.jsonc` — seção `mcp.rea`: `{type:"local", command:["node","<nvm>/lib/node_modules/rea-agents/scripts/rea.mjs","mcp"], enabled:true}`. Backups locais: `opencode.jsonc.pre-rea-*`, `opencode.jsonc.rea.backup`.
- `OPENCODE_SERVER_PASSWORD` — **não estava definida** (servidor sem autenticação). Configurar na nova VPS.
- `OAE_OPENCODE_URL` — aponta o OAE para o serviço em execução (modo adaptador 1.x).
- `OAE_OC_URL` — URL base do runner da Onda 1 (default `http://127.0.0.1:4097`).
- Credencial SSH do GitHub para `git@github.com:marcosrmo/opencode-autonomous-engineering.git`.
- Modelo usado: `oc-lab/glm-5.3-flash-free` (provider configurado no OpenCode).

## Procedimento para continuar a Onda 1 na nova VPS

1. Clonar o repo, `npm ci`, `npm run build`, `npm test` (baseline 61/61).
2. Instalar Node v24 (nvm), `npm i -g opencode-ai@1.19.3 rea-agents@6.5.0`; instalar OAE do tarball ou `npm pack` deste repo.
3. Recriar `~/.config/opencode/opencode.jsonc` com a seção `mcp.rea` acima (caminho do nvm pode variar).
4. Iniciar o servidor: `opencode serve --port 4097 --hostname 127.0.0.1` (definir `OPENCODE_SERVER_PASSWORD`).
5. Copiar `scripts/onda1/v2runner.mjs` para um diretório de trabalho e executar UMA tentativa:
   `node v2runner.mjs run --dir /tmp/oae-work` (ver antes: `free -m` com folga ≥300 MB).
6. Critérios de sucesso (não aceitar só HTTP 204): eventos em `out/events.ndjson`; `rep.phases.messages.tools` contendo a tool REA chamada; `rea_hit` não-nulo; relatório consistente.
7. Bloqueio a monitorar: limites de contexto do provedor lab (compação em ~252K tokens); manter sessões curtas.

## Itens que NÃO entraram no Git (preservados apenas nesta VPS)

- `/tmp/oae-work/openapi.json` (479 KB, dump do servidor — regenerável).
- `/tmp/oae-work/sessions.json`, `v1sessions.json`, `v2-probe-msgs.json` — metadados/transcrições de sessões pessoais (privacidade; verificados sem segredos, mas fora do escopo).
- `/tmp/oae-work/v1193/` — checkout do código-fonte upstream do OpenCode (fora do escopo).
- Logs de servidor/teste (`serve*.log`, `test*.log`, `run*.out`) — ruído; conclusões consolidadas nos relatórios acima.
- Backups rotacionados de `events.ndjson`/`run-report.json` (vazios/duplicados).
- `~/.local/share/opencode/opencode.db` — histórico de conversas (privacidade).
- `~/.config/opencode/opencode.jsonc` — arquivo de ambiente com possíveis chaves futuras; recriar conforme seção acima.

## Backups preservados (inalterados)

- `/tmp/oae-work/onda1/v2runner.mjs.bak-20261018-012045` e `.bak-20261018-014437` (SHA `06759587…`).
- `/tmp/oae-work/onda1/out/*.bak-*` (relatórios/logs anteriores).
- `.opencode/opencode.json.bak-20261017-020146` e `.opencode/opencode.json.pre-fase3-20261017-025821` (sem segredos; versionados neste commit como histórico de permissões do `oae-reviewer`).
