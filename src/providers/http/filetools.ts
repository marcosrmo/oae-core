/**
 * Minimal file tools for direct providers (Onda 2 plan §4): read_file,
 * write_file, list_dir — executed by the runner itself, restricted to the
 * session's project root. NO shell, NO network, NO package installation
 * (that is Onda 3 tool-core/sandbox scope).
 *
 * Isolation rules (defense in depth):
 * 1. strict argument schemas (types + no unknown fields + size caps);
 * 2. lexical rejection BEFORE resolution: absolute paths, ".." traversal,
 *    backslash-path escapes, "~", drive letters, NUL bytes;
 * 3. canonical resolution: the root is realpath'ed once; every existing
 *    path target must realpath back under it (rejects symlink escapes);
 *    symlinks are refused outright (the model can target the real path);
 * 4. new files: the parent dir is created inside the root and THEN realpath
 *    checked before writing;
 * 5. `.oae/` and `.opencode/` are read-only for the model (orchestrator
 *    state belongs to the harness, mirroring CODER_PROMPT rule 6);
 * 6. bounded I/O: reads cap content, writes cap size, lists cap entries.
 *
 * execute() NEVER throws — every failure is a plain-text tool result so the
 * model can correct course; a broken tool must never crash the session.
 */
import { constants as FS_CONSTANTS, lstat, mkdir, open, opendir, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { redact } from "../../progress.ts";
import type { ToolSchema } from "./transport.ts";

export const FILE_TOOL_LIMITS = {
  /** read_file returns at most this many characters (truncation marker appended). */
  readMaxChars: 48_000,
  /** write_file accepts at most this many characters. */
  writeMaxChars: 256_000,
  /** list_dir returns at most this many entries (tail note with the count). */
  listMaxEntries: 400,
  pathMaxChars: 512,
} as const;

const WRITE_DENIED_PREFIXES = [".oae", ".opencode"];

type FieldKind = "string" | "opt-string";
const FIELD_SPECS: Record<string, { field: string; kind: FieldKind }[]> = {
  read_file: [{ field: "path", kind: "string" }],
  write_file: [{ field: "path", kind: "string" }, { field: "content", kind: "string" }],
  list_dir: [{ field: "path", kind: "opt-string" }],
};

export function fileToolSpecs(): ToolSchema[] {
  return [
    {
      name: "read_file",
      description: "Read a text file inside the project. Paths are RELATIVE to the project root; absolute paths, '..' and symlinks are refused.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "relative path, e.g. src/index.ts" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
    {
      name: "write_file",
      description: "Create or overwrite a text file inside the project. Paths are RELATIVE to the project root; .oae/ and .opencode/ are read-only.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "relative path, e.g. src/lib/util.ts" },
          content: { type: "string", description: "the complete file content" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
    {
      name: "list_dir",
      description: "List one directory inside the project (shallow). Paths are RELATIVE to the project root; default is '.', the root itself.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "relative directory, default '.'" } },
        required: [],
        additionalProperties: false,
      },
    },
  ];
}

export class FileToolSet {
  private root: string;
  private rootReal: string | null = null;

  constructor(root: string) {
    this.root = root;
  }

  /** The realpath'ed root the tool set is actually confined to. */
  async canonicalRoot(): Promise<string> {
    if (!this.rootReal) this.rootReal = await realpath(this.root);
    return this.rootReal;
  }

  /**
   * Execute one tool call. Always resolves to a plain-text result (the
   * tool-result message sent back to the model); internal failures are
   * returned as "ERROR: ..." text, never thrown.
   *
   * `signal` is BEST-EFFORT only (audit F1 honesty note): Node cannot cancel
   * an OS-level blocking I/O such as open() on a FIFO via AbortSignal. The
   * runner therefore never depends on tool completion for settlement — it
   * races this call against its stop promise and discards late resolutions.
   */
  async execute(name: string, rawArgs: string, signal?: AbortSignal): Promise<string> {
    try {
      if (!FIELD_SPECS[name]) return `ERROR: unknown tool "${truncate(name, 60)}"`;
      if (signal?.aborted) return "ERROR: cancelled before execution (session interrupted)";
      const args = this.parseArgs(name, rawArgs);
      switch (name) {
        case "read_file": return await this.readFile(args.path as string);
        case "write_file": return await this.writeFile(args.path as string, args.content as string);
        case "list_dir": return await this.listDir((args.path as string | undefined) ?? ".");
        default: return `ERROR: unknown tool "${truncate(name, 60)}"`;
      }
    } catch (e) {
      return `ERROR: ${redact(String((e as Error)?.message ?? e))}`;
    }
  }

  /** Strict schemas: types, unknown-field rejection, caps, NUL bytes. */
  private parseArgs(name: string, rawArgs: string): Record<string, unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawArgs);
    } catch {
      throw new Error(`arguments are not valid JSON for ${name}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`arguments for ${name} must be a JSON object`);
    }
    const args = parsed as Record<string, unknown>;
    const spec = FIELD_SPECS[name]!;
    for (const s of spec) {
      const v = args[s.field];
      if (s.kind === "opt-string" && v === undefined) continue;
      if (typeof v !== "string") throw new Error(`field "${s.field}" must be a string`);
      if (s.field === "path" && v.length > FILE_TOOL_LIMITS.pathMaxChars) {
        throw new Error(`field "path" exceeds ${FILE_TOOL_LIMITS.pathMaxChars} chars`);
      }
      if (v.includes("\u0000")) throw new Error(`field "${s.field}" contains NUL bytes`);
    }
    for (const key of Object.keys(args)) {
      if (!spec.some((s) => s.field === key)) throw new Error(`unknown field "${truncate(key, 60)}" for ${name}`);
    }
    return args;
  }

  /**
   * Canonical, escape-proof target resolution for BOTH existing and new
   * paths: lexical checks → canonical join → (existing ? realpath target :
   * create parent then realpath parent) → containment under the root.
   */
  private async resolveTarget(rawPath: string, forWrite: boolean): Promise<string> {
    const rootReal = await this.canonicalRoot();
    const p = rawPath.replaceAll("\\", "/");
    if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) {
      throw new Error(`absolute paths are not allowed (got "${truncate(redact(rawPath), 120)}") — pass a path relative to the project root`);
    }
    if (p === "~" || p.startsWith("~/")) throw new Error("'~' is not allowed — pass a path relative to the project root");
    if (p.split("/").includes("..")) throw new Error("'..' traversal is not allowed — pass a path relative to the project root");
    const segments = p.split("/").filter((s) => s !== "" && s !== ".");
    if (segments.length === 0) {
      if (forWrite) throw new Error("path must name something inside the project root");
      return rootReal; // "." IS the root (e.g. the list_dir default)
    }
    if (forWrite && WRITE_DENIED_PREFIXES.includes(segments[0]!)) {
      throw new Error(`"${segments[0]}/" is read-only for the model (orchestrator-owned)`);
    }
    let target = rootReal;
    for (const s of segments) target = join(target, s);
    if (forWrite) {
      // new files: BEFORE creating anything, anchor the write at the deepest
      // EXISTING ancestor of the parent and prove it is inside the root
      // (audit F7: mkdir must never follow a symlink out of the root)
      const parent = dirname(target);
      const anchor = await this.existingAncestor(parent);
      this.assertInside(await realpath(anchor), rootReal, rawPath);
      await mkdir(parent, { recursive: true });
      this.assertInside(await realpath(parent), rootReal, rawPath);
      // the leaf must not be an existing symlink pointed anywhere
      const leaf = await safeLstat(target);
      if (leaf?.isSymbolicLink()) throw new Error("refusing to write: target is a symlink (symlinks are not followed)");
      return target;
    }
    const leaf = await safeLstat(target);
    if (!leaf) throw new Error(`no such path in the project: ${truncate(relative(rootReal, target) || ".", 200)}`);
    if (leaf.isSymbolicLink()) throw new Error("refusing to follow a symlink (symlinks are not followed) — target the real path instead");
    this.assertInside(await realpath(target), rootReal, rawPath);
    return target;
  }

  private assertInside(real: string, rootReal: string, rawPath: string): void {
    const ok = real === rootReal || real.startsWith(rootReal + sep);
    if (!ok) throw new Error(`path escapes the project root (refused): ${truncate(redact(rawPath), 160)}`);
  }

  /** Deepest existing ancestor of p (walking up). The realpath of this node
   * is checked BEFORE any directory creation happens under it (F7). */
  private async existingAncestor(p: string): Promise<string> {
    let cur = p;
    for (;;) {
      if (await safeLstat(cur)) return cur;
      const up = dirname(cur);
      if (up === cur) return cur; // filesystem root reached
      cur = up;
    }
  }

  private async readFile(rawPath: string): Promise<string> {
    const target = await this.resolveTarget(rawPath, false);
    const st = await safeLstat(target);
    if (st?.isDirectory()) throw new Error("path is a directory — use list_dir");
    // bounded read (audit F2): NEVER materialize the whole file. First pass
    // reads at most readMaxChars*4+1 bytes (worst-case UTF-8 expansion; the
    // +1 byte separates truncation from an exact end-of-file). Only when the
    // prefix proves truncation does a second bounded-memory pass COUNT the
    // remaining characters (streamed decoding, fixed-size chunks) so the
    // public message keeps its exact "file has N chars" wording.
    const cap = FILE_TOOL_LIMITS.readMaxChars;
    const capBytes = cap * 4 + 1;
    const handle = await open(target, "r");
    try {
      const buf = Buffer.alloc(capBytes);
      const { bytesRead } = await handle.read(buf, 0, capBytes, 0);
      const truncated = bytesRead === capBytes;
      // the sliced-back byte avoids a mid-codepoint cut in the first pass
      const text = new TextDecoder("utf8", { fatal: false }).decode(buf.subarray(0, truncated ? capBytes - 1 : bytesRead));
      if (!truncated && text.length <= cap) return text;
      const total = text.length + (truncated ? await this.countTailChars(handle, capBytes - 1) : 0);
      return `${text.slice(0, cap)}\n…[truncated: file has ${total} chars, showing first ${cap}]`;
    } finally {
      await handle.close();
    }
  }

  /** Second pass of a truncated read: counts remaining UTF-8 characters in
   * fixed-size chunks without retaining content (audit F2). */
  private async countTailChars(handle: FileHandle, fromByte: number): Promise<number> {
    const decoder = new TextDecoder("utf8", { fatal: false });
    const buf = Buffer.alloc(65_536);
    let pos = fromByte;
    let count = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, pos);
      if (bytesRead === 0) {
        count += decoder.decode().length; // final flush (dangling byte → one char)
        return count;
      }
      pos += bytesRead;
      count += decoder.decode(buf.subarray(0, bytesRead), { stream: true }).length;
    }
  }

  /** F8 mitigation (Etapa 3): resolveTarget's lstat→write gap is closed at
   * the LEAF with open(O_NOFOLLOW) — a PATH that turns into a symlink
   * BETWEEN the check and the open fails with ELOOP instead of being
   * followed out of the root. Legit creation AND overwrite of regular files
   * are preserved (O_WRONLY|O_CREAT|O_TRUNC; same visible behavior and
   * message as the former fs/writeFile path). Resolution/containment checks
   * are untouched. Unresolved by design: directory-component swaps,
   * hardlinks and bind-mounts are invisible to realpath/no-follow flags —
   * documented residual for the Onda 3 sandbox (docs/onda2-plan.md §9). */
  private async writeFile(rawPath: string, content: string): Promise<string> {
    if (content.length > FILE_TOOL_LIMITS.writeMaxChars) {
      throw new Error(`content exceeds the ${FILE_TOOL_LIMITS.writeMaxChars} char cap (${content.length})`);
    }
    const target = await this.resolveTarget(rawPath, true);
    // secure final-component open: O_NOFOLLOW refuses a leaf that is (or just
    // became) a symlink; ?? 0 keeps the flags valid on platforms that lack it
    const flags = FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_TRUNC | (FS_CONSTANTS.O_NOFOLLOW ?? 0);
    let handle;
    try {
      handle = await open(target, flags, 0o666);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ELOOP") {
        throw new Error("refusing to write: target is a symlink (O_NOFOLLOW rejected the open; symlinks are not followed)");
      }
      throw e;
    }
    try {
      // same observable result as fs/writeFile(..., "utf8"): file truncated
      // by O_TRUNC before this, then the full content written from byte 0
      // (multi-byte UTF-8 safe). fsPromises.writeFile internally RETRIED
      // short writes; a single handle.write() must not be trusted with that
      const buf = Buffer.from(content, "utf8");
      await writeFully(handle, buf);
    } finally {
      // release the descriptor on every outcome; a close failure must never
      // mask the original write error
      await handle.close().catch(() => undefined);
    }
    const rel = relative(await this.canonicalRoot(), target) || ".";
    return `written ${Buffer.byteLength(content, "utf8")} bytes to ${rel}`;
  }

  private async listDir(rawPath: string): Promise<string> {
    const target = await this.resolveTarget(rawPath, false);
    const st = await safeLstat(target);
    if (st?.isFile()) throw new Error("path is a file — use read_file");
    if (st && !st.isDirectory()) throw new Error("path is neither a file nor a directory");
    // bounded listing (audit F2): incremental opendir keeps memory at O(cap)
    // — only the alphabetically-first 400 entries are retained; the rest are
    // counted and discarded (exact hidden count preserved in the output).
    const dir = await opendir(target);
    const cap = FILE_TOOL_LIMITS.listMaxEntries;
    const keep: Dirent[] = [];
    let total = 0;
    try {
      for (;;) {
        const d = await dir.read();
        if (!d) break;
        total++;
        if (keep.length < cap) {
          // sorted insertion; the slot array stays ≤ cap for any dir size
          const at = keep.findIndex((e) => e.name.localeCompare(d.name) > 0);
          if (at < 0) keep.push(d);
          else keep.splice(at, 0, d);
        } else if (d.name.localeCompare(keep[cap - 1]!.name) < 0) {
          keep.pop();
          const at = keep.findIndex((e) => e.name.localeCompare(d.name) > 0);
          if (at < 0) keep.push(d);
          else keep.splice(at, 0, d);
        }
      }
    } finally {
      await dir.close();
    }
    const lines = keep.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    if (total > keep.length) {
      lines.push(`…[${total - keep.length} more entries hidden (cap ${cap})]`);
    }
    return lines.join("\n") || "(empty directory)";
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** R3 (auditoria técnica Etapa 3): full-write loop for the secured leaf
 * handle. The former fsPromises.writeFile internally covered short writes;
 * a single handle.write() does not, so a short write would have left a
 * truncated file while the tool still reported the full count. This loop
 * resumes from the bytes actually written and aborts with an explicit error
 * when a write returns ZERO bytes (no progress possible on this descriptor)
 * — it never reports bytes that were not written to the descriptor.
 * Exported ONLY for deterministic tests with a fake FileHandle: partial
 * writes, write failures and zero-progress are not injectable on a real
 * regular file without a disproportional fs-injection layer. */
export async function writeFully(handle: FileHandle, buf: Uint8Array): Promise<void> {
  let written = 0;
  while (written < buf.length) {
    const chunk = buf.subarray(written);
    const r = await handle.write(chunk, 0, chunk.byteLength);
    if (r.bytesWritten <= 0) {
      throw new Error(`write_file: write made no progress (${written}/${buf.length} bytes written)`);
    }
    written += r.bytesWritten;
  }
}

async function safeLstat(p: string): Promise<Stats | null> {
  try { return await lstat(p); } catch { return null; }
}
