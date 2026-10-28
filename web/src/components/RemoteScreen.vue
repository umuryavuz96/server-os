<script setup lang="ts">
// The Mac / server screen: ONE window that is either a modal over the current page or a picture-in-picture in a corner
// (sess.ui, screen/session.ts). Mounted once in App.vue. The noVNC canvas belongs to the session and lives in `.ms-screen`
// for the whole time, so growing or shrinking only moves and resizes this box (no reconnect). Controls are floating pills
// on the dimmed page above the rounded screen; there is no header bar. Backdrop click and Escape shrink, they never
// disconnect: only the red power button (closeScreen) ends the session.
import { computed, nextTick, onMounted, onUnmounted, ref, toRefs, watch } from "vue";
import { MODES, RES_HELP, RES_LABEL, RESES } from "../screen/modes";
import type { Mode, Res } from "../screen/modes";
import * as S from "../screen/session";
import { sess } from "../screen/session";
import { P } from "../permissions";
import PermSteps from "./PermSteps.vue";

const { ui, phase, status, reason, loginErr, needUser, fit, viewOnly, pan, mode, showStats, statsText, statsTip, resNote, display } = toRefs(sess);
const res = computed(S.shownRes);
const fixPerm = computed(() => (sess.perm ? P.list.find((p) => p.id === sess.perm) ?? null : null));
const onlyNative = computed(() => !!display.value?.sizes.length && display.value.sizes.every((o) => o.res === "native" || !o.available || (o.width === display.value!.current?.width && o.height === display.value!.current?.height)));
const resLabel = (r: Res) => r === "native" && onlyNative.value && display.value?.current ? `Native ${display.value.current.width}×${display.value.current.height}` : RES_LABEL[r];
const resOff = (r: Res) => !!S.resTip(r);
const user = ref(""), pass = ref(""), keys = ref(false), more = ref(false), copied = ref(""), screen = ref<HTMLDivElement | null>(null);
const MODE_HELP: Record<Mode, string> = { performance: "Smaller, lossy pictures: for a slow link", balanced: "noVNC defaults", quality: "Lossless pictures: sharper, more data" };
const isMac = computed(() => !status.value || status.value.platform === "darwin");
const noun = computed(() => status.value?.noun ?? "Mac screen");
const modal = computed(() => ui.value === "modal"), pip = computed(() => ui.value === "pip");
const live = computed(() => phase.value === "connected");
const secure = window.isSecureContext;
async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); copied.value = text; setTimeout(() => (copied.value = ""), 1500); } catch { /* plain http has no clipboard: the text is selectable */ }
}
function login() { if (!pass.value || (needUser.value && !user.value)) return; S.login(user.value, pass.value); pass.value = ""; /* never kept in this page after use */ }
function close() { pass.value = ""; keys.value = more.value = false; S.closeScreen(); }
const PHASE_TEXT: Partial<Record<typeof sess.phase, string>> = { checking: "Checking…", connecting: "Connecting…", login: "Waiting for login", busy: "In use elsewhere", off: "Off in config", "not-listening": "Not running", closed: "Disconnected" };
const dot = computed(() => (live.value ? "on" : phase.value === "closed" || phase.value === "off" ? "bad" : "warn"));

// X11 keysyms (noVNC's keysym table)
const K = { esc: 0xff1b, tab: 0xff09, cmd: 0xffe7, space: 0x0020, ret: 0xff0d };
function combo(syms: [number, string][]) { S.keyCombo(syms); keys.value = false; }

// The canvas: one node, moved into the window once.
const host = S.host;
const shown = computed(() => phase.value === "connected" || phase.value === "login" || phase.value === "connecting");
watch(shown, (v) => (host.style.visibility = v ? "visible" : "hidden"), { immediate: true });
watch(screen, (el) => { if (el) S.attach(el); }, { flush: "post" });
watch(ui, (u) => { keys.value = more.value = false; if (u === "closed") pass.value = ""; S.applyView(); });
watch([needUser, phase, ui], async ([n, p, u]) => { if (p === "login" && u === "modal") { await nextTick(); (document.getElementById(n ? "mac-user" : "mac-pass") as HTMLInputElement | null)?.focus(); } });

// Geometry. Both states are plain rectangles in px and CSS transitions the box between them (the "morph"); the pills are
// children of the box, so they travel with it.
const vw = ref(innerWidth), vh = ref(innerHeight);
const onResize = () => { vw.value = innerWidth; vh.value = innerHeight; };
const phone = computed(() => vw.value <= 620);
// Height of the caption under the screen (the Fix strip): the screen shrinks by exactly that, so controls, screen and strip
// always fit the viewport. Measured, because the strip is one row or two depending on the width.
const cap = ref<HTMLDivElement | null>(null), capH = ref(0);
let capRo: ResizeObserver | null = null;
watch(cap, (el) => { capRo?.disconnect(); capRo = null; if (el && typeof ResizeObserver !== "undefined") { capRo = new ResizeObserver(() => (capH.value = Math.ceil(el.getBoundingClientRect().height))); capRo.observe(el); } else capH.value = 0; });
onUnmounted(() => capRo?.disconnect());
const ratio = computed(() => (sess.fbW > 0 && sess.fbH > 0 ? sess.fbW / sess.fbH : 16 / 10));
const pos = ref<{ x: number; y: number } | null>(null);
const dragging = ref(false);
const rect = computed(() => {
  const W = vw.value, H = vh.value;
  if (modal.value) {
    const gx = phone.value ? 12 : Math.round(W * 0.05), w = W - 2 * gx;
    const top = (phone.value ? 12 : 16) + (phone.value ? 44 : 40) + 14, bottom = sess.perm ? 12 + Math.max(capH.value, phone.value ? 150 : 64) + 12 : phone.value ? 64 : 56, avail = H - top - bottom;
    if (phone.value && live.value) { const h = Math.min(Math.round(w / ratio.value), avail); return { l: gx, t: top + Math.round((avail - h) / 2), w, h, r: 18 }; }
    return { l: gx, t: top, w, h: Math.max(avail, 200), r: phone.value ? 18 : 22 };
  }
  const w = Math.min(phone.value ? 176 : 348, W - 24), h = Math.round(w / ratio.value), m = phone.value ? 10 : 16;
  const tb = W <= 860 ? 64 : m;
  if (pos.value) return { l: pos.value.x, t: pos.value.y, w, h, r: 14 };
  const c = sess.corner;
  return { l: c[1] === "l" ? m : W - w - m, t: c[0] === "t" ? tb : H - h - m, w, h, r: 14 };
});
const winStyle = computed(() => { const r = rect.value; return { left: r.l + "px", top: r.t + "px", width: r.w + "px", height: r.h + "px", borderRadius: r.r + "px" }; });

// PiP: drag by the picture; a press that barely moves is a tap (= grow).
let start: { px: number; py: number; ox: number; oy: number; moved: boolean } | null = null;
function down(e: PointerEvent) {
  const r = rect.value;
  start = { px: e.clientX, py: e.clientY, ox: r.l, oy: r.t, moved: false };
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}
function move(e: PointerEvent) {
  if (!start) return;
  const dx = e.clientX - start.px, dy = e.clientY - start.py;
  if (!start.moved && Math.hypot(dx, dy) < 6) return;
  start.moved = true; dragging.value = true;
  pos.value = { x: start.ox + dx, y: start.oy + dy };
}
function up() {
  if (!start) return;
  const s = start; start = null; dragging.value = false;
  if (!s.moved) { S.openScreen(); return; }
  const r = rect.value, cx = r.l + r.w / 2, cy = r.t + r.h / 2;
  S.setCorner(((cy < vh.value / 2 ? "t" : "b") + (cx < vw.value / 2 ? "l" : "r")) as S.Corner); pos.value = null;
}

// Escape shrinks, but only while the modal is open and never when it is meant for the remote screen (focus in the canvas
// and control mode on): then it is the Mac's Escape. Without a picture (login, errors) Escape closes the window.
const onKey = (e: KeyboardEvent) => {
  if (e.key !== "Escape" || ui.value !== "modal" || e.defaultPrevented) return;
  if (keys.value) { keys.value = false; return; }
  if (more.value) { more.value = false; return; }
  if (live.value) { if (!viewOnly.value && host.contains(document.activeElement)) return; S.shrinkScreen(); } else if (phase.value !== "connecting") close();
};
const onDim = () => { if (live.value) S.shrinkScreen(); };
onMounted(() => { addEventListener("keydown", onKey); addEventListener("resize", onResize); });
onUnmounted(() => { removeEventListener("keydown", onKey); removeEventListener("resize", onResize); });
</script>

<template>
  <div v-if="ui !== 'closed'" class="rs" :class="{ modal, pip, phone, dragging }">
    <button type="button" class="rs-dim" tabindex="-1" aria-label="Shrink to picture-in-picture" @click="onDim"></button>

    <div class="rs-win" :style="winStyle" role="dialog" :aria-modal="modal" :aria-label="sess.title || noun">
      <!-- Floating controls: every one is its own rp on the dimmed page, no shared bar -->
      <Transition name="rs-bar">
        <div v-if="modal" class="rs-bar">
          <div class="rp rs-status"><span class="rd" :class="dot"></span><b>{{ sess.title || noun }}</b>
            <span v-if="live" class="rs-mono">{{ sess.fps }} fps · {{ sess.fbW && sess.fbH ? `${sess.fbW}×${sess.fbH}` : "…" }}</span>
            <span v-else class="rs-mono">{{ PHASE_TEXT[phase] }}</span>
          </div>
          <span class="rs-rp"></span>
          <template v-if="live">
            <div class="rp sg x" role="group" aria-label="Picture mode">
              <button v-for="m in MODES" :key="m" type="button" :aria-pressed="mode === m" :title="MODE_HELP[m]" @click="S.setMode(m)">{{ m[0].toUpperCase() + m.slice(1) }}</button>
            </div>
            <button type="button" class="rp x" :aria-pressed="fit" @click="S.setFit()">{{ fit ? "Fit" : "1:1" }}</button>
            <button v-if="!fit" type="button" class="rp x" :aria-pressed="pan" @click="S.setPan()">{{ pan ? "Panning" : "Pan" }}</button>
            <button type="button" class="rp x" :aria-pressed="viewOnly" @click="S.setView()">{{ viewOnly ? "View only" : "Control" }}</button>
            <div class="rs-keys">
              <button type="button" class="rp" :aria-expanded="keys" @click="keys = !keys">Keys</button>
              <div v-if="keys" class="rs-menu" role="menu">
                <button type="button" role="menuitem" @click="combo([[K.esc, 'Escape']])">Esc</button>
                <button type="button" role="menuitem" @click="combo([[K.tab, 'Tab']])">Tab</button>
                <button type="button" role="menuitem" @click="combo([[K.ret, 'Enter']])">Return</button>
                <button type="button" role="menuitem" @click="combo([[K.cmd, 'MetaLeft'], [K.space, 'Space']])">⌘ Space (Spotlight)</button>
                <button type="button" role="menuitem" @click="combo([[K.cmd, 'MetaLeft'], [K.tab, 'Tab']])">⌘ Tab</button>
                <button type="button" role="menuitem" @click="S.ctrlAltDel(); keys = false">Ctrl Alt Del</button>
              </div>
            </div>
            <div v-if="status?.resize" class="rp sg x" role="group" aria-label="Resolution">
              <button v-for="r in RESES" :key="r" type="button" :class="{ off: resOff(r) }" :aria-pressed="res === r" :aria-disabled="resOff(r)" :title="S.resTip(r) || RES_HELP[r]" @click="S.setRes(r)">{{ resLabel(r) }}</button>
            </div>
            <button type="button" class="rp x" :aria-pressed="showStats" @click="showStats = !showStats">Stats</button>
            <button type="button" class="rp round more" :aria-pressed="more" aria-label="More controls" title="More controls" @click="more = !more">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.4" /><circle cx="8" cy="8" r="1.4" /><circle cx="13" cy="8" r="1.4" /></svg>
            </button>
            <i class="rs-br" :class="{ open: more }"></i>
          </template>
          <button v-if="live" type="button" class="rp round danger" aria-label="Disconnect" title="Disconnect" @click="close">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M8 1.8v5.4" /><path d="M4.6 4.2a5 5 0 1 0 6.8 0" /></svg>
          </button>
          <button v-if="live" type="button" class="rp round" aria-label="Shrink to picture-in-picture" title="Shrink to picture-in-picture" @click="S.shrinkScreen()">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="2" /><rect x="8" y="8" width="5" height="4" rx="1" fill="currentColor" stroke="none" /></svg>
          </button>
          <button v-else type="button" class="rp round" aria-label="Close" title="Close" @click="close">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" /></svg>
          </button>
        </div>
      </Transition>

      <!-- The rounded screen: border, shadow, nothing else around it -->
      <div class="rs-scr">
        <div ref="screen" class="ms-screen" :class="{ hidden: !shown }"></div>

        <template v-if="modal">
          <div v-if="showStats && live" class="ms-stats" aria-live="off">{{ statsText || "measuring…" }}<br v-if="statsTip" /><b v-if="statsTip" class="ms-tip">{{ statsTip }}</b></div>
          <div v-if="resNote && live" class="ms-note" role="status">{{ resNote }}</div>
          <div v-if="phase === 'checking' || phase === 'connecting'" class="ms-card"><p class="muted">{{ phase === "checking" ? (isMac ? "Checking Screen Sharing…" : "Looking for a VNC server…") : `Connecting to the ${isMac ? "Mac" : "server"}…` }}</p></div>

          <form v-else-if="phase === 'login'" class="ms-card" @submit.prevent="login">
            <h2>{{ needUser ? (isMac ? "Sign in to the Mac" : "Sign in to the server screen") : "VNC password" }}</h2>
            <p class="muted">{{ isMac ? "Screen Sharing asks for a user account on this Mac. What you type is encrypted in this browser and goes straight to macOS; Server OS does not store or see it." : needUser ? "The VNC server asks for a username and password. Server OS passes them on and does not store or log them." : "The VNC server asks for its password (the one you set with vncpasswd, x11vnc -storepasswd or the desktop's sharing settings). Server OS passes it on and does not store or log it." }}</p>
            <label v-if="needUser" class="fld">{{ isMac ? "Mac username" : "Username" }}<input id="mac-user" v-model="user" name="mac-user" autocomplete="off" autocapitalize="off" spellcheck="false" /></label>
            <label class="fld">{{ needUser ? (isMac ? "Mac password" : "Password") : "Password" }}<input id="mac-pass" v-model="pass" name="mac-password" type="password" autocomplete="off" /></label>
            <p v-if="loginErr" class="form-err">{{ loginErr }}</p>
            <div class="ms-row"><button type="submit" class="btn primary" :disabled="!pass || (needUser && !user)">Connect</button><button type="button" class="btn" @click="close">Cancel</button></div>
          </form>

          <div v-else-if="phase === 'busy'" class="ms-card">
            <h2>Someone is viewing the screen</h2>
            <p class="muted">Only one session at a time. If that was you in another tab, take it over.</p>
            <div class="ms-row"><button type="button" class="btn primary" @click="S.connect(true)">Take over</button><button type="button" class="btn" @click="close">Cancel</button></div>
          </div>

          <div v-else-if="phase === 'off'" class="ms-card">
            <h2>The remote screen is off</h2>
            <p class="muted">Turn it on in <code>config/server-os.yaml</code> and restart Server OS:</p>
            <pre class="log">integrations:
  screen: { enabled: true }   # idleMinutes: 5, maxMinutes: 30</pre>
            <p v-if="!isMac" class="muted">On Linux it needs a VNC server on this machine (x11vnc, wayvnc, TigerVNC, krfb); this panel tells you what to run once it is on.</p>
            <div class="ms-row"><button type="button" class="btn" @click="close">Close</button></div>
          </div>

          <div v-else-if="phase === 'not-listening' && isMac" class="ms-card">
            <h2>Screen Sharing is off on the Mac</h2>
            <p class="muted">Turn it on once, then come back. At the Mac: <b>System Settings → General → Sharing → Screen Sharing</b>. Or over SSH:</p>
            <pre class="log">sudo launchctl enable system/com.apple.screensharing
sudo launchctl bootstrap system /System/Library/LaunchDaemons/com.apple.screensharing.plist</pre>
            <p class="muted">The SSH way starts the service; if it is still refused, macOS wants the switch in System Settings (newer releases lock it to a click at the Mac).</p>
            <div class="ms-row"><button type="button" class="btn primary" @click="S.check()">Check again</button><button type="button" class="btn" @click="close">Close</button></div>
          </div>

          <div v-else-if="phase === 'not-listening'" class="ms-card ms-setup">
            <h2>No VNC server is running</h2>
            <p class="muted">Server OS shows this machine's screen through a VNC server on 127.0.0.1 (ports 5900-5910). Start one, then check again. Nothing is installed or started for you: copy a command and run it on the server.</p>
            <p v-if="status?.setup?.found.some((f) => f.exposed)" class="form-err">A VNC server is listening on every network interface. Restart it bound to localhost only (x11vnc: -localhost, vncserver: -localhost yes).</p>
            <p v-if="status?.setup?.installed.length" class="muted">Already installed: {{ status.setup.installed.join(", ") }}.</p>
            <div v-for="o in status?.setup?.options ?? []" :key="o.id" class="ms-opt">
              <b>{{ o.title }}</b><span class="muted">{{ o.note }}</span>
              <div v-for="c in [...o.install, ...o.then]" :key="c" class="ms-cmd"><code>{{ c }}</code><button type="button" class="btn" @click="copy(c)">{{ copied === c ? "Copied" : "Copy" }}</button></div>
            </div>
            <div class="ms-row"><button type="button" class="btn primary" @click="S.check()">Check again</button><button type="button" class="btn" @click="close">Close</button></div>
          </div>

          <div v-else-if="phase === 'closed'" class="ms-card">
            <h2>Disconnected</h2>
            <p class="muted">{{ reason || "The session ended." }}</p>
            <div class="ms-row"><button type="button" class="btn primary" @click="S.check()">Connect again</button><button type="button" class="btn" @click="close">Close</button></div>
          </div>
        </template>

        <!-- PiP: the whole picture is the grow button (and the drag handle) -->
        <template v-if="pip">
          <div v-if="!live" class="rs-pipmsg"><b>Screen closed</b><span>{{ reason || "The session ended." }}</span></div>
          <button type="button" class="rs-tap" aria-label="Grow to full view" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up" @keydown.enter.prevent="S.openScreen()" @keydown.space.prevent="S.openScreen()"></button>
        </template>
      </div>

      <div v-if="pip" class="rs-pipbtns">
        <button type="button" class="rp round sm" aria-label="Grow to full view" title="Grow" @click="S.openScreen()">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" /></svg>
        </button>
        <button type="button" class="rp round sm" :aria-label="live ? 'Disconnect' : 'Dismiss'" :title="live ? 'Disconnect' : 'Dismiss'" @click="close">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" /></svg>
        </button>
      </div>

      <div v-if="modal" ref="cap" class="rs-cap">
        <PermSteps v-if="fixPerm" :perm="fixPerm" compact />
        <p v-else-if="sess.hint && (live || phase === 'login')">{{ sess.hint }}</p>
        <p v-if="!fixPerm && live && !secure">Plain http: the login is encrypted by Apple's scheme, but the screen picture itself is not. Prefer the tailnet https address when you can.</p>
        <p v-else-if="!fixPerm && live && status">Closes after {{ status.idleMinutes }} min without input, {{ status.maxMinutes }} min at most. Tap to click, drag with two fingers to scroll.</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rs{position:fixed;inset:0;z-index:60;pointer-events:none;color:var(--ink)}
.rs-dim{position:absolute;inset:0;width:100%;border:0;padding:0;background:rgba(0,0,0,.66);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);opacity:0;transition:opacity .32s ease;pointer-events:none;cursor:zoom-out;animation:rs-fade .32s ease}
.modal .rs-dim{opacity:1;pointer-events:auto}
.rs-win{position:absolute;pointer-events:auto;transition:left .45s var(--spring),top .45s var(--spring),width .45s var(--spring),height .45s var(--spring),border-radius .45s var(--spring);animation:rs-pop .38s var(--spring)}
.dragging .rs-win{transition:none}
@keyframes rs-fade{from{opacity:0}}
@keyframes rs-pop{from{opacity:0;transform:scale(.96)}}
.rs-scr{position:absolute;inset:0;border-radius:inherit;border:1px solid rgba(255,255,255,.1);box-shadow:0 30px 90px rgba(0,0,0,.6);overflow:hidden;background:#000;display:grid;place-items:center}
.pip .rs-scr{box-shadow:0 14px 40px rgba(0,0,0,.55)}
.ms-screen{position:absolute;inset:0;overflow:hidden}
.ms-screen.hidden{visibility:hidden}
.pip .ms-screen{pointer-events:none}

/* pills */
.rs-bar{--ph:40px;position:absolute;left:0;right:0;bottom:calc(100% + 14px);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rp{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:var(--ph);padding:0 15px;border-radius:99px;border:1px solid rgba(255,255,255,.08);background:rgba(22,22,25,.86);color:var(--ink);font:600 12.5px var(--body);box-shadow:0 8px 24px rgba(0,0,0,.35);cursor:pointer;white-space:nowrap;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);transition:background .15s var(--ease),border-color .15s var(--ease)}
button.rp:hover{background:rgba(40,40,45,.92);border-color:rgba(255,255,255,.16)}
.rp:focus-visible,.sg button:focus-visible{outline:2px solid var(--on);outline-offset:2px}
.rp[aria-pressed="true"]:not(.sg):not(.more){background:var(--ink);color:#050506;border-color:var(--ink)}
.rp.round{width:var(--ph);padding:0}
.rp.round.sm{--ph:30px;background:rgba(22,22,25,.82);border-color:rgba(255,255,255,.1);box-shadow:0 4px 12px rgba(0,0,0,.4)}
.rp.danger{border-color:rgba(255,59,69,.45);background:rgba(60,12,16,.9);color:#ff6a72}
.rp.danger:hover{background:rgba(90,16,22,.95);border-color:rgba(255,59,69,.7)}
.rp.more{display:none}
.rs-status{cursor:default;padding:0 14px;gap:8px}
.rs-status b{font:700 17px var(--display);letter-spacing:.03em}
.rs-mono{font:500 12px var(--mono);color:var(--muted)}
.rd{width:8px;height:8px;border-radius:99px;background:var(--muted);flex:none}
.rd.on{background:var(--on)}.rd.warn{background:var(--warn)}.rd.bad{background:var(--bad)}
.rs-rp{flex:1}
.rs-br{display:none}
.sg{padding:3px;gap:0}
.sg button{all:unset;box-sizing:border-box;cursor:pointer;height:100%;padding:0 13px;border-radius:99px;font:600 12.5px var(--body);color:#c9ccd1;display:inline-flex;align-items:center}
.sg button[aria-pressed="true"]{background:var(--ink);color:#050506}
.sg button.off{opacity:.45;cursor:not-allowed}
.rs-keys{position:relative}
.rs-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:3;background:#17181c;border:1px solid var(--line);border-radius:12px;padding:4px;display:flex;flex-direction:column;min-width:200px;box-shadow:0 20px 50px rgba(0,0,0,.5)}
.rs-menu button{all:unset;cursor:pointer;padding:10px 11px;border-radius:8px;font:600 13px var(--body)}
.rs-menu button:hover,.rs-menu button:focus-visible{background:var(--panel)}
.rs-bar-enter-active,.rs-bar-leave-active{transition:opacity .2s ease}
.rs-bar-enter-from,.rs-bar-leave-to{opacity:0}
.rs-bar-leave-active{pointer-events:none}

.rs-pipbtns{position:absolute;top:8px;right:8px;z-index:2;display:flex;gap:6px}
.rs-tap{all:unset;position:absolute;inset:0;cursor:grab;touch-action:none;user-select:none;border-radius:inherit}
.dragging .rs-tap{cursor:grabbing}
.rs-tap:focus-visible{outline:2px solid var(--ink);outline-offset:-3px}
.rs-pipmsg{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;gap:4px;padding:14px;font-size:12.5px;color:var(--muted);background:var(--panel)}
.rs-pipmsg b{color:var(--ink)}
.rs-cap{position:absolute;left:0;right:0;top:calc(100% + 12px);display:flex;flex-direction:column;align-items:center;gap:2px;text-align:center}
.rs-cap>.ps{width:100%;max-width:1180px;pointer-events:auto}
.rs-cap p{margin:0;max-width:760px;font-size:12px;line-height:1.4;color:var(--muted)}

/* cards inside the rounded screen (login, takeover, setup) */
.ms-card{position:relative;z-index:1;width:min(440px,calc(100% - 32px));background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:22px;display:flex;flex-direction:column;gap:12px}
.ms-card h2{margin:0;font:700 17px var(--body);text-transform:none;letter-spacing:0}
.ms-card p{margin:0}
.ms-card pre{margin:0;max-height:none}
.ms-setup{max-height:calc(100% - 24px);overflow:auto}
.ms-opt{display:flex;flex-direction:column;gap:5px;font-size:13px}
.ms-cmd{display:flex;gap:6px;align-items:center}
.ms-cmd code{flex:1;min-width:0;overflow-wrap:anywhere;font:11.5px var(--mono);background:var(--panel-2);padding:5px 7px;border-radius:6px}
.ms-row{display:flex;gap:8px;flex-wrap:wrap}
.ms-stats{position:absolute;left:10px;bottom:10px;z-index:2;max-width:calc(100% - 20px);padding:4px 8px;border-radius:6px;background:rgba(0,0,0,.72);color:#9fe6a0;font:11px/1.35 ui-monospace,monospace;pointer-events:none}
.ms-tip{color:#ffd479;font-weight:600}
.ms-note{position:absolute;top:10px;left:50%;transform:translateX(-50%);z-index:2;max-width:calc(100% - 24px);padding:6px 12px;border-radius:8px;background:rgba(0,0,0,.8);color:#fff;font:600 12.5px var(--body)}
.form-err{color:var(--bad);font-size:12.5px}

/* phone: 44px pills; status, Keys, Disconnect, Shrink on the first row, the rest behind the "more" rp */
.phone .rs-bar{--ph:44px;bottom:calc(100% + 12px)}
.phone .rp{font-size:13.5px}
.phone .rs-status{flex:1 1 0;min-width:96px;padding:0 12px}
.phone .rs-status b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.phone .rs-mono{display:none}
.phone .rp.more{display:inline-flex}
.phone .x{display:none;order:-1}
.phone .rs-br{order:-1;flex-basis:100%;height:0}
.phone .rs-bar:has(.more[aria-pressed="true"]) .x{display:inline-flex}
.phone .rs-bar:has(.more[aria-pressed="true"]) .sg.x{display:flex}
.phone .rs-bar:has(.more[aria-pressed="true"]) .rs-br{display:block}
.phone .rs-menu{right:0;min-width:210px}
.phone .rs-cap{top:calc(100% + 10px)}

@media(prefers-reduced-motion:reduce){
  .rs-win,.rs-dim,.rs-bar-enter-active,.rs-bar-leave-active,.rp{transition:none!important;animation:none!important}
  .rs-dim{animation:none!important}
}
</style>
