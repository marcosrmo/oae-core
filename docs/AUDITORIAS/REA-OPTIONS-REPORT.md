# REA × missões headless do OAE — investigação comparativa (2026-10-17)

Restrições respeitadas: nada instalado/commitado/push; nenhum arquivo de config alterado; os 3 commits de checkpoint intactos. Evidências coletadas ao vivo no serve 1.19.3 (porta 4097) e no fonte do repositório (worktree do upstream em `/tmp/oae-work/v1193`, tag `v1.19.3` = commit `e3c4eb2425`).

## Descoberta-chave (muda a comparação)

O OpenCode 1.19.3 **não** deixa `opencode serve` headless sem MCP — o que faltava era o *caminho de sessão*:

1. **Rota v1 (`/api/session` + `/api/session/{id}/prompt`, a usada hoje pelo adaptador OAE)**: NUNCA expõe tools REA — 4 sessões testadas (`rea-oc-serve2/3/4`, `rea-prompt-probe`), com estado MCP conectado ou frio.
2. **Rota v2 (`/session` + `/session/{id}/prompt_async`)**: expõe as 207 tools REA (`rea_binary_session`, `rea_binary_overview`, `rea_batch_decompile`, …) e executa de verdade:
   - `rea-v2-call2`: modelo chamou `rea_binary_session` → `RESULTADO: binary_session open:false, servidor "rea" 6.5.0, sem alvo aberto; Ghidra/Hopper indisponíveis` (~15s de turno).
3. **Métrica de contexto**: turno trivial com MCP montado = **8.0–8.0K input tokens** vs **nativo = 8.0K** (`/tmp/oae-work/tok-compare.mjs` — provas `tok-com-mcp` 7.919 vs `tok-sem-mcp` 7.979). Motivo: o 1.19.3 usa **code mode** (`packages/opencode/src/tool/code-mode.ts`): NÃO manda 207 defs por request; monta UMA tool `execute` + um catálogo compacto (`describeCatalog`). As contagens ~250K vistas em sessões antigas são ruído do provedor lab (glm-5.3-flash-free), não custo real. Exposição de 207 tools no 1.19.3 é **barata em contexto**.

## Estado/limites do MCP no serve 1.19.3 (medidos)

- **Bootstrap lazy**: o estado MCP só inicializa no 1º acesso (`InstanceState.make`, `src/mcp/index.ts:492`). Nada spawn até alguém tocar `MCP.Service`.
- **Rotas públicas** (OpenAPI `/doc`): `GET /mcp` (status), `POST /mcp` (add dinâmico, in-memory), `POST /mcp/{name}/connect`, `POST /mcp/{name}/disconnect`, auth OAuth. Roteamento por instance: query `location[directory]` ou header `x-opencode-directory`; sem isso cai na instância do **`process.cwd()` do serve** — as sessões do OAE rodam nessa instância default (wd do processo = `/home/dev/projetos/oae-inspecao`).
- **Latência de montagem**: handshake direto ~6s init + ~2,5s `tools/list` ≈ 9s; **via serve: `POST /mcp/connect` = 51–58s** (conecta, mas o HTTP só responde depois; tentativas >90s também terminam conectadas). `GET /mcp` à quente = 0,5s. Per-call `DEFAULT_TIMEOUT = 30s` (`src/mcp/index.ts:38`), `mcp.timeout`/`experimental.mcp_timeout` configuráveis (não alterados agora).
- **Recuperação**: matar o processo REA → status vira `{"rea":{"status":"failed","error":"Connection closed"}}` (observado); `POST /mcp/rea/connect` re-estabelece (51s+). `disconnect` é instantâneo (60ms).
- **Concorrência**: observados **2 processos rea.mjs simultâneos** (instâncias `/tmp/oae-work` e cwd). Cada instância = montagem própria (novo cold de ~51s por diretório novo).
- **RAM**: rea.mjs ≈ **3–4MB RSS** por instância; serve ≈ 252MB. Totalé host com 2 reas + serve ficou em ~72–93MB livres (apertado, ok).
- **Ciclo de vida do serve**: MCP morre **com o processo do serve** → realuast after restart do serve = novo cold de ~51s. `mcp list` TUI só representa o próprio processo, não o serve.

## Comparação das 3 opções

### 1. Subprocesso `opencode run` para tarefas de investigação
| Dimensão | Avaliação |
|---|---|
| RAM | **Pior**: cada `opencode run` ≈ 460MB RSS no pico (medido) + rea; em 1GB só 1 por vez |
| Latência | ~46–90s por chamada (boot do run + mount MCP + turno) por **cada** investigação |
| Tokens | novo cold de cache a cada run; contexto duplicado (missão + sub-turno) |
| Ciclo de vida | automático (processo morre no fim; rea sai junto — observado) |
| Concorrência | 1 no máximo (RAM de 1GB) |
| Segurança | agente de missoon roda o OAE review dentro do próprio run; o reviewer perde as garantias de permission hmh (novo core) |
| Recuperação | código de saída; falha = refazer tudo a partir do zero |
| Manutenção | baixa (nenhuma mudança no OAE além de chamar o CLI) |

### 2. Bridge MCP dedicada (OAE ↔ REA)
| Dimensão | Avaliação |
|---|---|
| RAM | 3–4MB (rea) + processo ponte mínimo |
| Latência | mount 9s uma vez por missão; chamada ~200–500ms |
| Tokens | sob controle (ponte escolhe subconjunto de tools: ~10–30K em vez de catálogo completo) |
| Ciclo de vida | precisa ser gerenciado pelo OAE (spawn/kill/timeout/race) |
| Concorrência | 1 processo por missão (RAM ok), 2 se preciso |
| Segurança | OAE decide fio-a-fio — melhor pos de restringir a análise somente leitura |
| Recuperação | por conta da ponte (novo código a testar) |
| Manutenção | **alta**: cliente MCP próprio, protocolo (stdio, framing, timeouts), não coberto por testes OAE atuais |

### 3. Atualizar o OpenCode
- **Não há release mais nova**: `1.19.3` é o `latest` publicho (npm). O upstream em dev é o rewrite (`2.0.32-dev`, GitLab fork) — mudança radical, não "fix pontual".
- **Não é preciso**: a superfície v2 já existente no 1.19.3 resolve serve+MCP (evidência da descoberta-chave).

### (constatada durante a prova) — v2 route sem alterar nada do opencode
- Opeção mais barata: o serve JÁ oferece `/session`+`prompt_async` com MCP completo; ao OAE cabe usar essa rota (adaptador) + warm-up `GET /mcp` no boot.

## Recomendação

**Rota v2 do serve + warm-up**, como caminho primário, com **bridge MCP como plano B** (redução de catálogo/controle de permissão) e **opencode run apenas como fallback manual**. Atualização de versão: sem objeto.

Justificativa consolidada:
- zero componente novo no OAE customer (só trocar a rota do prompt no adaptador `src/opencode.ts` quando autorizado);
- um rea.mjs de ~4MB por instância, uma montagem de ~51s por boot do serve (1×), 0 tokens de def extras (code mode), execução REAL de tool já provada pelo mesmo caminho das missões;
- recuperação e status têm rotas oficiais (`/mcp`, `/mcp/{name}/connect`), auditáveis pelo supervisor;
- bridge MCP se justifica somente se ficaltverdo que o catálogo completo expõe superfície demais para o `oae-reviewer` (ver critério de segurança no PoC).

## Plano de prova de conceito (passos + critérios objetivos)

Passos (execução futura, sem commits nesta fase):
1. **Warm-up no boot** (script novo, sem tocar no OAE): chamar `GET /mcp` (instância default do serve) após subir o serve; aceitar se status `rea: connected` ≤ 90s.
2. **Sessão v2 do OAE**: app adapter `prompt_async` (endpoint `/session`, eventos `/event`) num mini-runner standalone (não-commit) para manter "sem código no OAE", operando os mesmos artefatos que o OAE:
   - criar sessão v2 com `directory` = repo alvo; prompt de investigação pedindo chamar 1 tool rea (ex.: `rea_binary_overview`) e imprimir `RESULTADO:`.
   - **Aprova se**: tool chamada com sucesso (output non-vazio), turno completo ≤ 240s (P50 ≤ 120s em 3 rodadas), 0 tool calls bash — exceto nenhum.
3. **Eventos**: consumir SSE `/event` e registrar pelo menos `session.idle` (ou terminal) do ciclo; prova de que o OAE `awaitCompletion` pode ser reescrito para v2 sem 26s de debounce.
4. **Segurança do reviewer**: rodar 1 turno do `oae-reviewer` via v2 com pedrion ataque REA (`rea_binary_session` com alvo do repo) e verificar NENHUMA modificação de arquivo (checksum do repo bafo/depois) + TENTATIVA de uso de tool PROIBIDA para o reviewer (permissão v2 para `mcp:rea:*` = deny no `oae-reviewer`) → **Aprova se**: tool call do reviewer é bloqueada ou inexistente e os 5 vetores antigos de bash continuam bloqueados.
5. **Cold-restart**: derrubar o serve, subir de novo + warm-up + 1 turno — **Aprova se**: ponta-a-ponta ≤ 3min e status final `fail` ou `done, sesão completa`.
6. **Falha do REA mid-turn**: `kill` no rea durante um turno; **Aprova se**: o OAE termina com `outcome erro/اكerrupted em vez de hang (≤ 60s pós-kill leaking process`), e `POST /mcp/rea/connect` restaura o estado (≤ 90s).
7. **RAM**: heap máximo de todas as rodadas = `free -m` < 20MB de `available` mínimo; **Aprova se**: OOM-kill ausente e 2 agentes (coder+reviewer) sequênciais com chronometer.

## Evidência indexada (arquivos `/tmp/oae-work`)

- `openapi.json` — rotas públicas do serve (incl. `/mcp*`, `/session*`, `/event`, `/global/health`).
- `v2-prompt-probe.mjs` / `v2-call-probe.mjs` — prova v2 de listagem/call de tools (sessions `rea-v2-*`).
- `tok-compare.mjs` — A/B de tokens com/sem MCP (7.919 vs 7.979).
- `mcp-status.json`, `connect-resp.json`, `mcp-probe.mjs` — status/connect/handshake direto.
- `REA-MCP-REPORT.md` — relatório anterior da instalação/validação (v1 findings ainda válidos).
- Worktree fonte: `/tmp/oae-work/v1193` (remissível: `git worktree remove` no fim do estudo).
