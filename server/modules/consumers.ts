// Who uses the Mac's memory and CPU, sampled every 15 s and grouped by app, so the Overview chart can say what
// caused a jump ("Swap +0.5 GB: Xcode +1.8 GB, Claude Code +0.6 GB") and show the app's logo on it.
//
// Groups: a Server OS app (its launchd process tree, its Docker containers, its VM), else the macOS app bundle a
// process lives in ("Xcode", "Google Chrome"), else the Claude Code CLI, else the program's own name. Memory is
// the footprint `top` reports (what Activity Monitor shows, compressed pages included); CPU is `ps` %CPU.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { dir } from "../core/config";
import { loadCatalog } from "../apps";
import { run } from "../lib";
import { getSlice, setSlice } from "../store";

export interface Group { name: string; mb: number; cpu: number; app?: string; icon?: string }
export interface Sample { t: number; groups: Group[] }
export interface Cause { name: string; app?: string; icon?: string; delta: number; now: number }
export interface Event { t: number; value: number; delta: number; causes: Cause[] }

const KEEP = 6 * 3600, TOP = 14;
const file = () => join(dir("data"), "consumers.json");
let samples: Sample[] = [];
try { samples = JSON.parse(readFileSync(file(), "utf8")); } catch { /* first run */ }

/** "12M" / "1.2G" / "640K" (top's MEM column) → MB. */
export function parseMem(s: string): number {
  const m = /^([\d.]+)([KMGB])?\+?-?$/.exec(s.trim());
  if (!m) return 0;
  const n = Number(m[1]);
  return m[2] === "G" ? n * 1024 : m[2] === "K" ? n / 1024 : m[2] === "B" ? n / 1048576 : n;
}

/** The outermost macOS .app bundle in a path: ".../Xcode.app/Contents/Developer/.../xcodebuild" → "Xcode". */
export function bundleOf(path: string): string | null {
  const m = /\/([^/]+)\.app\//.exec(path + "/");
  return m ? m[1] : null;
}

interface Proc { pid: number; ppid: number; cpu: number; path: string; args: string }
const vmOwner = new Map<number, string>(); // VM process pid → "Docker" / "HomeAssistant.utm" (looked up once per pid)

async function whichVm(pid: number): Promise<string> {
  if (vmOwner.has(pid)) return vmOwner.get(pid)!;
  const r = await run(["lsof", "-p", String(pid), "-Fn"], 5_000);
  const utm = /\/([^/]+\.utm)\//.exec(r.out)?.[1];
  const name = utm ?? (/Docker|docker/.test(r.out) ? "Docker" : "Virtual machine");
  vmOwner.set(pid, name);
  return name;
}

/** Name a process: the first rule that fits, walking up from it to its ancestors. */
function classify(p: Proc, byPid: Map<number, Proc>, appOf: Map<number, string>): { name: string; app?: string } {
  for (let q: Proc | undefined = p, hops = 0; q && q.pid > 1 && hops < 30; q = byPid.get(q.ppid), hops++) {
    const a = appOf.get(q.pid);
    if (a) return { name: a, app: a };
    if (/\/claude\/versions\/|^claude(\s|$)/.test(q.path + " ") || /^claude(\s|$)/.test(q.args)) return { name: "Claude Code" };
    const b = bundleOf(q.path);
    if (b && !/^com\.apple\./.test(b)) return { name: b.replace(/ Helper.*$/, "") };
  }
  // macOS's own services (WindowServer, VTEncoderXPCService, mds…) are one group: nothing to act on one by one.
  if (/^\/(System|usr\/libexec|usr\/sbin|sbin)\//.test(p.path) || /^com\.apple\./.test(basename(p.path))) return { name: "macOS" };
  const b = bundleOf(p.path);
  return { name: b ?? basename(p.path.split(" ")[0]) };
}

async function sample(): Promise<Sample | null> {
  const [ps, top] = await Promise.all([
    run(["ps", "-axo", "pid=,ppid=,%cpu=,comm="], 8_000),
    run(["top", "-l", "1", "-o", "mem", "-n", "60", "-stats", "pid,mem"], 8_000),
  ]);
  if (ps.code !== 0) return null;
  const procs = new Map<number, Proc>();
  for (const l of ps.out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(l);
    if (m) procs.set(+m[1], { pid: +m[1], ppid: +m[2], cpu: +m[3], path: m[4], args: m[4] });
  }
  const mem = new Map<number, number>();
  for (const l of top.out.split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)\s*$/.exec(l);
    if (m) mem.set(+m[1], parseMem(m[2]));
  }
  // Server OS apps: each launchd app's process tree carries its name (from the apps slice's catalog).
  const appOf = new Map<number, string>();
  const launchd = await run(["launchctl", "list"], 8_000);
  const labelPid = new Map<string, number>();
  for (const line of launchd.out.split("\n").slice(1)) { const [pid, , label] = line.split("\t"); if (/^\d+$/.test(pid)) labelPid.set(label, +pid); }
  const catalog = (getSlice<Record<string, { name: string; icon?: string }>>("apps")) ?? {};
  const icons = new Map(Object.values(catalog).map((a) => [a.name, a.icon]));
  for (const [name, labels] of catalogLaunchd()) for (const l of labels) { const pid = labelPid.get(l); if (pid) appOf.set(pid, name); }

  const groups = new Map<string, Group>();
  const add = (name: string, app: string | undefined, mb: number, cpu: number) => {
    const g = groups.get(name) ?? { name, mb: 0, cpu: 0, ...(app ? { app } : {}) };
    g.mb += mb; g.cpu += cpu; groups.set(name, g);
  };
  for (const p of procs.values()) {
    const mb = mem.get(p.pid) ?? 0;
    if (mb < 1 && p.cpu < 0.5) continue;
    if (/com\.apple\.Virtualization\.VirtualMachine$/.test(p.path)) {
      const vm = await whichVm(p.pid);
      const app = vm.endsWith(".utm") ? catalogVm(vm) : undefined;
      add(app ?? vm, app, mb, p.cpu);
      continue;
    }
    const c = classify(p, procs, appOf);
    add(c.name, c.app, mb, p.cpu);
  }
  // The Docker VM is one process; split it into its apps (each container's memory, from the apps slice) + the VM itself (its reserved memory).
  const docker = groups.get("Docker");
  if (docker) {
    const apps = Object.values(getSlice<Record<string, { name: string; icon?: string; mem: number; parts?: Record<string, boolean> }>>("apps") ?? {});
    for (const a of apps) {
      const parts = Object.keys(a.parts ?? {});
      if (!a.mem || !parts.length || !parts.every((k) => k.startsWith("docker:"))) continue;
      add(a.name, a.name, a.mem, 0);
      docker.mb = Math.max(0, docker.mb - a.mem);
    }
    groups.delete("Docker");
    groups.set("Docker VM", { ...docker, name: "Docker VM" });
  }
  const top14 = [...groups.values()].filter((g) => g.mb >= 20 || g.cpu >= 5)
    .sort((a, b) => b.mb - a.mb).slice(0, TOP)
    .map((g) => ({ ...g, mb: Math.round(g.mb), cpu: Math.round(g.cpu * 10) / 10, ...(g.app && icons.get(g.app) ? { icon: icons.get(g.app) } : {}) }));
  // Busy-but-small programs (a compile, a scan) matter for load: keep the top CPU users too.
  for (const g of [...groups.values()].sort((a, b) => b.cpu - a.cpu).slice(0, 5)) {
    if (g.cpu >= 10 && !top14.some((x) => x.name === g.name)) top14.push({ ...g, mb: Math.round(g.mb), cpu: Math.round(g.cpu * 10) / 10 });
  }
  for (const g of top14) if (!g.icon && !g.app) { const i = procIcon(g.name === "Docker VM" ? "Docker" : g.name); if (i) g.icon = i; }
  return { t: Math.floor(Date.now() / 1000), groups: top14 };
}

// ---------- the catalog's launchd labels and VMs (svc-control/catalog.json) ----------
function catalogLaunchd(): [string, string[]][] {
  return loadCatalog().flatMap((g) => g.items.filter((it) => it.launchd?.length).map((it) => [it.name, it.launchd!] as [string, string[]]));
}
function catalogVm(utm: string): string | undefined {
  for (const g of loadCatalog()) for (const it of g.items) if (it.utm && utm.startsWith(it.utm)) return it.name;
  return undefined;
}

// ---------- macOS app icons for groups that aren't Server OS apps ----------
const iconDir = () => join(dir("data"), "icons", "proc");
const iconTried = new Set<string>();
/** A PNG of a macOS app's icon (made once from its .icns with `sips`), or undefined until it exists. */
function procIcon(name: string): string | undefined {
  const safe = name.replace(/[^A-Za-z0-9 ._-]/g, "");
  const out = join(iconDir(), `${safe}.png`);
  if (existsSync(out)) return `/icons/installed/proc/${encodeURIComponent(safe)}.png`; // served by the /icons/installed route
  if (iconTried.has(safe)) return undefined;
  iconTried.add(safe);
  const bundle = [`/Applications/${safe}.app`, `/System/Applications/${safe}.app`, `/Applications/Utilities/${safe}.app`].find(existsSync)
    ?? (safe === "Claude Code" && existsSync("/Applications/Claude.app") ? "/Applications/Claude.app" : undefined)
    ?? (safe === "macOS" ? "/System/Applications/System Settings.app" : undefined);
  if (!bundle) return undefined;
  void (async () => {
    const plist = await run(["defaults", "read", join(bundle, "Contents/Info"), "CFBundleIconFile"], 3_000);
    let icns = plist.out.trim();
    if (!icns) return;
    if (!icns.endsWith(".icns")) icns += ".icns";
    mkdirSync(iconDir(), { recursive: true });
    await run(["sips", "-s", "format", "png", "-Z", "128", join(bundle, "Contents/Resources", icns), "--out", out], 10_000);
  })();
  return undefined;
}

// ---------- jumps and their causes ----------
const RULES: Record<string, { rise: number; floor?: number; by: "mb" | "cpu" }> = {
  ram: { rise: 1.0, by: "mb" },        // GB
  swap: { rise: 0.3, by: "mb" },       // GB
  load: { rise: 3, floor: 5, by: "cpu" },
  cpu: { rise: 10, floor: 60, by: "cpu" }, // °C
};

/**
 * Jumps in a metric's 15-s series (a rise of `rise` within ~2 minutes, peak kept), each with the groups that grew
 * most across it (memory metrics: footprint growth; load and temperature: CPU use at the peak).
 */
export function findEvents(metric: string, series: { t: number[]; v: (number | null)[] }, from: number): Event[] {
  const rule = RULES[metric];
  if (!rule) return [];
  const events: Event[] = [];
  const { t, v } = series;
  for (let i = 1; i < t.length; i++) {
    const cur = v[i];
    if (cur == null || t[i] < from) continue;
    let lo = Infinity;
    for (let j = i - 1; j >= 0 && t[i] - t[j] <= 150; j--) if (v[j] != null) lo = Math.min(lo, v[j]!);
    if (!isFinite(lo) || cur - lo < rule.rise || (rule.floor != null && cur < rule.floor)) continue;
    const last = events.at(-1);
    if (last && t[i] - last.t < 600) { if (cur > last.value) { last.t = t[i]; last.value = cur; last.delta = Math.max(last.delta, cur - lo); } continue; }
    events.push({ t: t[i], value: cur, delta: cur - lo, causes: [] });
  }
  // The few that matter: the 6 biggest in the window, in time order.
  const kept = events.sort((a, b) => b.delta - a.delta).slice(0, 6).sort((a, b) => a.t - b.t);
  for (const e of kept) e.causes = causesAt(e.t, rule.by, rule.by === "mb" ? e.delta * 1024 : 0);
  return kept.map((e) => ({ ...e, value: Math.round(e.value * 100) / 100, delta: Math.round(e.delta * 100) / 100 }));
}

const nearest = (t: number) => samples.reduce<Sample | null>((best, s) => (!best || Math.abs(s.t - t) < Math.abs(best.t - t) ? s : best), null);

/** The groups behind a jump: for memory, each must explain at least a fifth of the rise (`riseMB`). */
export function causesAt(t: number, by: "mb" | "cpu", riseMB = 0): Cause[] {
  const at = nearest(t), before = nearest(t - 180);
  if (!at || Math.abs(at.t - t) > 60) return [];
  const prev = new Map((before && before.t < at.t ? before.groups : []).map((g) => [g.name, g]));
  const rows = at.groups.map((g) => ({
    name: g.name, ...(g.app ? { app: g.app } : {}), ...(g.icon ? { icon: g.icon } : {}),
    delta: by === "mb" ? g.mb - (prev.get(g.name)?.mb ?? 0) : g.cpu,
    now: by === "mb" ? g.mb : g.cpu,
  }));
  return rows.filter((r) => (by === "mb" ? r.delta >= Math.max(100, riseMB * 0.2) : r.delta >= 15)).sort((a, b) => b.delta - a.delta).slice(0, 3);
}

export function startConsumerCollector(every: (ms: number, fn: () => Promise<void> | void) => void) {
  let lastWrite = 0;
  every(15_000, async () => {
    const s = await sample().catch(() => null);
    if (!s) return;
    samples.push(s);
    while (samples.length && samples[0].t < s.t - KEEP) samples.shift();
    setSlice("consumers", s);
    if (s.t - lastWrite > 300) { lastWrite = s.t; try { mkdirSync(dir("data"), { recursive: true }); writeFileSync(file(), JSON.stringify(samples)); } catch { /* a nicety */ } }
  });
}
