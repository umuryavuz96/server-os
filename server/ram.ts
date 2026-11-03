// The "ram" slice: everything the Ram tab shows. Read-only. Pure numbers, never process arguments (secrets live on command lines).
// apps.ts hands over its process snapshot after every computeApps(); macOS memory counters come from vm_stat / sysctl (no sudo).
import { totalmem } from "node:os";
import type { Hono } from "hono";
import type { Env } from "./core/http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME, run, every } from "./lib";
import { dir } from "./core/config";
import { dockerApi } from "./docker";
import { getSlice, setSlice } from "./store";
import { agentByPid, liveSessions, type LiveSession } from "./agmsgNet";
import { resolveProcs, claudeApp, pruneCwds, type AppRef, type ResolveCtx } from "./ramApps";

/** Name a process for grouping: the .app bundle it belongs to, else its binary name. Never includes arguments. */
export function groupName(cmd: string) {
  // iOS Simulator runtimes live under a path with spaces ("iOS 27.1.simruntime"): every simulated process is one group.
  if (cmd.includes(".simruntime/") || cmd.includes("/CoreSimulator/") || cmd.includes("/CoreSimulator.framework/")) return "iOS Simulator";
  const app = cmd.match(/\/([^/]+)\.app\//)?.[1];
  if (app) return app;
  // comm can be argv[0] with arguments (npm exec … --api-key …): keep only the binary name, never the args.
  return (cmd.split(" ")[0].split("/").pop() || "?").slice(0, 40);
}

/** The program name of a process, never arguments. Simulator paths contain spaces, so they keep their last path part. */
export function binName(cmd: string) {
  const b = cmd.includes(".simruntime/") || cmd.includes("/CoreSimulator") ? cmd.split("/").pop() : cmd.split(" ")[0].split("/").pop();
  return (b || "?").replace(/^\((.*)\)$/, "$1").slice(0, 40);
}

/** ps etime ("1-02:03:04", "02:03:04", "03:04") -> seconds. */
export function parseEtime(s: string): number {
  const m = s.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return 0;
  return (+(m[1] ?? 0)) * 86400 + (+(m[2] ?? 0)) * 3600 + (+m[3]) * 60 + +m[4];
}

export interface MemCounters { pageSize: number; free: number; speculative: number; wired: number; compressor: number; anonymous: number; fileBacked: number; purgeable: number }
/** vm_stat text -> byte counters. Activity Monitor: App = anonymous - purgeable, Cached = file-backed + purgeable, Compressed = compressor, Used = App + Wired + Compressed. */
export function parseVmStat(txt: string): MemCounters | null {
  const page = Number(txt.match(/page size of (\d+) bytes/)?.[1]);
  if (!page) return null;
  const n = (label: string) => Number(txt.match(new RegExp(`^${label}:\\s+(\\d+)\\.`, "m"))?.[1] ?? 0) * page;
  return {
    pageSize: page, free: n("Pages free"), speculative: n("Pages speculative"), wired: n("Pages wired down"),
    compressor: n("Pages occupied by compressor"), anonymous: n("Anonymous pages"), fileBacked: n("File-backed pages"), purgeable: n("Pages purgeable"),
  };
}
/** sysctl vm.swapusage -> MB. */
export function parseSwap(txt: string): { totalMB: number; usedMB: number } {
  const g = (k: string) => Number(txt.match(new RegExp(`${k} = ([\\d.]+)M`))?.[1] ?? 0);
  return { totalMB: Math.round(g("total")), usedMB: Math.round(g("used")) };
}

const MB = 1048576;
export interface RamOverview {
  totalMB: number; usedMB: number | null; pressure: "normal" | "warn" | "critical" | "unknown"; swapUsedMB: number; swapTotalMB: number;
  compressedMB: number; wiredMB: number; appMB: number; cachedMB: number; freeMB: number;
}
let overview: RamOverview = { totalMB: Math.round(totalmem() / MB), usedMB: null, pressure: "unknown", swapUsedMB: 0, swapTotalMB: 0, compressedMB: 0, wiredMB: 0, appMB: 0, cachedMB: 0, freeMB: 0 };
async function refreshOverview() {
  if (process.platform !== "darwin") return;
  const [vm, sw, pr] = await Promise.all([run(["vm_stat"], 5_000), run(["sysctl", "-n", "vm.swapusage"], 3_000), run(["sysctl", "-n", "kern.memorystatus_vm_pressure_level"], 3_000)]);
  const c = parseVmStat(vm.out); if (!c) return;
  const s = parseSwap(sw.out), mb = (b: number) => Math.round(b / MB);
  const lvl = Number(pr.out.trim());
  overview = {
    ...overview, pressure: lvl === 1 ? "normal" : lvl === 2 ? "warn" : lvl === 4 ? "critical" : "unknown",
    swapUsedMB: s.usedMB, swapTotalMB: s.totalMB, compressedMB: mb(c.compressor), wiredMB: mb(c.wired),
    appMB: mb(Math.max(0, c.anonymous - c.purgeable)), cachedMB: mb(c.fileBacked + c.purgeable), freeMB: mb(c.free),
  };
}

// ---- per-process footprint (Activity Monitor's "Memory"): RSS counts shared pages once per process, which made
// 190 iOS Simulator processes look like 12 GB. One `top` call (no sudo, ~0.4 s) every 15 s gives phys_footprint for every pid.
/** top -l 1 -stats pid,mem -> pid -> KB ("7472K", "278M", "1.2G", "512B", with an optional +/- trend mark). */
export function parseTopMem(txt: string): Map<number, number> {
  const m = new Map<number, number>();
  for (const l of txt.split("\n")) {
    const r = l.match(/^\s*(\d+)\*?\s+([\d.]+)([BKMG])[+-]?\s*$/);
    if (!r) continue;
    const v = Number(r[2]), u = r[3];
    m.set(Number(r[1]), u === "G" ? v * 1048576 : u === "M" ? v * 1024 : u === "K" ? v : v / 1024);
  }
  return m;
}
let foot = new Map<number, number>();
async function refreshFootprint() {
  if (process.platform !== "darwin") return;
  const r = await run(["top", "-l", "1", "-stats", "pid,mem", "-n", "5000"], 10_000);
  const m = parseTopMem(r.out); if (m.size > 10) foot = m;
}
/** Live pids keep their RSS when top has not seen them yet (started in the last 15 s). */
export const withFootprint = (rss: Map<number, number>, f: Map<number, number>) => new Map([...rss].map(([p, kb]) => [p, kb ? f.get(p) ?? kb : 0]));

// ---- movers: a ring of one sample per minute for every group ----
type Kind = "app" | "claude" | "process" | "vm";
const RING_MAX = 61;
let ring: { t: number; m: Map<string, number> }[] = [];
export const resetRing = () => { ring = []; };
const BOOT_SEC = Math.floor(Date.now() / 1000);
/** Collectors (VM footprint, container memory) need ~20 s to fill after a start: samples before that would make every VM look new. */
const WARMUP_SEC = 60;
export function trackMovers(items: { kind: Kind; name: string; mb: number }[], nowSec: number, warmupUntil = 0) {
  if (nowSec < warmupUntil) return { spanMin: 0, up: [] as Mover[], down: [] as Mover[] };
  const m = new Map<string, number>();
  for (const i of items) if (i.mb >= 5) m.set(i.kind + "\t" + i.name, i.mb);
  if (!ring.length || nowSec - ring.at(-1)!.t >= 60) { ring.push({ t: nowSec, m }); if (ring.length > RING_MAX) ring.shift(); }
  const first = ring[0], spanMin = Math.round((nowSec - first.t) / 60);
  const up: Mover[] = [], down: Mover[] = [];
  if (spanMin >= 2) for (const k of new Set([...m.keys(), ...first.m.keys()])) {
    const now = m.get(k) ?? 0, before = first.m.get(k) ?? 0, d = now - before;
    if (Math.abs(d) < 20) continue;
    const [kind, name] = k.split("\t");
    (d > 0 ? up : down).push({ kind: kind as Kind, name, nowMB: now, beforeMB: before, deltaMB: d, isNew: before === 0, gone: now === 0 });
  }
  up.sort((a, b) => b.deltaMB - a.deltaMB); down.sort((a, b) => a.deltaMB - b.deltaMB);
  return { spanMin, up: up.slice(0, 8), down: down.slice(0, 5) };
}
export interface Mover { kind: Kind; name: string; nowMB: number; beforeMB: number; deltaMB: number; isNew: boolean; gone: boolean }

// ---- VM configured size (UTM plist, Docker /info), refreshed rarely ----
const cfgMB = new Map<string, number>();
let cfgAt = 0;
async function refreshVmConfig(names: string[], dockerRunning: boolean) {
  if (!names.length && !dockerRunning) return; // nothing to ask yet: do not burn the throttle window
  if (Date.now() - cfgAt < 60_000) return;
  cfgAt = Date.now();
  for (const n of names) {
    const plist = `${HOME}/Library/Containers/com.utmapp.UTM/Data/Documents/${n}.utm/config.plist`;
    const mb = parseInt((await run(["/usr/bin/plutil", "-extract", "System.MemorySize", "raw", plist], 5_000)).out, 10);
    if (mb > 0) cfgMB.set(n, mb);
  }
  if (dockerRunning) { const i = await dockerApi<{ MemTotal?: number }>("/info", {}, 5_000); if (i?.MemTotal) cfgMB.set("Docker", Math.round(i.MemTotal / MB)); }
}


// ---- app icons: bundle icon -> 64 px png, resolved once per bundle (never per poll), only for names seen in the process list ----
const bundles = new Map<string, string>(); // group name -> /path/Foo.app
const iconState = new Map<string, "yes" | "no">();
const iconQueue = new Set<string>();
const iconDir = () => { const d = join(dir("data"), "ram-icons"); mkdirSync(d, { recursive: true }); return d; };
const iconFile = (name: string) => join(iconDir(), Buffer.from(name).toString("hex") + ".png");
export const iconOk = (name: string) => iconState.get(name) === "yes";
export function noteBundles(comms: Map<number, string>) {
  for (const cmd of comms.values()) {
    const m = cmd.match(/^(.*?\/([^/]+)\.app)\//);
    if (m && !bundles.has(m[2])) bundles.set(m[2], m[1]);
  }
}
async function resolveIcon(name: string) {
  const app = bundles.get(name); if (!app) return iconState.set(name, "no");
  const out = iconFile(name);
  if (existsSync(out)) return iconState.set(name, "yes");
  const plist = join(app, "Contents/Info.plist");
  for (const key of ["CFBundleIconFile", "CFBundleIconName"]) {
    let f = (await run(["/usr/bin/plutil", "-extract", key, "raw", plist], 5_000)).out.trim();
    if (!f || /[\n/]/.test(f)) continue;
    if (!f.endsWith(".icns")) f += ".icns";
    const icns = join(app, "Contents/Resources", f);
    if (!existsSync(icns)) continue;
    if ((await run(["/usr/bin/sips", "-s", "format", "png", "-Z", "64", icns, "--out", out], 10_000)).code === 0 && existsSync(out)) return iconState.set(name, "yes");
  }
  iconState.set(name, "no");
}
let iconBusy = false;
async function drainIcons() {
  if (iconBusy) return; iconBusy = true;
  try { for (const n of iconQueue) { iconQueue.delete(n); await resolveIcon(n); } } finally { iconBusy = false; }
}
export function wantIcons(names: string[]) {
  for (const n of names) if (!iconState.has(n) && bundles.has(n)) iconQueue.add(n);
  if (iconQueue.size) void drainIcons();
}

// ---- the snapshot ----
export interface RamInput {
  rss: Map<number, number>; kids: Map<number, number[]>; comms: Map<number, string>; etimes: Map<number, number>;
  /** pids already counted by a panel app or VM */
  claimed: Set<number>;
  /** pid -> panel app that counted it (to expand an app into its processes) */
  claimBy?: Map<number, string>;
  vmMem: Map<string, number>; dockerVm: { pid: number; mb: number }; containerMem: Map<string, number>; containerApp: Map<string, string>;
  apps: { name: string; group: string; mem: number; memSrc: string; state: string }[];
  sessions: LiveSession[]; agentByPid: Map<number, string>; nowSec: number;
  /** how to name bare processes after the app they belong to (omitted = group by binary only) */
  resolve?: ResolveCtx;
}
export interface ProcRow { pid: number; mb: number; upSec: number; bin?: string }
/** src = the app's logo url when the group was resolved to an app (name is then the app name, bins the programs behind it) */
export interface GroupRow { name: string; mb: number; n: number; icon?: boolean; src?: string | null; app?: boolean; bins?: string[]; procs: ProcRow[] }
export interface ClaudeRow { pid: number; name: string; agent: string | null; tmux: string | null; cwd: string; status: string; mb: number; n: number; startedAt: number; src?: string | null }
export interface VmRow { name: string; kind: "utm" | "docker"; running: boolean; configuredMB: number | null; footprintMB: number; items: { name: string; mb: number; app: string | null }[]; overheadMB: number }

const PROC_CAP = 20;

/** Programs that ship with macOS (by path). Grouped under one "macOS" row in the Ram list. */
const SYS_RE = /^\/(System|usr\/libexec|usr\/sbin|sbin|Library\/Apple)\//;
export const isSystem = (comm: string) => SYS_RE.test(comm) || comm === "kernel_task";

/**
 * The Ram tab's main list: every running thing that holds RAM as exactly one row, biggest first.
 * Bundles expand (kids): Docker -> containers, Claude Code -> sessions, an app -> its processes, macOS -> wired + system programs.
 * Nothing is counted twice: containers live only under Docker, claimed pids only under their panel app.
 */
export interface ListKid { key: string; name: string; mb: number; sub?: string; app?: string | null; src?: string | null; icon?: boolean }
export interface ListRow {
  key: string; name: string; kind: "vm" | "docker" | "panel" | "claude" | "app" | "proc" | "macos" | "small";
  mb: number; n: number; sub?: string; src?: string | null; icon?: boolean; href?: string; kids: ListKid[]; more?: { n: number; mb: number };
}
const LIST_ROWS = 40, KID_CAP = 25;
let shownRows = new Set<string>();
function cap(kids: ListKid[]): Pick<ListRow, "kids" | "more"> {
  kids.sort((a, b) => b.mb - a.mb);
  if (kids.length <= KID_CAP) return { kids };
  const rest = kids.slice(KID_CAP);
  return { kids: kids.slice(0, KID_CAP), more: { n: rest.length, mb: Math.round(rest.reduce((t, k) => t + k.mb, 0)) } };
}
const procKids = (procs: ProcRow[], fallback: string): ListKid[] => procs.map((p) => ({ key: "p" + p.pid, name: p.bin ?? fallback, mb: p.mb, sub: "pid " + p.pid }));
const squashN = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
export function buildList(inp: RamInput, ov: RamOverview, vms: VmRow[], apps: { name: string; mb: number; src: string; state: string }[], claude: ClaudeRow[], groups: GroupRow[], sysNames: Set<string>): ListRow[] {
  const rows: ListRow[] = [];
  // Docker Desktop's own Mac processes belong to the Docker row too (one row per thing).
  const dockerHost = new Set<string>();
  for (const v of vms) {
    if (v.kind === "docker") {
      const kids: ListKid[] = v.items.map((c) => ({ key: "c:" + c.name, name: c.app ?? c.name, mb: c.mb, sub: c.app ? c.name : "not in panel", app: c.app }));
      if (v.overheadMB) kids.push({ key: "c:-vm", name: "Docker VM itself", mb: v.overheadMB, sub: "Linux kernel and page cache" });
      let hostMB = 0;
      for (const x of groups) if ((x.name === "Docker" || x.name === "docker" || x.name.startsWith("com.docker.")) && !sysNames.has(x.name)) {
        dockerHost.add(x.name); hostMB += x.mb;
        kids.push({ key: "h:" + x.name, name: x.name === "Docker" ? "Docker Desktop" : x.name, mb: x.mb, sub: `on the Mac · ${x.n} process${x.n === 1 ? "" : "es"}`, icon: x.icon });
      }
      rows.push({ key: "vm:Docker", name: "Docker", kind: "docker", mb: v.footprintMB + hostMB, n: v.items.length, sub: `${v.items.length} container${v.items.length === 1 ? "" : "s"}`, icon: true, ...cap(kids) });
    } else {
      const app = apps.find((a) => squashN(a.name) === squashN(v.name));
      rows.push({ key: "vm:" + v.name, name: app?.name ?? v.name, kind: "vm", mb: v.footprintMB, n: 0, sub: "Virtual machine", href: app ? "#apps?open=" + encodeURIComponent(app.name) : undefined, kids: [] });
    }
  }
  // Panel apps measured by their processes (VM / Docker ones are already inside the VM rows).
  const byApp = new Map<string, ProcRow[]>();
  for (const [pid, name] of inp.claimBy ?? []) {
    const kb = inp.rss.get(pid) ?? 0; if (!kb) continue;
    (byApp.get(name) ?? byApp.set(name, []).get(name)!).push({ pid, mb: Math.round(kb / 102.4) / 10, upSec: inp.etimes.get(pid) ?? 0, bin: binName(inp.comms.get(pid) ?? "?") });
  }
  for (const a of apps) if ((a.src === "process" || a.src === "port") && a.mb > 0) {
    const procs = byApp.get(a.name) ?? [];
    const pmb = procs.length ? Math.round(procs.reduce((t, x) => t + x.mb, 0)) : a.mb;
    rows.push({ key: "panel:" + a.name, name: a.name, kind: "panel", mb: pmb, n: procs.length, sub: procs.length ? `${procs.length} process${procs.length === 1 ? "" : "es"}` : undefined, href: "#apps?open=" + encodeURIComponent(a.name), ...cap(procs.length > 1 ? procKids(procs, a.name) : []) });
  }
  if (claude.length) {
    const kids: ListKid[] = claude.map((c) => ({ key: "cl:" + c.pid, name: c.name, mb: c.mb, sub: [c.agent, c.cwd].filter(Boolean).join(" · "), src: c.src ?? null }));
    rows.push({ key: "claude", name: "Claude Code", kind: "claude", mb: claude.reduce((t, c) => t + c.mb, 0), n: claude.length, sub: `${claude.length} session${claude.length === 1 ? "" : "s"}`, ...cap(kids) });
  }
  // macOS: wired memory plus every program that ships with the system.
  const sys = groups.filter((x) => sysNames.has(x.name));
  const sysKids: ListKid[] = [{ key: "wired", name: "Wired memory", mb: ov.wiredMB, sub: "kernel and drivers, never swapped" }, ...sys.map((x) => ({ key: "g:" + x.name, name: x.name, mb: x.mb, sub: x.n > 1 ? `${x.n} processes` : undefined, icon: x.icon }))];
  rows.push({ key: "macos", name: "macOS", kind: "macos", mb: ov.wiredMB + sys.reduce((t, x) => t + x.mb, 0), n: sys.length, sub: "system and kernel", icon: true, ...cap(sysKids) });
  // Everything else: apps (bundles, resolved runtimes) and plain programs.
  for (const x of groups) if (!sysNames.has(x.name) && !dockerHost.has(x.name)) {
    const isApp = !!x.app || !!x.icon || x.procs.length > 1;
    rows.push({ key: "g:" + x.name, name: x.name, kind: isApp ? "app" : "proc", mb: x.mb, n: x.n, sub: x.app && x.bins?.length ? x.bins.join(", ") : x.n > 1 ? `${x.n} processes` : undefined, src: x.src ?? null, icon: x.icon, ...cap(x.n > 1 || x.app ? procKids(x.procs, x.name) : []) });
  }
  rows.sort((a, b) => b.mb - a.mb);
  if (rows.length <= LIST_ROWS) { shownRows = new Set(rows.map((r) => r.key)); return rows; }
  // The long tail folds into one row so the list stays readable on a phone. A row already shown stays out of the fold
  // until it is clearly smaller than the cut (hysteresis): rows near the edge would otherwise pop in and out every update.
  const cut = rows[LIST_ROWS - 2].mb;
  const keep = (r: ListRow, i: number) => i < LIST_ROWS - 1 || (shownRows.has(r.key) && r.mb >= cut * 0.7 && i < LIST_ROWS + 9);
  const head = rows.filter(keep), tail = rows.filter((r, i) => !keep(r, i));
  shownRows = new Set(head.map((r) => r.key));
  if (!tail.length) return head;
  const kids: ListKid[] = tail.map((r) => ({ key: r.key, name: r.name, mb: r.mb, sub: r.sub, src: r.src, icon: r.icon }));
  head.push({ key: "small", name: "Small programs", kind: "small", mb: tail.reduce((t, r) => t + r.mb, 0), n: tail.length, sub: `${tail.length} programs, up to ${Math.max(1, Math.round(tail[0].mb))} MB each`, ...cap(kids) });
  return head;
}
const round = (kb: number) => Math.round(kb / 1024);
export function buildRam(inp: RamInput, ov: RamOverview, cfg: Map<string, number>, hasIcon: (name: string) => boolean = () => false) {
  const taken = new Set(inp.claimed);
  // Claude sessions: tree RSS of each `claude` process, skipping what a panel app already counted.
  const claude: ClaudeRow[] = [];
  for (const s of [...inp.sessions].sort((a, b) => a.pid - b.pid)) {
    let kb = 0, n = 0; const stack = [s.pid];
    while (stack.length) { const p = stack.pop()!; if (taken.has(p)) continue; taken.add(p); kb += inp.rss.get(p) ?? 0; n++; stack.push(...(inp.kids.get(p) ?? [])); }
    claude.push({ pid: s.pid, name: s.name || s.cwd.split("/").pop() || String(s.pid), agent: inp.agentByPid.get(s.pid) ?? null, tmux: s.tmux?.split(":")[0] || null, cwd: s.cwd.replace(HOME, "~"), status: s.status, mb: round(kb), n, startedAt: s.startedAt, src: inp.resolve ? claudeApp(inp.resolve, s.cwd)?.icon ?? null : null });
  }
  claude.sort((a, b) => b.mb - a.mb);
  // Everything else, grouped by app bundle / binary.
  const g = new Map<string, { kb: number; procs: ProcRow[]; src: string | null; app: boolean; sys: boolean }>();
  const rest = [...inp.rss].filter(([pid, kb]) => !taken.has(pid) && kb).map(([pid]) => pid);
  const parent = new Map<number, number>(); for (const [pp, ks] of inp.kids) for (const k of ks) parent.set(k, pp);
  const res: Map<number, AppRef> = inp.resolve ? resolveProcs(inp.resolve, rest, parent, inp.comms) : new Map();
  for (const [pid, kb] of inp.rss) {
    if (taken.has(pid) || !kb) continue;
    const name = groupName(inp.comms.get(pid) ?? "?"), bin = binName(inp.comms.get(pid) ?? "?"), a = res.get(pid), k = a?.name ?? name, e: { kb: number; procs: ProcRow[]; src: string | null; app: boolean; sys: boolean } = g.get(k) ?? { kb: 0, procs: [], src: a?.icon ?? null, app: !!a, sys: true };
    if (a || !isSystem(inp.comms.get(pid) ?? "")) e.sys = false;
    e.kb += kb; e.procs.push({ pid, mb: Math.round(kb / 102.4) / 10, upSec: inp.etimes.get(pid) ?? 0, bin }); g.set(k, e);
  }
  const sysNames = new Set([...g].filter(([, e]) => e.sys).map(([n]) => n));
  const all: GroupRow[] = [...g].map(([name, e]) => ({
    name, mb: round(e.kb), n: e.procs.length, icon: !e.src && hasIcon(name), ...(e.app ? { app: true, src: e.src, bins: [...new Set(e.procs.map((p) => p.bin!))].sort() } : {}), procs: e.procs.sort((a, b) => b.mb - a.mb),
  })).sort((a, b) => b.mb - a.mb);
  // VMs
  const vms: VmRow[] = [];
  for (const [name, mb] of inp.vmMem) vms.push({ name, kind: "utm", running: true, configuredMB: cfg.get(name) ?? null, footprintMB: Math.round(mb), items: [], overheadMB: 0 });
  if (inp.dockerVm.pid) {
    const items = [...inp.containerMem].filter(([, m]) => m > 0).map(([name, m]) => ({ name, mb: Math.round(m), app: inp.containerApp.get(name) ?? null })).sort((a, b) => b.mb - a.mb);
    const inVm = items.reduce((t, i) => t + i.mb, 0);
    vms.push({ name: "Docker", kind: "docker", running: true, configuredMB: cfg.get("Docker") ?? null, footprintMB: Math.round(inp.dockerVm.mb), items, overheadMB: Math.max(0, Math.round(inp.dockerVm.mb) - inVm) });
  }
  vms.sort((a, b) => b.footprintMB - a.footprintMB);
  const apps = inp.apps.map((a) => ({ name: a.name, group: a.group, mb: a.mem, src: a.memSrc, state: a.state }));
  const list = buildList(inp, ov, vms, apps, claude, all, sysNames);
  // Breakdown bar. Apps measured inside a VM (vm/docker) are already in the VM footprint, so only process-measured apps count here.
  const vmsMB = vms.reduce((t, v) => t + v.footprintMB, 0);
  const appsMB = apps.filter((a) => a.src === "process" || a.src === "port").reduce((t, a) => t + a.mb, 0);
  const claudeMB = claude.reduce((t, c) => t + c.mb, 0), otherMB = all.reduce((t, x) => t + x.mb, 0);
  const breakdown = [
    { key: "vms", label: "Virtual machines", mb: vmsMB }, { key: "apps", label: "Panel apps", mb: appsMB }, { key: "claude", label: "Claude sessions", mb: claudeMB },
    { key: "other", label: "Other processes", mb: otherMB }, { key: "macos", label: "macOS (wired + kernel)", mb: ov.wiredMB },
  ];
  const sum = breakdown.reduce((t, b) => t + b.mb, 0);
  const procSumMB = vmsMB + appsMB + claudeMB + otherMB;
  const movers = trackMovers([
    ...all.map((x) => ({ kind: "process" as Kind, name: x.name, mb: x.mb })), ...claude.map((c) => ({ kind: "claude" as Kind, name: c.name, mb: c.mb })),
    ...apps.filter((a) => a.src === "process" || a.src === "port").map((a) => ({ kind: "app" as Kind, name: a.name, mb: a.mb })),
    ...vms.map((v) => ({ kind: "vm" as Kind, name: v.name, mb: v.footprintMB })),
  ], inp.nowSec, BOOT_SEC + WARMUP_SEC);
  return {
    full: all,
    slice: {
      at: inp.nowSec, ...ov, procSumMB, breakdown, restMB: Math.max(0, ov.totalMB - sum), overByMB: Math.max(0, sum - ov.totalMB),
      list, vms, apps, claude, groups: all.slice(0, 50).map((x) => ({ ...x, procs: x.procs.slice(0, PROC_CAP) })), groupCount: all.length, otherMB, movers,
    },
  };
}

let lastAll: GroupRow[] = [];
let sysUsed: () => number | null = () => { const s = getSlice<{ ramUsedGB: number | null }>("system"); return s?.ramUsedGB != null ? Math.round(s.ramUsedGB * 1024) : null; };
/** Called by apps.ts at the end of computeApps() with its process snapshot. */
export function publishRam(inp: Omit<RamInput, "sessions" | "agentByPid" | "nowSec">) {
  if (process.platform !== "darwin") return;
  pruneCwds(inp.rss);
  const full: RamInput = { ...inp, rss: withFootprint(inp.rss, foot), sessions: liveSessions(), agentByPid: agentByPid(), nowSec: Math.floor(Date.now() / 1000) };
  void refreshVmConfig([...inp.vmMem.keys()], inp.dockerVm.pid > 0);
  noteBundles(inp.comms);
  if (!bundles.has("macOS")) bundles.set("macOS", "/System/Library/CoreServices/Finder.app"); // the macOS row wears the Finder face
  if (!bundles.has("iOS Simulator")) { const sim = ["/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app", "/Applications/Xcode.app"].find((p) => existsSync(p)); if (sim) bundles.set("iOS Simulator", sim); }
  const r = buildRam(full, { ...overview, usedMB: sysUsed() }, cfgMB, iconOk);
  wantIcons(["macOS", ...r.full.map((x) => x.name)]);
  lastAll = r.full;
  setSlice("ram", r.slice);
}
export function startRamCollectors() { every(5_000, refreshOverview); every(15_000, refreshFootprint); }

/** GET /ram/groups?q=&limit=: the full grouped list for "show all" and search (limit 0 = everything). */
export function ramRoutes(api: Hono<Env>) {
  api.get("/ram/groups", (c) => {
    const q = (c.req.query("q") ?? "").trim().toLowerCase(), lim = Number(c.req.query("limit") ?? 50);
    const list = q ? lastAll.filter((x) => x.name.toLowerCase().includes(q)) : lastAll;
    const page = lim > 0 ? list.slice(0, lim) : list; wantIcons(page.map((x) => x.name));
    return c.json({ total: list.length, groups: page.map((x) => ({ ...x, icon: iconOk(x.name), procs: x.procs.slice(0, 50) })) });
  });
  // Only names seen in the process list resolve; the query never becomes a path.
  api.get("/ram/icon", async (c) => {
    const name = c.req.query("name") ?? "";
    if (!bundles.has(name)) return c.body(null, 404);
    if (!iconState.has(name)) await resolveIcon(name);
    if (!iconOk(name)) return c.body(null, 404);
    return c.body(readFileSync(iconFile(name)), 200, { "Content-Type": "image/png", "Cache-Control": "max-age=86400" });
  });
}
