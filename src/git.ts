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
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Test seam for deterministic failure injection (P0.2, plan §6 item 8): the
 * runner behind the internal git() helper. Production default is the real
 * runCommand. Tests may substitute it via setGitExecForTest and MUST reset
 * it afterwards (finally) so no later test runs against a stub.
 */
let gitExec: typeof runCommand = runCommand;

/** Install a stub for every git invocation made by this module; call with no argument to restore the real runner. */
export function setGitExecForTest(impl?: typeof runCommand): void {
  gitExec = impl ?? runCommand;
}

/** One porcelain v1 `-z` record: both status columns, the path, and — for staged rename/copy records — the original path. */
export interface GitStatusRecord {
  /** Index (staged) column: porcelain code or " ". */
  x: string;
  /** Work-tree column: porcelain code or " ". */
  y: string;
  /** New/current path (for renames: the destination; -z emits "to\0from"). */
  path: string;
  /** Original path of a staged rename/copy record. */
  orig?: string;
}

export interface GitStatus {
  isRepo: boolean;
  branch: string;
  remote: string | null;
  uncommitted: string[];
  /**
   * P0.2 (B1): the same status as `uncommitted`, but structured — used to
   * build the baseline restore list without re-deriving state from text.
   * Optional so hand-built status objects (tests, mocks) keep type-checking.
   */
  records?: GitStatusRecord[];
  head?: string;
  hasCommits: boolean;
}

const GIT_TIMEOUT = 120_000;

/**
 * Command-scoped Git identity for every commit OAE creates. Passed as
 * `-c key=value` per invocation, so this never reads/writes global, system or
 * repo config — it applies to that single commit command only. Keeps commits
 * working in environments with no configured identity (CI, containers).
 */
const COMMIT_IDENTITY_ARGS = [
  "-c", "user.name=OAE Autonomous",
  "-c", "user.email=oae@autonomous.local",
];

/**
 * OAE-internal runtime trees. Everything under these directories is owned by
 * the running OAE instance (state, events, sessions, installed agent config)
 * and must never silently enter a commit — see docs/SECURITY.md and the P0
 * plan (Protection of internal artifacts).
 * Segment-anchored matching only: ".oae", ".opencode" as trees. Names like
 * ".oae-notes", "docs/.oae-guide.md" or "src/opencode.ts" are NOT internal.
 */
const INTERNAL_TREES = [".oae", ".opencode"] as const;

/** True iff `p` (a repo-root-relative path) is inside an OAE-internal tree. */
export function isInternalArtifactPath(p: string): boolean {
  for (const t of INTERNAL_TREES) {
    if (p === t || p.startsWith(`${t}/`)) return true;
  }
  return false;
}

/**
 * Stage everything while EXCLUDING the internal trees. Exclusion-only
 * pathspecs are official semantics (gitglossary: "When there is no
 * non-exclude pathspec, the exclusion is applied to the result set as if
 * invoked without any pathspec"). The specs are anchored on the directory
 * segment, so "my.oaefile" or "src/.oae-thing" are unaffected.
 * Note: this filter applies to what `git add` stages. Entries that were
 * staged BEFORE this command are not removed by it (git add never unstages);
 * they are caught by assertNoInternalArtifactsStaged below.
 */
export const INTERNAL_EXCLUDE_PATHSPECS = INTERNAL_TREES.map((t) => `:!${t}`);

export class InternalArtifactsStagedError extends Error {
  /** Repo-root-relative internal paths that were staged, path names only — no file content. */
  readonly paths: string[];
  constructor(paths: string[]) {
    // Self-limiting diagnostic: the TOTAL count plus a bounded sample of paths
    // (names only). With many offending paths the old list-only message could
    // be truncated mid-path and hide the real scale of the problem.
    const MAX_SAMPLE = 8;
    const total = paths.length;
    const sample = paths.slice(0, MAX_SAMPLE);
    super(
      `OAE pre-commit guard: internal artifacts are staged and the commit was blocked — ` +
      `${total} internal path(s) total` +
      (total > MAX_SAMPLE ? `, showing the first ${MAX_SAMPLE}: ${sample.join(", ")}` : `: ${sample.join(", ")}`) +
      ` — nothing was committed; pre-existing staging was left untouched. Remove or commit these paths` +
      ` manually (OAE never resets the index on its own).`,
    );
    this.name = "InternalArtifactsStagedError";
    this.paths = paths;
  }
}

/**
 * Parse `git status --porcelain=v1 -z` into complete records (P0.2, defects
 * B1/B6): both status columns, the path and — for staged rename/copy records
 * — the original path carried as the second NUL-separated field ("to from"
 * order per the git-status docs). With -z, git NEVER C-quotes paths, so
 * UTF-8, spaces and special characters arrive as the literal path (the old
 * non-z pipeline got quoted, octal-escaped text here and fed the restore
 * list with invalid pathspecs).
 *
 * Deliberately minimal: fixed 2-char status + space, NUL record separator,
 * no quoting. Any output that cannot be interpreted unambiguously throws —
 * the caller must fail closed rather than guess. Ignored entries ("!")
 * never appear in plain porcelain and never get staged, so they are skipped
 * entirely (same practical set the old parsed list covered).
 */
export function parseStatusRecordsZ(raw: string): GitStatusRecord[] {
  // With -z, `git status` emits NO output at all for a clean status and
  // TERMINATES EVERY record with NUL. Therefore any non-empty output must end
  // with a NUL; a missing terminator means the output was cut and cannot be
  // interpreted safely → fail closed.
  if (raw === "") return []; // empty output = legit clean status
  if (!raw.endsWith("\0")) {
    throw new Error("git status output is truncated (missing terminating NUL) — cannot interpret safely");
  }
  const recs = raw.split("\0");
  recs.pop(); // drop the empty element following the guaranteed final NUL
  // status columns: any porcelain v1 code — M, T (type change), A, D, R, C, U,
  // X, '?', '!' and ' ' (space = unaffected column) — then the space that
  // separates the status field from the first path (guaranteed by the -z spec)
  const statusOk = /^[MTADRCUX?! ]{2} /;
  const records: GitStatusRecord[] = [];
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    if (rec.length < 4 || !statusOk.test(rec)) {
      throw new Error(`malformed porcelain record (position ${i}): ${JSON.stringify(rec.slice(0, 20))}`);
    }
    const x = rec[0], y = rec[1];
    if (x === "!" || y === "!") continue; // ignored: never quoted, never staged, never committed
    const path = rec.slice(3);
    if (!path) throw new Error(`empty path record (position ${i})`);
    let orig: string | undefined;
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      orig = recs[i + 1];
      if (orig === undefined) throw new Error("rename record without an original-path field (truncated output)");
      i++;
      if (!orig) throw new Error("rename record with an empty original path");
    }
    records.push(orig !== undefined ? { x, y, path, orig } : { x, y, path });
  }
  return records;
}

/**
 * Parse `git status --porcelain=v1 -z` and return the paths that are staged
 * (index differs from HEAD), derived from the structured records above. Used
 * by the pre-commit guard; behavior is exactly the pre-P0.2 one (same inputs,
 * same outputs, same fail-closed throws).
 */
export function parseStagedPathsFromStatusZ(raw: string): string[] {
  const records = parseStatusRecordsZ(raw);
  const staged: string[] = [];
  for (const r of records) {
    if (r.x !== " " && r.x !== "?") {
      // staged entry (index differs from HEAD, or added for the first commit)
      staged.push(r.path);
      if (r.orig !== undefined) staged.push(r.orig); // a staged rename adds the new entry AND deletes the old one
    }
  }
  return staged;
}

/**
 * Mudança E (P0.1): the last barrier before every OAE-generated commit.
 * Refuses to proceed if any commit would include a path under `.oae/` or
 * `.opencode/` — including artifacts that were staged BEFORE the run (by the
 * user or by a previous run). It never mutates the index, the working tree,
 * or anything else: when it blocks, it only reports. Cannot distinguish who
 * staged an internal path; both cases call for a human decision, so the
 * policy is fail-closed (the plan's §3.2, Mudança E).
 *
 * Residual limitation (no Git atomicity is claimed): the staged-set snapshot
 * and the `git commit` that follows are two separate operations. A concurrent
 * writer could mutate the index in the window between them. OAE serializes
 * its own actions per project (run lock), and nothing in the OAE flow mutates
 * the index between this check and the commit; a third-party process doing so
 * is outside what the toolchain can prevent.
 */
export async function assertNoInternalArtifactsStaged(dir: string): Promise<void> {
  const st = await git(dir, "status", "--porcelain=v1", "-z");
  if (st.code !== 0 || st.timedOut) {
    throw new Error(
      `OAE pre-commit guard: cannot read the git index safely (git status exit=${st.code}${st.timedOut ? ", timed out" : ""})` +
      `; commit blocked (fail-safe). git said: ${(st.stderr || st.stdout).trim().slice(0, 200)}`,
    );
  }
  let staged: string[];
  try {
    staged = parseStagedPathsFromStatusZ(st.stdout);
  } catch (e) {
    throw new Error(
      `OAE pre-commit guard: git status output could not be interpreted safely; commit blocked (fail-safe): ` +
      `${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const internal = staged.filter(isInternalArtifactPath);
  if (internal.length > 0) throw new InternalArtifactsStagedError(internal);
}

/**
 * P0.2.1 (A1): typed failure when a user-initiated Git operation is still
 * pending (or when OAE cannot PROVE it is not). OAE never concludes another
 * process's merge/rebase/cherry-pick/revert: a task commit there would
 * silently finish the user's operation and reshape history. Message is
 * self-limiting (≤500 chars, path-name evidence only, no file content).
 */
export class GitPendingOperationError extends Error {
  /** Operation labels still pending ("merge (MERGE_HEAD)", …), or the probe labels whose query failed. */
  readonly ops: string[];
  /** True when the probes could not answer reliably (fail-closed query-failure branch). */
  readonly queryFailed: boolean;
  constructor(ops: string[], queryFailed: boolean) {
    super(
      queryFailed
        ? `OAE git-state pre-commit check: pending-operation state could not be determined (git query failed for: ${ops.join(", ")})` +
          `; commit blocked (fail-closed) — OAE never assumes a clean repository. Finish or abort any in-progress Git operation manually, then retry.`
        : `OAE git-state pre-commit check: a user-initiated Git operation is still pending (${ops.join(", ")})` +
          `; commit blocked — OAE never concludes another process's merge/rebase/cherry-pick/revert. ` +
          `Finish or abort the operation manually (its Git state files were left untouched), then retry.`,
    );
    this.name = "GitPendingOperationError";
    this.ops = ops;
    this.queryFailed = queryFailed;
  }
}

/**
 * P0.2.1 (A3): typed failure of OAE's staging (`git add`). Unlike a restore
 * failure, a staging failure means OAE changed nothing itself: no restore is
 * run and no commit is attempted after it. Message is self-limiting (≤500).
 */
export class GitStagingError extends Error {
  /** git exit code — null when the process could not be spawned/initialized. */
  readonly code: number | null;
  readonly stderr: string;
  constructor(code: number | null, stderr: string, timedOut: boolean) {
    // C5: a null code is a process-initialization/spawn failure, never a real
    // exit status — it is reported as "unknown" with its own cause phrase so
    // the three failure modalities (spawn failure, non-zero exit, timeout)
    // are distinguishable in the diagnostic. Message is self-limiting (≤500).
    const exitText = code === null ? "unknown" : String(code);
    const cause = timedOut
      ? ", timed out"
      : code === null
        ? " — git process could not be started"
        : "";
    super(
      `OAE git staging failed (git add, exit ${exitText}${cause})` +
      `; commit blocked — nothing was staged by OAE and neither an index restore nor a commit was attempted.` +
      ` git said: ${stderr.slice(0, 200)}`,
    );
    this.name = "GitStagingError";
    this.code = code;
    this.stderr = stderr;
  }
}

/** One probe unit of the pending-operation check (A1). */
interface PendingProbe {
  label: string;
  /** true = pending operation found; false = PROVEN absent; null = query failed → fail closed. */
  check(dir: string): Promise<boolean | null>;
}

/**
 * On-disk operation-state probe via `git rev-parse --git-path <node>` — the
 * git-native way to find the state directory (main repo AND linked
 * worktrees), followed only by a *read-only* existence check. No state file
 * is ever written, moved or removed.
 */
async function gitStateDirExists(dir: string, node: string): Promise<boolean | null> {
  const r = await git(dir, "rev-parse", "--git-path", node);
  if (r.timedOut || r.code === null) return null; // no reliable answer
  if (r.code !== 0) return null; // --git-path normally exits 0; a diagnostic means a broken query
  const out = r.stdout.trim();
  if (!out) return null; // empty answer is not a trustworthy "absent"
  return existsSync(resolve(dir, out));
}

/**
 * Symbolic-ref probe via `git rev-parse -q --verify <ref>`: exit 0 = the ref
 * exists (operation pending); exit 1 WITH empty output = proven absent; any
 * other exit/diagnostic/timeout = failed query (fail closed). Nothing about
 * the repository is modified by the query.
 */
async function gitRefExists(dir: string, ref: string): Promise<boolean | null> {
  const r = await git(dir, "rev-parse", "-q", "--verify", ref);
  if (r.timedOut || r.code === null) return null;
  if (r.code === 0) return true;
  return r.stderr.trim() === "" && r.stdout.trim() === "" ? false : null;
}

const PENDING_PROBES: PendingProbe[] = [
  { label: "merge (MERGE_HEAD)", check: (d) => gitRefExists(d, "MERGE_HEAD") },
  { label: "rebase (rebase-merge dir)", check: (d) => gitStateDirExists(d, "rebase-merge") },
  { label: "rebase (rebase-apply dir)", check: (d) => gitStateDirExists(d, "rebase-apply") },
  { label: "cherry-pick/revert (sequencer)", check: (d) => gitStateDirExists(d, "sequencer") },
  { label: "cherry-pick (CHERRY_PICK_HEAD)", check: (d) => gitRefExists(d, "CHERRY_PICK_HEAD") },
  { label: "revert (REVERT_HEAD)", check: (d) => gitRefExists(d, "REVERT_HEAD") },
];

/**
 * P0.2.1 (A1): fail-closed gate for user-initiated pending Git operations —
 * merge (MERGE_HEAD), rebase (rebase-merge / rebase-apply state dirs, both
 * flavors), cherry-pick and revert (sequencer dir; CHERRY_PICK_HEAD /
 * REVERT_HEAD). Detection uses git's own state facilities; nothing is
 * inferred from error texts, and no Git state file is touched.
 *
 * Every probe answers true / false / null: null means the QUERY failed, which
 * blocks the commit as well — the repository is never assumed clean.
 * Deliberately NOT run on prepareGit paths: a repo mid-merge cannot be in the
 * fresh/no-commits branches (both require zero commits), and creating the run
 * branch (`checkout -b`) modifies no pending-operation state.
 */
export async function assertNoPendingGitOperations(dir: string): Promise<void> {
  const pending: string[] = [];
  const failed: string[] = [];
  for (const probe of PENDING_PROBES) {
    let state: boolean | null;
    try {
      state = await probe.check(dir);
    } catch {
      state = null;
    }
    if (state === true) pending.push(probe.label);
    else if (state === null) failed.push(probe.label);
  }
  // pending operations take precedence over query failures in the report
  if (pending.length > 0) throw new GitPendingOperationError(pending, false);
  if (failed.length > 0) throw new GitPendingOperationError(failed, true);
}

async function git(dir: string, ...args: string[]) {
  // routed through the module-level seam so tests can inject deterministic
  // git failures without corrupting a real repository
  return gitExec("git", args, { cwd: dir, timeoutMs: GIT_TIMEOUT });
}

/**
 * P0.2.1 (A3): OAE's single staging entry (`git add -A` excluding internal
 * trees). The exit code is checked explicitly — any failure (or timeout)
 * aborts the flow BEFORE the baseline restore and any commit, with a typed,
 * bounded diagnosis. No cleanup, no retry, no destructive recovery.
 */
async function stageAll(dir: string): Promise<void> {
  const add = await git(dir, "add", "-A", "--", ...INTERNAL_EXCLUDE_PATHSPECS);
  if (add.code !== 0 || add.timedOut) {
    // C5: code is number|null — null (spawn/initialization failure) is passed
    // through as null and rendered as "unknown" with its own cause phrase in
    // the typed error; no cast ever masks it as a numeric exit.
    throw new GitStagingError(add.code, (add.stderr || add.stdout).trim().slice(0, 400), add.timedOut);
  }
}

/**
 * C1: typed failure of the `git status` read in inspectGit. A failed status
 * read must NEVER be interpreted as "the repository is clean" — the run
 * operates on a snapshot of the user's pre-existing work, and a missing
 * snapshot could silently expose that work to a commit. Fail-closed: any
 * non-zero exit, a null exit code (process spawn failure) or a timeout blocks
 * the operation. Message is self-limiting (≤500 chars, git diagnostic only,
 * no file content).
 */
export class GitStatusReadError extends Error {
  /** git exit code (null when the process could not be spawned). */
  readonly code: number | null;
  /** True when the git invocation timed out. */
  readonly timedOut: boolean;
  constructor(code: number | null, timedOut: boolean, diagnostic: string, source: "git" | "contract" = "git") {
    // C5/P2: distinguish WHERE the diagnostic comes from. A failed git read
    // quotes a git diagnostic; a broken status snapshot (contract violation)
    // is diagnosed by OAE itself and must not be presented as "git said:".
    const cause = source === "contract"
      ? `; contract violation (fail-closed) — the status snapshot is unusable, so the repository`
      : `; operation blocked (fail-closed) — the working-tree state could not be read safely, so the repository`;
    super(
      `OAE git-state read failed (git status --porcelain=v1 -z, exit ${code}${timedOut ? ", timed out" : ""})` +
      cause + ` is never assumed clean. ${source === "contract" ? "diagnosis" : "git said"}: ${diagnostic.slice(0, 200)}`,
    );
    this.name = "GitStatusReadError";
    this.code = code;
    this.timedOut = timedOut;
  }
}

export async function inspectGit(dir: string): Promise<GitStatus> {
  const rev = await git(dir, "rev-parse", "--is-inside-work-tree");
  if (rev.code !== 0 || rev.stdout.trim() !== "true") {
    return { isRepo: false, branch: "", remote: null, uncommitted: [], records: [], hasCommits: false };
  }
  const branch = await git(dir, "rev-parse", "--abbrev-ref", "HEAD");
  const remote = await git(dir, "remote", "get-url", "origin");
  // P0.2 (B1): structured -z capture — no C-quoting, no trim(), no incomplete
  // regex prefix-stripping; each record carries both status columns and the
  // rename original path. `uncommitted` below is the same set rendered in the
  // "XY path" text form the orchestrator's report pipeline expects.
  const status = await git(dir, "status", "--porcelain=v1", "-z");
  // C1: a status read failure (non-zero exit, spawn failure or timeout) is NOT
  // a clean repository — it is an unreadable one. Fail closed instead of
  // reporting empty lists (the old comment claimed the pre-commit guard would
  // catch it later, but callers that only consume `uncommitted`/`records`
  // would proceed with a missing baseline snapshot).
  if (status.code !== 0 || status.timedOut) {
    throw new GitStatusReadError(status.code, status.timedOut, (status.stderr || status.stdout).trim().slice(0, 400));
  }
  let records: GitStatusRecord[];
  try {
    records = parseStatusRecordsZ(status.stdout);
  } catch (e) {
    // exit 0 but uninterpretable output — also a failed read (fail closed),
    // wrapped for a single typed diagnosis
    throw new GitStatusReadError(0, false, `uninterpretable porcelain output: ${e instanceof Error ? e.message : String(e)}`);
  }
  const uncommitted = records.map((r) =>
    r.orig !== undefined ? `${r.x}${r.y} ${r.orig} -> ${r.path}` : `${r.x}${r.y} ${r.path}`,
  );
  const head = await git(dir, "rev-parse", "HEAD");
  return {
    isRepo: true,
    branch: branch.stdout.trim() || "HEAD",
    remote: remote.code === 0 ? remote.stdout.trim() : null,
    uncommitted,
    records,
    head: head.code === 0 ? head.stdout.trim() : undefined,
    hasCommits: head.code === 0,
  };
}

/**
 * P0.2 (B2/B3/B4): the baseline restore list is derived from structured
 * status records — never from text trimming. It contains every user path
 * whose index entry OAE's `git add -A` has to (re)stage: untracked files,
 * unstaged changes, unmerged paths and entries the user had already staged.
 * Staged renames contribute BOTH paths (both index entries were touched).
 *
 * OAE-internal root trees (.oae/, .opencode/) are EXCLUDED: add never stages
 * them (Mudança A) and pre-staged ones must STAY staged so the pre-commit
 * guard blocks them with a diagnosis (Mudança E) — and an untracked-internal
 * pathspec would make `git restore --staged` exit 1 ("not known to git"),
 * which would block task commits for no reason. Look-alikes like .oae-notes
 * are user work and stay in the list (policy §6.3, audit defect B3).
 */
function baselineRestoreList(records: GitStatusRecord[]): string[] {
  const out: string[] = [];
  for (const r of records) {
    if (isInternalArtifactPath(r.path)) continue;
    if (r.orig !== undefined && isInternalArtifactPath(r.orig)) continue;
    out.push(r.path);
    if (r.orig !== undefined) out.push(r.orig);
  }
  return out;
}

/**
 * C2/C3: prepareGit's baseline derivation with a fail-closed contract on the
 * status snapshot. `records` is optional on GitStatus only so hand-built
 * objects (tests, mocks) keep type-checking — but a valid-repository snapshot
 * WITHOUT records is a broken read: the type cannot distinguish "clean" from
 * "unreadable", and masking it with `?? []` would prepare a task commit whose
 * baseline restores nothing, letting user work enter the wrong commit. Throw
 * instead. Message is self-limiting (fixed text, no file content).
 */
export function baselineRestoreListOrFail(st: GitStatus): string[] {
  if (st.records === undefined) {
    throw new GitStatusReadError(
      0,
      false,
      "git-status snapshot for a valid repository carries no structured records — baseline cannot be derived safely",
      "contract",
    );
  }
  return baselineRestoreList(st.records);
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
    // P0.1: guard pre-check BEFORE any staging — a pre-staged internal
    // artifact must block without the index being modified by this operation.
    await assertNoInternalArtifactsStaged(dir);
    await stageAll(dir);
    await assertNoInternalArtifactsStaged(dir);
    const first = await git(dir, ...COMMIT_IDENTITY_ARGS, "commit", "-m", "chore: baseline before autonomous run");
    if (first.code !== 0) {
      // empty repo, nothing to commit — fine
    }
    st = await inspectGit(dir);
    // dedicated working branch for agent work
    const nb = `oae/auto-${Date.now().toString(36)}`;
    const chk = await git(dir, "checkout", "-b", nb);
    st = await inspectGit(dir);
    return { status: st, branch: chk.code === 0 ? nb : st.branch, baseline: st.head, baselineUncommitted: [] };
  }
  if (!st.hasCommits) {
    // P0.1: guard pre-check BEFORE any staging (same rationale as above)
    await assertNoInternalArtifactsStaged(dir);
    await stageAll(dir);
    await assertNoInternalArtifactsStaged(dir);
    await git(dir, ...COMMIT_IDENTITY_ARGS, "commit", "-m", "chore: baseline before autonomous run");
    // P0.2 (B5): refresh AFTER the baseline commit so the restore list below
    // is derived from the current state, not from pre-baseline records. The
    // baseline commit has just committed every non-internal user change, so
    // the list is empty by construction; the stale pre-commit list would make
    // the first task commit try to "restore" already-committed paths
    // (git exits 1 for pathspecs not known to the index/HEAD).
    st = await inspectGit(dir);
  }
  // P0.2 (B2–B4): precise restore list from structured records. C2/C3: a
  // missing records array is never masked into an empty baseline (the old
  // `?? []` did exactly that) — a snapshot without records fails closed
  // before any branch switch, so the first task commit can never proceed
  // with a baseline that restores nothing.
  const baselineUncommitted = baselineRestoreListOrFail(st);
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

/**
 * Commit everything not explicitly excluded, never touching user baseline
 * work content: baseline paths are demoted out of THIS commit's staging after
 * our `git add -A` (their content stays in the working tree). Per the approved
 * policy (plan §6.3 option A) the exact staged state a user had before the run
 * is NOT promised — pre-existing work may end unstaged — but no pre-existing
 * work can enter the task commit, and nothing is ever deleted or reset.
 * OAE-internal runtime trees (.oae/, .opencode/) are not staged here
 * (INTERNAL_EXCLUDE_PATHSPECS); if something internal is ALREADY in the
 * index, the pre-commit guard blocks the commit and reports the offending
 * paths instead of committing (Mudança E / P0.1).
 */
/**
 * Message for the `{ error }` return of commitAll. InternalArtifactsStagedError
 * and GitBaselineRestoreError are self-limiting by construction (bounded
 * path/diagnostic evidence); anything else keeps the legacy length cap.
 */
function guardBlockMessage(e: unknown): string {
  if (e instanceof InternalArtifactsStagedError) return e.message;
  if (e instanceof GitBaselineRestoreError) return e.message;
  if (e instanceof GitPendingOperationError) return e.message;
  if (e instanceof GitStagingError) return e.message;
  return (e instanceof Error ? e.message : String(e)).slice(0, 500);
}

/**
 * P0.2 (B6): typed failure of the baseline restore step. Carries the affected
 * path(s) (parsed from git's own diagnostic when available), the git exit
 * code, a bounded git diagnostic and an index snapshot (`status
 * --porcelain=v1 -z` at failure time) as evidence for the operator. Message is
 * self-limiting (≤500 chars, path-name evidence only, no file content).
 */
export class GitBaselineRestoreError extends Error {
  /** Baseline path(s) whose restore failed — path names only, no content. */
  readonly paths: string[];
  /** git exit code — null when the process could not be spawned/initialized (test-injected values included). */
  readonly code: number | null;
  /** True when the git invocation timed out. */
  readonly timedOut: boolean;
  /** git's diagnostic, bounded to 400 chars. */
  readonly stderr: string;
  /** `git status --porcelain=v1 -z` snapshot at failure time, bounded. */
  readonly porcelain: string;
  constructor(paths: string[], code: number | null, stderr: string, porcelain: string, timedOut = false) {
    let shown = paths.length === 1 ? `path "${paths[0]}"` : `paths ${paths.map((p) => `"${p}"`).join(", ")}`;
    if (shown.length > 140) shown = `${shown.slice(0, 140)}…`;
    // C5: a null code is a process-initialization/spawn failure, never a real
    // exit status ("unknown" + its own cause phrase); a timeout is stated
    // explicitly. The three failure modalities stay distinguishable. Message
    // is self-limiting (≤500 chars, path-name evidence only, no file content).
    const exitText = code === null ? "unknown" : String(code);
    const cause = timedOut
      ? ", timed out"
      : code === null
        ? " — git process could not be started"
        : "";
    super(
      `OAE baseline restore failed (git restore --staged, exit ${exitText}${cause}) for ${shown}` +
      `; commit blocked — nothing was committed and no cleanup was executed.` +
      ` git said: ${stderr.slice(0, 150)}` +
      ` | index at failure: ${porcelain.replace(/\n/g, " | ").slice(0, 120)}`,
    );
    this.name = "GitBaselineRestoreError";
    this.paths = paths;
    this.code = code;
    this.timedOut = timedOut;
    this.stderr = stderr;
    this.porcelain = porcelain;
  }
}

/**
 * P0.2 (B6): demote every baseline path out of the staging our `git add -A`
 * produced — ONE verified invocation for the whole list (the plan's §5.2.1
 * same-invocation variant; renamed baseline pairs ride along naturally since
 * both sides are flat list entries). Empirically verified on git 2.43: git
 * validates every pathspec BEFORE touching the index and exits 1 with the
 * index unchanged when any pathspec is not "known to git" — so this restore
 * either applies completely or fails cleanly, with no partially-restored
 * index to undo. Every baseline path comes from a status record captured
 * during prepareGit, so a failure means the baseline drifted underneath this
 * run (concurrent writer) — fail closed: block the commit, keep evidence,
 * never improvise a destructive recovery.
 *
 * P0.2 (C4): porcelain -z paths are LITERAL file names, but a bare pathspec
 * after `--` is still reinterpreted by git as a glob pattern. `a[1].txt`
 * matches both `a[1].txt` and `a1.txt`, so the restore would demote the
 * WRONG sibling out of the index and leave real baseline work in the task
 * commit. Each path is therefore passed as `:(literal)<path>`, which
 * disables every pathspec magic (globs, short-hand `:!`/`:^`/`:/` exclude
 * and top forms included). Verified on git 2.43 that the remainder after
 * the leading `:(...)` magic is taken verbatim, so a file name that itself
 * starts with `:` (e.g. `:weird`, `:(top)`) is still safe: it is spelled
 * `:(literal):weird`, never re-parsed as magic. The `--` separator stays:
 * it guards against option-looking paths (leading `-`) independent of
 * magic interpretation.
 *
 * Not destructive by construction: with --staged, restore rewrites INDEX
 * entries from HEAD only; the working tree is never touched. No `git reset`,
 * no `git rm --cached`, no Cobra cleanup anywhere.
 */
async function restoreBaseline(dir: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return; // empty baseline → no restore invocation at all
  // C4: literal pathspecs only — a captured file name must never act as a
  // glob and touch a sibling file it merely pattern-matches.
  const literal = paths.map((p) => `:(literal)${p}`);
  const r = await git(dir, "restore", "--staged", "--", ...literal);
  // C5: explicit fail-closed check for ALL three failure modalities — non-zero
  // exit, spawn/initialization failure (code null, stated explicitly) and
  // timeout. A timeout with code 0 or null must never be read as success.
  if (r.code === null || r.code !== 0 || r.timedOut) {
    // Evidence: index snapshot as it stands at the moment of the failure.
    const snap = await git(dir, "status", "--porcelain=v1", "-z");
    const porcelain = snap.code === 0 && !snap.timedOut
      ? snap.stdout.split("\0").filter(Boolean).join("\n").slice(0, 2000)
      : "";
    const output = (r.stderr || r.stdout).trim().slice(0, 400);
    // Pin down the offending path when git names it: "error: pathspec 'X'
    // did not match any file(s) known to git".
    // C5/P3: git echoes the whole pathspec it was handed; report the file
    // name in the evidence, not our `:(literal)` magic prefix.
    const named = [...output.matchAll(/pathspec '(.*?)' did not match/g)].map((m) =>
      m[1].startsWith(":(literal)") ? m[1].slice(":(literal)".length) : m[1],
    );
    throw new GitBaselineRestoreError(named.length > 0 ? named : paths, r.code, output, porcelain, r.timedOut);
  }
}

export async function commitAll(dir: string, message: string, exclude: string[] = []): Promise<{ commit?: string; error?: string }> {
  // P0.2.1 (A1): fail-closed gate BEFORE touching anything — a user-left
  // merge/rebase/cherry-pick/revert is never concluded by an OAE commit, and
  // an unanswerable state query blocks too (the repo is never assumed clean).
  try {
    await assertNoPendingGitOperations(dir);
  } catch (e) {
    return { error: guardBlockMessage(e) };
  }
  // P0.1: guard pre-check BEFORE we touch the index, so a pre-staged internal
  // artifact blocks this operation without staging anything (no add, no
  // restore) and the caller's git state is left exactly as it was.
  try {
    await assertNoInternalArtifactsStaged(dir);
  } catch (e) {
    return { error: guardBlockMessage(e) };
  }
  // P0.2.1 (A3): staging failure aborts BEFORE restoreBaseline and the commit
  // (typed error, no cleanup, no retry; the index is left exactly as it was).
  try {
    await stageAll(dir);
  } catch (e) {
    return { error: guardBlockMessage(e) };
  }
  // P0.2 (B6): verified restore — one invocation, exit code checked, typed
  // error on failure. The commit below never runs after a restore failure.
  try {
    await restoreBaseline(dir, exclude);
  } catch (e) {
    return { error: guardBlockMessage(e) };
  }
  try {
    // second check after staging: still fail-closed before the commit runs
    await assertNoInternalArtifactsStaged(dir);
  } catch (e) {
    return { error: guardBlockMessage(e) };
  }
  const c = await git(dir, ...COMMIT_IDENTITY_ARGS, "commit", "-m", message);
  if (c.code !== 0) {
    // nothing to commit is not an error for empty tasks ("nothing to commit"
    // once HEAD exists, "nothing added to commit" on the initial commit)
    if (/nothing(?: added)? to commit/.test(c.stdout + c.stderr)) return { commit: undefined };
    // a failing pre-commit hook can abort the commit with no output at all —
    // the error must still be truthy so callers never mistake it for success.
    // C5/P4: a null exit code is a process-initialization failure, not a
    // numeric exit — say so instead of rendering "exited with code null".
    return {
      error: ((c.stderr || c.stdout).trim()
        || (c.code === null ? "git commit could not be started (no exit code)" : `git commit exited with code ${c.code}`)
      ).slice(0, 500),
    };
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
