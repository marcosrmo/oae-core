# TEST REPORT

Scope: `node --test test/unit.test.ts` (13 tests, deterministic, no provider calls)
and `node --test test/integration.test.ts` (1 test, real OpenCode service).
Typecheck: `tsc --noEmit` — clean. Environment: Windows 10 Pro, Node v24.19.0,
OpenCode v2.0.29, git 2.55.0.windows.4.

## Unit / harness tests (fake agents — no provider calls)

| # | Test | Validates | Result |
| --- | --- | --- | --- |
| 1 | task lifecycle: dispatch → review → validators → commit → done | happy path: coder completes, reviewer approves, validator passes, commit created, task `done` | PASS |
| 2 | persistent store: state.json + events.jsonl recorded | state/events persisted with correct kinds and ordering | PASS |
| 3 | independent review rejects and drives rework until approved | reviewer rejection → refined re-dispatch → approval on 2nd attempt | PASS |
| 4 | validator failure keeps task out of done (criteria enforcement) | failing validator → rework; task cannot complete while red | PASS |
| 5 | stall detection: 7min diagnosis, 10min recovery, refined redispatch | supervisor diagnoses at `diagnoseMs`, interrupts + re-dispatches at `recoverMs` with refined context | PASS |
| 6 | attempt limit and cycle prevention: repeated stalls end blocked | repeated hangs exhaust `maxAttempts` → task `blocked` with precise reason | PASS |
| 7 | supervisor quarantines a task past the recovery-cycle limit | quarantine action + `supervisor_quarantine` event + stalled session interrupted | PASS |
| 8 | agent failure: task blocked, independent task continues | provider/runner failure → failed attempt → retry; independent task unaffected | PASS |
| 9 | dependency failure blocks dependent task | parent `failed` → dependents `blocked` ("dependency failed") | PASS |
| 10 | command timeout recorded (legitimate long ops bounded separately) | validator command exceeding `commandTimeoutMs` → timed-out result recorded | PASS |
| 11 | git preservation: user uncommitted work is never committed by OAE | pre-existing dirty file survives every OAE commit untouched | PASS |
| 12 | final report renders real evidence | report contains tasks, attempts, validator outputs, decisions from the store | PASS |
| 13 | supervisor does not diagnose while progress is recent | recent signals → no diagnosis action | PASS |

**Aggregate: 13/13 PASS** (last full run: 76673 ms total).

## Integration test (real OpenCode service + real provider)

### I-01 — Sessão real do OpenCode implementa e revisa uma alteração (PASSOU)
- Config: modelo `openrouter/z-ai/glm-5.3-flash`; agentes `build` (coder) e
  `oae-reviewer` (read-only, instalado via `installIntoProject`).
- Setup: projeto Node mínimo em diretório temporário; validador `node test.js`.
- Coder real: criou sessão no diretório do projeto, editou `index.js` (implementou
  `sub()`) e `test.js` (assert `sub(5,2) === 3`), retornou saída final.
- Revisor real: sessão separada analisou o diff (`git diff`), re-verificou critérios,
  retornou veredito aprovado.
- Resultado do orchestrator: task `done`; validador executado com code 0; session ids
  reais (`ses_*`).
- **Resultado: PASSOU** (~72 s).

## Demo end-to-end via CLI (real OpenCode service)

### D-01 — `oae run` sobre `examples/demo-project` (PASSOU)
- Comando: `node src/index.ts run "Add a sub(a, b) function to index.js ... and
  extend test.js to assert that sub(5, 2) === 3." --dir examples/demo-project
  --model openrouter/z-ai/glm-5.3-flash` · exit code **0**.
- O `run` auto-instalou o agente `oae-reviewer` + skills (fix de robustez validado).
- Plano gerado pelo planner real: 3 tarefas (t1 implementar `sub`, t2 estender
  `test.js`, t3 rodar o validador) — todas `done`, cada uma com commit próprio no
  branch isolado `oae/auto-mvameh0h` (commits `2c3c5f3`, `eb662f3`, `e00dd6f`).
- Revisões reais `oae-reviewer` **approved** nas 3 tarefas; o revisor capturou stderr
  (0 bytes) para provar que nenhum `console.assert` falhou.
- Validadores: 4 execuções, todas exit=0. Duração total: ~1 min 54 s.
- Relatório completo em `examples/demo-project/.oae/REPORT.md`.
- **Resultado: PASSOU** (3/3 tarefas, `Status: done`).

### Correções que a demo expôs (todas aplicadas e re-testadas)
1. `IMPEDIMENT: none` (com texto anexo) era tratado como bloqueio real — regex
   corrigido para aceitar variações de "none"/"n/a"/"no impediment".
2. O comando `run` agora auto-instala o agente revisor + skills quando ausentes
   (a primeira execução da demo falhou com `Agent not found: "oae-reviewer"`).
3. Prompt do coder proíbe explicitamente modificar `.oae/`/`.opencode/` e criar
   arquivos de config não solicitados (um coder havia criado `package.json`).
4. Conflito ESM/CJS da demo aninhada resolvido pré-criando `package.json` com
   `"type": "commonjs"` no projeto-alvo.

Correções de integração feitas durante o desenvolvimento (todas cobertas por testes):
1. Parser de mensagens: o contexto real usa `{type, content[]}` (partes
   `reasoning|tool|text`), não `{role, text}`.
2. `idle.outcome === "failed"` (erros do provedor, ex. cota 402) mapeado para
   `outcome: "failed"` → caminho normal de retry/backoff, em vez de "completed" falso.
3. `FakeRunner` com comportamento "hang" agora honra o timeout do
   `awaitCompletion`, igual ao runner real.
4. `event()` no store: `...data` sobrescrevia o campo `kind` — corrigido.

## Known limitations (documented, not bugs)

- `session.wait` é experimental (`/api/experimental/…`); o runner usa polling de
  `session.active()` + `session.context` — estável na v2.0.29.
- O modelo do serviço padrão pode falhar por cota (402); escolher modelo via
  `--model` mitigou no teste de integração.
- Revisor só enxerga o diff textual não-commitado; arquivos binários aparecem como
  "(no textual diff)" e são revisados lendo os arquivos diretamente.

## Lab audit 2026-10-17 — compatibilidade OpenCode 1.19.3 e segurança do revisor

Ambiente: VPS Ubuntu 24.04, Node v24.22.0 (nvm), CLI `opencode-ai@1.19.3`
(`/usr/bin/opencode`), cliente `@opencode/client@2.0.29`. A integração nativa v2
(`Service.ensure()` + headers de serviço) permanece como caminho default e não
foi alterada; tudo abaixo vive no modo adaptador exclusivo
`OAE_OPENCODE_URL=http://host:port`.

### Incompatibilidades comprovadas por execução (e correções aplicadas)

| # | Achado (evidência) | Correção |
| --- | --- | --- |
| C1 | `opencode serve --service` não existe no 1.19.3 (exit 1; sem `service.json`): `Service.ensure()`/spawn do cliente falha sempre | `connect()` aceita endpoint explícito via `OAE_OPENCODE_URL` com probe `/api/health` |
| C2 | Cliente 2.0.29 envia `{id, text}`; servidor 1.19.3 exige `{sessionID, prompt:{text}}` (`Missing key at ["prompt"]`) | shim `applyPromptCompatibility` (retry REST transparente) |
| C3 | Vocabulário de eventos `session.next.*` e nenhum evento terminal `session.idle`/`session.status` (probe SSE: prompt.admitted → prompt → step.started → reasoning/text deltas → step.ended → silêncio) | adaptador de eventos `applyEventCompatibility` traduz para `session.step.started/ended` + idle sintético |
| C4 | O parser CLI tratava o **valor** de `--model` como o pedido da missão (tentativas de coder vazias na 1ª missão) | `requestArg()` consome valores de flags conhecidas |
| C5 | Debounce de 8s após `step.ended` fechava sessões **no meio do streaming** (gaps reais de até ~14s entre steps no provedor do lab): resultado `completed` com output vazio → reviews "unparseable" | limiar elevado para 25s (missão passou após o ajuste) |

### Missão controlada end-to-end (projeto descartável `/tmp/oae-disp`)

- `oae run --model <lab provider> "add a greet(name) helper …"` → **status: done,
  task: done** (relatório: `.oae/REPORT.md`, run `run-mvcs46hv`).
- A revisão independente rejeitou de verdade: veredito `reject` com achado
  `ReferenceError: greet is not defined` (evidência coletada pelo próprio revisor);
  o coder corrigiu e a revisão seguinte aprovou → commit `fab8476` no branch
  isolado `oae/auto-mvcs46rt`; `node test.js` verde.
- Sinais de progresso via eventos traduzidos (supervisor interviu apenas onde
  devido; nenhuma interrupção espúria após C5).

### Segurança do revisor (sessões reais via API, projeto `/tmp/oae-fw-proj`)

- Config resolvida (`opencode debug agent oae-reviewer`): `edit/write/task/
  webfetch/websearch/browser = deny`, `bash: {"*": deny}` + 5 permissoes exatas.
- Vetores de escrita **antes** do ajuste executaram com efeito colateral
  (arquivos `hack2..5` criados via redirect/tee/heredoc / pipe) — registrados como
  **falha corrigida**.
- Vetores idênticos **depois**: `error/blocked` com zero arquivos criados;
  `git status` continua permitido; leitura via tools nativas (glob/grep) funciona.

### Limitações conhecidas desta auditoria

- O padrão de matching do 1.19.3 (primeiro token) **não bloqueia redirect/pipes
  para o token inicial permitido**: por isso a allowlist é fechada em strings
  exatas. Environments que precisem de leitura shell ampla exigem sandbox fora do
  OAE (o 1.19.3 não expõe sandbox por config relevante aqui).
- O idle sintético do adaptador é heurístico (25s de silêncio ≈ fim do turn);
  provedores muito lentos podem estender o temporizador artificialmente — o
  supervisor trata por timeout/recovery independente disso.
- Review no provedor do lab durou marcadamente mais (~5 min até deadline em um
  re-ask) que na v2 de referência (~20–30s); não bloqueante, custo de modelo.
- Persistência parcial de parts no DB local vs. `/api/session/{id}/context`
  (contexto HTTP é a fonte de verdade usada pelo OAE).
