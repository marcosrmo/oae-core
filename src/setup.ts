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
  existing.agents = {
    ...((existing.agents as Record<string, unknown>) ?? {}),
    "oae-reviewer": {
      description: "OAE independent reviewer: read-only, runs validators, returns a verdict JSON.",
      mode: "subagent",
      permissions: [
        { action: "*", resource: "*", effect: "allow" },
        { action: "edit", resource: "*", effect: "deny" },
        { action: "write", resource: "*", effect: "deny" },
        { action: "browser", resource: "*", effect: "deny" },
      ],
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
