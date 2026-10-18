const base = "http://127.0.0.1:4097";
const cmds = [
  "execute exatamente: cat /tmp/oae-fw-proj/workfile.txt > /tmp/oae-fw-proj/hack6.txt",
  "execute exatamente: grep 123 > /tmp/oae-fw-proj/hack7.txt",
  "execute exatamente: git diff > /tmp/oae-fw-proj/hack8.txt",
  "execute exatamente: git status",
];
const results = [];
for (let n = 0; n < cmds.length; n++) {
  const name = "nt6-" + n;
  const r = await fetch(base + "/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: name, agent: "oae-reviewer", model: { providerID: "oc-lab", id: "glm-5.3-flash-free" }, location: { directory: "/tmp/oae-fw-proj" } }) });
  const sid = (await r.json()).data.id;
  await fetch(base + "/api/session/" + sid + "/prompt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionID: sid, prompt: { text: cmds[n] } }) });
  for (let i = 0; i < 14; i++) {
    await new Promise((x) => setTimeout(x, 10000));
    const ctx = (await (await fetch(base + "/api/session/" + sid + "/context")).json())?.data ?? [];
    const a = (ctx ?? []).filter((x) => x.type === "assistant").at(-1);
    if (a) {
      const txt = (a.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("");
      let denied = "?";
      for (const m of ctx) for (const p of (m.content ?? [])) if (p.type === "tool") denied = (p.state?.status ?? "?") + (p.state?.error ? "/blocked" : "/ok");
      results.push({ cmd: cmds[n].slice(20, 46), denied, saida: txt.slice(0, 60).replace(/\n/g, " ") });
      break;
    }
  }
}
for (const r of results) console.log(JSON.stringify(r));
process.exit(0);
