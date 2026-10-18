const base = "http://127.0.0.1:4097";
const res = await fetch(base + "/session", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ title: "rea-v2-probe" }),
});
console.log("create", res.status);
const body = await res.text(); const sid = JSON.parse(body)?.id; console.log("sid", sid);
if (!sid) process.exit(1);
const p = await fetch(base + "/session/" + sid + "/prompt_async", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    parts: [{ type: "text", text: "Liste em uma linha, separadas por vírgula, TODAS as tool identities que você possui direito agora. Não chame nada." }],
    model: { providerID: "oc-lab", id: "glm-5.3-flash-free" },
    agent: "build",
  }),
});
console.log("prompt", p.status);
await new Promise(r => setTimeout(r, 90000));
const ctx = await fetch(base + "/session/" + sid + "/message").then(r => r.json()).catch(() => null);
const data = ctx?.data ?? ctx ?? [];
let out = "";
for (const m of data) for (const part of (m.parts ?? [])) if (part.type === "text") out += part.text + "\n";
console.log((out || "(vazio)").slice(0, 600));
process.exit(0);
