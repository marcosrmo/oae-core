# Auditoria OAE × OpenCode — evidências consolidadas (2026-10-17)

Ambiente: VPS Ubuntu 24.04, usuário `dev`. Repo objeto: `/home/dev/projetos/oae-inspecao` (main @ `6c5b043`).
Referência de leitura: `/home/dev/projetos/opencode-upstream` (dev @ `8c173a8f38`). CLI: `opencode-ai@1.19.3` em `/usr/bin/opencode`.

## Arquivos modificados no repo (sem commit, conforme instrução)

- `src/opencode.ts` (+140): modo adaptador `OAE_OPENCODE_URL` + probe `/api/health`; shims `applyPromptCompatibility` e `applyEventCompatibility` (1.x → contrato de eventos v2). Caminho nativo v2 (Service.ensure + headers) intacto.
- `src/index.ts` (+30): `requestArg()` — valores de `--dir/--model/--repo/--concurrency` não são tomados como pedido da missão; `arg()` simplificada.
- `src/setup.ts` (+42): `oae init` escreve chave `agent` (singular) com `permission` map; purga entrada legada `agents.oae-reviewer` (silenciosamente descartada no 1.19.x).
- `.opencode/opencode.json`: idem — permission map + allowlist bash somente strings exatas (`git status`, `pwd`, `ls`, `npm test`, `node --version`).

Backups preservados: `.opencode/opencode.json.pre-fase3-20261017-025821`, `.opencode/opencode.json.bak-20261017-020146`, `~/.config/opencode/opencode.jsonc.pre-prov` (config global OpenCode não alterada nesta fase).

## Evidências por teste (arquivos nesta pasta)

- `sdk-ev12/13/14.mjs` (stdout nos logs da sessão): wire format do prompt REST 200; SDK 2.0.29 entrega eventos `session.next.*`; adaptador emite `session.step.started/ended` + idle sintético.
- `sse-tail.mjs` / `sse-map.mjs`: ciclos completos de eventos do 1.19.3 (sem `session.idle`; silêncio terminal após `step.ended`).
- `rev-replica.mjs`: revisão real com `oae-reviewer` → 114s, output 1961 chars, `verdict=approve` Parseable (antes do debounce 25s: 30s, output vazio).
- `negtest3/4/5/6.mjs`: vetores de escrita do revisor. 3/4/5: escapes executados (`grep x > f`, `git diff > f`, `cat f|tee f2`, heredoc) — falha corrigida. 6 (pós-fix): todos `error/blocked`, zero arquivos criados; `git status` permitido.
- `run4.out` + `/tmp/oae-disp/.oae/REPORT.md`: missão end-to-end `done`/`done`, branch `oae/auto-mvcs46rt`, commit `fab8476`, rework real após rejeição do revisor (`ReferenceError: greet is not defined`).
- `test-fase6.log`: typecheck limpo, build ok, `npm test` 61/61 pass (exit 0), sequencial (serve de teste desligado; RAM do host ~0.9GB).

## Bloqueios resolvidos nesta sessão

1. Parser CLI ingeria valor de `--model` como pedido da missão (tentativas vazias) → `requestArg`.
2. Debounce 8s → sessões fechadas mid-stream (reviews "unparseable") → 25s.
3. Allowlist bash com wildcard → escrita via redirect → strings exatas.
4. Serve de teste precisa reinciar para ler config nova de permissões (config lida no startup).

## Estado final

- `npm run typecheck` ✓ · `npm run build` ✓ · `npm test` **61/61** ✓ (0 skip)
- Git: 4 arquivos modificados, backuo/report não rastreados; nenhum commit/push (instrução).
- CLI global OAE reinstalada a partir do tarball local (`/tmp/oae-work/opencode-autonomous-engineering-0.1.0.tgz`).
