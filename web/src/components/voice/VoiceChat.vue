<script setup lang="ts">
// The voice assistant's chat (docs/voice-chat.md). The conversation is the voice bot's own session, live over its
// feed; typed messages go in as "[Chat] …", spoken ones as "[Voice] …" / "[Voice tr] …" like the apps send them.
// Answers render as Markdown with component blocks (cards, charts, code) and the web pages the assistant used as
// source cards. Voice mode: hold the mic to talk, tap it for one sentence, or go hands-free; replies are spoken in
// the browser (or on a Home Assistant speaker) and pressing the mic cuts them off. When this browser can't use a
// microphone (plain http, none found, blocked), the phone or the desk speaker can be the mic instead.
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from "vue";
import { api, toast } from "../../store";
import { useFeed, clock, dur, newNonce, type FeedItem } from "../../bots";
import { CHAT_PREFIX, activity, plainText, turns as toTurns, voicePrefix, type Turn } from "../../chat/blocks";
import { MIC_PROBLEM, micSupport, useMic, usePlayer } from "../../chat/audio";
import Icon from "../Icon.vue";
import VcMessage from "./VcMessage.vue";
import VcSources from "./VcSources.vue";
import VcDevices, { type DevState, type InputKind } from "./VcDevices.vue";
import VcPhonePair from "./VcPhonePair.vue";
import { useDpad } from "../../chat/useDpad";

export interface ChatInfo {
  name: string; channel: string; available: boolean; running: boolean; voice: string; language: "en" | "tr" | "auto";
  stt: { available: boolean; model: string | null; reason: string | null };
  deskSpeaker: { available: boolean; enabled?: boolean; state?: string }; speakers: { configured: boolean }; phoneUrl: string | null; auth: string;
}
// kiosk: the TV screen (#voice-chat?kiosk=1): its own calm 10-foot layout (a 1920×1080 canvas, VoiceKiosk), D-pad focus
// navigation, voice mode open, no per-message buttons, settings in a sheet, only the last half hour of the conversation,
// spoken turns sent as "[TV] …" so the answers come back TV-sized, and on a device without a microphone the phone
// pairing QR in the middle.
const p = defineProps<{ info: ChatInfo; kiosk?: boolean }>();
const emit = defineEmits<{ refresh: [] }>();
const channel = computed(() => p.info.channel);
const { items, echoes, meta, state, echo, echoState, dismiss } = useFeed(channel);
const mic = useMic();
const player = usePlayer();

// ---------- preferences (this browser only) ----------
const pref = <T extends string>(k: string, d: T): T => { try { return (localStorage.getItem("vc." + k) as T) || d; } catch { return d; } };
const save = (k: string, v: string) => { try { localStorage.setItem("vc." + k, v); } catch { /* private mode */ } };
const input = ref<InputKind>(pref<InputKind>("input", micSupport().ok ? "browser" : "phone"));
const output = ref<string>(pref("output", "browser"));
// ?mic=tv (Salon TV): the remote's mic button picks the mic: the TV's USB mic, else a connected phone, else the QR
const tvMode = typeof location !== "undefined" && /[?&]mic=tv\b/.test(location.hash);
const handsFree = ref(pref<string>("handsFree", "0") === "1");
watch(input, (v) => save("input", v)); watch(output, (v) => save("output", v)); watch(handsFree, (v) => save("handsFree", v ? "1" : "0"));

// ---------- the conversation ----------
const LIMIT = 40;
const limit = ref(LIMIT);
// always a new array: the feed patches items in place, and a computed that returned the same array wouldn't notify
const all = computed(() => [...items.value, ...echoes.value] as FeedItem[]);
const past = ref<{ session: string; items: FeedItem[]; when: number } | null>(null);
const allTurns = computed<Turn[]>(() => toTurns(past.value ? past.value.items : all.value));
// The TV shows the recent conversation only (&recent=<minutes>, 30 by default): an old answer doesn't sit on the screen
// for hours. "Show earlier" in the settings sheet brings the rest back.
const RECENT = (() => { const m = typeof location !== "undefined" ? location.hash.match(/[?&]recent=(\d+)/) : null; return (m ? Number(m[1]) : 30) * 60_000; })();
const showAll = ref(false);
const turnTs = (t: Turn) => (t.type === "assistant" ? t.ts : t.item.ts);
const shown = computed(() => {
  const list = allTurns.value.slice(-limit.value);
  if (!p.kiosk || showAll.value || past.value) return list;
  const since = now.value - RECENT;
  return list.filter((t) => turnTs(t) >= since || (t.type === "assistant" && t.running) || (t.type === "user" && !!t.item.local));
});
const hidden = computed(() => allTurns.value.length - shown.value.length);
const working = computed(() => (past.value ? null : meta.value?.session?.working ?? null));
const runningStep = computed(() => { for (let i = all.value.length - 1; i >= 0; i--) { const it = all.value[i]; if (it.kind === "user") return null; if (it.kind === "step" && it.status === "running") return it; } return null; });
const doing = computed(() => activity(runningStep.value, working.value));
const lastAssistant = computed(() => [...shown.value].reverse().find((t) => t.type === "assistant")?.key ?? null);
const userText = (key: string | null) => { const t = allTurns.value.find((x) => x.key === key); return t?.type === "user" ? t : null; };
const queryOf = (t: Extract<Turn, { type: "assistant" }>) => t.steps.find((s) => s.tool === "WebSearch")?.detail ?? null;

// ---------- scrolling: follow the end unless the reader scrolled up ----------
const box = ref<HTMLElement | null>(null);
const stick = ref(true), unseen = ref(false);
function onScroll() { const el = box.value; if (!el) return; stick.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80; if (stick.value) unseen.value = false; }
async function follow(force = false) {
  await nextTick(); const el = box.value; if (!el) return;
  // the TV: the latest question at the top of the screen with its answer below (a spacer makes room), like a fresh page
  if (p.kiosk) { const u = [...el.querySelectorAll<HTMLElement>(".vc-u")].at(-1); el.scrollTop = u ? Math.max(0, u.offsetTop - 8) : el.scrollHeight; unseen.value = false; return; }
  if (stick.value || force) { el.scrollTop = el.scrollHeight; unseen.value = false; } else unseen.value = true;
}
watch(() => [allTurns.value.length, all.value.at(-1)?.id, all.value.at(-1)?.status, doing.value], () => follow());
watch(state, (s) => { if (s === "live") void follow(true); });
async function earlier() {
  const el = box.value, h = el?.scrollHeight ?? 0;
  limit.value += LIMIT;
  await nextTick();
  if (el) el.scrollTop += el.scrollHeight - h; // keep the message you were reading in place
}

// ---------- history: earlier conversations of this session folder ----------
const sessions = ref<{ session: string; updated: number; messages: number; preview: string }[] | null>(null);
const historyOpen = ref(false);
async function openHistory() {
  historyOpen.value = !historyOpen.value;
  if (historyOpen.value) try { sessions.value = await api(`/bots/${encodeURIComponent(channel.value)}/sessions`); } catch (e) { toast((e as Error).message); }
}
async function openPast(s: { session: string; updated: number }) {
  if (s.session === meta.value?.session?.session) { past.value = null; historyOpen.value = false; return; }
  try { past.value = { session: s.session, when: s.updated, items: await api(`/bots/${encodeURIComponent(channel.value)}/sessions/${s.session}`) }; historyOpen.value = false; limit.value = LIMIT; void follow(true); }
  catch (e) { toast((e as Error).message); }
}
function backToLive() { past.value = null; limit.value = LIMIT; void follow(true); }

// ---------- sending ----------
const draft = ref(""), ta = ref<HTMLTextAreaElement | null>(null);
async function deliver(text: string, nonce: string) {
  try { await api(`/bots/${encodeURIComponent(channel.value)}/send`, { body: { text, nonce } }); echoState(nonce, "queued"); }
  catch (e) { echoState(nonce, "failed", (e as Error).message || "Couldn't send"); if (pending.value?.nonce === nonce) pending.value = null; }
}
function send(raw: string, mode: "chat" | "voice", lang?: string) {
  const text = (mode === "voice" ? voicePrefix(lang ?? p.info.language, p.kiosk) : CHAT_PREFIX) + raw.trim();
  const nonce = echo(text, newNonce());
  if (mode === "voice") { pending.value = { nonce, at: Date.now(), lang: lang ?? p.info.language }; spoken.clear(); }
  if (past.value) backToLive();
  stick.value = true; void follow(true);
  void deliver(text, nonce);
}
function submit() {
  const t = draft.value.trim();
  if (!t) return;
  draft.value = ""; void nextTick(grow);
  send(t, "chat");
}
const onKey = (e: KeyboardEvent) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } };
function grow() { const el = ta.value; if (!el) return; el.style.height = "auto"; el.style.height = Math.min(160, el.scrollHeight) + "px"; }
function retry(nonce: string, text: string) { echoState(nonce, "sending"); void deliver(text, nonce); }
function again(t: Extract<Turn, { type: "assistant" }>) {
  const u = userText(t.after);
  if (u) send(u.text, u.mode === "voice" ? "voice" : "chat", u.lang ?? undefined);
}
const copied = ref<string | null>(null);
async function copy(t: Extract<Turn, { type: "assistant" }>) {
  try { await navigator.clipboard.writeText(t.replies.map((r) => plainText(r.text ?? "")).join("\n\n")); copied.value = t.key; setTimeout(() => { if (copied.value === t.key) copied.value = null; }, 1500); }
  catch { toast("Couldn't copy"); }
}
const stopping = ref(false);
async function interrupt() {
  stopping.value = true; player.stop(); queue.length = 0;
  try { const r = await api<{ detail: string; stopped: boolean }>(`/bots/${encodeURIComponent(channel.value)}/interrupt`, { body: {} }); if (!r.stopped) toast(r.detail); }
  catch (e) { toast((e as Error).message); }
  stopping.value = false;
}

// ---------- speaking the answers to a spoken question ----------
const pending = ref<{ nonce: string; at: number; lang: string } | null>(null);
const spoken = new Set<string>();
const queue: string[] = [];
const speakingNow = ref(false);
let speakerUntil = 0; // a Home Assistant speaker is still saying the answer (half duplex: no mic until then)
watch(items, () => {
  const pd = pending.value; if (!pd) return;
  const list = items.value, at = list.findIndex((i) => i.kind === "user" && i.nonce === pd.nonce);
  if (at < 0) return;
  for (const it of list.slice(at + 1)) {
    if (it.kind === "user") { pending.value = null; break; } // someone else spoke: the rest isn't for us
    if (it.kind === "assistant" && it.text?.trim() && !spoken.has(it.id)) { spoken.add(it.id); queue.push(it.text); toPhone({ text: it.text, language: pd.lang }); tellParent("phase", "answer"); }
  }
  void drain();
});
async function drain() {
  if (speakingNow.value) return;
  speakingNow.value = true;
  while (queue.length) {
    const text = queue.shift()!;
    try {
      if (output.value === "browser") await player.say(text, p.info.voice);
      else if (output.value.startsWith("speaker:")) { await api("/voice/speakers/play", { body: { entity: output.value.slice(8), text, voice: p.info.voice } }); speakerUntil = Date.now() + 1500 + text.length * 70; } // about how long it talks
    } catch (e) { toast((e as Error).message); queue.length = 0; }
  }
  speakingNow.value = false;
  resumeHandsFree();
}
function readOut(t: Extract<Turn, { type: "assistant" }>) { player.unlock(); player.stop(); queue.length = 0; queue.push(...t.replies.map((r) => r.text ?? "")); void drain(); }
// The turn is over and everything is said: listen again in hands-free mode.
watch(working, (w) => { if (!w) { if (pending.value) toPhone({ done: true }); if (pending.value && !queue.length) pending.value = null; resumeHandsFree(); } });
/** A spoken turn from the phone: its answer goes back to the phone too, which shows it and speaks it. */
function toPhone(body: { text?: string; language?: string; done?: boolean }) {
  if (input.value !== "phone" || !phoneSess.value || !phoneLive()) return;
  void api(`/voice/mic/${phoneSess.value.id}/reply`, { body }).catch(() => {});
}
function resumeHandsFree() {
  if (!handsFree.value || !voiceOpen.value || input.value !== "browser" || working.value || speakingNow.value || transcribing.value || player.playing.value) return;
  if (!mic.listening.value && mic.open.value) mic.listen(onClip);
}

// ---------- voice mode: the mic ----------
const voiceOpen = ref(false);
const transcribing = ref(false), heard = ref<string | null>(null), voiceErr = ref<string | null>(null);
async function onClip(b: Blob, lang = p.info.language) {
  mic.stopListening();
  if (b.size < 1200) { resumeHandsFree(); return; }
  transcribing.value = true; voiceErr.value = null;
  try {
    const r = await fetch(`/api/v1/voice/transcribe?lang=${lang}`, { method: "POST", headers: { "Content-Type": b.type || "audio/webm" }, body: b });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.detail ?? `HTTP ${r.status}`);
    heard.value = j.text || null;
    if (j.text) send(j.text, "voice", j.language === "tr" ? "tr" : lang === "auto" ? j.language : lang);
    else voiceErr.value = "Didn't catch that. Try again a little closer.";
  } catch (e) { voiceErr.value = (e as Error).message; }
  transcribing.value = false;
  if (!heard.value || voiceErr.value) resumeHandsFree();
}
let downAt = 0, ptt = false, downPending = false, releasedEarly = false;
const oneSentence = () => mic.listen((clip) => void onClip(clip));
/** Press: barge in on speech, then hold to talk (push to talk) or, released quickly, listen for one sentence. */
async function micDown(e: PointerEvent) {
  if (e.button !== 0) return;
  try { (e.currentTarget as Element | null)?.setPointerCapture?.(e.pointerId); } catch { /* not capturable */ }
  player.unlock();
  if (player.playing.value || speakingNow.value) { player.stop(); queue.length = 0; } // barge-in
  if (tvMode && (input.value === "tv" || input.value === "phone")) { void micPress(); return; }
  if (input.value === "phone") { if (!phoneState.value || phoneState.value === "gone") void openPhone(); return; }
  if (input.value === "desk" || input.value === "tv") return;
  voiceErr.value = null;
  if (mic.listening.value) { const b = mic.recording.value ? await mic.finish() : null; mic.stopListening(); if (b && !handsFree.value) void onClip(b); return; } // a second tap ends it
  downPending = true; releasedEarly = false;
  const ok = await mic.start();
  downPending = false;
  if (!ok) { voiceErr.value = mic.problem.value ? MIC_PROBLEM[mic.problem.value] : "No microphone"; return; }
  if (handsFree.value) { mic.listen(onClip); return; }
  if (releasedEarly) { oneSentence(); return; } // the permission prompt took longer than the press
  downAt = performance.now(); ptt = true; mic.record();
}
async function micUp() {
  if (downPending) { releasedEarly = true; return; }
  if (!ptt) return;
  ptt = false;
  const held = performance.now() - downAt;
  const b = await mic.finish();
  if (held >= 450) { if (b) void onClip(b); return; } // held: push to talk
  oneSentence();                                       // tapped: listen for one sentence
}
/** Keyboard: Space or Enter starts listening for one sentence, pressed again it sends. */
async function micKey(e: KeyboardEvent) {
  if (e.key !== " " && e.key !== "Enter") return;
  e.preventDefault();
  player.unlock();
  if (player.playing.value || speakingNow.value) { player.stop(); queue.length = 0; }
  if (tvMode && (input.value === "tv" || input.value === "phone")) { void micPress(); return; }
  if (input.value === "phone") { if (phoneState.value !== "connected") void openPhone(!phoneSess.value); return; }
  if (input.value !== "browser") return;
  if (mic.listening.value) { const b = mic.recording.value ? await mic.finish() : null; mic.stopListening(); if (b) void onClip(b); return; }
  if (await mic.start()) { if (handsFree.value) mic.listen(onClip); else oneSentence(); }
  else voiceErr.value = mic.problem.value ? MIC_PROBLEM[mic.problem.value] : "No microphone";
}
function openVoice() { voiceOpen.value = true; player.unlock(); if (input.value === "browser" && micSupport().ok) void mic.start(); }
function closeVoice() { voiceOpen.value = false; mic.close(); player.stop(); queue.length = 0; }
watch(handsFree, (h) => { if (!h) mic.stopListening(); else resumeHandsFree(); });

const phase = computed(() => {
  if (input.value === "desk") return desk.value?.state === "listening" ? "listening" : desk.value?.state === "speaking" ? "speaking" : working.value ? "thinking" : "desk";
  if (input.value === "tv") {
    const t = tvMic.value;
    return transcribing.value || t?.state === "sending" ? "transcribing" : t?.state === "recording" ? "recording" : t?.state === "listening" ? "listening"
      : working.value && pending.value ? "thinking" : speakingNow.value || player.playing.value ? "speaking" : !t || !t.usb ? "nousb" : "tvidle";
  }
  if (input.value === "phone") return phoneState.value === "recording" ? "recording" : phoneState.value === "listening" ? "listening" : phoneState.value === "sending" || transcribing.value ? "transcribing" : working.value ? "thinking" : speakingNow.value ? "speaking" : phoneState.value && phoneState.value !== "gone" && phoneState.value !== "waiting" ? "phone" : "nophone";
  return mic.recording.value ? "recording" : transcribing.value ? "transcribing" : working.value && pending.value ? "thinking" : speakingNow.value || player.playing.value ? "speaking" : mic.listening.value ? "listening" : "idle";
});
const PHASE: Record<string, string> = {
  idle: "Hold to talk, or tap and speak", listening: "Listening… just talk", recording: "Hearing you…", transcribing: "Writing down what you said…",
  thinking: "Thinking…", speaking: "Speaking · tap the mic to cut in", desk: "Say the wake word near the desk speaker", phone: "Talk on your phone", nophone: "Connect your phone to use its mic",
};
PHASE.tvidle = "Press the mic button on the remote and talk"; PHASE.nousb = "Plug in a USB mic, or press the mic button to use your phone";
const KIOSK_PHASE: Record<string, string> = tvMode
  ? { phone: "Press the mic button on the remote, then talk to your phone", nophone: "Scan with your phone to use it as the mic (or plug in a USB mic)" }
  : { phone: "Tap the mic on your phone and talk", nophone: "Scan the code with your phone to talk" };

const ring = computed(() => (input.value === "browser" ? 1 + mic.level.value * 0.55 : phase.value === "recording" ? 1.25 : phase.value === "listening" ? 1.12 : 1));

// ---------- the phone as microphone ----------
const phoneSess = ref<{ id: string; url: string; secure: boolean; code: string | null; expires: number | null } | null>(null);
const phoneState = ref<string | null>(null), phoneDevice = ref<string | null>(null), pairOpen = ref(false), pairErr = ref<string | null>(null);
let phoneES: EventSource | null = null;
async function openPhone(fresh = false, show = true) {
  if (show) pairOpen.value = true;
  pairErr.value = null;
  if (phoneSess.value && !fresh) return;
  if (phoneSess.value) void api(`/voice/mic/${phoneSess.value.id}`, { method: "DELETE" }).catch(() => {});
  phoneES?.close(); phoneSess.value = null; phoneState.value = "waiting";
  try { phoneSess.value = await api("/voice/mic", { body: { label: p.kiosk ? "TV" : "Browser" } }); } catch (e) { pairErr.value = (e as Error).message; return; }
  phoneES = new EventSource(`/api/v1/voice/mic/${phoneSess.value!.id}/events`);
  phoneES.addEventListener("mic", (ev) => {
    const e = JSON.parse((ev as MessageEvent).data);
    if (e.type === "phone") { phoneState.value = e.state; if (e.device) phoneDevice.value = e.device; if (e.state === "connected" && pairOpen.value) setTimeout(() => { if (phoneState.value !== "gone") pairOpen.value = false; }, 1800); }
    // the language whisper heard (the phone asks for en, tr or auto): Turkish words get a Turkish answer, English an English one
    else if (e.type === "transcript") { heard.value = e.text; player.unlock(); send(e.text, "voice", e.language === "tr" ? "tr" : "en"); }
    else if (e.type === "error") voiceErr.value = e.detail;
  });
  phoneES.onerror = () => { if (phoneES?.readyState === EventSource.CLOSED) phoneState.value = "gone"; };
  voiceOpen.value = true; if (show) input.value = "phone";
}

// ---------- desk speaker + speakers ----------
const desk = ref<{ available: boolean; enabled: boolean; state: string } | null>(null);
const speakers = ref<{ id: string; name: string; available: boolean }[]>([]), speakersNote = ref<string | null>(null);
async function loadDesk() { if (!p.info.deskSpeaker.available) return; try { desk.value = await api("/house-voice"); } catch { /* keep */ } }
async function deskOn() { try { desk.value = await api("/house-voice", { method: "PATCH", body: { enabled: true } }); } catch (e) { toast((e as Error).message); } }
let deskPoll: ReturnType<typeof setInterval> | null = null;
watch(input, (k) => {
  if (deskPoll) clearInterval(deskPoll); deskPoll = null;
  if (k === "desk") { void loadDesk(); deskPoll = setInterval(loadDesk, 2000); }
  if (k !== "browser") mic.close(); else if (voiceOpen.value) void mic.start();
}, { immediate: true });
/** Is there any audio input at all? (Labels need permission, the devices themselves don't. A TV voice remote can show up as one.) */
async function hasAudioInput() {
  if (!micSupport().ok) return false;
  try { return (await navigator.mediaDevices.enumerateDevices()).some((d) => d.kind === "audioinput"); } catch { return false; }
}
const kioskQr = ref(false);
async function kioskStart() {
  voiceOpen.value = true; player.unlock();
  // ?mic=tv: the TV launcher that embeds us records a USB mic itself and hands us the clips (see onParent)
  // a phone mic link stays open in the background, so a phone that scanned it once is live for the mic button
  if (tvMode) { input.value = "tv"; void openPhone(true, false); await nextTick(); focusMic(); return; }
  // ?mic=phone: the TV's own inputs are no use (a voice remote that hears nothing): always the phone
  const phoneOnly = /[?&]mic=phone\b/.test(location.hash);
  if (!phoneOnly && await hasAudioInput()) { input.value = "browser"; if (!(await mic.start())) kioskPhone(); } // the WebView's own input wins
  else kioskPhone();
  await nextTick(); if (!pairOpen.value) focusMic();
}
const focusMic = () => (document.querySelector(".vc-tvmic, .vc-orb") as HTMLElement | null)?.focus();
function kioskPhone() { input.value = "phone"; kioskQr.value = true; void openPhone(true); }
watch(phoneState, (s, before) => {
  if (tvMode) {
    if (s === "gone") { unduck(); if (input.value === "phone") input.value = "tv"; void openPhone(true, pairOpen.value); return; } // a new link for the next scan
    // half duplex on the phone too: its mic opens → stop a spoken answer, duck the Sonos; it stops → put it back
    if (s === "listening" || s === "recording") { if (player.playing.value || speakingNow.value) { player.stop(); queue.length = 0; } input.value = "phone"; duck(); }
    else if (before === "listening" || before === "recording") unduck();
    return;
  }
  if (p.kiosk && input.value === "phone" && s === "gone") { kioskQr.value = true; void openPhone(true); }
});
const phoneLive = () => !!phoneState.value && !["waiting", "gone"].includes(phoneState.value);
// The Sonos goes down while a phone listens (the Salon page does it, see salon-tv assistant.duck); 20 s at most.
let ducked = false, duckT: ReturnType<typeof setTimeout> | null = null;
function duck() { if (!ducked) { ducked = true; tellParent("duck"); } if (duckT) clearTimeout(duckT); duckT = setTimeout(unduck, 20_000); }
function unduck() { if (duckT) clearTimeout(duckT); duckT = null; if (ducked) { ducked = false; tellParent("unduck"); } }
/** The remote's mic button (or OK on the orb): the USB mic, else a connected phone, else the pairing code. Half duplex. */
async function micPress() {
  const t = tvMic.value;
  const busy = t?.state === "listening" || t?.state === "recording";
  if (!busy) {
    if (player.playing.value || speakingNow.value) { player.stop(); queue.length = 0; } // the answer stops, then we listen
    if (Date.now() < speakerUntil) { voiceErr.value = "Wait for the answer to finish on the speaker"; return; }
  }
  voiceErr.value = null;
  if (t?.usb) { input.value = "tv"; tellParent("mic-toggle"); return; }
  if (phoneLive() && phoneSess.value) {
    input.value = "phone"; heard.value = null;
    try { await api(`/voice/mic/${phoneSess.value.id}/listen`, { body: {} }); duck(); }
    catch (e) { voiceErr.value = (e as Error).message; }
    return;
  }
  input.value = "tv"; kioskQr.value = true; void openPhone(true, true);
}
/** Back: close what is open; false when there is nothing left to close. */
function back() {
  if (pairOpen.value && !(p.kiosk && kioskQr.value && phoneState.value !== "connected")) { pairOpen.value = false; return true; }
  if (devOpen.value) { devOpen.value = false; return true; }
  if (historyOpen.value) { historyOpen.value = false; return true; }
  if (past.value) { backToLive(); return true; }
  return false;
}
const dpad = useDpad(() => document.body, back);
// Embedded (the TV launcher shows the kiosk in a frame and keeps the remote's Back key): the launcher posts
// {sdKiosk: "back"}; we close what is open, or tell it to close us ("exit").
const embedded = typeof window !== "undefined" && window.parent !== window;
const tellParent = (m: string, phase?: string) => { if (!embedded) return; try { window.parent.postMessage({ sdKiosk: m, phase }, "*"); } catch { /* gone */ } };
// The launcher's own mic: {sdKiosk: "tvmic", usb, name, state: idle|listening|recording|sending|nousb, error?} as it
// changes, and {sdKiosk: "tvclip", clip: Blob} with each recording (a WAV), which goes the same way as a browser clip.
const tvMic = ref<{ usb: boolean; name: string | null; state: string; error?: string | null } | null>(null);
function onParent(ev: MessageEvent) {
  if (ev.source !== window.parent) return;
  const d = ev.data as { sdKiosk?: string; usb?: boolean; name?: string | null; state?: string; error?: string | null; clip?: Blob } | null;
  if (d?.sdKiosk === "back") tellParent(back() ? "back-handled" : "exit");
  else if (d?.sdKiosk === "mic-press") void micPress();
  else if (d?.sdKiosk === "tvmic") {
    tvMic.value = { usb: !!d.usb, name: d.name ?? null, state: d.state ?? "idle", error: d.error ?? null };
    if (d.state === "listening" && (player.playing.value || speakingNow.value)) { player.stop(); queue.length = 0; } // barge-in
    if (d.state === "listening") { voiceErr.value = null; heard.value = null; }
    if (d.error) voiceErr.value = d.error;
    if (input.value !== "tv" && d.state === "listening") input.value = "tv"; // the remote's mic button: the TV mic it is
  } else if (d?.sdKiosk === "tvclip" && d.clip instanceof Blob) void onClip(d.clip, "auto");
}
// the Salon page shows a pill with this: Listening, Thinking, Answer
watch(phase, (ph) => tellParent("phase", ph));
onMounted(() => {
  if (!p.kiosk) return;
  addEventListener("keydown", dpad.onKey); void kioskStart();
  if (embedded) { addEventListener("message", onParent); tellParent("ready"); }
});
onUnmounted(() => { removeEventListener("keydown", dpad.onKey); removeEventListener("message", onParent); });
onMounted(async () => {
  void loadDesk();
  if (p.info.speakers.configured) try {
    const s = await api<{ speakers: typeof speakers.value; baseUrl: boolean }>("/voice/speakers");
    speakers.value = s.speakers; if (!s.baseUrl) speakersNote.value = "To answer on a speaker, set integrations.speakers.baseUrl to an address the speaker can reach.";
  } catch (e) { speakersNote.value = (e as Error).message; }
  if (output.value.startsWith("speaker:") && !speakers.value.some((s) => "speaker:" + s.id === output.value)) output.value = "browser";
});
const now = ref(Date.now());
const tick = setInterval(() => (now.value = Date.now()), 1000);

// ---------- spoken acknowledgements: the prompt hook says "got it" at once (POST /voice/ack); show the line and say it ----------
interface AckLine { id: string; text: string; at: number; clip: string | null }
const acks = ref<AckLine[]>([]);
const liveAcks = computed(() => acks.value.filter((a) => now.value - a.at < 90_000).slice(-3));
let ackES: EventSource | null = null;
onMounted(() => {
  if (p.kiosk) return;
  ackES = new EventSource("/api/v1/voice/ack/stream");
  ackES.addEventListener("ack", (e) => {
    const a = JSON.parse((e as MessageEvent).data) as AckLine;
    acks.value = [...acks.value.slice(-9), a];
    nextTick(() => follow(false));
    if (output.value === "browser" && a.clip) void new Audio(a.clip).play().catch(() => {}); // the browser may refuse before the first tap: the line still shows
    else if (output.value.startsWith("speaker:")) void api("/voice/speakers/play", { body: { entity: output.value.slice(8), text: a.text, voice: p.info.voice } }).catch(() => {});
  });
});
onUnmounted(() => ackES?.close());
onUnmounted(() => { clearInterval(tick); mic.close(); player.stop(); phoneES?.close(); if (deskPoll) clearInterval(deskPoll); if (phoneSess.value) void api(`/voice/mic/${phoneSess.value.id}`, { method: "DELETE" }).catch(() => {}); });

const secureUrl = computed(() => (location.protocol === "https:" ? null : p.info.phoneUrl));
const devState = computed<DevState>(() => ({
  input: input.value, output: output.value,
  browser: { problem: mic.problem.value ? MIC_PROBLEM[mic.problem.value] : null, secureUrl: mic.problem.value === "insecure" ? secureUrl.value : null, devices: mic.devices.value.map((d) => ({ id: d.deviceId, label: d.label })), deviceId: mic.deviceId.value, open: mic.open.value },
  phone: { state: phoneState.value, device: phoneDevice.value },
  tv: tvMic.value ?? (/[?&]mic=tv\b/.test(location.hash) ? { usb: false, name: null, state: null } : null),
  desk: { available: p.info.deskSpeaker.available, enabled: !!desk.value?.enabled, state: desk.value?.state ?? null },
  speakers: speakers.value, speakersNote: speakersNote.value,
}));
const devOpen = ref(false);
const narrow = ref(typeof matchMedia !== "undefined" && matchMedia("(max-width:1099px)").matches);
function pickInput(k: InputKind) { input.value = k; if (k === "phone" && (!phoneState.value || phoneState.value === "gone")) void openPhone(); }
const INPUT_LABEL: Record<InputKind, string> = { browser: "This browser", phone: "My phone", desk: "Desk speaker", tv: "TV mic" };
// On the TV the phone is the mic: call it what it is ("iPhone", as the phone's mic page reports it).
const inputLabel = computed(() => input.value === "tv" ? (tvMic.value?.usb ? tvMic.value.name || "TV mic" : "No mic yet") : (input.value === "phone" && (p.kiosk || phoneDevice.value) ? phoneDevice.value || "iPhone" : INPUT_LABEL[input.value]));
const outLabel = computed(() => output.value === "off" ? (input.value === "phone" || input.value === "tv" ? "on screen" : "text only") : output.value.startsWith("speaker:") ? speakers.value.find((s) => "speaker:" + s.id === output.value)?.name ?? "speaker" : p.kiosk ? "on the TV" : "here");
const initial = computed(() => p.info.name.slice(0, 1).toUpperCase());

// ---------- the TV's four states: idle, listening, thinking, answer ----------
const tvState = computed<"idle" | "listening" | "thinking" | "answer">(() => {
  const ph = phase.value;
  if (ph === "listening" || ph === "recording") return "listening";
  if (ph === "transcribing" || ph === "thinking" || (working.value && !past.value)) return "thinking";
  if (ph === "speaking") return "answer";
  return "idle";
});
const tvLine = computed<{ main: string; sub?: string }>(() => {
  const ph = phase.value, remote = tvMode ? "the mic button" : "OK";
  switch (tvState.value) {
    case "listening": return { main: "Listening", sub: ph === "recording" ? "Go on, I'm hearing you" : input.value === "phone" ? "Talk to your phone" : "Talk now" };
    case "thinking": return { main: ph === "transcribing" ? "One moment" : "Thinking", sub: ph === "transcribing" ? "Writing down what you said" : undefined }; // what it is doing shows under the question
    case "answer": return { main: "Speaking", sub: `Press ${remote} to cut in` };
  }
  if (!info.value.stt.available && input.value === "browser") return { main: "Speech to text is off", sub: info.value.stt.reason ?? undefined };
  if (input.value === "desk") return { main: "Say the wake word", sub: "near the desk speaker" };
  if (ph === "phone") return { main: tvMode ? "Press the mic button to talk" : "Tap the mic on your phone and talk", sub: tvMode ? `then talk to ${phoneDevice.value || "your phone"}` : undefined };
  if (ph === "nophone") return { main: "Scan the code with your phone to talk" };
  if (ph === "nousb") return { main: "Press the mic button to talk", sub: "Uses your phone, or plug in a USB mic" };
  return { main: tvMode ? "Press the mic button to talk" : "Press OK to talk" };
});
const info = computed(() => p.info);
const tvSources = computed(() => (t: Extract<Turn, { type: "assistant" }>) => { const d = [...new Set(t.sources.map((s) => s.domain))]; return d.length > 3 ? `${d.slice(0, 3).join(" · ")} +${d.length - 3}` : d.join(" · "); });
const settingsBtn = ref<HTMLButtonElement | null>(null);
// D-pad: an opened sheet takes the focus, a closed one gives it back to where it was opened from
watch(devOpen, async (o) => { if (!p.kiosk) return; await nextTick(); if (o) (document.querySelector(".vc-side .vc-side-b button, .vc-side button") as HTMLElement | null)?.focus(); else settingsBtn.value?.focus(); });
watch([historyOpen, sessions], async ([o]) => { if (!p.kiosk) return; await nextTick(); if (o) (document.querySelector(".vc-hist button") as HTMLElement | null)?.focus(); else if (!devOpen.value) settingsBtn.value?.focus(); });
function kioskHistory() { devOpen.value = false; void openHistory(); }
function kioskEarlier() { showAll.value = true; devOpen.value = false; limit.value += LIMIT; }
const live = computed(() => state.value === "live" && p.info.running);
</script>

<template>
  <div class="vc" :class="{ voice: voiceOpen, 'vc-kiosk': kiosk }">
    <section class="vc-main" aria-label="Chat">
      <header v-if="kiosk" class="vc-tvh">
        <span class="vc-tvh-n"><i :class="{ on: live, work: !!working }" aria-hidden="true"></i>{{ info.name }}</span>
        <span v-if="!live" class="vc-tvh-s">{{ !info.running ? "Not running" : state === "error" ? "Reconnecting…" : "Connecting…" }}</span>
        <button ref="settingsBtn" type="button" class="vc-tvh-b" :aria-expanded="devOpen" aria-label="Settings" @click="devOpen = !devOpen"><Icon name="sliders" :size="26" /></button>
      </header>
      <header v-else class="vc-h">
        <span class="vc-av" aria-hidden="true">{{ initial }}</span>
        <span class="vc-ht"><b>{{ info.name }}</b><small :class="{ on: live, work: !!working }"><i></i>{{ !info.running ? "Not running" : state !== "live" ? (state === "error" ? "Reconnecting…" : "Connecting…") : working ? "Thinking…" : "Online" }}</small></span>
        <button type="button" class="vc-ib" :aria-pressed="historyOpen" aria-label="Earlier conversations" title="Earlier conversations" @click="openHistory"><Icon name="history" /></button>
        <button type="button" class="vc-ib vc-dev-btn" :aria-expanded="devOpen" aria-label="Microphone and speaker" title="Microphone and speaker" @click="devOpen = !devOpen"><Icon name="sliders" /></button>
      </header>
      <div v-if="historyOpen" class="vc-hist" role="dialog" aria-label="Earlier conversations" :data-dpad-trap="kiosk ? '' : undefined">
        <p v-if="!sessions" class="meta">Loading…</p>
        <p v-else-if="!sessions.length" class="meta">No earlier conversations.</p>
        <button v-for="s in sessions ?? []" :key="s.session" type="button" class="vc-hist-r" :aria-current="(past?.session ?? meta?.session?.session) === s.session" @click="openPast(s)">
          <b>{{ s.session === meta?.session?.session ? "Current conversation" : new Date(s.updated).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) }}</b>
          <span>{{ s.preview.replace(/^\[(Voice|TV|Chat)( [a-z]{2})?\]\s*/, "") || "—" }}</span><em>{{ s.messages }} messages</em>
        </button>
      </div>
      <div v-if="past" class="vc-past"><span>Earlier conversation · {{ new Date(past.when).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) }}</span><button type="button" class="btn" @click="backToLive">Back to now</button></div>

      <div ref="box" class="vc-list" role="log" tabindex="0" data-dpad-scroll aria-label="Messages" aria-live="polite" aria-relevant="additions" @scroll.passive="onScroll">
        <div class="vc-in">
          <button v-if="hidden > 0 && !kiosk" type="button" class="vc-more" @click="earlier">Show {{ Math.min(hidden, LIMIT) }} earlier messages</button>
          <div v-if="kiosk && !shown.length" class="vc-tv-hi">
            <b>What can I help with?</b>
            <span>{{ tvMode ? "Press the mic button on the remote and ask anything" : "Ask anything, out loud" }}</span>
          </div>
          <div v-else-if="!shown.length && state === 'live'" class="vc-empty">
            <span class="vc-av lg" aria-hidden="true">{{ initial }}</span>
            <b>Ask {{ info.name }} anything</b>
            <span class="meta">Type below, or press the mic and talk. Answers can include sources from the web, cards and charts.</span>
          </div>
          <template v-for="t in shown" :key="t.key">
            <div v-if="t.type === 'user'" class="vc-u" data-dpad-skip>
              <div class="vc-ub" :class="{ pending: t.item.local === 'sending' || t.item.local === 'queued', failed: t.item.local === 'failed' }">{{ t.text }}</div>
              <span v-if="!kiosk || t.item.local === 'failed'" class="vc-meta">
                <template v-if="t.item.local === 'failed'"><span class="vc-bad">Not sent: {{ t.item.error }}</span> · <button type="button" class="vc-link" @click="retry(t.item.nonce!, t.item.text!)">Retry</button> · <button type="button" class="vc-link" @click="dismiss(t.item.nonce!)">Dismiss</button></template>
                <template v-else-if="t.item.local === 'sending'">Sending…</template>
                <template v-else-if="t.item.local === 'queued'">Sent · waiting for {{ info.name }}</template>
                <template v-else><Icon v-if="t.mode === 'voice'" name="mic" :size="12" />{{ t.mode === "voice" ? (t.lang === "tr" ? "Spoken · Türkçe" : "Spoken") : "" }}{{ t.mode === "voice" ? " · " : "" }}{{ clock(t.item.ts) }}</template>
              </span>
            </div>
            <div v-else-if="t.type === 'assistant'" class="vc-a" data-dpad-skip>
              <span v-if="!kiosk" class="vc-av" aria-hidden="true">{{ initial }}</span>
              <div class="vc-ab">
                <details v-if="t.steps.length && !kiosk" class="vc-work">
                  <summary><Icon :name="t.running ? 'loader' : 'check'" :size="13" :class="{ 'vc-spin': t.running }" />{{ t.running ? "Working" : `Worked for ${dur(Math.max(1000, (t.steps.at(-1)!.ts + (t.steps.at(-1)!.ms ?? 0)) - t.steps[0].ts))}` }} · {{ t.steps.length }} {{ t.steps.length === 1 ? "step" : "steps" }}</summary>
                  <ol><li v-for="s in t.steps" :key="s.id" :class="s.status"><b>{{ s.title }}</b><code v-if="s.detail">{{ s.detail.length > 140 ? s.detail.slice(0, 140) + "…" : s.detail }}</code></li></ol>
                </details>
                <VcSources v-if="t.sources.length && !kiosk" :sources="t.sources" :query="queryOf(t)" />
                <VcMessage v-for="r in t.replies" :key="r.id" :text="r.text ?? ''" :ts="r.ts" :tv="kiosk" />
                <p v-if="kiosk && t.sources.length && t.replies.length" class="vc-tv-src"><Icon name="globe" :size="18" />{{ tvSources(t) }}</p>
                <div v-if="t.replies.length && !kiosk" class="vc-acts">
                  <span class="vc-meta">{{ clock(t.replies.at(-1)!.ts) }}</span>
                  <button type="button" class="vc-act" :aria-label="copied === t.key ? 'Copied' : 'Copy the answer'" @click="copy(t)"><Icon :name="copied === t.key ? 'check' : 'copy'" :size="14" />{{ copied === t.key ? "Copied" : "Copy" }}</button>
                  <button v-if="t.key === lastAssistant && !working && !past && userText(t.after)" type="button" class="vc-act" aria-label="Ask again" @click="again(t)"><Icon name="rotate-ccw" :size="14" />Retry</button>
                  <button v-if="t.replies.length && output !== 'off'" type="button" class="vc-act" aria-label="Read it out" @click="readOut(t)"><Icon name="volume" :size="14" />Read out</button>
                </div>
              </div>
            </div>
            <div v-else class="vc-ev"><span>{{ t.item.text }} · {{ clock(t.item.ts) }}</span></div>
          </template>
          <div v-for="a in liveAcks" :key="a.id" class="vc-ack" role="status"><Icon name="volume" :size="13" /><span>{{ a.text }}</span><small class="num">{{ clock(a.at) }}</small></div>
          <div v-if="working && kiosk" class="vc-tv-think" role="status"><span class="vc-dots" aria-hidden="true"><i></i><i></i><i></i></span>{{ doing }}</div>
          <div v-else-if="working" class="vc-a vc-typing" role="status">
            <span class="vc-av" aria-hidden="true">{{ initial }}</span>
            <div class="vc-tb"><span class="vc-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="vc-doing">{{ doing }}</span><span class="vc-t num">{{ dur(Math.max(0, now - working.since)) }}</span></div>
            <button type="button" class="vc-stop" :disabled="stopping" @click="interrupt"><Icon name="square" :size="12" fill="currentColor" />{{ stopping ? "Stopping…" : "Stop" }}</button>
          </div>
          <div v-if="kiosk && shown.length" class="vc-tv-room" aria-hidden="true"></div>
        </div>
      </div>
      <button v-if="unseen && !stick && !kiosk" type="button" class="vc-jump" @click="follow(true)"><Icon name="arrow-down" :size="15" />New messages</button>

      <!-- composer / voice mode -->
      <!-- the TV: one calm dock with the mic, the state in words and a small waveform while it listens -->
      <footer v-if="kiosk && !past" class="vc-dock" :class="tvState">
        <button type="button" class="vc-tvmic" :class="tvState" :aria-label="tvState === 'listening' ? 'Stop and send' : 'Talk'" :disabled="input === 'desk' || (!info.stt.available && input === 'browser')"
          @pointerdown="micDown" @pointerup="micUp" @pointercancel="micUp" @keydown="micKey" @contextmenu.prevent>
          <Icon :name="tvState === 'answer' ? 'volume' : input === 'phone' && tvState === 'idle' ? 'smartphone' : 'mic'" :size="34" />
        </button>
        <div class="vc-dock-r"><div class="vc-dock-t" role="status">
          <span class="vc-dock-m">
            <span v-if="tvState === 'listening'" class="vc-wave" :class="{ loud: phase === 'recording' }" aria-hidden="true"><i v-for="n in 5" :key="n"></i></span>
            <span v-else-if="tvState === 'thinking'" class="vc-dots" aria-hidden="true"><i></i><i></i><i></i></span>
            {{ tvLine.main }}
          </span>
          <span v-if="voiceErr" class="vc-dock-s err">{{ voiceErr }}</span>
          <span v-else-if="tvLine.sub" class="vc-dock-s">{{ tvLine.sub }}</span>
        </div>
        <button v-if="working" type="button" class="vc-dock-stop" :disabled="stopping" @click="interrupt"><Icon name="square" :size="16" fill="currentColor" />{{ stopping ? "Stopping" : "Stop" }}</button></div>
      </footer>
      <footer v-else-if="past && kiosk" class="vc-dock"><button type="button" class="vc-dock-stop" style="grid-column:2" @click="backToLive">Back to now</button></footer>
      <footer v-else-if="!past" class="vc-f">
        <div v-if="voiceOpen" class="vc-voice">
          <div class="vc-vtop">
            <button type="button" class="vc-chip" @click="devOpen = !devOpen"><Icon :name="input === 'phone' ? 'smartphone' : input === 'desk' ? 'volume' : input === 'tv' && phase === 'nousb' ? 'plug' : 'mic'" :size="14" />{{ inputLabel }} · answers {{ outLabel }}<Icon name="chevron-down" :size="14" /></button>
            <label v-if="input === 'browser'" class="vc-hf"><span>Hands-free</span><button type="button" class="sw sm" role="switch" :aria-checked="handsFree" aria-label="Hands-free" @click="handsFree = !handsFree"></button></label>
          </div>
          <div class="vc-orb-wrap">
            <span class="vc-ring" :style="{ transform: `scale(${ring})` }" :class="phase" aria-hidden="true"></span>
            <button type="button" class="vc-orb" :class="phase" :aria-label="phase === 'recording' ? 'Stop and send' : 'Talk'" :disabled="input === 'desk' || (!info.stt.available && input === 'browser')"
              @pointerdown="micDown" @pointerup="micUp" @pointercancel="micUp" @keydown="micKey" @contextmenu.prevent>
              <Icon :name="input === 'phone' ? 'smartphone' : input === 'desk' ? 'volume' : phase === 'speaking' ? 'volume' : phase === 'nousb' ? 'plug' : 'mic'" :size="34" />
            </button>
          </div>
          <div v-if="input === 'browser'" class="vc-meter" aria-hidden="true"><i v-for="n in 14" :key="n" :class="{ on: mic.level.value * 14 >= n }"></i></div>
          <p class="vc-phase" role="status">{{ !info.stt.available && input === "browser" ? `Speech to text isn't available: ${info.stt.reason}` : input === "browser" && mic.problem.value ? MIC_PROBLEM[mic.problem.value] : (kiosk && KIOSK_PHASE[phase]) || PHASE[phase] }}</p>
          <p v-if="voiceErr" class="vc-verr">{{ voiceErr }}</p>
          <p v-else-if="heard" class="vc-heard">“{{ heard }}”</p>
          <div v-if="input === 'browser' && mic.problem.value && mic.problem.value !== 'denied'" class="vc-fall">
            <a v-if="mic.problem.value === 'insecure' && secureUrl" class="btn" :href="secureUrl + '/#voice'">Open the secure address</a>
            <button type="button" class="btn go" @click="pickInput('phone')"><Icon name="smartphone" :size="14" /> Use my phone's mic</button>
            <button v-if="info.deskSpeaker.available" type="button" class="btn" @click="pickInput('desk')">Desk speaker</button>
          </div>
          <div class="vc-vbar">
            <button v-if="!kiosk" type="button" class="vc-ib" aria-label="Back to the keyboard" title="Keyboard" @click="closeVoice"><Icon name="keyboard" /></button><span v-else></span>
            <button v-if="working" type="button" class="vc-stop" @click="interrupt"><Icon name="square" :size="12" fill="currentColor" />Stop</button>
          </div>
        </div>
        <form v-else class="vc-comp" @submit.prevent="submit">
          <textarea ref="ta" v-model="draft" rows="1" :placeholder="`Message ${info.name}`" aria-label="Message" enterkeyhint="send" @keydown="onKey" @input="grow"></textarea>
          <button type="button" class="vc-cb mic" aria-label="Voice mode" title="Talk" @click="openVoice"><Icon name="mic" :size="20" /></button>
          <button v-if="working && !draft.trim()" type="button" class="vc-cb stop" aria-label="Stop" title="Stop" @click="interrupt"><Icon name="square" :size="14" fill="currentColor" /></button>
          <button v-else type="submit" class="vc-cb send" :disabled="!draft.trim()" aria-label="Send" title="Send · Enter (Shift+Enter for a new line)"><Icon name="send" :size="18" /></button>
        </form>
      </footer>
    </section>

    <aside class="vc-side" :class="{ 'vc-open': devOpen }" aria-label="Microphone and speaker" :data-dpad-trap="devOpen && (narrow || kiosk) ? '' : undefined" :inert="kiosk && !devOpen ? true : undefined">
      <div class="vc-side-h"><b>{{ kiosk ? "Settings" : "Microphone & speaker" }}</b><button type="button" class="vc-ib vc-side-x" aria-label="Close" @click="devOpen = false"><Icon name="x" /></button></div>
      <div v-if="kiosk" class="vc-side-b">
        <button type="button" class="btn" @click="kioskHistory"><Icon name="history" :size="14" /> Earlier conversations</button>
        <button v-if="!showAll" type="button" class="btn" @click="kioskEarlier">Show older messages</button>
        <label v-if="input === 'browser'" class="vc-hf"><span>Hands-free</span><button type="button" class="sw sm" role="switch" :aria-checked="handsFree" aria-label="Hands-free" @click="handsFree = !handsFree"></button></label>
      </div>
      <VcDevices :s="devState" @input="pickInput" @output="output = $event" @device="mic.start($event)" @pair-phone="openPhone(true)" @desk-on="deskOn" />
      <slot name="side" />
    </aside>
    <div v-if="devOpen" class="vc-scrim" @click="devOpen = false"></div>
    <VcPhonePair v-if="pairOpen" :big="kiosk" :lead="tvMode ? 'Scan with your phone, then press the mic button on the remote.' : undefined" :session="phoneSess" :phone="phoneState" :device="phoneDevice" :error="pairErr" @close="pairOpen = false" @renew="openPhone(true)" @expired="kiosk && phoneState !== 'connected' && openPhone(true)" />
  </div>
</template>

<style scoped>
.vc{position:relative;display:grid;grid-template-columns:minmax(0,1fr) 340px;height:100%;min-height:0;background:var(--bg)}
.vc-main{position:relative;display:flex;flex-direction:column;min-width:0;min-height:0;border-right:1px solid #1f1f23}
.vc-h{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid #1f1f23;background:#0b0b0d}
.vc-av{flex:none;width:30px;height:30px;border-radius:50%;display:grid;place-items:center;font:700 13px var(--body);color:#1a0c06;background:linear-gradient(140deg,#ffb59c,#d97757)}
.vc-av.lg{width:54px;height:54px;font-size:22px}
.vc-ht{flex:1;min-width:0;display:flex;flex-direction:column}
.vc-ht b{font:700 15px var(--body)}
.vc-ht small{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)}
.vc-ht small i{width:7px;height:7px;border-radius:50%;background:#4a4a52}
.vc-ht small.on i{background:var(--on)}
.vc-ht small.work{color:#ffb59c}.vc-ht small.work i{background:#d97757;animation:vc-pulse 1.2s ease-in-out infinite}
.vc-ib{flex:none;width:40px;height:40px;border-radius:10px;border:1px solid transparent;background:none;color:#c7c7cc;display:grid;place-items:center;cursor:pointer}
.vc-ib:hover,.vc-ib[aria-pressed="true"],.vc-ib[aria-expanded="true"]{background:#17171b;border-color:#26262b;color:var(--ink)}
.vc-ib:focus-visible{outline:2px solid var(--ink);outline-offset:1px}
.vc-dev-btn{display:none}
.vc-hist{position:absolute;z-index:6;top:62px;right:12px;width:min(360px,calc(100% - 24px));max-height:60%;overflow:auto;display:flex;flex-direction:column;gap:4px;padding:8px;border-radius:14px;border:1px solid var(--line);background:#141417;box-shadow:0 20px 50px rgba(0,0,0,.5)}
.vc-hist-r{display:grid;grid-template-columns:1fr auto;gap:2px 8px;text-align:left;padding:9px 10px;border-radius:10px;border:1px solid transparent;background:none;color:var(--ink);cursor:pointer;font:inherit}
.vc-hist-r:hover,.vc-hist-r[aria-current="true"]{background:#1b1b1f;border-color:#2a2a30}
.vc-hist-r b{font:600 13px var(--body)}.vc-hist-r em{font-style:normal;font-size:11.5px;color:var(--muted);text-align:right}
.vc-hist-r span{grid-column:1/-1;font-size:12.5px;color:#a5a5ac;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vc-past{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 16px;font-size:12.5px;color:#ffd38a;background:var(--warn-bg);border-bottom:1px solid rgba(255,178,30,.25)}
.vc-list{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;scroll-behavior:auto}
.vc-in{display:flex;flex-direction:column;gap:18px;max-width:820px;margin:0 auto;padding:20px 18px 24px}
.vc-more{align-self:center;font:600 12.5px var(--body);color:var(--muted);background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:7px 14px;cursor:pointer}
.vc-empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:8px;margin:12vh auto 0;max-width:360px}
.vc-empty b{font:700 18px var(--body)}
.vc-u{display:flex;flex-direction:column;align-items:flex-end;gap:4px;padding-left:12%}
.vc-ub{max-width:100%;padding:10px 14px;border-radius:18px 18px 6px 18px;background:#24242a;color:var(--ink);font-size:15px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere}
.vc-ub.pending{opacity:.65}
.vc-ub.failed{background:var(--bad-bg);border:1px solid rgba(255,59,69,.4)}
.vc-ack{display:flex;align-items:center;gap:8px;align-self:flex-start;max-width:min(86%,520px);padding:7px 12px;border-radius:14px;background:rgba(255,255,255,.06);border:1px dashed rgba(255,255,255,.14);color:rgba(255,255,255,.78);font-size:13px;line-height:1.4;animation:vc-ack-in .25s cubic-bezier(.2,.8,.2,1)}
.vc-ack small{color:#7b7b83;font-size:11px;margin-left:4px}
@keyframes vc-ack-in{from{opacity:0;transform:translateY(6px)}}
@media (prefers-reduced-motion:reduce){.vc-ack{animation:none}}
.vc-meta{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;color:#7b7b83}
.vc-bad{color:#ff8a94}
.vc-link{border:0;background:none;color:var(--ink);text-decoration:underline;cursor:pointer;font:inherit;padding:0}
.vc-a{display:grid;grid-template-columns:30px minmax(0,1fr);gap:10px;align-items:start}
.vc-ab{display:flex;flex-direction:column;gap:10px;min-width:0;padding-top:4px}
.vc-work{font-size:12.5px;color:var(--muted)}
.vc-work summary{display:inline-flex;align-items:center;gap:6px;cursor:pointer;list-style:none;padding:3px 9px 3px 7px;border-radius:999px;border:1px solid #232327;background:#111114}
.vc-work summary::-webkit-details-marker{display:none}
.vc-work ol{margin:8px 0 0;padding:0 0 0 14px;display:flex;flex-direction:column;gap:5px;border-left:2px solid #232327}
.vc-work li{list-style:none;display:flex;flex-direction:column;gap:1px}
.vc-work li b{font-weight:600;color:#c7c7cc}.vc-work li.error b{color:#ff8a94}
.vc-work code{font:500 11.5px var(--mono);color:#7b7b83;overflow-wrap:anywhere}
.vc-acts{display:flex;align-items:center;gap:4px;margin-top:-2px;flex-wrap:wrap}
.vc-acts .vc-meta{margin-right:4px}
.vc-act{display:inline-flex;align-items:center;gap:5px;min-height:30px;padding:0 9px;border-radius:8px;border:1px solid transparent;background:none;color:var(--muted);font:600 12px var(--body);cursor:pointer}
.vc-act:hover{background:#17171b;border-color:#26262b;color:var(--ink)}
.vc-ev{align-self:center;font-size:11.5px;color:#6f6f77;padding:3px 10px;border-radius:999px;border:1px dashed #26262b}
.vc-typing{grid-template-columns:30px minmax(0,1fr) auto;align-items:center}
.vc-tb{display:flex;align-items:center;gap:10px;min-width:0;padding:8px 12px;border-radius:14px;background:#141417;border:1px solid #232327}
.vc-dots{display:inline-flex;gap:3px}
.vc-dots i{width:6px;height:6px;border-radius:50%;background:#d97757;animation:vc-dot 1.2s ease-in-out infinite}
.vc-dots i:nth-child(2){animation-delay:.15s}.vc-dots i:nth-child(3){animation-delay:.3s}
@keyframes vc-dot{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}
.vc-doing{flex:1;min-width:0;font-size:13px;color:#d6d6db;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vc-t{font-size:11.5px;color:#7b7b83}
.vc-stop{display:inline-flex;align-items:center;gap:6px;min-height:36px;padding:0 12px;border-radius:999px;border:1px solid #3a3a40;background:#17171b;color:var(--ink);font:600 12.5px var(--body);cursor:pointer}
.vc-stop:hover{border-color:var(--ink)}
.vc-jump{position:absolute;left:50%;transform:translateX(-50%);bottom:96px;z-index:4;display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:999px;border:1px solid #3a3a40;background:#1b1b1f;color:var(--ink);font:600 12.5px var(--body);cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.45)}
.vc.voice .vc-jump{bottom:330px}
.vc-f{border-top:1px solid #1f1f23;background:#0b0b0d;padding:12px 16px calc(12px + env(safe-area-inset-bottom,0px))}
.vc-comp{display:flex;align-items:flex-end;gap:8px;max-width:820px;margin:0 auto;padding:6px 6px 6px 14px;border-radius:22px;border:1px solid #2a2a30;background:#141417}
.vc-comp:focus-within{border-color:#4a4a52}
.vc-comp textarea{flex:1;min-width:0;resize:none;border:0;outline:none;background:transparent;color:var(--ink);font:400 15px/1.45 var(--body);padding:9px 0;max-height:160px}
.vc-cb{flex:none;width:40px;height:40px;border-radius:50%;border:0;display:grid;place-items:center;cursor:pointer;color:var(--ink);background:#22222a}
.vc-cb.send{background:var(--ink);color:var(--bg)}
.vc-cb.send:disabled{background:#26262b;color:#6f6f77;cursor:default}
.vc-cb.mic:hover{background:#2c2c34}
.vc-cb:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.vc-voice{display:flex;flex-direction:column;align-items:center;gap:10px;max-width:520px;margin:0 auto}
.vc-vtop{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;flex-wrap:wrap}
.vc-chip{display:inline-flex;align-items:center;gap:6px;min-height:34px;max-width:100%;padding:0 10px;border-radius:999px;border:1px solid #2a2a30;background:#141417;color:#d6d6db;font:600 12.5px var(--body);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vc-hf{display:inline-flex;align-items:center;gap:8px;font:600 12.5px var(--body);color:var(--muted)}
.vc-hf .sw{margin:0}
.vc-orb-wrap{position:relative;width:132px;height:132px;display:grid;place-items:center;margin:4px 0}
.vc-ring{position:absolute;inset:6px;border-radius:50%;background:radial-gradient(circle,rgba(217,119,87,.30),rgba(217,119,87,0) 70%);transition:transform .08s linear}
.vc-ring.recording{background:radial-gradient(circle,rgba(255,59,69,.38),rgba(255,59,69,0) 70%)}
.vc-ring.speaking{background:radial-gradient(circle,rgba(47,211,138,.28),rgba(47,211,138,0) 70%);animation:vc-breathe 1.6s ease-in-out infinite}
.vc-orb{position:relative;width:104px;height:104px;border-radius:50%;border:1px solid rgba(255,181,156,.4);display:grid;place-items:center;cursor:pointer;color:#1a0c06;background:linear-gradient(150deg,#ffc2ad,#d97757 70%);box-shadow:0 10px 40px rgba(217,119,87,.35);touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;transition:transform .12s var(--ease),filter .2s}
.vc-orb:active{transform:scale(.95)}
.vc-orb.recording{background:linear-gradient(150deg,#ff8a94,#e00018 75%);color:#fff;border-color:rgba(255,138,148,.6)}
.vc-orb.listening{animation:vc-breathe 2s ease-in-out infinite}
.vc-orb.thinking,.vc-orb.transcribing{filter:saturate(.5) brightness(.8)}
.vc-orb.speaking{background:linear-gradient(150deg,#8ff0c4,#2fd38a 75%)}
.vc-orb:disabled{filter:grayscale(1) brightness(.6);cursor:default}
.vc-orb:focus-visible{outline:3px solid var(--ink);outline-offset:4px}
@keyframes vc-breathe{50%{transform:scale(1.04)}}
@keyframes vc-pulse{50%{opacity:.35}}
.vc-meter{display:flex;gap:3px;align-items:flex-end;height:14px}
.vc-meter i{width:4px;height:5px;border-radius:2px;background:#2a2a30;transition:height .08s,background .08s}
.vc-meter i.on{background:#d97757;height:14px}
.vc-meter i:nth-child(odd).on{height:10px}
.vc-phase{margin:0;font:600 14px var(--body);color:#d6d6db;text-align:center}
.vc-heard{margin:0;font-size:13px;color:var(--muted);text-align:center;font-style:italic;max-width:100%;overflow-wrap:anywhere}
.vc-verr{margin:0;font-size:13px;color:#ffd38a;text-align:center}
.vc-fall{display:flex;flex-wrap:wrap;justify-content:center;gap:8px}
.vc-fall .btn{display:inline-flex;align-items:center;gap:6px;min-height:38px;text-decoration:none}
.vc-vbar{display:flex;align-items:center;justify-content:space-between;width:100%}
.vc-side{display:flex;flex-direction:column;gap:16px;min-height:0;overflow-y:auto;padding:16px;background:#0b0b0d}
.vc-side-h{display:flex;align-items:center;justify-content:space-between}
.vc-side-h b{font:700 13px var(--display);letter-spacing:.1em;text-transform:uppercase;color:#c7c7cc}
.vc-side-x{display:none}
.vc-scrim{display:none}
.vc-spin{animation:vc-spin .9s linear infinite}
@keyframes vc-spin{to{transform:rotate(360deg)}}
@media(max-width:1099px){
  .vc{grid-template-columns:minmax(0,1fr)}
  .vc-main{border-right:0}
  .vc-dev-btn{display:grid}
  .vc-side{position:fixed;z-index:48;left:0;right:0;bottom:0;max-height:82vh;border-radius:20px 20px 0 0;border:1px solid var(--line);box-shadow:0 -20px 60px rgba(0,0,0,.6);transform:translateY(105%);transition:transform .25s var(--ease);padding-bottom:calc(16px + env(safe-area-inset-bottom,0px))}
  .vc-side.vc-open{transform:none}
  .vc-side-x{display:grid}
  .vc-scrim{display:block;position:fixed;inset:0;z-index:47;background:rgba(0,0,0,.5)}
}
@media(min-width:1100px){.vc-scrim{display:none!important}}
/* ---------- TV kiosk: a 1920×1080 canvas (VoiceKiosk zooms the page to it), px are screen pixels ----------
   One calm accent (#f2b26b, the Salon TV amber), no borders or dividers, type for 3-4 m. Motion is opacity and
   transform only (the TV GPU bands on blurs and moving gradients); no vh/vw, they are zoomed too. */
.vc-kiosk{grid-template-columns:minmax(0,1fr);background:#0d0e11;--tv-ac:#f2b26b;--tv-ink:#ececef;--tv-mut:#8e8f97}
.vc-kiosk .vc-main{border-right:0}
.vc-tvh{display:flex;align-items:center;gap:16px;height:112px;padding:0 96px;flex:none}
.vc-tvh-n{display:inline-flex;align-items:center;gap:12px;font:600 22px var(--body);color:#c9c9cf;letter-spacing:.01em}
.vc-tvh-n i{width:10px;height:10px;border-radius:50%;background:#4a4b52}
.vc-tvh-n i.on{background:#5fd39a}
.vc-tvh-n i.work{background:var(--tv-ac);animation:vc-pulse 1.4s ease-in-out infinite}
.vc-tvh-s{font-size:20px;color:var(--tv-mut)}
.vc-tvh-b{margin-left:auto;width:60px;height:60px;border-radius:50%;border:0;background:transparent;color:#a9aab1;display:grid;place-items:center;cursor:pointer}
.vc-tvh-b[aria-expanded="true"]{background:#1b1c21;color:var(--tv-ink)}
.vc-kiosk .vc-list{position:relative;scroll-behavior:smooth}
.vc-kiosk .vc-in{max-width:1280px;gap:44px;padding:8px 96px 0}
.vc-kiosk .vc-u{padding-left:20%;gap:8px;animation:vc-rise .35s var(--ease) both}
.vc-kiosk .vc-ub{padding:14px 26px;border-radius:28px;background:#1b1c21;color:#d4d4da;font-size:25px;line-height:1.4}
.vc-kiosk .vc-a{display:block;animation:vc-rise .45s var(--ease) both}
.vc-kiosk .vc-ab{gap:22px;padding:0}
.vc-kiosk .vc-ev{font-size:18px;border:0;color:#6c6d74}
.vc-kiosk .vc-meta{font-size:18px}
.vc-tv-src{display:flex;align-items:center;gap:10px;margin:-4px 0 0;font:500 19px var(--body);color:#6f7077}
.vc-tv-think{display:flex;align-items:center;gap:16px;font:500 26px var(--body);color:var(--tv-mut);animation:vc-fade .3s ease both}
.vc-kiosk .vc-dots{gap:7px}
.vc-kiosk .vc-dots i{width:10px;height:10px;background:var(--tv-ac)}
.vc-tv-room{flex:none;height:640px}
.vc-tv-hi{display:flex;flex-direction:column;align-items:center;gap:18px;margin:210px auto 0;text-align:center;animation:vc-fade .6s ease both}
.vc-tv-hi b{font:600 60px/1.15 var(--body);letter-spacing:-.015em;color:var(--tv-ink)}
.vc-tv-hi span{font-size:26px;color:var(--tv-mut)}
/* the dock */
.vc-dock{flex:none;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:28px;height:184px;padding:0 96px 24px}
.vc-dock>.vc-tvmic{grid-column:2}
.vc-dock-r{grid-column:3;display:flex;align-items:center;gap:20px;min-width:0}
.vc-tvmic{flex:none;width:96px;height:96px;border-radius:50%;border:0;display:grid;place-items:center;cursor:pointer;color:var(--tv-ink);background:#1d1e23;transition:transform .25s var(--ease),background-color .25s,color .25s;touch-action:none;user-select:none;-webkit-user-select:none}
.vc-tvmic.listening{background:var(--tv-ac);color:#1a1206;transform:scale(1.06)}
.vc-tvmic.thinking{color:var(--tv-mut)}
.vc-tvmic.answer{background:#22332a;color:#9ed6b0}
.vc-tvmic:disabled{opacity:.4;cursor:default}
.vc-dock-t{display:flex;flex-direction:column;gap:6px;min-width:0}
.vc-dock-m{display:inline-flex;align-items:center;gap:16px;font:600 28px/1.2 var(--body);color:var(--tv-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vc-dock-s{font-size:22px;color:var(--tv-mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vc-dock-s.err{color:#f2c46b}
.vc-dock-stop{flex:none;display:inline-flex;align-items:center;gap:10px;height:60px;padding:0 26px;border-radius:999px;border:0;background:#1d1e23;color:#c9c9cf;font:600 22px var(--body);cursor:pointer}
.vc-wave{display:inline-flex;align-items:center;gap:6px;height:34px}
.vc-wave i{width:6px;height:34px;border-radius:3px;background:var(--tv-ac);transform:scaleY(.25);animation:vc-wave 1.1s ease-in-out infinite}
.vc-wave i:nth-child(2){animation-delay:.12s}.vc-wave i:nth-child(3){animation-delay:.24s}.vc-wave i:nth-child(4){animation-delay:.36s}.vc-wave i:nth-child(5){animation-delay:.48s}
.vc-wave.loud i{animation-duration:.7s}
@keyframes vc-wave{0%,100%{transform:scaleY(.25)}50%{transform:scaleY(1)}}
@keyframes vc-rise{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}
@keyframes vc-fade{from{opacity:0}to{opacity:1}}
/* settings sheet and history: the panel's own controls, scaled up as a whole */
.vc-kiosk .vc-side{position:fixed;z-index:48;top:0;right:0;bottom:0;left:auto;width:400px;max-height:none;border-radius:0;zoom:1.6;padding:28px 24px;gap:18px;background:#141519;border:0;box-shadow:none;transform:translateX(105%);visibility:hidden;transition:transform .3s var(--ease),visibility 0s .3s}
.vc-kiosk .vc-side.vc-open{transform:none;visibility:visible;transition:transform .3s var(--ease)}
.vc-kiosk .vc-side-x{display:grid}
.vc-kiosk .vc-side-h b{font:600 17px var(--body);letter-spacing:0;text-transform:none;color:var(--ink)}
.vc-side-b{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.vc-side-b .btn{display:inline-flex;align-items:center;gap:6px;min-height:36px;font-weight:600}
.vc-kiosk .vc-scrim{display:block!important;position:fixed;inset:0;z-index:47;background:rgba(13,14,17,.7)}
.vc-kiosk .vc-hist{zoom:1.6;top:64px;right:56px;max-height:none;bottom:24px;height:max-content;border:0;box-shadow:none;background:#141519}
.vc-kiosk .vc-past{font-size:20px;padding:12px 96px}
/* a focus ring you see from the sofa */
.vc-kiosk :focus-visible,.vc-kiosk :focus{outline:4px solid var(--tv-ac)!important;outline-offset:5px;border-radius:14px}
.vc-kiosk .vc-tvmic:focus,.vc-kiosk .vc-tvh-b:focus{outline-offset:8px;border-radius:50%}
.vc-kiosk .vc-dock-stop:focus{border-radius:999px}
.vc-kiosk .vc-list:focus{outline:0!important;box-shadow:inset 4px 0 0 var(--tv-ac)}
.vc-kiosk .vc-side :focus,.vc-kiosk .vc-hist :focus{outline-width:2.5px!important;outline-offset:2px}
@media(max-width:620px){
  .vc-h{padding:10px 12px}
  .vc-in{padding:16px 12px 20px;gap:16px}
  .vc-u{padding-left:8%}
  .vc-a{grid-template-columns:minmax(0,1fr)}
  .vc-a>.vc-av{display:none}
  .vc-typing{grid-template-columns:minmax(0,1fr) auto}
  .vc-f{padding:10px 10px calc(10px + env(safe-area-inset-bottom,0px))}
  .vc-orb-wrap{width:120px;height:120px}.vc-orb{width:96px;height:96px}
}
</style>
