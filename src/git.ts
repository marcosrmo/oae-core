/**
 * Git integration. Rules enforced here:
 * - Never discard user changes; baseline is captured, never reset.
 * - Agent work happens on a dedicated branch (oae/auto-<timestamp>).
 * - No force push, no history rewriting, no remote operations without explicit
 *   authorization handled by publish.ts.
 * (Per-task worktree isolation for concurrency > 1 is future work — see
 * docs/ROADMAP.md.)
 */
import { runCommand } from "./util.ts";

export interface GitStatus {
  isRepo: boolean;
  branch: string;
  remote: string | null;
  uncommitted: string[];
  head?: string;
  hasCommits: boolean;
}

const GIT_TIMEOUT = 120_000;

async function git(dir: string, ...args: string[]) {
  return runCommand("git", args, { cwd: dir, timeoutMs: GIT_TIMEOUT });
}

export async function inspectGit(dir: string): Promise<GitStatus> {
  const rev = await git(dir, "rev-parse", "--is-inside-work-tree");
  if (rev.code !== 0 || rev.stdout.trim() !== "true") {
    return { isRepo: false, branch: "", remote: null, uncommitted: [], hasCommits: false };
  }
  const branch = await git(dir, "rev-parse", "--abbrev-ref", "HEAD");
  const remote = await git(dir, "remote", "get-url", "origin");
  const status = await git(dir, "status", "--porcelain");
  const head = await git(dir, "rev-parse", "HEAD");
  return {
    isRepo: true,
    branch: branch.stdout.trim() || "HEAD",
    remote: remote.code === 0 ? remote.stdout.trim() : null,
    uncommitted: status.stdout.split("\n").filter(Boolean).map((s) => s.trim()),
    head: head.code === 0 ? head.stdout.trim() : undefined,
    hasCommits: head.code === 0,
  };
}

/**
 * Prepare the repo for a run. Creates a repo if none exists; if a repo exists
 * with uncommitted user work, that work is preserved untouched (captured in the
 * status report, not committed silently — committing user files without
 * permission would alter their history).
 */
export async function prepareGit(dir: string): Promise<{ status: GitStatus; branch?: string; baseline?: string; baselineUncommitted: string[] }> {
  let st = await inspectGit(dir);
  if (!st.isRepo) {
    await git(dir, "init", "-b", "main");
    st = await inspectGit(dir);
    const add = await git(dir, "add", "-A");
    const first = await git(dir, "commit", "-m", "chore: baseline before autonomous run");
    if (first.code !== 0 && add.code !== 0) {
      // empty repo, nothing to commit — fine
    }
    st = await inspectGit(dir);
    // dedicated working branch for agent work
    const nb = `oae/auto-${Date.now().toString(36)}`;
    const chk = await git(dir, "checkout", "-b", nb);
    st = await inspectGit(dir);
    return { status: st, branch: chk.code === 0 ? nb : st.branch, baseline: st.head, baselineUncommitted: [] };
  }
  const baselineUncommitted = st.uncommitted
    .map((f) => f.replace(/^[MARC?]+\s*/, ""))
    .filter((f) => !f.startsWith(".oae"));
  if (!st.hasCommits) {
    await git(dir, "add", "-A");
    await git(dir, "commit", "-m", "chore: baseline before autonomous run");
    st = await inspectGit(dir);
  }
  // dedicated working branch; user's current branch stays untouched
  const branch = `oae/auto-${Date.now().toString(36)}`;
  const chk = await git(dir, "checkout", "-b", branch);
  return { status: st, branch: chk.code === 0 ? branch : st.branch, baseline: st.head, baselineUncommitted };
}

/** If a run branch already exists (previous interrupted run), reuse or return it. */
export async function ensureBranch(dir: string, branch: string): Promise<boolean> {
  const chk = await git(dir, "checkout", branch);
  if (chk.code === 0) return true;
  const cr = await git(dir, "checkout", "-b", branch);
  return cr.code === 0;
}

export async function commitAll(dir: string, message: string, exclude: string[] = []): Promise<{ commit?: string; error?: string }> {
  await git(dir, "add", "-A");
  for (const path of exclude) {
    await git(dir, "restore", "--staged", "--", path);
  }
  const c = await git(dir, "commit", "-m", message);
  if (c.code !== 0) {
    // nothing to commit is not an error for empty tasks
    if (/nothing to commit/.test(c.stdout + c.stderr)) return { commit: undefined };
    return { error: (c.stderr || c.stdout).slice(0, 500) };
  }
  const h = await git(dir, "rev-parse", "HEAD");
  return { commit: h.stdout.trim() };
}

export async function diffStat(dir: string): Promise<string> {
  const d = await git(dir, "diff", "--stat", "HEAD");
  return d.stdout.trim();
}

export async function diffUncommitted(dir: string, maxChars = 8000): Promise<string> {
  const d = await git(dir, "diff", "HEAD", "--", ":!*.oae*");
  return d.stdout.length > maxChars ? d.stdout.slice(0, maxChars) + "\n[diff truncated]" : d.stdout;
}
