const base = "http://127.0.0.1:4097";
const label = process.argv[2];
const r = await fetch(base + "/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "tok-" + label }) });
const sid = (await r.json()).id;
const p = await fetch(`${base}/session/${sid}/prompt_async`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ parts: [{ type: "text", text: "Responda apenas: ok" }], model: { providerID: "oc-lab", modelID: "glm-5.3-flash-free" }, agent: "build" }),
});
for (let i = 0; i < 50; i++) {
  await new Promise(r => setTimeout(r, 3000));
  const s = await fetch(`${base}/session/${sid}`).then(r => r.json()).catch(() => null);
  const tok = s?.tokens ?? s?.data?.tokens;
  if (tok && (tok.output ?? 0) > 0) { console.log(label, JSON.stringify(tok)); process.exit(0); }
}
console.log(label, "timeout");
process.exit(1);
