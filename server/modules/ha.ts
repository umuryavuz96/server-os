// Home Assistant bridge for the entity cards of JSON dashboards. The token never leaves the server.
// Live state: HA's WebSocket (state_changed events) pushed into the `haEntities` map slice, only for entities a dashboard
// shows (or a card asked about). If the socket can't be opened, polling /api/states every 5 s keeps the cards fresh.
// REST goes through curl: macOS Local Network privacy can block LAN access for some runtimes; curl is always allowed.
import { config } from "../core/config";
import { ENV, log } from "../lib";
import { setMapEntry, setSlice } from "../store";
import { getDashboard, listDashboards } from "./dashboards";

export const DEFAULT_ALLOW = ["light", "switch", "fan", "climate", "media_player", "scene", "script", "input_boolean", "cover"];
/** Target keys that would reach entities outside the explicit list, and so outside the allowlist. */
const WIDE_TARGETS = ["area_id", "device_id", "floor_id", "label_id"];
const ENTITY = /^[a-z_]+\.[a-z0-9_]+$/;
const NAME = /^[a-z_]+$/;

export interface HaEntity { id: string; name: string; domain: string; state: string; unit?: string; icon?: string; area?: string; attrs?: Record<string, unknown> }
interface RawState { entity_id: string; state: string; attributes?: Record<string, unknown> }

/** Attributes the cards read, per domain; everything else stays on the server. */
const ATTRS: Record<string, string[]> = {
  climate: ["current_temperature", "temperature", "hvac_mode", "hvac_modes", "hvac_action", "min_temp", "max_temp", "target_temp_step"],
  media_player: ["media_title", "media_artist", "media_album_name", "volume_level", "is_volume_muted", "source", "media_duration"],
  light: ["brightness", "rgb_color"], fan: ["percentage"], cover: ["current_position"], sensor: ["device_class"], binary_sensor: ["device_class"],
};

export const mapState = (s: RawState): HaEntity => {
  const a = s.attributes ?? {}, domain = s.entity_id.split(".")[0];
  const attrs: Record<string, unknown> = {};
  for (const k of ATTRS[domain] ?? []) if (a[k] !== undefined && a[k] !== null) attrs[k] = a[k];
  return {
    id: s.entity_id, domain, state: s.state,
    name: typeof a.friendly_name === "string" && a.friendly_name ? a.friendly_name : s.entity_id,
    ...(typeof a.unit_of_measurement === "string" ? { unit: a.unit_of_measurement } : {}),
    ...(typeof a.icon === "string" ? { icon: a.icon } : {}),
    ...(Object.keys(attrs).length ? { attrs } : {}),
  };
};

export const allowedDomains = (): string[] => config.integrations.homeAssistant?.allowDomains ?? DEFAULT_ALLOW;

/** Why a service call is refused, or null when it may go ahead. Pure: the domain allowlist is the safety boundary. */
export function checkCall(domain: unknown, service: unknown, data: unknown, allow: string[] = allowedDomains()): string | null {
  if (typeof domain !== "string" || !NAME.test(domain)) return "domain: lowercase letters and underscores";
  if (typeof service !== "string" || !NAME.test(service)) return "service: lowercase letters and underscores";
  if (!allow.includes(domain)) return `Calls on “${domain}” are not allowed. Allowed domains: ${allow.join(", ")}`;
  if (service === "reload") return "reload is not allowed";
  const d = (data ?? {}) as Record<string, unknown>;
  if (typeof d !== "object" || Array.isArray(d)) return "data: an object";
  for (const k of WIDE_TARGETS) if (k in d) return `${k} targets are not allowed; name the entities`;
  const ids = Array.isArray(d.entity_id) ? d.entity_id : d.entity_id === undefined ? [] : [d.entity_id];
  // script.<name> runs that script and needs no entity_id; every other call must name its entities.
  if (!ids.length && !(domain === "script" && !["turn_on", "turn_off", "toggle"].includes(service))) return "entity_id: name the entities to act on";
  if (ids.length > 20) return "entity_id: at most 20 entities";
  for (const id of ids) {
    if (typeof id !== "string" || !ENTITY.test(id)) return "entity_id: not an entity id";
    if (!allow.includes(id.split(".")[0])) return `Entity ${id} is in a domain that is not allowed`;
    if (id.split(".")[0] !== domain) return `Entity ${id} does not belong to ${domain}`;
  }
  return null;
}

// ---------- history: HA's raw state changes → the fixed-step buckets every chart in the panel draws ----------
export const HISTORY_RANGES = { "1h": 3600, "2h": 7200, "6h": 6 * 3600, "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400 } as const;
export type HistoryRange = keyof typeof HISTORY_RANGES;
export interface HaSeries { step: number; t: number[]; avg: (number | null)[]; min: (number | null)[]; max: (number | null)[] }

/** A state holds until it changes, so an empty bucket repeats the last value; before the first state it is null (a gap). */
export function bucketHistory(points: [number, number | null][], now: number, range: number, count: number): HaSeries {
  const step = Math.max(60, Math.ceil(range / count / 60) * 60), end = Math.ceil(now / step) * step, n = Math.ceil(range / step);
  const t0 = end - n * step, t: number[] = [], avg: (number | null)[] = [], min: (number | null)[] = [], max: (number | null)[] = [];
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  let i = 0, held: number | null = null, seen = false;
  while (i < sorted.length && sorted[i][0] < t0) { held = sorted[i][1]; seen = true; i++; }
  for (let b = 0; b < n; b++) {
    const lo = t0 + b * step, hi = lo + step, vals: number[] = [];
    if (held != null) vals.push(held);
    while (i < sorted.length && sorted[i][0] < hi) { held = sorted[i][1]; seen = true; if (held != null) vals.push(held); i++; }
    t.push(lo);
    if (!seen || !vals.length) { avg.push(null); min.push(null); max.push(null); continue; }
    avg.push(Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 100) / 100); min.push(Math.min(...vals)); max.push(Math.max(...vals));
  }
  return { step, t, avg, min, max };
}

// ---------- plumbing ----------
const conf = () => { const h = config.integrations.homeAssistant; const token = h ? ENV[h.tokenEnv ?? "HA_TOKEN"] : undefined; return h && token ? { url: h.url.replace(/\/$/, ""), token } : null; };
export const haConfigured = () => !!conf();
/** Testing aid: HA_DRY_RUN=1 makes every service call a no-op that only reports what it would have sent. */
const dryRun = () => process.env.HA_DRY_RUN === "1";

/** GET/POST through curl; the token goes in on stdin (-H @-), never on the command line. */
async function curl(path: string, body?: unknown, timeout = 8): Promise<{ ok: boolean; status: number; data: Uint8Array } | null> {
  const c = conf(); if (!c) return null;
  const cmd = ["/usr/bin/curl", "-s", "--max-time", String(timeout), "-w", "\n%{http_code}", "-H", "@-", ...(body !== undefined ? ["-X", "POST", "-H", "Content-Type: application/json", "--data-binary", JSON.stringify(body)] : []), c.url + path];
  try {
    const p = Bun.spawn(cmd, { stdin: new TextEncoder().encode(`Authorization: Bearer ${c.token}\n`), stdout: "pipe", stderr: "ignore" });
    const raw = new Uint8Array(await new Response(p.stdout).arrayBuffer()); await p.exited;
    const nl = raw.lastIndexOf(10), status = Number(new TextDecoder().decode(raw.slice(nl + 1)));
    return { ok: status >= 200 && status < 300, status, data: raw.slice(0, Math.max(0, nl)) };
  } catch { return null; }
}
const json = async <T>(path: string, body?: unknown): Promise<T | null> => {
  const r = await curl(path, body, 10);
  if (!r?.ok) return null;
  try { return JSON.parse(new TextDecoder().decode(r.data)) as T; } catch { return null; }
};

// ---------- state cache + live push ----------
const states = new Map<string, HaEntity>();
let mode: "off" | "ws" | "poll" = "off";
let online = false;
let areas: Record<string, string> = {}, areasAt = 0;
const extra = new Set<string>(); // entities a card asked about before any saved dashboard shows them (bounded)
let watched = new Set<string>();

const publishStatus = () => setSlice("haBridge", { configured: haConfigured(), online, mode });
const withArea = (e: HaEntity): HaEntity => (areas[e.id] ? { ...e, area: areas[e.id] } : e);
const push = (e: HaEntity | undefined) => { if (e && (watched.has(e.id) || extra.has(e.id))) setMapEntry("haEntities", e.id, withArea(e)); };

function put(raw: RawState) {
  const e = mapState(raw), old = states.get(e.id);
  if (old && JSON.stringify(old) === JSON.stringify(e)) return;
  states.set(e.id, e); push(e);
}
/** Entities named by the saved dashboards (entity, entities of group cards). */
export function dashboardEntities(): Set<string> {
  const out = new Set<string>();
  for (const { id } of listDashboards()) for (const c of getDashboard(id)?.cards ?? []) {
    const q = (c.query ?? {}) as { entity?: unknown; entities?: unknown };
    if (typeof q.entity === "string") out.add(q.entity);
    if (Array.isArray(q.entities)) for (const x of q.entities) if (typeof x === "string") out.add(x);
  }
  return out;
}
/** Other pages that show entities live (the House page's pins) add their list here. */
const watchSources: (() => Iterable<string>)[] = [];
export const addWatchSource = (fn: () => Iterable<string>) => { watchSources.push(fn); };
/** Call after a dashboard (or another watch source) changes: start pushing newly shown entities, stop pushing dropped ones. */
export function refreshWatched() {
  const next = dashboardEntities();
  for (const src of watchSources) for (const id of src()) next.add(id);
  for (const id of watched) if (!next.has(id) && !extra.has(id)) setMapEntry("haEntities", id, null);
  watched = next;
  for (const id of watched) { push(states.get(id)); if (id.startsWith("camera.") && !snaps.has(id) && conf()) void refreshSnapshot(id); }
}

async function loadAll(): Promise<boolean> {
  const all = await json<RawState[]>("/api/states");
  if (!Array.isArray(all)) { if (online) { online = false; publishStatus(); } return false; }
  const seen = new Set<string>();
  for (const s of all) { seen.add(s.entity_id); put(s); }
  for (const id of states.keys()) if (!seen.has(id)) states.delete(id);
  if (!online) { online = true; publishStatus(); }
  return true;
}
async function loadAreas() {
  if (Date.now() - areasAt < 300_000) return;
  areasAt = Date.now();
  const tpl = "{% set ns = namespace(o={}) %}{% for s in states %}{% set a = area_name(s.entity_id) %}{% if a %}{% set ns.o = dict(ns.o, **{s.entity_id: a}) %}{% endif %}{% endfor %}{{ ns.o | tojson }}";
  const r = await curl("/api/template", { template: tpl }, 15);
  try { if (r?.ok) areas = JSON.parse(new TextDecoder().decode(r.data)); } catch { /* names stay as they were */ }
}

let ws: WebSocket | null = null, backoff = 5_000;
function connectWs() {
  const c = conf(); if (!c || ws) return;
  let sock: WebSocket;
  try { sock = new WebSocket(c.url.replace(/^http/, "ws") + "/api/websocket"); } catch { return scheduleWs(); }
  ws = sock;
  sock.onmessage = async (m) => {
    let d: { type?: string; event?: { event_type?: string; data?: { new_state?: RawState | null; entity_id?: string } } };
    try { d = JSON.parse(String(m.data)); } catch { return; }
    if (d.type === "auth_required") sock.send(JSON.stringify({ type: "auth", access_token: c.token }));
    else if (d.type === "auth_ok") {
      sock.send(JSON.stringify({ id: 1, type: "subscribe_events", event_type: "state_changed" }));
      if (await loadAll()) { mode = "ws"; backoff = 5_000; publishStatus(); log("Home Assistant live over WebSocket"); }
    } else if (d.type === "auth_invalid") { log("Home Assistant rejected the token"); sock.close(); }
    else if (d.type === "event" && d.event?.event_type === "state_changed") {
      const ns = d.event.data?.new_state, id = d.event.data?.entity_id;
      if (ns) put(ns); else if (id) { states.delete(id); setMapEntry("haEntities", id, null); }
    }
  };
  const down = () => { if (ws !== sock) return; ws = null; if (mode === "ws") log("Home Assistant WebSocket closed; polling until it is back"); mode = "poll"; publishStatus(); scheduleWs(); };
  sock.onclose = down; sock.onerror = down;
}
function scheduleWs() { const wait = backoff; backoff = Math.min(backoff * 2, 60_000); setTimeout(connectWs, wait).unref?.(); }

/** Start the bridge. A no-op without integrations.homeAssistant and its token, so a fresh install boots clean. */
export function startHa() {
  if (!conf()) return;
  mode = "poll"; refreshWatched(); publishStatus();
  connectWs();
  setInterval(async () => {
    if (mode === "ws") return;
    if (await loadAll()) void loadAreas();
  }, 5_000).unref?.();
  setInterval(() => { if (mode === "ws") void loadAll(); }, 300_000).unref?.(); // WebSocket drops events silently now and then; resync
  void loadAll().then(() => loadAreas()).then(() => refreshWatched());
}

// ---------- what the routes use ----------
export const bridgeStatus = () => ({ configured: haConfigured(), online, mode, allow: allowedDomains(), dryRun: dryRun() });

export async function listEntities(q = "", domain = "", limit = 60) {
  if (!states.size) await loadAll();
  await loadAreas();
  const needle = q.trim().toLowerCase();
  const hit = [...states.values()].filter((e) => (!domain || e.domain === domain)
    && (!needle || e.id.toLowerCase().includes(needle) || e.name.toLowerCase().includes(needle) || (areas[e.id] ?? "").toLowerCase().includes(needle)));
  const domains: Record<string, number> = {};
  for (const e of states.values()) domains[e.domain] = (domains[e.domain] ?? 0) + 1;
  hit.sort((a, b) => a.name.localeCompare(b.name));
  return { total: hit.length, entities: hit.slice(0, limit).map(withArea), domains: Object.entries(domains).sort().map(([d, count]) => ({ domain: d, count, controllable: allowedDomains().includes(d) })) };
}
/** One entity; asking also subscribes the panel to its changes (cards in the editor aren't in a saved dashboard yet). */
export async function getEntity(id: string): Promise<HaEntity | null> {
  if (!ENTITY.test(id)) return null;
  if (!states.size) await loadAll();
  const e = states.get(id); if (!e) return null;
  if (!watched.has(id) && extra.size < 200) { extra.add(id); push(e); }
  return withArea(e);
}

export type Sender = (path: string, body: unknown) => Promise<{ ok: boolean; status: number } | null>;
/** Call a service. `dry` (or HA_DRY_RUN=1) checks everything and returns what would be sent without sending it. */
export async function callService(domain: string, service: string, data: Record<string, unknown>, opts: { dry?: boolean; send?: Sender } = {}): Promise<{ ok: boolean; status: number; detail: string; dry?: boolean; sent?: unknown }> {
  const bad = checkCall(domain, service, data);
  if (bad) return { ok: false, status: 403, detail: bad };
  const path = `/api/services/${domain}/${service}`;
  if (opts.dry || dryRun()) return { ok: true, status: 200, detail: "dry run: nothing sent", dry: true, sent: { path, data } };
  const r = await (opts.send ?? ((p, b) => curl(p, b)))(path, data);
  if (!r) return { ok: false, status: 502, detail: "Home Assistant didn't answer" };
  if (mode !== "ws") setTimeout(() => void loadAll(), 700).unref?.(); // polling: don't make the card wait the full 5 s
  return { ok: r.ok, status: r.ok ? 200 : r.status === 404 ? 404 : 502, detail: r.ok ? "ok" : `Home Assistant said ${r.status}` };
}

/** Numeric history of one entity as fixed-step buckets (the shape every chart in the panel draws). */
export async function history(id: string, range: HistoryRange, count: number): Promise<HaSeries | null> {
  if (!ENTITY.test(id)) return null;
  const now = Math.floor(Date.now() / 1000), sec = HISTORY_RANGES[range];
  const iso = (t: number) => encodeURIComponent(new Date(t * 1000).toISOString());
  const rows = await json<{ state: string; last_changed?: string; last_updated?: string }[][]>(`/api/history/period/${iso(now - sec)}?filter_entity_id=${encodeURIComponent(id)}&end_time=${iso(now)}&minimal_response&no_attributes`);
  if (!Array.isArray(rows)) return null;
  const pts: [number, number | null][] = (rows[0] ?? []).map((r) => {
    const v = Number(r.state);
    return [Math.floor(Date.parse(r.last_changed ?? r.last_updated ?? "") / 1000), r.state === "" || !Number.isFinite(v) ? null : v] as [number, number | null];
  }).filter((p) => Number.isFinite(p[0]));
  return bucketHistory(pts, now, sec, count);
}

const snaps = new Map<string, { at: number; type: string; body: Uint8Array }>(), inflight = new Map<string, Promise<void>>();
const sniff = (b: Uint8Array) => (b[0] === 0xff && b[1] === 0xd8 ? "image/jpeg" : b[0] === 0x89 && b[1] === 0x50 ? "image/png" : b[0] === 0x52 && b[1] === 0x49 ? "image/webp" : b[0] === 0x47 && b[1] === 0x49 ? "image/gif" : null);
/** Fetch a new still into the cache; concurrent callers share one request. */
function refreshSnapshot(id: string): Promise<void> {
  let p = inflight.get(id);
  if (!p) {
    p = curl(`/api/camera_proxy/${id}`, undefined, 10).then((r) => {
      const type = r?.ok ? sniff(r.data) : null;
      if (r && type) snaps.set(id, { at: Date.now(), type, body: r.data });
    }).finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  return p;
}
/** A camera still, stale-while-revalidate: the last frame is returned at once and a newer one is fetched behind it when
 *  it is over 2 s old, so a card paints immediately and ten viewers cost Home Assistant one request. Only the very first
 *  call waits (dashboards' cameras are warmed at start and on save, so that is rare). */
export async function cameraSnapshot(id: string): Promise<{ type: string; body: Uint8Array } | null> {
  if (!/^camera\.[a-z0-9_]+$/.test(id)) return null;
  const hit = snaps.get(id);
  if (hit) { if (Date.now() - hit.at > 2_000) void refreshSnapshot(id); return hit; }
  await refreshSnapshot(id);
  return snaps.get(id) ?? null;
}

// ---------- registries: areas, and which area each entity is in (through its device when it has none itself) ----------
export interface RegistryEntity { id: string; name: string; domain: string; area: string | null; deviceClass: string | null; device: string | null; state?: string; unit?: string }
export interface Registry { areas: { id: string; name: string; floor: string | null }[]; entities: RegistryEntity[] }
interface RawArea { area_id: string; name: string; floor_id?: string | null }
interface RawDevice { id: string; area_id?: string | null }
interface RawEntry { entity_id: string; name?: string | null; original_name?: string | null; area_id?: string | null; device_id?: string | null; entity_category?: string | null; disabled_by?: string | null; hidden_by?: string | null; device_class?: string | null; original_device_class?: string | null }

/** Join the three registry lists. Diagnostic/config, disabled and hidden entities are dropped here. Pure. */
export function joinRegistry(areas: RawArea[], devices: RawDevice[], entries: RawEntry[], live: (id: string) => HaEntity | undefined = () => undefined): Registry {
  const devArea = new Map(devices.map((d) => [d.id, d.area_id ?? null]));
  const entities = entries.filter((e) => !e.entity_category && !e.disabled_by && !e.hidden_by && ENTITY.test(e.entity_id)).map((e) => {
    const s = live(e.entity_id);
    return {
      id: e.entity_id, domain: e.entity_id.split(".")[0], name: s?.name ?? e.name ?? e.original_name ?? e.entity_id,
      area: e.area_id ?? (e.device_id ? devArea.get(e.device_id) ?? null : null), device: e.device_id ?? null,
      // some integrations only put the class on the state, not in the registry
      deviceClass: e.device_class ?? e.original_device_class ?? (typeof s?.attrs?.device_class === "string" ? s.attrs.device_class : null),
      ...(s ? { state: s.state } : {}), ...(s?.unit ? { unit: s.unit } : {}),
    };
  });
  return { areas: areas.map((a) => ({ id: a.area_id, name: a.name, floor: a.floor_id ?? null })), entities };
}

/** The registry lists only come over the WebSocket API: open a short-lived socket, ask, close. */
function wsAsk(types: string[], timeout = 12_000): Promise<unknown[] | null> {
  const c = conf(); if (!c) return Promise.resolve(null);
  return new Promise((resolve) => {
    let sock: WebSocket, done = false;
    const out: unknown[] = new Array(types.length);
    let got = 0;
    const finish = (v: unknown[] | null) => { if (done) return; done = true; clearTimeout(t); try { sock?.close(); } catch { /* closed */ } resolve(v); };
    const t = setTimeout(() => finish(null), timeout);
    try { sock = new WebSocket(c.url.replace(/^http/, "ws") + "/api/websocket"); } catch { return finish(null); }
    sock.onmessage = (m) => {
      let d: { type?: string; id?: number; success?: boolean; result?: unknown };
      try { d = JSON.parse(String(m.data)); } catch { return; }
      if (d.type === "auth_required") sock.send(JSON.stringify({ type: "auth", access_token: c.token }));
      else if (d.type === "auth_ok") types.forEach((type, i) => sock.send(JSON.stringify({ id: i + 1, type })));
      else if (d.type === "auth_invalid") finish(null);
      else if (d.type === "result" && d.id) { if (!d.success) return finish(null); out[d.id - 1] = d.result; if (++got === types.length) finish(out); }
    };
    sock.onerror = () => finish(null);
    sock.onclose = () => finish(null);
  });
}
let reg: { at: number; data: Registry } | null = null, regInflight: Promise<Registry | null> | null = null;
/** Areas + entities with their area, cached for 5 minutes (`fresh` skips the cache). Null when HA can't be asked. */
export async function registry(fresh = false): Promise<Registry | null> {
  if (!fresh && reg && Date.now() - reg.at < 300_000) return reg.data;
  regInflight ??= (async () => {
    if (!states.size) await loadAll();
    const r = await wsAsk(["config/area_registry/list", "config/device_registry/list", "config/entity_registry/list"]);
    if (!r) return reg?.data ?? null;
    const data = joinRegistry(r[0] as RawArea[], r[1] as RawDevice[], r[2] as RawEntry[], (id) => states.get(id));
    reg = { at: Date.now(), data };
    return data;
  })().finally(() => { regInflight = null; });
  return regInflight;
}
