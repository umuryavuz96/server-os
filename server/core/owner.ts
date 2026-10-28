// The owner account: the first thing a new server asks for, in the web panel. Username + password (argon2id via
// Bun.password). Any device on the home network or tailnet can create it on first visit; from outside (a public
// proxy), only with the one-time setup link the installer prints (data/setup.token).
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { dir } from "./config";
import { db, schema } from "./db";

schema(`CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK (id = 1), username TEXT NOT NULL, hash TEXT NOT NULL, created INTEGER NOT NULL)`);

export const hasOwner = () => !!db().query("SELECT 1 FROM owner WHERE id = 1").get();
export const ownerName = () => (db().query("SELECT username FROM owner WHERE id = 1").get() as { username: string } | null)?.username ?? null;

const tokenFile = () => join(dir("data"), "setup.token");
/** The one-time setup token for claiming the server (exists only while there is no owner). */
export function setupToken(): string | null {
  if (hasOwner()) return null;
  if (existsSync(tokenFile())) return readFileSync(tokenFile(), "utf8").trim();
  mkdirSync(dir("data"), { recursive: true });
  const t = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64url");
  writeFileSync(tokenFile(), t + "\n", { mode: 0o600 });
  chmodSync(tokenFile(), 0o600);
  return t;
}

export function validUsername(u: string) { return /^[a-zA-Z0-9._@-]{2,64}$/.test(u); }
export function passwordProblem(p: string): string | null {
  if (p.length < 10) return "Use at least 10 characters";
  if (p.length > 200) return "That's too long";
  return null;
}

export async function createOwner(username: string, password: string): Promise<string | null> {
  if (hasOwner()) return "This server already has an owner";
  if (!validUsername(username)) return "Username: 2–64 letters, digits, . _ @ -";
  const bad = passwordProblem(password);
  if (bad) return bad;
  db().run("INSERT INTO owner (id, username, hash, created) VALUES (1, ?, ?, ?)", [username, await Bun.password.hash(password), Date.now()]);
  rmSync(tokenFile(), { force: true }); // the claim link dies with the first owner
  return null;
}

export async function verifyOwner(username: string, password: string): Promise<boolean> {
  const row = db().query("SELECT username, hash FROM owner WHERE id = 1").get() as { username: string; hash: string } | null;
  if (!row) return false;
  const ok = await Bun.password.verify(password, row.hash); // always hash-compare, even for a wrong name
  return ok && row.username.toLowerCase() === username.toLowerCase();
}

export async function changePassword(oldPw: string, newPw: string): Promise<string | null> {
  const name = ownerName();
  if (!name || !(await verifyOwner(name, oldPw))) return "The current password is wrong";
  const bad = passwordProblem(newPw);
  if (bad) return bad;
  db().run("UPDATE owner SET hash = ? WHERE id = 1", [await Bun.password.hash(newPw)]);
  return null;
}

// ---- slow down guessing: 5 failed sign-ins per address per 15 minutes ----
const fails = new Map<string, number[]>();
export function tooManyAttempts(key: string, now = Date.now()) {
  const recent = (fails.get(key) ?? []).filter((t) => now - t < 15 * 60_000);
  fails.set(key, recent);
  return recent.length >= 5;
}
export function noteFailure(key: string, now = Date.now()) { fails.set(key, [...(fails.get(key) ?? []), now]); }
export function clearFailures(key: string) { fails.delete(key); }
