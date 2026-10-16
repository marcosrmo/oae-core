/**
 * Final report generator: renders what actually happened from the persisted
 * store + git history. Never invents outcomes.
 */
import type { Store } from "./store.ts";
import { inspectGit } from "./git.ts";

export async function renderReport(store: Store): Promise<string> {
  const st = store.state;
  const g = await inspectGit(st.projectDir);
  const lines: string[] = [];
  lines.push(`# OAE Run Report — ${st.id}`);
  lines.push("");
  lines.push(`- Request: ${st.request}`);
  lines.push(`- Project: ${st.projectDir}`);
  lines.push(`- Status: **${st.status}**  (started ${st.startedAt}${st.endedAt ? `, ended ${st.endedAt}` : ", still running"})`);
  lines.push(`- Git: branch \`${g.branch}\`, head \`${g.head ?? "n/a"}\`, remote: ${g.remote ?? "none"}`);
  if (g.uncommitted.length) lines.push(`- Uncommitted files: ${g.uncommitted.length} (pre-existing user work is never committed by OAE)`);
  lines.push("");
  lines.push("## Tasks");
  for (const t of st.tasks) {
    lines.push(`### ${t.id} — ${t.title}  [${t.status}]`);
    if (t.blockedReason) lines.push(`- Blocked reason: ${t.blockedReason}`);
    if (t.commit) lines.push(`- Commit: ${t.commit}`);
    for (const a of t.attempts) {
      lines.push(`- Attempt ${a.id} (${a.kind}, agent \`${a.agent}\`, session ${a.sessionId}) → **${a.outcome}**`);
      if (a.filesChanged.length) lines.push(`  - Files: ${a.filesChanged.join(", ")}`);
      if (a.summary) lines.push(`  - Summary: ${a.summary.replace(/\n+/g, " ").slice(0, 400)}`);
    }
  }
  lines.push("");
  lines.push("## Validators");
  for (const [name, runs] of Object.entries(st.validatorResults)) {
    for (const r of runs) lines.push(`- ${name}: exit=${r.code}${r.timedOut ? " (TIMED OUT)" : ""} at ${r.at}`);
  }
  lines.push("");
  lines.push("## Decisions");
  for (const d of st.decisions) {
    lines.push(`- **[${d.kind}]** (${d.by}) ${d.text}`);
    if (d.rationale) lines.push(`  - Rationale: ${d.rationale.replace(/\n+/g, " ").slice(0, 500)}`);
  }
  lines.push("");
  lines.push("## Summary");
  lines.push(st.summary ?? "(no summary)");
  return lines.join("\n");
}
