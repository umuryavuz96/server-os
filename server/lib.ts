// Shared helpers: ~/.env loading, process spawning with timeouts, paths.
import { homedir } from "node:os";
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const HOME = homedir();
export const UID = process.getuid?.() ?? 501;

export function loadEnv(path = join(HOME, ".env")): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const raw of readFileSync(path, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const i = line.indexOf("=");
      const k = line.slice(0, i).replace(/^export\s+/, "").trim();
      out[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    }
  } catch {}
  return out;
}
export const ENV = loadEnv();

export interface RunResult { code: number; out: string; }

/** Run a command with a hard timeout. Never throws. */
export async function run(cmd: string[], timeoutMs = 20_000): Promise<RunResult> {
  try {
    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" } });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    clearTimeout(timer);
    return { code, out: (out + err).trim() };
  } catch (e) {
    return { code: -1, out: String(e) };
  }
}

// The structured logger (core/logger.ts) registers itself here, so these lines also reach the Logs tab.
// A setter, not an import: core/config imports this file, and an import back would be a load-order cycle.
let sink: ((line: string) => void) | null = null;
export const setLogSink = (fn: (line: string) => void) => { sink = fn; };

let logFile: string | null = null;
export const setLogFile = (f: string) => { logFile = f; };

export function log(line: string) {
  if (logFile) {
    mkdirSync(dirname(logFile), { recursive: true });
    const ts = new Date().toLocaleString("sv-SE").replace("T", " ");
    appendFileSync(logFile, `${ts} ${line}\n`);
  }
  sink?.(line);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs fn now and then every `ms`, never overlapping itself. */
export function every(ms: number, fn: () => Promise<void> | void) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await fn(); } catch (e) { console.error("[collector]", e); }
    busy = false;
  };
  tick();
  return setInterval(tick, ms);
}
