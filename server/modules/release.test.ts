import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleName, checksumFor, compareSemver, detectInstallMode, modeBlock, parseSemver, pickRelease, RELEASE_PUBLIC_KEY, sha256, verifyBundle, verifySignature, type GhRelease } from "./release";

const enc = (s: string) => new TextEncoder().encode(s);
const keys = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { pub: publicKey.export({ type: "spki", format: "pem" }).toString(), privateKey };
};

describe("semver", () => {
  test("parse", () => {
    expect(parseSemver("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, pre: [] });
    expect(parseSemver("0.2.0-beta.1+build.5")?.pre).toEqual(["beta", "1"]);
    expect(parseSemver("1.2")).toBeNull();
    expect(parseSemver("01.2.3")).toBeNull();
    expect(parseSemver("latest")).toBeNull();
  });
  test("compare", () => {
    expect(compareSemver("v0.2.0", "0.1.0")).toBe(1);
    expect(compareSemver("0.1.0", "v0.1.0")).toBe(0);
    expect(compareSemver("0.9.0", "0.10.0")).toBe(-1);
    expect(compareSemver("1.0.0-beta.2", "1.0.0")).toBe(-1);
    expect(compareSemver("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compareSemver("1.0.0-beta.2", "1.0.0-beta.11")).toBe(-1); // numeric, not text
    expect(compareSemver("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(compareSemver("1.0.0-1", "1.0.0-alpha")).toBe(-1);
    expect(compareSemver("1.0.0+a", "1.0.0+b")).toBe(0);
    expect(compareSemver("nope", "1.0.0")).toBeNull();
  });
});

describe("signature + checksum", () => {
  const { pub, privateKey } = keys();
  const bundle = enc("pretend tarball");
  const name = bundleName("v0.2.0");
  const sums = enc(`${sha256(bundle)}  ${name}\n${"0".repeat(64)}  server-os-setup-darwin-arm64\n`);
  const sig = new Uint8Array(sign(null, sums, privateKey));

  test("a good signature verifies", () => {
    expect(verifySignature(sums, sig, pub)).toBe(true);
    expect(verifyBundle({ bundle, sums, sig }, name, pub)).toBeNull();
  });
  test("tampered SHA256SUMS or signature is refused", () => {
    const t = enc(new TextDecoder().decode(sums).replace(/^./, (c) => (c === "a" ? "b" : "a")));
    expect(verifySignature(t, sig, pub)).toBe(false);
    const s2 = sig.slice(); s2[10] ^= 1;
    expect(verifySignature(sums, s2, pub)).toBe(false);
    expect(verifyBundle({ bundle, sums: t, sig }, name, pub)).toMatch(/signature/);
  });
  test("a signature by another key is refused, also against the real release key", () => {
    expect(verifySignature(sums, sig, keys().pub)).toBe(false);
    expect(verifySignature(sums, sig, RELEASE_PUBLIC_KEY)).toBe(false);
    expect(verifySignature(sums, new Uint8Array(3), pub)).toBe(false); // malformed, no throw
  });
  test("checksum mismatch (signed list, swapped bundle) is refused", () => {
    expect(verifyBundle({ bundle: enc("evil tarball"), sums, sig }, name, pub)).toMatch(/checksum mismatch/);
    expect(verifyBundle({ bundle, sums, sig }, bundleName("v9.9.9"), pub)).toMatch(/no entry/);
  });
  test("checksumFor reads shasum and sha256sum binary format", () => {
    expect(checksumFor(`${"a".repeat(64)} *x.tgz\n`, "x.tgz")).toBe("a".repeat(64));
    expect(checksumFor(`${"a".repeat(64)}  y.tgz\n`, "x.tgz")).toBeNull();
  });
  test("install.sh carries the same public key", () => {
    const sh = readFileSync(join(import.meta.dir, "../../install/install.sh"), "utf8");
    expect(sh).toContain(RELEASE_PUBLIC_KEY.trim());
  });
});

describe("pickRelease", () => {
  const rel = (tag: string, o: Partial<GhRelease> = {}): GhRelease => ({ tag_name: tag, body: `notes ${tag}`, assets: ["SHA256SUMS", "SHA256SUMS.sig", bundleName(tag)].map((name) => ({ name })), ...o });
  const list = [rel("v0.1.0"), rel("v0.3.0-beta.1", { prerelease: true }), rel("v0.2.0"), rel("v0.4.0", { draft: true }), rel("nightly")];
  test("stable skips prereleases and drafts; beta takes the newest", () => {
    expect(pickRelease(list, "stable")?.tag).toBe("v0.2.0");
    expect(pickRelease(list, "beta")?.tag).toBe("v0.3.0-beta.1");
    expect(pickRelease(list, "beta")?.prerelease).toBe(true);
    expect(pickRelease([], "stable")).toBeNull();
  });
  test("signed only with bundle, SHA256SUMS and the .sig", () => {
    expect(pickRelease(list, "stable")?.signed).toBe(true);
    expect(pickRelease([rel("v1.0.0", { assets: [{ name: "SHA256SUMS" }, { name: bundleName("v1.0.0") }] })], "stable")?.signed).toBe(false);
  });
});

describe("install mode", () => {
  const tmp = () => mkdtempSync(join(tmpdir(), "sos-mode-"));
  const noDocker = { dockerenv: "/nonexistent/.dockerenv" };
  test("release layout: <home>/versions/<tag> with a current link", () => {
    const home = tmp(), v = join(home, "versions", "v0.1.0");
    mkdirSync(join(v, "server"), { recursive: true });
    symlinkSync("versions/v0.1.0", join(home, "current"));
    expect(detectInstallMode(join(home, "current"), home, noDocker)).toBe("release");
    expect(detectInstallMode(v, home, noDocker)).toBe("release");
    expect(modeBlock("release")).toBeNull();
  });
  test("a git checkout is never a release, even inside the versions layout", () => {
    const home = tmp(), v = join(home, "versions", "v0.1.0");
    mkdirSync(join(v, ".git"), { recursive: true });
    symlinkSync("versions/v0.1.0", join(home, "current"));
    expect(detectInstallMode(v, home, noDocker)).toBe("git");
    const wt = tmp(); writeFileSync(join(wt, ".git"), "gitdir: /elsewhere\n"); mkdirSync(join(wt, "sub"));
    expect(detectInstallMode(join(wt, "sub"), tmp(), noDocker)).toBe("git"); // worktree: .git is a file, found from below
    expect(modeBlock("git")).toMatch(/git pull/);
  });
  test("this repository is a git checkout", () => {
    expect(detectInstallMode(join(import.meta.dir, "../.."), tmp(), noDocker)).toBe("git");
  });
  test("homebrew, docker, unmanaged", () => {
    const cellar = join(tmp(), "Cellar", "server-os", "0.1.0", "libexec");
    mkdirSync(cellar, { recursive: true });
    expect(detectInstallMode(cellar, tmp(), noDocker)).toBe("homebrew");
    expect(modeBlock("homebrew")).toMatch(/brew upgrade server-os/);
    const d = tmp(), marker = join(d, ".dockerenv"); writeFileSync(marker, "");
    expect(detectInstallMode(d, tmp(), { dockerenv: marker })).toBe("docker");
    expect(detectInstallMode(tmp(), tmp(), noDocker)).toBe("unmanaged");
  });
});
