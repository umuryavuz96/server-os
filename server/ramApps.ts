// Ram tab: which app is a bare process (bun, node, python, npm, claude...) really part of?
// Order: launchd label of the process tree root -> listening port (Caddy route / catalog URL) -> working directory (cached per pid).
// Never reads command lines: only the binary name, the launchd label, listening ports and the cwd path.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HOME, run } from "./lib";
import { config } from "./core/config";

export interface AppRef { name: string; icon: string | null }
export interface ResolveCtx {
  /** launchd label -> pid (0 = not running) */
  launchd: Map<string, number>;
  /** listening TCP port -> pid */
  portPid: Map<number, number>;
  /** "x.home" -> "port:3066" | "static" | "remote" | ... */
  caddyTarget: Map<string, string>;
  catalog: { name: string; icon?: string; href?: string; launchd?: string[] }[];
  /** folder with the catalog's own icons (to find /icons/<name>.svg for jobs that are not in the catalog) */
  iconDir: string;
}

/** Programs that are only a runtime: they say nothing about what they run, so we look further. Everything else keeps its own name. */
export const RUNTIMES = new Set(["bun", "node", "python", "python3", "Python", "npm", "npx", "uv", "uvx", "deno", "tsx", "claude", "sh", "bash", "zsh", "ruby", "java"]);
export const isRuntime = (bin: string) => RUNTIMES.has(bin) || /^python[\d.]*$/i.test(bin) || /^node\d*$/.test(bin);

/** Server OS itself is not in the catalog. */
export const SERVER_OS: AppRef = { name: "Server OS", icon: "/app-icons/icon.svg" };
/** Jobs that are not catalog apps but deserve a proper name. label suffix -> name */
const LABELS: Record<string, AppRef> = {};
/** The user's own launchd label prefix (integrations.cron.launchd, e.g. "com.me."), "" when unset. */
const prefix = () => config.integrations.cron?.launchd ?? "";
const isOwn = (label: string) => { const p = prefix(); return !!p && label.startsWith(p); };
const isSelf = (label: string) => /\.(server-dash|server-os)$/.test(label);

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const ACR = new Set(["tts", "tv", "ftp", "api", "os", "ai", "pt", "ha", "ns", "ui", "dns", "mc", "vm"]);
const title = (s: string) => s.split(/[-_.]+/).filter(Boolean).map((w) => (ACR.has(w.toLowerCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(" ");

/** The catalog app that owns a launchd label, a squashed name or a port; else null. */
function byLabel(ctx: ResolveCtx, label: string): AppRef | null {
  if (LABELS[label]) return LABELS[label];
  if (isSelf(label)) return SERVER_OS;
  const it = ctx.catalog.find((i) => i.launchd?.includes(label));
  if (it) return { name: it.name, icon: it.icon ?? null };
  if (!isOwn(label)) return null;
  const id = label.slice(prefix().length);
  return nameApp(ctx, id);
}
/** A folder / job id such as "my-app-log": the catalog app with that name, else a title-cased name with a logo file if one exists. */
export function nameApp(ctx: ResolveCtx, id: string): AppRef {
  const k = squash(id);
  const it = ctx.catalog.find((i) => squash(i.name) === k || i.launchd?.some((l) => squash(prefix() && l.startsWith(prefix()) ? l.slice(prefix().length) : l) === k));
  if (it) return { name: it.name, icon: it.icon ?? null };
  for (const ext of ["svg", "png"]) if (existsSync(join(ctx.iconDir, `${id}.${ext}`))) return { name: title(id), icon: `/icons/${id}.${ext}` };
  return { name: title(id), icon: null };
}
function byPort(ctx: ResolveCtx, ports: number[]): AppRef | null {
  for (const port of ports) {
    for (const [host, tgt] of ctx.caddyTarget) {
      if (tgt !== "port:" + port) continue;
      const it = ctx.catalog.find((i) => { try { return new URL(i.href ?? "").hostname === host; } catch { return false; } });
      if (it) return { name: it.name, icon: it.icon ?? null };
    }
    const it = ctx.catalog.find((i) => new RegExp(`:${port}(/|$)`).test(i.href ?? ""));
    if (it) return { name: it.name, icon: it.icon ?? null };
  }
  return null;
}
/** A working directory: ~/bots/<bot>, ~/projects/<app>, ~/scripts/<job>, the claude-mem folders. Returns null for anything else. */
export function byCwd(ctx: ResolveCtx, cwd: string): AppRef | null {
  const rel = cwd.startsWith(HOME + "/") ? cwd.slice(HOME.length + 1) : null;
  if (!rel) return null;
  const [top, sub] = rel.split("/");
  if (/claude-mem/.test(rel)) return { name: "claude-mem worker", icon: null };
  if (!sub) return null;
  if (top === "bots") return nameApp(ctx, sub);
  if (top === "projects" && sub !== "_archive") return sub === "server-dash" ? SERVER_OS : nameApp(ctx, sub);
  if (top === "scripts" && sub !== "lib" && sub !== "logs") return nameApp(ctx, sub);
  return null;
}

// ---- working directories: one batched lsof, cached per pid, only for runtimes that nothing else explained ----
const cwdCache = new Map<number, string>(); // pid -> cwd ("" = looked, nothing)
let cwdBusy = false;
export function wantCwds(pids: number[]) {
  const todo = pids.filter((p) => !cwdCache.has(p)).slice(0, 200);
  if (!todo.length || cwdBusy) return;
  cwdBusy = true;
  void run(["lsof", "-a", "-d", "cwd", "-Fpn", "-p", todo.join(",")], 15_000).then((r) => {
    for (const p of todo) cwdCache.set(p, "");
    let pid = 0;
    for (const l of r.out.split("\n")) { if (l[0] === "p") pid = Number(l.slice(1)); else if (l[0] === "n" && pid) cwdCache.set(pid, l.slice(1)); }
  }).catch(() => { for (const p of todo) cwdCache.set(p, ""); }).finally(() => { cwdBusy = false; });
}
export const cwdOf = (pid: number) => cwdCache.get(pid) || "";
/** Forget pids that are gone. */
export function pruneCwds(alive: Map<number, unknown>) { for (const p of cwdCache.keys()) if (!alive.has(p)) cwdCache.delete(p); }

/** pid -> app, for every pid in `pids`. `parent` is the ppid map. Only runtimes are looked up by port and cwd. */
export function resolveProcs(ctx: ResolveCtx, pids: number[], parent: Map<number, number>, comms: Map<number, string>): Map<number, AppRef> {
  const out = new Map<number, AppRef>();
  const labelOf = new Map<number, string>();
  for (const [l, p] of ctx.launchd) if (p > 0 && (isOwn(l) || isSelf(l) || LABELS[l] || ctx.catalog.some((i) => i.launchd?.includes(l)))) labelOf.set(p, l);
  const portsOf = new Map<number, number[]>();
  for (const [port, p] of ctx.portPid) (portsOf.get(p) ?? portsOf.set(p, []).get(p)!).push(port);
  const bin = (p: number) => (comms.get(p) ?? "").split(" ")[0].split("/").pop() ?? "";
  const need: number[] = [];
  for (const pid of pids) {
    // 1. launchd label of the tree root
    let hit: AppRef | null = null;
    for (let p = pid, i = 0; p > 1 && i < 12 && !hit; p = parent.get(p) ?? 0, i++) { const l = labelOf.get(p); if (l) hit = byLabel(ctx, l); }
    if (!hit && isRuntime(bin(pid))) {
      // 2. listening port of the process or an ancestor
      for (let p = pid, i = 0; p > 1 && i < 6 && !hit; p = parent.get(p) ?? 0, i++) { const ports = portsOf.get(p); if (ports) hit = byPort(ctx, ports); }
      // 3. working directory
      if (!hit) { const c = cwdOf(pid); if (c) hit = byCwd(ctx, c); else need.push(pid); }
    }
    if (hit) out.set(pid, hit);
  }
  wantCwds(need);
  return out;
}

/** The app a Claude session belongs to by folder (~/bots/<name>), for its logo. null = plain Claude. */
export function claudeApp(ctx: ResolveCtx, cwd: string): AppRef | null {
  const full = cwd.startsWith("~/") ? HOME + cwd.slice(1) : cwd;
  const rel = full.startsWith(HOME + "/bots/") ? full.slice(HOME.length + 6).split("/")[0] : "";
  if (!rel) return null;
  const a = nameApp(ctx, rel);
  return a.icon ? a : null;
}
