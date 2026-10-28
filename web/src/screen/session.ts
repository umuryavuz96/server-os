// The remote-screen session lives here, not in a component, so it survives page changes: the viewer page and the
// picture-in-picture both just show the same noVNC canvas (`sess.host`, one DOM node that is moved between them).
// One session per browser tab; closing the tab closes the WebSocket and the server puts the display back.
import { reactive } from "vue";
import { api } from "../store";
import { installSubtleShim } from "./aes";
import { applyMode, bandwidthTip, DEFAULT_RES, ENCODING_NAMES, LEVELS, MODES, parseRes } from "./modes";
import type { Mode, Res } from "./modes";

interface SetupOption { id: string; title: string; note: string; install: string[]; then: string[] }
interface Setup { family: string; desktop: string; found: { port: number; process?: string; exposed: boolean }[]; installed: string[]; options: SetupOption[] }
export interface SizeOption { res: Res; width: number; height: number; available: boolean }
export interface DisplayInfo { supported: boolean; current: { width: number; height: number; hidpi: boolean } | null; sizes: SizeOption[]; why?: string }
export interface Status { resize?: boolean; enabled: boolean; listening: boolean; platform: string; noun?: string; setup?: Setup | null; port?: number; idleMinutes?: number; maxMinutes?: number; active: { since: number } | null }
export type Phase = "checking" | "off" | "not-listening" | "busy" | "connecting" | "login" | "connected" | "closed";
type Rfb = { disconnect(): void; sendCredentials(c: Record<string, string>): void; sendCtrlAltDel(): void; sendKey(sym: number, code: string | null, down?: boolean): void;
  qualityLevel: number; compressionLevel: number; scaleViewport: boolean; clipViewport: boolean; dragViewport: boolean; viewOnly: boolean; resizeSession: boolean; focus(): void; blur?(): void;
  addEventListener(t: string, f: (e: CustomEvent) => void): void };

const store = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const save = (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private window: not remembered */ } };

export type Corner = "tl" | "tr" | "bl" | "br";
const CORNERS: Corner[] = ["tl", "tr", "bl", "br"];

export const sess = reactive({
  phase: "checking" as Phase, status: null as Status | null, reason: "", loginErr: "", needUser: true,
  fit: true, viewOnly: false, pan: false,
  mode: ((m) => (MODES.includes(m as Mode) ? (m as Mode) : "balanced"))(store("sos.screen.mode")) as Mode,
  chosenRes: parseRes(store("sos.screen.res")) as Res | null, resNote: "", display: null as DisplayInfo | null,
  showStats: false, statsText: "", statsTip: "",
  /** Framebuffer size (for the picture-in-picture's aspect ratio). */
  fbW: 0, fbH: 0,
  /** The viewer is one window: "modal" over the current page, "pip" shrunk into a corner, "closed" not shown (RemoteScreen.vue). */
  ui: "closed" as "closed" | "modal" | "pip", title: "", hint: "", perm: "", fps: 0, started: false,
  corner: ((c) => (CORNERS.includes(c as Corner) ? (c as Corner) : "br"))(store("sos.screen.pip")) as Corner,
});
export const resOf = (): Res => sess.chosenRes ?? DEFAULT_RES[sess.mode];
export const inPip = () => sess.ui !== "modal";

/** The one DOM node noVNC draws into. Pages append it into their own container. */
export const host = document.createElement("div");
host.className = "ms-host";
host.style.cssText = "position:absolute;inset:0;overflow:hidden";

const meter = { frames: 0, bytes: 0, rects: 0, decodeMs: 0, encs: new Map<number, number>() };
type Internals = { _resize?: (w: number, h: number) => void; _framebufferUpdate?: () => boolean; _handleDataRect?: () => boolean; _FBU?: { encoding: number }; _fbWidth?: number; _fbHeight?: number };
let cur: Internals | null = null;
let rfb: Rfb | null = null, statsTimer: ReturnType<typeof setInterval> | null = null, lastTick = 0, resizedAt = 0, code = 0;
// In the picture-in-picture only a small thumbnail is needed: hold noVNC's "send me the next update" requests so the
// server sends at most ~4 updates a second instead of as many as the link can carry.
const PIP_MS = 250;
let pipTimer: ReturnType<typeof setTimeout> | null = null, pipHeld: Uint8Array | null = null, rawSend: ((d: Parameters<WebSocket["send"]>[0]) => void) | null = null;
const onlyUpdateRequests = (d: Uint8Array) => d.length > 0 && d.length % 10 === 0 && Array.from({ length: d.length / 10 }, (_, i) => d[i * 10]).every((t) => t === 3);
function sendOut(d: Parameters<WebSocket["send"]>[0]) {
  if (!(d instanceof Uint8Array)) return rawSend!(d);
  const m = applyMode(d, sess.mode);
  if (inPip() && sess.phase === "connected" && onlyUpdateRequests(m)) {
    pipHeld = m;
    pipTimer ??= setTimeout(() => { pipTimer = null; const h = pipHeld; pipHeld = null; if (h && rfb) rawSend!(h); }, PIP_MS);
    return;
  }
  rawSend!(m);
}
/** Back on the full page: send any held request at once so the picture catches up. */
function flushHeld() { if (pipTimer) { clearTimeout(pipTimer); pipTimer = null; } const h = pipHeld; pipHeld = null; if (h && rfb) rawSend!(h); }

const CLOSED: Record<number, string> = { 4001: "Closed after a few minutes without input.", 4002: "The session time limit was reached.", 4003: "Another browser took over the screen.",
  4004: "Screen Sharing ended the connection.", 4005: "Screen Sharing is not reachable on the Mac.", 4006: "The server closed the session." };

export async function check() {
  sess.phase = "checking";
  try { sess.status = await api<Status>("/screen"); } catch (e) { sess.reason = (e as Error).message; sess.phase = "closed"; return; }
  if (!sess.status.enabled) sess.phase = "off";
  else if (!sess.status.listening) sess.phase = "not-listening";
  else if (sess.status.active) sess.phase = "busy";
  else void connect(false);
}

export async function connect(takeover: boolean) {
  sess.phase = "connecting"; sess.reason = ""; sess.loginErr = ""; sess.started = true; code = 0;
  installSubtleShim(); // plain http has no WebCrypto; Apple's login needs AES (see screen/aes.ts)
  const { default: RFB } = await import("@novnc/novnc");
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/v1/screen/ws?res=${resOf()}${takeover ? "&takeover=1" : ""}`;
  const ws = new WebSocket(url, ["binary"]); // same origin: the sign-in cookie goes along
  rawSend = ws.send.bind(ws);
  ws.send = sendOut as WebSocket["send"]; // the picture mode trims noVNC's encoding list on the way out (screen/modes.ts)
  ws.addEventListener("message", (e) => { if (e.data instanceof ArrayBuffer) meter.bytes += e.data.byteLength; });
  ws.addEventListener("close", (e) => { code = e.code; if (!sess.reason) sess.reason = CLOSED[e.code] ?? e.reason ?? ""; });
  host.replaceChildren();
  const r = new RFB(host, ws, { shared: true, wsProtocols: ["binary"] }) as unknown as Rfb;
  rfb = r;
  r.qualityLevel = LEVELS[sess.mode].quality; r.compressionLevel = LEVELS[sess.mode].compression;
  hookMeter(r);
  r.scaleViewport = sess.fit; r.clipViewport = !sess.fit; r.resizeSession = false; applyView();
  r.addEventListener("credentialsrequired", (e) => { sess.needUser = !e.detail?.types || (e.detail.types as string[]).includes("username"); sess.phase = "login"; });
  r.addEventListener("securityfailure", (e) => { sess.loginErr = e.detail?.reason || "Wrong username or password."; });
  r.addEventListener("connect", () => { sess.phase = "connected"; if (inPip()) r.blur?.(); else r.focus(); void loadDisplay().then(() => { if (resOf() !== "native") void postRes(false); }); });
  r.addEventListener("disconnect", () => {
    if (rfb !== r) return;
    rfb = null; pipHeld = null;
    if (!sess.reason && sess.loginErr) sess.reason = sess.loginErr;
    if (!sess.reason && !code) sess.reason = "The connection was refused (maybe someone else is viewing).";
    sess.phase = "closed";
  });
}

/** View-only is forced in the picture-in-picture: a stray click there must never reach the Mac. */
export function applyView() {
  if (!rfb) return;
  const pip = inPip();
  rfb.viewOnly = pip || sess.viewOnly;
  if (pip) { rfb.dragViewport = false; rfb.blur?.(); }
  rfb.scaleViewport = pip || sess.fit; rfb.clipViewport = !(pip || sess.fit);
  if (!pip) { rfb.dragViewport = sess.pan; flushHeld(); }
}
/** The viewer window mounted: the one canvas goes into it (it stays there while the window morphs between modal and PiP). */
export function attach(el: HTMLElement) { el.appendChild(host); applyView(); }

let onClose: (() => void) | null = null;
/** Show the screen as a modal over the current page. A session already running (shrunk to the PiP) is just grown back, never reconnected. */
export function openScreen(o: { title?: string; hint?: string; perm?: string; onClose?: () => void } = {}) {
  const was = sess.ui;
  // A new Fix retargets a screen that is already open (PiP or modal) to its own permission; a plain "open" keeps the old one.
  if (was === "closed" || o.perm) { sess.title = o.title ?? ""; sess.hint = o.hint ?? ""; sess.perm = o.perm ?? ""; onClose = o.onClose ?? null; }
  sess.ui = "modal";
  if (was === "closed") void check();
  else { applyView(); if (sess.phase === "connected") rfb?.focus(); }
}
/** Shrink to the PiP. Never disconnects. Only while a picture is live: the login and error cards have nothing to shrink to. */
export function shrinkScreen() { if (sess.ui === "modal" && sess.phase === "connected") { sess.ui = "pip"; applyView(); } }
/** End the session and hide the window (the only way a session ends on purpose). */
export function closeScreen() { disconnect(); sess.ui = "closed"; sess.title = sess.hint = sess.perm = ""; const f = onClose; onClose = null; f?.(); }

// Counts what noVNC does with each update. noVNC internals, each guarded so a renamed one only loses the numbers.
function hookMeter(r: unknown) {
  const i = r as Internals;
  cur = i; sess.fbW = sess.fbH = 0;
  const fu = i._framebufferUpdate, dr = i._handleDataRect;
  if (fu) i._framebufferUpdate = function (this: Internals) { const t = performance.now(), done = fu.call(this); meter.decodeMs += performance.now() - t; if (done) meter.frames++; return done; };
  if (dr) i._handleDataRect = function (this: Internals) { const e = this._FBU?.encoding ?? 0; meter.rects++; meter.encs.set(e, (meter.encs.get(e) ?? 0) + 1); return dr.call(this); };
  // The Mac switched resolution under us: noVNC gets a DesktopSize and calls _resize.
  const rs = i._resize;
  if (rs) i._resize = function (this: Internals, w: number, h: number) { resizedAt = Date.now(); sess.resNote = ""; sess.fbW = w; sess.fbH = h; return rs.call(this, w, h); };
  statsTimer ??= setInterval(() => {
    const dt = (performance.now() - lastTick) / 1000; lastTick = performance.now();
    const i = cur;
    if (!i) return;
    if (dt > 0 && dt <= 5) sess.fps = Math.round(meter.frames / dt);
    if (!sess.fbW && i._fbWidth) { sess.fbW = i._fbWidth; sess.fbH = i._fbHeight ?? 0; }
    if (!sess.showStats || dt <= 0 || dt > 5) { Object.assign(meter, { frames: 0, bytes: 0, rects: 0, decodeMs: 0 }); meter.encs.clear(); return; }
    const encs = [...meter.encs].sort((a, b) => b[1] - a[1]).map(([e, n]) => `${ENCODING_NAMES[e] ?? e}×${n}`).join(" ") || "-";
    sess.statsText = `${Math.round(meter.frames / dt)} fps · ${Math.round(meter.bytes / 1024 / dt)} KB/s · ${meter.frames ? Math.round(meter.bytes / meter.frames / 1024) : 0} KB/frame · `
      + `${Math.round(meter.rects / dt)} rects/s · decode ${Math.round(meter.decodeMs / dt / 10)}% of a core · ${encs} · ${i._fbWidth}×${i._fbHeight} · ${sess.mode}`;
    sess.statsTip = bandwidthTip(meter.frames ? meter.bytes / meter.frames / 1024 : 0, meter.frames / dt, resOf());
    Object.assign(meter, { frames: 0, bytes: 0, rects: 0, decodeMs: 0 }); meter.encs.clear();
  }, 1000);
}

/** Which sizes the Mac's display really offers (read-only). The virtual display only exists once Screen Sharing is connected. */
export async function loadDisplay() {
  if (!sess.status?.resize) return;
  try { sess.display = await api<DisplayInfo>("/screen/resolution"); } catch { /* the buttons stay as they are */ }
}
const sizeText = (o?: SizeOption) => (o ? `${o.width}×${o.height}` : "");
/** The size button that matches what the Mac shows now: the chosen one if it exists, else the one equal to the current size. */
export function shownRes(): Res {
  const r = resOf(), d = sess.display;
  if (!d || !d.sizes.length || d.sizes.find((o) => o.res === r)?.available) return r;
  const c = d.current;
  return d.sizes.find((o) => o.res !== "native" && o.available && c && o.width === c.width && o.height === c.height && !c.hidpi)?.res ?? "native";
}
/** Tooltip for a Size button that cannot be used, "" when it works. */
export function resTip(r: Res): string {
  const d = sess.display;
  if (!d || !d.sizes.length) return "";
  const o = d.sizes.find((x) => x.res === r);
  if (!o || o.available) return "";
  if (d.why === "not-virtual") return "This is a real monitor, so the server does not resize it";
  const have = d.sizes.filter((x) => x.res !== "native" && x.available).map(sizeText);
  const cur = d.current ? `${d.current.width}×${d.current.height}` : "";
  return `This screen only offers ${[...new Set(have.length ? have : [cur])].join(", ")}`;
}

export function setRes(r: Res) {
  const tip = resTip(r);
  if (tip) { sess.resNote = tip + "."; const n = sess.resNote; setTimeout(() => { if (sess.resNote === n) sess.resNote = ""; }, 6000); return; } // not on offer: say why, keep the choice
  const before = resOf();
  sess.chosenRes = r; save("sos.screen.res", r);
  // Every click answers: an explicit choice shows what happened even when nothing changed.
  void postRes(true, resOf() === before);
}
/** The Mac's virtual display only exists once Screen Sharing has a signed-in session, so the size is also requested right
 *  after the connection is up. `explicit`: the user clicked, so "already at this size" and refusals are shown as well. */
async function postRes(explicit = false, same = false) {
  if (!rfb || sess.phase !== "connected" || !sess.status?.resize) return;
  const want = resOf();
  const label = want === "native" ? "native size" : want;
  if (explicit) sess.resNote = "Switching…";
  const sent = Date.now();
  let r: { result: string; message?: string; display?: DisplayInfo };
  try { r = await api(`/screen/resolution`, { method: "POST", body: { res: want } }); } catch (e) { if (explicit) sess.resNote = (e as Error).message; return; }
  if (r.display) sess.display = r.display;
  if (r.result !== "switched" && r.result !== "restored") {
    // Nothing changed on the Mac, so no new size is coming.
    const t = r.result === "kept" ? `Already at ${label}${sess.display?.current ? ` (${sess.display.current.width}×${sess.display.current.height})` : ""}.` : r.message || "That size is not available.";
    sess.resNote = explicit || r.result === "skipped" && !same ? t : "";
    if (!explicit && r.result === "kept") sess.resNote = "";
    if (sess.resNote) { const n = sess.resNote; setTimeout(() => { if (sess.resNote === n) sess.resNote = ""; }, 6000); }
    return;
  }
  sess.resNote = "Switching…";
  setTimeout(() => { sess.resNote = resizedAt < sent && rfb ? "The Mac did not report a new size. Disconnect and connect again to use it." : ""; }, 4000);
}

export function setMode(m: Mode) {
  const before = resOf();
  sess.mode = m; save("sos.screen.mode", m);
  if (!sess.chosenRes && resOf() !== before) void postRes(false); // no explicit choice: the mode's default resolution applies
  if (!rfb) return;
  rfb.qualityLevel = LEVELS[m].quality; rfb.compressionLevel = LEVELS[m].compression;
  (rfb as unknown as { _sendEncodings?: () => void })._sendEncodings?.(); // resend the list now, no reconnect
}

export function login(user: string, pass: string) {
  if (!rfb || !pass || (sess.needUser && !user)) return;
  rfb.sendCredentials(sess.needUser ? { username: user, password: pass } : { password: pass });
  sess.phase = "connecting";
}
export function setFit() { sess.fit = !sess.fit; if (rfb) { sess.pan = false; applyView(); } }
export function setView() { sess.viewOnly = !sess.viewOnly; applyView(); }
export function setPan() { sess.pan = !sess.pan; applyView(); }
export function keyCombo(syms: [number, string][]) {
  if (!rfb) return;
  for (const [s, c] of syms) rfb.sendKey(s, c, true);
  for (const [s, c] of [...syms].reverse()) rfb.sendKey(s, c, false);
  rfb.focus();
}
export const ctrlAltDel = () => rfb?.sendCtrlAltDel();
export const focusScreen = () => rfb?.focus();
export function disconnect() { const r = rfb; rfb = null; pipHeld = null; r?.disconnect(); sess.started = false; sess.statsText = ""; sess.fps = 0; sess.fbW = sess.fbH = 0; if (sess.phase === "connected" || sess.phase === "login" || sess.phase === "connecting") sess.phase = "closed"; }
export const live = () => rfb !== null;

export function setCorner(c: Corner) { sess.corner = c; save("sos.screen.pip", c); }
