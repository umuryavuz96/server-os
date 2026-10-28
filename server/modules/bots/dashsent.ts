// Prompts typed in Server OS, remembered until the bot's transcript shows them. The transcript only says "a user
// line with this text", so each send carries a client nonce: the first matching line claims it (labelled "from
// Server OS", linked to the optimistic bubble the page drew) and it can't be claimed twice. Sending the same text
// twice on purpose is two entries, so it shows twice; one send never shows twice.
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const TTL = 30 * 60_000; // a prompt queued behind a long turn can wait a while
const SKEW = 5_000; // transcript timestamps vs our clock

export interface DashClaim { nonce: string | null }
export class DashSent {
  private list = new Map<string, { text: string; nonce: string | null; at: number }[]>();
  add(ch: string, text: string, nonce: string | null, now = Date.now()) {
    const l = (this.list.get(ch) ?? []).filter((e) => now - e.at < TTL);
    l.push({ text: norm(text), nonce, at: now });
    this.list.set(ch, l.slice(-50));
  }
  /** Take the oldest unclaimed send with this text that was made before the line was written. */
  claim(ch: string, text: string, ts: number): DashClaim | null {
    const l = this.list.get(ch);
    if (!l) return null;
    const t = norm(text);
    const i = l.findIndex((e) => e.text === t && ts + SKEW >= e.at && ts - e.at < TTL);
    if (i < 0) return null;
    const [e] = l.splice(i, 1);
    return { nonce: e.nonce };
  }
}
