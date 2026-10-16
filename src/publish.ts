/**
 * GitHub publication: only with explicit authorization. Uses git push over
 * HTTPS (Git Credential Manager handles auth) and, when authorized to create a
 * repo, the GitHub REST API with a token read from `git credential fill` in
 * memory only — the token is never printed, logged or persisted.
 */
import type { OaeConfig } from "./config.ts";
import { inspectGit } from "./git.ts";
import { runCommand } from "./util.ts";
import { spawn } from "node:child_process";

const API = "https://api.github.com";

export async function checkRemote(cfg: OaeConfig): Promise<{ hasRemote: boolean; url?: string }> {
  const st = await inspectGit(cfg.projectDir);
  return { hasRemote: st.remote !== null, url: st.remote ?? undefined };
}

async function githubToken(): Promise<string | null> {
  return new Promise((res) => {
    const child = spawn("git", ["credential", "fill"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.on("close", () => {
      const m = out.match(/^password=(.*)$/m);
      res(m ? m[1] : null);
    });
    child.stdin.end("protocol=https\nhost=github.com\n\n");
  });
}

/**
 * Creates the GitHub repo if authorized and pushes. `authorize` must come from
 * an explicit user decision (question/approval), never assumed.
 */
export async function publish(
  cfg: OaeConfig,
  repoName: string,
  authorize: { createRepo: boolean; private: boolean },
): Promise<{ pushed: boolean; repoUrl?: string; error?: string }> {
  const st = await inspectGit(cfg.projectDir);
  if (!st.isRepo || !st.hasCommits) return { pushed: false, error: "repository has no commits" };
  const user = await gitUser();
  if (!user) return { pushed: false, error: "git user.name not configured" };

  if (!st.remote) {
    if (!authorize.createRepo) return { pushed: false, error: "no remote and repo creation not authorized" };
    const token = await githubToken();
    if (!token) return { pushed: false, error: "no GitHub credential available (install gh or run `git credential approve`)" };
    const res = await fetch(`${API}/user/repos`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "oae" },
      body: JSON.stringify({ name: repoName, private: authorize.private, description: "Autonomous software engineering runs by OAE" }),
    });
    if (res.status !== 201) {
      const body = await res.text();
      return { pushed: false, error: `repo creation failed: HTTP ${res.status} ${body.slice(0, 200)}` };
    }
    const created = (await res.json()) as { full_name: string };
    await runCommand("git", ["remote", "add", "origin", `https://github.com/${created.full_name}.git`], { cwd: cfg.projectDir, timeoutMs: 30_000 });
  }

  const push = await runCommand("git", ["push", "-u", "origin", st.branch], { cwd: cfg.projectDir, timeoutMs: 120_000 });
  if (push.code !== 0) return { pushed: false, error: (push.stderr || push.stdout).slice(0, 300) };
  const final = await inspectGit(cfg.projectDir);
  return { pushed: true, repoUrl: final.remote ?? undefined };
}

async function gitUser(): Promise<string | null> {
  const r = await runCommand("git", ["config", "user.name"], { cwd: process.cwd(), timeoutMs: 10_000 });
  return r.code === 0 ? r.stdout.trim() || null : null;
}
