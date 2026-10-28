// Picture modes for the Mac screen. noVNC always offers one fixed list of encodings (best first) and the server picks
// from it, so the lever that works with any server is the list itself: we rewrite the client's SetEncodings message
// on its way out. Quality/compression levels only matter to Tight/JPEG, which Apple's server may not use at all;
// the overlay in the viewer shows what it really sends.
export type Mode = "performance" | "balanced" | "quality";
export const MODES: Mode[] = ["performance", "balanced", "quality"];

const RRE = 2, ZLIB = 6, HEXTILE = 5, TIGHT = 7, JPEG = 21, H264 = 50, TIGHT_PNG = -260;
// Encodings dropped from the offer. Everything else (CopyRect, Raw, cursor, resize, ... pseudo-encodings) stays.
const DROP: Record<Mode, number[]> = {
  performance: [H264, TIGHT_PNG, JPEG, RRE, ZLIB],            // Tight (lossy JPEG for photos) > ZRLE > Hextile > Raw
  balanced: [],                                               // noVNC's own list, untouched
  quality: [H264, TIGHT, TIGHT_PNG, JPEG, HEXTILE, RRE, ZLIB], // lossless only: CopyRect, ZRLE, Raw
};
// Tight/JPEG quality (0-9) and compression (0-9) pseudo-encodings: low quality + heavy compression vs the opposite.
export const LEVELS: Record<Mode, { quality: number; compression: number }> = {
  performance: { quality: 2, compression: 9 }, balanced: { quality: 6, compression: 2 }, quality: { quality: 9, compression: 0 },
};

export const ENCODING_NAMES: Record<number, string> = { 0: "Raw", 1: "CopyRect", 2: "RRE", 5: "Hextile", 6: "Zlib", 7: "Tight", 16: "ZRLE", 21: "JPEG", 50: "H264", [-260]: "TightPNG" };

/** Rewrite a SetEncodings message (type 2) for a mode; any other message is returned as it is. */
export function applyMode(msg: Uint8Array, mode: Mode): Uint8Array {
  if (msg.length < 4 || msg[0] !== 2) return msg;
  const n = (msg[2] << 8) | msg[3];
  if (n === 0 || msg.length !== 4 + 4 * n) return msg;
  const v = new DataView(msg.buffer, msg.byteOffset, msg.byteLength), keep: number[] = [];
  for (let i = 0; i < n; i++) { const e = v.getInt32(4 + 4 * i); if (!DROP[mode].includes(e)) keep.push(e); }
  const out = new Uint8Array(4 + 4 * keep.length), o = new DataView(out.buffer);
  out[0] = 2; o.setUint16(2, keep.length);
  keep.forEach((e, i) => o.setInt32(4 + 4 * i, e));
  return out;
}

// Display resolution the Mac is switched to while the session is open (server/modules/displayMode.ts). A headless Mac's
// virtual display is 3840x2160, ~14 MB per ZRLE frame: unusable. Non-HiDPI 1080p keeps the same layout at a quarter of
// the pixels; 720p is a ninth. Each picture mode has a default; an explicit choice wins and is remembered.
export type Res = "native" | "1080p" | "720p";
export const RESES: Res[] = ["native", "1080p", "720p"];
export const RES_LABEL: Record<Res, string> = { native: "Native", "1080p": "1080p", "720p": "720p" };
export const RES_HELP: Record<Res, string> = { native: "The Mac's full resolution: sharpest, slowest", "1080p": "1920×1080, same layout, a quarter of the pixels", "720p": "1280×720, a ninth of the pixels: fastest, larger text" };
export const DEFAULT_RES: Record<Mode, Res> = { performance: "720p", balanced: "1080p", quality: "native" };
export const parseRes = (v: unknown): Res | null => (RESES.includes(v as Res) ? (v as Res) : null);

/** One line of advice for the Stats overlay when the link is saturated by huge frames, else "". */
export function bandwidthTip(kbPerFrame: number, fps: number, res: Res): string {
  if (kbPerFrame < 2000 || fps >= 8) return "";
  return res === "native" ? "Frames are huge: pick 1080p or 720p above. A photo wallpaper also compresses badly, a plain colour wallpaper helps a lot."
    : "Frames are still huge: a photo wallpaper compresses badly, a plain colour wallpaper helps a lot (or try 720p).";
}
