// Read-only live view of the agmsg network (cross-agent messaging, ~/.agents/skills/agmsg). Data comes ONLY from
// agmsg's own JSON script (scripts/api.sh get teams [...]); its database and teams/ files are never opened and
// nothing is ever sent or changed. One poller (every few seconds) runs while at least one page is subscribed and
// pushes new messages to every open SSE stream.
import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { HOME } from "./lib";
import type { Env } from "./core/http";
import { CONFIG_FILE, dir } from "./core/config";
import { logEvent } from "./core/logger";
import { kickUsage, noteOwners, onUsage, view as usageView } from "./agentUsage";
import { publicItem } from "./modules/bots/steps";
import { readAgentTasks, mergeTasks, taskFile, TASKS_DIR } from "./agentTasks";
import { Transcript, projectDir, latestTranscript, type FeedItem } from "./modules/bots/transcript";

const DIR = (process.env.AGMSG_DIR ?? join(HOME, ".agents", "skills", "agmsg")).replace(/\/+$/, "");
const API = join(DIR, "scripts", "api.sh");
const INITIAL = 3000; // messages kept per team on the first read
const KEEP = 4000;
const BODY_MAX = 1600;
const POLL_MS = 3000; // the chat stream's own look when nothing else runs
const RESYNC_MS = 30_000; // the network is pushed by file events; this slow pass only catches what a watcher missed
const DEBOUNCE_MS = 150;

export type MsgKind = "stop" | "bug" | "question" | "report" | "status";
export interface NetMsg { id: number; team: string; from: string; to: string; body: string; at: number; kind: MsgKind | null }
/** A message's type, from its wording (first match wins): an order to stop, a bug, a question, a report, a status note. */
export function msgKind(body: string): MsgKind | null {
  const b = body.slice(0, 600);
  if (/\b(STOP|SHELVED)\b/.test(b) || /\b(stand down|halt)\b|\bstop (now|work|all)\b|\bpause (now|work)\b/i.test(b)) return "stop";
  if (/\b(bug|crash(es|ed)?|broken|regression|fails?|failed|failing|error)\b/i.test(b)) return "bug";
  if (/[a-z)]\?(\s|$)/i.test(b) || /\bplease confirm\b/i.test(b)) return "question";
  if (/\b(done|shipped|finished|completed|merged|committed|ready|report|landed)\b/i.test(b)) return "report";
  if (/\b(status|progress|FYI|ack|update|working on|now on|starting)\b/i.test(b)) return "status";
  return null;
}
export interface NetMember { name: string; team: string; types: string[]; project: string | null }
/** One team's picture: the job it was built for, who reports to whom (or `flat`: peers, no lead), roles, group labels,
 *  and what is archived (`true` = the whole team, or a list of agent names). Archived agents are only hidden by the
 *  page; agmsg keeps their data. */
export interface TeamHierarchy { job?: string; staff?: boolean; root?: string; flat?: boolean; parent?: Record<string, string>; role?: Record<string, string>; groups?: Record<string, string>; archived?: boolean | string[] }
/** The main assistant that builds and runs the teams; shown above every team. `agent` is its agmsg name (the page
 *  shows it as `name` wherever it appears); `cwd` finds its live session. */
export interface Director { agent?: string; name: string; role?: string; cwd?: string }
export interface NetConfig { director: Director | null; teams: Record<string, TeamHierarchy> }
export interface Snapshot { at: number; teams: string[]; members: NetMember[]; messages: NetMsg[]; total: Record<string, number>; hierarchy: Record<string, TeamHierarchy>; director: AgentInfo | null; agents: Record<string, AgentInfo>; clusters: NetCluster[]; temps: TempAgent[] }
/** One box on the chart: a job team, the standing staff, or (later) temp agents. Same rules as the web page, so every
 *  client draws the same picture. `manager` is "@director" or a member name; `done` = archived (behind History). */
export interface ClusterMember { key: string; name: string; manager: string; archived: boolean; external: boolean }
export interface NetCluster { id: string; team: string; label: string; kind: "job" | "staff" | "temp"; done: boolean; lead: string | null; members: ClusterMember[] }
/** Clusters from teams, members, messages and the hierarchy file: staff first, then teams by name; the director's agmsg
 *  name is never a member; an agent sits in the first cluster that has it; a flat team (or one without parent/root)
 *  reports straight to the director. Archived teams and agents are included and marked, so clients can offer History. */
export function buildClusters(teamNames: string[], mem: NetMember[], messages: NetMsg[], cfg: Record<string, TeamHierarchy>, dirAgent: string | null): NetCluster[] {
  const order = [...teamNames].sort((a, b) => Number(!!cfg[b]?.staff) - Number(!!cfg[a]?.staff) || a.localeCompare(b));
  const seen = new Set<string>(), out: NetCluster[] = [];
  for (const t of order) {
    const h = cfg[t] ?? {}, arch = h.archived === true, names: { name: string; external: boolean }[] = [];
    const add = (n: string, external: boolean) => { if (n === dirAgent || seen.has(n)) return; seen.add(n); names.push({ name: n, external }); };
    for (const m of mem) if (m.team === t) add(m.name, false);
    for (const m of messages) if (m.team === t) { add(m.from, true); add(m.to, true); }
    if (!names.length) continue;
    const inside = new Set(names.map((x) => x.name));
    const managerOf = (n: string) => { if (h.flat) return "@director"; const p = h.parent?.[n] ?? (h.root && n !== h.root ? h.root : undefined); return p && p !== n && inside.has(p) ? p : "@director"; };
    const members = names.map(({ name, external }) => ({ key: `${t}/${name}`, name, manager: managerOf(name), archived: arch || (Array.isArray(h.archived) && h.archived.includes(name)), external }));
    const lead = !h.flat && h.root && inside.has(h.root) ? h.root : null;
    out.push({ id: "c:" + t, team: t, label: h.job ?? t, kind: h.staff ? "staff" : "job", done: arch, lead, members });
  }
  return out;
}

/** Lives with the owner's config (it names real agents and projects), never in the repo;
 *  config/agmsg-hierarchy.example.json shows the format. A file without "teams" is the older team map. */
export function netConfig(): NetConfig {
  const f = join(dirname(CONFIG_FILE), "agmsg-hierarchy.json");
  try {
    if (existsSync(f)) {
      const j = JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;
      if (j && typeof j.teams === "object") return { director: (j.director as Director) ?? null, teams: j.teams as Record<string, TeamHierarchy> };
      return { director: null, teams: j as Record<string, TeamHierarchy> };
    }
  } catch { /* bad file: inferred trees */ }
  return { director: null, teams: {} };
}
const hierarchy = () => netConfig().teams;

// ---------- agents: which Claude Code session an agmsg name is, and what it is working on ----------
/** What the page knows about one agent (keyed "team/name"). `session` is null when no live process was found. */
export interface AgentInfo {
  team: string; name: string; template: string | null; project: string | null; job: string | null; model: string | null;
  startedAt: number | null; status: "working" | "idle" | "offline" | string; session: string | null; pid: number | null; via: string | null;
  /** What it is doing right now, from its own session: the running tool step, "thinking", or null when idle. */
  doing: string | null; agent?: string;
}
/** Optional sidecar written by whoever spawns template instances (see docs/agent-templates.md):
 *  { "<team>/<name>": { template, project, job, model, startedAt, status } }. Any field may be missing. */
export const INSTANCES_FILE = () => join(dir("data"), "agent-instances.json");
type Sidecar = Partial<Pick<AgentInfo, "template" | "project" | "job" | "model" | "startedAt" | "status">>;
function sidecar(): Record<string, Sidecar> {
  try { return JSON.parse(readFileSync(INSTANCES_FILE(), "utf8")) as Record<string, Sidecar>; } catch { return {}; }
}
export interface LiveSession { pid: number; sessionId: string; cwd: string; name: string; status: string; startedAt: number; tmux: string | null }
/** Is the process there? EPERM means it exists but belongs to someone else: still alive. */
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; } };
/** Claude Code's own per-process records (~/.claude/sessions/<pid>.json) for processes that are still running. */
export function liveSessions(): LiveSession[] {
  const d = join(HOME, ".claude", "sessions"), out: LiveSession[] = [];
  let files: string[] = [];
  try { files = readdirSync(d).filter((f) => /^\d+\.json$/.test(f)); } catch { return out; }
  for (const f of files) {
    try {
      const s = JSON.parse(readFileSync(join(d, f), "utf8")) as { pid: number; sessionId: string; cwd: string; name?: string; status?: string; startedAt?: number; tmux?: string; kind?: string };
      if (!s.pid || !s.sessionId || !alive(s.pid) || (s.kind && s.kind !== "interactive")) continue;
      out.push({ pid: s.pid, sessionId: s.sessionId, cwd: s.cwd, name: s.name ?? "", status: s.status ?? "", startedAt: s.startedAt ?? 0, tmux: s.tmux ?? null });
    } catch { /* half-written file */ }
  }
  return out;
}
let windows: Map<string, number[]> = new Map(); // tmux window name -> pane pids
async function tmuxWindows() {
  if (!Bun.which("tmux")) return;
  const r = await run2(["tmux", "list-panes", "-a", "-F", "#{window_name}\t#{pane_pid}"]);
  const m = new Map<string, number[]>();
  for (const l of r.split("\n")) { const [w, p] = l.split("\t"); if (w && p) (m.get(w) ?? m.set(w, []).get(w)!).push(Number(p)); }
  windows = m;
}
async function run2(cmd: string[]) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const t = setTimeout(() => p.kill(), 4000);
  const out = await new Response(p.stdout).text(); clearTimeout(t); return out;
}
const parentOf = new Map<number, number>();
async function processTree() {
  parentOf.clear();
  for (const l of (await run2(["ps", "-Ao", "pid=,ppid="])).split("\n")) { const [a, b] = l.trim().split(/\s+/).map(Number); if (a) parentOf.set(a, b); }
}
const under = (pid: number, root: number) => { for (let p = pid, k = 0; p > 1 && k < 12; p = parentOf.get(p) ?? 0, k++) if (p === root) return true; return false; };

/** Map an agmsg (team, name) to a live session, most certain first: the name agmsg spawn gives a session
 *  ("<team>-<name>"), the tmux window named after the agent, a bot-manager name ("<name>-<short id>"), and last
 *  a session running in the agent's project folder when that folder has only one. */
export const DIRECTOR_KEY = "@/director";
/** The director's session: the live one in its folder, preferring the bot-manager name ("<folder>-<short id>"). */
export function matchDirector(d: Director, live: LiveSession[]): LiveSession | null {
  if (!d.cwd) return null;
  const here = live.filter((s) => s.cwd === d.cwd);
  const base = basename(d.cwd);
  return here.find((s) => s.name.startsWith(base + "-")) ?? here[0] ?? null;
}
export function matchSession(team: string, name: string, project: string | null, live: LiveSession[], wins = windows): { s: LiveSession; via: string } | null {
  const exact = live.find((s) => s.name === `${team}-${name}`);
  if (exact) return { s: exact, via: "spawn name" };
  const panes = wins.get(name) ?? [];
  const inTmux = live.find((s) => panes.some((p) => under(s.pid, p)));
  if (inTmux) return { s: inTmux, via: "tmux window" };
  const short = live.find((s) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-[0-9a-z]{1,4}$`).test(s.name));
  if (short) return { s: short, via: "session name" };
  if (project) { const here = live.filter((s) => s.cwd === project); if (here.length === 1) return { s: here[0], via: "project folder" }; }
  return null;
}
/** Match every member in two passes: sure signals first (spawn name, tmux window, session name) for ALL members, then
 *  the project-folder guess for the rest. One pass in member order let an earlier team's guess steal the session of a
 *  later member that had an exact name (team-a/lead took team-b/qa-1's session: qa-1 showed offline). */
export function matchAll(mem: { team: string; name: string; project: string | null }[], live: LiveSession[], taken: Set<number>, wins = windows): Map<string, { s: LiveSession; via: string }> {
  const out = new Map<string, { s: LiveSession; via: string }>(), key = (m: { team: string; name: string }) => `${m.team}/${m.name}`;
  for (const guess of [false, true]) for (const m of mem) {
    if (out.has(key(m))) continue;
    const hit = matchSession(m.team, m.name, guess ? m.project : null, live.filter((s) => !taken.has(s.pid)), wins);
    if (hit) { taken.add(hit.s.pid); out.set(key(m), hit); }
  }
  return out;
}
const TEMPLATE_RE = /^(.+)-(\d+)$/;
let agents: Record<string, AgentInfo> = {};
let director: AgentInfo | null = null;
/** pid of a live agent session -> "team/name" (for the Ram tab). */
export const agentByPid = () => new Map(Object.entries(agents).filter(([, a]) => a.pid).map(([k, a]) => [a.pid!, k]));
let procAt = 0;
async function refreshAgents(forceProc = false) {
  if (forceProc || Date.now() - procAt > 5000) { procAt = Date.now(); await Promise.all([tmuxWindows(), processTree()]); }
  const live = liveSessions(), side = sidecar(), out: Record<string, AgentInfo> = {};
  const taken = new Set<number>();
  // the director first: its agmsg name (e.g. "root") must never be matched to some other session
  const d = netConfig().director;
  const ds = d ? matchDirector(d, live) : null;
  if (ds) taken.add(ds.pid);
  const hits = matchAll(members.filter((m) => !(d?.agent && m.name === d.agent)), live, taken);
  for (const m of members) {
    const key = `${m.team}/${m.name}`, sc = side[key] ?? {};
    if (d?.agent && m.name === d.agent) continue; // shown as the director
    const hit = hits.get(key);
    out[key] = {
      team: m.team, name: m.name, template: sc.template ?? m.name.match(TEMPLATE_RE)?.[1] ?? null,
      project: sc.project ?? hit?.s.cwd ?? m.project, job: sc.job ?? null, model: sc.model ?? modelOf.get(hit?.s.sessionId ?? "") ?? null,
      startedAt: sc.startedAt ?? (hit?.s.startedAt || null),
      status: sc.status ?? (!hit ? "offline" : hit.s.status === "busy" ? "working" : "idle"),
      session: hit?.s.sessionId ?? null, pid: hit?.s.pid ?? null, via: hit?.via ?? null, doing: null,
    };
    paths.set(key, hit ? join(projectDir(hit.s.cwd), `${hit.s.sessionId}.jsonl`) : null);
    if (hit) live1(out[key], paths.get(key)!);
  }
  agents = out;

  director = d ? { team: "@", name: d.name, agent: d.agent, template: d.role ?? "Director", project: d.cwd ?? null, job: null, model: null,
    startedAt: ds?.startedAt || null, status: !ds ? "offline" : ds.status === "busy" ? "working" : "idle", session: ds?.sessionId ?? null, pid: ds?.pid ?? null, via: ds ? "project folder" : null, doing: null } : null;
  paths.set(DIRECTOR_KEY, ds ? join(projectDir(ds.cwd), `${ds.sessionId}.jsonl`) : null);
  if (director && ds) live1(director, paths.get(DIRECTOR_KEY)!);
  // temp agents: the background subagents of the director and of every agent on the chart
  const owners: { key: string; s: LiveSession }[] = [];
  if (ds) owners.push({ key: DIRECTOR_KEY, s: ds });
  for (const [key, a] of Object.entries(out)) { const l = a.pid ? live.find((x) => x.pid === a.pid) : null; if (l) owners.push({ key, s: l }); }
  temps = scanTemps(owners);
  // each live session belongs to the agent that runs it: this is what the weekly usage share is counted by
  const own: Record<string, string> = {};
  if (ds) own[ds.sessionId] = DIRECTOR_KEY;
  for (const [key, a] of Object.entries(out)) if (a.session) own[a.session] = key;
  kickUsage(noteOwners(own) ? 300 : 20_000);
}

// ---------- temp agents: in-process Agent/Task subagents of a live session (read-only) ----------
/** One background subagent. `parent` is the "<team>/<name>" (or "@/director") of the session that started it. */
export interface TempAgent { key: string; id: string; parent: string; description: string; agentType: string; model: string | null; startedAt: number; lastAt: number; running: boolean; ended: "finished" | "stopped" | null }
const TEMP_TEAM = "@temp", TEMP_STALE_MS = 10 * 60_000, TEMP_HISTORY_MS = 6 * 3600_000;
let temps: TempAgent[] = [];
const tempDirs = new Set<string>();
const metaCache = new Map<string, { m: number; meta: Record<string, unknown> }>();
const subDir = (s: LiveSession) => join(projectDir(s.cwd), s.sessionId, "subagents");
/** Running = not marked finished, written in the last 10 minutes, and its last line is not an interrupt. Finished or
 *  stopped ones stay for 6 hours as history. */
export function tempState(meta: Record<string, unknown>, lastAt: number, tail: string, nowMs = Date.now()): { running: boolean; ended: TempAgent["ended"] } {
  if (meta.finished) return { running: false, ended: "finished" };
  if (nowMs - lastAt > TEMP_STALE_MS || /\[Request interrupted/.test(tail)) return { running: false, ended: "stopped" };
  return { running: true, ended: null };
}
function scanTemps(owners: { key: string; s: LiveSession }[]): TempAgent[] {
  const list: TempAgent[] = [], now = Date.now();
  tempDirs.clear();
  for (const { key, s } of owners) {
    const d = subDir(s);
    let files: string[] = [];
    try { files = readdirSync(d).filter((f) => f.endsWith(".meta.json")); } catch { continue; }
    tempDirs.add(d);
    for (const f of files) {
      const id = f.replace(/^agent-/, "").replace(/\.meta\.json$/, ""), mf = join(d, f), jf = join(d, `agent-${id}.jsonl`);
      let mm = 0, lastAt = 0, born = 0;
      try { mm = statSync(mf).mtimeMs; born = statSync(mf).birthtimeMs; } catch { continue; }
      try { lastAt = statSync(jf).mtimeMs; } catch { lastAt = mm; }
      if (now - lastAt > TEMP_HISTORY_MS) continue;
      let c = metaCache.get(mf);
      if (!c || c.m !== mm) { try { c = { m: mm, meta: JSON.parse(readFileSync(mf, "utf8")) }; metaCache.set(mf, c); } catch { continue; } }
      const st = tempState(c.meta, lastAt, now - lastAt < TEMP_STALE_MS ? tailBytes(jf) : "", now);
      const tk = `${TEMP_TEAM}/${id}`;
      paths.set(tk, existsSync(jf) ? jf : null);
      list.push({ key: tk, id, parent: key, description: String(c.meta.description ?? "Background task"), agentType: String(c.meta.agentType ?? "agent"), model: (c.meta.model as string) ?? null, startedAt: born || lastAt, lastAt, ...st });
    }
  }
  return list.sort((a, b) => Number(b.running) - Number(a.running) || b.lastAt - a.lastAt).slice(0, 24);
}
/** The last few hundred bytes of a file, without reading all of it (subagent logs run to megabytes). */
function tailBytes(file: string, n = 600): string {
  try {
    const size = statSync(file).size, fd = openSync(file, "r");
    const buf = Buffer.alloc(Math.min(n, size));
    readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
    closeSync(fd);
    return buf.toString("utf8");
  } catch { return ""; }
}
/** Fill model and "doing" from the session's own transcript (read incrementally; a turn in progress = working). */
function live1(a: AgentInfo, path: string) {
  if (!existsSync(path)) return;
  const t = parser(path); t.update();
  a.model ??= t.meta.model;
  const w = t.meta.working;
  if (w) { a.status = "working"; a.doing = w.step ?? "thinking"; }
}
const paths = new Map<string, string | null>();
const modelOf = new Map<string, string>(); // session id -> model, learnt when its chat is opened

/** A temp agent in AgentInfo shape, for the chat panel header. */
function tempInfo(key: string): AgentInfo | null {
  const t = temps.find((x) => x.key === key); if (!t) return null;
  return { team: TEMP_TEAM, name: t.id, template: t.agentType, project: null, job: t.description, model: t.model, startedAt: t.startedAt, status: t.running ? "working" : "offline", session: null, pid: null, via: "subagent", doing: null };
}
// ---------- one agent's chat: its own Claude Code transcript, followed live (read-only) ----------
const parsers = new Map<string, Transcript>();
function parser(path: string) {
  let t = parsers.get(path);
  if (!t) { t = new Transcript(path, undefined, 3_000_000); t.keepSidechain = path.includes("/subagents/"); t.keepThinking = true; t.update(); parsers.set(path, t); if (parsers.size > 24) parsers.delete(parsers.keys().next().value!); }
  return t;
}
function chatPath(key: string, project: string | null): string | null {
  const p = paths.get(key);
  if (p && existsSync(p)) return p;
  return p === undefined && project ? latestTranscript(project) : null;
}

export const agmsgNetAvailable = () => existsSync(API) && !!Bun.which("sqlite3");

async function run(args: string[]): Promise<string> {
  const p = Bun.spawn(["bash", API, ...args], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: { ...process.env } });
  const t = setTimeout(() => p.kill(), 8000);
  const out = await new Response(p.stdout).text();
  clearTimeout(t);
  return out;
}
const lines = <T>(s: string): T[] => s.split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as T]; } catch { return []; } });

let teams: string[] = [];
let members: NetMember[] = [];
const msgs = new Map<number, NetMsg>(); // by id
const lastId: Record<string, number> = {};
let first = true;
const subs = new Set<(event: string, data: unknown) => void>();
let busy = false;

const toMsg = (r: { id: string; team: string; from: string; to: string; body: string; at: string }): NetMsg => ({
  id: Number(r.id), team: r.team, from: r.from, to: r.to, body: String(r.body ?? "").slice(0, BODY_MAX), at: Date.parse(r.at) || 0, kind: msgKind(String(r.body ?? "")),
});

async function poll() {
  if (busy) return;
  busy = true;
  try {
    const names = lines<{ name: string }>(await run(["get", "teams"])).map((t) => t.name);
    const mem: NetMember[] = [];
    const fresh: NetMsg[] = [];
    await Promise.all(names.map(async (team) => {
      const [m, rows] = await Promise.all([
        run(["get", "teams", team, "members"]),
        run(["get", "teams", team, "messages", "--limit", String(first ? INITIAL : 60)]),
      ]);
      for (const x of lines<{ name: string; types?: string[]; project?: string }>(m)) mem.push({ name: x.name, team, types: x.types ?? [], project: x.project ?? null });
      for (const r of lines<{ id: string; team: string; from: string; to: string; body: string; at: string }>(rows)) {
        const n = toMsg(r);
        if (!msgs.has(n.id)) { msgs.set(n.id, n); if (!first) fresh.push(n); lastId[team] = Math.max(lastId[team] ?? 0, n.id); }
      }
    }));
    teams = names.sort();
    members = mem.sort((a, b) => a.team.localeCompare(b.team) || a.name.localeCompare(b.name)); // stable order: diffs only on real change
    await refreshAgents();
    if (msgs.size > KEEP) for (const id of [...msgs.keys()].sort((a, b) => a - b).slice(0, msgs.size - KEEP)) msgs.delete(id);
    const wasFirst = first;
    first = false;
    if (!wasFirst) emit(fresh.sort((a, b) => a.id - b.id));
    else lastKey = stateKey(); // each new stream sends its own snapshot once this first read is done
    rewatchSessions();
  } catch (e) { logEvent("warn", "agmsg network read failed", { error: String(e) }); /* the next event or the resync retries */ } finally { busy = false; }
}

// ---------- reactive: file events push diffs; nothing polls on a short timer ----------
let lastKey = "";
const stateKey = () => JSON.stringify([teams, members, director, agents, hierarchy(), temps]);
/** Temp agents as one cluster under the director (finished ones are "archived": History only). */
const tempCluster = (): NetCluster[] => (!temps.length ? [] : [{ id: "c:" + TEMP_TEAM, team: TEMP_TEAM, label: "Temp agents", kind: "temp", done: !temps.some((t) => t.running), lead: null,
  members: temps.map((t) => ({ key: t.key, name: t.id, manager: "@director", archived: !t.running, external: false })) }]);
/** Push a "net" diff when there are new messages or anything about the agents changed. */
function emit(fresh: NetMsg[]) {
  const k = stateKey();
  if (!fresh.length && k === lastKey) return;
  lastKey = k;
  const all = [...msgs.values()].sort((a, b) => a.id - b.id);
  for (const s of subs) s("net", { at: Date.now(), teams, members, messages: fresh, hierarchy: hierarchy(), director, agents, clusters: [...buildClusters(teams, members, all, hierarchy(), director?.agent ?? null), ...tempCluster()], temps });
}
let pollT: ReturnType<typeof setTimeout> | null = null, agentT: ReturnType<typeof setTimeout> | null = null, procNext = false;
/** agmsg storage or team config changed: re-read through api.sh (debounced). */
function kickPoll() { if (pollT) return; pollT = setTimeout(() => { pollT = null; void poll(); }, DEBOUNCE_MS); }
/** A session file or transcript changed: re-check status and "doing" only (debounced). */
function kickAgents(proc = false) {
  procNext ||= proc;
  if (agentT) return; // one pass per 150 ms window, so a busy transcript can't starve it
  agentT = setTimeout(async () => {
    agentT = null;
    if (busy || first) { kickAgents(); return; }
    const p = procNext; procNext = false;
    await refreshAgents(p); emit([]); rewatchSessions();
  }, DEBOUNCE_MS);
}
const fixed: FSWatcher[] = [], perFile = new Map<string, FSWatcher>();
let resync: ReturnType<typeof setInterval> | null = null;
const tryWatch = (path: string, fn: (file: string | null) => void, recursive = false): FSWatcher | null => {
  try { return watch(path, { persistent: false, recursive }, (_e, f) => fn(f ? String(f) : null)); } catch { return null; }
};
/** agmsg's storage folder, asked from agmsg's own storage library (never a hand-built path). */
async function storageDir(): Promise<string | null> {
  const p = Bun.spawn(["bash", "-c", `source ${JSON.stringify(join(DIR, "scripts", "lib", "storage.sh"))} && agmsg_storage_dir`], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const out = (await new Response(p.stdout).text()).trim();
  return out && existsSync(out) ? out : null;
}
async function startWatching() {
  if (resync) return;
  resync = setInterval(() => void poll(), RESYNC_MS);
  const store = await storageDir();
  const add = (w: FSWatcher | null) => { if (w) fixed.push(w); };
  // the folder (files created/replaced) and each sqlite file (written in place: a folder watch misses that on macOS)
  if (store) { add(tryWatch(store, kickPoll)); for (const f of ["messages.db", "messages.db-wal", "messages.db-shm"]) add(tryWatch(join(store, f), kickPoll)); }
  add(tryWatch(join(DIR, "teams"), kickPoll, true));
  add(tryWatch(dirname(CONFIG_FILE), (f) => { if (!f || f.startsWith("agmsg-hierarchy")) kickPoll(); }));
  add(tryWatch(dir("data"), (f) => { if (!f || f.startsWith("agent-instances")) kickAgents(); }));
  add(tryWatch(join(HOME, ".claude", "sessions"), () => kickAgents(true)));
}
function stopWatching() {
  if (resync) clearInterval(resync); resync = null;
  for (const w of fixed.splice(0)) w.close();
  for (const w of perFile.values()) w.close();
  perFile.clear();
}
/** Follow exactly the transcripts of the agents on the chart. */
function rewatchSessions() {
  if (!resync) return;
  const want = new Set([...paths.values()].filter((p): p is string => !!p));
  for (const d of tempDirs) want.add(d); // a subagent starting or finishing writes into its session's subagents folder
  for (const [p, w] of perFile) if (!want.has(p)) { w.close(); perFile.delete(p); }
  for (const p of want) if (!perFile.has(p)) { const w = tryWatch(p, () => kickAgents()); if (w) perFile.set(p, w); }
}

function snapshot(): Snapshot {
  const messages = [...msgs.values()].sort((a, b) => a.id - b.id);
  const total: Record<string, number> = {};
  for (const m of messages) total[m.team] = (total[m.team] ?? 0) + 1;
  return { at: Date.now(), teams, members, messages, total, hierarchy: hierarchy(), director, agents, clusters: [...buildClusters(teams, members, messages, hierarchy(), director?.agent ?? null), ...tempCluster()], temps };
}

export function agmsgNetRoutes(api: Hono<Env>) {
  api.get("/agmsg/network", async (c) => {
    if (!members.length) await poll(); else if (!resync) await refreshAgents(); // no live stream = no watchers: look now, never serve an old picture
    return c.json(snapshot());
  });
  // One agent's session, live: "reset" (recent items + who it is), then "items" with new or changed items only.
  api.get("/agmsg/agents/:team/:name/chat", (c) => {
    const key = `${c.req.param("team")}/${c.req.param("name")}`;
    return streamSSE(c, async (stream) => {
      if (!members.length) await poll();
      let path: string | null | undefined, t: Transcript | null = null, cursor = 0, beat = Date.now(), last = "", seen = 0;
      let fw: FSWatcher | null = null, wake: (() => void) | null = null;
      // the agent's tasks.sh file: a change wakes the loop at once (live, no reload)
      const tf = taskFile(key), tw = tf ? tryWatch(TASKS_DIR(), (f) => { if (!f || f === tf) wake?.(); }) : null;
      stream.onAbort(() => { tw?.close(); wake?.(); });
      while (!stream.aborted) {
        if (!resync && Date.now() - seen > POLL_MS) { seen = Date.now(); await refreshAgents(); } // the network page is closed: look ourselves
        const info = key === DIRECTOR_KEY ? director : agents[key] ?? tempInfo(key);
        const p = chatPath(key, info?.project ?? null);
        const meta = () => ({ agent: info, session: t?.meta ?? null, path: p ? basename(p) : null, tasks: mergeTasks(t?.tasks ?? [], readAgentTasks(key)) });
        if (p !== path) {
          fw?.close(); fw = p ? tryWatch(p, () => wake?.()) : null;
          path = p; t = p ? parser(p) : null; t?.update(); cursor = t?.cursor ?? 0;
          if (t?.meta.model && info?.session) modelOf.set(info.session, t.meta.model);
          last = JSON.stringify(meta());
          await stream.writeSSE({ event: "reset", data: JSON.stringify({ items: t ? t.items.slice(-300).map(publicItem) : [], ...meta() }) });
        } else {
          if (t) {
            t.update();
            const d = t.changedSince(cursor); cursor = d.cursor;
            if (d.ids.length) await stream.writeSSE({ event: "items", data: JSON.stringify(d.ids.map((id) => t!.get(id)).filter(Boolean).map((i) => publicItem(i!))) });
          }
          const m = JSON.stringify(meta());
          if (m !== last) { last = m; await stream.writeSSE({ event: "meta", data: m }); }
        }
        if (Date.now() - beat > 15_000) { beat = Date.now(); await stream.writeSSE({ event: "ping", data: "" }); }
        // wake on the transcript's own change event (+ a short settle), else look again after a few seconds
        await new Promise<void>((r) => { const to = setTimeout(r, POLL_MS); wake = () => { clearTimeout(to); setTimeout(r, DEBOUNCE_MS); }; });
        wake = null;
      }
      fw?.close(); tw?.close();
    });
  });
  // The same chat for clients that poll (the iOS app): pass back `session` and `total` from the last answer and get
  // only the tail since then (plus a few items before it, whose tool steps may have finished meanwhile).
  api.get("/agmsg/agents/:team/:name/snapshot", async (c) => {
    const key = `${c.req.param("team")}/${c.req.param("name")}`;
    if (!members.length) await poll(); else if (!resync) await refreshAgents();
    const info = key === DIRECTOR_KEY ? director : agents[key] ?? tempInfo(key);
    const p = chatPath(key, info?.project ?? null);
    const t = p ? parser(p) : null;
    t?.update();
    const total = t?.items.length ?? 0, since = Number(c.req.query("since") ?? -1);
    const same = !!t && c.req.query("session") === t.meta.session && since >= 0 && since <= total;
    const items = (!t ? [] : same ? t.items.slice(Math.max(0, since - 40)) : t.items.slice(-300)).map(publicItem);
    return c.json({ session: t?.meta.session ?? null, total, reset: !same, items, meta: { agent: info, session: t?.meta ?? null }, tasks: mergeTasks(t?.tasks ?? [], readAgentTasks(key)) });
  });
  api.get("/agmsg/usage", (c) => { kickUsage(50); return c.json(usageView() ?? { at: Date.now(), weekStart: 0, resetsAt: 0, total: 0, scanning: true, agents: {}, mode: null }); });
  api.get("/agmsg/stream", (c) => streamSSE(c, async (stream) => {
    const queue: Array<[string, unknown]> = [];
    let wake: (() => void) | null = null;
    const push = (e: string, d: unknown) => { queue.push([e, d]); wake?.(); };
    subs.add(push);
    const offUsage = onUsage((v) => push("usage", v));
    void startWatching();
    // a poll may already be running (a watcher fired): wait for the first full read, then send this stream its snapshot
    for (let k = 0; first && k < 300 && !stream.aborted; k++) { if (!busy) await poll(); else await stream.sleep(100); }
    await stream.writeSSE({ event: "snapshot", data: JSON.stringify(snapshot()) });
    const u0 = usageView(); if (u0) await stream.writeSSE({ event: "usage", data: JSON.stringify(u0) });
    kickUsage(50);
    stream.onAbort(() => { subs.delete(push); offUsage(); wake?.(); });
    let beat = Date.now();
    while (!stream.aborted) {
      if (!queue.length) await new Promise<void>((r) => { wake = r; setTimeout(r, 15_000); });
      wake = null;
      while (queue.length) { const [e, d] = queue.shift()!; await stream.writeSSE({ event: e, data: JSON.stringify(d) }); }
      if (Date.now() - beat > 15_000) { await stream.writeSSE({ event: "ping", data: String(Date.now()) }); beat = Date.now(); }
    }
    subs.delete(push); offUsage();
    if (!subs.size) { stopWatching(); first = true; msgs.clear(); } // nobody watching: stop, start fresh next time
  }));
}
