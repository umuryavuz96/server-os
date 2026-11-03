// Each agent's share of this week's Claude usage, from the Claude Code transcripts (~/.claude/projects/**/*.jsonl).
// Tokens are summed per SESSION since the weekly window opened (resets_at minus 7 days), priced at API list prices (costs.ts),
// and a session counts for the agent that owned it when it was seen on the network. The share is the agent's cost divided
// by all Claude Code usage on this machine in the same window. Byte offsets are kept, so only new lines are read.
// The ledger lives in var/data/agent-usage.json; a new weekly window starts it again (archived agents stay for History).
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { HOME } from "./lib";
import { dir } from "./core/config";
import { loadUsageState } from "./claude";
import { costUsd, loadPrices, priceFor, type Tok } from "./modules/costs";
import { usageMode, type ModeInfo } from "./modelRouting";

interface Ledger { resetsAt: number; weekStart: number; files: Record<string, { off: number; sid: string }>; sessions: Record<string, Record<string, Tok>>; owners: Record<string, string> }
export interface AgentShare { share: number; cost: number; tokens: number }
export interface UsageView { at: number; weekStart: number; resetsAt: number; total: number; scanning: boolean; agents: Record<string, AgentShare>; mode: ModeInfo }

const FILE = () => join(process.env.AGENT_USAGE_DIR ?? dir("data"), "agent-usage.json");
const ROOT = () => process.env.CLAUDE_PROJECTS_DIR ?? join(HOME, ".claude", "projects");
const WEEK = 7 * 86400;
let L: Ledger | null = null, busy = false, again = false, timer: ReturnType<typeof setTimeout> | null = null;
let lastKey = "";
const subs = new Set<(v: UsageView) => void>();

const blank = (resetsAt: number): Ledger => ({ resetsAt, weekStart: resetsAt - WEEK, files: {}, sessions: {}, owners: {} });
function load(): Ledger | null { try { return JSON.parse(readFileSync(FILE(), "utf8")) as Ledger; } catch { return null; } }
function save() { if (!L) return; mkdirSync(dirname(FILE()), { recursive: true }); writeFileSync(FILE(), JSON.stringify(L)); }

/** When the weekly window resets (epoch seconds), from the live Claude usage; null when unknown. */
export function weekResetsAt(): number | null {
  const last = loadUsageState().last;
  const w = last?.windows?.find((x) => x.key === "seven_day")?.resetsAt ?? last?.week?.resetsAt ?? null;
  return w ? Number(w) : null;
}

/** Add one chunk of transcript lines (whole lines) to a session's token sums; only lines at or after `since` (ms). */
export function ingestSession(chunk: string, since: number, into: Record<string, Tok>) {
  const last = new Map<string, { model: string; u: any }>();
  for (const line of chunk.split("\n")) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
    let o: any; try { o = JSON.parse(line); } catch { continue; }
    const m = o.message, u = m?.usage;
    if (o.type !== "assistant" || !u || !m.model || m.model === "<synthetic>" || !o.timestamp || Date.parse(o.timestamp) < since) continue;
    last.set(`${m.id ?? o.uuid}|${o.requestId ?? ""}`, { model: String(m.model), u }); // streaming repeats a message: the last copy wins
  }
  for (const { model, u } of last.values()) {
    const c = u.cache_creation ?? {}, w1 = Number(c.ephemeral_1h_input_tokens ?? 0), w5 = c.ephemeral_5m_input_tokens != null ? Number(c.ephemeral_5m_input_tokens) : Number(u.cache_creation_input_tokens ?? 0) - w1;
    const t = (into[model] ??= [0, 0, 0, 0, 0, 0]);
    t[0] += Number(u.input_tokens ?? 0); t[1] += Number(u.output_tokens ?? 0); t[2] += Number(u.cache_read_input_tokens ?? 0); t[3] += Math.max(0, w5); t[4] += w1; t[5]++;
  }
}
/** A subagent's own log (<sid>/subagents/agent-x.jsonl) counts for its parent session. */
export const sessionOf = (path: string) => (path.includes("/subagents/") ? basename(dirname(dirname(path))) : basename(path, ".jsonl"));

function* walk(d: string, depth: number, since: number): Generator<{ path: string; size: number }> {
  let ents: import("node:fs").Dirent[] = [];
  try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = join(d, e.name);
    if (e.isDirectory() && depth < 3) yield* walk(p, depth + 1, since);
    else if (e.isFile() && e.name.endsWith(".jsonl")) { try { const st = statSync(p); if (st.mtimeMs >= since) yield { path: p, size: st.size }; } catch { /* gone */ } }
  }
}

async function scan() {
  const resets = weekResetsAt();
  if (!resets) return;
  if (!L) L = load();
  if (!L || Math.abs(L.resetsAt - resets) > 3600) L = blank(resets); // a new weekly window: start again
  L.resetsAt = resets; L.weekStart = resets - WEEK;
  const since = L.weekStart * 1000;
  for (const f of walk(ROOT(), 0, since)) {
    const prev = L.files[f.path] ?? { off: 0, sid: sessionOf(f.path) };
    if (f.size <= prev.off) continue;
    let text = "";
    try { text = await Bun.file(f.path).slice(prev.off, f.size).text(); } catch { continue; }
    const end = text.lastIndexOf("\n");
    if (end < 0) continue;
    text = text.slice(0, end + 1);
    ingestSession(text, since, (L.sessions[prev.sid] ??= {}));
    L.files[f.path] = { ...prev, off: prev.off + Buffer.byteLength(text) };
    await new Promise((r) => setTimeout(r, 0)); // let the server breathe between files
  }
  for (const p of Object.keys(L.files)) if (!existsSync(p)) delete L.files[p];
  save();
}

/** Remember which agent owns which session (called whenever the network sees a live session). */
export function noteOwners(map: Record<string, string>) {
  if (!L) L = load();
  const resets = weekResetsAt();
  if (!L && resets) L = blank(resets);
  if (!L) return false;
  let changed = false;
  for (const [sid, key] of Object.entries(map)) if (sid && L.owners[sid] !== key) { L.owners[sid] = key; changed = true; }
  return changed;
}

export function view(now = Date.now()): UsageView | null {
  if (!L) L = load();
  if (!L) return null;
  const table = loadPrices(), cost = (s: Record<string, Tok>) => Object.entries(s).reduce((a, [m, t]) => { const p = priceFor(m, table); return a + (p ? costUsd(t, p) : 0); }, 0);
  const tok = (s: Record<string, Tok>) => Object.values(s).reduce((a, t) => a + t[0] + t[1] + t[2] + t[3] + t[4], 0);
  let total = 0; const per: Record<string, { cost: number; tokens: number }> = {};
  for (const [sid, s] of Object.entries(L.sessions)) {
    const c = cost(s); total += c;
    const key = L.owners[sid]; if (!key) continue;
    const e = (per[key] ??= { cost: 0, tokens: 0 }); e.cost += c; e.tokens += tok(s);
  }
  const agents: Record<string, AgentShare> = {};
  for (const [k, e] of Object.entries(per)) agents[k] = { share: total ? Math.round((e.cost / total) * 1000) / 10 : 0, cost: Math.round(e.cost * 100) / 100, tokens: e.tokens };
  return { at: now, weekStart: L.weekStart, resetsAt: L.resetsAt, total: Math.round(total * 100) / 100, scanning: busy, agents, mode: usageMode() };
}

/** Look at the transcripts soon (debounced) and tell subscribers when the numbers moved. Called when a transcript changes. */
let due = 0;
export function kickUsage(delay = 20_000) {
  const at = Date.now() + delay;
  if (timer) { if (at >= due) return; clearTimeout(timer); } // a sooner look replaces a later one
  due = at;
  timer = setTimeout(async () => {
    timer = null;
    if (busy) { again = true; return; }
    busy = true;
    try { await scan(); } catch { /* try again on the next change */ }
    busy = false;
    publish();
    if (again) { again = false; kickUsage(); }
  }, delay);
}
function publish() {
  const v = view(); if (!v) return;
  const key = JSON.stringify([v.total, v.agents, v.mode.mode, v.mode.usagePct]);
  if (key === lastKey) return;
  lastKey = key;
  for (const s of subs) s(v);
}
export function onUsage(cb: (v: UsageView) => void) { subs.add(cb); return () => subs.delete(cb); }
/** Owners changed or a client asked: make sure a scan is on its way (the first one runs at once). */
export function ensureUsage() { if (!L && !busy) kickUsage(50); else kickUsage(); }
export const _reset = () => { L = null; busy = false; again = false; lastKey = ""; if (timer) clearTimeout(timer); timer = null; };
