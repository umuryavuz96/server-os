// Crash forensics for the Alerts tab: reads what ~/scripts/blackbox/blackbox.py writes (read-only).
// Memory history (5-minute buckets, last 24 h), the newest top consumers, and the boot reports.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./lib";

const BB = join(HOME, "scripts/logs/blackbox");
const REPORTS = join(HOME, "scripts/logs/boot-reports");

export interface BbSample { ts: string; mem: { avail_mb: number; swap_used_mb: number | null; pressure: string | null; compressed_mb: number; wired_mb: number }; load: number[]; top: { name: string; pid: number; mb: number }[]; claude_procs: number; docker_ok: boolean; tmux: string[] }

export function parseSamples(text: string): BbSample[] {
  const out: BbSample[] = [];
  for (const ln of text.split("\n")) { if (!ln.trim()) continue; try { out.push(JSON.parse(ln)); } catch { /* torn last line */ } }
  return out;
}

/** Average samples into fixed buckets (default 5 min). */
export function bucket(samples: BbSample[], stepSec = 300) {
  const by = new Map<number, BbSample[]>();
  for (const s of samples) { const t = Math.floor(Date.parse(s.ts) / 1000 / stepSec) * stepSec; (by.get(t) ?? by.set(t, []).get(t)!).push(s); }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([t, xs]) => ({
    t, availMb: Math.round(Math.min(...xs.map((x) => x.mem.avail_mb))), swapMb: Math.round(Math.max(...xs.map((x) => x.mem.swap_used_mb ?? 0))),
    pressure: xs.some((x) => x.mem.pressure && x.mem.pressure !== "normal") ? "warn" : "normal", dockerOk: xs.every((x) => x.docker_ok),
  }));
}

export function readBlackbox(now = Date.now(), dir = BB, reportsDir = REPORTS) {
  let samples: BbSample[] = [];
  try {
    const files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-2);
    for (const f of files) samples.push(...parseSamples(readFileSync(join(dir, f), "utf8")));
  } catch { /* recorder not installed yet */ }
  samples = samples.filter((s) => now - Date.parse(s.ts) < 24 * 3600_000);
  const last = samples.at(-1) ?? null;
  let reports: { name: string; ts: number; md: string }[] = [];
  try {
    reports = readdirSync(reportsDir).filter((f) => f.endsWith(".md")).sort().slice(-5).reverse().map((f) => {
      const m = f.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
      const ts = m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`) / 1000 : 0;
      return { name: f, ts, md: readFileSync(join(reportsDir, f), "utf8").slice(0, 6000) };
    });
  } catch { /* none yet */ }
  return { installed: existsSync(dir), totalMb: 16384, lastTs: last ? Math.floor(Date.parse(last.ts) / 1000) : null, age: last ? Math.round((now - Date.parse(last.ts)) / 1000) : null,
    history: bucket(samples), top: last?.top.slice(0, 5) ?? [], last: last ? { availMb: last.mem.avail_mb, swapMb: last.mem.swap_used_mb, pressure: last.mem.pressure, claude: last.claude_procs, dockerOk: last.docker_ok, load: last.load } : null, reports };
}
