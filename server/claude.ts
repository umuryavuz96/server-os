// Claude on this Mac: the account's usage limits and every Claude process running right now.
//
// Usage: the same numbers Claude Code's /usage shows (5-hour session window + weekly window), read from
// Anthropic's OAuth usage endpoint with the login token Claude Code keeps in the macOS keychain. The token
// is read per request and never stored, logged or sent anywhere else.
//
// Jobs: every `claude` process, classified (Telegram bot session, headless/SDK run, interactive terminal),
// with how long it has been running and what started it. Ended jobs stay listed for 10 minutes so the
// dashboard can show them come and go.
import { join } from "node:path";
import { basename } from "node:path";
import { HOME, run, every } from "./lib";
import { logEvent } from "./core/logger";
import { setSlice } from "./store";
import { dir } from "./core/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

export interface ClaudeUsage {
  plan: string | null;
  session: { pct: number; resetsAt: number | null } | null;
  week: { pct: number; resetsAt: number | null } | null;
  /** Every limit window the API returned, in display order (5-hour, week, then per-model and any new ones). session and
   *  week stay for older clients (iOS app, widget); new clients draw this list. Absent in states saved before 2026-10-31. */
  windows?: UsageWindow[];
  /** The response carries five_hour: null next to a weekly window: the plan has no 5-hour limit (Ultra, 2026-10-30). */
  noSessionLimit?: boolean;
  fetchedAt: number;
  /** Set when the last read failed; session/week then hold the last good numbers (from fetchedAt). */
  error: string | null;
}

export interface UsageWindow { key: string; label: string; pct: number; resetsAt: number | null; hours: number | null }

export interface ClaudeJob {
  pid: number;
  kind: "bot" | "headless" | "interactive";
  label: string;
  detail: string;
  model: string | null;
  cwd: string | null;
  startedAt: number;
  cpu: number;
  memMB: number;
  endedAt: number | null;
}

const toEpoch = (iso: string | null | undefined) => (iso ? Math.floor(Date.parse(iso) / 1000) : null);

async function token(): Promise<{ accessToken: string; plan: string | null } | null> {
  // macOS keeps Claude Code's login in the Keychain; Linux in ~/.claude/.credentials.json.
  let raw = "";
  if (process.platform === "darwin") {
    const r = await run(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"], 5_000);
    if (r.code === 0) raw = r.out;
  } else {
    try { raw = await Bun.file(join(HOME, ".claude", ".credentials.json")).text(); } catch { /* not logged in */ }
  }
  if (!raw) return null;
  try {
    const o = JSON.parse(raw).claudeAiOauth ?? {};
    // the Keychain tier is frozen at login (a plan upgrade never rewrites it); ~/.claude.json's profile is refetched by Claude Code
    let prof: { organizationRateLimitTier?: string } = {};
    try { prof = JSON.parse(readFileSync(join(HOME, ".claude.json"), "utf8")).oauthAccount ?? {}; } catch { /* no profile */ }
    const tier = String(prof.organizationRateLimitTier ?? o.rateLimitTier ?? "");
    const plan = planName(o.subscriptionType, tier);
    return o.accessToken ? { accessToken: o.accessToken, plan } : null;
  } catch { return null; }
}

/** Set by readUsage when Anthropic answers 429: no new request before this time (ms). */
let retryAt = 0;
/** Consecutive 429s; drives the doubling backoff. Reset on success. */
let strikes = 0;

/** Backoff after a 429: Retry-After (if sent) or 180 s, doubled per repeated 429, capped at 15 min, +-20% jitter. */
export function backoffMs(strike: number, retryAfterSec = 0, rand = Math.random): number {
  const base = (retryAfterSec > 0 ? retryAfterSec : 180) * 1000 * 2 ** Math.max(0, strike - 1);
  return Math.min(900_000, Math.round(base * (0.8 + rand() * 0.4)));
}

const stateFile = () => join(dir("data"), "claude-usage.json");
export interface UsageState { last: ClaudeUsage | null; retryAt: number; strikes: number }

export function saveUsageState(st: UsageState, file = stateFile()) {
  try { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, JSON.stringify(st)); } catch { /* best effort */ }
}
export function loadUsageState(file = stateFile()): UsageState {
  try {
    if (!existsSync(file)) return { last: null, retryAt: 0, strikes: 0 };
    const o = JSON.parse(readFileSync(file, "utf8"));
    const l = o.last;
    const ok = l && typeof l.fetchedAt === "number" && (l.session || l.week || l.windows?.length);
    // a state saved before the Ultra rename still says "Max 20x"
    return { last: ok ? { ...l, plan: l.plan === "Max 20x" ? "Ultra" : l.plan === "Max 5x" ? "Max" : l.plan, error: null } : null, retryAt: Number(o.retryAt) || 0, strikes: Number(o.strikes) || 0 };
  } catch { return { last: null, retryAt: 0, strikes: 0 }; }
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null;

/** One usage window ({ utilization, resets_at }) → { pct, resetsAt }; utilization may come as a number or a numeric string. */
export function readWindow(w: unknown): { pct: number; resetsAt: number | null } | null {
  if (!w || typeof w !== "object" || Array.isArray(w)) return null;
  const o = w as Record<string, unknown>;
  if (o.is_enabled === false || o.enabled === false) return null; // e.g. extra_usage while extra usage is switched off
  const pct = num(o.utilization);
  return pct == null ? null : { pct, resetsAt: typeof o.resets_at === "string" ? toEpoch(o.resets_at) : num(o.resets_at) };
}

// Labels for the windows we know; anything new gets a readable name from its key ("seven_day_haiku" → "Week · Haiku").
const WINDOW_LABEL: Record<string, string> = {
  five_hour: "Session · 5 h", seven_day: "Week", seven_day_opus: "Week · Opus", seven_day_sonnet: "Week · Sonnet", seven_day_oauth_apps: "Week · apps",
};
const ORDER = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"];
const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
export function windowLabel(key: string): string {
  if (WINDOW_LABEL[key]) return WINDOW_LABEL[key];
  const m = /^(five_hour|seven_day)_(.+)$/.exec(key);
  if (m) return `${WINDOW_LABEL[m[1]]} · ${m[2].split("_").map(cap).join(" ")}`;
  return cap(key.replace(/_/g, " "));
}
/** How long the window is, for the "time left" bar: five_hour → 5, seven_day* → 168, unknown → null. */
const windowHours = (key: string) => (key.startsWith("five_hour") ? 5 : key.startsWith("seven_day") ? 168 : null);

/** The OAuth usage response → ClaudeUsage: every key whose value is a window with a utilization, nothing hard-coded.
 *  A null window is not drawn; five_hour: null beside a weekly window means the plan has no 5-hour limit. */
export function parseUsage(j: Record<string, unknown>, plan: string | null, now: number): ClaudeUsage {
  const windows: UsageWindow[] = [];
  for (const [key, v] of Object.entries(j)) {
    const w = readWindow(v);
    if (w) windows.push({ key, label: windowLabel(key), hours: windowHours(key), ...w });
  }
  const rank = (k: string) => (ORDER.includes(k) ? ORDER.indexOf(k) : ORDER.length);
  windows.sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key));
  const pick = (k: string) => { const w = windows.find((x) => x.key === k); return w ? { pct: w.pct, resetsAt: w.resetsAt } : null; };
  const week = pick("seven_day");
  return { plan, session: pick("five_hour"), week, windows, noSessionLimit: j.five_hour === null && !!week, fetchedAt: now, error: null };
}

/** Plan name for the card. The Keychain/profile still say "max" + a 20x tier; Anthropic renamed Max 20x to Ultra
 *  (2026-10-30) and Max 5x is plain Max. A plan name the profile already spells differently passes through. */
export function planName(subscription: string | null | undefined, tier: string | null | undefined): string | null {
  if (!subscription) return null;
  const sub = String(subscription).toLowerCase(), x = /(\d+)x/.exec(String(tier ?? ""))?.[1];
  if (sub === "max") return x === "20" ? "Ultra" : "Max";
  return cap(String(subscription)) + (x ? ` ${x}x` : "");
}

const shapeOf = (v: unknown): string => v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "object"
  ? `{${Object.entries(v as object).map(([k, x]) => `${k}:${x === null ? "null" : typeof x}`).join(",")}}` : typeof v;

let lastShape = "";
export async function readUsage(): Promise<ClaudeUsage> {
  const now = Math.floor(Date.now() / 1000);
  const t = await token();
  if (!t) return { plan: null, session: null, week: null, fetchedAt: now, error: "No Claude Code login found in the keychain" };
  try {
    const r = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${t.accessToken}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "server-os" },
      signal: AbortSignal.timeout(15_000),
    });
    if (r.status === 429) {
      // The usage endpoint is rate limited (roughly one read per two minutes); honour Retry-After, else wait 3 min.
      strikes++;
      retryAt = Date.now() + backoffMs(strikes, Number(r.headers.get("retry-after")));
    }
    if (!r.ok) return { plan: t.plan, session: null, week: null, fetchedAt: now, error: `Usage API HTTP ${r.status}` };
    const j = await r.json() as Record<string, unknown>;
    const u = parseUsage(j, t.plan, now);
    // Only the shape (keys and value types, never values or the token), so a changed response can be diagnosed.
    // The response's shape (keys and value types only, never values or the token), logged when it changes, so a new
    // window or a renamed field can be seen in Logs.
    const shape = Object.entries(j).map(([k, v]) => `${k}=${shapeOf(v)}`).join(" ");
    if (shape !== lastShape) { lastShape = shape; logEvent("info", "Claude usage response shape", { module: "claude", shape }); }
    return u;
  } catch (e) {
    return { plan: t.plan, session: null, week: null, fetchedAt: now, error: String(e).slice(0, 120) };
  }
}

/** ps "etime" ([[dd-]hh:]mm:ss) → seconds. */
function etimeSeconds(e: string): number {
  const [d, rest] = e.includes("-") ? e.split("-") : ["0", e];
  const p = rest.split(":").map(Number);
  const [h, m, s] = p.length === 3 ? p : [0, p[0], p[1]];
  return Number(d) * 86400 + h * 3600 + m * 60 + s;
}

const seen = new Map<number, ClaudeJob>();

export async function readJobs(): Promise<ClaudeJob[]> {
  const now = Math.floor(Date.now() / 1000);
  const ps = await run(["ps", "-axo", "pid=,ppid=,etime=,%cpu=,rss=,command="], 5_000);
  const rows = ps.out.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = /^(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(l);
    return m ? { pid: +m[1], ppid: +m[2], etime: m[3], cpu: +m[4], rss: +m[5], cmd: m[6] } : null;
  }).filter((r): r is NonNullable<typeof r> => !!r);
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  // The CLI only: `claude …` or …/bin/claude …, never the desktop app or its helpers.
  const claude = rows.filter((r) => /(^|\/)claude(\s|$)/.test(r.cmd) && !/Claude\.app|Helper|claude-mem|chrome-native/.test(r.cmd));

  const live = new Set<number>();
  for (const r of claude) {
    live.add(r.pid);
    const model = /--model\s+(\S+)/.exec(r.cmd)?.[1] ?? null;
    let kind: ClaudeJob["kind"], label: string, detail: string;
    if (r.cmd.includes("--channels")) {
      kind = "bot";
      label = "Telegram bot";
      detail = "Bot session";
    } else if (r.cmd.includes("--output-format stream-json") || r.cmd.includes(" -p ") || r.cmd.includes("--print")) {
      kind = "headless";
      const parent = byPid.get(r.ppid);
      const origin = parent ? basename(parent.cmd.split(/\s+/)[0]) : "unknown";
      label = r.cmd.includes("--max-turns 1") ? "One-shot task" : "Agent run";
      detail = `Started by ${origin}`;
    } else {
      kind = "interactive";
      label = "Terminal session";
      detail = r.cmd.replace(/^\S*claude\s*/, "").slice(0, 80) || "claude";
    }
    const prev = seen.get(r.pid);
    seen.set(r.pid, {
      pid: r.pid, kind, label, detail, model, cwd: prev?.cwd ?? null,
      startedAt: prev?.startedAt ?? now - etimeSeconds(r.etime), cpu: Math.round(r.cpu), memMB: Math.round(r.rss / 1024), endedAt: null,
    });
  }
  // Working folder for new processes only (lsof is slow-ish).
  await Promise.all([...seen.values()].filter((j) => live.has(j.pid) && j.cwd === null).map(async (j) => {
    const r = await run(["lsof", "-a", "-p", String(j.pid), "-d", "cwd", "-Fn"], 3_000);
    j.cwd = (r.out.split("\n").find((l) => l.startsWith("n"))?.slice(1) ?? "").replace(process.env.HOME ?? "", "~") || "";
  }));
  // Name things by where they run: ~/bots/<name> is that bot, ~ is the main bot, claude-mem runs its memory observer.
  for (const j of seen.values()) {
    if (!j.cwd) continue;
    if (j.kind === "bot") j.label = j.cwd === "~" ? "Main bot" : /\/bots\/([^/]+)/.exec(j.cwd)?.[1] ?? basename(j.cwd);
    else if (j.cwd.includes("claude-mem")) { j.label = "Memory observer"; j.detail = "claude-mem, saving this session's notes"; }
    else if (j.kind === "interactive") j.label = `Terminal · ${basename(j.cwd)}`;
  }
  for (const [pid, j] of seen) {
    if (!live.has(pid) && j.endedAt === null) j.endedAt = now;
    if (j.endedAt !== null && now - j.endedAt > 600) seen.delete(pid);
  }
  return [...seen.values()].sort((a, b) => Number(a.endedAt !== null) - Number(b.endedAt !== null) || b.startedAt - a.startedAt);
}

let lastRead = 0, last: ClaudeUsage | null = null, failing: string | null = null;
/** Restore the persisted numbers and backoff so a restart shows data at once and doesn't fire into a 429. */
export function restoreUsage() {
  const st = loadUsageState();
  last = st.last; retryAt = st.retryAt; strikes = st.strikes;
  if (last) setSlice("claudeUsage", retryAt > Date.now() ? { ...last, error: "Rate limited, retrying" } : last);
}
/** Read the usage numbers now (at most every 15 s, so a button can't hammer Anthropic) and push them to the panel.
 *  A failed read keeps the last good numbers on screen with the error beside them, instead of blanking the card. */
export async function refreshUsage(force = false) {
  if (!force && Date.now() - lastRead < 15_000) return;
  if (Date.now() < retryAt) return;
  lastRead = Date.now();
  const u = await readUsage();
  if (u.error) {
    // Log once per new cause, and again when it clears, so a flapping API doesn't fill the log.
    if (u.error !== failing) logEvent("warn", `Claude usage read failed: ${u.error}`, { module: "claude", retry_at: retryAt ? new Date(retryAt).toISOString() : null });
    failing = u.error;
    saveUsageState({ last, retryAt, strikes });
    setSlice("claudeUsage", last?.session || last?.week ? { ...last, plan: u.plan ?? last.plan, error: u.error } : u);
    return;
  }
  if (failing) logEvent("info", "Claude usage read works again", { module: "claude", was: failing });
  failing = null; last = u; strikes = 0; retryAt = 0;
  saveUsageState({ last, retryAt, strikes });
  setSlice("claudeUsage", u);
}

export function startClaudeCollectors() {
  // Every 2 min: the usage endpoint answers 429 to anything faster (2026-10-23, every other 1-min read failed).
  restoreUsage();
  every(120_000, () => refreshUsage(true));
  every(5_000, async () => { setSlice("claudeJobs", await readJobs()); });
}
