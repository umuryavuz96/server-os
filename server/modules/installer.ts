// Installs and removes apps. An install option from Discover becomes a plan
// (compose file or Homebrew package), then an operation whose steps and output stream to the panel and apps.
// Installed apps live in <home>/apps/<id>/ (app.yaml + compose.yaml + data/) and show up on the Apps tab with
// the same on/off switch as everything else.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { config, dir } from "../core/config";
import { audit, logEvent, newTrace, type Trace } from "../core/logger";
import { HOME } from "../lib";
import { setSlice } from "../store";
import { getItem, slugify, type InstallOption } from "./catalog";
import { agentAvailable, runAgent } from "./agent";
import { getRecipe } from "./recipes";
import { addName, removeName } from "./names";

export interface InstalledApp {
  id: string; name: string; about: string; category: string; icon: string; href: string;
  method: InstallOption["method"]; ref: string; installedAt: number;
  docker?: string[]; launchd?: string[]; compose?: boolean; formula?: string; cask?: string;
  /** Local port of the web UI (href may be a nicer address made by apps.link). */
  port?: number;
  /** Written by the agent when setup is done (ready.yaml next to app.yaml). */
  ready?: Ready;
}
/** "Ready to use" card: where to open it, how to log in, and what is left for a person to do. */
export interface Ready {
  url: string; username?: string;
  /** Name of the generated secret that holds the password (see secrets). */
  secret?: string;
  summary: string; steps: string[]; at: number;
}
export interface Plan {
  id: string; name: string; about: string; category: string; logo: string | null;
  method: InstallOption["method"]; ref: string;
  compose?: string; formula?: string; service?: boolean; cask?: string; webPort?: number; webPath?: string;
  notes?: string; setup?: string;
}
export interface Operation {
  id: string; app: string; name: string; action: "install" | "uninstall" | "setup"; status: "running" | "ok" | "failed";
  step: string; log: string; started: number; ended: number | null; traceId: string; actor: string;
  /** true when a background Claude Code run does the work. */
  agent?: boolean;
  /** What the owner sees ticked off: the installer's own steps, then the agent's (it plans and checks them itself). */
  checklist: Check[];
}
export interface Check { label: string; state: "todo" | "doing" | "done" | "skipped" | "failed"; note?: string; group?: string }

/** Mark a step: the one before it that was still "doing" is done, this one is now doing (or the given state). */
function step(op: Operation, label: string, state: Check["state"] = "doing", note?: string) {
  if (state === "doing") for (const c of op.checklist) if (c.state === "doing" && c.label !== label) c.state = "done";
  const c = op.checklist.find((x) => x.label.toLowerCase() === label.toLowerCase());
  if (c) { c.state = state; if (note) c.note = note.slice(0, 160); }
  else op.checklist.push({ label: label.slice(0, 80), state, ...(note ? { note: note.slice(0, 160) } : {}) });
  if (state === "doing") op.step = label;
  publish();
}
const SETUP_STEPS = ["Check it is running", "Create your admin account", "Finish the first-run setup", "Close public sign-ups", "Check the login works", "Write the ready card"];

const PATH = `${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
const appDir = (id: string) => join(dir("apps"), id);
const appFile = (id: string) => join(appDir(id), "app.yaml");
const readyFile = (id: string) => join(appDir(id), "ready.yaml");
const secretFile = (id: string) => join(appDir(id), ".secret");
const host = () => config.host ?? hostname().replace(/\.local$/, "") + ".local";

// ---------- installed apps ----------
export function listInstalled(): InstalledApp[] {
  if (!existsSync(dir("apps"))) return [];
  return readdirSync(dir("apps")).filter((id) => existsSync(appFile(id))).sort().flatMap((id) => {
    try {
      const ready = existsSync(readyFile(id)) ? (Bun.YAML.parse(readFileSync(readyFile(id), "utf8")) as Ready) : undefined;
      return [{ ...(Bun.YAML.parse(readFileSync(appFile(id), "utf8")) as InstalledApp), id, ...(ready ? { ready } : {}) }];
    } catch { return []; }
  });
}
export const getInstalled = (id: string) => listInstalled().find((a) => a.id === id) ?? null;

// ---------- secrets + ready card ----------
// Passwords the agent sets in an app are made here, so they are random and kept in one place:
// apps/<id>/.secret (JSON, mode 600). The agent's settings deny it reading that file; it gets a value once, when made.
const readSecrets = (id: string): Record<string, string> => { try { return JSON.parse(readFileSync(secretFile(id), "utf8")); } catch { return {}; } };
export function newSecret(id: string, name: string, length = 24): string {
  if (!existsSync(appDir(id))) throw new Error(`no app ${id}`);
  if (!/^[a-z0-9_-]{1,40}$/i.test(name)) throw new Error("secret name: letters, digits, - and _");
  const all = readSecrets(id);
  if (all[name]) return all[name];
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  all[name] = Array.from(crypto.getRandomValues(new Uint32Array(Math.min(Math.max(length, 12), 64))), (n) => abc[n % abc.length]).join("");
  writeFileSync(secretFile(id), JSON.stringify(all, null, 2)); chmodSync(secretFile(id), 0o600);
  return all[name];
}
export const getSecrets = (id: string) => readSecrets(id);
/** The agent's side of the checklist: replace the plan (keeps done steps) and/or mark one step. */
export function agentChecklist(id: string, b: { plan?: string[]; label?: string; state?: Check["state"]; note?: string }): Check[] {
  const op = [...ops.values()].filter((o) => o.app === id && o.agent && o.status === "running").sort((a, b) => b.started - a.started)[0];
  if (!op) throw new Error(`no agent run for ${id} right now`);
  if (b.plan?.length) {
    const kept = op.checklist.filter((c) => c.state !== "todo");
    op.checklist = [...kept, ...b.plan.slice(0, 15).filter((l) => !kept.some((c) => c.label.toLowerCase() === l.toLowerCase())).map((label) => ({ label: label.slice(0, 80), state: "todo" as const }))];
    publish();
  }
  if (b.label) step(op, b.label, b.state && ["todo", "doing", "done", "skipped", "failed"].includes(b.state) ? b.state : "done", b.note);
  return op.checklist;
}

export function setReady(id: string, r: Omit<Ready, "at">): Ready {
  if (!getInstalled(id)) throw new Error(`${id} is not installed`);
  if (!r.url || !r.summary) throw new Error("url and summary are required");
  if (r.secret && !readSecrets(id)[r.secret]) throw new Error(`no secret ${r.secret} — make it with new_secret first`);
  const ready: Ready = { url: r.url, ...(r.username ? { username: r.username } : {}), ...(r.secret ? { secret: r.secret } : {}), summary: r.summary, steps: (r.steps ?? []).map(String).slice(0, 12), at: Date.now() };
  writeFileSync(readyFile(id), `# Ready card — written by the agent after setup\n${Bun.YAML.stringify(ready, null, 2)}\n`);
  try { agentChecklist(id, { label: "Write the ready card", state: "done" }); } catch { /* not during an agent run */ }
  onInstalled();
  return ready;
}

// ---------- ports ----------
export function portFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = createServer().once("error", () => res(false)).once("listening", () => s.close(() => res(true)));
    s.listen(port, "0.0.0.0");
  });
}
export async function freePort(preferred: number, taken: Set<number>): Promise<number> {
  for (let p = preferred; p < preferred + 200; p++) if (!taken.has(p) && (await portFree(p))) return p;
  throw new Error(`no free port near ${preferred}`);
}

/** Resolve {{data}}, {{port:N}}, {{tz}}, {{puid}}, {{pgid}}. Returns the text and the host ports picked, in order. */
export async function fillTemplate(text: string, dataDir: string): Promise<{ text: string; ports: number[] }> {
  const ports: number[] = [], picked = new Map<string, number>(), taken = new Set<number>();
  for (const m of text.matchAll(/\{\{port:(\d+)\}\}/g)) {
    if (picked.has(m[0])) continue;
    const p = await freePort(Number(m[1]), taken);
    taken.add(p); picked.set(m[0], p); ports.push(p);
  }
  const u = userInfo();
  const out = text.replace(/\{\{port:\d+\}\}/g, (m) => String(picked.get(m)))
    .replaceAll("{{data}}", dataDir).replaceAll("{{tz}}", Intl.DateTimeFormat().resolvedOptions().timeZone)
    .replaceAll("{{puid}}", String(u.uid)).replaceAll("{{pgid}}", String(u.gid));
  return { text: out, ports };
}

// ---------- plans per source ----------
/** CasaOS compose → our template: drop x-casaos and host devices, map /DATA paths into the app's data folder, ports → {{port:N}}. */
export function casaToTemplate(raw: string): { compose: string; webPort?: number; webPath?: string } {
  const y = Bun.YAML.parse(raw) as Record<string, any>;
  const x = y["x-casaos"] ?? {};
  delete y["x-casaos"];
  let first: number | undefined;
  for (const [, svc] of Object.entries<Record<string, any>>(y.services ?? {})) {
    delete svc["x-casaos"]; delete svc.devices;
    if (svc.network_mode === "host") delete svc.network_mode; // Docker Desktop has no host networking for ports
    svc.ports = (svc.ports ?? []).map((p: any) => {
      if (typeof p === "string") { const [h, c] = p.split(":").length >= 2 ? [p.split(":").at(-2), p.split(":").at(-1)] : [p, p]; first ??= Number(h); return `{{port:${h}}}:${c}`; }
      first ??= Number(p.published ?? p.target);
      return { ...p, published: `{{port:${p.published ?? p.target}}}` };
    });
    svc.volumes = (svc.volumes ?? []).map((v: any) => {
      const fix = (s: string) => s.replace(/^\/DATA\/AppData\/\$AppID/, "{{data}}").replace(/^\/DATA\/AppData\/[^/]+/, "{{data}}").replace(/^\/DATA/, "{{data}}");
      return typeof v === "string" ? fix(v) : v.type === "bind" ? { ...v, source: fix(v.source), bind: { create_host_path: true } } : v;
    });
    const env = svc.environment;
    if (env && !Array.isArray(env)) for (const k of Object.keys(env)) env[k] = String(env[k]).replace("$PUID", "{{puid}}").replace("$PGID", "{{pgid}}").replace("$TZ", "{{tz}}");
  }
  const webPort = x.port_map ? Number(x.port_map) : first;
  return { compose: Bun.YAML.stringify(y, null, 2).replace(/\$AppID/g, "app"), webPort, webPath: x.index };
}

let lsio: Record<string, any>[] | null = null;
/** LinuxServer image → compose: its required ports, volumes (under data/) and env. */
export async function linuxserverTemplate(name: string): Promise<{ compose: string; webPort?: number }> {
  lsio ??= (await (await fetch("https://api.linuxserver.io/api/v1/images?include_config=true&include_deprecated=false", { signal: AbortSignal.timeout(60_000) })).json()).data.repositories.linuxserver;
  const img = lsio!.find((i) => i.name === name);
  if (!img) throw new Error(`LinuxServer has no image ${name}`);
  const c = img.config ?? {};
  const ports = (c.ports ?? []).filter((p: any) => !p.optional && !String(p.internal).endsWith("/udp"));
  const env: Record<string, string> = { PUID: "{{puid}}", PGID: "{{pgid}}", TZ: "{{tz}}" };
  for (const e of c.env_vars ?? []) if (!e.optional && !(e.name in env)) env[e.name] = String(e.value ?? "");
  const svc: Record<string, unknown> = {
    image: `lscr.io/linuxserver/${name}:latest`, container_name: `sd-${name}`, restart: "unless-stopped", environment: env,
    ports: ports.map((p: any) => `{{port:${String(p.external).replace(/\D/g, "")}}}:${p.internal}`),
    volumes: (c.volumes ?? []).filter((v: any) => !v.optional).map((v: any) => `{{data}}${v.path}:${v.path}`),
  };
  return { compose: Bun.YAML.stringify({ services: { [name]: svc } }, null, 2), webPort: ports[0] ? Number(String(ports[0].external).replace(/\D/g, "")) : undefined };
}

/** Turn a catalog entry + chosen method into a concrete plan (no side effects). */
export async function makePlan(catalogId: string, method?: InstallOption["method"]): Promise<Plan> {
  const item = getItem(catalogId);
  if (!item) throw new Error("unknown catalog entry");
  const opt = method ? item.install.find((o) => o.method === method) : item.install[0];
  if (!opt) throw new Error(method ? `${item.name} can't be installed with ${method}` : `${item.name} has no automatic install — ask the agent`);
  const base = { id: slugify(item.name), name: item.name, about: item.description.split("\n")[0].slice(0, 200), category: item.category, logo: item.logo, method: opt.method, ref: opt.ref };
  switch (opt.method) {
    case "recipe": {
      const r = getRecipe(opt.ref);
      if (!r) throw new Error(`recipe ${opt.ref} not found`);
      return { ...base, id: r.id, about: r.description || base.about, compose: (process.platform === "linux" && r.docker?.linux) || r.docker?.compose, formula: r.brew?.formula, service: r.brew?.service, cask: r.cask?.token, webPort: r.web?.port, webPath: r.web?.path, notes: r.notes, setup: r.setup };
    }
    case "casaos": {
      const raw = await (await fetch(`https://raw.githubusercontent.com/IceWhaleTech/CasaOS-AppStore/main/Apps/${encodeURIComponent(opt.ref)}/docker-compose.yml`, { signal: AbortSignal.timeout(30_000) })).text();
      return { ...base, ...casaToTemplate(raw) };
    }
    case "linuxserver": return { ...base, ...(await linuxserverTemplate(opt.ref)) };
    case "brew": return { ...base, formula: opt.ref, service: true };
    case "cask":
      if (process.platform !== "darwin") throw new Error("casks are macOS apps");
      return { ...base, cask: opt.ref };
    default: throw new Error(`${item.name}: no automatic install for ${opt.method} — ask the agent`);
  }
}

// ---------- operations ----------
const ops = new Map<string, Operation>();
const publish = () => {
  setSlice("operations", [...ops.values()].sort((a, b) => b.started - a.started).slice(0, 20));
  setSlice("lifecycle", lifecycle());
};
let appsChanged: () => void = () => {};
let installedCache: { at: number; apps: Map<string, InstalledApp> } | null = null;
const onInstalled = () => { installedCache = null; appsChanged(); setSlice("lifecycle", lifecycle()); };
export function onAppsChanged(fn: () => void) { appsChanged = fn; }

// ---------- lifecycle ----------
/**
 * One state per app, so every screen shows the same thing and offers only what makes sense:
 * installing → setting-up → ready, with installed (no ready card yet), setup-failed and failed (install failed,
 * kept for 30 min) and removing. Apps absent from the map are available to install.
 */
export type LifeState = "installing" | "setting-up" | "removing" | "ready" | "installed" | "setup-failed" | "failed";
export interface Life { name: string; logo: string | null; state: LifeState; step: string; op: string | null; agent: boolean; since: number; href: string | null; error: string | null; checklist: Check[] }
export function lifecycle(): Record<string, Life> {
  const out: Record<string, Life> = {};
  // Per app: a running operation wins over finished ones (an agent run keeps going after its own inner install ends).
  const latest = new Map<string, Operation>();
  const rank = (o: Operation) => (o.status === "running" ? 2e13 : 0) + o.started;
  for (const o of ops.values()) if (!latest.has(o.app) || rank(o) > rank(latest.get(o.app)!)) latest.set(o.app, o);
  // publish() runs on every chunk of install output: keep the folder read out of that path.
  if (!installedCache || Date.now() - installedCache.at > 3000) installedCache = { at: Date.now(), apps: new Map(listInstalled().map((a) => [a.id, a])) };
  const installed = installedCache.apps;
  for (const id of new Set([...latest.keys(), ...installed.keys()])) {
    const o = latest.get(id) ?? null, a = installed.get(id) ?? null;
    // One checklist for the whole journey: install, then the agent's setup, as one list in two groups
    // (the runs since the last removal, within the last two hours).
    const lastRemoval = Math.max(0, ...[...ops.values()].filter((x) => x.app === id && x.action === "uninstall").map((x) => x.started));
    const sinceInstall = Math.max(lastRemoval, ...[...ops.values()].filter((x) => x.app === id && x.action === "install" && !x.agent && x.actor !== "agent" && x.started > lastRemoval).map((x) => x.started).slice(-1));
    const runs = [...ops.values()].filter((x) => x.app === id && x.action !== "uninstall" && x.started >= sinceInstall && Date.now() - x.started < 2 * 3600_000)
      .sort((x, y) => x.started - y.started);
    const checklist = runs.flatMap((x) => x.checklist.map((c) => ({ ...c, group: x.agent ? (x.action === "install" ? "The agent installs and sets it up" : "The agent sets it up") : x.action === "setup" ? "Setup" : "Install" })));
    const base = { name: o?.name ?? a?.name ?? id, logo: getItem(id)?.logo ?? null, op: o?.id ?? null, agent: !!o?.agent, href: a?.ready?.url || a?.href || null, error: null as string | null, checklist };
    if (o?.status === "running") out[id] = { ...base, state: o.action === "uninstall" ? "removing" : o.action === "setup" || (o.agent && a) ? "setting-up" : "installing", step: o.step, since: o.started };
    else if (a) {
      if (a.ready) out[id] = { ...base, state: "ready", step: "Ready to use", since: a.ready.at };
      else if (o?.action === "setup" && o.status === "failed") out[id] = { ...base, state: "setup-failed", step: "Setup didn't finish", since: o.ended ?? o.started, error: o.step };
      else out[id] = { ...base, state: "installed", step: "Installed", since: a.installedAt };
    } else if (o?.action === "install" && o.status === "failed" && Date.now() - (o.ended ?? 0) < 30 * 60_000)
      out[id] = { ...base, state: "failed", step: "Install failed", since: o.ended ?? o.started, error: o.step };
  }
  return out;
}
export const getOperation = (id: string) => ops.get(id) ?? null;

export async function sh(op: Operation, cmd: string[], cwd = HOME, timeoutMs = 20 * 60_000): Promise<number> {
  op.log += `$ ${cmd.join(" ")}\n`; publish();
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, PATH, HOME, HOMEBREW_NO_AUTO_UPDATE: "1" }, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const pump = async (s: ReadableStream<Uint8Array>) => { for await (const chunk of s) { op.log = (op.log + new TextDecoder().decode(chunk)).slice(-32_000); publish(); } };
  await Promise.all([pump(p.stdout), pump(p.stderr)]);
  clearTimeout(timer);
  return p.exited;
}

const DONE = { install: "Installed", uninstall: "Removed", setup: "Ready to use" } as const;
export function runOp(app: string, name: string, action: Operation["action"], actor: string, trace: Trace, work: (op: Operation) => Promise<void>, agent = false, then?: () => void): Operation {
  const op: Operation = { id: crypto.randomUUID(), app, name, action, status: "running", step: "Starting", log: "", started: Date.now(), ended: null, traceId: trace.trace_id, actor, checklist: [], ...(agent ? { agent } : {}) };
  ops.set(op.id, op); publish();
  logEvent("info", `${action} ${app} started`, { app, operation: op.id, actor, agent }, trace);
  work(op).then(() => {
    op.status = "ok"; op.step = DONE[action];
    for (const c of op.checklist) if (c.state === "doing") c.state = "done"; else if (c.state === "todo") c.state = "skipped";
    try { then?.(); } catch (e) { op.log += `Could not start the follow-up: ${(e as Error).message}\n`; }
  })
    .catch((e) => {
      op.status = "failed"; op.step = String((e as Error).message ?? e); op.log += `\n${op.step}\n`;
      for (const c of op.checklist) if (c.state === "doing") { c.state = "failed"; c.note ??= op.step.slice(0, 160); }
    })
    .finally(() => {
      op.ended = Date.now(); installedCache = null; publish(); onInstalled();
      audit(actor, `app.${action}`, app, op.status === "ok" ? "ok" : "failed", trace, { operation: op.id, agent });
      if (op.status === "failed") logEvent("error", `${action} ${app} failed: ${op.step}`, { app, operation: op.id }, trace);
    });
  return op;
}

async function fetchIcon(id: string, url: string | null): Promise<string> {
  if (!url) return "";
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return "";
    const ext = (r.headers.get("content-type") ?? "").includes("svg") ? "svg" : url.match(/\.(png|webp|svg|jpg)(\?|$)/)?.[1] ?? "png";
    const f = join(dir("data"), "icons", `${id}.${ext}`);
    mkdirSync(join(dir("data"), "icons"), { recursive: true });
    await Bun.write(f, r);
    return `${id}.${ext}`;
  } catch { return ""; }
}

export async function waitHttp(url: string, ms = 90_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: "manual" }); if (r.status < 500) return true; } catch { /* not up yet */ }
    await Bun.sleep(2000);
  }
  return false;
}

/** Another operation runs for this app. An agent run's own install calls don't count against it. */
const busy = (id: string, byAgent = false) => [...ops.values()].some((o) => o.app === id && o.status === "running" && !(byAgent && o.agent));

/** Give the app an address with apps.link (e.g. a reverse proxy + DNS helper). Returns the URL, or null. */
async function link(op: Operation, id: string, port: number): Promise<string | null> {
  // Built-in names (set up by the wizard) first; a custom apps.link command otherwise.
  if (config.names) {
    step(op, "Give it an address");
    try { const url = await addName(id, port); step(op, "Give it an address", "done", url.replace(/^https?:\/\//, "")); return url; }
    catch (e) { op.log += `Could not add the address: ${(e as Error).message}\n`; step(op, "Give it an address", "skipped", "kept its port"); return null; }
  }
  const l = config.apps.link;
  if (!l?.command) return null;
  const fill = (t: string) => t.replaceAll("{id}", id).replaceAll("{port}", String(port));
  step(op, "Give it an address");
  if ((await sh(op, ["sh", "-c", fill(l.command)], HOME, 120_000)) !== 0) { op.log += "Could not add the address — the app stays on its port\n"; step(op, "Give it an address", "skipped", "kept its port; the address is in use or the helper failed"); return null; }
  step(op, "Give it an address", "done", fill(l.url).replace(/^https?:\/\//, ""));
  return fill(l.url);
}

/** Install from a plan. With agentSetup (default: config.apps.agentSetup), a background agent run finishes setup after. */
export function install(plan: Plan, actor: string, trace: Trace = newTrace(), opts: { agentSetup?: boolean; note?: string } = {}): Operation {
  if (getInstalled(plan.id)) throw new Error(`${plan.name} is already installed`);
  if (busy(plan.id, actor === "agent")) throw new Error(`${plan.name} is already being installed`);
  // The agent's own installs don't start a second agent: it does the setup itself.
  const setupAfter = actor !== "agent" && (opts.agentSetup ?? config.apps.agentSetup) && agentAvailable() && !plan.cask;
  return runOp(plan.id, plan.name, "install", actor, trace, async (op) => {
    op.checklist = [
      ...(plan.compose ? ["Prepare the compose file", "Pull and start containers"] : plan.formula ? [`Install ${plan.formula} with Homebrew`, ...(plan.service ? ["Start the service"] : [])] : [`Install ${plan.cask ?? plan.name}`]),
      ...(plan.webPort || plan.compose ? ["Wait for the web UI"] : []),
      ...((config.names || config.apps.link?.command) && (plan.webPort || plan.compose) ? ["Give it an address"] : []),
      ...(setupAfter ? ["Hand over to the agent for setup"] : []),
    ].map((label) => ({ label, state: "todo" as const }));
    const d = appDir(plan.id);
    mkdirSync(join(d, "data"), { recursive: true });
    const app: InstalledApp = { id: plan.id, name: plan.name, about: plan.about, category: plan.category || "Installed", icon: "", href: "", method: plan.method, ref: plan.ref, installedAt: Date.now() };
    let webPort = plan.webPort;
    if (plan.compose) {
      step(op, "Prepare the compose file");
      const { text, ports } = await fillTemplate(plan.compose, join(d, "data"));
      if (plan.method !== "recipe" || !plan.webPort) webPort = ports[0] ?? webPort;
      writeFileSync(join(d, "compose.yaml"), `# Installed by Server OS from ${plan.method}:${plan.ref}\n${text}`);
      step(op, "Pull and start containers");
      if ((await sh(op, ["docker", "compose", "-p", `sd-${plan.id}`, "-f", join(d, "compose.yaml"), "up", "-d", "--pull", "missing"], d)) !== 0) throw new Error("docker compose up failed");
      const ps = Bun.spawnSync(["docker", "compose", "-p", `sd-${plan.id}`, "-f", join(d, "compose.yaml"), "ps", "-a", "--format", "{{.Name}}"], { env: { ...process.env, PATH } });
      app.docker = ps.stdout.toString().trim().split("\n").filter(Boolean);
      app.compose = true;
    } else if (plan.formula) {
      step(op, `Install ${plan.formula} with Homebrew`);
      if ((await sh(op, ["brew", "install", plan.formula])) !== 0) throw new Error("brew install failed");
      app.formula = plan.formula;
      if (plan.service) {
        step(op, "Start the service");
        if ((await sh(op, ["brew", "services", "start", plan.formula])) !== 0) throw new Error("brew services start failed");
        if (process.platform === "darwin") app.launchd = [`homebrew.mxcl.${plan.formula}`];
      }
    } else if (plan.cask) {
      step(op, `Install ${plan.cask}`);
      if ((await sh(op, ["brew", "install", "--cask", plan.cask])) !== 0) throw new Error("brew install --cask failed");
      app.cask = plan.cask;
    } else throw new Error("nothing to install");
    op.step = "Fetching the logo"; // not a checklist step: never fails the install
    app.icon = await fetchIcon(plan.id, plan.logo);
    if (webPort) {
      app.port = webPort;
      app.href = `http://${host()}:${webPort}${plan.webPath ?? ""}`;
      step(op, "Wait for the web UI");
      const up = await waitHttp(`http://127.0.0.1:${webPort}${plan.webPath ?? ""}`);
      step(op, "Wait for the web UI", "done", up ? `answers on port ${webPort}` : `no answer yet on port ${webPort}; it may still be starting`);
      op.log += up ? `Web UI answers on port ${webPort}\n` : `Web UI did not answer on port ${webPort} within 90 s (it may still be starting)\n`;
      const url = await link(op, plan.id, webPort);
      if (url) { app.href = url + (plan.webPath ?? ""); op.log += `Address: ${app.href}\n`; }
    }
    writeFileSync(appFile(plan.id), `# Server OS app — written by the installer\n${Bun.YAML.stringify(app, null, 2)}\n`);
    if (plan.notes || plan.setup) writeFileSync(join(d, "setup.md"), `# ${plan.name}: setup notes from the recipe\n\n${plan.notes ? `For the owner: ${plan.notes}\n\n` : ""}${plan.setup ?? ""}\n`);
    if (setupAfter) { op.log += "Handing over to the agent for first-run setup\n"; step(op, "Hand over to the agent for setup", "done"); }
  }, false, setupAfter ? () => { setup(plan.id, actor, trace, opts.note); } : undefined);
}

const owner = () => `${config.owner.name}${config.owner.email ? ` <${config.owner.email}>` : ""}`;
const BACKGROUND = `You run in the background: nobody can answer questions. Pick safe defaults and say which. Never stop, change or remove other apps.
The owner watches a live checklist: start with plan_steps, then check_step each step (doing → done with a short note) as you go.`;

/** Background agent run: first-run setup of an installed app, ending with its ready card. */
export function setup(id: string, actor: string, trace: Trace = newTrace(), note = ""): Operation {
  const app = getInstalled(id);
  if (!app) throw new Error("not installed");
  if (busy(id)) throw new Error(`${app.name} is busy`);
  if (!agentAvailable()) throw new Error("Claude Code is not installed on this server");
  const d = appDir(id), hints = existsSync(join(d, "setup.md")) ? readFileSync(join(d, "setup.md"), "utf8") : "";
  const prompt = `Finish setting up ${app.name} (app id "${id}"), which Server OS just installed, so the owner can open it and use it.
Follow the finish-app skill.

- Installed from: ${app.method}:${app.ref}
- Address: ${app.href || "none"}${app.port ? ` (local: http://127.0.0.1:${app.port})` : ""}
- Folder: ${d} (compose.yaml, data/)${app.docker?.length ? `\n- Containers: ${app.docker.join(", ")}` : ""}
- Owner: ${owner()}
${hints ? `\nRecipe notes:\n${hints}\n` : ""}${note ? `\nNote from the owner: ${note}\n` : ""}
${BACKGROUND}
End by calling report_ready for "${id}" exactly once — also when part of the setup is left for the owner.`;
  const started = Date.now();
  return agentOp(id, app.name, "setup", prompt, actor, trace, SETUP_STEPS, () => {
    const r = getInstalled(id)?.ready;
    if (!r || r.at < started) throw new Error("the agent finished without a ready card");
  });
}

/** No automatic method (or the owner chose the agent): a background run installs it, then sets it up. */
export function agentInstall(catalogId: string, note: string, actor: string, trace: Trace = newTrace()): Operation {
  const item = getItem(catalogId);
  if (!item) throw new Error("unknown catalog entry");
  if (!agentAvailable()) throw new Error("Claude Code is not installed on this server");
  const id = slugify(item.name);
  if (getInstalled(id)) throw new Error(`${item.name} is already installed`);
  if (busy(id)) throw new Error(`${item.name} is already being installed`);
  const prompt = `Install ${item.name} on this server and set it up so the owner can open it and use it.
Follow the add-app skill, then the finish-app skill. Use the app id "${id}" for the recipe and the install.

- Catalog id: ${catalogId}
- Description: ${item.description.split("\n")[0]}
- Website: ${item.website ?? "—"} · Repo: ${item.repo ?? "—"}
- Known install options: ${item.install.map((o) => `${o.method}:${o.ref}`).join(", ") || "none"}
- Owner: ${owner()}
${note ? `\nNote from the owner: ${note}\n` : ""}
${BACKGROUND}
End by calling report_ready for the installed app exactly once.`;
  return agentOp(id, item.name, "install", prompt, actor, trace, ["Find the official install", "Write a recipe", "Install it", ...SETUP_STEPS], () => {
    if (!listInstalled().some((a) => a.id === id || a.ref === catalogId)) throw new Error("the agent finished but the app is not installed");
  });
}

function agentOp(id: string, name: string, action: Operation["action"], prompt: string, actor: string, trace: Trace, steps: string[], check: () => void): Operation {
  return runOp(id, name, action, actor, trace, async (op) => {
    op.checklist = steps.map((label) => ({ label, state: "todo" }));
    op.step = "The agent is starting";
    const answer = await runAgent(prompt, trace, {
      log: (t) => { op.log = (op.log + t).slice(-32_000); publish(); },
      step: (t) => { if (!op.checklist.some((c) => c.state === "doing")) op.step = t; publish(); },
    });
    if (!op.log.includes(answer.trim().slice(0, 80))) op.log += `\n${answer}\n`; // the last message usually streamed already
    check();
  }, true);
}

export function uninstall(id: string, purge: boolean, actor: string, trace: Trace = newTrace()): Operation {
  const app = getInstalled(id);
  if (!app) throw new Error("not installed");
  return runOp(id, app.name, "uninstall", actor, trace, async (op) => {
    const d = appDir(id);
    if (app.compose) {
      op.step = "Stopping and removing containers";
      if ((await sh(op, ["docker", "compose", "-p", `sd-${id}`, "-f", join(d, "compose.yaml"), "down", "--remove-orphans"], d)) !== 0) throw new Error("docker compose down failed");
    }
    if (app.formula) {
      op.step = `brew uninstall ${app.formula}`;
      await sh(op, ["brew", "services", "stop", app.formula]);
      if ((await sh(op, ["brew", "uninstall", app.formula])) !== 0) throw new Error("brew uninstall failed");
    }
    if (app.cask) {
      op.step = `brew uninstall --cask ${app.cask}`;
      if ((await sh(op, ["brew", "uninstall", "--cask", app.cask])) !== 0) throw new Error("brew uninstall --cask failed");
    }
    if (config.names) { const note = await removeName(id); if (note) op.log += note + "\n"; }
    const rm = config.apps.link?.remove;
    if (rm && app.href && config.apps.link?.url && app.href.startsWith(config.apps.link.url.replaceAll("{id}", id))) {
      op.step = "Removing its address";
      if ((await sh(op, ["sh", "-c", rm.replaceAll("{id}", id)], HOME, 120_000)) !== 0) op.log += "Could not remove the address — remove it by hand\n";
    }
    rmSync(appFile(id), { force: true }); rmSync(readyFile(id), { force: true });
    if (purge) { op.step = "Deleting data"; rmSync(d, { recursive: true, force: true }); }
    else op.log += `Data kept in ${d}\n`;
  });
}

/** No automatic method: leave a task in the root agent's inbox (the agent kit's CLAUDE.md tells it to check). */
export function askAgent(catalogId: string, note: string, actor: string): string {
  const item = getItem(catalogId);
  const inbox = join(dir("agent"), "inbox");
  mkdirSync(inbox, { recursive: true });
  const f = join(inbox, `${new Date().toISOString().replace(/[:.]/g, "-")}-install-${slugify(item?.name ?? catalogId)}.md`);
  writeFileSync(f, `# Install request: ${item?.name ?? catalogId}\n\nRequested by: ${actor}\n\n${item ? `- Description: ${item.description}\n- Website: ${item.website ?? "—"}\n- Repo: ${item.repo ?? "—"}\n- Known install options: ${item.install.map((o) => `${o.method}:${o.ref}`).join(", ") || "none"}\n` : ""}\n${note ? `Note from the user: ${note}\n\n` : ""}Follow the add-app skill: write a recipe in <home>/config/recipes/, install it through the Server OS API, verify it, and report back.\n`);
  return f;
}

export function startInstaller() { publish(); }
