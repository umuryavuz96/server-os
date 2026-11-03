// Apps: catalog + live on/off state + RAM, and the on/off actions.
// Kinds: docker (containers), launchd (LaunchAgents), gate (static site via Caddy import), utm (VM). lock = never switchable.
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { UID, HOME, run, log, every } from "./lib";
import { config, dir } from "./core/config";
import { listContainers, containerMemMB, startContainer, stopContainer, setRestart, watchEvents } from "./docker";
import { setMapEntry, setSlice, getSlice } from "./store";
import { noteState } from "./lifecycle";
import { listInstalled, runOp, sh, uninstall } from "./modules/installer";
import { newTrace, type Trace } from "./core/logger";
import { copyFileSync, renameSync } from "node:fs";
import { groupName, parseEtime, publishRam } from "./ram";

// Apps managed outside the installer live in integrations.catalog; without it this folder stays empty.
export const SVC = config.integrations.catalog ?? join(dir("data"), "catalog");
const CATALOG = join(SVC, "catalog.json");
const OFF = join(SVC, "off-containers.txt");
const GATES = join(SVC, "gates");
const AGENTS = join(HOME, "Library/LaunchAgents");
const UTMCTL = "/Applications/UTM.app/Contents/MacOS/utmctl";
const CADDY = "/opt/homebrew/bin/caddy";
const CADDYFILE = "/opt/homebrew/etc/Caddyfile";

export interface CatalogItem {
  name: string; href?: string; icon?: string; about?: string;
  docker?: string[]; launchd?: string[]; gate?: string; utm?: string;
  lock?: boolean; warn?: boolean;
  /** Process names to measure when the app has no docker/launchd/utm member (root daemons like unbound). */
  proc?: string[];
}
export interface AppState {
  name: string; group: string; order: number; href: string; icon: string; about: string;
  kind: "lock" | "gate" | "switch"; warn: boolean;
  state: "on" | "off" | "part"; parts: Record<string, boolean>; mem: number;
  /** How mem was measured: every app goes through the same resolution order in memOf(). */
  memSrc: MemSrc;
}
export type MemSrc = "vm" | "docker" | "process" | "port" | "static" | "remote" | "unknown" | "off";

/** The hand-written catalog (if any) plus every app the installer put in <home>/apps, grouped by category. */
export function loadCatalog(): { group: string; items: CatalogItem[] }[] {
  const groups: { group: string; items: CatalogItem[] }[] = existsSync(CATALOG) ? JSON.parse(readFileSync(CATALOG, "utf8")).groups : [];
  for (const a of listInstalled()) {
    const item: CatalogItem = { name: a.name, href: a.href || undefined, icon: a.icon ? `/icons/installed/${a.icon}` : undefined, about: a.about, docker: a.docker, launchd: a.launchd };
    if (groups.some((g) => g.items.some((i) => i.name === a.name))) continue; // the hand-written entry wins
    const g = groups.find((x) => x.group === a.category) ?? (groups.push({ group: a.category, items: [] }), groups.at(-1)!);
    g.items.push(item);
  }
  return groups;
}
export function findItem(name: string): CatalogItem | undefined {
  for (const g of loadCatalog()) for (const it of g.items) if (it.name === name) return it;
}

// ---- raw sources (refreshed by collectors) ----
let containers = new Map<string, { id: string; state: string }>();
let containerMem = new Map<string, number>();
let launchd = new Map<string, number>(); // label -> pid (0 = loaded, not running)
let etimes = new Map<number, number>(); // pid -> seconds running
let rss = new Map<number, number>(); let kids = new Map<number, number[]>();
const utm = new Map<string, boolean>();
const vmMem = new Map<string, number>(); // VM name -> host phys_footprint MB of its Virtualization process
let vmPids = new Set<number>(); // every Virtualization VM process (UTM and Docker)
let dockerVm = { pid: 0, mb: 0 }; // Docker Desktop's VM: its footprint minus panel containers is "Docker, not in panel"
let procByName = new Map<string, number[]>(); // process basename -> pids
let portPid = new Map<number, number>(); // listening TCP port -> pid (own-user processes only, lsof without sudo)
let caddyTarget = new Map<string, string>(); // "x.home" -> "port:3066" | "static" | "remote"

async function refreshContainers() {
  const list = await listContainers();
  if (list) containers = new Map(list.map((c) => [c.name, { id: c.id, state: c.state }]));
}
async function refreshContainerMem() {
  const running = [...containers.entries()].filter(([, c]) => c.state === "running");
  const mems = await Promise.all(running.map(async ([n, c]) => [n, await containerMemMB(c.id)] as const));
  containerMem = new Map(mems);
}
async function refreshLaunchd() {
  const r = await run(["launchctl", "list"], 10_000);
  const m = new Map<string, number>();
  for (const line of r.out.split("\n").slice(1)) {
    const [pid, , label] = line.split("\t");
    if (label) m.set(label, /^\d+$/.test(pid) ? Number(pid) : 0);
  }
  launchd = m;
  const ps = await run(["ps", "-axo", "pid=,ppid=,rss=,etime=,comm="], 10_000);
  const r2 = new Map<number, number>(), k2 = new Map<number, number[]>(), n2 = new Map<string, number[]>(), c2 = new Map<number, string>(), e2 = new Map<number, number>();
  for (const l of ps.out.split("\n")) {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const [pid, ppid, kb] = [Number(m[1]), Number(m[2]), Number(m[3])];
    r2.set(pid, kb);
    (k2.get(ppid) ?? k2.set(ppid, []).get(ppid)!).push(pid);
    const base = m[5].split("/").pop()!; c2.set(pid, m[5]); e2.set(pid, parseEtime(m[4]));
    (n2.get(base) ?? n2.set(base, []).get(base)!).push(pid);
  }
  rss = r2; kids = k2; procByName = n2; comms = c2; etimes = e2;
}
/** What is running right now, for discovery: container names and loaded LaunchAgent labels (pid, 0 = not running). */
export const runtimeNames = () => ({ containers: [...containers.keys()], launchd: new Map(launchd) });
export const CATALOG_FILE = CATALOG;
let claimed = new Set<number>(); // pids counted by some panel app during the current computeApps()
let comms = new Map<number, string>(); // pid -> full command path, for grouping unclaimed processes
let claimBy = new Map<number, string>(); // pid -> panel app that counted it (Ram tab: expand an app to its processes)
let claimer = "";
function treeMB(pid: number) {
  let tot = 0; const stack = [pid];
  while (stack.length) { const p = stack.pop()!; if (claimed.has(p)) continue; claimed.add(p); if (claimer) claimBy.set(p, claimer); tot += rss.get(p) ?? 0; stack.push(...(kids.get(p) ?? [])); }
  return tot / 1024;
}
/** Live RAM of each UTM VM: the host phys_footprint of the Virtualization process that has the VM's .utm bundle open. */
async function refreshVmMem() {
  const pids = (await run(["pgrep", "-f", "com.apple.Virtualization.VirtualMachine"], 5_000)).out.split("\n").filter(Boolean);
  // Build the new values first and swap them in at the end: computeApps() runs while this awaits, and must never
  // see a half-done refresh (Docker's VM used to vanish for a moment every 15 s).
  const next = new Map<string, number>(); let dvm = { pid: 0, mb: 0 };
  for (const pid of pids) {
    const name = (await run(["lsof", "-p", pid, "-Fn"], 10_000)).out.match(/([^/\n]+)\.utm\//)?.[1];
    const mb = Number((await run(["footprint", "-p", pid], 10_000)).out.match(/phys_footprint:\s+([\d.]+)\s*MB/)?.[1] ?? 0);
    if (name) { if (mb > 0) next.set(name, mb); } else dvm = { pid: Number(pid), mb };
  }
  vmPids = new Set(pids.map(Number)); dockerVm = dvm;
  for (const [k, v] of next) vmMem.set(k, v);
  for (const k of [...vmMem.keys()]) if (!next.has(k)) vmMem.delete(k);
}
/** Listening ports -> owning pid, and what Caddy routes each .home host to. Used for apps that only have a URL. */
async function refreshPorts() {
  const out = (await run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"], 10_000)).out;
  const m = new Map<number, number>(); let pid = 0;
  for (const l of out.split("\n")) {
    if (l[0] === "p") pid = Number(l.slice(1));
    else if (l[0] === "n") { const port = Number(l.match(/:(\d+)$/)?.[1]); if (port && !m.has(port)) m.set(port, pid); }
  }
  portPid = m;
  try {
    const cf = readFileSync(CADDYFILE, "utf8"), t = new Map<string, string>();
    for (const b of cf.matchAll(/^https?:\/\/([a-z0-9.-]+)\s*\{([\s\S]*?)^\}/gm)) {
      const body = b[2], rp = body.match(/reverse_proxy\s+(\S+)/)?.[1];
      t.set(b[1], rp ? (/^(localhost|127\.0\.0\.1):(\d+)$/.test(rp) ? "port:" + rp.split(":")[1] : "remote") : /\broot\b|file_server/.test(body) ? "static" : "unknown");
    }
    caddyTarget = t;
  } catch { /* Caddyfile unreadable: URL-only apps show unknown */ }
}
const isDockerProxy = (pid: number) => (procByName.get("com.docker.backend") ?? []).includes(pid) || (procByName.get("vpnkit-bridge") ?? []).includes(pid);
/**
 * One standard for every app's RAM, in this order:
 * vm (host footprint of the VM) + docker (container cgroup usage) + process (launchd job / named process trees, RSS);
 * no members -> the process listening on the port Caddy routes its URL to; static Caddy sites and remote hosts say so.
 */
function memOf(it: CatalogItem, on: boolean): { mem: number; src: MemSrc } {
  let mem = 0; const src = new Set<MemSrc>(); claimer = it.name;
  if (it.utm && utm.get(it.utm)) { const v = vmMem.get(it.utm); if (v) { mem += v; src.add("vm"); } }
  for (const c of it.docker ?? []) { const v = containerMem.get(c); if (v) { mem += v; src.add("docker"); } }
  for (const l of it.launchd ?? []) { const pid = launchd.get(l) ?? 0; if (pid) { mem += treeMB(pid); src.add("process"); } }
  for (const n of it.proc ?? []) for (const pid of procByName.get(n) ?? []) { mem += treeMB(pid); src.add("process"); }
  if (src.size) return { mem: Math.round(mem), src: src.has("vm") ? "vm" : src.has("docker") ? "docker" : "process" };
  if (it.gate) return { mem: 0, src: "static" };
  if (it.docker?.length || it.launchd?.length || it.utm) return { mem: 0, src: on ? "unknown" : "off" };
  let host = ""; try { host = new URL(it.href ?? "").hostname; } catch { /* no URL */ }
  const tgt = caddyTarget.get(host) ?? (host && !host.endsWith(".home") ? "remote" : "unknown");
  if (tgt.startsWith("port:")) {
    const pid = portPid.get(Number(tgt.slice(5)));
    if (pid && !isDockerProxy(pid)) return { mem: Math.round(treeMB(pid)), src: "port" };
    return { mem: 0, src: "unknown" };
  }
  return { mem: 0, src: tgt as MemSrc };
}
export interface RamOther { appsMB: number; dockerOtherMB: number; top: { name: string; mb: number; n: number }[]; otherMB: number }
/** Everything the panel apps did not claim, grouped by app bundle / binary, biggest first. */
function ramOther(appsMB: number, panelContainers: Set<string>): RamOther {
  const g = new Map<string, { mb: number; n: number }>();
  for (const [pid, kb] of rss) {
    if (claimed.has(pid) || !kb) continue;
    const k = groupName(comms.get(pid) ?? "?"), e = g.get(k) ?? { mb: 0, n: 0 };
    e.mb += kb / 1024; e.n++; g.set(k, e);
  }
  // Docker's VM footprint = panel containers + containers not in the panel + the VM's own kernel/cache.
  let inVm = 0;
  for (const [n, m] of containerMem) {
    inVm += m;
    if (!panelContainers.has(n) && m > 0) g.set("container: " + n, { mb: m, n: 1 });
  }
  const dockerOtherMB = dockerVm.mb ? Math.max(0, Math.round(dockerVm.mb - inVm)) : 0;
  if (dockerOtherMB) g.set("Docker VM itself (kernel, page cache)", { mb: dockerOtherMB, n: 1 });
  const all = [...g].map(([name, e]) => ({ name, mb: Math.round(e.mb), n: e.n })).sort((a, b) => b.mb - a.mb);
  return { appsMB: Math.round(appsMB), dockerOtherMB, top: all.slice(0, 15), otherMB: all.reduce((t, e) => t + e.mb, 0) };
}
async function refreshUtm() {
  for (const g of loadCatalog()) for (const it of g.items) if (it.utm) {
    const r = await run([UTMCTL, "status", it.utm], 15_000);
    if (/started|stopped|paused/i.test(r.out)) { utm.set(it.utm, /started/i.test(r.out)); continue; }
    // utmctl talks to UTM over Apple Events; without macOS Automation permission (bun -> UTM) it answers
    // "Virtual machine not found". Fall back to "is Home Assistant answering" for the HA VM.
    const ha = getSlice<{ online: boolean }>("ha");
    if (!ha) return; // HA not probed yet: wait, so the VM never flashes "off" at startup
    utm.set(it.utm, ha.online);
  }
  utmReady = true;
}
const gateOn = (n: string) => !existsSync(join(GATES, n + ".off"));

// ---- derive app states and push changed ones ----
let utmReady = false; // never publish a VM as "off" before utmctl has answered once
export function computeApps() {
  if (process.env.SERVER_OS_DEMO === "1") return;
  if (!utmReady) return;
  let order = 0;
  const seen = new Set<string>();
  claimed = new Set(vmPids); claimBy = new Map(); let appsMB = 0; const panelContainers = new Set<string>(), containerApp = new Map<string, string>(), appList: AppState[] = [];
  for (const g of loadCatalog()) for (const it of g.items) {
    const parts: Record<string, boolean> = {};
    for (const c of it.docker ?? []) parts["docker:" + c] = containers.get(c)?.state === "running";
    for (const l of it.launchd ?? []) parts["launchd:" + l] = (launchd.get(l) ?? 0) > 0;
    if (it.utm) parts["vm:" + it.utm] = utm.get(it.utm) ?? false;
    if (it.gate) parts["site:" + it.gate] = gateOn(it.gate);
    const vals = Object.values(parts), n = vals.filter(Boolean).length;
    const plain = !it.lock && !vals.length; // nothing to switch (a site served by Caddy, an external page): always on, health-checked only
    const app: AppState = {
      name: it.name, group: g.group, order: order++, href: it.href ?? "", icon: it.icon ?? "", about: it.about ?? "",
      kind: it.lock ? "lock" : it.gate || plain ? "gate" : "switch", warn: !!it.warn,
      state: it.lock || plain ? "on" : vals.length && n === vals.length ? "on" : n === 0 ? "off" : "part",
      parts: it.lock ? {} : parts, ...(({ mem, src }) => ({ mem, memSrc: src }))(memOf(it, Object.values(parts).some(Boolean))),
    };
    appsMB += app.mem;
    for (const c of it.docker ?? []) { panelContainers.add(c); containerApp.set(c, it.name); }
    appList.push(app);
    setMapEntry("apps", it.name, app);
    noteState(app);
    seen.add(it.name);
  }
  claimer = "";
  // removed from catalog -> drop
  const apps = getSlice<Record<string, AppState>>("apps") ?? {};
  for (const n of Object.keys(apps)) if (!seen.has(n)) setMapEntry("apps", n, null);
  setSlice("groups", loadCatalog().map((g) => g.group));
  setSlice("ramOther", ramOther(appsMB, panelContainers));
  publishRam({ rss, kids, comms, etimes, claimed, claimBy, vmMem, dockerVm, containerMem, containerApp, apps: appList, resolve: { launchd, portPid, caddyTarget, catalog: loadCatalog().flatMap((g) => g.items), iconDir: join(SVC, "icons") } });
}

export function startAppCollectors() {
  every(5_000, async () => { await Promise.all([refreshContainers(), refreshLaunchd()]); computeApps(); });
  every(15_000, async () => { await Promise.all([refreshContainerMem(), refreshVmMem(), refreshPorts()]); computeApps(); });
  every(20_000, async () => { await refreshUtm(); computeApps(); });
  // Docker pushes lifecycle events: reflect start/stop instantly instead of waiting for the next poll.
  watchEvents(async () => { await refreshContainers(); computeApps(); });
}

// ---- actions ----
function setOffList(cs: string[], off: boolean) {
  const cur = new Set(existsSync(OFF) ? readFileSync(OFF, "utf8").split(/\s+/).filter(Boolean) : []);
  for (const c of cs) off ? cur.add(c) : cur.delete(c);
  writeFileSync(OFF, [...cur].sort().join("\n") + "\n");
}
async function writeGate(name: string, on: boolean) {
  mkdirSync(GATES, { recursive: true });
  const flag = join(GATES, name + ".off"), snip = join(GATES, name + ".caddy");
  if (on) { if (existsSync(flag)) unlinkSync(flag); writeFileSync(snip, "# on\n"); }
  else { writeFileSync(flag, new Date().toISOString()); writeFileSync(snip, 'respond "This site is switched off in Server OS." 503\n'); }
  return run([CADDY, "reload", "--config", CADDYFILE], 30_000);
}

let busy = false;
export async function toggle(name: string, on: boolean): Promise<{ ok: boolean; detail: string | string[] }> {
  const it = findItem(name);
  if (!it) return { ok: false, detail: "unknown service" };
  if (it.lock) return { ok: false, detail: "locked" };
  if (busy) return { ok: false, detail: "another switch is still running" };
  busy = true;
  const msgs: string[] = [];
  try {
    const dk = it.docker ?? [], ld = it.launchd ?? [];
    if (on) {
      for (const c of dk) { await setRestart(c, "unless-stopped"); msgs.push(`start ${c}: ${(await startContainer(c)) ? 0 : 1}`); }
      for (const l of ld) {
        await run(["launchctl", "enable", `gui/${UID}/${l}`]);
        msgs.push(`load ${l}: ${(await run(["launchctl", "bootstrap", `gui/${UID}`, join(AGENTS, l + ".plist")])).code}`);
      }
      if (it.utm) msgs.push(`vm start: ${(await run([UTMCTL, "start", it.utm], 60_000)).code}`);
      if (it.gate) msgs.push(`site on: ${(await writeGate(it.gate, true)).code}`);
      setOffList(dk, false);
    } else {
      for (const l of ld) {
        await run(["launchctl", "disable", `gui/${UID}/${l}`]);
        msgs.push(`unload ${l}: ${(await run(["launchctl", "bootout", `gui/${UID}/${l}`], 60_000)).code}`);
      }
      for (const c of [...dk].reverse()) { await setRestart(c, "no"); msgs.push(`stop ${c}: ${(await stopContainer(c)) ? 0 : 1}`); }
      if (it.utm) msgs.push(`vm stop: ${(await run([UTMCTL, "stop", it.utm], 90_000)).code}`);
      if (it.gate) msgs.push(`site off: ${(await writeGate(it.gate, false)).code}`);
      setOffList(dk, true);
    }
    log(`${name} -> ${on ? "ON" : "OFF"} :: ${msgs.join("; ")}`);
    await Promise.all([refreshContainers(), refreshLaunchd(), it.utm ? refreshUtm() : null]);
    computeApps();
    return { ok: true, detail: msgs };
  } finally {
    busy = false;
  }
}

export const iconFiles = () => { try { return readdirSync(join(SVC, "icons")); } catch { return []; } };

// ---- delete ----
// Apps Server OS installed go through the installer's uninstall. Apps from the hand-written catalog are taken
// apart carefully: containers removed (images, volumes and bind-mounted data stay), LaunchAgents unloaded with
// their plist moved aside (restorable), gated sites' switch files removed, and the catalog entry dropped after a
// backup copy. Locked core services and VMs are never deleted from here.
const REMOVED = join(AGENTS, existsSync(join(AGENTS, ".removed-by-server-dash")) ? ".removed-by-server-dash" : ".removed-by-server-os");

export interface DeletePlan { name: string; deletable: boolean; reason?: string; installed: boolean; canPurge: boolean; steps: string[] }

export function deletePlan(name: string): DeletePlan {
  const inst = listInstalled().find((a) => a.name === name);
  if (inst) {
    const steps = [
      inst.compose ? `Stops and removes its containers (${(inst.docker ?? []).join(", ") || "compose project sd-" + inst.id})` : "",
      inst.formula ? `brew uninstall ${inst.formula}` : "", inst.cask ? `brew uninstall --cask ${inst.cask}` : "",
      "Removes it from the Apps tab",
      `Keeps its data in apps/${inst.id}/data unless you also delete the data`,
    ].filter(Boolean);
    return { name, deletable: true, installed: true, canPurge: true, steps };
  }
  const it = findItem(name);
  if (!it) return { name, deletable: false, reason: "Unknown app", installed: false, canPurge: false, steps: [] };
  if (it.lock) return { name, deletable: false, reason: "Core service — deleting it would cut devices off DNS or the VPN.", installed: false, canPurge: false, steps: [] };
  if (it.utm) return { name, deletable: false, reason: "A virtual machine — delete it in UTM if you really mean to.", installed: false, canPurge: false, steps: [] };
  const steps = [
    ...(it.docker ?? []).map((c) => `Removes container ${c} (its image, volumes and data folders stay)`),
    ...(it.launchd ?? []).map((l) => `Unloads ${l} and moves its plist to ~/Library/LaunchAgents/.removed-by-server-os (restorable)`),
    it.gate ? `Removes the on/off switch files of the ${it.gate} site (its Caddy block stays — remove it by hand)` : "",
    "Removes it from the Apps tab (catalog.json is backed up first)",
  ].filter(Boolean);
  return { name, deletable: true, installed: false, canPurge: false, steps };
}

export function deleteApp(name: string, purge: boolean, actor: string, trace: Trace = newTrace()) {
  const plan = deletePlan(name);
  if (!plan.deletable) throw new Error(plan.reason ?? "can't delete");
  const inst = listInstalled().find((a) => a.name === name);
  if (inst) return uninstall(inst.id, purge, actor, trace);
  const it = findItem(name)!;
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return runOp(id, name, "uninstall", actor, trace, async (op) => {
    for (const c of it.docker ?? []) {
      op.step = `Removing container ${c}`;
      if ((await sh(op, ["docker", "rm", "-f", c], HOME, 120_000)) !== 0) op.log += `Container ${c} was not there or could not be removed\n`;
    }
    if (it.docker?.length) setOffList(it.docker, false);
    for (const l of it.launchd ?? []) {
      op.step = `Unloading ${l}`;
      await sh(op, ["launchctl", "bootout", `gui/${UID}/${l}`], HOME, 60_000);
      const plist = join(AGENTS, l + ".plist");
      if (existsSync(plist)) {
        mkdirSync(REMOVED, { recursive: true });
        renameSync(plist, join(REMOVED, l + ".plist"));
        op.log += `Moved ${plist} to ${REMOVED}\n`;
      }
    }
    if (it.gate) {
      for (const f of [join(GATES, it.gate + ".off"), join(GATES, it.gate + ".caddy")]) if (existsSync(f)) unlinkSync(f);
      op.log += `Its Caddy block for ${it.gate} is still in the Caddyfile — remove it by hand if the site should go too\n`;
    }
    op.step = "Removing it from the catalog";
    const raw = JSON.parse(readFileSync(CATALOG, "utf8"));
    const backup = `${CATALOG}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(CATALOG, backup);
    for (const g of raw.groups) g.items = g.items.filter((x: CatalogItem) => x.name !== name);
    raw.groups = raw.groups.filter((g: { items: CatalogItem[] }) => g.items.length);
    writeFileSync(CATALOG, JSON.stringify(raw, null, 2) + "\n");
    op.log += `catalog.json backed up to ${backup}\n`;
    await Promise.all([refreshContainers(), refreshLaunchd()]);
    computeApps();
  });
}

// ---- for the Ports page: which processes / containers / ports belong to which app ----
export function appRefs(): { name: string; docker?: string[]; pids?: number[]; ports?: number[] }[] {
  const refs: { name: string; docker?: string[]; pids?: number[]; ports?: number[] }[] = [];
  const tree = (pid: number) => { const out: number[] = [], st = [pid]; while (st.length) { const p = st.pop()!; out.push(p); st.push(...(kids.get(p) ?? [])); } return out; };
  for (const g of loadCatalog()) for (const it of g.items) {
    const pids = (it.launchd ?? []).flatMap((l) => { const pid = launchd.get(l) ?? 0; return pid ? tree(pid) : []; });
    const port = /:(\d+)(\/|$)/.exec(it.href ?? "")?.[1];
    refs.push({ name: it.name, docker: it.docker, pids, ports: port ? [Number(port)] : [] });
  }
  for (const a of listInstalled()) if (a.port) { const r = refs.find((x) => x.name === a.name); if (r) r.ports = [...(r.ports ?? []), a.port]; }
  return refs;
}
