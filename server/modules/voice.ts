// Voice for the apps: the main bot's replies spoken by a local text-to-speech service: Kokoro
// (~/projects/kokoro-tts, 127.0.0.1:8880, quick) or Chatterbox Turbo (~/projects/chatterbox-tts, 127.0.0.1:8881, the
// more natural voice; voices named "chatterbox…" go there) or the Turkish voices (~/projects/xtts-tts, 127.0.0.1:8882;
// voices named "tr-…": XTTS-v2 and Piper). All speak the same API. Audio streams straight through as it is made, sentence by sentence:
// raw 16-bit mono PCM at 24 kHz, so an app can start playing before the whole reply is synthesized.
import { config } from "../core/config";
import { cloudEnabled } from "./cloudVoice";

const base = () => (config.integrations as { tts?: string }).tts?.replace(/\/$/, "") ?? "http://127.0.0.1:8880";
const chatterbox = () => (config.integrations as { ttsChatterbox?: string }).ttsChatterbox?.replace(/\/$/, "") ?? "http://127.0.0.1:8881";
const turkish = () => (config.integrations as { ttsTurkish?: string }).ttsTurkish?.replace(/\/$/, "") ?? "http://127.0.0.1:8882";
/** Which service speaks a voice, by name prefix: "tr-…" Turkish, "chatterbox…" Chatterbox Turbo, anything else Kokoro. */
export const serviceFor = (voice?: string) => (voice?.startsWith("tr-") ? turkish() : voice?.startsWith("chatterbox") ? chatterbox() : base());

/** Markdown and chat decoration read aloud badly: keep the words. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")                 // code blocks: not for the ear
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")          // links: their text
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/[*_~|>]+/g, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export async function voiceAvailable(): Promise<boolean> {
  try { return (await fetch(`${base()}/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}

type VoiceList = { voices: string[]; rate: number; cloud?: string[]; labels?: Record<string, string> };
export async function voices(): Promise<{ voices: string[]; rate: number; cloud: string[]; labels: Record<string, string>; cloudEnabled: boolean } | null> {
  const list = async (url: string) => {
    try { return await (await fetch(`${url}/v1/voices`, { signal: AbortSignal.timeout(3000) })).json() as VoiceList; } catch { return null; }
  };
  const [k, c, t] = await Promise.all([list(base()), list(chatterbox()), list(turkish())]);
  if (!k && !c && !t) return null;
  // cloud: voices a service runs in the cloud (picker marks them); they are served locally while the switch is off
  return { voices: [...(t?.voices ?? []), ...(c?.voices ?? []), ...(k?.voices ?? [])], rate: 24000,
    cloud: [...(t?.cloud ?? []), ...(c?.cloud ?? []), ...(k?.cloud ?? [])], labels: { ...k?.labels, ...c?.labels, ...t?.labels }, cloudEnabled: cloudEnabled() };
}

/** The service's streaming response (PCM), or null when it isn't running. */
export async function speak(text: string, voice?: string, speed?: number): Promise<Response | null> {
  try {
    const r = await fetch(`${serviceFor(voice)}/v1/audio/speech`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: speakable(text), voice: voice || "af_heart", speed: speed || 1.0, format: "pcm", cloud: cloudEnabled() }),
    });
    return r.ok ? r : null;
  } catch { return null; }
}
