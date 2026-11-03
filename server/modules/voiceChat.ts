// Voice chat: what the panel's chat with the voice assistant needs on the server. Speech to text for clips the browser
// records (ffmpeg decodes webm/opus, mp4/aac or wav to 16 kHz mono, whisper.cpp transcribes: the same CLI and model
// the desk speaker's listener uses), the phone-as-microphone relay (a paired phone posts clips for one chat, the chat
// hears them over SSE), and speakers that can play a reply through Home Assistant (a Sonos: output only, its
// microphones are reserved for Sonos' own assistants, see docs/voice-chat.md).
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { config } from "../core/config";
import { HOME, ENV } from "../lib";

// ---------- the assistant's name ----------
/** From config (integrations.houseVoice.name), else the first heading of the voice session's CLAUDE.md ("# Ada — voice
 *  session" → "Ada"), else "Assistant". Never hardcoded: Server OS is used with any bot. */
export function assistantName(cwd: string | null | undefined, configured = config.integrations.houseVoice?.name): string {
  if (configured?.trim()) return configured.trim().slice(0, 40);
  if (cwd) {
    try {
      const h = readFileSync(join(cwd, "CLAUDE.md"), "utf8").match(/^#\s+(.+)$/m)?.[1];
      const name = h?.split(/\s+[—–-]\s+|:/)[0]?.trim();
      if (name && name.length <= 40) return name;
    } catch { /* no instructions file */ }
  }
  return "Assistant";
}
export const voiceChannel = () => config.integrations.houseVoice?.channel ?? "voice";

/** What the person speaks: "" follows the voice (Turkish for tr- voices), else en / tr / auto. */
export function voiceLanguage(voice: string | null | undefined, language: string | null | undefined): "en" | "tr" | "auto" {
  if (language === "en" || language === "tr" || language === "auto") return language;
  return voice?.startsWith("tr-") ? "tr" : "en";
}

// ---------- speech to text (whisper.cpp) ----------
const S = () => config.integrations.stt ?? {};
const firstFile = (list: (string | null | undefined)[]) => list.find((p): p is string => !!p && existsSync(p)) ?? null;
function whisperBin() { return firstFile([S().whisper, "/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli", Bun.which("whisper-cli")]); }
function ffmpegBin() { return firstFile([S().ffmpeg, "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg", Bun.which("ffmpeg")]); }
function whisperModel() {
  const d = join(HOME, ".whisper-models");
  const any = existsSync(d) ? readdirSync(d).filter((f) => /^ggml-.*\.bin$/.test(f)).map((f) => join(d, f)) : [];
  return firstFile([S().model, join(d, "ggml-small.bin"), join(d, "ggml-base.bin"), join(d, "ggml-base.en.bin"), ...any]);
}
export function sttInfo() {
  const w = whisperBin(), m = whisperModel(), f = ffmpegBin();
  const reason = !w ? "whisper.cpp (whisper-cli) isn't installed" : !m ? "No whisper model in ~/.whisper-models (or integrations.stt.model)" : !f ? "ffmpeg isn't installed" : null;
  return { available: !reason, engine: "whisper.cpp", model: m ? basename(m).replace(/^ggml-|\.bin$/g, "") : null, englishOnly: !!m && /\.en\.bin$/.test(m), reason };
}

/** whisper output → what was said: one line, without its "[BLANK_AUDIO]" / "(music)" style markers. */
export function cleanTranscript(out: string): string {
  return out.replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, " ").replace(/\s+/g, " ").trim();
}

export const MAX_CLIP_BYTES = 12 * 1024 * 1024;
let queue: Promise<unknown> = Promise.resolve(); // one transcription at a time: whisper is heavy on a small machine
async function exec(cmd: string[], ms: number) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const t = setTimeout(() => p.kill(), ms);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited; clearTimeout(t);
  return { code, out, err };
}
/** A recorded clip (any format ffmpeg reads) → text. language: en / tr / auto (whisper detects it). */
export function transcribe(audio: Uint8Array, language: string): Promise<{ text: string; language: string; ms: number }> {
  const job = queue.then(async () => {
    const w = whisperBin(), m = whisperModel(), f = ffmpegBin();
    if (!w || !m || !f) throw new Error(sttInfo().reason ?? "Speech to text isn't set up");
    const lang = /^(en|tr|auto|[a-z]{2})$/.test(language) ? (m.endsWith(".en.bin") ? "en" : language) : "auto";
    const d = mkdtempSync(join(tmpdir(), "sos-stt-"));
    const t0 = performance.now();
    try {
      writeFileSync(join(d, "in"), audio);
      const dec = await exec([f, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", join(d, "in"), "-t", "120", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", join(d, "a.wav")], 30_000);
      if (dec.code !== 0) throw new Error("Couldn't read the recording" + (dec.err ? `: ${dec.err.trim().split("\n").pop()}` : ""));
      const r = await exec([w, "-m", m, "-l", lang, "-nt", "-f", join(d, "a.wav")], 90_000);
      if (r.code !== 0) throw new Error("whisper.cpp failed");
      const detected = r.err.match(/auto-detected language:\s*([a-z]{2})/)?.[1];
      return { text: cleanTranscript(r.out), language: lang === "auto" ? detected ?? "en" : lang, ms: Math.round(performance.now() - t0) };
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  queue = job.catch(() => {});
  return job;
}

// ---------- phone as microphone ----------
export type PhoneState = "waiting" | "connected" | "listening" | "recording" | "sending" | "gone";
export interface MicReply { seq: number; text: string; language: string | null; at: number }
export type MicEvent =
  | { type: "phone"; state: PhoneState; device?: string | null; at: number }
  | { type: "transcript"; id: string; text: string; language: string; at: number }
  | { type: "reply"; seq: number; text: string; language: string | null; at: number }
  /** The chat asks the mic to listen now (the TV remote's mic button): one sentence, half duplex. */
  | { type: "listen"; at: number }
  | { type: "error"; detail: string; at: number };
interface MicSession {
  id: string; created: number; seen: number; state: PhoneState; device: string | null; listeners: Set<(e: MicEvent) => void>;
  /** What the chat calls this screen ("TV"), so an app can find it without scanning its code. */
  label: string | null;
  /** The chat's answers to what the phone said, so the phone can show and speak them (last 20). busy: answer coming. */
  replies: MicReply[]; seq: number; busy: boolean;
}

/** Mic sessions: one per chat that asked for "use my phone". In memory only; idle ones end after `ttl`. */
export class MicHub {
  private s = new Map<string, MicSession>();
  constructor(private ttl = 30 * 60_000) {}
  create(now = Date.now(), label: string | null = null) {
    this.sweep(now);
    const id = Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("hex");
    this.s.set(id, { id, created: now, seen: now, state: "waiting", device: null, listeners: new Set(), label: label?.trim().slice(0, 40) || null, replies: [], seq: 0, busy: false });
    return id;
  }
  get(id: string, now = Date.now()) { this.sweep(now); return this.s.get(id) ?? null; }
  view(id: string, after = 0) {
    const m = this.s.get(id);
    return m ? { id, state: m.state, device: m.device, created: m.created, seen: m.seen, label: m.label, busy: m.busy, seq: m.seq, replies: m.replies.filter((r) => r.seq > after) } : null;
  }
  /** The sessions a chat is still showing (someone listens to its events), newest first: what "Talk to TV" picks from. */
  list(now = Date.now()) {
    this.sweep(now);
    return [...this.s.values()].filter((m) => m.listeners.size > 0).sort((a, b) => b.created - a.created)
      .map((m) => ({ id: m.id, label: m.label, state: m.state, device: m.device, created: m.created }));
  }
  /** The phone says what it is doing; also its heartbeat. */
  phone(id: string, state: PhoneState, device: string | null = null, now = Date.now()) {
    const m = this.get(id, now); if (!m) return false;
    m.seen = now; m.state = state; if (device) m.device = device.slice(0, 60);
    this.emit(id, { type: "phone", state, device: m.device, at: now });
    return true;
  }
  /** A transcript goes to the chat: an answer is now on its way. */
  heard(id: string, text: string, language: string, now = Date.now()) {
    const m = this.s.get(id); if (!m) return false;
    m.busy = true;
    this.emit(id, { type: "transcript", id: crypto.randomUUID(), text, language, at: now });
    return true;
  }
  /** The chat hands back an answer (text) for the phone, or says the turn is over (done). */
  reply(id: string, r: { text?: string | null; language?: string | null; done?: boolean }, now = Date.now()) {
    const m = this.s.get(id); if (!m) return false;
    const text = r.text?.trim();
    if (text) {
      const e: MicReply = { seq: ++m.seq, text: text.slice(0, 8000), language: r.language ?? null, at: now };
      m.replies.push(e); if (m.replies.length > 20) m.replies.shift();
      this.emit(id, { type: "reply", ...e });
    }
    if (r.done) m.busy = false;
    return true;
  }
  emit(id: string, e: MicEvent) { const m = this.s.get(id); if (m) for (const f of m.listeners) f(e); }
  listen(id: string, f: (e: MicEvent) => void) { const m = this.s.get(id); if (!m) return () => {}; m.listeners.add(f); m.seen = Date.now(); return () => m.listeners.delete(f); }
  close(id: string) { this.emit(id, { type: "phone", state: "gone", at: Date.now() }); return this.s.delete(id); }
  sweep(now = Date.now()) {
    for (const [id, m] of this.s) if (now - m.seen > this.ttl && !m.listeners.size) this.s.delete(id);
    // a phone that stopped sending heartbeats (screen locked, page closed) is gone
    for (const [id, m] of this.s) if (m.state !== "waiting" && m.state !== "gone" && now - m.seen > 45_000) { m.state = "gone"; this.emit(id, { type: "phone", state: "gone", at: now }); }
  }
  get size() { return this.s.size; }
}

// ---------- speakers (output only, through Home Assistant) ----------
/** 16-bit mono PCM → a WAV file a speaker can fetch. */
export function wav(pcm: Uint8Array, rate = 24000): Uint8Array {
  const h = new DataView(new ArrayBuffer(44));
  const str = (o: number, s: string) => [...s].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); h.setUint32(4, 36 + pcm.length, true); str(8, "WAVE"); str(12, "fmt ");
  h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true); h.setUint32(24, rate, true);
  h.setUint32(28, rate * 2, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true); str(36, "data"); h.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length); out.set(new Uint8Array(h.buffer)); out.set(pcm, 44);
  return out;
}

/** Reply clips a speaker fetches by URL: unguessable ids, gone after 10 minutes. */
export class ClipStore {
  private m = new Map<string, { data: Uint8Array; expires: number }>();
  put(data: Uint8Array, now = Date.now()) {
    for (const [k, v] of this.m) if (v.expires < now) this.m.delete(k);
    const id = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
    this.m.set(id, { data, expires: now + 10 * 60_000 });
    return id;
  }
  get(id: string, now = Date.now()) { const v = this.m.get(id); return v && v.expires >= now ? v.data : null; }
}

type HaState = { entity_id: string; state: string; attributes: Record<string, unknown> };
/** The speakers to offer: integrations.speakers.entities, else Home Assistant players whose name says Sonos. */
export function pickSpeakers(states: HaState[], entities?: string[]) {
  const players = states.filter((s) => s.entity_id.startsWith("media_player."));
  const chosen = entities?.length ? players.filter((s) => entities.includes(s.entity_id))
    : players.filter((s) => /sonos/i.test(`${s.entity_id} ${s.attributes.friendly_name ?? ""}`));
  const seen = new Set<string>();
  return chosen.map((s) => ({ id: s.entity_id, name: String(s.attributes.friendly_name ?? s.entity_id), state: s.state, available: s.state !== "unavailable" }))
    .filter((s) => { const k = s.name; if (!entities?.length && seen.has(k)) return false; seen.add(k); return true; });
}
export function playPayload(entity: string, url: string) {
  return { entity_id: entity, media_content_id: url, media_content_type: "music", announce: true };
}
export const speakersConfigured = () => !!config.integrations.homeAssistant && !!config.integrations.speakers;

/** Home Assistant through curl (macOS Local Network privacy can block LAN access for some runtimes; curl is allowed).
 *  The token goes in on stdin (-H @-), never on the command line. */
async function ha(path: string, body?: unknown): Promise<unknown> {
  const h = config.integrations.homeAssistant;
  const token = h ? ENV[h.tokenEnv ?? "HA_TOKEN"] : "";
  if (!h || !token) throw new Error("Home Assistant isn't set up (integrations.homeAssistant)");
  const cmd = ["/usr/bin/curl", "-s", "--max-time", "8", "-H", "@-", ...(body ? ["-X", "POST", "-H", "Content-Type: application/json", "--data-binary", JSON.stringify(body)] : []), `${h.url.replace(/\/$/, "")}${path}`];
  const p = Bun.spawn(cmd, { stdin: new TextEncoder().encode(`Authorization: Bearer ${token}\n`), stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text(); await p.exited;
  try { return JSON.parse(out); } catch { throw new Error("Home Assistant didn't answer"); }
}
export async function listSpeakers() {
  if (!speakersConfigured()) return [];
  const st = await ha("/api/states");
  return Array.isArray(st) ? pickSpeakers(st as HaState[], config.integrations.speakers?.entities) : [];
}
/** Play a clip URL on a speaker. The caller made sure the entity is one of listSpeakers(). */
export async function playOn(entity: string, url: string) {
  await ha("/api/services/media_player/play_media", playPayload(entity, url));
}
