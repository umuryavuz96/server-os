// macOS privacy permissions / Linux access needs: shared by the Permissions page, the sidebar badge, the Overview banner
// and the Fix session (the Mac screen modal with the grant steps).
import { computed, reactive } from "vue";
import { api, toast } from "./store";
import { closeScreen, openScreen, sess } from "./screen/session";
import type { Outcome } from "./permGuide";

export interface Perm {
  id: string; title: string; why: string; features: string[]; required: boolean; needed: boolean;
  status: "granted" | "missing" | "unknown" | "not-needed"; detail: string; active: boolean;
  /** "dialog": macOS shows an Allow popup the server can trigger. "settings": only a switch in System Settings. */
  how?: "dialog" | "settings" | "";
  processes: { role: string; path: string }[]; settingsUrl: string; fix: string[];
  /** The exact entries to switch on under the program (folder names, volume names, the app to control). */
  targets?: string[];
}
interface Reply { platform: string; permissions: Perm[]; missingRequired: string[]; permission?: Perm | null }

export const P = reactive({
  list: [] as Perm[], loaded: false, busy: "", platform: "",
  /** The permission being fixed right now (popup or Settings opened); `done` shows the green tick for a moment. */
  fixing: null as null | { id: string; done: boolean },
  /** The Permissions page is open: it re-reads the missing ones. */
  viewing: false,
  /** What the last Fix did per permission: the strip and the cards word their steps from it. */
  outcome: {} as Record<string, Outcome>,
});
export const missingRequired = computed(() => P.list.filter((p) => p.required && p.status === "missing"));

export async function loadPerms() {
  try { const r = await api<Reply>("/permissions"); P.list = r.permissions; P.platform = r.platform; } catch { /* older server: no page */ }
  P.loaded = true;
}
function apply(perm: Perm) {
  const i = P.list.findIndex((p) => p.id === perm.id);
  if (i >= 0) P.list[i] = perm;
}
/** Active probe for one permission: macOS may show its allow popup on the server's screen. */
export async function recheck(id: string) {
  P.busy = id;
  try {
    const r = await api<Reply>(`/permissions/${id}/check`, { method: "POST", body: {} });
    if (r.permission) apply(r.permission);
  } catch (e) { toast((e as Error).message); }
  P.busy = "";
}
/** Trigger the popup where macOS has one, else open the Settings pane. `pane` forces the pane (the popup comes only once). */
export async function openSettings(id: string, pane = false): Promise<"prompt" | "pane" | "granted" | ""> {
  try {
    const r = await api<{ did?: "prompt" | "pane" | "granted"; denied?: boolean }>(`/permissions/${id}/open`, { method: "POST", body: { pane } });
    toast(r.did === "prompt" ? "Click Allow on the Mac screen"
      : r.did === "granted" ? "Already allowed: macOS has nothing to ask"
      : r.denied ? "macOS was told no before and won't ask again: switch it on in System Settings (now open)"
      : "Opened System Settings on the server's Mac");
    P.outcome[id] = r.did ?? "pane";
    return r.did ?? "pane";
  } catch (e) { toast((e as Error).message); return ""; }
}

// ---- live status ---------------------------------------------------------------------------------------------------
// While a Fix session or the page is open, re-check every 2 s. Only permissions that are already known missing (macOS has
// decided, so a probe raises nothing new) plus the one being fixed. "Not checked" ones are never probed from here.
const EVERY = 2000, CLOSE_AFTER = 1500;
let timer: ReturnType<typeof setInterval> | null = null, ticking = false;
const wanted = () => (P.platform !== "linux" && (P.viewing || !!P.fixing)) && !!P.list.length;

async function tick() {
  if (ticking || (typeof document !== "undefined" && document.hidden)) return;
  ticking = true;
  try {
    const ids = new Set(P.list.filter((p) => p.needed && p.status === "missing").map((p) => p.id));
    if (P.fixing && !P.fixing.done) ids.add(P.fixing.id);
    for (const id of ids) {
      const before = P.list.find((p) => p.id === id)?.status;
      let r: Reply;
      try { r = await api<Reply>(`/permissions/${id}/check`, { method: "POST", body: {} }); } catch { continue; }
      if (r.permission) apply(r.permission);
      if (r.permission?.status === "granted" && before !== "granted") granted(id);
    }
  } finally { ticking = false; }
}
function granted(id: string) {
  const f = P.fixing;
  if (!f || f.id !== id || f.done) return;
  f.done = true;
  scheduleClose(id);
}
function scheduleClose(id: string) {
  setTimeout(() => {
    if (sess.perm === id && sess.ui !== "closed") closeScreen();
    if (P.fixing?.id === id) P.fixing = null;
    sync();
  }, CLOSE_AFTER);
}
/** Start or stop the 2 s timer to match whether anything needs it. */
export function sync() {
  if (wanted() && !timer) { timer = setInterval(() => void tick(), EVERY); void tick(); }
  else if (!wanted() && timer) { clearInterval(timer); timer = null; }
}
export function watchPage(on: boolean) { P.viewing = on; sync(); }

/** Fix button: popup or pane first, then (with a remote screen) the Mac screen modal showing the steps. */
export async function startFix(p: Perm, remote: boolean) {
  P.fixing = { id: p.id, done: false };
  P.outcome[p.id] = "";
  const did = await openSettings(p.id);
  sync();
  if (did === "granted") {
    // macOS has nothing to ask: say so on the Mac screen for a moment, then close it.
    if (!remote) { await recheck(p.id); P.fixing = null; sync(); return; }
    openScreen({ title: `Fix: ${p.title}`, perm: p.id, onClose: () => { if (P.fixing?.id === p.id) P.fixing = null; sync(); void recheck(p.id); } });
    if (P.fixing) P.fixing.done = true;
    void recheck(p.id); scheduleClose(p.id); return;
  }
  if (remote) openScreen({ title: `Fix: ${p.title}`, perm: p.id, onClose: () => { if (P.fixing?.id === p.id) P.fixing = null; sync(); void recheck(p.id); } });
}
