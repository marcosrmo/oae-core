# Onda 2 — Providers diretos NVIDIA/OpenRouter (planejamento)

Status: **etapa 1 (provider NVIDIA direto) IMPLEMENTADA, com teste real NVIDIA
APROVADO (2026-10-19, 1 execução — evidências em `/tmp/opencode/oae-w2c/.oae/`,
run `nvidia/z-ai/glm-5.3-flash`, tools locais exercitadas, telemetria real,
zero segredos em artefatos; sem commit/push nesta onda — revisão local primeiro)**.
Gap ainda não validado em produção: fallback não-streaming (stick) coberto
apenas por testes sintéticos; e o planner real via `nvidia-direct` com tools
desligadas não foi chamado no teste real (o plano mínimo determinístico
fallback cobriu a pequena tarefa). Este documento fixa o desenho técnico
para que a Onda 2 execute um provider por vez (NVIDIA primeiro), reutilizando
a fronteira de contratos consolidada na Onda 1.

Limites residuais documentados (atualizados na Etapa 3, 2026-10-19): F8 — a
janela TOCTOU lstat→write do componente FINAL foi fechada com
`open(O_NOFOLLOW)` (§10, Lote A; evidência: testes de recusa + semântica de
flag preservada); troca de componentes de DIRETÓRIO, hardlinks e bind-mounts
continua indetectável por realpath ou por flags de `open` (sandbox completa é
Onda 3 — não alegar resolução). Um `open()` em FIFO não é cancelável pelo
AbortSignal no nível do SO, por isso o runner settle independentemente da
tool (corrida de parada) e descarta resoluções tardias. F10 — RESOLVIDO na
Etapa 3: `filesChanged` agora exclui `.oae/` e `.opencode/` por SEGMENTO de
caminho e marca truncamento explicitamente (§10, Lote D).

Restrição arquitetural no runner direto (auditoria 2026-10-19, achado A2):
no pump do `HttpAgentRunner`, o trecho entre a troca de `pendingUser`
(`const pending = this.pendingUser; this.pendingUser = []`) e o
`settle("completed")` deve permanecer SÍNCRONO — não há `await` entre eles e
por isso um prompt() aceito enquanto `running` ou é drenado no próximo ciclo
do ramo final ou rejeita após o settle (nenhuma janela de descarte). Não
introduzir `await` nesse trecho sem reavaliar a lógica de drenagem da fila
e a nota de follow-up descartado (`droppedFollowUpsNote`): se um await
intercalar a troca, um follow-up poderia ficar em pendingUser já trocado
quando o terminal for `completed` — o único call site de settle sem nota.
Nenhum comportamento de execução foi alterado por esta restrição; ela é uma
trava arquitetural contra refactors futuros. Achados da mesma auditoria:
A1 e A4 foram corrigidos na Etapa 2 (§9); A3 (contagem ±1 char em corte
mid-codepoint, cosmético) segue em aberto — a Etapa 3 não alterou esse
comportamento; aceite ou correção é decisão do dono (sem alegação de
resolução).

Nota de adaptação (plano → código real): a tabela HTTP canônica foi consolidada
em `contracts.ts` (`classifyHttpFailure`: 401/403→auth, 429→rateLimit,
5xx→unavailable, 4xx→protocol) e `classifyProviderError` delega a ela — uma
única fonte de regras para os dois caminhos (adapter opencode e transporte
direto). 5xx é `unavailable` (plano §3) e a semântica única substitui a
classificação "protocol" de 5xx herdada do motor de mensagens.

## 1. Interfaces e módulos a reutilizar (já em `main`)

| Módulo | Papel na Onda 2 |
|---|---|
| `src/contracts.ts` | `AgentRunner`, `SessionOptions`, `ProviderError` + `classifyProviderError` (motor único; F5) — a normalização de erros dos providers diretos desova aqui por construção |
| `src/providers/contract.ts` | `Provider { id, createSession, healthCheck? }` — ponto de entrada de cada backend |
| `src/runtime.ts` | fábrica única: resolve `OAE_PROVIDER` / `--provider` (`opencode` \| `nvidia-direct`; OpenRouter depois); seleção desconhecida falha cedo; `nvidia-direct` não importa/inicia nada do OpenCode (imports dinâmicos carregam só o adaptador escolhido). `index.ts` adiciona `--provider` (default histórico preservado) nas fábricas de `run` e `plan`. |
| `src/sessions/writer.ts` | rollout append-only por tentativa — reuso sem alteração (com fencing de cauda rasgada, F2) |
| `src/orchestrator.ts` / `src/planner.ts` | **inalterados**: consomem `Provider`; gates de falha (429/401) já operam sobre `classifyProviderFailure` |
| `src/store.ts` | `schemaVersion: 1` acretivo — sem mudança de esquema para a Onda 2 |

Novos módulos (etapa 1 — implementados):
- `src/providers/http/transport.ts` — cliente HTTP compartilhável (chat-completions, streaming SSE, fallback não-streaming em 400 "stream", `fetch` injetável, buffers limitados, erros redigidos).
- `src/providers/http/runner.ts` — `HttpAgentRunner implements AgentRunner`: array de mensagens como sessão; primeiro prompt despachado em `begin()` (falha de dispatch rejeita na criação — paridade com OpenCodeRunner); loop de tool-calls por rodadas; usage agregado; ordem de settle única.
- `src/providers/http/filetools.ts` — FileToolSet (read_file/write_file/list_dir) com confinamento canônico à raiz, proudimentos estritos, negação de symlinks, `.oae/.opencode` somente leitura e caps de E/S.
- `src/providers/nvidia.ts` — adaptador NVIDIA fino (`nvidia-direct`): `OAE_NVIDIA_API_KEY` do ambiente (erro claro sem segredo quando ausente), healthCheck barato sem chamada de modelo.
- `src/providers/openrouter.ts` — etapa 2, IMPLEMENTADO (§9) sobre o mesmo transporte (`HttpTransport`/`HttpAgentRunner`/`FileToolSet`).

## 2. Autenticação (sem revelar nem modificar segredos)

- Chaves lidas de variáveis de ambiente no momento da sessão: `OAE_NVIDIA_API_KEY` / `OAE_OPENROUTER_API_KEY` (ou valor já persistido pelo usuário em config própria, se existir). O adaptador só injeta `Authorization: Bearer …`.
- Proibido: logar cabeçalhos, ecoar chaves em `ProviderError.message`, gravar chaves em `state.json` ou rollout. Reuso do `redact()` de `src/progress.ts` em qualquer superfície serializada.
- healthCheck não requer chamada com modelo: `GET` de endpoint barato (ex.: `HEAD`/`GET /v1/models`) apenas para disponibilidade.

## 3. Normalização (respostas, erros, uso, encerramento)

- **Resposta**: SSE padrão OpenAI (`delta.content`, `finish_reason`); `[DONE]` → `outcome: "completed"`; abort/falha de rede → `interrupted`; exceção de protocolo (JSON quebrado, SSE inválido) → `failed` com `ProviderError(kind: protocol)`.
- **Erros HTTP → taxonomia única**: 401/403 → `auth`, 429 → `rateLimit`, 5xx/ENOTFOUND → `unavailable`, 400/422 ou stream malformado → `protocol`, demais → `unknown` (mesmos kinds já testados na Onda 1).
- **Uso de tokens**: `response.usage` → `SessionUsage { input, output, total }`; ausência → `null` (tokensUnknown preservado no evento `provider_error`, sem inventar números).
- **Encerramento**: `interrupt()` cancela a requisição em curso (AbortController) e marca o encerramento local; a sessão HTTP é sem estado por requisição — `sessionId` do runner é local e só alimenta o rollout/telemetria.

## 4. Ferramentas mínimas do coder (fronteira da Onda 2)

O provider direto não possui backend com ferramentas embutidas. A Onda 2
inclui um conjunto mínimo de ferramentas de arquivo executadas **pelo
próprio runner**, todas restritas ao diretório do projeto:

- `read_file`, `write_file`, `list_dir` (sem shell; sem rede; paths
  absolutos ainda proibidos — resolução relativa à raiz da task).
- `planner` e `reviewer` permanecem puramente textuais (JSON de plano e
  parecer), exatamente como hoje.
- Sandbox/permissões completas ficam na **Onda 3** (tool-core); a Onda 2
  documenta explicitamente essa limitação e não expõe `shell`.

## 5. Estratégia de testes (um teste real autorizado por etapa)

1. **Unitários (sem rede)**: `fetch` injetado com respostas gravadas — streaming feliz, abort, 401/429/5xx/malformado, usage ausente, tools do coder (escrita restrita à raiz), redação de segredos.
2. **Conformidade de contrato**: os adapters diretos passam no MESMO conjunto de testes de contrato do `OpenCodeProvider` (incl. "createSession despacha o primeiro prompt").
3. **Um teste real por etapa, protocolo da Onda 1**: diretório temporário, task única, cap 900s desde o início, artefatos em `.oae/` para evidência; NVIDIA primeiro (`nvidia/z-ai/glm-5.3-flash`), OpenRouter só após reauth do usuário.
4. Sem testes reais em CI/repetidos — custo e flakiness fora do escopo.

## 6. Como demonstrar independência do OpenCode

- Nodo estático: `grep -r "@opencode/client" src/providers/{http,nvidia,openrouter}.ts` → zero ocorrências.
- Nodo dinâmico: suíte completa verde **sem** processo OpenCode acessível (service não iniciado; testes usam fetch injetado).
- Nodo ponta-a-ponta: o teste real NVIDIA registra no rollout `runtime: "nvidia-direct"` em `dispatch`, com commit de verificação e `wave2-check.txt` — mesma disciplina da Onda 1 (`oae-w1c`).

## 7. Histórico, retomada, logs e isolamento

- `state.json` (autoridade) + `SessionLog` (observabilidade) inalterados; retomada usa `reconcileRun` existente.
- Nenhum estado global compartilhado entre projetos: tudo sob `.oae/` local; rollout isolado por attempt (`<taskId>-a<n>.jsonl`).
- Estados legados v0 continuam legíveis (prefixo acretivo v1).

## 8. Critérios de aceitação e riscos

**Aceite (etapa NVIDIA)**:
1. Suíte completa verde incluindo os novos testes de contrato direto (sem depender de OpenCode).
2. Teste real NVIDIA único conclui → task `done`, commit criado, rollout com `runtime: "nvidia-direct"` e tokens NVIDIA reportados.
3. Classificação de erros exibida por eventos (`provider_error`) coerente com a taxonomia única.
4. Zero segredos em qualquer artefato persistido (verificação por grep no bundle de evidência).

**Riscos**:
- Suporte a tool-calls varia por modelo/gateway (NVIDIA vs OpenRouter) — mitigado por fixtures por gateway e fallback de formato documentado.
- Streaming fragilidade (possíveis reconexões) — política: falha honesta + retry do orquestrador já existente, sem mascarar.
- Limites de contexto em requests grandes de planner — testar limite real e documentar teto.
- Apr feita sem permissões de sandbox — escopo restrito à raiz do projeto e sem shell (Onda 3 fecha a lacuna).
- Dependência externa (chave expirada/reauth) — bloqueio de ambiente conhecido; gates de auth/rateLimit já existem no orquestrador.

---

## 9. Etapa 2 — Provider OpenRouter direto (implementado 2026-10-19)

### O que foi implementado
`src/providers/openrouter.ts` (`openrouter-direct`) reutiliza **integralmente** o
runtime da etapa 1 (`HttpTransport`, `HttpAgentRunner`, `FileToolSet`) — sem
segundo parser SSE, sem segundo ciclo de ferramentas, sem `@opencode/client`.
Seleção explícita: `--provider openrouter-direct` / `OAE_PROVIDER`
(aliases `openrouter`, `openrouter_direct`); default permanece OpenCode.
Endpoint oficial `https://openrouter.ai/api/v1` (constante exportada).
O OpenCode segue disponível como adaptador independente — nada foi removido.

### Configuração e modelo
- Credencial: **`OPENROUTER_API_KEY`** do ambiente (fallback documentado
  `OAE_OPENROUTER_API_KEY`, nome previsto no plano original). Erro fail-fast
  sem segredo quando ausente. A chave trafega só no header `Authorization`;
  `redact()` cobre o formato `sk-or-…` via padrão `sk-`. Headers extra
  opcionais (`HTTP-Referer`/`X-Title`) **não** são enviados — nenhuma URL
  inventada; o único cabeçalho com credencial é o Authorization.
- Modelo: **obrigatório e nunca inventado** — ids OpenRouter são
  `autor/slug`; passe `--model openrouter/<autor>/<slug>` (o `index.ts`
  resolve para `{providerID: "openrouter", id: "<autor>/<slug>"}` e o runner
  envia `id` verbatim). `createSession` sem modelo → erro de configuração.

### Particularidades da API OpenRouter (docs oficiais, verificadas 2026-10-19)
1. Keepalives `: OPENROUTER PROCESSING` — já ignorados pelo parser SSE
   (linhas comentário). Teste dedicado.
2. **Erro mid-stream**: após o commit do 200, a falha chega como evento SSE
   com `error` no nível superior e `finish_reason: "error"` — o parser
   compartilhado agora a captura e classifica pela tabela HTTP canônica
   (código numérico → `classifyHttpFailure`; sem código → `unavailable`).
   Antes disso, a rodada presented-se como "completed vazia" (corrigido).
3. Chunk final de usage: `choices` não-VAZIO repetindo `finish_reason`
   (desvio do OpenAI) — tratado como frame de contabilidade, sem efeito
   colateral no parser.
4. `stream_options.include_usage` é legacy **sem efeito** lá (usage chega
   automático) — o openrouter-direct inicia o transporte com
   `includeUsage: false` (flag nova em `TransportConfig`); nvidia-direct
   continua enviando (teste "pins" fixa a divergência).

### A1 — limites de memória de corpos HTTP (resolvido; cancelamento de readers fechado na Etapa 3)
`readExcerpt`/`readAll` (`res.text()` ⇒ materialização integral) foram
substituídos por `readBounded(res, cap, signal?, cancelWhenDone?)`: leitura
incremental por chunks via `res.body.getReader()`, memória limitada ao cap
(+ débito de um chunk: um chunk é decodificado ANTES do check e a fila faz
1 prefetch — se um único chunk de fio for gigante, ele é materializado
inteiro antes do break; chunks reais de vendors são pequenos). Contagem de
bytes consumidos.
- **Corpo de erro**: lê apenas `errorExcerptBytes` (2 KB) e PARA de ler;
  reporta "…(body truncated, >2000 bytes — further data not read)".
  **Cancelamento (Etapa 3)**: esses dois caminhos (corpo de erro e
  400-probe) passam `cancelWhenDone: true` — após o trecho coletado, o
  `reader.cancel()` libera a conexão do corpo; falhas de cancel são
  engolidas e nunca mascaram o erro/trecho original (testes com streams
  instrumentados, inclusive cancel hostil que lança). O caminho de sucesso
  continua SEM cancel duplo aqui: o `finally` de `consume()` segue como dono
  do reader (semântica F4).
- **Corpo de sucesso non-streaming**: cap novo `successBodyBytes: 4_000_000`
  (4 MiB — folgado vs. `roundContentBytes` 1 MiB); excedido → erro de
  protocolo controlado sem materializar o resto
  ("exceeded the 4000000 byte cap (consumed N bytes; body not fully read)").
- **Falha de leitura/stream interrompido/abort**: degrada para texto parcial
  honesto ("…(read interrupted after N bytes)" / "(read aborted by
  interrupt)") em vez de buffer gigante — com o `signal` propagado até o
  `readBounded` (R4, abaixo), tanto no fetch real (o abort derruba o body
  stream) quanto em mocks.
- Testes provam a não-materialização com stream *pull-based* que conta os
  bytes efetivamente puxados (assert `consumed ≤ cap + 2 chunks`, ≪ corpo).

### A4 — cap de tool calls no caminho não-streaming (resolvido)
`wireToolCalls` aplica o MESMO `toolSlotsMax` (32) do caminho SSE: array com
mais de 32 `tool_calls` → erro de protocolo controlado
("…more than 32 tool calls (non-streaming…"), antes de alocar `out`.
Tool calls válidas ≤ 32 preservadas (testes em ambos os caminhos).

### Testes executados (resultados reais)
+20 testes OpenRouter/A1/A4 (19 pass + 1 opt-in skip): seleção/aliases,
fail-fast sem credencial, endpoint/cabeçalhos/modelo verbatim, non-stream
(via retry 400 "stream"), streaming com keepalives + usage chunk, erro
mid-stream (com e sem código numérico; redação), tool calls válidos e flood
(streaming e non-streaming), A1 corpo de erro 1 MB (pulled ≤ 18 KB) e corpo
de sucesso > 4 MiB, leitura interrompida, JSON malformado/sem choices, rede
ECONNREFUSED → unavailable, ausência de credencial em sinais/transcript,
interrupção com settle exatamente uma vez, pins `includeUsage`. Suíte
completa pós-correções da auditoria (R3/R4, +3 testes): **133 testes —
131 pass, 0 fail, 2 skipped (opt-ins:
runtime real OpenCode e real OpenRouter), exit 0; typecheck 0 erros; build
exit 0; `git diff --check` limpo.** A única expectativa atualizada foi a do
teste de seleção que pregava `normalizeProviderSelection("openrouter")` como
INVÁLIDO na etapa 1 — agora é alias legítimo do openrouter-direct (o gate
passou a usar `openrouters`, que continua inválido).

### Teste real OpenRouter — NÃO EXECUTADO
Preparado e **desativado por padrão**: `node --test \
--test-name-pattern "DIRECT REAL RUN"` com `OAE_OPENROUTER_REAL=1`,
`OPENROUTER_API_KEY` exportada e **`OAE_OPENROUTER_REAL_MODEL`=<autor>/<slug>**
(obrigatório — sem default inventado). Custo real de tokens; protocolo da
Onda 1 (dir isolado, cap 900 s, artefatos em `.oae/`) quando autorizado.

### Riscos residuais (não resolvidos, sem alegação de oposição)
- **A3**: ±1 char na contagem UTF-8 em corte mid-codepoint (cosmético).
- **F8 — MITIGADO na folha (Etapa 3, §10/Lote A)**: `write_file` abre o
  destino com `O_WRONLY|O_CREAT|O_TRUNC|O_NOFOLLOW` — um leaf que vire
  symlink entre a checagem e o `open` falha com `ELOOP` (mensagem honesta)
  em vez de ser seguido; criação e sobrescrita legítimas preservadas.
  Residuais NÃO resolvidos (não alegar o contrário): troca de componentes
  de diretório, hardlinks e bind-mounts → sandbox da Onda 3.
- **F10 — CORRIGIDO e testado (Etapa 3, §10/Lote D)**: filtro por segmento
  para `.oae/` e `.opencode/` (decisão registrada: ambos excluídos como
  artefatos do harness; arquivos de projeto que apenas começam com ".oae"
  continuam legítimos), strip correta do formato porcelain " M path" e
  marcador explícito de truncamento com contagem omitida (contrato
  `filesChanged: string[]` preservado).
- **R1 — buffer de linha do path SSE SEM limite — CORRIGIDO e testado
  (fechamento pós-auditoria: a conferência passa a valer POR LINHA,
  terminada ou não)**: em `parseSseBody`, o residual que espera um `\n`
  acumulava sem teto (`roundContentBytes` limita apenas o `delta.content`,
  não o framing cru). Auditoria 2 identificou a variante que escapava da
  conferência original: uma linha gigante **terminada dentro do mesmo
  chunk** residia no buffer só um instante — o residual era pequeno no
  check e a linha inteira ia para `JSON.parse` (padding hostil nunca era
  lido, mas era parseado; materialização = tamanho do chunk). Fix em duas
  camadas de `TRANSPORT_CAPS.sseLineBytes = 131_072` (128 KiB): (i) o
  residual SEM `\n` é conferido no laço a cada chunk (memória limitada a
  cap + um chunk entrante, mesma contabilidade do A1) e também no flush de
  EOF (F5); (ii) `drainBuffer` e o flush conferem a linha COMPLETA ANTES de
  `processLine`/`JSON.parse` — a linha gigante nunca é parseada. Contrato
  atualizado: **o limite é de LINHA cru (qualquer linha `data:`, terminada
  ou não) e não de "evento"** (um evento com N linhas, cada uma menor que o
  cap, continua válido — separar linha de evento evita rejeitar eventos
  multi-linha legítimos; decisão documentada). Exceder é um
  protocol error controlado e determinístico ("SSE framing: a raw line
  exceeded the 131072 byte cap (terminated or not…)"). Linhas válidas do
  protocolo (poucos KiB/linha, `\n` presumido no formato) não são afetadas
  — o teste de vários delimitadores no mesmo chunk prova normalidade.
  Efeito colateral aceito e documentado: um payload legítimo
  de >128 KiB numa ÚNICA linha `data:` passaria a ser rejeitado — nenhum
  vendor conhecido emite isso. Evidência dinâmica: stream *pull-based*
  contador de bytes com 300 KB numa única linha não terminada → erro
  determinístico em 2 execuções com `consumed ≤ cap + 2 chunks` (147 KB
  contra 300 KB); linha terminada gigante em um único chunk de 190 KB →
  rejeitada ANTES do parse (o código anterior processava a linha com
  êxito — o teste reprovava antes do fix e passa agora); NÃO demonstrado
  pelos testes: contabilidade de bytes e comportamento em transportes
  undici reais (rede).
- **R2 — redação após truncamento — CORRIGIDO e testado**: sonda dinâmica
  anterior (2026-10-19, 401 com excerpt cortado) confirmou vazamento do
  prefixo `sk-or-v1-` quando o segredo cruza a fronteira do cap (a chave
  completa não vazou; `kind: auth` correto). Causa: `redact()` exige ≥8
  chars após o stem, então um token parcialmente visível na borda escapa.
  Fix em três frentes: (i) **redação ANTES do truncamento** nos sítios que
  cortam um cap de mensagem (`parseNonStreamReply`/linha SSE malformada:
  redact + scrub primeiro, cut depois — impossível fragmentar um token já
  mascarado); (ii) **`redactTruncatedTail()`** (`progress.ts`) para os
  sítios cujo texto JÁ CHEGA cortado (excerpt de erro 2 KB e 400-probe
  300 bytes: o corpo não pode ser re-lido): após `redact()`, mascara
  qualquer cauda que comece numa stem reconhecida e corra até o fim,
  incluindo a própria stem (o "sk-or-v1-" flagado pela sonda); (iii)
  **pós-auditoria 2026-10-19 — FN de stem colada corrigido**: o `\b` antes
  dos stems fazia "xsk-or-v1-…" (segredo colado a palavra) escapar de
  `redact()` E do scrub (confirmado por sonda: retorno imutável). Os \b
  foram removidos: o reconhecimento passou a ser agnóstico de fronteira; um
  id de prosa com forma de token (ex.: "task-01234567") pode ser mascarado
  — o custo é, por ocorrência, um ÚNICO token mascarado, nunca "grandes
  trechos" (cada regra exige stem + ≥8/16 chars contíguos; "task-02" e
  "sk-abc;x" permanecem visíveis); testes: 6 formas de
  segredo (`sk-or-v1-`, `nvapi-`, `ghp_`, `github_pat_`, `xoxp-`,
  `eyJ…`) cortadas na borda → nenhum fragmento; 3 formas COLADAS (chave
  completa e cruzando a borda de truncamento), `kind` preservado em todas;
  mais 400-probe, JSON malformado
  e payload SSE malformado (cortado e EOF); teste unitário do helper.
- **Limitação honesta do fix R2**: a garantia cobre segredos
  **reconhecíveis pelas stems do `redact()`** (lista acima). (a) Um corte
  NO MEIO da própria stem (ex.: "github_pa…") deixa um fragmento que não
  casa com nenhuma stem completa — sem material de segredo (o material
  vem depois do stem), mas com identificação parcial de vendor (aceito;
  notar: redação por prefixo-parcial geraria falsos positivos massivos em
  prosa). (b) Fragmentos mid-corpo com menos de 8 chars ("sk-abc;x")
  permanecem visíveis por design. (c) Chaves SEM stem reconhecível (AWS
  AKIA…, randômicas sem prefixo) estão fora do escopo de `redact()` por
  natureza — também fora do SDK inteiro. (d) A garantia se baseia em
  reconhecimento de stems, não numa prova contra todos os formatos; o
  comportamento em transportes undici reais (fora dos mocks dos testes)
  é inferido estaticamente.
- **R3 — tool_calls malformadas non-streaming — CORRIGIDO e testado**:
  `wireToolCalls` agora descarta itens estruturalmente vazios (sem `name` E
  sem `args`, paridade com o filtro de slots vazios do path SSE); chamadas
  válidas dentro do cap inalteradas (ids de fallback sequenciais e
  conteúdo preservados); tudo-vazio + sem content → protocol error
  "empty content and no tool calls" (testado).
- **R4 — AbortSignal em `readBounded` — CORRIGIDO com escopo mínimo**:
  o `signal` é propagado por todos os chamadores (errorFrom, 400-probe,
  leitura de sucesso non-streaming) e o read corre em `readWithSignal`: um
  abort durante a leitura termina em tempo FINITO com texto honesto
  ("read aborted by interrupt") — incluindo em mocks que nunca resolvem
  (gap mock↔real fechado; no fetch real o abort do request já derruba o
  body stream). Testes determinísticos provam settle <5 s no error-path e
  no 400-probe. Limite de evidência: comprovado com mocks `ReadableStream`;
  o comportamento em fetch real (undici) é inferido estaticamente — sem
  chamada de rede executada.
- **Observações (atualizadas pela Etapa 3)**: compatibilidade de parâmetros
  varia por modelo no OpenRouter (ex.: nem todo modelo suporta tool
  calling). **Decisão Etapa 3 (C3): sem catálogo de modelos nem gate
  rígido** (informações de capability não verificadoras localmente) — a
  Etapa 3 manteve o erro explícito e recuperável (protocol error via
  `classifyProviderError`) como comportamento local determinístico; ao usar
  `openrouter-direct` com o coder, escolher modelo com suporte a tool
  calling documentado. Erro 402 (créditos) classifica `protocol` pela
  tabela canônica (mensagem traz "Payment Required" — diagnóstico claro;
  mudança de tabela não escopo desta etapa). **Etapa 3 (C1)**:
  `healthCheck` dos providers diretos (NVIDIA e OpenRouter) aceita
  `fetchImpl` opcional nas opções de `start()` — default segue o fetch
  global, chamadores existentes inalterados; `detail` continua trazendo
  apenas status/erro de rede, nunca headers/chave. **Etapa 3 (C2)**: o shim
  de prompt do adaptador OpenCode lê o corpo de erro via `readBounded`
  (300 B) em vez de `res.text()` ilimitado; o `res.json()` do caminho de
  SUCESSO segue como residual documentado (serviço local confiável,
  leitura limitada incompatível com o contrato de retorno estruturado).

---

## 10. Etapa 3 — Melhorias reais (implementadas 2026-10-19, sem commit/push)

Alterações de código com testes de regressão; documentação escrita APÓS o
código e a suíte. Suíte após a etapa e as correções da auditoria
pós-implementação (R1–R4): **161 testes — 159 pass, 0 fail, 2 skipped
(opt-ins: runtime real OpenCode `OAE_RUNTIME_TEST=1` e real OpenRouter
`OAE_OPENROUTER_REAL=1` — NÃO executados, como antes)**; base de
comparação: 142/140/0/2 na publicação `f51e10f`; intermediário da Etapa 3
antes das correções: 156/154/0/2 (+14). Δ contra a base: **+19** (14
originais + 1 do R1 [status `T` do porcelain] + 4 do R3 [cenários
scriptados de `writeFully`]); o único teste RENOMEADO é o de cancel duplo
do Lote B — fortalecido com contador de `cancel()` (R4), não teve
expectativa enfraquecida. Nenhum teste foi removido.
Validação final: `npm run typecheck` (0 erros), suíte completa (exit 0),
`npm run build` (exit 0), `git diff --check` (limpo).

### Lote A — F8: abertura segura do componente final de escrita
`FileToolSet.writeFile` (`src/providers/http/filetools.ts`) não usa mais
`fsPromises.writeFile` (que poderia seguir um symlink instalado entre a
checagem `lstat` de `resolveTarget` e o `open`). Agora abre o destino final
com `O_WRONLY|O_CREAT|O_TRUNC|O_NOFOLLOW` (guard `?? 0` para plataformas sem
a constante) e escreve via handle (`Buffer.from(content, "utf8")`) com o
helper **`writeFully`** (R3 da auditoria pós-implementação): loop de
escrita que retoma do `bytesWritten` reportado — escrita curta do
`handle.write` (que o antigo `fsPromises.writeFile` cobria por dentro) não
produz mais arquivo truncado silencioso — e aborta com erro explícito
("write made no progress (N/M bytes written)") quando uma escrita retorna
ZERO bytes; nunca reporta bytes não gravados. O descritor é fechado em
`finally` (falha de close nunca mascara o erro de escrita). `ELOOP` é
traduzido em mensagem honesta ("refusing to write: target is a symlink
(O_NOFOLLOW rejected the open…)"); criação e sobrescrita legítimas de
arquivos regulares preservadas (observed behavior e formato
"written N bytes to …" idênticos). Residual explícito: troca de
componentes de diretório, hardlinks e bind-mounts não são cobertos — Onda
3 (sandbox); a corrida lstat→open NÃO está "resolvida por prova": o ramo
`ELOOP` é evidência ESTÁTICA do flag (flags em `writeFile`), não dinâmica — residual.
Testes F8 (3): criação + sobrescrita legítimas e conteúdo multi-byte
byte-exato; recusa de leaf symlink pré-existente (o alvo externo permanece
intacto); recusa após substituição do leaf regular por symlink — MESMO
RESULTADO da recusa, mas pelo ramo da PRÉ-CHECAGEM de `resolveTarget` (o
teste não alcança o ramo `ELOOP` e não reproduz a corrida real; a
janela lstat→open não é hookável sem injeção de fs, deliberadamente fora
do escopo) + sanidade de `O_NOFOLLOW` disponível no runtime.
Testes `writeFully` (4, cenários scriptados num FileHandle falso &
determinístico): escrita completa em uma única chamada; escrita curta
retomando apenas a cauda não gravada (subarray(offset)); falha de escrita
propagada (nada de sucesso parcial mentiroso); zero progresso → erro
explícito e sem repetição. O caminho real com arquivo regular mantém
cobertura pelos testes filetools acima.

### Lote B — cancelamento dos readers de corpo de erro e 400-probe
`readBounded` (`src/providers/http/transport.ts`) ganhou o parâmetro
`cancelWhenDone` (default `false` — chamadores existentes inalterados):
após o trecho ser coletado (cap atingido, stream terminado, erro de leitura
ou abort), o `reader.cancel()` libera a conexão; falhas de cancel são
engolidas (`.catch(() => undefined)`) e nunca mascaram o resultado.
`errorFrom` (excerpt 2 KB) e o 400-probe (300 B) passam `true`; o caminho de
sucesso por rodadas NÃO (o `finally` de `consume()` é o dono — sem cancel
duplo). Testes (4): excerpt de erro 2 KB de corpo 10 KB com cancel
verificado no stream e erro original/truncamento/`kind` preservados; probe
400 com retry F4 íntegro (exatamente 1 retry, resposta limpa) e probe
cancelado; cancel hostil (stream cujo `cancel()` lança) não mascara o
"HTTP 503"; sucesso de rodada SEM cancel duplo — comprovado por contador de
`cancel()` no stream de sucesso (ZERO disparos; R4 da auditoria:
substitui o teste fraco anterior, que só conferia o conteúdo).
Regressões checadas pela suíte: redação R2, cap SSE por linha R1,
AbortSignal R4 — verdes.

### Lote C — provider testabilidade e comportamento determinístico
- **C1 — healthCheck injetável**: `NVIDIAOptions`/`OpenRouterOptions`
  ganham `fetchImpl?: typeof fetch` (NVIDIA já o usava para chat; agora o
  healthCheck de AMBOS honra: `(this.fetchImpl ?? fetch).call(globalThis,
  …)`). Default fetch global; `start()` existente inalterado; `detail`
  segue sem segredo (status/erro de rede apenas). Testes (2): sucesso
  (`GET …/models` → 200, detail sem `Bearer`/prefixo de chave), 401,
  ECONNREFUSED e verificação de que um `AbortSignal` é de fato repassado
  (timeout aplicável). nvidia: mesmo par (ok/falha de rede).
- **C2 — corpo de erro do adaptador OpenCode**: o shim de prompt
  (`src/providers/opencode.ts`) substituiu `res.text()` (corpo
  ilimitado em memória) por `readBounded(res, 300, undefined, true)` —
  helper exportado (`applyPromptCompatibility`) para teste direto com
  cliente falso, sem servidor 1.x real. Mensagem mantida em forma
  ("session.prompt failed (N): …", trecho ≤ 300 cr). `res.json()` do
  caminho de SUCESSO permanece (contrato estruturado do cliente 2.0 —
  residual documentado acima). Teste (1): corpo de erro de 2 MB
  (stream pull-based) → mensagem emitida < 360 chars; exatamente 1 fetch
  bruto de fallback.
- **C3 — modelos sem tool calling**: decisão registrada, sem alteração de
  código (ver "Observações" do §9): sem catálogo/gate local — o erro
  explícito e recuperável segue o comportamento; escolha de modelo com
  tool calling documentada.

### Lote D — orquestrador: `changedFiles` determinístico e truncamento explícito
`src/orchestrator.ts`: `changedFiles` agora é exportada e aceita
`inspectGitImpl` injetável (default: `git.inspectGit` — produção
inalterada). Comportamento provado por testes (4):
1. `.oae/` e `.opencode/` (árvores e entradas de diretório) são excluídos
   por SEGMENTO de caminho — incluindo o caso porcelain " M path", que o
   filtro antigo (`startsWith(".oae")` sobre a linha CRUA com prefixo de
   status) deixava vazar; arquivos de projeto que apenas COMEÇAM com
   ".oae" (".oae-lookalike.ts") permanecem legítimos (o antigo filtro,
   com seu match por prefixo cru, os excluía indevidamente).
2. Arquivos de baseline (parâmetro `exclude` — lista inalterada do caller
   em `orchestrator.ts:406`) continuam removidos.
3. Strip correta do formato porcelain `XY ` (incl. " M", "MM", "A ", "D ",
   "??") — o regex antigo `^[MARC?]+\s*` não cobria o espaço inicial do
   unstaged deixava prefixos sujos nos relatórios. Correção pós-auditoria
   (R1): a classe inclui também **`T`** (typechange) do alfabeto
   A C D M R T U X ! ? — testado em `" T path"`, `"T  path"` e
   `" T .oae/…"` (artefato continua filtrado).
4. >50 arquivos → marcador explícito na ÚLTIMA posição
   ("…(N more changed files omitted — list truncated at 50)") com a
   contagem exata de omissos; ≤50 → lista íntegra, sem marcador.
Contrato público preservado: `filesChanged: string[]` (`store.ts` v1) e o
renderizador de relatório continuam recebendo um `string[]`.
Decisão de escopo (dono, registrada): `.opencode/` excluído como artefato
do harness (a OAE não o produz nem o consome como artefato de tarefa;
config do próprio opencode). Se um projeto legítimo mantiver conteúdo de
produto sob `.opencode/`, os arquivos editados nele não aparecerão em
filesChanged — exclusão registrada aqui deliberadamente (reavaliar na Onda 3 se isto
se tornar real).

### Pendências transferidas (sem alegação de resolução)
- **A3** (±1 char, cosmético): aguardando decisão de aceite/correção do dono.
- **Sandbox de escrita completa** (dir-swap/hardlink/bind-mount): Onda 3.
- **Testes opt-in** (`OAE_RUNTIME_TEST=1`, `OAE_OPENROUTER_REAL=1`):
  executáveis SOMENTE com autorização (dir isolado, cap 900 s, credenciais
  apenas no ambiente).
- **Leak de conexão no caminho de SUCESSO non-streaming** (pré-existente e
  evidenciado pelo teste R4 do Lote B com contador de `cancel()`): o
  `res.body?.cancel()` do `finally` de `consume()` não reverte travado (o
  reader interno do `readBounded` não está liberado) — falha engolida, sem
  efeito funcional; candidato a reutilizar o padrão `cancelWhenDone` do
  Lote B num follow-up de 1 linha. NÃO é cancel duplo (o cancel do stream
  dispara ZERO vezes — comprovado).
- **`res.json()` do caminho de sucesso do adaptador OpenCode**: leitura
  limitada incompatível com o retorno estruturado — residual documentado.
- **Transportes undici reais**: comportamento de cancel/limites inferido
  estaticamente (mocks completos; nenhuma rede nesta etapa).
