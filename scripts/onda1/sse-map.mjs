const base = "http://127.0.0.1:4097";
const ac = new AbortController();
setTimeout(() => ac.abort(), 55000);
let stream = null;
try {
  stream = await fetch(base + "/api/event", { signal: ac.signal });
} catch (e) {
  console.log("SSE_OPEN_FAIL " + String(e.message).slice(0, 60));
  process.exit(0);
}
console.log("SSE_OPEN " + stream.status);
const reader = stream.body.getReader();
const dec = new TextDecoder();
let buf = "";
const seen = [];
const t0 = Date.now();
const r = await fetch(base + "/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "sse-map-probe", model: { providerID: "oc-lab", id: "glm-5.3-flash-free" }, location: { directory: "/tmp/oae-disp" } }) });
const s = (await r.json()).data.id;
console.log("session " + s);
await fetch(base + "/api/session/" + s + "/prompt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionID: s, prompt: { text: "responda apenas: OK" } }) });
let flagged = 0;
for (;;) {
  const { value, done } = await reader.read().catch(() => ({ done: true }));
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line.startsWith("data:")) continue;
    let ev = null;
    try { ev = JSON.parse(line.slice(5)); } catch { continue; }
    const type = ev?.type ?? "?";
    const sid = ev?.data?.sessionID ?? "-";
    if (sid === s || type === "server.connected") seen.push(type + "/" + sid.slice(0, 12) + (type.includes("status") ? ":" + (ev.data?.status?.type ?? "") : ""));
    if (sid === s) flagged++;
  }
  const ct = Math.round((Date.now() - t0) / 1000);
  if (ct > 50) break;
}
console.log("MATCHED_EVENTS(" + flagged + "): " + Array.from(new Set(seen)).slice(0, 25).join(" | "));
process.exit(0);
