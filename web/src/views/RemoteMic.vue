<script setup lang="ts">
// The phone's mic page (<https panel>/#mic?s=<session>&code=<pairing code>), opened from the QR code in the voice chat.
// It pairs the phone first when it isn't signed in (the normal one-time device code), then records what you say and
// posts each clip to the chat's mic session; the computer sends it and speaks the answer. Nothing else of the panel
// loads here. The chat can also ask the phone to listen (the TV remote's mic button: a `listen` event), once the mic
// is switched on here with one tap (browsers only open a mic after a tap); its answers show here too.
import { ref, computed, onMounted, onUnmounted } from "vue";
import { MIC_PROBLEM, micSupport, useMic } from "../chat/audio";
import Icon from "../components/Icon.vue";

const q = new URLSearchParams(location.hash.replace(/^#mic\??/, ""));
const sid = q.get("s") ?? "", code = q.get("code");
const step = ref<"start" | "pairing" | "ready" | "ended" | "error">("start"), err = ref<string | null>(null);
const name = ref("your assistant"), lang = ref("auto");
const mic = useMic();
const handsFree = ref(false), sending = ref(false), last = ref<string | null>(null), note = ref<string | null>(null);
const answer = ref<string | null>(null), remote = ref(false);
const device = /iPhone/.test(navigator.userAgent) ? "iPhone" : /iPad/.test(navigator.userAgent) ? "iPad" : /Android/.test(navigator.userAgent) ? "Android phone" : "Phone";

async function j<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`/api/v1${path}`, init);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.detail ?? d.title ?? `HTTP ${r.status}`), { status: r.status });
  return d as T;
}
const post = (path: string, body: unknown) => j(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const state = (s: string) => post(`/voice/mic/${sid}/state`, { state: s, device }).catch((e) => { if ((e as { status?: number }).status === 404) step.value = "ended"; });

let beat: ReturnType<typeof setInterval> | null = null;
onMounted(async () => {
  if (!sid) { step.value = "error"; err.value = "This link is incomplete. Scan the code in the chat again."; return; }
  try {
    const me = await j<{ signedIn: boolean }>("/auth/me");
    if (!me.signedIn) {
      if (!code) throw new Error("This phone isn't signed in. Open a new code from the chat and scan it.");
      step.value = "pairing";
      await post("/pair", { code, name: `${device} mic`, web: true }); // the browser keeps the device token in a cookie
    }
    const s = await j<{ name: string }>(`/voice/mic/${sid}`);
    name.value = s.name;
    // English or Turkish, whichever is spoken: whisper detects it (lang stays "auto")
    step.value = "ready";
    void state("connected");
    beat = setInterval(() => void state(mic.recording.value ? "recording" : mic.listening.value ? "listening" : "connected"), 15_000);
    follow();
    void keepAwake();
    history.replaceState(null, "", `#mic?s=${sid}`); // the pairing code is spent; keep it out of the address bar
  } catch (e) { step.value = (e as { status?: number }).status === 404 ? "ended" : "error"; err.value = (e as Error).message; }
});
// What the chat says to this phone: listen now (the TV's mic button), and its answers.
let es: EventSource | null = null;
function follow() {
  es?.close();
  es = new EventSource(`/api/v1/voice/mic/${sid}/events`);
  es.addEventListener("mic", (ev) => {
    const e = JSON.parse((ev as MessageEvent).data) as { type: string; text?: string };
    if (e.type === "reply" && e.text) answer.value = e.text.replace(/```[\s\S]*?```/g, "").trim() || answer.value;
    else if (e.type === "listen") void listenNow();
  });
}
async function listenNow() {
  if (sending.value || mic.listening.value) return;
  if (!mic.open.value) { note.value = "The TV asked to listen: tap the mic once so it can."; return; }
  note.value = null; answer.value = null; remote.value = true;
  mic.listen(upload); void state("listening");
}
// Keep the screen on while it is the TV's mic (Safari stops a page whose screen locked).
let lock: { release: () => Promise<void> } | null = null;
async function keepAwake() { try { lock = await (navigator as unknown as { wakeLock?: { request: (t: string) => Promise<typeof lock> } }).wakeLock?.request("screen") ?? null; } catch { /* not supported */ } }
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && step.value === "ready") { void keepAwake(); void state("connected"); } });
async function enable() { if (await mic.start()) { note.value = null; void state("connected"); } else note.value = mic.problem.value ? MIC_PROBLEM[mic.problem.value] : "No microphone"; }
const leave = () => { if (step.value === "ready") navigator.sendBeacon?.(`/api/v1/voice/mic/${sid}/state`, new Blob([JSON.stringify({ state: "gone", device })], { type: "application/json" })); };
addEventListener("pagehide", leave);
onUnmounted(() => { leave(); removeEventListener("pagehide", leave); if (beat) clearInterval(beat); mic.close(); es?.close(); void lock?.release().catch(() => {}); });

async function upload(b: Blob) {
  mic.stopListening();
  if (b.size < 1200) { again(); return; }
  sending.value = true; note.value = null; void state("sending");
  try {
    const r = await fetch(`/api/v1/voice/mic/${sid}/clip?lang=${lang.value}`, { method: "POST", headers: { "Content-Type": b.type || "audio/mp4" }, body: b });
    const d = await r.json().catch(() => ({}));
    if (r.status === 404) { step.value = "ended"; return; }
    if (!r.ok) throw new Error(d.detail ?? `HTTP ${r.status}`);
    last.value = d.text || null;
    if (!d.text) note.value = "Didn't catch that. Try again a little closer.";
  } catch (e) { note.value = (e as Error).message; }
  sending.value = false;
  again();
}
function again() { remote.value = false; if (handsFree.value && step.value === "ready") mic.listen(upload); else void state("connected"); }

let downAt = 0, ptt = false;
async function down(e: PointerEvent) {
  try { (e.currentTarget as Element | null)?.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
  note.value = null;
  if (mic.listening.value) { const b = mic.recording.value ? await mic.finish() : null; mic.stopListening(); if (b && !handsFree.value) void upload(b); else void state("connected"); return; }
  if (!(await mic.start())) { note.value = mic.problem.value ? MIC_PROBLEM[mic.problem.value] : "No microphone"; return; }
  if (handsFree.value) { mic.listen(upload); void state("listening"); return; }
  downAt = performance.now(); ptt = true; mic.record(); void state("recording");
}
async function up() {
  if (!ptt) return;
  ptt = false;
  const b = await mic.finish();
  if (performance.now() - downAt >= 450) { if (b) void upload(b); return; }
  mic.listen(upload); void state("listening");
}
function toggleHands() { handsFree.value = !handsFree.value; if (!handsFree.value) { mic.stopListening(); void state("connected"); } }
const support = micSupport();
const phase = computed(() => (sending.value ? "Writing down what you said…" : mic.recording.value ? "Hearing you…" : mic.listening.value ? "Listening… just talk" : "Hold to talk, or tap and speak"));
</script>

<template>
  <main class="rm">
    <header class="rm-h"><span class="rm-av" aria-hidden="true">{{ name.slice(0, 1).toUpperCase() }}</span><span><b>{{ name }}</b><small>Phone microphone</small></span></header>
    <section v-if="step === 'ready'" class="rm-body">
      <p v-if="!support.ok" class="rm-warn">{{ MIC_PROBLEM[support.problem!] }}</p>
      <template v-else>
        <p class="rm-sub">Connected to the chat on your {{ remote ? "TV" : "computer or TV" }}. The answer is spoken there.</p>
        <div class="rm-orb-wrap">
          <span class="rm-ring" :style="{ transform: `scale(${1 + mic.level.value * 0.6})` }" aria-hidden="true"></span>
          <button type="button" class="rm-orb" :class="{ rec: mic.recording.value, busy: sending }" :aria-label="mic.listening.value ? 'Stop' : 'Talk'" @pointerdown="down" @pointerup="up" @pointercancel="up" @contextmenu.prevent><Icon name="mic" :size="40" /></button>
        </div>
        <p class="rm-phase" role="status">{{ phase }}</p>
        <p v-if="note" class="rm-note">{{ note }}</p>
        <p v-else-if="last" class="rm-last">“{{ last }}”<span>sent to the chat</span></p>
        <p v-if="answer" class="rm-ans">{{ answer }}</p>
        <button v-if="!mic.open.value" type="button" class="rm-en" @click="enable">Let the TV use this mic</button>
        <p v-else class="rm-sub">The TV's mic button can start this mic. Keep this page open.</p>
        <label class="rm-hf"><span>Hands-free</span><button type="button" class="sw" role="switch" :aria-checked="handsFree" aria-label="Hands-free" @click="toggleHands"></button></label>
      </template>
    </section>
    <section v-else class="rm-body">
      <Icon v-if="step === 'start' || step === 'pairing'" name="loader" :size="30" class="rm-spin" />
      <p class="rm-phase">{{ step === "pairing" ? "Pairing this phone…" : step === "start" ? "Connecting…" : step === "ended" ? "This mic link has ended." : "Can't connect" }}</p>
      <p v-if="err || step === 'ended'" class="rm-note">{{ step === "ended" ? "Open a new code from the chat on your computer and scan it." : err }}</p>
    </section>
  </main>
</template>

<style scoped>
.rm{min-height:100dvh;display:flex;flex-direction:column;background:radial-gradient(120% 60% at 50% 0%,#1a1210,var(--bg) 60%);color:var(--ink);padding:env(safe-area-inset-top,0) 16px env(safe-area-inset-bottom,0)}
.rm-h{display:flex;align-items:center;gap:10px;padding:16px 0}
.rm-h span:last-child{display:flex;flex-direction:column}
.rm-h b{font:700 16px var(--body)}.rm-h small{font-size:12px;color:var(--muted)}
.rm-av{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;font:700 14px var(--body);color:#1a0c06;background:linear-gradient(140deg,#ffb59c,#d97757)}
.rm-body{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;text-align:center;padding-bottom:12vh}
.rm-sub{margin:0;color:var(--muted);font-size:14px;max-width:300px}
.rm-orb-wrap{position:relative;width:200px;height:200px;display:grid;place-items:center}
.rm-ring{position:absolute;inset:10px;border-radius:50%;background:radial-gradient(circle,rgba(217,119,87,.35),rgba(217,119,87,0) 70%);transition:transform .08s linear}
.rm-orb{position:relative;width:150px;height:150px;border-radius:50%;border:1px solid rgba(255,181,156,.45);display:grid;place-items:center;color:#1a0c06;background:linear-gradient(150deg,#ffc2ad,#d97757 70%);box-shadow:0 14px 50px rgba(217,119,87,.4);touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}
.rm-orb.rec{background:linear-gradient(150deg,#ff8a94,#e00018 75%);color:#fff}
.rm-orb.busy{filter:saturate(.5) brightness(.8)}
.rm-phase{margin:0;font:600 17px var(--body)}
.rm-note{margin:0;color:#ffd38a;font-size:14px;max-width:320px}
.rm-last{margin:0;display:flex;flex-direction:column;gap:3px;font-style:italic;color:#d6d6db;max-width:320px}
.rm-last span{font-style:normal;font-size:12px;color:var(--muted)}
.rm-warn{margin:0;max-width:320px;color:#ffd38a;background:var(--warn-bg);border:1px solid rgba(255,178,30,.35);border-radius:12px;padding:12px}
.rm-hf{display:inline-flex;align-items:center;gap:10px;font:600 14px var(--body);color:var(--muted)}
.rm-hf .sw{margin:0}
.rm-ans{margin:0;max-width:340px;max-height:30vh;overflow:auto;font-size:14px;line-height:1.45;color:var(--ink);background:var(--panel-2);border:1px solid var(--line);border-radius:12px;padding:10px 12px;text-align:left;white-space:pre-wrap}
.rm-en{font:600 15px var(--body);color:#1a0c06;background:linear-gradient(150deg,#ffc2ad,#d97757 70%);border:0;border-radius:999px;padding:11px 20px;cursor:pointer}
.rm-spin{animation:rm-spin .9s linear infinite;color:var(--muted)}
@keyframes rm-spin{to{transform:rotate(360deg)}}
</style>
