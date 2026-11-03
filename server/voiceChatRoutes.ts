// Voice chat API (the Voice page's chat; see docs/voice-chat.md): what the chat can use on this server, speech to text
// for a recorded clip, a phone as the microphone (paired the same way as any device), and speakers to answer on.
// The conversation itself is the voice bot's ordinary feed and send (/bots/{ch}/feed, /bots/{ch}/send).
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getState } from "./store";
import { config } from "./core/config";
import { audit } from "./core/logger";
import { problem, requireAdmin, type Env } from "./core/http";
import { startPairing } from "./core/devices";
import { panelAddresses } from "./modules/ports";
import { speak, voices } from "./modules/voice";
import { houseVoice, houseVoiceAvailable, settings as houseSettings } from "./modules/houseVoice";
import { ClipStore, MAX_CLIP_BYTES, MicHub, assistantName, listSpeakers, playOn, speakersConfigured, sttInfo, transcribe, voiceChannel, voiceLanguage, wav, type PhoneState } from "./modules/voiceChat";

export const micHub = new MicHub();
const clips = new ClipStore();
// Spoken acknowledgements (POST /voice/ack): the prompt hook says "got it, doing X" the moment a request lands. Open voice chats
// listen on /voice/ack/stream, show the line and play its clip.
export interface Ack { id: string; text: string; lang: string; at: number; clip: string | null }
const ackSubs = new Set<(a: Ack) => void>();
const ACK_MAX = 300;
const PHONE_STATES = new Set<PhoneState>(["connected", "listening", "recording", "sending", "gone"]);

interface Opts { port: number; demo: boolean }
type C = Context<Env>;

/** A raw audio body (what MediaRecorder made), size-checked. */
async function clip(c: C): Promise<Uint8Array | Response> {
  const type = c.req.header("content-type") ?? "";
  if (!/^(audio|video)\/|^application\/octet-stream/.test(type)) return problem(c, 415, "Unsupported Media Type", "Send the recording as audio/webm, audio/mp4, audio/ogg or audio/wav");
  if (Number(c.req.header("content-length") ?? 0) > MAX_CLIP_BYTES) return problem(c, 413, "Too Large", "Recordings up to 12 MB (about two minutes)");
  const buf = new Uint8Array(await c.req.arrayBuffer());
  if (!buf.length) return problem(c, 400, "Bad Request", "The recording is empty");
  if (buf.length > MAX_CLIP_BYTES) return problem(c, 413, "Too Large", "Recordings up to 12 MB (about two minutes)");
  return buf;
}
const langOf = (c: C) => { const l = c.req.query("lang") ?? "auto"; return /^(en|tr|auto)$/.test(l) ? l : "auto"; };

export function voiceChatRoutes(api: Hono<Env>, o: Opts) {
  const bot = () => ((getState().botSessions ?? []) as unknown as { channel: string; cwd: string; running: boolean }[]).find((b) => b.channel === voiceChannel()) ?? null;

  // Everything the chat needs to set itself up: who it talks to, which mics and outputs exist, and why one doesn't.
  api.get("/voice/chat", async (c) => {
    const b = bot();
    const hv = houseVoiceAvailable() ? await houseVoice().catch(() => null) : null;
    const voice = hv?.voice ?? houseSettings().voice ?? "af_heart";
    const https = panelAddresses(o.port).find((a) => a.startsWith("https://")) ?? null;
    return c.json({
      name: o.demo ? "Nova" : assistantName(b?.cwd), channel: voiceChannel(), available: o.demo || !!b, running: o.demo || !!b?.running,
      voice, language: voiceLanguage(voice, hv?.language ?? null),
      stt: o.demo ? { available: true, engine: "whisper.cpp", model: "small", englishOnly: false, reason: null } : sttInfo(),
      deskSpeaker: o.demo ? { available: true, enabled: true, state: "idle" } : hv ? { available: true, enabled: hv.enabled, state: hv.state } : { available: false },
      speakers: { configured: o.demo || speakersConfigured() },
      // Where a phone opens its mic page: the panel's https address (a phone browser only allows the mic on https).
      phoneUrl: https, auth: config.auth,
    });
  });

  api.post("/voice/transcribe", async (c) => {
    const a = await clip(c);
    if (a instanceof Response) return a;
    if (o.demo) return c.json({ text: "What's the weather like this weekend?", language: "en", ms: 640 });
    try { return c.json(await transcribe(a, langOf(c))); }
    catch (e) { return problem(c, 503, "Speech to text", (e as Error).message); }
  });

  // ---------- spoken acknowledgement ----------
  // speak() makes the audio now; the clip is kept 10 minutes under an unguessable id. Without a voice service the line still shows.
  api.post("/voice/ack", requireAdmin, async (c) => {
    const j = await c.req.json().catch(() => null) as { text?: unknown; lang?: unknown } | null;
    const text = typeof j?.text === "string" ? j.text.trim().replace(/\s+/g, " ") : "";
    if (!text || text.length > ACK_MAX) return problem(c, 400, "Bad Request", `text: one short sentence, up to ${ACK_MAX} characters`);
    const lang = /^(en|tr|auto)$/.test(String(j?.lang ?? "")) ? String(j!.lang) : "auto";
    const hv = !o.demo && houseVoiceAvailable() ? await houseVoice().catch(() => null) : null;
    let voice = hv?.voice ?? houseSettings().voice ?? "af_heart";
    if (lang === "tr" && !voice.startsWith("tr-")) voice = (await voices().catch(() => null))?.voices.find((v) => v.startsWith("tr-")) ?? voice;
    let clip: string | null = null;
    if (!o.demo) {
      const r = await speak(text, voice);
      if (r) { try { clip = clips.put(wav(new Uint8Array(await r.arrayBuffer()))); } catch { clip = null; } }
    }
    const ack: Ack = { id: Buffer.from(crypto.getRandomValues(new Uint8Array(6))).toString("hex"), text, lang, at: Date.now(), clip: clip ? `/api/v1/voice/clips/${clip}.wav` : null };
    for (const s of ackSubs) s(ack);
    audit(c.get("actor"), "voice.ack", ack.id, "ok", c.get("trace"));
    return c.json({ ok: true, id: ack.id, spoken: !!clip, listeners: ackSubs.size });
  });
  api.get("/voice/ack/stream", (c) => streamSSE(c, async (stream) => {
    const q: Ack[] = []; let wake: (() => void) | null = null;
    const push = (a: Ack) => { q.push(a); wake?.(); };
    ackSubs.add(push);
    stream.onAbort(() => { ackSubs.delete(push); wake?.(); });
    await stream.writeSSE({ event: "ready", data: "{}" });
    while (!stream.aborted) {
      if (!q.length) await new Promise<void>((r) => { wake = r; setTimeout(r, 15_000); });
      wake = null;
      while (q.length) await stream.writeSSE({ event: "ack", data: JSON.stringify(q.shift()) });
      await stream.writeSSE({ event: "ping", data: "" });
    }
    ackSubs.delete(push);
  }));

  // ---------- phone as microphone ----------
  // The chat opens a mic session; the phone opens <https panel>/#mic?s=<id>&code=<pairing code>. A phone that isn't
  // signed in yet trades the one-time code for a device token (the normal pairing), so every call below is authenticated.
  // A device that is already paired (an app, a voice satellite) finds the chat to feed here instead of scanning its code.
  api.get("/voice/mic", (c) => c.json({ sessions: micHub.list() }));
  api.post("/voice/mic", async (c) => {
    const j = await c.req.json().catch(() => null) as { label?: unknown } | null;
    const id = micHub.create(Date.now(), typeof j?.label === "string" ? j.label : null);
    const pairing = config.auth === "token" ? startPairing() : null;
    const base = panelAddresses(o.port).find((a) => a.startsWith("https://")) ?? new URL(c.req.url).origin;
    const q = new URLSearchParams({ s: id, ...(pairing ? { code: pairing.code } : {}) });
    audit(c.get("actor"), "voice.mic.open", id, "ok", c.get("trace"));
    return c.json({ id, url: `${base}/#mic?${q}`, secure: base.startsWith("https://") || /^http:\/\/(localhost|127\.)/.test(base), code: pairing?.code ?? null, expires: pairing?.expires ?? null });
  });
  api.get("/voice/mic/:id", (c) => {
    const v = micHub.view(c.req.param("id"), Number(c.req.query("after") ?? 0) || 0);
    return v ? c.json({ ...v, name: o.demo ? "Nova" : assistantName(bot()?.cwd) }) : problem(c, 404, "Not Found", "This mic link has ended. Open a new one from the chat.");
  });
  api.delete("/voice/mic/:id", (c) => (micHub.close(c.req.param("id")) ? c.body(null, 204) : problem(c, 404, "Not Found", "No such mic session")));
  api.get("/voice/mic/:id/events", (c) => {
    const id = c.req.param("id");
    if (!micHub.get(id)) return problem(c, 404, "Not Found", "No such mic session");
    return streamSSE(c, async (stream) => {
      const q: string[] = [];
      let wake: (() => void) | null = null;
      const off = micHub.listen(id, (e) => { q.push(JSON.stringify(e)); wake?.(); });
      const v = micHub.view(id);
      await stream.writeSSE({ event: "mic", data: JSON.stringify({ type: "phone", state: v?.state, device: v?.device, at: Date.now() }) });
      stream.onAbort(() => { off(); wake?.(); });
      while (!stream.aborted && micHub.get(id)) {
        if (!q.length) await new Promise<void>((r) => { wake = r; setTimeout(r, 15_000); });
        wake = null;
        while (q.length) await stream.writeSSE({ event: "mic", data: q.shift()! });
        await stream.writeSSE({ event: "ping", data: "" });
      }
      off();
    });
  });
  api.post("/voice/mic/:id/state", async (c) => {
    const j = await c.req.json().catch(() => null) as { state?: string; device?: string } | null;
    const st = String(j?.state ?? "") as PhoneState;
    if (!PHONE_STATES.has(st)) return problem(c, 400, "Bad Request", "state: connected, listening, recording, sending or gone");
    return micHub.phone(c.req.param("id"), st, typeof j?.device === "string" ? j.device : null) ? c.json({ ok: true }) : problem(c, 404, "Not Found", "This mic link has ended");
  });
  api.post("/voice/mic/:id/clip", async (c) => {
    const id = c.req.param("id");
    if (!micHub.get(id)) return problem(c, 404, "Not Found", "This mic link has ended");
    const a = await clip(c);
    if (a instanceof Response) return a;
    micHub.phone(id, "sending");
    try {
      const r = o.demo ? { text: "Read me the news headlines", language: "en", ms: 500 } : await transcribe(a, langOf(c));
      if (r.text) micHub.heard(id, r.text, r.language);
      micHub.phone(id, "connected");
      return c.json(r);
    } catch (e) {
      micHub.emit(id, { type: "error", detail: (e as Error).message, at: Date.now() });
      micHub.phone(id, "connected");
      return problem(c, 503, "Speech to text", (e as Error).message);
    }
  });

  // The chat hands its answer back to the mic that asked (a phone or a satellite can show it or speak it).
  api.post("/voice/mic/:id/reply", async (c) => {
    const j = await c.req.json().catch(() => null) as { text?: unknown; language?: unknown; done?: unknown } | null;
    if (!j) return problem(c, 415, "Unsupported Media Type", "JSON only");
    const text = typeof j.text === "string" ? j.text : null, language = typeof j.language === "string" ? j.language.slice(0, 8) : null;
    if (!text?.trim() && j.done !== true) return problem(c, 400, "Bad Request", "text (the answer) or done: true");
    return micHub.reply(c.req.param("id"), { text, language, done: j.done === true }) ? c.json({ ok: true }) : problem(c, 404, "Not Found", "This mic link has ended");
  });

  // The chat asks its mic to listen now (the TV remote's mic button): the phone page / a satellite records one sentence.
  api.post("/voice/mic/:id/listen", (c) => {
    const id = c.req.param("id"), m = micHub.get(id);
    if (!m) return problem(c, 404, "Not Found", "This mic link has ended");
    if (m.state === "waiting" || m.state === "gone") return problem(c, 409, "Conflict", "No phone is connected to this mic link");
    micHub.emit(id, { type: "listen", at: Date.now() });
    return c.json({ ok: true });
  });

  // ---------- speakers ----------
  api.get("/voice/speakers", async (c) => {
    if (o.demo) return c.json({ configured: true, baseUrl: true, speakers: [{ id: "media_player.living_room", name: "Living Room Sonos", state: "idle", available: true }] });
    if (!speakersConfigured()) return c.json({ configured: false, baseUrl: false, speakers: [] });
    try { return c.json({ configured: true, baseUrl: !!config.integrations.speakers?.baseUrl, speakers: await listSpeakers() }); }
    catch (e) { return problem(c, 502, "Bad Gateway", (e as Error).message); }
  });
  api.post("/voice/speakers/play", async (c) => {
    const j = await c.req.json().catch(() => null) as { entity?: string; text?: string; voice?: string } | null;
    const text = String(j?.text ?? "").trim(), entity = String(j?.entity ?? "");
    if (!text || text.length > 8000) return problem(c, 400, "Bad Request", "Text to speak (up to 8000 characters)");
    if (o.demo) return c.json({ ok: true });
    const base = config.integrations.speakers?.baseUrl?.replace(/\/$/, "");
    if (!base) return problem(c, 409, "Conflict", "Set integrations.speakers.baseUrl to an address the speaker can reach");
    let list: Awaited<ReturnType<typeof listSpeakers>>;
    try { list = await listSpeakers(); } catch (e) { return problem(c, 502, "Bad Gateway", (e as Error).message); }
    if (!list.some((s) => s.id === entity)) return problem(c, 404, "Not Found", "Unknown speaker");
    const r = await speak(text, j?.voice);
    if (!r) return problem(c, 503, "Service Unavailable", "The voice service is not running");
    const id = clips.put(wav(new Uint8Array(await r.arrayBuffer())));
    try { await playOn(entity, `${base}/api/v1/voice/clips/${id}.wav`); } catch (e) { return problem(c, 502, "Bad Gateway", (e as Error).message); }
    audit(c.get("actor"), "voice.speaker.play", entity, "ok", c.get("trace"));
    return c.json({ ok: true });
  });
  // Open (a speaker can't sign in): the id is 128 random bits and the clip is gone after 10 minutes.
  api.get("/voice/clips/:file", (c) => {
    const m = c.req.param("file").match(/^([0-9a-f]{32})\.wav$/);
    const d = m ? clips.get(m[1]) : null;
    return d ? new Response(new Blob([d as Uint8Array<ArrayBuffer>]), { headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store" } }) : problem(c, 404, "Not Found", "This clip has expired");
  });
}
