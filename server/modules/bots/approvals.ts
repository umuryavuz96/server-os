// Permission asks relayed to the panel: a Claude Code PermissionRequest hook (agent/hooks/permission-relay.sh) posts the
// ask and waits; the owner answers on the Bots tab, and the answer goes back to the hook as its decision. In memory only:
// an ask that nobody answers expires and the hook exits silently, so Claude Code shows its normal terminal prompt.
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { HOME } from "../../lib";

export interface Approval {
  id: string; channel: string; tool: string; summary: string; created: number; expires: number; cwd: string;
  input: Record<string, unknown>;
  /** Claude Code's first suggested permission update, applied by "Always allow". */
  suggestion: Record<string, unknown> | null;
}
export type Decision = { behavior: "allow"; always?: boolean } | { behavior: "deny"; message?: string };
export const WAIT_MS = 10 * 60_000;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
const one = (v: unknown, n = 160) => clip(String(v ?? "").replace(/\s+/g, " ").trim(), n);
const tilde = (p: string) => p.replace(HOME, "~");

/** A short readable line for what the tool wants to do. */
export function summarize(tool: string, input: Record<string, unknown>): string {
  const i = input ?? {};
  if (tool === "Bash") return one(i.command);
  if (["Edit", "Write", "MultiEdit", "Read", "NotebookEdit"].includes(tool)) return tilde(one(i.file_path ?? i.notebook_path));
  if (tool === "WebFetch") return one(i.url);
  if (tool === "WebSearch") return one(i.query);
  if (tool === "Glob" || tool === "Grep") return one(i.pattern);
  const first = Object.values(i).find((v) => typeof v === "string") ?? "";
  return one(first);
}

/** Keep the stored input small: long strings are clipped (the panel shows them in an expandable block). */
export function trimInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  return Object.fromEntries(Object.entries(input as object).slice(0, 12).map(([k, v]) => [k, typeof v === "string" ? clip(v, 4000) : clip(JSON.stringify(v) ?? "", 2000)]));
}

interface BotRef { channel: string; cwd: string; pid: number | null; running: boolean }
/** Which bot asked: its live session id, else its folder, else its Telegram state folder (<dir>/<channel>/telegram, or ~/.claude/channels/<channel>). */
export function resolveChannel(bots: BotRef[], p: { sessionId?: string; cwd?: string; stateDir?: string }, sessionOf = defaultSessionOf): string | null {
  const live = bots.filter((b) => b.running);
  if (p.sessionId) { const b = live.find((x) => x.pid && sessionOf(x.pid) === p.sessionId); if (b) return b.channel; }
  const same = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
  if (p.cwd) { const b = live.find((x) => same(x.cwd.replace(/^~(?=\/|$)/, HOME), p.cwd!)); if (b) return b.channel; }
  if (p.stateDir) {
    const parts = p.stateDir.replace(/\/+$/, "").split("/");
    const name = parts[parts.length - 1] === "telegram" && parts[parts.length - 2] !== "channels" ? parts[parts.length - 2] : basename(p.stateDir);
    const b = live.find((x) => x.channel === name);
    if (b) return b.channel;
  }
  return null;
}
function defaultSessionOf(pid: number): string | null {
  try { return (JSON.parse(readFileSync(join(HOME, ".claude", "sessions", `${pid}.json`), "utf8")) as { sessionId?: string }).sessionId ?? null; } catch { return null; }
}

/** What the hook prints for a decision (Claude Code PermissionRequest contract). */
export function hookOutput(a: Approval, d: Decision) {
  const decision = d.behavior === "allow"
    ? { behavior: "allow", ...(d.always && a.suggestion ? { updatedPermissions: [a.suggestion] } : {}) }
    : { behavior: "deny", message: d.message?.trim() || "The owner denied this from the Server OS panel." };
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision } };
}

export class Approvals {
  private m = new Map<string, { a: Approval; done: (d: Decision | null) => void; timer: ReturnType<typeof setTimeout> }>();
  private pinged = new Map<string, number>();
  constructor(private onChange: () => void = () => {}, private ping: (text: string) => void = () => {}) {}

  /** Adds an ask; the promise settles with the owner's decision, or null when it expired or was withdrawn. */
  add(a: Approval): Promise<Decision | null> {
    return new Promise((done) => {
      const timer = setTimeout(() => this.settle(a.id, null), Math.max(0, a.expires - Date.now()));
      this.m.set(a.id, { a, done, timer });
      this.onChange();
      this.notify(a);
    });
  }
  private settle(id: string, d: Decision | null) {
    const e = this.m.get(id); if (!e) return false;
    clearTimeout(e.timer); this.m.delete(id); e.done(d); this.onChange(); return true;
  }
  decide(id: string, d: Decision) { return this.settle(id, d); }
  /** The hook went away (answered in the terminal, or timed out): drop the ask. */
  withdraw(id: string) { return this.settle(id, null); }
  get(id: string) { return this.m.get(id)?.a ?? null; }
  pending(channel?: string) { return [...this.m.values()].map((e) => e.a).filter((a) => !channel || a.channel === channel).sort((x, y) => x.created - y.created); }
  counts() { const o: Record<string, number> = {}; for (const a of this.pending()) o[a.channel] = (o[a.channel] ?? 0) + 1; return o; }

  /** One Telegram ping per distinct ask per minute, and at most one per bot every 15 s. */
  private notify(a: Approval, now = Date.now()) {
    for (const [k, t] of this.pinged) if (now - t > 60_000) this.pinged.delete(k);
    const key = `${a.channel}|${a.tool}|${a.summary}`;
    if (this.pinged.has(key) || now - (this.pinged.get(`bot|${a.channel}`) ?? 0) < 15_000) return;
    this.pinged.set(key, now); this.pinged.set(`bot|${a.channel}`, now);
    this.ping(`🔐 ${a.channel === "telegram" ? "main" : a.channel} asks: ${a.tool} ${clip(a.summary, 120)} — answer in Server Dash Bots tab`);
  }
}
