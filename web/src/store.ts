// Reactive client state fed by one Server-Sent Events stream. The server sends a snapshot, then only changed slices/entries.
import { reactive, computed } from "vue";

export interface AppState {
  name: string; group: string; order: number; href: string; icon: string; about: string;
  kind: "lock" | "gate" | "switch"; warn: boolean; state: "on" | "off" | "part"; parts: Record<string, boolean>; mem: number;
}
export interface System { cpuTemp: number | null; gpuTemp: number | null; load1: number | null; ramUsedGB: number | null; ramTotalGB: number; swapGB: number | null; boot: number | null; internal: { totalGB: number; freeGB: number } | null; ssd: { totalGB: number; freeGB: number } | null; }
export interface SpeedPoint { t: number; ping: number; down: number; up: number; }
export interface Monitor { name: string; pct: number | null; up: boolean; lastUp: number | null; }
export interface Job { id: string; name: string; schedule: string; when: string; enabled: boolean; nextRun: number | null; status: string; lastRun: number | null; cause: string; log: string | null; command: string; about?: string | null; category?: string | null; source?: "server" | "launchd"; canRun?: boolean; kind?: "command" | "claude" | "http"; webhook?: boolean; }
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
export interface ClaudeUsage { plan: string | null; session: { pct: number; resetsAt: number | null } | null; week: { pct: number; resetsAt: number | null } | null; fetchedAt: number; error: string | null }
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
interface State {
  connected: boolean;
  update?: UpdateStatus | null;
  claudeUsage?: ClaudeUsage | null; claudeJobs?: ClaudeJob[] | null;
  apps: Record<string, AppState>; groups: string[];
  system: System | null; dns: { unboundHitRate: number | null; adguard: { queries: number; blocked: number; clients: number } | null } | null;
  ha: { online: boolean; peopleHome?: number; people?: number; lightsOn?: number; lights?: number; switchesOn?: number; switches?: number; weather?: { state: string; temp: number | null } | null } | null;
  speed: { points: SpeedPoint[]; last: SpeedPoint | null } | null;
  uptime: { available: boolean; monitors: Record<string, Monitor> } | null;
  jobs: Job[] | null; bots: Bot[] | null; hooks: Hook[] | null; alerts24: Alerts | null;
  sysHistory: { t: number[]; cpu: (number | null)[]; ram: (number | null)[]; swap: (number | null)[]; load: (number | null)[]; disk: (number | null)[] } | null;
  botSessions: BotSession[] | null;
  botsProvider?: { provider: "claudeOS" | "native" | "both" | "demo" | null; prefix: string | null; missing: string[] } | null;
  life: Record<string, Life> | null;
}
export const S = reactive<State>({
  connected: false, apps: {}, groups: [], system: null, dns: null, ha: null, speed: null, uptime: null, jobs: null, bots: null, hooks: null, alerts24: null, sysHistory: null, botSessions: null, life: null,
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
