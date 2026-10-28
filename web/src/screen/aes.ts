// A small AES-128 block cipher for the one place the remote screen needs it without WebCrypto.
// macOS Screen Sharing logs in with Apple's scheme (RFB security type 30): noVNC derives a key with Diffie-Hellman + MD5
// (its own JS) and encrypts the credentials with AES-128-ECB through window.crypto.subtle. Browsers hide crypto.subtle
// on plain http (http://homepage.home is not a "secure context"), so the login would crash there. installSubtleShim()
// fills in exactly that call, AES-CBC over single 16-byte blocks with a zero IV, and nothing else; on https or
// localhost the real WebCrypto stays in place. The credentials are encrypted in the browser either way.

const SBOX = new Uint8Array(256);
{ // build the S-box from GF(2^8) inverses (FIPS-197 5.1.1)
  let p = 1, q = 1;
  do {
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff; if (q & 0x80) q ^= 0x09;
    const x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4));
    SBOX[p] = (x ^ 0x63) & 0xff;
  } while (p !== 1);
  SBOX[0] = 0x63;
}
const xtime = (b: number) => ((b << 1) ^ (b & 0x80 ? 0x1b : 0)) & 0xff;

/** The 11 round keys of AES-128 (176 bytes). */
export function expandKey(key: Uint8Array): Uint8Array {
  if (key.length !== 16) throw new Error("AES-128 only");
  const w = new Uint8Array(176);
  w.set(key);
  for (let i = 16, rcon = 1; i < 176; i += 4) {
    let t = w.slice(i - 4, i);
    if (i % 16 === 0) {
      t = new Uint8Array([SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]]);
      rcon = xtime(rcon);
    }
    for (let j = 0; j < 4; j++) w[i + j] = w[i - 16 + j] ^ t[j];
  }
  return w;
}

/** Encrypt one 16-byte block. */
export function encryptBlock(rk: Uint8Array, input: Uint8Array): Uint8Array {
  const s = input.slice(0, 16);
  for (let i = 0; i < 16; i++) s[i] ^= rk[i];
  for (let round = 1; round <= 10; round++) {
    for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
    // ShiftRows: row r (bytes r, r+4, r+8, r+12) rotates left by r
    const t = s.slice();
    for (let c = 0; c < 4; c++) for (let r = 1; r < 4; r++) s[c * 4 + r] = t[((c + r) % 4) * 4 + r];
    if (round < 10) for (let c = 0; c < 4; c++) { // MixColumns
      const a = s.slice(c * 4, c * 4 + 4), all = a[0] ^ a[1] ^ a[2] ^ a[3];
      for (let r = 0; r < 4; r++) s[c * 4 + r] = a[r] ^ all ^ xtime(a[r] ^ a[(r + 1) % 4]);
    }
    for (let i = 0; i < 16; i++) s[i] ^= rk[round * 16 + i];
  }
  return s;
}

type ShimKey = { algorithm: { name: string }; rk: Uint8Array };
const bytes = (d: BufferSource) => (d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength));

/** The subset of SubtleCrypto noVNC's AES-ECB uses: importKey("raw", AES-CBC) and encrypt(AES-CBC) on one block. */
export const subtleShim = {
  async importKey(format: string, keyData: BufferSource, alg: { name: string }): Promise<ShimKey> {
    if (format !== "raw" || alg.name !== "AES-CBC") throw new Error("not supported without https");
    return { algorithm: { name: "AES-CBC" }, rk: expandKey(bytes(keyData)) };
  },
  async encrypt(alg: { name: string; iv: BufferSource }, key: ShimKey, data: BufferSource): Promise<ArrayBuffer> {
    const d = bytes(data), iv = bytes(alg.iv);
    if (alg.name !== "AES-CBC" || d.length !== 16 || iv.length !== 16) throw new Error("not supported without https");
    const x = d.map((b, i) => b ^ iv[i]);
    return encryptBlock(key.rk, x).buffer as ArrayBuffer; // the caller keeps the first 16 bytes (no padding block needed)
  },
};

/** Put the shim in place only where the browser has no crypto.subtle (plain http). */
export function installSubtleShim(c: Crypto = globalThis.crypto) {
  if (c.subtle) return false;
  Object.defineProperty(c, "subtle", { value: subtleShim, configurable: true });
  return true;
}
