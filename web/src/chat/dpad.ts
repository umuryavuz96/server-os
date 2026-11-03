// D-pad navigation for the voice chat's TV kiosk (#voice-chat?kiosk=1): arrow keys move focus to the nearest control
// in that direction, Enter activates it (native for buttons and links), Escape / Backspace / the TV's Back key closes
// what is open. pickNext() is pure so the server's tests cover it; useDpad.ts wires it to the page.
export type Dir = "up" | "down" | "left" | "right";
export interface Box { x: number; y: number; w: number; h: number }
export const KEY_DIR: Record<string, Dir> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
/** Keys a TV remote sends for Back. */
export const BACK_KEYS = new Set(["Escape", "Backspace", "GoBack", "BrowserBack", "XF86Back"]);

/** The candidate to move to: in the direction, nearest by distance along it, with sideways offset counting double. -1 when none. */
export function pickNext(from: Box, list: Box[], dir: Dir): number {
  const cx = from.x + from.w / 2, cy = from.y + from.h / 2;
  let best = -1, score = Infinity;
  list.forEach((b, i) => {
    const bx = b.x + b.w / 2, by = b.y + b.h / 2;
    const along = dir === "up" ? from.y - (b.y + b.h) : dir === "down" ? b.y - (from.y + from.h) : dir === "left" ? from.x - (b.x + b.w) : b.x - (from.x + from.w);
    const centre = dir === "up" ? cy - by : dir === "down" ? by - cy : dir === "left" ? cx - bx : bx - cx;
    if (centre <= 0 || along < -Math.min(from.w, from.h, b.w, b.h) / 2) return; // not in that direction
    const side = dir === "up" || dir === "down" ? Math.abs(bx - cx) : Math.abs(by - cy);
    const s = Math.max(0, along) + side * 2;
    if (s < score) { score = s; best = i; }
  });
  return best;
}
