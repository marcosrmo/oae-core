const base = "http://127.0.0.1:4097";
const r = await fetch(base + "/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "rea-v2-call2" }) });
const sid = (await r.json()).id;
const p = await fetch(`${base}/session/${sid}/prompt_async`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({
    parts: [{ type: "text", text: "Chame a tool 'rea_binary_session' sem argumentos. Depois imprima uma linha: RESULTADO: <ate 100 chars do retorno>" }],
    model: { providerID: "oc-lab", modelID: "glm-5.3-flash-free" },
    agent: "build",
  }),
});
console.log("prompt", p.status, sid);
let idle = 0; const t0 = Date.now();
for (;;) {
  await new Promise(r => setTimeout(r, 3000));
  
  process.stdout.write(".");
  if (Date.now() - t0 > 210000) break;
  const msgs = await fetch(`${base}/session/${sid}/message`).then(r => r.json()).catch(() => null);
  const list = msgs?.data ?? msgs ?? [];
  const last = list.filter(m => m.info?.role === "assistant").pop() ?? null;
  let done = false, out = "";
  for (const m of list) if ((m.info?.role ?? "") === "assistant") for (const part of (m.parts ?? [])) if (part.type === "text") out += part.text + "\n";
  if (/RESULTADO:/i.test(out)) done = true;
  if (done) { console.log("\n" + out.slice(0, 500)); break; }
}
process.exit(0);
