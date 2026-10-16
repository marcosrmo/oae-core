<div align="center">
<img src="img/OAE Core_ Engenharia Autônoma em Verde.png" alt="OAE Core — Engenharia Autônoma" width="380">

# OAE Core

**AUTONOMOUS ENGINEERING ORCHESTRATOR**

**Mantendo o trabalho de engenharia avançando.**

![Node](https://img.shields.io/badge/node-%E2%89%A524-3c873a?logo=nodedotjs&logoColor=white)
![OpenCode](https://img.shields.io/badge/OpenCode-v2%20%C2%B7%20client%202.0.29-6b46c1)
![Tests](https://img.shields.io/badge/tests-46%2F46-brightgreen)
![Status](https://img.shields.io/badge/status-v0.1%20%C2%B7%20experimental-orange)

</div>

OAE Core é um **orquestrador de engenharia autônoma** construído sobre o serviço do
**OpenCode v2**. Dada uma requisição de engenharia em linguagem natural, ele planeja,
despacha sessões de agentes reais do OpenCode (coder + revisor independente somente
leitura), executa os validadores do próprio projeto e faz commit em um branch isolado
— tudo supervisionado por um watchdog determinístico com limites rígidos de tempo e
de tentativas.

> **Dependência atual:** o OAE Core **não** executa modelos por conta própria. Toda a
> inteligência vem de sessões do OpenCode; o OAE é a camada que sequencia, observa,
> supervisiona e contém essas sessões.

---

## Visão geral

O objetivo do OAE Core é **reduzir a necessidade de intervenção manual constante** em
tarefas de engenharia de software, sem abrir mão de **rastreabilidade, limites
operacionais e controle** sobre a execução. Na prática ele:

- **coordena tarefas de desenvolvimento** a partir de uma requisição única;
- **acompanha cada execução** com estado e eventos persistidos em arquivo;
- **identifica estagnação e falhas** (agente parado, sessão inativa, erro de provedor);
- **apoia o diagnóstico** com um painel determinístico e um relatório baseado em evidências;
- **conduz tentativas controladas de recuperação e validação** dentro de orçamentos fixos.

O que ele **entrega** hoje: um loop de execução auditável, com estado inspecionável após
uma interrupção e limites de segurança rígidos, além de um painel de observabilidade que
nunca inventa dados (zero confirmado é diferente de desconhecido).

---

## O problema que resolve

Orquestrar agentes de código de ponta a ponta é frágil na prática. Os problemas
operacionais que motivaram o projeto (todos observados em execuções reais — ver
`docs/EFFICIENCY_AUDIT.md`):

- **agentes que param de progredir** — a sessão continua "viva" mas não produz avanço;
- **sessões que ficam inativas** — o serviço não sinaliza claramente que o trabalho cessou;
- **falhas que exigem intervenção manual** — erros de provedor (limite de uso, autenticação)
  derrubam a tentativa sem explicação no estado;
- **perda de visibilidade** — sem painel, o único jeito de entender um run era reabrir o
  JSON manualmente;
- **dificuldade de distinguir execução ativa de execução sem progresso** — uma tentativa em
  aberto *parece* trabalho, mesmo quando está parada.

O OAE Core ataca esses pontos com supervisão determinística, limites rígidos, telemetria
por tentativa e um painel que deriva o progresso de sinais verificáveis. **Isso não
significa que os problemas estejam totalmente resolvidos:** estagnação ainda é detectada
por tempo (política), não por compreensão do conteúdo do agente, e a recuperação é
limitada — ver [Estado atual e limitações](#estado-atual-e-limitações).

---

## Arquitetura e módulos

OAE Core é organizado em cinco camadas conceituais. A coluna **Estado** é rigorosa sobre o
que existe hoje:

| Camada | Módulos reais | Estado |
| --- | --- | --- |
| **OAE Core** — orquestração, estado, tarefas, tentativas, decisões | `orchestrator.ts`, `store.ts`, `planner.ts`, `config.ts`, `git.ts`, `report.ts`, `runlock.ts`, `validators.ts`, `util.ts` | **Implementado** e coberto por testes |
| **OAE Guardian** — supervisão, diagnóstico, recuperação controlada | `supervisor.ts` (watchdog determinístico — não é um LLM) | **Implementado** |
| **OAE Agents** — agentes especializados | prompts de coder/reviewer/planner + `skills/` (`autonomous-engineering`, `independent-review`, `blocked-task-recovery`) | **Parcial** — coder (`build`), revisor somente-leitura (`oae-reviewer`) e planner (`plan`) existem; perfis especializados (segurança, contexto, documentação) são **planejados, não implementados** |
| **OAE Control Center** — dashboard, eventos, progresso, histórico | `dashboard.ts`, `viewmodel.ts`, `events.ts`, `history.ts` | **Implementado** (terminal; não há UI web) |
| **OAE Connect** — integração com OpenCode / MCP / motores futuros | `opencode.ts`, `skills/oae/` | **Implementado apenas para o OpenCode v2** via `@opencode/client@2.0.29`; MCP e outros motores **não implementados** (decisão D10: sem MCP no núcleo) |

> Os nomes das camadas são uma organização conceitual. Não existem hoje serviços,
> binários ou interfaces separados chamados "Guardian", "Control Center" ou "Connect" —
> são módulos TypeScript dentro deste repositório.

### Fluxo de execução

```
                    ┌────────────────────────────────────────────────────┐
 requisição ───────▶│ Orchestrator (OAE Core)                            │
                    │  1. run lock (.oae/run.lock, anti-recursão D13)    │
                    │  2. Store.create (arquiva run anterior)            │
                    │  3. prepareGit (branch oae/auto-<id>)              │
                    │  4. plano (modelo + fallback determinístico)       │
                    │  5. por tarefa:                                    │
                    │       dispatch coder ──▶ awaitCompletion ◀──┐      │
                    │       validadores (timeout rígido)          │ SSE/ │
                    │       dispatch revisor (somente leitura) ───┘ poll │
                    │       commit no branch do run  ───────────▶ OpenCode│
                    │  6. validadores finais + relatório           service│
                    └───────────────┬────────────────────────────────────┘
                                    │ ticker de supervisão (5 s)
                    ┌───────────────▼────────────────────────────────────┐
                    │ Supervisor (OAE Guardian) — inspeção pura de estado │
                    │  ocioso ≥ 7 min → diagnóstico + contexto            │
                    │  ocioso ≥ 10 min → interrupção + re-dispatch        │
                    │  limites excedidos → quarentena (task blocked)       │
                    └────────────────────────────────────────────────────┘
```

---

## Como o OAE funciona atualmente

1. **Criação e acompanhamento de uma missão.** `oae run "<request>" --dir <projeto>`
   adquire `.oae/run.lock` (um run por diretório — *anti-recursão*, D13) e, se ausente,
   instala o agente revisor + skills no projeto alvo (idempotente). `Store.create` passa a
   **arquivar** o run anterior em `.oae/history/<runId>/` antes de sobrescrever o estado.
2. **Planejamento e execução de tarefas.** O planner pede um plano JSON ao modelo com
   **fallback determinístico** (detecção de stack + descoberta de validadores) se a
   resposta não for um plano válido. As tarefas executam em ordem de dependência, com
   concorrência limitada (`--concurrency`, padrão 1).
3. **Tentativas e sessões de agentes.** Cada tarefa despacha uma sessão OpenCode
   (`AgentRunner`): o coder usa o agente `build`; o revisor usa `oae-reviewer`
   (somente leitura) sobre o diff não commitado e devolve um veredito JSON. Rejeição vira
   instruções refinadas para a próxima tentativa.
4. **Integração com o OpenCode.** A conexão usa `@opencode/client@2.0.29` (versão fixada
   para casar com o serviço instalado) via `Service.ensure()`; autenticação HTTP Basic é
   feita pelo cliente, nunca exposta.
5. **Acompanhamento via SSE, reconexão e fallback.** `awaitCompletion` consome o stream de
   eventos do serviço (`GET /api/event`) **incrementalmente e apenas para a sua sessão**
   (filtro estrito por sessionID): `session.idle`/`status idle`/`execution.succeeded`
   concluem; `execution.failed` revela o erro do provedor com o status HTTP. Há
   **reconexão com orçamento limitado** (5 tentativas) e, se a assinatura estiver
   indisponível, **fallback imediato** para o loop de *polling* de `session.active()` +
   `session.context`. O texto das mensagens (deltas) **não** é consumido (evita tempestade
   de eventos).
6. **Telemetria e procedência.** O consumo de tokens por tentativa
   (`GET /api/session/{id}` ou `session.usage.updated`) é gravado em `attempt.evidence.tokens`.
   O painel distingue **zero confirmado** de **desconhecido**: uma tentativa sem registro
   de uso nunca é apresentada como zero.
7. **Histórico e diagnóstico de falta de progresso.** `.oae/history/` preserva runs
   anteriores; o painel deriva fases operacionais e marca `sem progresso detectável` quando
   não há atividade confirmada além do limiar — uma tentativa ainda aberta **não** é prova de
   trabalho.
8. **Erros de provedor.** Falhas HTTP 429/401 **sem tokens confirmados** são
   reclassificadas como `provider_retry`: elas **não consomem** o orçamento de tentativas de
   engenharia. Esgotados os gates, a tarefa é bloqueada com motivo explícito
   (`provider unavailable (HTTP N) after 3 provider retries — engineering attempts preserved`). Um 429
   **após** computação real (tokens > 0) segue o caminho normal de engenharia.

---

## Dashboard e observabilidade

Comandos que **existem** hoje (CLI em `src/index.ts`):

| Comando | Descrição | Opções |
| --- | --- | --- |
| `oae run "<request>"` | Executa uma missão completa | `--dir`, `--model`, `--dry-run`, `--concurrency`, `--force`, `--quiet` |
| `oae plan "<request>"` | Só planeja (dry run), imprime as tarefas em JSON | `--dir`, `--model` |
| `oae status` | Tabela de tarefas + status do run | `--dir` |
| `oae report` | Relatório final baseado em evidências (texto) | `--dir` |
| `oae dashboard` (alias `watch`) | Painel do run atual | `--dir`, `--follow`, `--detail` |
| `oae history` | Lista runs atuais + arquivados (com contagem 429/401) | `--dir` |
| `oae reconcile` | Reconcilia um run órfão (dono do lock morto): preserva snapshot e grava `interrupted` | `--dir` |
| `oae init` | Instala `.opencode/` (skills + agente revisor) no projeto | `--dir` |
| `oae publish` | Publica no GitHub (somente com autorização explícita) | `--dir`, `--repo`, `--public` |

Exemplos:

```pwsh
# snapshot do run atual (seguro em CI/redirecionamento; sai imediatamente)
oae dashboard --dir .

# acompanhamento contínuo (apenas em TTY), com linha do tempo completa
oae dashboard --follow --detail --dir .

# histórico de execuções
oae history --dir .
```

O `dashboard` é **determinístico**: todas as linhas são montadas a partir de
`.oae/state.json` + `.oae/events.jsonl`, sem chamadas ao serviço e **sem LLM**.
`--follow` relê apenas os arquivos locais a cada 1 s. `Ctrl+C` encerra o painel
(comportamento padrão do Node — nenhum listener de sinal é registrado). Cores ANSI só em
TTY real; em pipe/CI a saída é texto limpo.

### Progresso ao vivo durante `oae run`

`oae run` imprime **progresso em tempo real no stderr** enquanto trabalha — uma linha por
evento realmente persistido, com timestamp, estado e escopo (tarefa#tentativa):

```
[13:08:19Z] [planning]    run started — make the CLI installable (model openrouter/z-ai/glm-5.3-flash)
[13:08:19Z] [running]     plan ready — 1 task(s)
[13:08:19Z] [waiting]     task-1#1   attempt 1 dispatched (agent build, kind code) — waiting for the session
[13:09:10Z] [validating]  validator typecheck: exit=0 — ok
[13:12:00Z] [completed]   run finished: done — 1/1 tasks completed
```

Estados: `planning`, `running`, `waiting`, `validating`, `recovering`, `interrupted`,
`failed`, `completed` (mais `info`/`unknown` para eventos neutros ou não reconhecidos).

- O **stdout** permanece apenas o relatório final — `oae run > report.md` é seguro.
- **Sem mensagens artificiais**: sem evento, sem linha. Silêncio é silêncio real, nunca um
  "provavelmente ainda trabalhando"; a última linha sempre corresponde a um evento gravado.
- Atividade do agente é limitada (throttle por tentativa) para não virar tempestade de logs;
  mensagens passam por redação de credenciais. `--quiet` desliga o feed.
- **Não existe canal de eventos em tempo real para a TUI do OpenCode v2.0.29.** Para
  acompanhar de dentro de uma sessão, rode em background e faça *polling* limitado de
  `oae status`/`oae dashboard` (a skill `oae` documenta a receita).

### Eventos, estado, transcrição e telemetria — o que é o quê

- **Eventos estruturados** — `.oae/events.jsonl` (append-only, um JSON por linha). Tipados
  em `src/events.ts`; a taxonomia é **aditiva** (kinds históricos nunca são renomeados).
- **Estado** — `.oae/state.json`: tarefas, tentativas (com session IDs), decisões,
  resultados de validadores, git (branch, baseline).
- **Telemetria de consumo** — tokens por tentativa em `attempt.evidence.tokens`, com
  procedência (confirmado vs. desconhecido).
- **Relatório** — `.oae/REPORT.md` (gerado ao fim de `run`) e `oae report`.
- **Transcrição do agente** — o painel **não** exibe a transcrição completa. Ele mostra uma
  **linha do tempo derivada** (rótulos determinísticos), não o texto das mensagens. O
  supervisor captura apenas o *tail* da transcrição para montar o contexto de recuperação.

---

## Estado atual e limitações

**Implementado e coberto por testes determinísticos** (sem chamadas a provedores):

- loop completo plan → dispatch → supervise → validate → review → commit;
- supervisor determinístico (diagnóstico → recuperação → quarentena);
- store persistente + histórico/arquivamento de runs anteriores;
- eventos tipados + projeção (`RunView`) + painel determinístico;
- gates de provedor 429/401 que preservam o orçamento de tentativas de engenharia;
- runner SSE-first com reconexão e fallback por polling;
- preservação de baseline no git e isolamento por branch.

**Ainda não validado em execução real ponta a ponta:**

- o **runner SSE-first** foi verificado apenas por testes unitários; somente a
  *assinatura* do stream foi sondada ao vivo (read-only). Não houve benchmarks de provedor
  após o incidente de 429 (D15).

**Limitações conhecidas (documentadas, não contornadas em silêncio):**

- **Dependência do OpenCode.** Sem um serviço OpenCode v2 em execução e ao menos um provedor
  autenticado, nada roda. O OAE não é autônomo do OpenCode.
- **SSE é live-only.** Um evento perdido durante uma desconexão não é reproduzido; isso é
  mitigado pela sondagem de `session.active()` e pelo watchdog.
- **Progresso é seletivo.** Só eventos materiais de ciclo de vida geram sinal; silêncio entre
  ferramentas pode parecer ausência de sinal e o veredito de estagnação continua sendo por
  tempo.
- **Interrupção do processo.** `oae run` trata `SIGINT`/`SIGTERM`/exceções e grava
  `interrupted` (nunca deixa `running` órfão). Se o processo for morto de forma abrupta
  (`SIGKILL`/queda de energia), `oae status`/`oae dashboard` projetam o run como
  `interrupted` (órfã) e `oae reconcile --dir .` persiste o estado, preservando um snapshot
  do original em `.oae/history/`. A retomada de um run interrompido — `oae resume` — ainda
  não existe.
- **Sem benchmarks válidos** de economia de tokens ou latência: as medições antes/depois
  foram invalidadas pelo incidente de limites do provedor; apenas proxies estruturais são
  afirmados (ver `docs/EFFICIENCY_AUDIT.md` §8).
- **Sem CI.** Os testes rodam localmente; não há workflows configurados no repositório.
- **Primariamente testado em Windows** (PowerShell) com Node ≥ 24 e OpenCode v2.0.29.

**Planejado (não implementado):** retomada de run (`oae resume`), tarefas em paralelo com
worktrees por tarefa, perfis de revisão (segurança/performance), dashboard multi-run, modo
daemon. Ver [Roadmap](#roadmap).

---

## Instalação e desenvolvimento

### Requisitos

- **Node.js ≥ 24** (usa *type-stripping* nativo para rodar `.ts` direto do checkout).
- **Serviço OpenCode v2 em execução** (`opencode service status`) com ao menos um provedor
  autenticado (`opencode auth list`).
- **Git** no `PATH`.

### A partir do checkout (desenvolvimento)

```pwsh
git clone https://github.com/marcosrmo/opencode-autonomous-engineering.git
cd opencode-autonomous-engineering
npm install
npm run typecheck          # tsc --noEmit
npm test                   # suíte unitária determinística (sem provedores)
```

Para rodar a CLI direto da fonte, sem instalar:

```pwsh
node src/index.ts status --dir .
node src/index.ts run "add a sub() function with a test" --dir .
```

### Instalação global (`oae`)

O pacote é compilado para `dist/` (`tsconfig.build.json`), e o `bin` aponta para
`dist/index.js`. O script `prepare` roda o build automaticamente em `npm install`/`npm pack`.

```pwsh
# a partir do clone
npm install -g .

# ou a partir de um tarball (sem clonar)
npm pack                                                    # gera o .tgz
npm install -g opencode-autonomous-engineering-0.1.0.tgz
```

Depois disso:

```pwsh
oae            # lista os comandos disponíveis
oae init --dir .
oae run "<request>" --dir .
```

> `dist/` é **gerado** e não é versionado (está no `.gitignore`); rode `npm run build` após
> alterações em `src/` antes de uma instalação global. O pacote é `private` — não é publicado
> no registro npm.

### Testes

| Script | O que faz |
| --- | --- |
| `npm test` (ou `npm run test:unit`) | Suíte unitária determinística com agentes falsos — **sem chamadas a provedores** |
| `npm run test:integration` | Teste real ponta a ponta (serviço + provedor reais; **consome tokens**) |
| `npm run typecheck` | `tsc --noEmit` |

### Layout do projeto

```
src/
  index.ts          CLI (run | plan | status | report | dashboard | watch | history | init | publish)
  orchestrator.ts   plan → dispatch → supervise → validate → review → consolidate
  supervisor.ts     watchdog determinístico: diagnose / recover / quarantine
  opencode.ts       integração com o OpenCode (sessões, SSE, telemetria)
  viewmodel.ts      projeção state.json + events.jsonl → RunView (fases, stall, tokens)
  dashboard.ts      renderer determinístico do painel (TTY/CI-safe)
  events.ts         camada de eventos tipados (taxonomia aditiva)
  history.ts        histórico + arquivamento de runs anteriores
  store.ts          estado do run (.oae/)
  planner.ts        detecção de stack, descoberta de validadores, plano
  git.ts            isolamento por branch, preservação de baseline, commits
  validators.ts     checks do projeto com timeout rígido
  report.ts         relatório final baseado em evidências
  publish.ts        publicação no GitHub (somente com autorização)
  config.ts         defaults + overrides de .oae/config.json
  setup.ts          instala skills + agente revisor no projeto alvo
  runlock.ts        lock de um run por diretório (anti-recursão)
  util.ts           runCommand (timeouts), escrita JSON atômica, append JSONL
skills/             procedimentos de agente (autonomous-engineering, independent-review,
                    blocked-task-recovery) + a skill `oae` para operar o OAE de dentro do OpenCode
test/               testes unitários (agentes falsos) + teste de integração real
docs/               arquitetura, recuperação, segurança, decisões, auditorias, relatório de testes
img/                identidade visual
```

### Configuração

Os defaults ficam em `src/config.ts`; um projeto pode sobrescrevê-los em
`.oae/config.json`. Principais limites de recuperação: `diagnoseMs` 7 min, `recoverMs`
10 min, `pollMs` 5 s, `maxAttempts` 3, `maxRecoveryCycles` 2, `taskTimeoutMs` 30 min,
`runTimeoutMs` 2 h, `commandTimeoutMs` 5 min, `maxProviderRetries` 3, `providerBackoffMs` 30 s.

---

## Segurança e operação

- **Isolamento por branch.** Todo trabalho dos agentes cai em `oae/auto-<id>`; o branch do
  usuário nunca é modificado. Sem `git reset --hard`, sem operações destrutivas.
- **Preservação de baseline.** Arquivos que já estavam sujos antes do run são registrados e
  **excluídos de todo commit** do OAE — não podem ser perdidos.
- **Revisor somente leitura.** O agente `oae-reviewer` nega `edit`/`write` no nível do
  agente: ele revisa, mas não altera.
- **Timeouts rígidos.** Cada comando de validador, sessão de agente e o run inteiro são
  limitados no tempo.
- **Anti-recursão (D13).** Sessões despachadas pelo OAE nunca iniciam outro OAE; um lock por
  diretório (`.oae/run.lock`, pid + runId) recusa um segundo run concorrente (exit 3).
  Locks com pid morto são recuperados automaticamente; `--force` é a sobreposição explícita
  do operador. Limites de tentativas/ciclos valem de qualquer forma.
- **Sem segredos nos artefatos.** Senha do serviço, chaves de provedor e credenciais do
  GitHub ficam com o OpenCode/gerenciador de credenciais — nunca são lidas, logadas ou
  persistidas em `.oae/`.
- **Publicação é autorizada.** `oae publish` só roda sob instrução explícita (repositórios
  privados por padrão).

Detalhes completos em [`docs/SECURITY.md`](docs/SECURITY.md) e
[`docs/RECOVERY.md`](docs/RECOVERY.md).

---

## Roadmap

A prioridade é **confiabilidade da execução → observabilidade ponta a ponta → recuperação
segura**, antes de prometer autonomia total.

**Concluído (Fase 0 e Fase V):**

- [x] finalização de estado em saída anômala do processo e reconciliação de execuções órfãs
      (`oae status`/`dashboard` projetam `interrupted`; `oae reconcile` persiste, preservando
      o histórico);
- [x] progresso ao vivo no terminal durante o run (`oae run` imprime eventos reais no stderr;
      `--quiet` desliga).

**Próximo (v0.2) — planejado:**

- [ ] retomada de run: `oae resume` continuando um run interrompido a partir de `.oae/state.json`;
- [ ] tarefas em paralelo com worktrees por tarefa;
- [ ] papéis adaptativos (Tester/Integrator determinísticos) e seleção de modelo por papel.

**Depois — planejado:**

- [ ] dashboard multi-run (agregando `.oae/` entre projetos);
- [ ] perfis de revisão (segurança, performance);
- [ ] descrições de PR geradas a partir do relatório do run;
- [ ] modo daemon / serviço em segundo plano.

**Não-objetivos (explícitos):** não é um sistema de CI (o OAE é invocado explicitamente); não
é um linter de qualidade (a qualidade da revisão vem do modelo configurado); não é um
gerenciador de segredos.

---

## Contribuição e licença

- **Licença:** não há arquivo de licença neste repositório (`LICENSE` ausente). O
  `package.json` está marcado como `"private": true`. Portanto, **os termos de
  distribuição não estão definidos** — não reutilize nem redistribua sem consultar o autor.
- **Contribuição:** não há `CONTRIBUTING.md` nem CI configurada. Para contribuir localmente,
  rode `npm run typecheck` e `npm test` antes de abrir um PR; mudanças de design devem ser
  registradas em [`docs/DECISIONS.md`](docs/DECISIONS.md).

---

<sub>OAE Core · AUTONOMOUS ENGINEERING ORCHESTRATOR · construído sobre o OpenCode v2.0.29 · [docs](docs/)</sub>
