// The Voices page: every voice the speech services can speak with (live from their /v1/voices), with a cached sample each,
// plus a static catalog of open-source voices to try (voiceCatalog.json). Samples are made once, on the first press of ▶,
// and kept under data/voice-samples/ (never on page load: a cloud voice costs credits).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dir } from "../core/config";
import { cloudEnabled } from "./cloudVoice";
import { speak, voices } from "./voice";

const SAMPLES: Record<string, string> = {
  en: "Hello, this is how I sound. Nice to meet you.",
  tr: "Merhaba, ben böyle konuşuyorum. Tanıştığımıza memnun oldum.",
  es: "Hola, así suena mi voz. Mucho gusto.", fr: "Bonjour, voici ma voix. Enchanté.", hi: "नमस्ते, यह मेरी आवाज़ है।",
  it: "Ciao, questa è la mia voce. Piacere.", ja: "こんにちは、これが私の声です。", pt: "Olá, esta é a minha voz. Prazer.", zh: "你好，这是我的声音。很高兴认识你。",
};
export const sampleText = (lang: string) => SAMPLES[lang] ?? SAMPLES.en;
const LANG_NAME: Record<string, string> = { en: "English", tr: "Turkish", es: "Spanish", fr: "French", hi: "Hindi", it: "Italian", ja: "Japanese", pt: "Portuguese", zh: "Chinese" };
const KOKORO_LANG: Record<string, string> = { a: "en", b: "en", e: "es", f: "fr", h: "hi", i: "it", j: "ja", p: "pt", z: "zh" };

export interface Described { id: string; name: string; lang: string; language: string; accent?: string; engine: string; cloud: boolean; cost: string }

/** Name, language, engine and cost of a voice, from its id (and the service's cloud list / labels). */
export function describe(id: string, cloud: string[] = [], labels: Record<string, string> = {}): Described {
  const isCloud = cloud.includes(id);
  const cost = isCloud ? "ElevenLabs credits" : "free";
  const out = (name: string, lang: string, engine: string, accent?: string): Described => ({ id, name, lang, language: LANG_NAME[lang] ?? lang, engine, cloud: isCloud, cost, ...(accent ? { accent } : {}) });
  if (id.startsWith("tr-")) {
    const engine = isCloud ? "ElevenLabs Flash v2.5" : id === "tr-piper" ? "Piper" : "XTTS-v2";
    const name = labels[id]?.replace(/ \(.*\)$/, "") ?? id.slice(3).replace(/^xtts-?/, "").replace(/^./, (c) => c.toUpperCase()) ?? id;
    return out(id === "tr-piper" ? "Piper" : name || "XTTS default", "tr", engine);
  }
  if (id.startsWith("chatterbox")) return out("Chatterbox", "en", "Chatterbox Turbo");
  const m = /^([a-z])([fm])_(\w+)$/.exec(id);
  if (m) return out(m[3][0].toUpperCase() + m[3].slice(1), KOKORO_LANG[m[1]] ?? "en", "Kokoro", m[1] === "a" ? "American" : m[1] === "b" ? "British" : undefined);
  return out(id, "en", "Kokoro");
}

const cacheDir = () => join(dir("data"), "voice-samples");
const safe = (v: string) => /^[\w-]{1,40}$/.test(v);
type Meta = { ms: number; seconds: number; rtf: number; chars: number };
const wavPath = (v: string) => join(cacheDir(), `${v}.wav`);
const metaPath = (v: string) => join(cacheDir(), `${v}.json`);
const readMeta = (v: string): Meta | null => { try { return JSON.parse(readFileSync(metaPath(v), "utf8")) as Meta; } catch { return null; } };

/** 16-bit mono PCM at 24 kHz wrapped as WAV so any <audio> element plays it. */
export function wav(pcm: Uint8Array, rate = 24000): Uint8Array {
  const h = new DataView(new ArrayBuffer(44)), s = (o: number, t: string) => [...t].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
  s(0, "RIFF"); h.setUint32(4, 36 + pcm.length, true); s(8, "WAVE"); s(12, "fmt "); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
  h.setUint32(24, rate, true); h.setUint32(28, rate * 2, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true); s(36, "data"); h.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length); out.set(new Uint8Array(h.buffer)); out.set(pcm, 44); return out;
}

const inflight = new Map<string, Promise<string | { error: string; status: number }>>();
/** Path of the voice's cached sample, making it first if needed (one request at a time per voice). */
export async function sampleFile(voice: string): Promise<string | { error: string; status: number }> {
  if (!safe(voice)) return { error: "Unknown voice", status: 400 };
  if (existsSync(wavPath(voice))) return wavPath(voice);
  const known = await voices();
  if (!known?.voices.includes(voice)) return { error: "The voice service doesn't list that voice", status: 404 };
  const d = describe(voice, known.cloud, known.labels);
  if (d.cloud && !cloudEnabled()) return { error: "Cloud voices are switched off", status: 409 };
  const running = inflight.get(voice);
  if (running) return running;
  const job = (async () => {
    const text = sampleText(d.lang);
    const t0 = performance.now();
    const r = await speak(text, voice, 1.0);
    if (!r?.body) return { error: "The voice service isn't answering", status: 503 };
    const pcm = new Uint8Array(await r.arrayBuffer());
    const ms = Math.round(performance.now() - t0);
    if (pcm.length < 4800) return { error: "The voice made no sound", status: 502 };
    mkdirSync(cacheDir(), { recursive: true });
    const seconds = pcm.length / 48000;
    writeFileSync(wavPath(voice), wav(pcm));
    writeFileSync(metaPath(voice), JSON.stringify({ ms, seconds: Math.round(seconds * 100) / 100, rtf: Math.round((ms / 1000 / seconds) * 100) / 100, chars: text.length } satisfies Meta));
    return wavPath(voice);
  })().finally(() => inflight.delete(voice));
  inflight.set(voice, job);
  return job;
}

export interface CatalogEntry { id: string; name: string; kind: string; languages: string; turkish: string; cloning: boolean; license: string; size: string; repo: string; demo: string; note: string; engine?: string }
export const catalog = (): CatalogEntry[] => JSON.parse(readFileSync(join(import.meta.dir, "voiceCatalog.json"), "utf8")) as CatalogEntry[];

/** The page's data: installed voices (with cached-sample state and measured speed) and the catalog, "installed" marked by engine. */
export async function showcase() {
  const v = await voices();
  const installed = (v?.voices ?? []).map((id) => {
    const m = readMeta(id);
    return { ...describe(id, v?.cloud, v?.labels), sample: existsSync(wavPath(id)), speed: m ? { rtf: m.rtf, seconds: m.seconds, ms: m.ms } : null };
  });
  const engines = new Set(installed.map((i) => i.engine));
  return { available: !!v, cloudEnabled: cloudEnabled(), installed, catalog: catalog().map((c) => ({ ...c, installed: !!c.engine && engines.has(c.engine) })) };
}
