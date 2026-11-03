// Glass desktop page switch (v2, 2026-10-30, after the reel study): "the room breathes". The old page's panels dissolve
// (opacity + blur out, 180 ms), the empty wallpaper shows for a beat (120 ms), then the new page's panels blur in one by
// one, left to right and top to bottom. Each panel animates on its own: blurring the whole page at once would make it a
// backdrop root and switch the glass off for the length of the animation.
// The classic layout keeps its own CSS fade; App.vue only binds these hooks in desktop mode.

const SURF = ".stat,.seg,.search,.at,.pick,.rep-t,.pack,.genre,.sim-t,.tile2,.card,.card2,.dc,.dcard,.svc,.tile,.row,.banner,.side,.detail,.bside,.bmain,.kpi,.hero,.conv,.bws-box,.tbl,.hs-stage,.perm-banner,.ov-range";
export const OUT_MS = 180, BEAT_MS = 120, IN_MS = 420, STEP_MS = 45, MAX_STAGGER = 14;

/** The page's floating parts: top-level surfaces, plus loose blocks (headers, notes) that hold no surface. */
function parts(root: Element): HTMLElement[] {
  const out: HTMLElement[] = [];
  const walk = (el: Element) => {
    for (const c of Array.from(el.children) as HTMLElement[]) {
      if (c.matches(SURF)) out.push(c);
      else if (c.querySelector(SURF)) walk(c);
      else if (c.offsetParent !== null || getComputedStyle(c).position === "fixed") out.push(c);
    }
  };
  walk(root);
  return out;
}

const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();

export function onEnter(el: Element, done: () => void) {
  // the page frame (.content) is the scroller in desktop mode: a new page starts at its top
  if (el.parentElement) el.parentElement.scrollTop = 0;
  const ps = parts(el);
  // reading order: rows first (with a little tolerance so a row of cards counts as one row), then left to right
  const pos = ps.map((p) => { const r = p.getBoundingClientRect(); return { p, top: Math.round(r.top / 40), left: r.left }; });
  pos.sort((a, b) => a.top - b.top || a.left - b.left);
  pos.forEach(({ p }, i) => { p.style.setProperty("--gs-d", `${BEAT_MS + Math.min(i, MAX_STAGGER) * STEP_MS}ms`); p.classList.add("gs-in"); });
  clearTimeout(timers.get(el));
  // drop the class afterwards so hover lifts (translate) work again
  timers.set(el, setTimeout(() => ps.forEach((p) => { p.classList.remove("gs-in"); p.style.removeProperty("--gs-d"); }), BEAT_MS + MAX_STAGGER * STEP_MS + IN_MS + 80));
  done();
}

export function onLeave(el: Element, done: () => void) {
  clearTimeout(timers.get(el));
  // The frame's classes (wide, fit) already describe the next page while this one fades out: freeze this page's box
  // so it keeps its own width and height instead of reflowing to the next page's layout (the user 2026-10-31).
  const box = el as HTMLElement, r = box.getBoundingClientRect();
  Object.assign(box.style, { width: `${r.width}px`, height: `${r.height}px`, maxWidth: "none", flex: "none" });
  for (const p of parts(el)) { p.classList.remove("gs-in"); p.classList.add("gs-out"); }
  setTimeout(done, OUT_MS);
}
