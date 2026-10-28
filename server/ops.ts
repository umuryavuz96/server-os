// Ops tabs: cron jobs, notify-bot alerts, Telegram bots, deploy webhooks.
import { config } from "./core/config";
import { openSync, readSync, fstatSync, closeSync, existsSync, statSync, readdirSync, readFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { HOME, run, log, every } from "./lib";
import { setSlice } from "./store";
import { DEMO, demoAlerts } from "./demo";

// ---------- notify history: read the (70 MB) JSONL backwards, newest first ----------
export interface HistEntry { t: number; job: string; action: string; sent: boolean; id: number | null; cause: string; title: string; body: string; input_status?: string; }
const cronCfg = () => config.integrations.cron;
const HISTORY = () => cronCfg()?.history;

export function readHistory(days: number): HistEntry[] {
  const cutoff = Date.now() / 1000 - days * 86400;
  const out: HistEntry[] = [];
  const file = HISTORY();
  if (!file) return out;
  let fd: number;
  try { fd = openSync(file, "r"); } catch { return out; }
  try {
    let pos = fstatSync(fd).size, rest = "";
    const CH = 1 << 20;
    outer: while (pos > 0) {
      const n = Math.min(CH, pos); pos -= n;
      const buf = Buffer.alloc(n); readSync(fd, buf, 0, n, pos);
      const lines = (buf.toString("utf8") + rest).split("\n");
      rest = lines.shift() ?? "";
      for (let i = lines.length - 1; i >= 0; i--) {
        const raw = lines[i].trim(); if (!raw) continue;
        let e: Record<string, unknown>; try { e = JSON.parse(raw); } catch { continue; }
        const t = Date.parse(String(e.ts)) / 1000; if (!Number.isFinite(t)) continue;
        if (t < cutoff) break outer;
        const legacy = e.mode === "legacy"; // plain notify calls carry no job/sent: title names the source
        out.push({
          t, job: String((legacy ? e.title : e.job) ?? "?"), action: String(e.action ?? (legacy ? "legacy" : "")),
          sent: legacy ? !!e.telegram_ok : !!e.sent, id: (e.id as number) ?? null, cause: String(e.cause ?? ""),
          title: String(e.title ?? "").replace(/<[^>]+>/g, ""), body: String(e.body ?? "").replace(/<[^>]+>/g, "").slice(0, 600),
          input_status: e.input_status as string | undefined,
        });
      }
    }
  } finally { closeSync(fd); }
  return out;
}

// ---------- cron ----------
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function humanSchedule(s: string) {
  const p = s.split(/\s+/); if (p.length !== 5) return s;
  const [mi, h, dom, mon, dow] = p;
  if (mi.startsWith("*/") && h === "*" && dom === "*" && mon === "*" && dow === "*") return `every ${mi.slice(2)} min`;
  if (/^\d+$/.test(mi) && h === "*" && dom === "*" && mon === "*" && dow === "*") return `hourly at :${mi.padStart(2, "0")}`;
  if (!(/^\d+$/.test(mi) && /^[\d,]+$/.test(h))) return s;
  const at = h.split(",").map((x) => `${x.padStart(2, "0")}:${mi.padStart(2, "0")}`).join(", ");
  if (dom === "*" && mon === "*" && dow === "*") return `daily ${at}`;
  if (dom === "*" && mon === "*" && dow === "1-5") return `weekdays ${at}`;
  if (dom === "*" && mon === "*" && /^[\d,]+$/.test(dow)) return dow.split(",").map((d) => DOW[+d % 7]).join(" ") + " " + at;
  if (dom.startsWith("*/") && mon === "*" && dow === "*") return `every ${dom.slice(2)} days ${at}`;
  if (/^\d+$/.test(dom) && mon === "*" && dow === "*") return `monthly on day ${dom}, ${at}`;
  return s;
}
function fieldMatch(f: string, v: number, lo: number, hi: number): boolean {
  return f.split(",").some((part) => {
    const [range, stepS] = part.split("/"); const step = stepS ? +stepS : 1;
    let a = lo, b = hi;
    if (range !== "*") { const [x, y] = range.split("-").map(Number); a = x; b = y ?? (stepS ? hi : x); }
    return v >= a && v <= b && (v - a) % step === 0;
  });
}
export function nextRun(s: string, from = new Date()): number | null {
  const [mi, h, dom, mon, dow] = s.split(/\s+/);
  const d = new Date(from); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 60 * 24 * 32; i++) {
    const domOk = fieldMatch(dom, d.getDate(), 1, 31), dowOk = fieldMatch(dow, d.getDay() % 7, 0, 7) || (dow.includes("7") && d.getDay() === 0);
    const dayOk = dom !== "*" && dow !== "*" ? domOk || dowOk : domOk && dowOk;
    if (fieldMatch(mi, d.getMinutes(), 0, 59) && fieldMatch(h, d.getHours(), 0, 23) && fieldMatch(mon, d.getMonth() + 1, 1, 12) && dayOk) return Math.floor(d.getTime() / 1000);
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}
/** The most recent scheduled time at or before `from` (the start of the current countdown). */
export function prevRun(s: string, from = new Date()): number | null {
  const [mi, h, dom, mon, dow] = s.split(/\s+/);
  const d = new Date(from); d.setSeconds(0, 0);
  for (let i = 0; i < 60 * 24 * 32; i++) {
    const domOk = fieldMatch(dom, d.getDate(), 1, 31), dowOk = fieldMatch(dow, d.getDay() % 7, 0, 7) || (dow.includes("7") && d.getDay() === 0);
    const dayOk = dom !== "*" && dow !== "*" ? domOk || dowOk : domOk && dowOk;
    if (fieldMatch(mi, d.getMinutes(), 0, 59) && fieldMatch(h, d.getHours(), 0, 23) && fieldMatch(mon, d.getMonth() + 1, 1, 12) && dayOk) return Math.floor(d.getTime() / 1000);
    d.setMinutes(d.getMinutes() - 1);
  }
  return null;
}
export function jobName(cmd: string): [string, boolean] {
  const m = /cron_wrap\.sh\s+(.*)/.exec(cmd);
  if (m) return [m[1].replace(/--[\w-]+(=('[^']*'|"[^"]*"|\S+))?\s*/g, "").trim().split(/\s+/)[0].replace(/["']/g, ""), true];
  const path = cmd.split(/\s*[>&]/)[0].trim().split(/\s+/).at(-1) ?? cmd;
  let parent = basename(dirname(path)); if (parent === "crons") parent = basename(dirname(dirname(path)));
  const stem = basename(path).replace(/\.[^.]+$/, "");
  return [parent === stem ? stem : `${parent} ${stem}`, false];
}
export interface Job {
  id: string; name: string; schedule: string; when: string; enabled: boolean; nextRun: number | null; status: string; lastRun: number | null; cause: string; log: string | null; command: string;
  // ID card (integrations.cron.cards) + the last runs it reported to the notify bot, newest first
  prevRun: number | null; category: string | null; about: string | null; reports: string | null; project: string | null; runs: { t: number; ok: boolean }[];
}
const CARDS = () => cronCfg()?.cards;
type Card = { category?: string; about?: string; reports?: string; project?: string };
function readCards(): Record<string, Card> { const f = CARDS(); if (!f) return {}; try { return JSON.parse(readFileSync(f, "utf8")); } catch { return {}; } }

export async function readJobs(): Promise<Job[]> {
  if (!cronCfg()) return [];
  const cron = (await run(["crontab", "-l"], 10_000)).out.split("\n");
  const last = new Map<string, HistEntry>();
  const runs = new Map<string, { t: number; ok: boolean }[]>();
  for (const e of readHistory(7)) {
    if (!last.has(e.job)) last.set(e.job, e);
    const r = runs.get(e.job) ?? []; if (r.length < 14) r.push({ t: e.t, ok: ["ok", "signal", "heartbeat"].includes(e.input_status ?? "") }); runs.set(e.job, r);
  }
  const cards = readCards();
  const jobs: Job[] = [];
  cron.forEach((raw, idx) => {
    const line = raw.trim(); if (!line) return;
    const disabled = line.startsWith("#");
    const body = line.replace(/^#+\s*/, "");
    const p = body.split(/\s+/);
    if (p.length < 6 || !/^(\*|\d)[\d*/,-]*$/.test(p[0]) || !p.slice(1, 5).every((t) => /^[\d*/,\-\w]+$/.test(t))) return;
    const schedule = p.slice(0, 5).join(" "), command = body.split(/\s+/).slice(5).join(" ");
    const [name, wrapped] = jobName(command);
    const logf = wrapped && cronCfg()?.logs ? join(cronCfg()!.logs!, name + ".log") : null;
    const mtime = logf && existsSync(logf) ? statSync(logf).mtimeMs / 1000 : null;
    const h = last.get(name);
    const status = disabled ? "paused" : h ? (["ok", "signal", "heartbeat"].includes(h.input_status ?? "") ? "ok" : "fail") : mtime ? "ran" : wrapped ? "unknown" : "untracked";
    jobs.push({ id: `cron:${idx}`, name, schedule, when: humanSchedule(schedule), enabled: !disabled, nextRun: disabled ? null : nextRun(schedule), prevRun: disabled ? null : prevRun(schedule),
      status, lastRun: h?.t ?? mtime, cause: h?.cause ?? "", log: mtime ? logf : null, command,
      category: cards[name]?.category ?? null, about: cards[name]?.about ?? null, reports: cards[name]?.reports ?? null, project: cards[name]?.project ?? null,
      runs: runs.get(name) ?? [] });
  });
  // pure-comment lines that merely look like jobs (e.g. "# 0 8 * * * old thing") count as paused; real disabled jobs are kept
  return jobs.sort((a, b) => Number(!a.enabled) - Number(!b.enabled) || Number(a.status !== "fail") - Number(b.status !== "fail") || a.name.localeCompare(b.name));
}

export function tail(path: string, n = 60) {
  try {
    const fd = openSync(path, "r"); const size = fstatSync(fd).size; const len = Math.min(size, 16384);
    const buf = Buffer.alloc(len); readSync(fd, buf, 0, len, size - len); closeSync(fd);
    return buf.toString("utf8").split("\n").slice(-n).join("\n");
  } catch { return ""; }
}

export async function runJob(id: string) {
  const job = (await readJobs()).find((j) => j.id === id);
  if (!job) return { ok: false, detail: "unknown job" };
  if (!job.enabled) return { ok: false, detail: "job is paused in crontab" };
  Bun.spawn(["/bin/sh", "-c", job.command], { cwd: HOME, env: { ...process.env, PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", HOME }, stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
  log(`job ${job.name} -> RUN NOW (${id})`);
  return { ok: true, detail: `${job.name} started` };
}

export function alerts(days: number) {
  if (DEMO) return demoAlerts(days >= 7 ? 7 : 1);
  const since = Date.now() / 1000 - days * 86400;
  const rows = readHistory(7).filter((e) => e.t >= since && e.action !== "noop_ok");
  const by = new Map<string, { job: string; sent: number; silent: number; items: HistEntry[] }>();
  for (const e of rows) {
    const g = by.get(e.job) ?? by.set(e.job, { job: e.job, sent: 0, silent: 0, items: [] }).get(e.job)!;
    e.sent ? g.sent++ : g.silent++;
    if (g.items.length < 8) g.items.push(e);
  }
  const groups = [...by.values()];
  return { days, sent: groups.reduce((s, g) => s + g.sent, 0), silent: groups.reduce((s, g) => s + g.silent, 0),
    newCause: rows.filter((e) => e.action === "send_failure_new_cause").length, groups };
}

// ---------- bots ----------
const CHANNELS = config.integrations.channelsDir ?? join(HOME, ".claude/channels");
function alivePid(file: string): number | null {
  try { const pid = +readFileSync(file, "utf8").trim(); process.kill(pid, 0); return pid; } catch { return null; }
}
export async function readBots() {
  const out = [];
  for (const dir of readdirSync(CHANNELS)) {
    const d = join(CHANNELS, dir);
    try { if (!statSync(d).isDirectory()) continue; } catch { continue; }
    const bot = alivePid(join(d, "bot.pid")), sess = alivePid(join(d, "run.pid")); // bun poller = real liveness; never touch the processes
    let since: number | null = null;
    if (bot ?? sess) { const r = await run(["ps", "-o", "lstart=", "-p", String(bot ?? sess)], 4_000); const t = Date.parse(r.out); since = Number.isFinite(t) ? t / 1000 : null; }
    const inbox = join(d, "inbox");
    out.push({ dir, name: dir === "telegram" ? "main" : dir, state: bot ? "up" : sess ? "session only" : "down", since,
      lastFile: existsSync(inbox) ? statSync(inbox).mtimeMs / 1000 : null });
  }
  return out.sort((a, b) => Number(a.state !== "up") - Number(b.state !== "up") || Number(a.dir !== "telegram") - Number(b.dir !== "telegram") || a.name.localeCompare(b.name));
}

// ---------- webhooks ----------
export async function readHooks() {
  return Promise.all((config.integrations.webhooks ?? []).map(async (h) => {
    const [ld, nc] = await Promise.all([run(["launchctl", "list", h.service], 5_000), run(["/usr/bin/nc", "-z", "-G", "1", "127.0.0.1", String(h.port)], 4_000)]);
    return { ...h, state: ld.code !== 0 ? "not loaded" : /"PID"/.test(ld.out) ? "running" : "stopped", listening: nc.code === 0,
      logMtime: existsSync(h.log) ? statSync(h.log).mtimeMs / 1000 : null, logTail: tail(h.log, 25) };
  }));
}

export function startOpsCollectors() {
  every(30_000, () => { setSlice("alerts24", alerts(1)); });
  if (config.integrations.telegramBots) every(15_000, async () => { setSlice("bots", await readBots()); });
  if (config.integrations.webhooks?.length) every(20_000, async () => { setSlice("hooks", await readHooks()); });
}
