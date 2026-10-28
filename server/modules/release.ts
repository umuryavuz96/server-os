// Release helpers for the self-updater (server/modules/update.ts), kept free of side effects so the release
// workflow and the tests can import them: semver, the Ed25519 signature on SHA256SUMS, checksums, picking a
// release from the GitHub API list, and how this copy of Server OS was installed.
import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";

/** Public half of the release signing key. The private half is the Actions secret SERVER_OS_SIGNING_KEY; the release
 *  workflow signs SHA256SUMS with it. install/install.sh carries the same key (a test keeps the two equal). */
export const RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAzw7A78HeKVk+lRM9HJRhQiKBjIKq14bLRZ80m+IcZRc=
-----END PUBLIC KEY-----
`;

export const bundleName = (tag: string) => `server-os-${tag}.tar.gz`;
export const SUMS = "SHA256SUMS", SIG = "SHA256SUMS.sig";

// ---------- semver ----------
export interface SemVer { major: number; minor: number; patch: number; pre: string[] }
const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;
export function parseSemver(v: string): SemVer | null {
  const m = SEMVER.exec(v.trim());
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split(".") : [] } : null;
}
/** -1 / 0 / 1 like a sort comparator (semver 2.0 precedence: 1.0.0-beta < 1.0.0, build metadata ignored); null if either is not semver. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 | null {
  const x = parseSemver(a), y = parseSemver(b);
  if (!x || !y) return null;
  for (const k of ["major", "minor", "patch"] as const) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return +p < +q ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1; // numeric identifiers sort before alphanumeric ones
    return p < q ? -1 : 1;
  }
  return 0;
}

// ---------- signature + checksums ----------
/** Ed25519 signature over the exact bytes of SHA256SUMS. Never throws: a malformed key or signature is just "no". */
export function verifySignature(data: Uint8Array, sig: Uint8Array, publicKeyPem = RELEASE_PUBLIC_KEY): boolean {
  try { return sig.length === 64 && verify(null, data, createPublicKey(publicKeyPem), sig); } catch { return false; }
}
export const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
/** The hex digest SHA256SUMS lists for `file` (shasum / sha256sum format, text or binary marker). */
export function checksumFor(sums: string, file: string): string | null {
  for (const line of sums.split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m && m[2] === file) return m[1].toLowerCase();
  }
  return null;
}
/** Signature first, then the bundle's checksum. Returns why it is refused, or null when both hold. */
export function verifyBundle(files: { bundle: Uint8Array; sums: Uint8Array; sig: Uint8Array }, name: string, publicKeyPem = RELEASE_PUBLIC_KEY): string | null {
  if (!verifySignature(files.sums, files.sig, publicKeyPem)) return "the signature on SHA256SUMS does not match the Server OS release key";
  const want = checksumFor(new TextDecoder().decode(files.sums), name);
  if (!want) return `SHA256SUMS has no entry for ${name}`;
  const got = sha256(files.bundle);
  if (got !== want) return `checksum mismatch for ${name} (expected ${want.slice(0, 12)}…, got ${got.slice(0, 12)}…)`;
  return null;
}

// ---------- releases ----------
export interface GhAsset { name: string; browser_download_url?: string; size?: number }
export interface GhRelease { tag_name: string; name?: string | null; body?: string | null; draft?: boolean; prerelease?: boolean; published_at?: string | null; html_url?: string; assets?: GhAsset[] }
export interface Release { tag: string; version: string; name: string; notes: string; prerelease: boolean; publishedAt: string | null; url: string | null; signed: boolean }
export type Channel = "stable" | "beta";

/** The newest release for the channel: stable = non-prerelease only, beta = prereleases too. Drafts and non-semver tags are skipped. */
export function pickRelease(list: GhRelease[], channel: Channel): Release | null {
  let best: GhRelease | null = null;
  for (const r of list) {
    if (r.draft || !parseSemver(r.tag_name)) continue;
    if ((r.prerelease || parseSemver(r.tag_name)!.pre.length) && channel !== "beta") continue;
    if (!best || compareSemver(r.tag_name, best.tag_name) === 1) best = r;
  }
  if (!best) return null;
  const names = new Set((best.assets ?? []).map((a) => a.name));
  return {
    tag: best.tag_name, version: best.tag_name.replace(/^v/, ""), name: best.name || best.tag_name, notes: String(best.body ?? "").slice(0, 20_000),
    prerelease: !!best.prerelease || parseSemver(best.tag_name)!.pre.length > 0, publishedAt: best.published_at ?? null, url: best.html_url ?? null,
    signed: names.has(SIG) && names.has(SUMS) && names.has(bundleName(best.tag_name)),
  };
}

// ---------- install mode ----------
export type InstallMode = "release" | "git" | "homebrew" | "docker" | "unmanaged";
const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };

/** How this copy runs, from the folder holding server/ (sourceDir) and SERVER_OS_HOME. Only "release" (the
 *  <home>/versions/<tag> + <home>/current layout install.sh makes) may be replaced by the updater. A git working tree
 *  anywhere above the source is always "git", whatever else is true, so the updater can never write over one. */
export function detectInstallMode(sourceDir: string, home: string, o: { dockerenv?: string } = {}): InstallMode {
  for (let d = real(sourceDir); ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return "git";
    if (dirname(d) === d) break;
  }
  const src = real(sourceDir);
  if (src.includes(`${sep}Cellar${sep}`) || /\/(homebrew|linuxbrew)\/.*\/libexec(\/|$)/.test(src)) return "homebrew";
  if (existsSync(o.dockerenv ?? "/.dockerenv")) return "docker";
  try {
    if (lstatSync(join(home, "current")).isSymbolicLink() && dirname(src) === real(join(home, "versions"))) return "release";
  } catch { /* no current link */ }
  return "unmanaged";
}

/** What the panel says when applying is off for this install mode (null = the updater can apply). */
export function modeBlock(mode: InstallMode): string | null {
  switch (mode) {
    case "release": return null;
    case "git": return "This is a git checkout (developer mode). Update it with git pull; the updater never writes over a working tree.";
    case "homebrew": return "Installed with Homebrew. Update with: brew upgrade server-os";
    case "docker": return "Running in Docker. Pull the new image and recreate the container.";
    case "unmanaged": return "This install isn't in the versions/current layout. Reinstall with install/install.sh to get one-click updates.";
  }
}
