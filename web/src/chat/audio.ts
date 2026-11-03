// Browser audio for the voice chat: the microphone (level meter, recording a clip, hands-free listening that cuts a
// clip when you stop talking) and a player for the server's streamed speech (/voice/speak: 16-bit mono PCM, 24 kHz).
import { ref, shallowRef } from "vue";

export type MicProblem = "insecure" | "unsupported" | "denied" | "nodevice" | "busy" | null;

/** Can this page use a microphone at all? getUserMedia only exists in a secure context (https or localhost). */
export function micSupport(): { ok: boolean; problem: MicProblem } {
  if (typeof window === "undefined") return { ok: false, problem: "unsupported" };
  if (!window.isSecureContext) return { ok: false, problem: "insecure" };
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return { ok: false, problem: "unsupported" };
  return { ok: true, problem: null };
}
export const MIC_PROBLEM: Record<Exclude<MicProblem, null>, string> = {
  insecure: "This page is open over plain http, and browsers only allow the microphone on https or on the server itself.",
  unsupported: "This browser can't record audio.",
  denied: "The microphone is blocked for this site. Allow it in the browser's site settings, then try again.",
  nodevice: "No microphone was found on this device.",
  busy: "The microphone is in use by another app.",
};

/** A recording format both the browser and the server's ffmpeg read: opus in webm (Chrome, Firefox) or AAC in mp4 (Safari). */
const MIME = () => ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(m)) ?? "";

export interface ListenOpts { threshold?: number; silenceMs?: number; maxMs?: number; minSpeechMs?: number }

export function useMic() {
  const level = ref(0);             // 0…1, smoothed
  const open = ref(false), recording = ref(false), listening = ref(false);
  const problem = ref<MicProblem>(micSupport().problem);
  const devices = shallowRef<MediaDeviceInfo[]>([]);
  const deviceId = ref<string>("");
  let stream: MediaStream | null = null, ctx: AudioContext | null = null, analyser: AnalyserNode | null = null, raf = 0;
  let rec: MediaRecorder | null = null, chunks: Blob[] = [], done: ((b: Blob) => void) | null = null;
  let stopListen: (() => void) | null = null;

  async function refreshDevices() {
    try { devices.value = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput"); } catch { devices.value = []; }
  }
  async function start(id = deviceId.value) {
    if (open.value && id === deviceId.value) return true;
    close();
    const s = micSupport();
    if (!s.ok) { problem.value = s.problem; return false; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: id ? { exact: id } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      const n = (e as DOMException).name;
      problem.value = n === "NotAllowedError" || n === "SecurityError" ? "denied" : n === "NotFoundError" || n === "OverconstrainedError" ? "nodevice" : n === "NotReadableError" ? "busy" : "unsupported";
      return false;
    }
    problem.value = null; deviceId.value = id; open.value = true;
    ctx = new AudioContext();
    analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const tick = () => {
      if (!analyser) return;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0; for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      const v = Math.min(1, rms * 6);
      level.value = v > level.value ? v : level.value * 0.85 + v * 0.15;
      raf = requestAnimationFrame(tick);
    };
    tick();
    void refreshDevices();
    return true;
  }
  function record() {
    if (!stream || recording.value) return false;
    const type = MIME();
    rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => { recording.value = false; const b = new Blob(chunks, { type: rec?.mimeType || type || "audio/webm" }); done?.(b); done = null; };
    rec.start(250);
    recording.value = true;
    return true;
  }
  /** Stop recording; the clip, or null when nothing was recording. */
  function finish(): Promise<Blob | null> {
    if (!rec || rec.state === "inactive") return Promise.resolve(null);
    return new Promise((r) => { done = r; rec!.stop(); });
  }
  /** Hands-free: record while someone talks; a clip ends after `silenceMs` of quiet. Calls onClip for each, until stopped. */
  function listen(onClip: (b: Blob) => void, o: ListenOpts = {}) {
    const thr = o.threshold ?? 0.12, silence = o.silenceMs ?? 1300, max = o.maxMs ?? 30_000, minSpeech = o.minSpeechMs ?? 250;
    stopListening();
    listening.value = true;
    let spoke = 0, quietSince = 0, began = 0, alive = true, cutting = false;
    const loop = setInterval(async () => {
      if (!alive || !open.value || cutting) return;
      const now = performance.now(), loud = level.value > thr;
      if (!recording.value) { if (loud) { record(); began = now; spoke = 0; quietSince = 0; } return; }
      if (loud) { spoke += 50; quietSince = 0; } else if (!quietSince) quietSince = now;
      const over = now - began > max, ended = quietSince && now - quietSince > silence;
      if (over || ended) {
        cutting = true;
        const b = await finish();
        cutting = false;
        if (b && spoke >= minSpeech && alive) onClip(b);
      }
    }, 50);
    stopListen = () => { alive = false; clearInterval(loop); listening.value = false; void finish(); };
  }
  function stopListening() { stopListen?.(); stopListen = null; }
  function close() {
    stopListening();
    if (rec && rec.state !== "inactive") { done = null; rec.stop(); }
    rec = null; recording.value = false;
    cancelAnimationFrame(raf);
    stream?.getTracks().forEach((t) => t.stop()); stream = null;
    void ctx?.close().catch(() => {}); ctx = null; analyser = null;
    open.value = false; level.value = 0;
  }
  return { level, open, recording, listening, problem, devices, deviceId, start, record, finish, listen, stopListening, close, refreshDevices };
}

/** Plays /voice/speak as it streams (sentence by sentence), so speech starts before the whole reply is made. */
export function usePlayer() {
  const playing = ref(false);
  let ctx: AudioContext | null = null, ctl: AbortController | null = null, sources: AudioBufferSourceNode[] = [], gen = 0;
  /** Call from a click or key press first: browsers only start audio after a gesture. */
  function unlock() { ctx ??= new AudioContext(); if (ctx.state === "suspended") void ctx.resume(); }
  function stop() {
    gen++; ctl?.abort(); ctl = null;
    for (const s of sources) { try { s.stop(); } catch { /* already ended */ } }
    sources = []; playing.value = false;
  }
  async function say(text: string, voice?: string): Promise<void> {
    stop();
    const my = gen;
    unlock();
    const c = ctx!;
    ctl = new AbortController();
    playing.value = true;
    try {
      const r = await fetch("/api/v1/voice/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, voice }), signal: ctl.signal });
      if (!r.ok || !r.body) throw new Error((await r.json().catch(() => ({}))).detail ?? `Speech failed (HTTP ${r.status})`);
      const rate = Number(r.headers.get("X-Sample-Rate") ?? 24000);
      const reader = r.body.getReader();
      let at = c.currentTime + 0.05, rest = new Uint8Array(0), last: AudioBufferSourceNode | null = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done || my !== gen) break;
        const bytes = new Uint8Array(rest.length + value.length); bytes.set(rest); bytes.set(value, rest.length);
        const n = Math.floor(bytes.length / 2);
        rest = bytes.slice(n * 2);
        if (!n) continue;
        const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, n);
        const buf = c.createBuffer(1, n, rate);
        const ch = buf.getChannelData(0);
        for (let i = 0; i < n; i++) ch[i] = pcm[i] / 32768;
        const s = c.createBufferSource(); s.buffer = buf; s.connect(c.destination);
        at = Math.max(at, c.currentTime + 0.02); s.start(at); at += buf.duration;
        sources.push(s); last = s;
      }
      if (last && my === gen) await new Promise<void>((res) => { last!.onended = () => res(); });
    } catch (e) { if ((e as Error).name !== "AbortError") throw e; }
    finally { if (my === gen) { playing.value = false; sources = []; } }
  }
  return { playing, say, stop, unlock };
}
