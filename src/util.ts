import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      rej(new Error("aborted"));
    }, { once: true });
  });
}

export function nowISO(): string {
  return new Date().toISOString();
}

/** Run a command with a hard timeout, capturing output. Never throws on non-zero exit. */
export function runCommand(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; env?: Record<string, string> },
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((res) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      windowsHide: true,
      shell: false,
    });
    let stdout = "", stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, opts.timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      res({ code, stdout: stdout.slice(-20000), stderr: stderr.slice(-20000), timedOut });
    });
    child.on("error", () => {
      clearTimeout(timer);
      res({ code: null, stdout, stderr: stderr.slice(-20000), timedOut });
    });
  });
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + `… [truncated, ${s.length} chars total]`;
}

export async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Atomic JSON write: tmp file + rename. */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, file);
}

export async function appendJsonl(file: string, entry: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(entry) + "\n", "utf8");
}

export function abs(p: string): string {
  return resolve(p);
}
