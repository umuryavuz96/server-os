// Reactive client state fed by one Server-Sent Events stream. The server sends a snapshot, then only changed slices/entries.
import { reactive, computed } from "vue";

export interface AppState {
  name: string; group: string; order: number; href: string; icon: string; about: string;
  kind: "lock" | "gate" | "switch"; warn: boolean; state: "on" | "off" | "part"; parts: Record<string, boolean>; mem: number;
  /** How mem was measured (server memOf): vm footprint, docker cgroup, process tree, port owner, or why there is no number. */
  memSrc?: "vm" | "docker" | "process" | "port" | "static" | "remote" | "unknown" | "off";
}
export interface RamOther { appsMB: number; dockerOtherMB: number; otherMB: number; top: { name: string; mb: number; n: number }[] }
const MEM_LABEL = { static: "static", remote: "remote", unknown: "n/a", off: "" } as const;
/** RAM cell text: the measured number, or the reason there is none. */
export const memText = (a: AppState) => (a.mem > 0 ? mb(a.mem) : a.memSrc && a.memSrc in MEM_LABEL ? MEM_LABEL[a.memSrc as keyof typeof MEM_LABEL] : a.kind === "gate" ? "static" : "—");
const MEM_HOW = { vm: "Measured: VM memory on the host", docker: "Measured: container memory (docker stats)", process: "Measured: process tree resident memory", port: "Measured: process listening on its port", static: "Static site served by Caddy, no own process", remote: "Runs on another machine", unknown: "No process found to measure", off: "Stopped" } as const;
export const memHow = (a: AppState) => (a.memSrc ? MEM_HOW[a.memSrc] : "");
export interface System { cpuTemp: number | null; gpuTemp: number | null; load1: number | null; ramUsedGB: number | null; ramTotalGB: number; swapGB: number | null; boot: number | null; internal: { totalGB: number; freeGB: number } | null; ssd: { totalGB: number; freeGB: number } | null; }
export interface SpeedPoint { t: number; ping: number; down: number; up: number; }
/** The Ram tab's live slice (server/ram.ts). All sizes in MB. */
export interface RamGroup { name: string; mb: number; n: number; icon?: boolean; src?: string | null; app?: boolean; bins?: string[]; procs: { pid: number; mb: number; upSec: number; bin?: string }[] }
export interface RamMover { name: string; nowMB: number; beforeMB: number; deltaMB: number; isNew: boolean }
/** One row of the Ram tab's main list (server/ram.ts buildList): every thing that holds RAM once; bundles expand into kids. */
export interface RamKid { key: string; name: string; mb: number; sub?: string; app?: string | null; src?: string | null; icon?: boolean }
export interface RamRow {
  key: string; name: string; kind: "vm" | "docker" | "panel" | "claude" | "app" | "proc" | "macos" | "small";
  mb: number; n: number; sub?: string; src?: string | null; icon?: boolean; href?: string; kids: RamKid[]; more?: { n: number; mb: number };
}
export interface RamSlice {
  list?: RamRow[];
  at: number; totalMB: number; usedMB: number | null; pressure: "normal" | "warn" | "critical" | "unknown"; swapUsedMB: number; swapTotalMB: number;
  compressedMB: number; wiredMB: number; appMB: number; cachedMB: number; freeMB: number; procSumMB: number;
  breakdown: { key: "vms" | "apps" | "claude" | "other" | "macos"; label: string; mb: number }[]; restMB: number;
  vms: { name: string; kind: "utm" | "docker"; configuredMB: number | null; footprintMB: number; running: boolean; overheadMB: number; items: { name: string; mb: number; app: string | null }[] }[];
  claude: { pid: number; name: string; agent: string | null; cwd: string; status: string; mb: number; n: number; startedAt: number; src?: string | null }[];
  groups: RamGroup[]; groupCount: number; otherMB: number;
  movers: { spanMin: number; up: RamMover[]; down: RamMover[] };
}
export interface Monitor { name: string; pct: number | null; up: boolean; lastUp: number | null; }
export interface Job { id: string; name: string; schedule: string; when: string; enabled: boolean; nextRun: number | null; status: string; lastRun: number | null; cause: string; log: string | null; command: string; about?: string | null; category?: string | null; source?: "server" | "launchd"; canRun?: boolean; kind?: "command" | "claude" | "http"; webhook?: boolean;
  reports?: string | null; project?: string | null; touches?: { apps?: string[]; paths?: string[]; data?: string } | null; uses?: { tools?: string[]; apis?: string[]; secrets?: string[]; model?: string } | null;
  risk?: "read-only" | "writes" | "destructive" | null; icons?: Record<string, string> | null; card?: "ok" | "missing"; gaps?: string[]; }
export interface Bot { dir: string; name: string; state: string; since: number | null; lastFile: number | null; }
export interface Hook { slug: string; label: string; description: string; port: number; state: string; listening: boolean; logMtime: number | null; logTail: string; }
export interface HistEntry { t: number; job: string; action: string; sent: boolean; id: number | null; cause: string; title: string; body: string; }
export interface Alerts { days: number; sent: number; silent: number; newCause: number; groups: { job: string; sent: number; silent: number; items: HistEntry[] }[]; }

export interface BotSession {
  channel: string; protected: boolean; restartable: boolean; scopable: boolean; tokenSet: boolean; cwd: string; model: string; activeModel: string | null;
  running: boolean; pid: number | null; telegramConnected: boolean; uptime: string | null; inbox: number;
  /** claudeOS: run by the Claude OS bot manager. native: run by Server OS itself in a tmux session. */
  provider?: "claudeOS" | "native"; telegram?: boolean; tokenKey?: string | null; effort?: string | null; permissionMode?: string;
  capabilities?: { globalSkills?: string[]; projectSkills?: string[]; mcps?: { name: string; scope: string; enabled: boolean; toggleable: boolean }[]; plugins?: string[] };
  /** native only: the workspace summary (Workspace tab has the full settings). team is null when agmsg isn't installed. */
  preset?: "safe" | "dev" | "full"; role?: string; isolated?: boolean; sandbox?: boolean; network?: boolean; folders?: string[]; secrets?: number; team?: string | null;
}
export interface Life { uptime24: number | null; uptime7d: number | null; healthy: boolean | null; code: number | null; since: number | null; restarts7d: number; lastChange: number | null; checkedVia: "http" | "process"; }
export interface UsageWindow { key: string; label: string; pct: number; resetsAt: number | null; hours: number | null }
export interface ClaudeUsage { plan: string | null; session: { pct: number; resetsAt: number | null } | null; week: { pct: number; resetsAt: number | null } | null;
  windows?: UsageWindow[]; noSessionLimit?: boolean; fetchedAt: number; error: string | null }
/** Every limit window to draw (the server's list; an older server's session/week otherwise). */
export function usageWindows(u: ClaudeUsage | null | undefined): UsageWindow[] {
  if (!u) return [];
  if (u.windows) return u.windows;
  return [["five_hour", "Session · 5 h", 5, u.session], ["seven_day", "Week", 168, u.week]]
    .filter((x) => x[3]).map(([key, label, hours, w]) => ({ key: key as string, label: label as string, hours: hours as number, ...(w as { pct: number; resetsAt: number | null }) }));
}
export interface UsageMeter { label: string; used: number; limit: number | null; unit: string; pct: number | null; resetsAt: number | null }
export interface UsageService { id: string; name: string; icon: string; fallback: string; group: string; kind: "paid" | "free" | "local"; via: string[]; plan: string | null; planManual: boolean; meters: UsageMeter[]; spend: { label: string; amount: number } | null;
  monthly: number | null; costSource: "manual" | "api" | "estimate" | "free" | null; renewalDay: number | null; renewsAt: number | null; status: "ok" | "near" | "error" | "unknown"; error: string | null; note: string | null; checkedAt: number | null; billing: string; hidden: boolean }
export interface UsageSnapshot { services: UsageService[]; totals: { monthly: number; known: number; estimated: number; unknown: number; actual: number }; currency: string; checkedAt: number | null; scanning: boolean }
export interface FixedCost { id: string; name: string; monthly: number; note?: string }
export interface CostsSnapshot { currency: string; updatedAt: number; headline: { monthly: number; actual: number; estimate: number };
  subscriptions: { monthly: number; unknown: number; items: { id: string; name: string; monthly: number; source: string }[] }; fixed: { monthly: number; items: FixedCost[] };
  electricity: { monthly: number; watts: number | null; avgWatts: number | null; kwhMonth: number; price: number; source: "measured" | "estimate"; machine: string; days: number };
  ai: { available: boolean; today: number; week: number; month: number; tokens: number; unpriced: number; days: { date: string; cost: number }[]; top: { label: string; kind: string; cost: number; tokens: number; share: number; models: string[] }[]; scannedAt: number | null };
  trend: { date: string; cost: number; ai: number }[] }
export interface ClaudeJob { pid: number; kind: "bot" | "headless" | "interactive"; label: string; detail: string; model: string | null; cwd: string | null; startedAt: number; cpu: number; memMB: number; endedAt: number | null }
/** The self-updater (server/modules/update.ts), pushed as the `update` slice. */
export interface UpdateStatus {
  current: string; mode: "release" | "git" | "homebrew" | "docker" | "unmanaged"; service: string | null;
  dev: { branch: string | null; upstream: string | null; behind: number } | null;
  latest: { tag: string; version: string; name: string; notes: string; prerelease: boolean; publishedAt: string | null; url: string | null; signed: boolean } | null;
  updateAvailable: boolean; canApply: boolean; blocked: string | null; checkedAt: number | null; checkError: string | null;
  state: "idle" | "checking" | "downloading" | "verifying" | "installing" | "restarting" | "failed"; detail: string; error: string | null;
  last: { ok: boolean; from: string; to: string; at: number; reason?: string; rolledBack?: boolean } | null;
  settings: { channel: "stable" | "beta"; auto: "off" | "notify" | "nightly" }; nextAutoAt: number | null;
}
/** A Home Assistant entity as the bridge sends it (server/modules/ha.ts). */
export interface HaEntity { id: string; name: string; domain: string; state: string; unit?: string; icon?: string; area?: string; attrs?: Record<string, any> }
interface State {
  connected: boolean;
  /** Entities that dashboards show, live; haBridge says whether Home Assistant is reachable and how (ws | poll). */
  haEntities: Record<string, HaEntity>; haBridge?: { configured: boolean; online: boolean; mode: "off" | "ws" | "poll" } | null;
  update?: UpdateStatus | null;
  usage?: UsageSnapshot | null; costs?: CostsSnapshot | null;
  claudeUsage?: ClaudeUsage | null; claudeJobs?: ClaudeJob[] | null;
  apps: Record<string, AppState>; groups: string[]; ramOther?: RamOther | null; ram?: RamSlice | null;
  system: System | null; dns: { unboundHitRate: number | null; adguard: { queries: number; blocked: number; clients: number } | null } | null;
  ha: { online: boolean; peopleHome?: number; people?: number; lightsOn?: number; lights?: number; switchesOn?: number; switches?: number; weather?: { state: string; temp: number | null } | null } | null;
  speed: { points: SpeedPoint[]; last: SpeedPoint | null } | null;
  uptime: { available: boolean; monitors: Record<string, Monitor> } | null;
  jobs: Job[] | null; bots: Bot[] | null; hooks: Hook[] | null; alerts24: Alerts | null;
  sysHistory: { t: number[]; cpu: (number | null)[]; ram: (number | null)[]; swap: (number | null)[]; load: (number | null)[]; disk: (number | null)[] } | null;
  botSessions: BotSession[] | null;
  /** Permission asks waiting per bot channel (the Bots list badge). */
  botApprovals?: Record<string, number>;
  botsProvider?: { provider: "claudeOS" | "native" | "both" | "demo" | null; prefix: string | null; missing: string[] } | null;
  life: Record<string, Life> | null;
}
export const S = reactive<State>({
  connected: false, haEntities: {}, apps: {}, groups: [], system: null, dns: null, ha: null, speed: null, uptime: null, jobs: null, bots: null, hooks: null, alerts24: null, sysHistory: null, botSessions: null, life: null,
});

export function connect() {
  const es = new EventSource("/svc-api/stream");
  es.addEventListener("snapshot", (e) => { Object.assign(S, JSON.parse((e as MessageEvent).data)); S.connected = true; });
  es.addEventListener("slice", (e) => { const { key, value } = JSON.parse((e as MessageEvent).data); (S as unknown as Record<string, unknown>)[key] = value; });
  es.addEventListener("entry", (e) => {
    const { key, id, value } = JSON.parse((e as MessageEvent).data);
    const map = (S as unknown as Record<string, Record<string, unknown>>)[key];
    if (value === null) delete map[id];
    else if (map[id]) Object.assign(map[id] as object, value); // patch in place: only bindings that read changed fields update
    else map[id] = value;
  });
  es.addEventListener("open", () => { S.connected = true; });
  es.addEventListener("error", () => { S.connected = false; }); // EventSource reconnects by itself
}

// ---- derived ----
export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** Our own lifecycle data first (every app); Uptime Kuma only as a fallback. */
export function uptimeFor(name: string): Monitor | null {
  const l = S.life?.[name];
  if (l && l.uptime24 != null) return { name, pct: l.uptime24, up: l.healthy !== false, lastUp: l.since };
  return kumaFor(name);
}
export function kumaFor(name: string): Monitor | null {
  const mons = S.uptime?.available ? S.uptime.monitors : null;
  if (!mons) return null;
  const a = norm(name);
  for (const [k, m] of Object.entries(mons)) if (k && a && (k === a || k.includes(a) || a.includes(k))) return m;
  return null;
}
export const appList = computed(() => Object.values(S.apps).sort((a, b) => a.order - b.order));
export const totalMem = computed(() => appList.value.reduce((s, a) => s + (a.mem || 0), 0));

// ---- formatting ----
export const mb = (m: number) => (m >= 1024 ? (m / 1024).toFixed(1) + " GB" : Math.round(m) + " MB");
export function ago(t: number | null | undefined) {
  if (!t) return "never";
  const d = Date.now() / 1000 - t, a = Math.abs(d), pre = d < 0 ? "in " : "", suf = d < 0 ? "" : " ago";
  if (a < 90) return d < 0 ? "in a moment" : "just now";
  if (a < 5400) return `${pre}${Math.round(a / 60)} min${suf}`;
  if (a < 129600) return `${pre}${Math.round(a / 3600)} h${suf}`;
  return `${pre}${Math.round(a / 86400)} d${suf}`;
}

export async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}

export const toastMsg = reactive({ text: "", n: 0 });
export function toast(text: string) { toastMsg.text = text; const n = ++toastMsg.n; setTimeout(() => { if (toastMsg.n === n) toastMsg.text = ""; }, 3500); }

/** Call the v1 API. Throws an Error with the server's RFC 9457 `detail` (or title) when the call fails. */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await fetch(`/api/v1${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (r.status === 204) return undefined as T;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail ?? data.title ?? `HTTP ${r.status}`);
  return data as T;
}
