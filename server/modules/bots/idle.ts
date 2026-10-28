// Is the bot really working? The transcript only says a turn started; Claude Code writes nothing when a turn is
// stopped before it produced output, so the live tmux pane is the second opinion. Claude Code shows
// "esc to interrupt" in its status line for as long as a turn runs.
import type { Transcript } from "./transcript";

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
/** true = a turn is running, false = idle prompt, null = can't tell (empty pane). */
export function paneBusy(pane: string): boolean | null {
  const lines = pane.replace(ANSI, "").split("\n").map((l) => l.trimEnd()).filter(Boolean);
  if (!lines.length) return null;
  return lines.slice(-14).some((l) => /esc to interrupt/i.test(l));
}

export type Capture = () => string | null | Promise<string | null>;

/** After Escape: wait (up to `waitMs`) for the pane to go idle. Returns whether it did, and clears the transcript's
 *  "working" state when it did and the transcript hasn't caught up on its own. */
export async function settleAfterInterrupt(t: Transcript | null, capture: Capture, opts: { waitMs?: number; stepMs?: number; graceMs?: number; now?: () => number } = {}) {
  const { waitMs = 3000, stepMs = 300, graceMs = 400, now = Date.now } = opts;
  const end = now() + waitMs;
  let busy: boolean | null = true;
  for (;;) {
    busy = paneBusy((await capture()) ?? "");
    if (busy !== true || now() >= end) break;
    await Bun.sleep(stepMs);
  }
  if (busy !== false) return { stopped: false, busy, changed: [] as string[] };
  // Give Claude Code's own "[Request interrupted…" line a moment to land first; only fill in if it never does.
  t?.update();
  if (t?.meta.working) { await Bun.sleep(graceMs); t.update(); }
  const changed = t?.markStopped(now(), "Interrupted") ?? [];
  return { stopped: true, busy, changed };
}

/** Staleness guard, asked for by the UI: "working" with no transcript activity for `staleMs` and an idle pane is not working. */
export async function clearIfStale(t: Transcript | null, capture: Capture, opts: { staleMs?: number; now?: number } = {}) {
  const { staleMs = 120_000, now = Date.now() } = opts;
  const w = t?.meta.working;
  if (!t || !w) return { cleared: false, reason: "not working" };
  if (now - Math.max(t.meta.lastActivity, w.since) < staleMs) return { cleared: false, reason: "recent activity" };
  const busy = paneBusy((await capture()) ?? "");
  if (busy !== false) return { cleared: false, reason: busy === null ? "no pane" : "pane busy" };
  t.markStopped(now, null);
  return { cleared: true, reason: "idle pane" };
}
