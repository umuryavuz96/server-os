// Pairing + device tokens.
// `server-os pair` (holding the local admin key) opens a 6-digit code for 5 minutes; an app trades the code
// for a device token. Only a SHA-256 of each token is stored, in data/server-os.db. Devices can be revoked.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dir } from "./config";
import { db, schema } from "./db";

export interface Device { id: string; name: string; platform: string; created: number; lastSeen: number | null }

const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
const token = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

schema(`CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE, created INTEGER NOT NULL, last_seen INTEGER)`);
const open = db;

/** Local admin key: lets the CLI on this machine open a pairing window. Created on first use, mode 0600. */
let key: string | null = null;
export function adminKey(): string {
  if (key) return key;
  const f = join(dir("data"), "admin.key");
  if (existsSync(f)) return (key = readFileSync(f, "utf8").trim());
  if (!existsSync(dir("data"))) mkdirSync(dir("data"), { recursive: true });
  const k = token();
  writeFileSync(f, k + "\n", { mode: 0o600 });
  chmodSync(f, 0o600);
  return (key = k);
}

const PAIR_TTL = 5 * 60_000, MAX_TRIES = 5;
let pending: { code: string; expires: number; tries: number } | null = null;

export function startPairing(now = Date.now()) {
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
  pending = { code, expires: now + PAIR_TTL, tries: 0 };
  return { code, expires: pending.expires };
}

/** Trade a pairing code for a device token. The code is single-use and dies after 5 wrong guesses. */
export function completePairing(code: string, name: string, platform: string, now = Date.now()):
  { ok: true; device: Device; token: string } | { ok: false; error: string } {
  if (!pending || now > pending.expires) { pending = null; return { ok: false, error: "no pairing in progress — run `server-os pair`" }; }
  if (code !== pending.code) {
    if (++pending.tries >= MAX_TRIES) pending = null;
    return { ok: false, error: "wrong code" };
  }
  pending = null;
  const t = token();
  const device: Device = { id: crypto.randomUUID(), name: name.slice(0, 80) || "Device", platform: platform.slice(0, 40) || "unknown", created: now, lastSeen: now };
  open().run("INSERT INTO devices (id, name, platform, token_hash, created, last_seen) VALUES (?, ?, ?, ?, ?, ?)",
    [device.id, device.name, device.platform, sha(t), device.created, device.lastSeen]);
  return { ok: true, device, token: t };
}

/** A new device token without a pairing code — for a browser that just proved it knows the owner's password. */
export function issueDevice(name: string, platform: string, now = Date.now()): { device: Device; token: string } {
  const t = token();
  const device: Device = { id: crypto.randomUUID(), name: name.slice(0, 80) || "Device", platform: platform.slice(0, 40) || "unknown", created: now, lastSeen: now };
  open().run("INSERT INTO devices (id, name, platform, token_hash, created, last_seen) VALUES (?, ?, ?, ?, ?, ?)",
    [device.id, device.name, device.platform, sha(t), device.created, device.lastSeen]);
  return { device, token: t };
}

const seen = new Map<string, number>(); // throttle last_seen writes to once a minute per device

/** The device a bearer token belongs to, or null. */
export function verify(t: string, now = Date.now()): Device | null {
  if (!t) return null;
  const row = open().query("SELECT id, name, platform, created, last_seen AS lastSeen FROM devices WHERE token_hash = ?").get(sha(t)) as Device | null;
  if (row && now - (seen.get(row.id) ?? 0) > 60_000) {
    seen.set(row.id, now);
    open().run("UPDATE devices SET last_seen = ? WHERE id = ?", [now, row.id]);
  }
  return row;
}

export const listDevices = (): Device[] =>
  open().query("SELECT id, name, platform, created, last_seen AS lastSeen FROM devices ORDER BY created").all() as Device[];

export const revoke = (id: string): boolean => open().run("DELETE FROM devices WHERE id = ?", [id]).changes > 0;
