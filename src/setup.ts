/**
 * Project setup: installs OAE project-local configuration and skills into a
 * target project (idempotent; never overwrites existing agent definitions).
 */
import { mkdir, writeFile, copyFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));

export async function installIntoProject(projectDir: string): Promise<void> {
  const ocDir = join(projectDir, ".opencode");
  await mkdir(join(ocDir, "skills"), { recursive: true });

  // agents config (merges into any existing file)
  const cfgFile = join(ocDir, "opencode.json");
  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(await readFile(cfgFile, "utf8")) as Record<string, unknown>; } catch { /* new file */ }
  existing.$schema = "https://opencode.ai/config.json";
  // purge the legacy `agents` (plural) entry — on OpenCode 1.19.x it is
  // partially merged and the permission map is silently dropped, so the
  // reviewer would run with edit/write enabled
  if (existing.agents && typeof existing.agents === "object") {
    const legacy = existing.agents as Record<string, unknown>;
    if ("oae-reviewer" in legacy) {
      delete legacy["oae-reviewer"];
      if (Object.keys(legacy).length === 0) delete existing.agents;
    }
  }
  existing.agent = {
    ...((existing.agent as Record<string, unknown>) ?? {}),
    "oae-reviewer": {
      description: "OAE independent reviewer: read-only, runs validators, returns a verdict JSON.",
      mode: "subagent",
      permission: {
        "*": "allow",
        "edit": "deny",
        "write": "deny",
        "task": "deny",
        "webfetch": "deny",
        "websearch": "deny",
        "browser": "deny",
        "bash": {
          // auditoria 2026-10-17: padrões com wildcard escapam escrita por
          // redirect/pipes compostos (`grep x > f`, `git diff > f`,
          // `cat f | tee g` todos EXECUTARAM com "cat *"/"grep *"/"git diff*").
          // Portanto somente strings exatas — leitura de arquivos fica com as
          // tools nativas (read/glob/grep), que não são afetadas por shell.
          "*": "deny",
          "git status": "allow",
          "pwd": "allow",
          "ls": "allow",
          "npm test": "allow",
          "node --version": "allow",
        },
      },
    },
  };
  await writeFile(cfgFile, JSON.stringify(existing, null, 2), "utf8");

  // skills: copy from this package's skills/ directory
  const srcSkills = join(PKG_ROOT, "skills");
  const names = await readdir(srcSkills).catch(() => [] as string[]);
  for (const n of names) {
    await mkdir(join(ocDir, "skills", n), { recursive: true });
    await copyFile(join(srcSkills, n, "SKILL.md"), join(ocDir, "skills", n, "SKILL.md"));
  }

  await mkdir(join(projectDir, ".oae"), { recursive: true });
}
