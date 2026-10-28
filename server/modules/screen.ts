// Remote screen: a WebSocket that pipes raw bytes to the Mac's own Screen Sharing (VNC/RFB) on loopback, so someone who
// can only reach the web panel can click a System Settings switch. The browser runs noVNC; macOS asks for the Mac's
// username + password inside the RFB stream (Apple auth, type 30), so the server only ever sees encrypted bytes.
// Off unless integrations.screen.enabled. Admin / paired devices only, one session at a time, idle timeout + hard cap,
// every open and close audited. Nothing new listens anywhere: the server dials 127.0.0.1:5900 itself.
import type { Server, ServerWebSocket, Socket } from "bun";
import { config } from "../core/config";
import { audit, logEvent } from "../core/logger";
import { join } from "node:path";
import { STATE_DIR } from "../core/config";
import { DisplayController, markerPath, parseRes, swiftRunner, whyText } from "./displayMode";
import type { Describe, Outcome, Res, ResizePolicy } from "./displayMode";
import type { Trace } from "../core/logger";

export interface ScreenConfig { host: string; port: number; portFixed: boolean; idleMinutes: number; maxMinutes: number; debug: boolean; resizeDisplay?: ResizePolicy }

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
/** The resolved settings, or null when the feature is off (or points anywhere but this machine). */
export function screenConfig(c = config): ScreenConfig | null {
  const s = c.integrations.screen;
  if (!s?.enabled) return null;
  const host = s.host ?? "127.0.0.1";
  if (!LOOPBACK.has(host)) return null; // this Mac's screen only: never a relay to other hosts
  const num = (v: unknown, d: number) => (typeof v === "number" && v > 0 ? v : d);
  return { host, port: num(s.port, 5900), portFixed: typeof s.port === "number" && s.port > 0, idleMinutes: num(s.idleMinutes, 5), maxMinutes: num(s.maxMinutes, 30),
    debug: s.debug === true || process.env.SERVER_OS_SCREEN_DEBUG === "1", ...(s.resizeDisplay === false || s.resizeDisplay === "any" ? { resizeDisplay: s.resizeDisplay } : {}) };
}

/** Is a client frame the user doing something? noVNC keeps asking for screen updates (FramebufferUpdateRequest:
 *  type 3, 10 bytes each) on its own; anything else (keys, pointer, clipboard, the handshake) counts as activity. */
export function isUserInput(frame: Uint8Array): boolean {
  if (!frame.length || frame.length % 10) return frame.length > 0;
  for (let i = 0; i < frame.length; i += 10) if (frame[i] !== 3) return true;
  return false;
}

/** Why a session must end now, or null. */
export function expiry(s: { started: number; lastInput: number }, cfg: ScreenConfig, now = Date.now()): "idle" | "max" | null {
  if (now - s.started >= cfg.maxMinutes * 60_000) return "max";
  if (now - s.lastInput >= cfg.idleMinutes * 60_000) return "idle";
  return null;
}

/** What a client RFB message reveals about the picture settings (never any payload): the encodings noVNC asks for
 *  (SetEncodings, type 2) and the colour depth (SetPixelFormat, type 0). Only exact-length frames count, so the
 *  encrypted login blob is not mistaken for one. */
export function parseClientSettings(f: Uint8Array): { encodings?: number[]; bpp?: number } | null {
  if (f.length === 20 && f[0] === 0) return { bpp: f[4] };
  if (f.length >= 4 && f[0] === 2) {
    const n = (f[2] << 8) | f[3];
    if (n > 0 && n <= 64 && f.length === 4 + 4 * n) {
      const v = new DataView(f.buffer, f.byteOffset, f.byteLength), encodings: number[] = [];
      for (let i = 0; i < n; i++) encodings.push(v.getInt32(4 + 4 * i));
      return { encodings };
    }
  }
  return null;
}

/** Per-session counters for debug mode: bytes and messages each way, logged as rates. Counts only, no content. */
export class ScreenStats {
  down = 0; downMsgs = 0; up = 0; upMsgs = 0; paused = 0;
  private last = { t: Date.now(), down: 0, downMsgs: 0, up: 0, upMsgs: 0 };
  rates(now = Date.now()) {
    const dt = Math.max(0.001, (now - this.last.t) / 1000), r = {
      downKBps: Math.round((this.down - this.last.down) / 1024 / dt), downMsgsPerSec: Math.round((this.downMsgs - this.last.downMsgs) / dt),
      upMsgsPerSec: Math.round((this.upMsgs - this.last.upMsgs) / dt), upKBps: Math.round((this.up - this.last.up) / 1024 / dt), pauses: this.paused };
    this.last = { t: now, down: this.down, downMsgs: this.downMsgs, up: this.up, upMsgs: this.upMsgs };
    return r;
  }
}

/** On Linux the VNC server is whichever one the user started (x11vnc 5900, TigerVNC :1 on 5901, ...), so without an
 *  explicit `port` the first listener in 5900-5910 is used. macOS and an explicit port are used as they are. */
export async function resolveScreen(cfg: ScreenConfig, platform: NodeJS.Platform = process.platform, listening = vncListening): Promise<ScreenConfig> {
  if (platform === "darwin" || cfg.portFixed) return cfg;
  const ports = Array.from({ length: 11 }, (_, i) => 5900 + i);
  const up = await Promise.all(ports.map((port) => listening({ ...cfg, port }, 400)));
  const hit = ports.find((_, i) => up[i]);
  return hit ? { ...cfg, port: hit } : cfg;
}

export interface ScreenData { actor: string; ip: string; trace?: Trace; cfg: ScreenConfig; id: number; res?: Res | null }

// Display resolution while a session is open (macOS only; see displayMode.ts). The policy is read live from the config.
const HERE = import.meta.dir;
export const display = new DisplayController(
  swiftRunner(join(HERE, "../native/displaymode.swift"), join(STATE_DIR, "bin", "displaymode")),
  markerPath(STATE_DIR), () => { const c = screenConfig(); return c ? (c.resizeDisplay ?? true) : false; });
/** On server start: a "switched" marker with no session means the last run died mid-session; put the display back. */
export function recoverDisplay() { return display.restore().then((r) => { if (r) logEvent("info", "screen.display.recovered", {}); }).catch(() => {}); }
/** Change the resolution of the open session (viewer's control). False when there is no session. */
export async function setResolution(res: Res): Promise<(Outcome & { message: string; display: Describe }) | false> {
  if (!active) return false;
  const o = await display.applyWhy(res);
  logEvent("info", "screen.display", { id: active?.id, res, result: o.result, ...(o.why ? { why: o.why, sizes: o.sizes } : {}) });
  return { ...o, message: whyText(o), display: await display.describe() };
}
/** The sizes the Mac's display offers (read-only). */
export const resolutionOptions = () => display.describe();
interface Session {
  id: number; actor: string; ip: string; trace?: Trace; started: number; lastInput: number;
  ws: ServerWebSocket<ScreenData>; tcp: Socket | null; pending: Uint8Array[]; bytesIn: number; bytesOut: number; ended: boolean; stats: ScreenStats | null; statsAt: number;
}

// Close codes the panel explains (4000-4999 are free for applications).
export const CLOSE = { idle: 4001, max: 4002, takeover: 4003, vncClosed: 4004, vncUnreachable: 4005, disabled: 4006 } as const;

let active: Session | null = null, nextId = 1, sweeper: ReturnType<typeof setInterval> | null = null;

export function screenStatus(cfg = screenConfig()) {
  return { enabled: !!cfg, resize: !!cfg && display.supported, host: cfg?.host, port: cfg?.port, idleMinutes: cfg?.idleMinutes, maxMinutes: cfg?.maxMinutes,
    active: active ? { since: active.started, lastInput: active.lastInput } : null };
}

/** Is Screen Sharing listening? A plain TCP connect, closed at once (no RFB bytes are exchanged). */
export function vncListening(cfg: ScreenConfig, timeoutMs = 1500): Promise<boolean> {
  return new Promise((res) => {
    let done = false;
    const finish = (v: boolean, s?: Socket) => { if (done) return; done = true; s?.end(); res(v); };
    setTimeout(() => finish(false), timeoutMs);
    Bun.connect({ hostname: cfg.host, port: cfg.port, socket: { open: (s) => finish(true, s), data() {}, error: () => finish(false), connectError: () => finish(false), close() {} } })
      .catch(() => finish(false));
  });
}

function end(s: Session, reason: string, code = 1000) {
  if (s.ended) return;
  s.ended = true;
  if (active === s) active = null;
  if (!active && sweeper) { clearInterval(sweeper); sweeper = null; }
  if (s.stats) logEvent("info", "screen.stats.final", { id: s.id, seconds: Math.round((Date.now() - s.started) / 1000), downBytes: s.stats.down, downMsgs: s.stats.downMsgs, pauses: s.stats.paused });
  try { s.tcp?.end(); } catch { /* already gone */ }
  if (!active && code !== CLOSE.takeover) void display.restore(); // a takeover's new session sets its own size
  try { s.ws.close(code, reason); } catch { /* already gone */ }
  audit(s.actor, "screen.close", `${s.ws.data.cfg.host}:${s.ws.data.cfg.port}`, "ok", s.trace,
    { reason, seconds: Math.round((Date.now() - s.started) / 1000), bytesIn: s.bytesIn, bytesOut: s.bytesOut, ip: s.ip });
}

function sweep() {
  if (!active) return;
  if (active.stats && Date.now() - active.statsAt >= 2000) { active.statsAt = Date.now(); logEvent("info", "screen.stats", { id: active.id, ...active.stats.rates() }); }
  const why = expiry(active, active.ws.data.cfg);
  if (why) end(active, why === "idle" ? "Closed after no input" : "Session time limit reached", why === "idle" ? CLOSE.idle : CLOSE.max);
}

/** Write to the VNC socket in order; Bun may take only part of a buffer, the rest goes out on drain. */
function flush(s: Session) {
  while (s.tcp && s.pending.length) {
    const b = s.pending[0], n = s.tcp.write(b);
    s.bytesOut += n;
    if (n < b.length) { s.pending[0] = b.subarray(n); return; }
    s.pending.shift();
  }
}

/** Upgrade an already-authorised request. 409 while another session is open, unless takeover. */
export function upgradeScreen(req: Request, server: Server<ScreenData>, d: Omit<ScreenData, "id">, takeover: boolean): Response | undefined {
  if (active && !takeover) return new Response(JSON.stringify({ type: "about:blank", title: "Busy", status: 409, detail: "Someone is already viewing the screen." }),
    { status: 409, headers: { "Content-Type": "application/problem+json" } });
  if (active) end(active, "Taken over by another session", CLOSE.takeover);
  const proto = req.headers.get("sec-websocket-protocol")?.split(",").map((p) => p.trim()).includes("binary") ? "binary" : undefined;
  const ok = server.upgrade(req, { data: { ...d, id: nextId++ }, headers: proto ? { "Sec-WebSocket-Protocol": proto } : undefined });
  return ok ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
}

export const screenSocket = {
  open(ws: ServerWebSocket<ScreenData>) {
    const { actor, ip, trace, cfg } = ws.data, now = Date.now();
    const s: Session = { id: ws.data.id, actor, ip, trace, started: now, lastInput: now, ws, tcp: null, pending: [], bytesIn: 0, bytesOut: 0, ended: false, stats: cfg.debug ? new ScreenStats() : null, statsAt: now };
    active = s;
    sweeper ??= setInterval(sweep, 1000);
    audit(actor, "screen.open", `${cfg.host}:${cfg.port}`, "ok", trace, { ip });
    // Smaller picture first (so the first frame is already the small one), then dial Screen Sharing.
    const res = ws.data.res ?? "native";
    (res === "native" && !display.switched ? Promise.resolve<Outcome>({ result: "kept" }) : display.applyWhy(res).catch((): Outcome => ({ result: "skipped", why: "helper" }))).then((o) => {
      if (s.ended) { if (!active) void display.restore(); return; }
      if (o.result !== "kept" && o.result !== "skipped") logEvent("info", "screen.display", { id: s.id, res, result: o.result });
      dial();
    });
    function dial() { Bun.connect({ hostname: cfg.host, port: cfg.port, socket: {
      open(t) { if (s.ended) { t.end(); return; } t.setNoDelay(true); s.tcp = t; flush(s); },
      // A slow viewer must not make the server queue stale frames: when the WebSocket backs up, stop reading from
      // Screen Sharing until it drains (the `drain` handler below); the protocol then sends fewer, fresher updates.
      data(t, chunk) {
        s.bytesIn += chunk.length;
        if (s.stats) { s.stats.down += chunk.length; s.stats.downMsgs++; }
        if (!s.ended && ws.sendBinary(chunk) === -1) { s.stats && s.stats.paused++; t.pause(); }
      },
      drain() { flush(s); },
      close() { end(s, "Screen Sharing closed the connection", CLOSE.vncClosed); },
      error() { end(s, "Screen Sharing connection error", CLOSE.vncClosed); },
      connectError() { end(s, "Screen Sharing is not reachable", CLOSE.vncUnreachable); },
    } }).catch(() => end(s, "Screen Sharing is not reachable", CLOSE.vncUnreachable)); }
  },
  message(ws: ServerWebSocket<ScreenData>, msg: string | Buffer) {
    const s = active?.id === ws.data.id ? active : null;
    if (!s || typeof msg === "string") return; // RFB is binary only
    const b = new Uint8Array(msg);
    if (isUserInput(b)) s.lastInput = Date.now();
    if (s.stats) {
      s.stats.up += b.length; s.stats.upMsgs++;
      const c = parseClientSettings(b);
      if (c) logEvent("info", "screen.client", { id: s.id, ...c });
    }
    s.pending.push(b);
    flush(s);
  },
  drain(ws: ServerWebSocket<ScreenData>) {
    if (active?.id === ws.data.id) active.tcp?.resume();
  },
  close(ws: ServerWebSocket<ScreenData>) {
    if (active?.id === ws.data.id) end(active, "Viewer disconnected");
  },
};

/** Close the session (config reload, tests). */
export function closeScreen(reason = "Server closed it") { if (active) end(active, reason, CLOSE.disabled); }
/** Server shutdown: end the session and put the display back before the process goes (SIGTERM from launchd). */
export async function shutdownScreen() { closeScreen("Server is shutting down"); await Promise.race([display.restore(), Bun.sleep(5000)]); }
