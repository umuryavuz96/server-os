// Bot workspace API: the live chat feed of a bot's Claude Code session (SSE, only changed items), its background
// jobs and schedules, model/effort switching, interrupt, and background-job requests that the bot carries out.
// Bot processes are run by Claude OS (:3090) or, without it, natively by Server OS (modules/bots/native.ts).
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { HOME, log, run } from "./lib";
import { getState } from "./store";
import { config, dir } from "./core/config";
import { audit } from "./core/logger";
import { problem, type Env } from "./core/http";
import { readAgentLog } from "./modules/bots/agentLog";
import {
  Transcript, latestTranscript, expiredWatcher, rearmPrompt, projectDir, readRequests, writeRequests, requestPrompt, requestStates, newRequestId, killJobProcess, DashSent, settleAfterInterrupt, clearIfStale,
  type BgJob, type BotRequest, type FeedItem, type NativeBots,
} from "./modules/bots";

interface BotInfo { channel: string; cwd: string; pid: number | null; running: boolean; protected: boolean; model: string }
const bot = (ch: string) => ((getState().botSessions ?? []) as unknown as BotInfo[]).find((b) => b.channel === ch) ?? null;

/** The transcript a running bot writes: its pid's session file (~/.claude/sessions/<pid>.json), else the newest in its folder. */
function transcriptPath(b: BotInfo): string | null {
  if (b.running && b.pid) {
    try {
      const s = JSON.parse(readFileSync(join(HOME, ".claude", "sessions", `${b.pid}.json`), "utf8")) as { sessionId?: string; cwd?: string };
      const p = join(projectDir(s.cwd ?? b.cwd), `${s.sessionId}.jsonl`);
      if (s.sessionId && existsSync(p)) return p;
    } catch { /* fall through */ }
  }
  return latestTranscript(b.cwd);
}

// ---------- shared parsers, one per session file ----------
const sentFromDash = new DashSent(); // prompts typed in Server OS, claimed by the transcript line they become
const parsers = new Map<string, Transcript>();
function parser(path: string, ch: string) {
  let t = parsers.get(path);
  if (!t) {
    t = new Transcript(path, (text, ts) => sentFromDash.claim(ch, text, ts));
    t.update();
    parsers.set(path, t);
    if (parsers.size > 12) parsers.delete(parsers.keys().next().value!); // forget the oldest
  }
  return t;
}

// ---------- agmsg watcher: Claude Code ends a Monitor after 30 minutes, nothing re-arms it ----------
const rearmed = new Set<string>();
/** Run every 30 s: reads transcripts only; types one turn into a bot whose agmsg Monitor expired and that is idle. */
export async function rearmWatchers(nat: NativeBots) {
  for (const b of (getState().botSessions ?? []) as unknown as BotInfo[]) {
    if (!b.running || !nat.get(b.channel)) continue;
    const path = transcriptPath(b);
    if (!path) continue;
    const t = parser(path, b.channel);
    t.update();
    const j = expiredWatcher(t.jobs.values(), t.meta, Date.now(), rearmed);
    if (!j) continue;
    rearmed.add(j.id);
    log(`agmsg monitor expired, re-arming ${b.channel}`);
    await nat.send(b.channel, rearmPrompt(j));
  }
}

// ---------- effort: Claude Code doesn't write it to the transcript, so remember what was set ----------
const effortFile = () => join(dir("data"), "bot-effort.json");
const efforts = (): Record<string, string> => { try { return JSON.parse(readFileSync(effortFile(), "utf8")); } catch { return {}; } };
let native: NativeBots | null = null;
/** The native manager when it runs this bot (with bots.provider: both, the others belong to Claude OS). */
const nat = (ch: string) => (native?.get(ch) ? native : null);
function launchFlag(ch: string, flag: "model" | "effort") {
  if (nat(ch)) return native!.get(ch)?.[flag] ?? null;
  const root = config.integrations.channelsDir;
  const f = root ? join(root, ch, "launch.command") : "";
  return f && existsSync(f) ? readFileSync(f, "utf8").match(new RegExp(`--${flag}\\s+(\\S+)`))?.[1] ?? null : null;
}

/** Background jobs for the panel: monitor re-arms collapse into their latest run; ended ones fade after 6 h. */
function jobsView(t: Transcript): BgJob[] {
  const latest = new Map<string, BgJob>();
  for (const j of t.jobs.values()) latest.set(`${j.kind}|${j.name}|${j.command}`, j);
  const now = Date.now();
  return [...latest.values()].filter((j) => !j.ended || now - j.ended < 6 * 3600_000)
    .sort((a, b) => Number(!!a.ended) - Number(!!b.ended) || b.started - a.started).slice(0, 16);
}

function metaView(ch: string, b: BotInfo, t: Transcript | null) {
  const reqs = readRequests().filter((r) => r.channel === ch);
  const states = requestStates(t, reqs);
  return {
    session: t?.meta ?? null,
    effort: t?.meta.effort ?? efforts()[ch] ?? launchFlag(ch, "effort") ?? null,
    launchModel: launchFlag(ch, "model") ?? b.model,
    jobs: t ? jobsView(t).map((j) => (stoppedHere.has(j.id) && j.ended ? { ...j, endReason: "stopped" } : j)) : [],
    schedules: t ? [...t.schedules.values()].filter((s) => !s.deleted).slice(-12) : [],
    requests: reqs.map((r, i) => ({ ...r, ...states[i] })),
    running: b.running, protected: b.protected, tmux: b.running && hasTmux(ch),
  };
}

// /model and /effort also save the choice as the default for every new Claude Code session (~/.claude/settings.json).
// A switch made here is meant for one bot, so put those keys back once the session has taken it (the live session
// keeps its new model/effort; checked against Claude Code 2.1.309).
const SETTINGS = join(HOME, ".claude", "settings.json");
const KEYS = ["model", "effortLevel", "modelSettings"] as const;
async function keepDefaults<T>(fn: () => Promise<T>): Promise<T> {
  let before: Record<string, unknown>;
  try { before = JSON.parse(readFileSync(SETTINGS, "utf8")); } catch { return fn(); }
  const out = await fn();
  void (async () => { // watch for ~8 s in the background, then put the defaults back once
    for (let i = 0; i < 16; i++) {
      await Bun.sleep(500);
      let now: Record<string, unknown>;
      try { now = JSON.parse(readFileSync(SETTINGS, "utf8")); } catch { continue; }
      if (KEYS.every((k) => JSON.stringify(now[k]) === JSON.stringify(before[k]))) continue;
      for (const k of KEYS) { if (k in before) now[k] = before[k]; else delete now[k]; }
      writeFileSync(SETTINGS, JSON.stringify(now, null, 2) + "\n");
      log(`bot switch: kept the global ${KEYS.join("/")} defaults`);
      return;
    }
  })();
  return out;
}

const stoppedHere = new Map<string, number>(); // job id → when it was switched off from Server OS

const TMUX = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].find(existsSync) ?? "tmux";
/** The tmux session a bot runs in: bot-<channel>, except the main bot (channel "telegram"), which runs as bot-main. */
const tmuxTarget = (ch: string) => `bot-${ch === "telegram" ? "main" : ch}`;
function hasTmux(ch: string) {
  if (nat(ch)) return native!.alive(ch);
  try { return Bun.spawnSync([TMUX, "has-session", "-t", tmuxTarget(ch)]).exitCode === 0; } catch { return false; }
}

export function botRoutes(api: Hono<Env>, cos: string | undefined, nativeBots: NativeBots | null = null) {
  native = nativeBots;
  const send = async (ch: string, text: string) => {
    if (nat(ch)) return native!.send(ch, text); // only ever its own <prefix>* tmux sessions
    // Into a tmux bot: bracketed paste (so newlines don't each press Enter in Claude Code), then Enter.
    if (hasTmux(ch)) {
      const load = Bun.spawnSync([TMUX, "load-buffer", "-b", "sd", "-"], { stdin: Buffer.from(text) });
      const paste = load.exitCode === 0 ? Bun.spawnSync([TMUX, "paste-buffer", "-p", "-d", "-b", "sd", "-t", tmuxTarget(ch)]) : load;
      if (paste.exitCode !== 0) return { ok: false, error: "tmux paste failed" };
      await Bun.sleep(400);
      const enter = Bun.spawnSync([TMUX, "send-keys", "-t", tmuxTarget(ch), "Enter"]);
      return enter.exitCode === 0 ? { ok: true } : { ok: false, error: "tmux send-keys failed" };
    }
    if (!cos) return { ok: false, error: "No bot manager configured (integrations.claudeOS)" };
    text = text.replace(/\s*\n\s*/g, " · "); // iTerm sessions: one line
    const r = await fetch(`${cos}/bot/send-prompt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel: ch, text }) }).catch(() => null);
    if (!r) return { ok: false, error: "Claude OS (:3090) is not answering" };
    return (await r.json()) as { ok: boolean; error?: string };
  };
  const body = async (c: { req: { header: (k: string) => string | undefined; json: () => Promise<unknown> } }) => {
    if (!(c.req.header("content-type") ?? "").includes("application/json")) return null;
    try { return (await c.req.json()) as Record<string, unknown>; } catch { return null; }
  };

  // Live feed: one "reset" (recent items + panel state), then "items" with only new/changed items and "meta" when
  // the panel state changes. Keyed by stable ids, so the page patches in place instead of re-rendering the chat.
  api.get("/bots/:ch/feed", (c) => {
    const ch = c.req.param("ch");
    const b0 = bot(ch);
    if (!b0) return problem(c, 404, "Not Found", "Unknown bot");
    return streamSSE(c, async (stream) => {
      let path: string | null = null, t: Transcript | null = null, lastMeta = "", beat = Date.now(), cursor = 0;
      while (!stream.aborted) {
        const b = bot(ch) ?? b0;
        const p = transcriptPath(b);
        if (p !== path) {
          path = p; t = p ? parser(p, ch) : null; t?.update(); cursor = t?.cursor ?? 0;
          const meta = metaView(ch, b, t); lastMeta = JSON.stringify(meta);
          await stream.writeSSE({ event: "reset", data: JSON.stringify({ items: t ? t.items.slice(-400) : [], meta }) });
        } else if (t) {
          t.update();
          const ch2 = t.changedSince(cursor); cursor = ch2.cursor;
          const ids = ch2.ids;
          if (ids.length) await stream.writeSSE({ event: "items", data: JSON.stringify(ids.map((id) => t!.get(id)).filter(Boolean) as FeedItem[]) });
        }
        const meta = JSON.stringify(metaView(ch, b, t));
        if (meta !== lastMeta) { lastMeta = meta; await stream.writeSSE({ event: "meta", data: meta }); }
        if (Date.now() - beat > 15_000) { beat = Date.now(); await stream.writeSSE({ event: "ping", data: "" }); }
        await stream.sleep(1000);
      }
    });
  });

  // The same feed for clients that poll (the iOS app): pass back `session` and `total` from the last answer and get
  // only the tail since then (plus a few items before it, whose tool steps may have finished meanwhile).
  api.get("/bots/:ch/snapshot", (c) => {
    const b = bot(c.req.param("ch"));
    if (!b) return problem(c, 404, "Not Found", "Unknown bot");
    const p = transcriptPath(b);
    const t = p ? parser(p, b.channel) : null;
    t?.update();
    const total = t?.items.length ?? 0;
    const since = Number(c.req.query("since") ?? -1);
    const same = !!t && c.req.query("session") === t.meta.session && since >= 0 && since <= total;
    const items = !t ? [] : same ? t.items.slice(Math.max(0, since - 40)) : t.items.slice(-300);
    return c.json({ session: t?.meta.session ?? null, total, reset: !same, items, meta: metaView(b.channel, b, t) });
  });

  // A past conversation, read once.
  api.get("/bots/:ch/sessions", (c) => {
    const b = bot(c.req.param("ch"));
    if (!b) return problem(c, 404, "Not Found", "Unknown bot");
    const d = projectDir(b.cwd);
    if (!existsSync(d)) return c.json([]);
    const files = readdirSync(d).filter((f) => f.endsWith(".jsonl")).map((f) => ({ f, t: statSync(join(d, f)).mtimeMs, size: statSync(join(d, f)).size }))
      .sort((a, b2) => b2.t - a.t).slice(0, 12);
    return c.json(files.map(({ f, t, size }) => {
      const tr = parser(join(d, f), b.channel);
      const firstUser = tr.items.find((i) => i.kind === "user");
      const lastUser = [...tr.items].reverse().find((i) => i.kind === "user");
      return { session: f.replace(/\.jsonl$/, ""), updated: t, size, messages: tr.items.filter((i) => i.kind === "user" || i.kind === "assistant").length,
        preview: (lastUser ?? firstUser)?.text?.replace(/\s+/g, " ").slice(0, 120) ?? "" };
    }));
  });
  api.get("/bots/:ch/sessions/:id", (c) => {
    const b = bot(c.req.param("ch"));
    const id = c.req.param("id");
    if (!b || !/^[0-9a-f-]{36}$/.test(id)) return problem(c, 404, "Not Found", "Unknown session");
    const p = join(projectDir(b.cwd), `${id}.jsonl`);
    if (!existsSync(p)) return problem(c, 404, "Not Found", "Unknown session");
    return c.json(parser(p, b.channel).items.slice(-600));
  });

  type C = Context<Env, any>;
  const live = (c: C) => {
    const b = bot(c.req.param("ch") ?? "");
    return b?.running ? b : null;
  };
  const done = (c: C, ch: string, action: string, r: { ok: boolean; error?: string }, okDetail: string) => {
    audit(c.get("actor"), `bot.${action}`, ch, r.ok ? "ok" : "failed", c.get("trace"));
    return r.ok ? c.json({ ok: true, detail: okDetail }) : problem(c, 502, "Bad Gateway", r.error ?? "The bot didn't take it");
  };

  api.post("/bots/:ch/send", async (c) => {
    const b = live(c); const j = await body(c);
    if (!b) return problem(c, 409, "Conflict", "The bot isn't running");
    const text = String(j?.text ?? "").trim();
    if (!text || text.length > 8000) return problem(c, 400, "Bad Request", "Type a message (up to 8000 characters)");
    const nonce = typeof j?.nonce === "string" && /^[\w-]{1,64}$/.test(j.nonce) ? j.nonce : null;
    sentFromDash.add(b.channel, text, nonce); // before typing it: the transcript line can land first
    return done(c, b.channel, "send", await send(b.channel, text), "Sent");
  });

  /** The bot's live tmux pane (visible part), for "is a turn still running?". null when it can't be read. */
  const pane = (ch: string) => async () => {
    if (nat(ch)) { const r = native!.terminal(ch); return r.ok ? String((r as { contents?: string }).contents ?? "").split("\n").slice(-40).join("\n") : null; }
    const r = await run([TMUX, "capture-pane", "-p", "-t", tmuxTarget(ch)], 3000);
    return r.code === 0 ? r.out : null;
  };
  const transcriptOf = (b: BotInfo) => { const p = transcriptPath(b); const t = p ? parser(p, b.channel) : null; t?.update(); return t; };

  // Escape, then confirm: wait for the pane to drop its "esc to interrupt" line. Claude Code writes no "[Request
  // interrupted" line when a turn is stopped before it produced output, so on an idle pane we clear Working ourselves.
  api.post("/bots/:ch/interrupt", async (c) => {
    const b = live(c);
    if (!b) return problem(c, 409, "Conflict", "The bot isn't running");
    if (!hasTmux(b.channel)) return problem(c, 409, "Conflict", "Only bots running in tmux can be interrupted from here");
    const key = nat(b.channel)
      ? native!.key(b.channel, "Escape")
      : await run([TMUX, "send-keys", "-t", tmuxTarget(b.channel), "Escape"], 5000).then((r) => ({ ok: r.code === 0, error: r.out }));
    audit(c.get("actor"), "bot.interrupt", b.channel, key.ok ? "ok" : "failed", c.get("trace"));
    if (!key.ok) return problem(c, 502, "Bad Gateway", key.error || "Couldn't press Escape in the bot's session");
    const r = await settleAfterInterrupt(transcriptOf(b), pane(b.channel));
    if (r.stopped) return c.json({ ok: true, stopped: true, detail: "Stopped" });
    if (r.busy === null) return c.json({ ok: true, stopped: false, detail: "Escape sent. Couldn't read the session to confirm it stopped." });
    return c.json({ ok: true, stopped: false, detail: "Escape sent, but the bot is still working. Try again, or stop it from the Terminal tab." });
  });

  // Asked by the page while "Working" looks stale: no transcript activity for a while and an idle pane means it isn't.
  api.post("/bots/:ch/verify", async (c) => {
    const b = live(c);
    if (!b) return problem(c, 409, "Conflict", "The bot isn't running");
    if (!hasTmux(b.channel)) return c.json({ ok: true, cleared: false, reason: "not tmux" });
    return c.json({ ok: true, ...(await clearIfStale(transcriptOf(b), pane(b.channel))) });
  });

  const MODELS = new Set(["fable", "opus", "sonnet", "haiku"]);
  api.post("/bots/:ch/model", async (c) => {
    const b = live(c); const m = String((await body(c))?.model ?? "");
    if (!b) return problem(c, 409, "Conflict", "The bot isn't running");
    if (!MODELS.has(m)) return problem(c, 400, "Bad Request", "Unknown model");
    return done(c, b.channel, "model", await keepDefaults(() => send(b.channel, `/model ${m}`)), `Switching to ${m}`);
  });

  const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
  api.post("/bots/:ch/effort", async (c) => {
    const b = live(c); const e = String((await body(c))?.effort ?? "");
    if (!b) return problem(c, 409, "Conflict", "The bot isn't running");
    if (!EFFORTS.has(e)) return problem(c, 400, "Bad Request", "Unknown effort level");
    const r = await keepDefaults(() => send(b.channel, `/effort ${e}`));
    if (r.ok) { mkdirSync(dir("data"), { recursive: true }); writeFileSync(effortFile(), JSON.stringify({ ...efforts(), [b.channel]: e })); }
    return done(c, b.channel, "effort", r, `Effort set to ${e}`);
  });

  const findJob = (b: BotInfo, id: string) => {
    const p = transcriptPath(b);
    const t = p ? parser(p, b.channel) : null; t?.update();
    return t?.jobs.get(id) ?? null;
  };
  // A sub-agent's own conversation (prompt, replies, one line per tool call), last ~200 entries, secrets masked.
  api.get("/bots/:ch/jobs/:id/log", (c) => {
    const b = bot(c.req.param("ch"));
    const p = b ? transcriptPath(b) : null;
    const j = p ? findJob(b!, c.req.param("id")) : null;
    if (!p || !j || j.kind !== "agent" || !j.taskId || !/^[a-z0-9]+$/.test(j.taskId)) return c.json([]);
    return c.json(readAgentLog(join(p.replace(/\.jsonl$/, ""), "subagents", `agent-${j.taskId}.jsonl`)));
  });
  api.post("/bots/:ch/jobs/:id/stop", async (c) => {
    const b = live(c);
    if (!b?.pid) return problem(c, 409, "Conflict", "The bot isn't running");
    const j = findJob(b, c.req.param("id"));
    if (!j || j.ended) return problem(c, 404, "Not Found", "That job isn't running");
    if (j.kind === "agent") return done(c, b.channel, "job.stop", await send(b.channel, `[Server OS] Please stop the background sub-agent "${j.name}"${j.taskId ? ` (task ${j.taskId})` : ""} with TaskStop.`), "Asked the bot to stop it");
    // Tell the bot first, so the "monitor failed" notice that follows doesn't make it re-arm or report it.
    await send(b.channel, `[Server OS] The owner is switching off the background job "${j.name}" on purpose. When it ends, don't restart it and don't report it.`);
    await Bun.sleep(1500);
    const killed = await killJobProcess(b.pid, j.command);
    if (killed) stoppedHere.set(j.id, Date.now());
    log(`bot ${b.channel} stop job ${j.name}: ${killed ? "killed" : "not found"}`);
    return done(c, b.channel, "job.stop", { ok: killed, error: "Couldn't find its process — it may have just ended" }, "Stopped");
  });
  api.post("/bots/:ch/jobs/:id/start", async (c) => {
    const b = live(c);
    if (!b) return problem(c, 409, "Conflict", "The bot isn't running");
    const j = findJob(b, c.req.param("id"));
    if (!j) return problem(c, 404, "Not Found", "Unknown job");
    const tool = j.kind === "monitor" ? "Monitor" : j.kind === "shell" ? "a background shell (Bash, run_in_background)" : "a background sub-agent";
    const text = `[Server OS] Please start the background job "${j.name}" again with ${tool}${j.kind !== "agent" ? `, same command:\n${j.command}` : "."}`;
    return done(c, b.channel, "job.start", await send(b.channel, text), "Asked the bot to start it");
  });
  api.post("/bots/:ch/schedules/:id/stop", async (c) => {
    const b = live(c);
    if (!b) return problem(c, 409, "Conflict", "The bot isn't running");
    const p = transcriptPath(b); const t = p ? parser(p, b.channel) : null;
    const s = t?.schedules.get(c.req.param("id"));
    if (!s) return problem(c, 404, "Not Found", "Unknown schedule");
    return done(c, b.channel, "schedule.stop", await send(b.channel, `[Server OS] Please cancel the scheduled job ${s.cronId ?? ""} (${s.cron}) with CronDelete.`), "Asked the bot to cancel it");
  });

  api.post("/bots/:ch/requests", async (c) => {
    const b = live(c); const j = await body(c);
    if (!b) return problem(c, 409, "Conflict", "The bot isn't running");
    const kind = String(j?.kind ?? "") as BotRequest["kind"];
    const name = String(j?.name ?? "").trim().slice(0, 80), what = String(j?.what ?? "").trim().slice(0, 2000);
    if (!["watch", "schedule", "task"].includes(kind) || !name || !what) return problem(c, 400, "Bad Request", "Pick a kind, a name and what it should do");
    const o = (j?.options ?? {}) as Record<string, unknown>;
    const pick = (k: string) => (typeof o[k] === "string" ? String(o[k]).slice(0, 60) : undefined);
    const r: BotRequest = { id: newRequestId(), channel: b.channel, kind, name, what, created: Date.now(),
      options: { source: pick("source"), every: pick("every"), repeat: pick("repeat"), at: pick("at"), model: pick("model"), until: pick("until"), telegram: !!o.telegram, quiet: o.quiet !== false } };
    const sent = await send(b.channel, requestPrompt(r));
    if (!sent.ok) return problem(c, 502, "Bad Gateway", sent.error ?? "The bot didn't take it");
    writeRequests([...readRequests(), r]);
    audit(c.get("actor"), "bot.request", `${b.channel} ${r.id}`, "ok", c.get("trace"));
    return c.json({ ok: true, id: r.id, prompt: requestPrompt(r) });
  });
  api.get("/bots/:ch/requests/preview", (c) => {
    const q = c.req.query();
    const r: BotRequest = { id: "sd-xxxx", channel: c.req.param("ch"), kind: (q.kind as BotRequest["kind"]) ?? "watch", name: q.name ?? "", what: q.what ?? "", created: 0,
      options: { source: q.source, every: q.every, repeat: q.repeat, at: q.at, model: q.model, until: q.until, telegram: q.telegram === "1", quiet: q.quiet !== "0" } };
    return c.json({ prompt: requestPrompt(r) });
  });
  api.delete("/bots/:ch/requests/:id", (c) => {
    const list = readRequests();
    const keep = list.filter((r) => !(r.channel === c.req.param("ch") && r.id === c.req.param("id")));
    if (keep.length === list.length) return problem(c, 404, "Not Found", "Unknown request");
    writeRequests(keep);
    return c.body(null, 204);
  });
}
