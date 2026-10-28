// Bot sessions, read straight from Claude Code's own transcript (~/.claude/projects/<cwd>/<session>.jsonl).
// One parser per session file turns its lines into a chat feed with stable ids (messages, the tool steps between
// them, background notices), the session's background jobs (Monitor, background shells, async agents), the cron
// jobs it scheduled, and the state of "background job" requests sent from Server OS. The file is followed by
// byte offset, so a change re-parses only the new lines and subscribers get just the items that changed.
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { HOME, run } from "../../lib";
import { dir } from "../../core/config";

export type Via = "telegram" | "dash" | "terminal";
export interface FeedItem {
  id: string; kind: "user" | "assistant" | "step" | "event"; ts: number;
  text?: string; via?: Via; from?: string; nonce?: string;
  tool?: string; title?: string; detail?: string; status?: "running" | "ok" | "error"; ms?: number; out?: string;
}
export interface BgJob {
  id: string; taskId: string | null; kind: "monitor" | "shell" | "agent"; name: string; command: string;
  started: number; ended: number | null; endReason: string | null; events: number; lastEvent: string | null; lastEventAt: number | null;
  timeoutMs: number | null; rearms: number; request: string | null;
}
export interface Schedule { id: string; cronId: string | null; cron: string; prompt: string; recurring: boolean; created: number; deleted: boolean; request: string | null }
export interface SessionMeta {
  session: string; model: string | null; contextTokens: number; contextLimit: number; permissionMode: string | null;
  working: { since: number; step: string | null } | null; lastActivity: number; effort: string | null;
}

const MAX_TEXT = 20_000;
const INTERRUPT_RE = /^\s*\[Request interrupted/;
const REQ_RE = /\bsd-[0-9a-f]{4,8}\b/;
const FAIL_RE = /SD-FAILED\s+(sd-[0-9a-f]{4,8})\s*:?\s*([^\n]*)/;
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const tag = (s: string, t: string) => s.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`))?.[1]?.trim() ?? null;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

/** Friendly name for a tool: "Shell", "Telegram · reply", "Chrome · navigate", "finnhub · calendar_data". */
export function toolName(name: string) {
  if (name === "Bash") return "Shell";
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  if (!m) return name;
  let server = m[1].replace(/^plugin_[^_]+_/, "").replace(/^claude_ai_/, "");
  if (server === "claude-in-chrome") server = "Chrome";
  if (server === "telegram") server = "Telegram";
  return `${server} · ${m[2].replace(/_mcp$/, "")}`;
}

/** One-line title + detail for a tool call. */
export function describeStep(name: string, input: Record<string, unknown>): { title: string; detail: string } {
  const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
  const desc = s("description");
  switch (name) {
    case "Bash": return { title: desc || "Ran a command", detail: s("command") };
    case "Monitor": return { title: `Monitor · ${desc || "watch"}`, detail: s("command") };
    case "Read": return { title: `Read ${base(s("file_path"))}`, detail: s("file_path") };
    case "Write": return { title: `Wrote ${base(s("file_path"))}`, detail: s("file_path") };
    case "Edit": return { title: `Edited ${base(s("file_path"))}`, detail: s("file_path") };
    case "Grep": return { title: `Searched for “${clip(s("pattern"), 40)}”`, detail: s("path") };
    case "Glob": return { title: "Listed files", detail: s("pattern") };
    case "WebFetch": return { title: "Fetched a page", detail: s("url") };
    case "WebSearch": return { title: `Searched the web`, detail: s("query") };
    case "Agent": case "Task": return { title: `Sub-agent · ${desc || "task"}`, detail: s("subagent_type") };
    case "Skill": return { title: `Skill · ${s("skill")}`, detail: s("args") };
    case "ToolSearch": return { title: "Loaded tools", detail: s("query") };
    case "TaskStop": return { title: "Stopped a background job", detail: s("task_id") || s("shell_id") };
    case "CronCreate": return { title: "Scheduled a job", detail: `${s("cron")} · ${clip(s("prompt"), 120)}` };
    case "CronDelete": return { title: "Cancelled a scheduled job", detail: s("id") };
  }
  const t = toolName(name);
  if (/telegram/i.test(name) && name.endsWith("reply")) return { title: "Telegram · replied", detail: clip(s("text").replace(/\s+/g, " "), 140) };
  const first = Object.entries(input).find(([, v]) => typeof v === "string" && v.length < 200);
  return { title: t, detail: desc || (first ? `${first[0]}: ${first[1]}` : "") };
}

function contentText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : "")).join("\n");
  return "";
}

export class Transcript {
  items: FeedItem[] = [];
  private index = new Map<string, number>();
  jobs = new Map<string, BgJob>();
  schedules = new Map<string, Schedule>();
  failures = new Map<string, string>(); // request id → bot's reason
  meta: SessionMeta;
  private offset = 0;
  private rest = "";
  private stepAt = new Map<string, number>();
  private taskToJob = new Map<string, string>();
  private changed = new Set<string>();
  private seq = 0;
  private rev = new Map<string, number>();
  private claimDash: (text: string, ts: number) => { nonce: string | null } | null;

  /** `claimDash`: is this user line a prompt that was typed in Server OS? (see dashsent.ts) */
  constructor(public path: string, claimDash: (text: string, ts: number) => { nonce: string | null } | null = () => null) {
    this.claimDash = claimDash;
    this.meta = { session: path.split("/").pop()!.replace(/\.jsonl$/, ""), model: null, contextTokens: 0, contextLimit: 200_000, permissionMode: null, working: null, lastActivity: 0, effort: null };
  }

  /** Read whatever was appended since last time. Returns the ids of feed items that are new or changed. */
  update(): string[] {
    let size = 0;
    try { size = statSync(this.path).size; } catch { return []; }
    if (size < this.offset) { this.offset = 0; this.rest = ""; } // rewritten: start over
    if (size === this.offset) return this.flush();
    const fd = openSync(this.path, "r");
    const buf = Buffer.alloc(size - this.offset);
    try { readSync(fd, buf, 0, buf.length, this.offset); } finally { closeSync(fd); }
    this.offset = size;
    const text = this.rest + buf.toString("utf8");
    const lines = text.split("\n");
    this.rest = lines.pop() ?? "";
    for (const l of lines) if (l.trim()) this.line(l);
    return this.flush();
  }

  private flush() { const out = [...this.changed]; this.changed.clear(); return out; }

  /** The turn is over although the transcript never said so (Claude Code writes nothing when a turn is stopped before
   *  it produced output). Closes the running steps, clears "working" and, for a real interrupt, adds the event.
   *  The changed ids are delivered by the next update(). No-op when nothing was working. */
  markStopped(ts: number, event: string | null): string[] {
    if (!this.meta.working) return [];
    this.meta.working = null;
    this.closeSteps();
    if (event) this.put({ id: `stopped:${ts}`, kind: "event", ts, text: event });
    return [...this.changed];
  }

  /** Steps still "running" when a turn ends early will never get a tool_result. */
  private closeSteps() {
    for (const it of this.items) if (it.kind === "step" && it.status === "running") this.put({ ...it, status: "error", out: it.out ?? "Interrupted", ms: Math.max(0, (this.meta.lastActivity || it.ts) - it.ts) });
  }

  private interrupted(uuid: string, ts: number) {
    this.closeSteps();
    this.meta.working = null;
    // markStopped() may have written the event a moment before Claude Code's own line landed: keep one.
    let mine = false;
    for (let k = this.items.length - 1; k >= 0; k--) {
      const i = this.items[k];
      if (i.kind === "user") break;
      if (i.kind === "event" && i.id.startsWith("stopped:") && Math.abs(i.ts - ts) < 30_000) { mine = true; break; }
    }
    if (!mine) this.put({ id: uuid, kind: "event", ts, text: "Interrupted" });
  }

  get(id: string) { const i = this.index.get(id); return i === undefined ? undefined : this.items[i]; }

  private put(item: FeedItem) {
    const i = this.index.get(item.id);
    if (i === undefined) { this.index.set(item.id, this.items.length); this.items.push(item); }
    else this.items[i] = item;
    this.changed.add(item.id);
    this.rev.set(item.id, ++this.seq);
  }

  /** Ids changed after `cursor`, for ONE reader. update() hands its ids to whoever calls it first, and the feed, the
   *  snapshot and the re-arm watcher share this parser, so a feed that relied on update() lost items to the others
   *  (a tool step stuck on "running"). Each reader keeps its own cursor instead. */
  changedSince(cursor: number): { ids: string[]; cursor: number } {
    const ids = [...this.rev].filter(([, n]) => n > cursor).sort((a, b) => a[1] - b[1]).map(([id]) => id);
    return { ids, cursor: this.seq };
  }
  get cursor() { return this.seq; }

  private line(l: string) {
    let o: Record<string, unknown>;
    try { o = JSON.parse(l); } catch { return; }
    const ts = Date.parse(String(o.timestamp ?? "")) || 0;
    const type = o.type as string;
    if (type === "permission-mode") { this.meta.permissionMode = String(o.permissionMode ?? ""); return; }
    if (type === "system" && o.subtype === "turn_duration") { this.meta.working = null; return; }
    // Compaction (manual or idle) writes a boundary and a summary "user" line but no turn_duration, so it ends any turn
    // and must not start one: an idle compaction otherwise shows the bot as working for hours.
    if (type === "system" && o.subtype === "compact_boundary") { this.meta.working = null; this.put({ id: String(o.uuid ?? ts), kind: "event", ts, text: "Compacted" }); return; }
    if (o.isCompactSummary) return;
    if (o.isSidechain) return;
    // A message that arrived mid-turn (Telegram, a background notice) is stored as a queued_command attachment.
    if (type === "attachment") {
      const a = (o.attachment ?? {}) as { type?: string; prompt?: unknown };
      if (a.type === "queued_command" && typeof a.prompt === "string") this.userText(a.prompt, String(o.uuid ?? ts), ts);
      return;
    }
    // Escape writes a user line "[Request interrupted by user]" (or "… for tool use"): a text block in an array, or a plain
    // string; seen without isMeta, but accepted with it too. Sub-agent lines were dropped above.
    if (type === "user" && o.isMeta && this.isInterrupt((o.message as { content?: unknown } | undefined)?.content)) { this.interrupted(String(o.uuid ?? ts), ts); return; }
    // Channel messages (Telegram) are marked meta; every other meta line is Claude Code's own context.
    if (o.isMeta && (o.origin as { kind?: string } | undefined)?.kind !== "channel") return;
    if (type !== "user" && type !== "assistant") return;
    const m = (o.message ?? {}) as { role?: string; content?: unknown; model?: string; usage?: Record<string, number> };
    const uuid = String(o.uuid ?? `${ts}-${this.items.length}`);
    if (ts) this.meta.lastActivity = Math.max(this.meta.lastActivity, ts);
    if (type === "assistant") return this.assistant(m, uuid, ts);
    this.user(m.content, uuid, ts);
  }

  private assistant(m: { content?: unknown; model?: string; usage?: Record<string, number> }, uuid: string, ts: number) {
    if (m.model && m.model !== "<synthetic>") this.meta.model = m.model;
    const u = m.usage;
    if (u) {
      const used = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      if (used) { this.meta.contextTokens = used; if (used > 200_000 || /\[1m\]/.test(m.model ?? "")) this.meta.contextLimit = 1_000_000; }
    }
    if (!Array.isArray(m.content)) return;
    m.content.forEach((b: Record<string, unknown>, k: number) => {
      if (b.type === "text") {
        const text = String(b.text ?? "").trim();
        if (!text || text === "No response requested.") return;
        this.put({ id: `${uuid}:${k}`, kind: "assistant", ts, text: clip(text, MAX_TEXT), via: "terminal" });
        this.scanFailure(text);
      } else if (b.type === "tool_use") this.toolUse(b, ts);
    });
  }

  private toolUse(b: Record<string, unknown>, ts: number) {
    const id = String(b.id), name = String(b.name), input = (b.input ?? {}) as Record<string, unknown>;
    const { title, detail } = describeStep(name, input);
    this.put({ id, kind: "step", ts, tool: toolName(name), title, detail: clip(detail, 400), status: "running" });
    this.stepAt.set(id, ts);
    this.meta.working = { since: this.meta.working?.since ?? ts, step: title };
    const raw = JSON.stringify(input);
    const request = raw.match(REQ_RE)?.[0] ?? null;
    if (/telegram/i.test(name) && name.endsWith("reply") && typeof input.text === "string") {
      this.put({ id: `${id}:msg`, kind: "assistant", ts, text: clip(input.text, MAX_TEXT), via: "telegram" });
      this.scanFailure(input.text);
    }
    const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
    const job = (kind: BgJob["kind"], jname: string, command: string) => {
      const same = [...this.jobs.values()].filter((j) => j.kind === kind && j.name === jname && j.command === command && ts - j.started < 86_400_000);
      this.jobs.set(id, { id, taskId: null, kind, name: jname, command, started: ts, ended: null, endReason: null, events: 0, lastEvent: null, lastEventAt: null,
        timeoutMs: typeof input.timeout_ms === "number" ? input.timeout_ms : null, rearms: same.length, request });
      for (const j of same) if (!j.ended) { j.ended = ts; j.endReason = "replaced"; }
    };
    if (name === "Monitor") job("monitor", str("description") || "Monitor", str("command"));
    else if (name === "Bash" && input.run_in_background) job("shell", str("description") || "Background command", str("command"));
    else if ((name === "Agent" || name === "Task") && input.run_in_background !== false && /agent/i.test(name)) job("agent", str("description") || "Sub-agent", str("subagent_type") || "general-purpose");
    else if (name === "TaskStop") this.endTask(str("task_id") || str("shell_id"), ts, "stopped");
    else if (name === "CronCreate") this.schedules.set(id, { id, cronId: null, cron: str("cron"), prompt: str("prompt"), recurring: input.recurring !== false, created: ts, deleted: false, request });
    else if (name === "CronDelete") { for (const s of this.schedules.values()) if (s.cronId === str("id")) s.deleted = true; }
  }

  private isInterrupt(content: unknown) {
    if (typeof content === "string") return INTERRUPT_RE.test(content);
    return Array.isArray(content) && content.some((b) => b && (b as { type?: string }).type === "text" && INTERRUPT_RE.test(String((b as { text?: unknown }).text ?? "")));
  }

  private user(content: unknown, uuid: string, ts: number) {
    if (Array.isArray(content)) {
      let text = "";
      let n = 0;
      for (const b of content as Record<string, unknown>[]) {
        if (b.type === "tool_result") this.toolResult(b, ts);
        else if (b.type === "text") {
          const t = String(b.text ?? "");
          if (INTERRUPT_RE.test(t)) this.interrupted(`${uuid}:int${n++}`, ts); // the marker can share a message with text
          else text += t;
        }
      }
      if (text.trim()) this.userText(text, uuid, ts);
      return;
    }
    if (typeof content === "string") this.userText(content, uuid, ts);
  }

  private userText(raw: string, uuid: string, ts: number) {
    const s = raw.trim();
    if (!s || s.startsWith("<system-reminder>") || s.startsWith("<local-command-caveat>")) return;
    if (s.includes("<task-notification>")) return this.notification(s, uuid, ts);
    const cmd = tag(s, "command-name");
    if (cmd) { this.put({ id: uuid, kind: "event", ts, text: `Ran ${cmd} ${tag(s, "command-args") ?? ""}`.trim() }); return; }
    const out = tag(s, "local-command-stdout");
    if (out !== null) {
      const o = strip(out);
      const model = o.match(/Set model to\s+(.+)/)?.[1]?.trim(); if (model) this.meta.model = model;
      const effort = o.match(/effort level to\s+(\w+)/i)?.[1]; if (effort) this.meta.effort = effort.toLowerCase();
      if (o) this.put({ id: uuid, kind: "event", ts, text: clip(o, 300) });
      return;
    }
    if (INTERRUPT_RE.test(s)) return this.interrupted(uuid, ts);
    const ch = s.match(/<channel\s+([^>]*)>([\s\S]*?)<\/channel>/);
    this.meta.working = { since: ts, step: null };
    if (ch) {
      const attrs = Object.fromEntries([...ch[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
      const source = attrs.source ?? "";
      this.put({ id: uuid, kind: "user", ts, text: clip(ch[2].trim(), MAX_TEXT), via: /telegram/.test(source) ? "telegram" : "terminal", from: [attrs.user_name, attrs.username, attrs.user].find((u) => u && !/^\d+$/.test(u)) });
      return;
    }
    const mine = this.claimDash(s, ts);
    this.put({ id: uuid, kind: "user", ts, text: clip(s, MAX_TEXT), via: mine || s.startsWith("[Server OS") || s.startsWith("[Server Dash") ? "dash" : "terminal", ...(mine?.nonce ? { nonce: mine.nonce } : {}) });
  }

  private notification(s: string, uuid: string, ts: number) {
    const taskId = tag(s, "task-id");
    const summary = tag(s, "summary") ?? "";
    const event = tag(s, "event");
    const status = tag(s, "status");
    const jobId = taskId ? this.taskToJob.get(taskId) : undefined;
    const job = jobId ? this.jobs.get(jobId) : undefined;
    if (job) {
      if (event && !/^\[Monitor expired/.test(event)) { job.events++; job.lastEvent = clip(event, 300); job.lastEventAt = ts; }
      if (event && /^\[Monitor expired/.test(event)) { job.ended = ts; job.endReason = "timed out"; }
      if (status && /completed|failed|killed|stopped/.test(status)) { job.ended = job.ended ?? ts; job.endReason = job.endReason ?? status; }
    }
    const what = event ? `${summary.replace(/^Monitor event:\s*/, "")} · ${clip(strip(event).replace(/\s+/g, " "), 200)}` : summary || "Background job update";
    this.put({ id: uuid, kind: "event", ts, text: what });
  }

  private toolResult(b: Record<string, unknown>, ts: number) {
    const id = String(b.tool_use_id ?? "");
    const step = this.get(id);
    const text = strip(contentText(b.content));
    if (step) {
      const t0 = this.stepAt.get(id) ?? ts;
      this.put({ ...step, status: b.is_error ? "error" : "ok", ms: Math.max(0, ts - t0), out: clip(text.trim(), 600) });
    }
    const job = this.jobs.get(id);
    if (job) {
      const t = text.match(/Monitor started \(task ([a-z0-9]+)/) ?? text.match(/background with ID:\s*([a-z0-9]+)/) ?? text.match(/agentId:\s*([a-z0-9]+)/);
      if (t) { job.taskId = t[1]; this.taskToJob.set(t[1], id); }
      if (b.is_error || !t) { job.ended = ts; job.endReason = b.is_error ? "failed to start" : "finished"; }
    }
    const sch = this.schedules.get(id);
    if (sch) { const c = text.match(/job ([0-9a-f]{6,})/); if (c) sch.cronId = c[1]; if (b.is_error) sch.deleted = true; }
  }

  private endTask(taskId: string, ts: number, why: string) {
    const j = this.jobs.get(this.taskToJob.get(taskId) ?? "");
    if (j && !j.ended) { j.ended = ts; j.endReason = why; }
  }

  private scanFailure(text: string) {
    const f = text.match(FAIL_RE);
    if (f) this.failures.set(f[1], f[2].trim() || "The bot couldn't set it up");
  }
}

// ---------- locating a bot's live transcript ----------
export const projectDir = (cwd: string) => join(HOME, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
export function latestTranscript(cwd: string): string | null {
  const d = projectDir(cwd);
  if (!existsSync(d)) return null;
  let best: string | null = null, bestT = 0;
  for (const f of readdirSync(d)) {
    if (!f.endsWith(".jsonl")) continue;
    const t = statSync(join(d, f)).mtimeMs;
    if (t > bestT) { bestT = t; best = join(d, f); }
  }
  return best;
}

// ---------- requests: background jobs asked for from Server OS ----------
export interface BotRequest {
  id: string; channel: string; kind: "watch" | "schedule" | "task"; name: string; what: string;
  options: { source?: string; every?: string; repeat?: string; at?: string; model?: string; until?: string; telegram?: boolean; quiet?: boolean };
  created: number;
}
const reqFile = () => join(dir("data"), "bot-requests.json");
export function readRequests(): BotRequest[] {
  try { return JSON.parse(readFileSync(reqFile(), "utf8")); } catch { return []; }
}
export function writeRequests(list: BotRequest[]) { mkdirSync(dir("data"), { recursive: true }); writeFileSync(reqFile(), JSON.stringify(list, null, 1)); }

/** The instructions a request becomes — plain words for the bot, with the id it must carry so we can follow it. */
export function requestPrompt(r: BotRequest) {
  const o = r.options;
  const how = r.kind === "watch" ? `Start a background watch (Monitor tool, or a background shell)${o.source ? ` on: ${o.source}` : ""}${o.every ? `, checking ${o.every === "Live" ? "live" : `every ${o.every}`}` : ""}.`
    : r.kind === "schedule" ? `Schedule it with CronCreate: ${o.repeat ?? "every day"}${o.at ? ` at ${o.at}` : ""}.`
    : `Run it as a background sub-agent (Agent tool, run_in_background)${o.model ? ` on ${o.model}` : ""}.`;
  return [
    `[Server OS · request ${r.id}] Please set up a background job.`,
    `Name: ${r.name}`,
    `Task: ${r.what}`,
    how,
    o.until ? `Stop: ${o.until}.` : "",
    o.telegram ? "Tell the owner on Telegram when it finds something." : "Don't message anyone unless asked.",
    o.quiet ? "Keep it quiet: when a watch times out with nothing found, re-arm it without reporting." : "",
    `Put "${r.id}" in the job's description so Server OS can follow it. If you can't set it up, reply with one line: SD-FAILED ${r.id}: <reason>`,
  ].filter(Boolean).join("\n");
}
export const newRequestId = () => "sd-" + Buffer.from(crypto.getRandomValues(new Uint8Array(2))).toString("hex");

export type RequestState = { id: string; status: "pending" | "running" | "failed"; reason: string | null; job: string | null };
export function requestStates(t: Transcript | null, list: BotRequest[]): RequestState[] {
  return list.map((r) => {
    const job = t ? [...t.jobs.values(), ...t.schedules.values()].find((j) => j.request === r.id) : undefined;
    const reason = t?.failures.get(r.id) ?? null;
    return { id: r.id, status: job ? "running" : reason ? "failed" : "pending", reason, job: job?.id ?? null };
  });
}

// ---------- stopping a background job's process ----------
/** Stop the shell Claude Code started for a background job: a direct child of the bot's claude process, in its own
 *  process group, whose command line carries the job's command. Never anything else (the Telegram MCP is a child too). */
export async function killJobProcess(botPid: number, command: string): Promise<boolean> {
  const r = await run(["ps", "-axo", "pid=,ppid=,pgid=,command="], 5000);
  const needle = command.trim().slice(0, 120);
  if (!needle) return false;
  for (const line of r.out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const [pid, ppid, pgid, cmd] = [Number(m[1]), Number(m[2]), Number(m[3]), m[4]];
    if (ppid !== botPid || pgid !== pid || !cmd.includes("shell-snapshots") || !cmd.includes(needle)) continue;
    try { process.kill(-pgid, "SIGTERM"); return true; } catch { return false; }
  }
  return false;
}
