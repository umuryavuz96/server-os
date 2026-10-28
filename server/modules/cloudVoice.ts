// Cloud voices (ElevenLabs): the "use cloud voices" switch and the live usage numbers. The voices themselves are served by
// the text-to-speech service (voice.ts routes them like any other); this module only holds the switch and reads the account's
// usage from GET /v1/user/subscription (needs an API key with "User: read"). The key lives in ~/.env under integrations.elevenLabs.keyEnv.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config, dir } from "../core/config";
import { loadEnv } from "../lib";

const file = () => join(dir("data"), "voice.json");
/** Is the cloud-voices switch on? Default on; stored in data/voice.json. */
export function cloudEnabled(): boolean {
  try { return (JSON.parse(readFileSync(file(), "utf8")) as { cloud?: boolean }).cloud !== false; } catch { return true; }
}
export function setCloudEnabled(on: boolean) {
  mkdirSync(dirname(file()), { recursive: true });
  writeFileSync(file(), JSON.stringify({ cloud: on }) + "\n");
}

// Measured 2026-10-28 on a Flash v2.5 account: a 67-character Turkish request moved the credit counter by 7, about 0.1 credit
// per character (not the published rate). Speech runs at roughly 900 characters a minute.
export const CREDITS_PER_CHAR = 0.1;
export const CHARS_PER_MINUTE = 900;

export type Usage =
  | { state: "ok"; used: number; limit: number; percent: number; resetsAt: number | null; tier: string; status: string | null; minutesLeft: number }
  | { state: "no-key" | "needs-permission" | "error"; message: string };

export const minutesLeft = (used: number, limit: number) => Math.max(0, Math.round((limit - used) / CREDITS_PER_CHAR / CHARS_PER_MINUTE));

/** Turn the subscription JSON into what the card shows. */
export function parseUsage(j: Record<string, unknown>): Usage {
  const used = Number(j.character_count), limit = Number(j.character_limit);
  if (!Number.isFinite(used) || !Number.isFinite(limit)) return { state: "error", message: "Unexpected answer from ElevenLabs" };
  const reset = Number(j.next_character_count_reset_unix);
  return {
    state: "ok", used, limit, percent: limit > 0 ? Math.min(100, Math.round((used / limit) * 1000) / 10) : 0,
    resetsAt: Number.isFinite(reset) && reset > 0 ? reset : null, tier: String(j.tier ?? ""), status: j.status ? String(j.status) : null,
    minutesLeft: minutesLeft(used, limit),
  };
}

let cache: { at: number; usage: Usage } | null = null;
export const resetUsageCache = () => { cache = null; };

/** The account's usage, cached for 60 s. Never throws; failures come back as a state the card can explain. */
export async function usage(fetcher: typeof fetch = fetch, now = Date.now(), env: Record<string, string> = loadEnv()): Promise<Usage> {
  if (cache && now - cache.at < 60_000) return cache.usage;
  const key = env[config.integrations.elevenLabs?.keyEnv ?? "ELEVENLABS_API_KEY"];
  let u: Usage;
  if (!key) u = { state: "no-key", message: "No ElevenLabs key is set" };
  else {
    try {
      const r = await fetcher("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": key }, signal: AbortSignal.timeout(5000) });
      if (r.ok) u = parseUsage((await r.json()) as Record<string, unknown>);
      else if (r.status === 401 || r.status === 403) {
        const body = await r.text().catch(() => "");
        u = /missing_permissions|user_read/i.test(body) ? { state: "needs-permission", message: "The key needs the User: read permission" } : { state: "error", message: "ElevenLabs rejected the key" };
      } else u = { state: "error", message: `ElevenLabs answered ${r.status}` };
    } catch { u = { state: "error", message: "Couldn't reach ElevenLabs" }; }
  }
  if (u.state !== "error") cache = { at: now, usage: u };
  return u;
}
