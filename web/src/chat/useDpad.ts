// The DOM side of the D-pad navigation (pure part: dpad.ts).
import { BACK_KEYS, KEY_DIR, pickNext, type Box } from "./dpad";

const FOCUSABLE = "button:not([disabled]), a[href], textarea, select, input, [tabindex]:not([tabindex='-1'])";
/** Arrow keys move focus inside `root`; a scrollable element marked data-dpad-scroll scrolls with Up/Down first. */
export function useDpad(root: () => HTMLElement | null, onBack: () => boolean) {
  function visible(el: HTMLElement) { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden" && !el.closest("[inert]"); }
  function onKey(e: KeyboardEvent) {
    const r = root(); if (!r) return;
    if (BACK_KEYS.has(e.key)) {
      const t = e.target as HTMLElement;
      if (e.key === "Backspace" && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) return;
      if (onBack()) e.preventDefault();
      return;
    }
    const dir = KEY_DIR[e.key]; if (!dir) return;
    const cur = (document.activeElement as HTMLElement | null) ?? r;
    if (cur.tagName === "TEXTAREA" && (cur as HTMLTextAreaElement).value && (dir === "left" || dir === "right")) return; // move the caret
    if (cur.tagName === "SELECT" && (dir === "up" || dir === "down")) return;
    if (cur.dataset.dpadScroll !== undefined && (dir === "up" || dir === "down")) {
      const before = cur.scrollTop;
      cur.scrollBy({ top: dir === "up" ? -240 : 240 });
      if (cur.scrollTop !== before) { e.preventDefault(); return; }
    }
    // a dialog or sheet that is open keeps the focus inside it
    const scope = (r.querySelector("[data-dpad-trap]") as HTMLElement | null) ?? r;
    const els = [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el !== cur && visible(el) && !el.closest("[data-dpad-skip]"));
    if (!els.length) return;
    e.preventDefault();
    if (!scope.contains(cur) || cur === r) { els[0].focus(); return; }
    const box = (el: HTMLElement): Box => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; };
    const i = pickNext(box(cur), els.map(box), dir);
    if (i >= 0) { els[i].focus(); els[i].scrollIntoView?.({ block: "nearest" }); }
  }
  return { onKey };
}
