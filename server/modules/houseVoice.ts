// House voice: the always-listening wake-word speaker (a Bluetooth JBL on the desk) that talks
// to the main bot. It runs in its own tmux session, so it inherits tmux's microphone permission. Its settings live in
// that project's config.json (read by the listener at start), and it reports what it is doing in status.json.
// While it is switched on, a watchdog keeps it running: after a reboot, a crash, or the speaker coming back.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../core/config";
import { run } from "../lib";

// Everything is off unless integrations.houseVoice names the listener project (dir) and/or the voice session launcher.
const HV = config.integrations.houseVoice ?? {};
const DIR = HV.dir ?? "";
const CONFIG = join(DIR, "config.json");
const STATUS = join(DIR, "status.json");
const SESSION = HV.session ?? "house-voice";
const TMUX = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].find(existsSync) ?? "tmux";

export type HouseVoiceSettings = { enabled: boolean; volume: number; followUp: number; threshold: number; voice: string; language: string };
const DEFAULTS: HouseVoiceSettings = { enabled: true, volume: 0.1, followUp: 8, threshold: 0.5, voice: "af_heart", language: "" };

const readJson = <T>(p: string): T | null => { try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return null; } };
export const houseVoiceAvailable = () => !!DIR && existsSync(join(DIR, "listen.py"));
export const settings = (): HouseVoiceSettings => ({ ...DEFAULTS, ...(readJson<Partial<HouseVoiceSettings>>(CONFIG) ?? {}) });

async function running() { return (await run([TMUX, "has-session", "-t", SESSION], 5000)).code === 0; }
async function start() {
  return run([TMUX, "new-session", "-d", "-s", SESSION, `cd ${DIR} && exec .venv/bin/python listen.py >> listen.log 2>&1`], 8000);
}
async function stop() {
  await run([TMUX, "kill-session", "-t", SESSION], 5000);
  writeFileSync(STATUS, JSON.stringify({ state: "off", ts: Date.now() }));
}

export async function houseVoice() {
  const s = settings();
  const up = await running();
  const st = readJson<{ state?: string; ts?: number; heard?: string; reply?: string; detail?: string }>(STATUS) ?? {};
  // A status left behind by a listener that is gone says nothing about now.
  const state = !up ? (s.enabled ? "starting" : "off") : !st.state || st.state === "off" ? "starting" : st.state;
  return { available: true, ...s, running: up, state, detail: st.detail ?? null, heard: st.heard ?? null, reply: st.reply ?? null, updated: st.ts ?? null };
}

const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/** Apply a change from the panel: switch on/off, or new settings (the listener restarts to pick them up). */
export async function setHouseVoice(patch: Partial<HouseVoiceSettings>) {
  const old = settings();
  const next: HouseVoiceSettings = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : old.enabled,
    volume: clamp(patch.volume, 0, 1, old.volume),
    followUp: clamp(patch.followUp, 3, 30, old.followUp),
    threshold: clamp(patch.threshold, 0.2, 0.9, old.threshold),
    voice: typeof patch.voice === "string" && /^[\w-]{1,40}$/.test(patch.voice) ? patch.voice : old.voice,
    // What you speak: "" follows the voice (Turkish for tr- voices), or "en" / "tr" / "auto".
    language: typeof patch.language === "string" && ["", "en", "tr", "auto"].includes(patch.language) ? patch.language : old.language ?? "",
  };
  writeFileSync(CONFIG, JSON.stringify(next, null, 2) + "\n");
  const up = await running();
  if (!next.enabled) { if (up) await stop(); }
  else if (!up) await start();
  else if (JSON.stringify({ ...next, enabled: true }) !== JSON.stringify({ ...old, enabled: true })) { await stop(); await start(); }
  return houseVoice();
}

// The bot's voice session: its identity in its own conversation (no Telegram). Every voice surface talks to it: the desk speaker and the apps' voice screen.
const VOICE_LAUNCH = HV.voiceLaunch ?? "";
const VOICE_SESSION = HV.voiceSession ?? "bot-voice";
export const voiceSessionAvailable = () => !!VOICE_LAUNCH && existsSync(VOICE_LAUNCH);
async function ensureVoiceSession() {
  if (!voiceSessionAvailable()) return;
  if ((await run([TMUX, "has-session", "-t", VOICE_SESSION], 5000)).code === 0) return;
  await run([TMUX, "new-session", "-d", "-s", VOICE_SESSION, "-x", "200", "-y", "50", VOICE_LAUNCH], 8000);
}

/** Keep the voice session up, and the listener while it is on. */
export async function houseVoiceWatchdog() {
  await ensureVoiceSession();
  if (!houseVoiceAvailable() || !settings().enabled) return;
  if (!(await running())) await start();
}
