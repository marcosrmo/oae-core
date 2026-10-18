// Onda 1 — PoC runner v2 (isolado do núcleo OAE). Roteamento v2 = header x-opencode-directory.
// Uso:
//   node v2runner.mjs events [--dir X] <seconds>
//   node v2runner.mjs run [--dir X] [--cold] [--prompt file] [--agent A] [--model P/I]
// Saída: JSON por fase em stdout; artefatos em /tmp/oae-work/onda1/out/
import { writeFileSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs';

const BASE = process.env.OAE_OC_URL ?? 'http://127.0.0.1:4097';
const OUT = '/tmp/oae-work/onda1/out';
mkdirSync(OUT, { recursive: true });
const LOG = OUT + '/events.ndjson';
try { writeFileSync(LOG, ''); } catch {}
const trace = (o) => appendFileSync(LOG, JSON.stringify(o) + '\n');
const log = (phase, obj) => console.log(JSON.stringify({ phase, ...obj, at: Date.now() }));

const H = (dir) => ({ 'content-type': 'application/json', ...(dir ? { 'x-opencode-directory': dir } : {}) });

async function jfetch(path, { dir, method, body, timeoutMs = 30000 } = {}) {
  const t = Date.now();
  let res;
  try {
    res = await fetch(BASE + path, { method: method ?? 'GET', headers: H(dir), body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return { status: 'ERR', ms: Date.now() - t, error: String(e?.message ?? e).slice(0, 120) };
  }
  const text = await res.text().catch(() => '');
  return { status: res.status, ms: Date.now() - t, body: text.slice(0, 4000) };
}

async function health() { return { phase: 'health', ...(await jfetch('/global/health')) }; }
async function mcpStatus(dir) { return jfetch('/mcp', { dir }); }
async function mcpConnect(dir, timeoutMs = 110_000) { return jfetch('/mcp/rea/connect', { dir, method: 'POST', timeoutMs }); }
async function mcpDisconnect(dir) { return jfetch('/mcp/rea/disconnect', { dir, method: 'POST' }); }

// SSE watch: resolve na sessão idle ou no timeout
function watchEvents(dir, sessionID, { timeoutMs = 200_000, started = Date.now() } = {}) {
  return new Promise((resolve) => {
    let count = 0, typeCounts = {}, terminal = null, sessionEvents = 0, toolCalls = [];
    fetch(`${BASE}/event`, { headers: H(dir), signal: AbortSignal.timeout(timeoutMs) })
      .then(async (res) => {
        if (!res.ok || !res.body) return resolve({ events: 0, terminal: 'sse_http_' + res.status });
        const dec = new TextDecoder();
        const reader = res.body.getReader();
        let buf = '';
        const pump = async () => {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) { if (!terminal) terminal = 'stream_ended'; break; }
              buf += dec.decode(value, { stream: true });
              let i;
              while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
                if (!line.startsWith('data:')) continue;
                count++;
                let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
                const type = ev.type ?? '';
                typeCounts[type] = (typeCounts[type] ?? 0) + 1;
                const sid = ev.properties?.sessionID;
                if (sid === sessionID) {
                  sessionEvents++;
                  if (type === 'session.idle' || (type === 'session.status' && ev.properties?.status?.type === 'idle')) terminal = 'idle';
                  if (type.startsWith('session.next.tool.')) {
                    toolCalls.push({ type, at: Date.now(), data: JSON.stringify(ev.properties).slice(0, 300) });
                  }
                  if (type === 'session.next.step.failed') terminal = 'step.failed';
                }
                if (sessionID === 'none') { /* modo events: só gravar */ }
              }
              if (terminal) break;
            }
            resolve({ events: count, sessionEvents, typeCounts, toolCalls, terminal: terminal ?? 'none', ms: Date.now() - started });
          } catch (e) {
            resolve({ events: count, sessionEvents, typeCounts, toolCalls, terminal: 'se_err_' + String(e?.message ?? e).slice(0, 30), ms: Date.now() - started });
          }
        };
        pump();
      })
      .catch((e) => resolve({ events: 0, terminal: 'sse_fetch_' + String(e?.message ?? e).slice(0, 30) }));
  });
}

async function run(args) {
  const dir = args.dir, agent = args.agent ?? 'build';
  const t0 = Date.now(); const rep = { phases: {} };
  rep.phases.health = await health();
  let ms = await mcpStatus(dir);
  if (ms.status === 'ERR') { console.error('mcp_status_err', ms); }
  const mpcStatusSafe = mcpStatus;
  rep.phases.mcp_before = { status: ms.status, body: ms.body, ms: ms.ms };
  if (args.cold) {
    const d = await mcpDisconnect(dir);
    rep.phases.mcp_force_cold = { status: d.status, ms: d.ms };
    ms = await mpcStatusSafe();
  }
  if (!ms.body.includes('connected')) {
    const c = await mcpConnect(dir);
    const ms2 = await mpcStatusSafe();
    rep.phases.mcp_warmup = { connect_status: c.status, connect_ms: c.ms, after: ms2.body, ms: ms2.ms };
  } else rep.phases.mcp_warmup = { skipped: true };

  const s = await jfetch('/session', { dir, method: 'POST', body: JSON.stringify({ title: 'onda1-v2runner-' + Date.now() }) });
  const sj = (() => { try { return JSON.parse(s.body); } catch { return {}; } })();
  rep.phases.session = { id: sj.id, directory: sj.directory, status: s.status, ms: s.ms };
  const sid = sj.id;
  if (!sid) { log('run', rep); return rep; }

  const promptText = args.promptFile ? readFileSync(args.promptFile, 'utf8') : (args.prompt ??
    'Chame a tool "rea_binary_session" sem argumentos. Depois imprima uma única linha: RESULTADO: <ate 120 chars do retorno>.');
  const p = await jfetch(`/session/${sid}/prompt_async`, {
    dir, method: 'POST', timeoutMs: 45000,
    body: JSON.stringify({
      parts: [{ type: 'text', text: promptText }],
      model: { providerID: args.provider ?? 'oc-lab', modelID: args.model ?? 'glm-5.3-flash-free' },
      agent,
    }),
  });
  rep.phases.prompt = { status: p.status, ms: p.ms, body: p.body.slice(0, 200) };
  if (p.status !== 204) { log('run', rep); return rep; }

  const turnStart = Date.now(); const ev = await watchEvents(dir, sid, { timeoutMs: args.turnTimeout ?? 200_000, started: turnStart });
  rep.phases.turn = ev;
  const fin = await jfetch(`/session/${sid}/message`, { dir });
  rep.phases.messages = { status: fin.status, ms: fin.ms };
  try { writeFileSync(OUT + '/messages-' + sid + '.json', fin.body); } catch {}
  rep.total_ms = Date.now() - t0;
  writeFileSync(OUT + '/run-report.json', JSON.stringify(rep, null, 1));
  log('run', { session: sid, total_ms: rep.total_ms, terminal: ev.terminal, report: OUT + '/run-report.json' });
  return rep;
}

const args = {};
const A = process.argv.slice(2);
for (let i = 0; i < A.length; i++) {
  if (A[i].startsWith('--')) { const key = A[i].slice(2); args[key] = A[i + 1]?.startsWith('--') || i + 1 >= A.length ? true : A[++i]; }
}
const cmd = A.find(a => !a?.startsWith('--') && !/^\//.test(a)) ?? (A[0] === 'run' ? 'run' : 'run');
if (args.promptFile) { args.promptFile = args.promptFile; }
if (cmd === 'events') {
  const secs = Number(A.find(a => /^\d+$/.test(a)) ?? 20);
  const { events, sessionEvents, typeCounts, terminal } = await watchEvents(args.dir, 'none', { timeoutMs: secs * 1000 });
  log('events', { events, sessionEvents, typeCounts, terminal });
  process.exit(0);
}
await (async () => {
  const dirDef = args.dir ?? '/home/dev/projetos/oae-inspecao';
  args.dir = dirDef;
  await run(args);
})();
