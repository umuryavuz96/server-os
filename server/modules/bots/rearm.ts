// agmsg asks for its inbox Monitor with `persistent: true`, but Claude Code's Monitor tool has no such option and ends
// every monitor after 30 minutes ("[Monitor expired after 30m …]"). agmsg does not re-arm it, so a bot that stays up
// goes deaf to other bots. The transcript already records the expiry, so Server OS decides from that (no polling of
// the model) and sends one short turn when the bot is idle.
import type { BgJob } from "./transcript";

/** Give the bot's own turn after the expiry notice time to re-arm by itself before we step in. */
export const REARM_GRACE_MS = 90_000;
/** Don't type into a bot that just did something. */
export const REARM_IDLE_MS = 10_000;

const isWatcher = (j: BgJob) => j.kind === "monitor" && /watch\.sh/.test(j.command);

/** The expired agmsg watcher to re-arm, or null: the newest watcher must have timed out, nothing newer is running,
 *  and the bot must be idle. `done` holds job ids already handled so each expiry is answered once. */
export function expiredWatcher(jobs: Iterable<BgJob>, s: { working: unknown; lastActivity: number }, now: number, done: Set<string>): BgJob | null {
  const ws = [...jobs].filter(isWatcher).sort((a, b) => b.started - a.started);
  const j = ws[0];
  if (!j || !j.ended || j.endReason !== "timed out" || done.has(j.id)) return null;
  if (now - j.ended < REARM_GRACE_MS || s.working || now - s.lastActivity < REARM_IDLE_MS) return null;
  return j;
}

export const rearmPrompt = (j: BgJob) =>
  `Your agmsg inbox stream expired (Monitor ends after 30 minutes). Start it again now: Monitor with command ${j.command}, description "${j.name}", timeout_ms 1800000. Then reply only: ready.`;
