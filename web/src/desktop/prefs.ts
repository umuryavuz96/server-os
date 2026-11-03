// Look of this browser's panel: the classic sidebar layout or the glass desktop (wallpaper, floating dock on the left,
// menu bar on top), plus "reduce transparency" for solid panels. Kept per browser in localStorage; the page reads them
// from <html data-layout data-glass> so style.css can switch everything in one place.
import { reactive, watchEffect } from "vue";

export type Layout = "classic" | "desktop";
export type Wallpaper = "room" | "dusk" | "aurora";
const KEY = "sos.look";

interface Look { layout: Layout; solid: boolean; wallpaper: Wallpaper; motion: boolean; rev?: number }
// rev 2 (glass v2): the warm room photo became the default; a look saved by v1 (which stored "dusk") moves to it once.
const REV = 2;
const DEFAULTS: Look = { layout: "classic", solid: false, wallpaper: "room", motion: true, rev: REV };

function read(): Look {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Look>;
    if ((saved.rev ?? 1) < REV) { saved.wallpaper = "room"; saved.rev = REV; }
    return { ...DEFAULTS, ...saved };
  } catch { return { ...DEFAULTS }; }
}

export const look = reactive<Look>(read());

// ?desktop=1 / ?desktop=0 in the address switches (handy for a kiosk link or a screenshot); remembered like the setting.
try {
  const q = new URLSearchParams(location.search).get("desktop");
  if (q === "1" || q === "0") look.layout = q === "1" ? "desktop" : "classic";
} catch { /* no URL */ }

watchEffect(() => {
  try { localStorage.setItem(KEY, JSON.stringify(look)); } catch { /* private window: not remembered */ }
  const el = document.documentElement;
  el.dataset.layout = look.layout;
  el.dataset.glass = look.solid ? "solid" : "glass";
  el.dataset.wallMotion = look.motion ? "on" : "off";
});
