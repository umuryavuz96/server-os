// Machine vitals, DNS, Home Assistant, speedtest, uptime — each on its own cadence, pushed only on change.
import { config } from "./core/config";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { freemem, loadavg, totalmem, uptime } from "node:os";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { HOME, ENV, run, every } from "./lib";
import { STATE_DIR } from "./core/config";
import { setSlice } from "./store";
import { DEMO, demoHistory } from "./demo";

const num = (s: string) => { const n = parseFloat(s); return Number.isFinite(n) ? n : null; };

async function dfFree(path: string) {
  const r = await run(["df", "-k", path], 5_000);
  const p = r.out.split("\n")[1]?.trim().split(/\s+/);
  if (!p || p.length < 4) return null;
  return { totalGB: Math.round(+p[1] / 1048576), freeGB: Math.round(+p[3] / 1048576) };
}

const readText = async (p: string) => { try { return await Bun.file(p).text(); } catch { return ""; } };
/** /proc/meminfo value in GB. */
const memInfo = (txt: string, key: string) => { const m = new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(txt); return m ? +m[1] / 1048576 : null; };
const round = (v: number | null, d = 2) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

/** Vitals on macOS (memory_pressure, sysctl, smctemp if installed) and Linux (/proc, /sys/class/thermal). */
export async function collectSystem() {
  const ramTotal = Math.round(totalmem() / 1073741824);
  const [internal, ext] = await Promise.all([dfFree("/"), config.externalDisk ? dfFree(config.externalDisk) : Promise.resolve(null)]);
  const base = { load1: round(loadavg()[0]), ramTotalGB: ramTotal, boot: Math.floor(Date.now() / 1000 - uptime()), internal, ssd: ext };
  if (process.platform === "darwin") {
    const [cpu, gpu, mp, swap] = await Promise.all([
      run(["smctemp", "-c"], 3_000), run(["smctemp", "-g"], 3_000), run(["memory_pressure"], 6_000), run(["sysctl", "-n", "vm.swapusage"], 3_000),
    ]);
    const freePct = Number(/System-wide memory free percentage:\s*(\d+)/.exec(mp.out)?.[1] ?? NaN);
    return {
      ...base, cpuTemp: num(cpu.out), gpuTemp: num(gpu.out),
      ramUsedGB: Number.isFinite(freePct) ? round((ramTotal * (100 - freePct)) / 100) : round((totalmem() - freemem()) / 1073741824),
      swapGB: (() => { const m = /used = ([\d.]+)M/.exec(swap.out); return m ? Math.round(+m[1] / 102.4) / 10 : null; })(),
    };
  }
  const [mi, t0] = await Promise.all([readText("/proc/meminfo"), readText("/sys/class/thermal/thermal_zone0/temp")]);
  const total = memInfo(mi, "MemTotal"), avail = memInfo(mi, "MemAvailable"), st = memInfo(mi, "SwapTotal"), sf = memInfo(mi, "SwapFree");
  return {
    ...base, cpuTemp: t0 ? round(+t0 / 1000, 1) : null, gpuTemp: null,
    ramUsedGB: total != null && avail != null ? round(total - avail) : null,
    swapGB: st != null && sf != null ? round(st - sf, 1) : null,
  };
}

async function collectDns() {
  const I = config.integrations;
  if (!I.unbound && !I.adguard) return null;
  const ub = I.unbound ? await run(["unbound-control", "stats_noreset"], 5_000) : { out: "" };
  const kv = Object.fromEntries(ub.out.split("\n").filter((l) => l.includes("=")).map((l) => l.split("=", 2)));
  const q = +kv["total.num.queries"] || 0, hits = +kv["total.num.cachehits"] || 0;
  let adguard: { queries: number; blocked: number; clients: number } | null = null;
  if (I.adguard) try {
    const auth = btoa(`${ENV[I.adguard.userEnv ?? "ADGUARD_USER"]}:${ENV[I.adguard.passwordEnv ?? "ADGUARD_PASSWORD"]}`);
    const r = await fetch(`${I.adguard.url.replace(/\/$/, "")}/control/stats`, { headers: { Authorization: "Basic " + auth }, signal: AbortSignal.timeout(4000) });
    if (r.ok) { const s = await r.json(); adguard = { queries: s.num_dns_queries ?? 0, blocked: s.num_blocked_filtering ?? 0, clients: (s.top_clients ?? []).length }; }
  } catch {}
  return { unboundHitRate: q ? Math.round(hits / q * 1000) / 10 : null, adguard };
}

async function collectHa() {
  const ha = config.integrations.homeAssistant;
  const token = ha ? ENV[ha.tokenEnv ?? "HA_TOKEN"] : undefined;
  if (!ha || !token) return null;
  // curl, not fetch: macOS Local Network privacy can block LAN access for some runtimes; curl is always allowed.
  const r = await run(["/usr/bin/curl", "-s", "--max-time", "6", "-H", "Authorization: Bearer " + token, `${ha.url.replace(/\/$/, "")}/api/states`], 10_000);
  let st: Array<{ entity_id: string; state: string; attributes: Record<string, unknown> }>;
  try { st = JSON.parse(r.out); if (!Array.isArray(st)) throw 0; } catch { return { online: false }; }
  const by = (d: string) => st.filter((s) => s.entity_id.startsWith(d + "."));
  const people = by("person"), lights = by("light"), switches = by("switch").filter((s) => s.state === "on" || s.state === "off");
  const w = st.find((s) => s.entity_id.startsWith("weather."));
  return {
    online: true, peopleHome: people.filter((p) => p.state === "home").length, people: people.length,
    lightsOn: lights.filter((l) => l.state === "on").length, lights: lights.length,
    switchesOn: switches.filter((s) => s.state === "on").length, switches: switches.length,
    weather: w ? { state: w.state, temp: w.attributes.temperature ?? null } : null,
  };
}

const SPEED_DB = join(HOME, "docker/speedtest-tracker/config/database.sqlite");
export function collectSpeed(days = 7) {
  try {
    const db = new Database(SPEED_DB, { readonly: true });
    const rows = db.query("SELECT created_at, ping, download, upload FROM results WHERE status='completed' AND created_at >= datetime('now', ?) ORDER BY created_at")
      .all(`-${days} days`) as Array<{ created_at: string; ping: number; download: number; upload: number }>;
    db.close();
    const points = rows.map((r) => ({
      t: Math.floor(Date.parse(r.created_at.replace(" ", "T") + "Z") / 1000), ping: Math.round((r.ping ?? 0) * 10) / 10,
      down: Math.round((r.download ?? 0) * 8 / 1e6), up: Math.round((r.upload ?? 0) * 8 / 1e6), // bytes/s -> Mbps
    }));
    return { points, last: points.at(-1) ?? null };
  } catch { return { points: [], last: null }; }
}

/** Uptime Kuma: 24h uptime %, current status, last-up time per monitor (keyed by normalised name). */
async function collectUptime() {
  const sql = "SELECT m.name, ROUND(100.0*SUM(h.status=1)/COUNT(*),2), (SELECT status FROM heartbeat WHERE monitor_id=m.id ORDER BY id DESC LIMIT 1), (SELECT MAX(time) FROM heartbeat WHERE monitor_id=m.id AND status=1) FROM monitor m LEFT JOIN heartbeat h ON h.monitor_id=m.id AND h.time >= datetime('now','-1 day') WHERE m.active=1 GROUP BY m.id";
  const r = await run(["/usr/local/bin/docker", "exec", "uptime-kuma", "sqlite3", "-readonly", "-separator", "\t", "/app/data/kuma.db", sql], 15_000);
  if (r.code !== 0) return { available: false, monitors: {} };
  const monitors: Record<string, { name: string; pct: number | null; up: boolean; lastUp: number | null }> = {};
  for (const line of r.out.split("\n")) {
    const [name, pct, cur, lastUp] = line.split("\t");
    if (!name) continue;
    monitors[norm(name)] = { name, pct: pct ? +pct : null, up: cur === "1", lastUp: lastUp ? Math.floor(Date.parse(lastUp.slice(0, 19).replace(" ", "T") + "Z") / 1000) : null };
  }
  return { available: true, monitors };
}
export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

let getRaw: () => { t: number[] } & Record<string, (number | null)[]> = () => ({ t: [] });
export function startSystemCollectors() {
  // Vitals every 3 s; a 2-hour history (one sample / 15 s) for the trend charts.
  const HIST_FILE = join(STATE_DIR, "server-os-history.json"); // survives restarts
  let hist = { t: [] as number[], cpu: [] as (number | null)[], ram: [] as (number | null)[], swap: [] as (number | null)[], load: [] as (number | null)[], disk: [] as (number | null)[] };
  try { const h = JSON.parse(readFileSync(HIST_FILE, "utf8")); if (Array.isArray(h.t)) hist = { ...hist, ...h }; setSlice("sysHistory", hist); } catch {}
  let lastSample = 0, lastHistWrite = 0;
  getRaw = () => hist;
  every(3_000, async () => {
    const s = await collectSystem();
    setSlice("system", s);
    const now = Math.floor(Date.now() / 1000);
    if (now - lastSample < 15) return;
    lastSample = now;
    hist.t.push(now); hist.cpu.push(s.cpuTemp); hist.ram.push(s.ramUsedGB); hist.swap.push(s.swapGB); hist.load.push(s.load1);
    hist.disk.push(s.internal ? Math.round((1 - s.internal.freeGB / s.internal.totalGB) * 1000) / 10 : null);
    if (hist.t.length > 480) for (const k of Object.keys(hist) as (keyof typeof hist)[]) hist[k].shift();
    setSlice("sysHistory", hist);
    if (now - lastHistWrite >= 300) { lastHistWrite = now; writeFile(HIST_FILE, JSON.stringify(hist)).catch(() => {}); } // throttled: SSD-friendly
    rollup(now, { cpu: s.cpuTemp, ram: s.ramUsedGB, swap: s.swapGB, load: s.load1, disk: hist.disk.at(-1) ?? null });
  });
  every(15_000, async () => { setSlice("dns", await collectDns()); });
  every(30_000, async () => { setSlice("ha", await collectHa()); });
  every(120_000, () => { setSlice("speed", collectSpeed()); });
  every(60_000, async () => { setSlice("uptime", await collectUptime()); });
}

// ---------- long-term history: 5-min averages (7 days) and hourly averages (90 days), persisted ----------
type Metric = "cpu" | "ram" | "swap" | "load" | "disk";
interface Agg { t: number; n: number; sum: Record<Metric, number>; cnt: Record<Metric, number> }
const LONG_FILE = join(STATE_DIR, "server-os-history-long.json");
const TIERS = { m5: { sec: 300, keep: 7 * 86400 }, h1: { sec: 3600, keep: 90 * 86400 } } as const;
let long: Record<keyof typeof TIERS, { t: number; v: Record<Metric, number | null> }[]> = { m5: [], h1: [] };
try { long = { ...long, ...JSON.parse(readFileSync(LONG_FILE, "utf8")) }; } catch {}
const open: Partial<Record<keyof typeof TIERS, Agg>> = {};
let lastLongWrite = 0;
const METRICS: Metric[] = ["cpu", "ram", "swap", "load", "disk"];
function rollup(now: number, sample: Record<Metric, number | null>) {
  for (const k of Object.keys(TIERS) as (keyof typeof TIERS)[]) {
    const start = Math.floor(now / TIERS[k].sec) * TIERS[k].sec;
    let a = open[k];
    if (a && a.t !== start) { // bucket closed: store its averages
      long[k].push({ t: a.t, v: Object.fromEntries(METRICS.map((m) => [m, a!.cnt[m] ? Math.round((a!.sum[m] / a!.cnt[m]) * 100) / 100 : null])) as Record<Metric, number | null> });
      while (long[k].length && long[k][0].t < now - TIERS[k].keep) long[k].shift();
      a = undefined;
    }
    if (!a) a = open[k] = { t: start, n: 0, sum: { cpu: 0, ram: 0, swap: 0, load: 0, disk: 0 }, cnt: { cpu: 0, ram: 0, swap: 0, load: 0, disk: 0 } };
    a.n++;
    for (const m of METRICS) { const v = sample[m]; if (v != null) { a.sum[m] += v; a.cnt[m]++; } }
  }
  if (now - lastLongWrite > 300) { lastLongWrite = now; writeFile(LONG_FILE, JSON.stringify(long)).catch(() => {}); }
}

export const RANGES = { "1h": 3600, "2h": 7200, "6h": 6 * 3600, "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400, "90d": 90 * 86400 } as const;
export type Range = keyof typeof RANGES;
/** Native resolution of each source, in seconds — the smallest step a query may use (Grafana's "min interval"). */
const RES = { raw: 15, m5: 300, h1: 3600, net: 3600 };

/**
 * Prometheus/Grafana-style range query: fixed `step` buckets aligned to the step, each with avg/min/max of
 * the samples that fall in it, and `null` where none did (the client breaks the line there; it never guesses).
 * step = max(range / points, native resolution of the coarsest source in the window).
 */
export function historyRange(metric: string, range: Range, points: number) {
  const now = Math.floor(Date.now() / 1000), span = RANGES[range];
  const src = history(metric, range);
  const coarsest = metric === "net" ? RES.net : span <= 2 * 3600 ? RES.raw : span <= 7 * 86400 ? RES.m5 : RES.h1;
  const step = Math.max(coarsest, Math.ceil(span / Math.max(10, Math.min(points, 1000))));
  const start = Math.floor((now - span) / step) * step;
  const n = Math.ceil((now - start) / step);
  const sum = new Array(n).fill(0), cnt = new Array(n).fill(0), lo = new Array(n).fill(Infinity), hi = new Array(n).fill(-Infinity);
  src.t.forEach((t, i) => {
    const v = src.v[i]; if (v == null || t < start) return;
    const k = Math.min(n - 1, Math.floor((t - start) / step));
    sum[k] += v; cnt[k]++; lo[k] = Math.min(lo[k], v); hi[k] = Math.max(hi[k], v);
  });
  const r = (x: number) => Math.round(x * 100) / 100;
  return {
    step, start, since: src.since,
    t: Array.from({ length: n }, (_, k) => start + k * step),
    avg: cnt.map((c, k) => (c ? r(sum[k] / c) : null)),
    min: cnt.map((c, k) => (c ? r(lo[k]) : null)),
    max: cnt.map((c, k) => (c ? r(hi[k]) : null)),
  };
}

export function history(metric: string, range: Range): { t: number[]; v: (number | null)[]; since: number | null } {
  const now = Math.floor(Date.now() / 1000), from = now - RANGES[range];
  if (DEMO) { const d = demoHistory(metric, RANGES[range], Math.max(15, Math.ceil(RANGES[range] / 600))); return { ...d, since: d.t[0] ?? null }; }
  if (metric === "net") {
    const pts = collectSpeed(Math.ceil(RANGES[range] / 86400)).points.filter((p) => p.t >= from);
    return { t: pts.map((p) => p.t), v: pts.map((p) => p.down), since: pts[0]?.t ?? null };
  }
  if (!METRICS.includes(metric as Metric)) return { t: [], v: [], since: null };
  const m = metric as Metric;
  // older part from the long-term tier, newest part from the raw 15-s samples (so short ranges and fresh installs still have data)
  const tier = RANGES[range] <= 7 * 86400 ? "m5" : "h1";
  const raw = getRaw() as unknown as { t: number[] } & Record<Metric, (number | null)[]>;
  const rawStart = raw.t[0] ?? now;
  const rows = long[tier].filter((b) => b.t >= from && b.t < rawStart);
  const t: number[] = rows.map((b) => b.t), v: (number | null)[] = rows.map((b) => b.v[m]);
  raw.t.forEach((x, i) => { if (x >= from) { t.push(x); v.push(raw[m][i]); } });
  return { t, v, since: t[0] ?? null };
}
