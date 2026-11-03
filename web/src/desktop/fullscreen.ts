// Fullscreen for the desktop: the Fullscreen API needs a user gesture (a click or a key), so the menu bar button and
// the F key call toggle(). iPhone Safari has no element fullscreen: there the page is added to the home screen
// (manifest + apple-mobile-web-app-capable) and opens without browser chrome instead.
import { ref } from "vue";

type Doc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> };
type El = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
const d = document as Doc;

export const canFullscreen = !!(document.documentElement.requestFullscreen || (document.documentElement as El).webkitRequestFullscreen);
export const isFull = ref(false);
/** Opened from the home screen / an installed app: already without browser chrome. */
export const standalone = typeof matchMedia === "function" && (matchMedia("(display-mode: fullscreen)").matches || matchMedia("(display-mode: standalone)").matches);

const sync = () => { isFull.value = !!(d.fullscreenElement ?? d.webkitFullscreenElement); };
document.addEventListener("fullscreenchange", sync);
document.addEventListener("webkitfullscreenchange", sync);

export async function toggleFullscreen() {
  try {
    if (d.fullscreenElement ?? d.webkitFullscreenElement) await (d.exitFullscreen?.() ?? d.webkitExitFullscreen?.());
    else {
      const el = document.documentElement as El;
      await (el.requestFullscreen?.({ navigationUI: "hide" }) ?? el.webkitRequestFullscreen?.());
    }
  } catch { /* refused (no gesture, iframe without allowfullscreen): stay as we are */ }
  sync();
}
