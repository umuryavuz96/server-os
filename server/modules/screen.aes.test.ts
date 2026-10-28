import { expect, test } from "bun:test";
// The browser-side AES fallback the Mac screen uses on plain http (web/src/screen/aes.ts), checked against WebCrypto.
import { encryptBlock, expandKey, installSubtleShim, subtleShim } from "../../web/src/screen/aes";

const hex = (s: string) => new Uint8Array(s.match(/../g)!.map((h) => parseInt(h, 16)));
const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

test("FIPS-197 appendix C.1 vector", () => {
  const out = encryptBlock(expandKey(hex("000102030405060708090a0b0c0d0e0f")), hex("00112233445566778899aabbccddeeff"));
  expect(toHex(out)).toBe("69c4e0d86a7b0430d8cdb78070b4c55a");
});

test("matches WebCrypto AES-CBC (zero IV) on random keys and blocks, the way noVNC calls it", async () => {
  for (let i = 0; i < 50; i++) {
    const key = crypto.getRandomValues(new Uint8Array(16)), block = crypto.getRandomValues(new Uint8Array(16)), iv = new Uint8Array(16);
    const real = await crypto.subtle.importKey("raw", key, { name: "AES-CBC" }, false, ["encrypt"]);
    const want = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, real, block)).slice(0, 16);
    const mine = new Uint8Array(await subtleShim.encrypt({ name: "AES-CBC", iv }, await subtleShim.importKey("raw", key, { name: "AES-CBC" }), block)).slice(0, 16);
    expect(toHex(mine)).toBe(toHex(want));
  }
});

test("installs only where crypto.subtle is missing; refuses anything else", async () => {
  expect(installSubtleShim(crypto)).toBe(false);
  const bare = { getRandomValues: crypto.getRandomValues.bind(crypto) } as unknown as Crypto;
  expect(installSubtleShim(bare)).toBe(true);
  expect(bare.subtle as unknown).toBe(subtleShim);
  await expect(subtleShim.importKey("raw", new Uint8Array(16), { name: "AES-GCM" })).rejects.toThrow();
  await expect(subtleShim.encrypt({ name: "AES-CBC", iv: new Uint8Array(16) }, await subtleShim.importKey("raw", new Uint8Array(16), { name: "AES-CBC" }), new Uint8Array(32))).rejects.toThrow();
});

import { applyMode } from "../../web/src/screen/modes";
const setEnc = (ids: number[]) => { const f = new Uint8Array(4 + 4 * ids.length), v = new DataView(f.buffer); f[0] = 2; v.setUint16(2, ids.length); ids.forEach((e, i) => v.setInt32(4 + 4 * i, e)); return f; };
const ids = (f: Uint8Array) => { const v = new DataView(f.buffer, f.byteOffset, f.byteLength); return Array.from({ length: (f[2] << 8) | f[3] }, (_, i) => v.getInt32(4 + 4 * i)); };

test("picture modes rewrite the encodings list and nothing else", () => {
  const all = [1, 7, -260, 16, 21, 5, 2, 6, 0, -23, -247]; // CopyRect, Tight, TightPNG, ZRLE, JPEG, Hextile, RRE, Zlib, Raw, + pseudo
  expect(ids(applyMode(setEnc(all), "balanced"))).toEqual(all);
  expect(ids(applyMode(setEnc(all), "performance"))).toEqual([1, 7, 16, 5, 0, -23, -247]);
  expect(ids(applyMode(setEnc(all), "quality"))).toEqual([1, 16, 0, -23, -247]);
  const other = new Uint8Array([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  expect(applyMode(other, "quality")).toBe(other); // update requests pass through untouched
});
