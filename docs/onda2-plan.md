# Onda 2 — Providers diretos NVIDIA/OpenRouter (planejamento)

Status: **planejado, não implementado**. Este documento fixa o desenho técnico
para que a Onda 2 execute um provider por vez (NVIDIA primeiro), reutilizando
a fronteira de contratos consolidada na Onda 1.

## 1. Interfaces e módulos a reutilizar (já em `main`)

| Módulo | Papel na Onda 2 |
|---|---|
| `src/contracts.ts` | `AgentRunner`, `SessionOptions`, `ProviderError` + `classifyProviderError` (motor único; F5) — a normalização de erros dos providers diretos desova aqui por construção |
| `src/providers/contract.ts` | `Provider { id, createSession, healthCheck? }` — ponto de entrada de cada backend |
| `src/runtime.ts` | fábrica única: estende para resolver `providerID` (`opencode` \| `nvidia-direct` \| `openrouter-direct`) a partir da configuração; nenhum outro site instancia provider |
| `src/sessions/writer.ts` | rollout append-only por tentativa — reuso sem alteração (com fencing de cauda rasgada, F2) |
| `src/orchestrator.ts` / `src/planner.ts` | **inalterados**: consomem `Provider`; gates de falha (429/401) já operam sobre `classifyProviderFailure` |
| `src/store.ts` | `schemaVersion: 1` acretivo — sem mudança de esquema para a Onda 2 |

Novos módulos:
- `src/providers/http/transport.ts` — cliente HTTP compartilhável (chat-completions, streaming SSE) com `fetch` injetável para testes.
- `src/providers/http/runner.ts` — `HttpAgentRunner implements AgentRunner`: converte o ciclo conversacional localizado (array de mensagens) em `awaitCompletion`/`interrupt`/`transcriptTail`.
- `src/providers/nvidia.ts` e `src/providers/openrouter.ts` — adapters finos: baseURL, header de auth, id de modelo, quirks de cada API. Nenhuma lógica compartilhada duplicada.

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
