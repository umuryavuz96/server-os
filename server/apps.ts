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
}
export interface AppState {
  name: string; group: string; order: number; href: string; icon: string; about: string;
  kind: "lock" | "gate" | "switch"; warn: boolean;
  state: "on" | "off" | "part"; parts: Record<string, boolean>; mem: number;
}

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
let rss = new Map<number, number>(); let kids = new Map<number, number[]>();
const utm = new Map<string, boolean>();

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
  const ps = await run(["ps", "-axo", "pid=,ppid=,rss="], 10_000);
  const r2 = new Map<number, number>(), k2 = new Map<number, number[]>();
  for (const l of ps.out.split("\n")) {
    const [pid, ppid, kb] = l.trim().split(/\s+/).map(Number);
    if (!pid) continue;
    r2.set(pid, kb);
    (k2.get(ppid) ?? k2.set(ppid, []).get(ppid)!).push(pid);
  }
  rss = r2; kids = k2;
}
function treeMB(pid: number) {
  let tot = 0; const stack = [pid];
  while (stack.length) { const p = stack.pop()!; tot += rss.get(p) ?? 0; stack.push(...(kids.get(p) ?? [])); }
  return tot / 1024;
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
  for (const g of loadCatalog()) for (const it of g.items) {
    const parts: Record<string, boolean> = {};
    let mem = 0;
    for (const c of it.docker ?? []) { parts["docker:" + c] = containers.get(c)?.state === "running"; mem += containerMem.get(c) ?? 0; }
    for (const l of it.launchd ?? []) { const pid = launchd.get(l) ?? 0; parts["launchd:" + l] = pid > 0; if (pid) mem += treeMB(pid); }
    if (it.utm) { const on = utm.get(it.utm) ?? false; parts["vm:" + it.utm] = on; if (on) mem += 4096; }
    if (it.gate) parts["site:" + it.gate] = gateOn(it.gate);
    const vals = Object.values(parts), n = vals.filter(Boolean).length;
    const app: AppState = {
      name: it.name, group: g.group, order: order++, href: it.href ?? "", icon: it.icon ?? "", about: it.about ?? "",
      kind: it.lock ? "lock" : it.gate ? "gate" : "switch", warn: !!it.warn,
      state: it.lock ? "on" : vals.length && n === vals.length ? "on" : n === 0 ? "off" : "part",
      parts: it.lock ? {} : parts, mem: it.gate || it.lock ? 0 : Math.round(mem),
    };
    setMapEntry("apps", it.name, app);
    noteState(app);
    seen.add(it.name);
  }
  // removed from catalog -> drop
  const apps = getSlice<Record<string, AppState>>("apps") ?? {};
  for (const n of Object.keys(apps)) if (!seen.has(n)) setMapEntry("apps", n, null);
  setSlice("groups", loadCatalog().map((g) => g.group));
}

export function startAppCollectors() {
  every(5_000, async () => { await Promise.all([refreshContainers(), refreshLaunchd()]); computeApps(); });
  every(15_000, async () => { await refreshContainerMem(); computeApps(); });
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
