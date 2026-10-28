// Server OS — Bun + Hono server: the v1 API, live state over SSE, collectors, scheduler, catalog, installer, the web panel.
// Live state is pushed to browsers over one SSE stream (/svc-api/stream); actions are small JSON POSTs.
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { join, normalize } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { log, every } from "./lib";
import { getSlice, getState, subscribe, setSlice } from "./store";
import { SVC, appRefs, computeApps, deleteApp, deletePlan, findItem, startAppCollectors, toggle } from "./apps";
import { envKeyNames, linkLogin, listLogins, revealLogin } from "./modules/logins";
import { startSystemCollectors, history, historyRange, RANGES, type Range } from "./system";
import { findEvents, startConsumerCollector } from "./modules/consumers";
import { speak, voiceAvailable, voices } from "./modules/voice";
import { sampleFile, showcase } from "./modules/voiceShowcase";
import { cloudEnabled, setCloudEnabled, usage as cloudUsage } from "./modules/cloudVoice";
import { houseVoice, houseVoiceAvailable, houseVoiceWatchdog, setHouseVoice, voiceSessionAvailable } from "./modules/houseVoice";
import { DEMO, demoBotsFeed, startDemo, demoToggle, demoRunJob, demoJobLog, demoInstall, demoStorage } from "./demo";
import { startOpsCollectors, alerts, readJobs, runJob, tail } from "./ops";
import { startLifecycle, appLogs } from "./lifecycle";
import { refreshUsage, startClaudeCollectors } from "./claude";
import { config, dir, ROOT, VERSION } from "./core/config";
import { audit, logEvent } from "./core/logger";
import { completePairing, issueDevice, listDevices, revoke, startPairing } from "./core/devices";
import { deleteSpec, getRun, getSpec, listRuns, onJobsChange, saveSpec, serverJobs, slug, startRun, startScheduler, webhookSecret, type JobSpec } from "./modules/scheduler";
import { categories, detail, dockerHub, genres, getItem, home, slugify, refresh as refreshCatalog, refreshRecipes, search, sourceStatus, startCatalog } from "./modules/catalog";
import { agentChecklist, agentInstall, askAgent, getInstalled, getOperation, getSecrets, install, listInstalled, makePlan, newSecret, onAppsChanged, setReady, setup, startInstaller, uninstall } from "./modules/installer";
import { agentAvailable } from "./modules/agent";
import { storage, storageAvailable } from "./modules/storage";
import { fixAttrs, fixPermission, isPermId, listPermissions, missingRequired, type MacPermId, type PermId } from "./modules/permissions";
import { listRecipes } from "./modules/recipes";
import { detectScreen, screenNoun } from "./modules/screenSetup";
import { parseRes } from "./modules/displayMode";
import { recoverDisplay, resolutionOptions, setResolution, shutdownScreen, resolveScreen, screenConfig, screenSocket, screenStatus, upgradeScreen, vncListening } from "./modules/screen";
import { collectPorts, panelAddresses } from "./modules/ports";
import { deleteDashboard, ensureDefault, getDashboard, listDashboards, saveDashboard, SCHEMA as DASH_SCHEMA } from "./modules/dashboards";
import { errorSummary, queryAudit, queryLogs, trace as getTrace } from "./modules/logs";
import { problem, requireAdmin, requireAuth, signInCookie, signOutCookie, tracing, type Env } from "./core/http";
import { changePassword, clearFailures, createOwner, hasOwner, noteFailure, ownerName, setupToken, tooManyAttempts, verifyOwner } from "./core/owner";
import { getConnInfo } from "hono/bun";
import type { Server } from "bun";
import type { ScreenData } from "./modules/screen";
import { botRoutes, rearmWatchers } from "./botRoutes";
import { NativeBots, botsProvider, nativeMissing } from "./modules/bots";
import { applyUpdate, checkForUpdate, saveSettings as saveUpdateSettings, startUpdater, updateStatus } from "./modules/update";

const PORT = Number(process.env.PORT ?? 3094);
const DIST = join(import.meta.dir, "../web/dist");

const app = new Hono<Env>();
app.use("*", tracing);

// The API lives on one sub-app, mounted at /api/v1 (the documented contract, spec/openapi.yaml) and at
// /svc-api (the original paths, kept so existing web/app builds keep working).
const api = new Hono<Env>();
api.use("*", requireAuth((p) => /\/(info|health|pair|auth\/(me|setup|login))$/.test(p) || /\/hooks\/[^/]+$/.test(p))); // webhooks carry their own secret

api.get("/stream", (c) =>
  streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: "snapshot", data: JSON.stringify(getState()) });
    const queue: Array<[string, unknown]> = [];
    let wake: (() => void) | null = null;
    const off = subscribe((event, data) => { queue.push([event, data]); wake?.(); });
    stream.onAbort(() => { off(); wake?.(); });
    let lastBeat = Date.now();
    while (!stream.aborted) {
      if (!queue.length) await new Promise<void>((r) => { wake = r; setTimeout(r, 15_000); });
      wake = null;
      while (queue.length) { const [event, data] = queue.shift()!; await stream.writeSSE({ event, data: JSON.stringify(data) }); }
      if (Date.now() - lastBeat > 15_000) { await stream.writeSSE({ event: "ping", data: String(Date.now()) }); lastBeat = Date.now(); }
    }
    off();
  }),
);

api.get("/state", (c) => c.json(getState()));

const jsonBody = async (c: { req: { header: (k: string) => string | undefined; json: () => Promise<unknown> } }) => {
  if (!(c.req.header("content-type") ?? "").includes("application/json")) return null; // JSON-only: blocks plain cross-site form posts
  try { return (await c.req.json()) as Record<string, unknown>; } catch { return null; }
};

api.post("/toggle", async (c) => {
  const b = await jsonBody(c);
  if (!b) return c.json({ ok: false, detail: "json only" }, 415);
  const r = DEMO ? demoToggle(String(b.name ?? ""), !!b.on) : await toggle(String(b.name ?? ""), !!b.on);
  audit(c.get("actor"), b.on ? "app.start" : "app.stop", String(b.name ?? ""), r.ok ? "ok" : "failed", c.get("trace"));
  return c.json(r, r.ok ? 200 : 400);
});

api.get("/jobs/log", async (c) => {
  const id = c.req.query("id") ?? "";
  if (DEMO) return c.json({ id, log: demoJobLog(id) ?? "(not run yet)" });
  if (id.startsWith("sd:")) {
    const r = listRuns(id.slice(3), 1)[0];
    return c.json({ id, log: r ? r.output || "(no output)" : "(not run yet)" });
  }
  const job = (await readJobs()).find((j) => j.id === c.req.query("id"));
  return job ? c.json({ id: job.id, log: job.log ? tail(job.log) : "(no log file)" }) : c.json({ error: "unknown job" }, 404);
});
api.post("/jobs/run", async (c) => {
  const b = await jsonBody(c);
  if (!b) return c.json({ ok: false, detail: "json only" }, 415);
  const id = String(b.id ?? "");
  const r = id.startsWith("sd:")
    ? (() => { const x = startRun(id.slice(3), "manual", c.get("actor"), c.get("trace")); return x.ok ? { ok: true, detail: "started", runId: x.runId } : { ok: false, detail: x.error }; })()
    : DEMO ? demoRunJob(id) : await runJob(id);
  audit(c.get("actor"), "job.run", String(b.id ?? ""), r.ok ? "ok" : "failed", c.get("trace"));
  return c.json(r, r.ok ? 200 : 400);
});
api.get("/history", (c) => {
  const r = (c.req.query("range") ?? "24h") as Range;
  if (!(r in RANGES)) return c.json({ error: "bad range" }, 400);
  const points = Number(c.req.query("points"));
  // ?points=N → fixed-step buckets with avg/min/max and nulls (what the apps use); without it, the raw series.
  if (points > 0) return c.json(historyRange(c.req.query("metric") ?? "", r, points));
  return c.json(history(c.req.query("metric") ?? "", r));
});
// Jumps in a vital and what caused them (the apps that grew), for the chart's pins; ranges up to 6 h.
api.get("/history/events", (c) => {
  const r = (c.req.query("range") ?? "2h") as Range;
  if (!(r in RANGES)) return problem(c, 400, "Bad Request", "Unknown range");
  if (RANGES[r] > 6 * 3600) return c.json({ events: [], note: "Causes are kept for 6 hours" });
  const metric = c.req.query("metric") ?? "";
  return c.json({ events: findEvents(metric, history(metric, r), Math.floor(Date.now() / 1000) - RANGES[r]) });
});
// Voice: the main bot's replies spoken (local Kokoro TTS), streamed as raw 16-bit mono PCM at 24 kHz.
api.get("/voice/voices", async (c) => {
  const v = await voices();
  return v ? c.json(v) : problem(c, 503, "Service Unavailable", "The voice service (Kokoro, :8880) is not running");
});
api.post("/voice/speak", async (c) => {
  const b = await c.req.json().catch(() => null) as { text?: string; voice?: string; speed?: number } | null;
  const text = String(b?.text ?? "").trim();
  if (!text || text.length > 8000) return problem(c, 400, "Bad Request", "Text to speak (up to 8000 characters)");
  const r = await speak(text, b?.voice, b?.speed);
  if (!r?.body) return problem(c, 503, "Service Unavailable", "The voice service (Kokoro, :8880) is not running");
  return new Response(r.body, { headers: { "Content-Type": "audio/pcm", "X-Sample-Rate": "24000", "X-Channels": "1", "Cache-Control": "no-store" } });
});
// Cloud voices: the on/off switch and the account's live usage (cached 60 s).
api.get("/voice/cloud", async (c) => c.json({ enabled: cloudEnabled(), usage: await cloudUsage() }));
api.patch("/voice/cloud", async (c) => {
  const b = await jsonBody(c);
  if (!b || typeof b.enabled !== "boolean") return problem(c, 400, "Bad Request", "JSON with enabled: true or false");
  setCloudEnabled(b.enabled);
  audit(c.get("actor"), "voice.cloud", "cloud-voices", "ok", c.get("trace"), b);
  return c.json({ enabled: cloudEnabled(), usage: await cloudUsage() });
});
// Voices page: all installed voices + the open-source catalog; a sample is made on the first press of play, then cached on disk.
api.get("/voice/showcase", async (c) => c.json(await showcase()));
api.get("/voice/sample", async (c) => {
  const f = await sampleFile(c.req.query("voice") ?? "");
  if (typeof f !== "string") return problem(c, f.status as 400, "Voice sample", f.error);
  return new Response(Bun.file(f), { headers: { "Content-Type": "audio/wav", "Cache-Control": "private, max-age=3600" } });
});
// House voice: the wake-word speaker on the desk that talks to the main bot. GET its state, PATCH to switch it or tune it.
api.get("/house-voice", async (c) => c.json(houseVoiceAvailable() ? await houseVoice() : { available: false }));
api.patch("/house-voice", async (c) => {
  if (!houseVoiceAvailable()) return problem(c, 404, "Not Found", "House voice isn't installed on this server");
  const b = await jsonBody(c);
  if (!b) return problem(c, 415, "Unsupported Media Type", "JSON only");
  const r = await setHouseVoice(b);
  audit(c.get("actor"), "houseVoice.set", "house-voice", "ok", c.get("trace"), b);
  return c.json(r);
});
api.get("/logs", async (c) => c.json(await appLogs(c.req.query("app") ?? "")));
api.get("/alerts", (c) => c.json(alerts(Number(c.req.query("days")) >= 7 ? 7 : 1)));

api.post("/claude/usage/refresh", async (c) => { await refreshUsage(); return c.json({ ok: true }); });

// Bot manager. Claude OS (:3090, integrations.claudeOS) owns the bot logic when it is configured: only these endpoints
// are forwarded and POSTs must be JSON. Without it (or with bots.provider: native) Server OS runs the bots itself in
// tmux sessions named <prefix><bot> and answers the same /cos/* endpoints natively (server/modules/bots/native.ts).
// bots.provider: both runs the two side by side: native bots are answered here, every other bot is forwarded to Claude OS.
const COS_URL = config.integrations.claudeOS?.replace(/\/$/, "");
const BOTS_MISSING = nativeMissing();
const BOTS_PROVIDER = botsProvider(config.bots?.provider, !!COS_URL, BOTS_MISSING.length === 0, DEMO);
const COS = BOTS_PROVIDER === "claudeOS" || BOTS_PROVIDER === "both" ? COS_URL : undefined;
const NATIVE = BOTS_PROVIDER === "native" || BOTS_PROVIDER === "both" ? new NativeBots({
  home: ROOT, prefix: config.bots?.prefix, team: config.bots?.team, agmsg: config.bots?.agmsg, ownerName: config.owner.name,
  ownerChatIds: (config.bots?.telegram?.ownerChatIds ?? []).map(String),
}) : null;
setSlice("botsProvider", { provider: DEMO ? "demo" : BOTS_PROVIDER, prefix: NATIVE?.prefix ?? null, missing: BOTS_PROVIDER ? [] : BOTS_MISSING });
const COS_GET = new Set(["botSessions", "bot/terminal", "bot/conversations", "bot/transcript", "bot/transcript-stream"]);
const COS_POST = new Set(["bot/restart", "bot/stop", "bot/launch", "bot/skill-scope", "bot/mcp-scope", "bot/create", "bot/set-token", "bot/send-prompt", "bot/reconnect-mcp", "bot/delete", "bot/save-settings"]);
const NO_BOTS = "No bot manager: install tmux and Claude Code, or set integrations.claudeOS";
const NATIVE_ONLY = new Set(["bot/create", "bot/catalog"]);
/** Native answers a call when it runs alone, for its own bots, and for what only it has (create, catalog). */
const nativeFor = (sub: string, ch: string) => NATIVE && (!COS || !!NATIVE.get(ch) || NATIVE_ONLY.has(sub)) ? NATIVE : null;
let cosBots: object[] | null = null;
/** The Bots list: Claude OS rows (minus names a native bot took over) followed by the native bots. */
const pushBots = () => {
  const nat = NATIVE?.list() ?? [];
  const mine = new Set(nat.map((b) => b.channel));
  setSlice("botSessions", !COS ? nat : !cosBots ? (nat.length ? nat : null)
    : [...cosBots.filter((b) => !mine.has(String((b as { channel?: string }).channel))), ...nat]);
};
api.get("/cos/*", async (c) => {
  const sub = c.req.path.replace(/^.*?\/cos\//, "");
  if (sub === "botSessions" && NATIVE && COS) { pushBots(); return c.json({ botSessions: getSlice("botSessions") ?? [] }); }
  const nat = nativeFor(sub, String(c.req.query("channel") ?? c.req.query("name") ?? ""));
  if (nat) { const r = await nat.handle(sub, c.req.query()); return c.json(r.body as object, r.status as 200); }
  if (!COS) return problem(c, 404, "Not Found", NO_BOTS);
  if (!COS_GET.has(sub)) return c.json({ ok: false, error: "not allowed" }, 404);
  const u = new URL(c.req.url);
  const r = await fetch(`${COS}/${sub}${u.search}`, { signal: c.req.raw.signal }).catch(() => null);
  if (!r) return c.json({ ok: false, error: "Claude OS (:3090) is not answering" }, 502);
  return new Response(r.body, { status: r.status, headers: { "Content-Type": r.headers.get("content-type") ?? "application/json", "Cache-Control": "no-store" } });
});
api.post("/cos/*", async (c) => {
  if (!COS && !NATIVE) return problem(c, 404, "Not Found", NO_BOTS);
  const sub = c.req.path.replace(/^.*?\/cos\//, "");
  if (!COS_POST.has(sub)) return c.json({ ok: false, error: "not allowed" }, 404);
  const b = await jsonBody(c);
  if (!b) return c.json({ ok: false, error: "json only" }, 415);
  const target = String(b.channel ?? b.name ?? "");
  const nat = nativeFor(sub, target);
  if (nat) {
    const r = await nat.handle(sub, b);
    log(`bot ${sub} ${target}`);
    audit(c.get("actor"), `bot.${sub.replace("bot/", "")}`, target, r.status === 200 ? "ok" : "failed", c.get("trace"));
    if (r.status === 200 && sub !== "bot/send-prompt") pushBots();
    return c.json(r.body as object, r.status as 200);
  }
  const r = await fetch(`${COS}/${sub}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).catch(() => null);
  if (!r) return c.json({ ok: false, error: "Claude OS (:3090) is not answering" }, 502);
  log(`bot ${sub} ${target}`);
  audit(c.get("actor"), `bot.${sub.replace("bot/", "")}`, target, r.ok ? "ok" : "failed", c.get("trace"));
  return new Response(r.body, { status: r.status, headers: { "Content-Type": "application/json" } });
});

if (DEMO) api.get("/bots/:ch/feed", (c) => streamSSE(c, async (stream) => {
  await stream.writeSSE({ event: "reset", data: JSON.stringify(demoBotsFeed()) });
  while (!stream.aborted) { await stream.sleep(15_000); await stream.writeSSE({ event: "ping", data: "" }); }
}));
botRoutes(api, COS, NATIVE);

// Bot instructions: the CLAUDE.md in a bot's working folder. The folder comes from the bot manager's own list
// (never from the request); the main bot's file is read-only here.
async function botCwd(channel: string): Promise<{ cwd: string; protected: boolean } | null> {
  const nb = NATIVE?.get(channel);
  if (nb) return { cwd: nb.cwd, protected: false };
  if (!COS) return null;
  const r = await fetch(`${COS}/botSessions`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  const list = r?.ok ? ((await r.json()).botSessions ?? []) as { channel: string; cwd: string; protected: boolean }[] : [];
  const b = list.find((x) => x.channel === channel);
  return b?.cwd ? { cwd: b.cwd.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"), protected: !!b.protected } : null;
}
api.get("/bot-instructions", async (c) => {
  const b = await botCwd(c.req.query("channel") ?? "");
  if (!b) return c.json({ ok: false, error: "unknown bot" }, 404);
  const f = Bun.file(join(b.cwd, "CLAUDE.md"));
  return c.json({ ok: true, path: join(b.cwd, "CLAUDE.md"), editable: !b.protected, text: (await f.exists()) ? await f.text() : "" });
});
api.post("/bot-instructions", async (c) => {
  const body = await jsonBody(c);
  if (!body) return c.json({ ok: false, error: "json only" }, 415);
  const b = await botCwd(String(body.channel ?? ""));
  if (!b) return c.json({ ok: false, error: "unknown bot" }, 404);
  if (b.protected) return c.json({ ok: false, error: "the main bot's instructions are edited on the Mac" }, 403);
  const text = String(body.text ?? "");
  if (text.length > 200_000) return c.json({ ok: false, error: "too long" }, 413);
  await Bun.write(join(b.cwd, "CLAUDE.md"), text);
  log(`bot instructions saved ${String(body.channel)}`);
  audit(c.get("actor"), "bot.instructions", String(body.channel), "ok", c.get("trace"));
  return c.json({ ok: true, detail: "Saved — restart the bot to apply" });
});

// macOS privacy permissions (server/modules/permissions.ts). The list only runs probes that cannot raise a popup; a
// check of one permission may (Local Network, volumes, folders), so it is a POST the user asks for. Open runs `open <System Settings link>` on this Mac.
const permissions = async (active: PermId[] = []) => {
  const list = DEMO ? [] : await listPermissions({ active });
  return { platform: process.platform, permissions: list, missingRequired: missingRequired(list).map((p) => p.id) };
};
api.get("/permissions", async (c) => c.json(await permissions()));
api.post("/permissions/:id/check", async (c) => {
  const id = c.req.param("id");
  if (!isPermId(id)) return problem(c, 404, "Not Found", "No such permission");
  const r = await permissions([id]);
  audit(c.get("actor"), "permission.check", id, "ok", c.get("trace"));
  return c.json({ ...r, permission: r.permissions.find((p) => p.id === id) ?? null });
});
api.post("/permissions/:id/open", requireAdmin, async (c) => {
  const id = c.req.param("id");
  if (!isPermId(id)) return problem(c, 404, "Not Found", "No such permission");
  if (process.platform !== "darwin" || DEMO) return problem(c, 404, "Not Found", "Privacy permissions exist on macOS only");
  const body = await c.req.json().catch(() => ({})) as { pane?: boolean };
  const r = await fixPermission(id as MacPermId, { pane: body?.pane === true });
  audit(c.get("actor"), "permission.open", id, r.ok ? "ok" : "failed", c.get("trace"), fixAttrs(r));
  return r.ok ? c.json(r) : problem(c, 502, "Bad Gateway", "Could not open System Settings");
});

// Storage tab: disk explorer + whitelisted cleanups (server/modules/storage.ts).
api.get("/storage", (c) => DEMO ? c.json(demoStorage()) : storageAvailable() ? c.json(storage().payload()) : problem(c, 404, "Not Found", "Storage needs a POSIX `du`"));
api.get("/storage/drill", (c) => {
  if (!storageAvailable()) return problem(c, 404, "Not Found", "Storage needs a POSIX `du`");
  const r = storage().drill(c.req.query("path") ?? "", c.req.query("rescan") === "1");
  return "err" in r ? problem(c, r.err.status, r.err.status === 403 ? "Forbidden" : r.err.status === 404 ? "Not Found" : "Bad Request", r.err.detail) : c.json(r.body);
});
api.post("/storage/rescan", async (c) => {
  if (!storageAvailable()) return problem(c, 404, "Not Found", "Storage needs a POSIX `du`");
  return c.json(storage().rescan(), 202); // harmless, so no body needed
});
api.post("/storage/run", async (c) => {
  if (!storageAvailable()) return problem(c, 404, "Not Found", "Storage needs a POSIX `du`");
  const b = await jsonBody(c);
  if (!b) return problem(c, 415, "Unsupported Media Type", "JSON only");
  const id = String(b.id ?? ""), actor = c.get("actor"), trace = c.get("trace");
  const r = storage().runAction(id, b.confirm === true, (st) => audit(actor, "storage.cleanup.done", id, st.state === "done" ? "ok" : "failed", trace, { freed: st.freed }));
  audit(actor, "storage.cleanup", id, "err" in r ? "failed" : "ok", trace);
  if ("err" in r) return problem(c, r.err.status, r.err.status === 404 ? "Not Found" : r.err.status === 409 ? "Conflict" : "Bad Request", r.err.detail);
  return c.json(r.body, 202);
});
const safeEqual = (a: string, b: string) => a.length === b.length && a.length > 0 && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Built-in jobs: CRUD, runs, webhooks.
const refreshJobs = async () => { if (DEMO) return; setSlice("jobs", [...await readJobs(), ...serverJobs()]); };
const jobOut = (id: string) => {
  const j = getSpec(id)!;
  return { id, ...j.spec, error: j.error ?? null, webhookUrl: j.spec.webhook ? `/api/v1/hooks/${id}` : null };
};
api.get("/jobs", (c) => c.json({ jobs: serverJobs() }));
api.post("/jobs", async (c) => {
  const b = await jsonBody(c);
  if (!b) return problem(c, 415, "Unsupported Media Type", "JSON only");
  let id = String(b.id ?? "") || slug(String(b.name ?? ""));
  if (!b.id) for (let n = 2; getSpec(id); n++) id = `${slug(String(b.name ?? ""))}-${n}`;
  else if (getSpec(id)) return problem(c, 409, "Conflict", `job ${id} exists`);
  const r = saveSpec(id, b as Partial<JobSpec>);
  audit(c.get("actor"), "job.create", id, r.ok ? "ok" : "failed", c.get("trace"));
  if (!r.ok) return problem(c, 422, "Invalid job", r.error);
  void refreshJobs();
  return c.json(jobOut(id), 201);
});
api.get("/jobs/:id", (c) => getSpec(c.req.param("id")) ? c.json(jobOut(c.req.param("id"))) : problem(c, 404, "Not Found", "No such job"));
api.put("/jobs/:id", async (c) => {
  const id = c.req.param("id"), cur = getSpec(id);
  if (!cur) return problem(c, 404, "Not Found", "No such job");
  const b = await jsonBody(c);
  if (!b) return problem(c, 415, "Unsupported Media Type", "JSON only");
  const r = saveSpec(id, { ...cur.spec, ...(b as Partial<JobSpec>) });
  audit(c.get("actor"), "job.update", id, r.ok ? "ok" : "failed", c.get("trace"), { fields: Object.keys(b) });
  if (!r.ok) return problem(c, 422, "Invalid job", r.error);
  void refreshJobs();
  return c.json(jobOut(id));
});
api.delete("/jobs/:id", (c) => {
  const ok = deleteSpec(c.req.param("id"));
  audit(c.get("actor"), "job.delete", c.req.param("id"), ok ? "ok" : "failed", c.get("trace"));
  void refreshJobs();
  return ok ? c.body(null, 204) : problem(c, 404, "Not Found", "No such job");
});
api.post("/jobs/:id/run", (c) => {
  const r = startRun(c.req.param("id"), "manual", c.get("actor"), c.get("trace"));
  audit(c.get("actor"), "job.run", c.req.param("id"), r.ok ? "ok" : "failed", c.get("trace"));
  return r.ok ? c.json({ runId: r.runId, trace_id: r.trace.trace_id }, 202) : problem(c, r.error === "unknown job" ? 404 : 409, "Not started", r.error);
});
api.get("/jobs/:id/runs", (c) => c.json({ runs: listRuns(c.req.param("id"), Math.min(200, Number(c.req.query("limit")) || 20)) }));
api.get("/runs/:run", (c) => { const r = getRun(Number(c.req.param("run"))); return r ? c.json(r) : problem(c, 404, "Not Found", "No such run"); });
api.get("/jobs/:id/webhook", (c) => {
  const j = getSpec(c.req.param("id"));
  if (!j?.spec.webhook) return problem(c, 404, "Not Found", "This job has no webhook");
  return c.json({ url: `/api/v1/hooks/${c.req.param("id")}`, secret: webhookSecret(c.req.param("id")), header: "X-Server-OS-Secret" });
});
// Webhook trigger: the secret goes in X-Server-OS-Secret (or ?secret=; the old X-Server-Dash-Secret still works); the request body reaches the job as stdin + $SD_PAYLOAD.
api.post("/hooks/:id", async (c) => {
  const id = c.req.param("id"), j = getSpec(id);
  const given = c.req.header("x-server-os-secret") ?? c.req.header("x-server-dash-secret") ?? c.req.query("secret") ?? "";
  if (!j?.spec.webhook || !safeEqual(given, webhookSecret(id))) return problem(c, 404, "Not Found");
  const body = (await c.req.text()).slice(0, 256 * 1024);
  const r = startRun(id, "webhook", "webhook", c.get("trace"), body);
  audit("webhook", "job.webhook", id, r.ok ? "ok" : "failed", c.get("trace"));
  return r.ok ? c.json({ runId: r.runId, trace_id: r.trace.trace_id }, 202) : problem(c, 409, "Not started", r.error);
});

// Discover + install.
api.get("/catalog", (c) => {
  const q = c.req.query();
  return c.json(search({ q: q.q, category: q.category, genre: q.genre || undefined, tier: ["ready", "oneclick", "agent"].includes(q.tier ?? "") ? q.tier as never : undefined, fresh: q.fresh === "true", installable: q.installable === "true", scope: q.scope === "all" ? "all" : "selfhosted", sort: q.sort as never, limit: Number(q.limit) || 30, offset: Number(q.offset) || 0 }));
});
api.get("/catalog/categories", (c) => c.json({ categories: categories() }));
api.get("/catalog/genres", (c) => c.json({ genres: genres() }));
api.get("/catalog/home", (c) => c.json(home(runningCatalogIds())));
api.get("/catalog/sources", (c) => c.json({ sources: sourceStatus() }));
api.post("/catalog/refresh-recipes", requireAdmin, async (c) => c.json(await refreshRecipes()));
api.post("/catalog/refresh", requireAdmin, (c) => { void refreshCatalog(true); audit(c.get("actor"), "catalog.refresh", "", "ok", c.get("trace")); return c.json({ ok: true }, 202); });
api.get("/catalog/dockerhub", async (c) => c.json({ items: await dockerHub(c.req.query("q") ?? "") }));
// Apps on this server that are in the catalog: installed by Server OS, or already on the Apps tab under the same name.
function runningApps(): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of Object.values(getSlice<Record<string, { name: string; href: string }>>("apps") ?? {})) {
    const id = slugify(a.name.replace(/\s*\(.*\)$/, ""));
    if (getItem(id)) out.set(id, a.href ?? "");
  }
  for (const a of listInstalled()) out.set(a.ref && getItem(a.ref) ? a.ref : a.id, a.href);
  return out;
}
const runningCatalogIds = () => new Set(runningApps().keys());
api.get("/catalog/running", (c) => c.json({ apps: Object.fromEntries(runningApps()) }));
api.get("/catalog/:id", (c) => {
  const it = detail(c.req.param("id"));
  if (!it) return problem(c, 404, "Not Found", "No such catalog entry");
  const link = config.apps.link?.url.replaceAll("{id}", it.id) ?? null;
  return c.json({ ...it, installed: !!getInstalled(it.id), runningHref: runningApps().get(it.id) ?? null,
    installPreview: { address: link, agentSetup: config.apps.agentSetup && agentAvailable(), owner: config.owner.name } });
});
api.get("/recipes", (c) => c.json({ recipes: listRecipes() }));
api.get("/apps/installed", (c) => c.json({ apps: listInstalled() }));
api.post("/apps/plan", async (c) => {
  const b = await jsonBody(c);
  if (!b) return problem(c, 415, "Unsupported Media Type", "JSON only");
  try { return c.json(await makePlan(String(b.catalogId ?? ""), b.method as never)); } catch (e) { return problem(c, 422, "Can't install", (e as Error).message); }
});
api.post("/apps", async (c) => {
  const b = await jsonBody(c);
  if (!b) return problem(c, 415, "Unsupported Media Type", "JSON only");
  if (DEMO) { const it = detail(String(b.catalogId ?? "")); if (!it) return problem(c, 422, "Can't install", "unknown entry"); return c.json(await demoInstall(it.id, it.name, it.description, it.logo, it.category), 202); }
  try {
    const op = install(await makePlan(String(b.catalogId ?? ""), b.method as never), c.get("actor"), c.get("trace"),
      { agentSetup: typeof b.agentSetup === "boolean" ? b.agentSetup : undefined, note: String(b.note ?? "").slice(0, 2000) });
    return c.json(op, 202);
  } catch (e) { return problem(c, 422, "Can't install", (e as Error).message); }
});
api.delete("/apps/:id", (c) => {
  try { return c.json(uninstall(c.req.param("id"), c.req.query("purge") === "true", c.get("actor"), c.get("trace")), 202); }
  catch (e) { return problem(c, 404, "Not Found", (e as Error).message); }
});
// Delete any app that isn't a locked core service: Server OS installs uninstall; hand-catalog apps are taken apart.
api.get("/apps/delete-plan", (c) => c.json(deletePlan(c.req.query("name") ?? "")));
api.post("/apps/delete", async (c) => {
  const b = await jsonBody(c);
  if (!b) return problem(c, 415, "Unsupported Media Type", "JSON only");
  try { return c.json(deleteApp(String(b.name ?? ""), b.purge === true, c.get("actor"), c.get("trace")), 202); }
  catch (e) { return problem(c, 409, "Can't delete", (e as Error).message); }
});
api.get("/operations/:id", (c) => { const op = getOperation(c.req.param("id")); return op ? c.json(op) : problem(c, 404, "Not Found", "No such operation"); });
// The agent installs it in the background (an operation like any install); without Claude Code, a note in its inbox.
const agentInstallRoute = async (c: Context<Env>) => {
  const b = await jsonBody(c);
  if (!b) return problem(c, 415, "Unsupported Media Type", "JSON only");
  const id = String(b.catalogId ?? ""), note = String(b.note ?? "").slice(0, 2000);
  audit(c.get("actor"), "agent.ask", id, "ok", c.get("trace"));
  if (!agentAvailable()) return c.json({ ok: true, file: askAgent(id, note, c.get("actor")) }, 202);
  try { return c.json(agentInstall(id, note, c.get("actor"), c.get("trace")), 202); } catch (e) { return problem(c, 422, "Can't install", (e as Error).message); }
};
api.post("/apps/agent-install", agentInstallRoute);
api.post("/apps/ask-agent", agentInstallRoute); // older apps
api.post("/apps/:id/setup", async (c) => {
  const b = (await jsonBody(c)) ?? {};
  try { return c.json(setup(c.req.param("id"), c.get("actor"), c.get("trace"), String(b.note ?? "").slice(0, 2000)), 202); }
  catch (e) { return problem(c, 422, "Can't set up", (e as Error).message); }
});
// Secrets of installed apps: made by the agent (admin key), shown to the owner (paired device, or anyone when auth is off).
api.post("/apps/:id/secrets", requireAdmin, async (c) => {
  const b = await jsonBody(c);
  if (!b) return problem(c, 415, "Unsupported Media Type", "JSON only");
  try {
    const value = newSecret(c.req.param("id"), String(b.name ?? ""), Number(b.length) || 24);
    audit(c.get("actor"), "secret.create", `${c.req.param("id")}/${b.name}`, "ok", c.get("trace"));
    return c.json({ name: b.name, value });
  } catch (e) { return problem(c, 422, "Can't make the secret", (e as Error).message); }
});
api.get("/apps/:id/secrets", (c) => {
  if (config.auth === "token" && !["admin"].includes(c.get("actor")) && !c.get("device")) return problem(c, 403, "Forbidden", "Paired devices only");
  if (c.get("actor") === "agent") return problem(c, 403, "Forbidden", "The agent can't read secrets back");
  audit(c.get("actor"), "secret.read", c.req.param("id"), "ok", c.get("trace"));
  return c.json({ secrets: getSecrets(c.req.param("id")) });
});
// App logins (username + password) for the Apps page. Listing shows where they live (variable names); values are read
// only on reveal, which needs sign-in to be on and a signed-in owner or paired device, and is always audited.
const loginApp = (name: string) => {
  const it = findItem(name);
  if (it) return { name: it.name, docker: it.docker };
  const inst = listInstalled().find((a) => a.name === name);
  return inst ? { name: inst.name, docker: inst.docker } : null;
};
const mayReveal = (c: Context<Env>) => config.auth !== "off" && c.get("actor") !== "agent" && (!!c.get("device") || c.get("actor") === "admin");
api.get("/apps/:name/logins", async (c) => {
  const app = loginApp(c.req.param("name"));
  if (!app) return problem(c, 404, "Not Found", "Unknown app");
  return c.json({ logins: await listLogins(app), canReveal: mayReveal(c), authOff: config.auth === "off" });
});
api.post("/apps/:name/logins/reveal", async (c) => {
  const app = loginApp(c.req.param("name"));
  if (!app) return problem(c, 404, "Not Found", "Unknown app");
  if (config.auth === "off") return problem(c, 403, "Forbidden", "Turn on sign-in (auth: token) to show passwords");
  if (!mayReveal(c)) return problem(c, 403, "Forbidden", "Signed-in owner or paired devices only");
  const b = await jsonBody(c);
  const id = String(b?.id ?? "");
  const v = await revealLogin(app, id);
  audit(c.get("actor"), "login.reveal", `${app.name} ${id}`, v ? "ok" : "failed", c.get("trace"));
  if (!v) return problem(c, 404, "Not Found", "Unknown login");
  c.header("Cache-Control", "no-store");
  return c.json(v);
});
api.post("/apps/:name/logins/link", requireAdmin, async (c) => {
  const app = loginApp(c.req.param("name"));
  if (!app) return problem(c, 404, "Not Found", "Unknown app");
  const b = await jsonBody(c);
  if (!b) return problem(c, 415, "Unsupported Media Type", "JSON only");
  const err = linkLogin(app.name, b.unlink ? null : { passwordEnv: String(b.passwordEnv ?? ""), userEnv: b.userEnv ? String(b.userEnv) : undefined, user: b.user ? String(b.user) : undefined });
  audit(c.get("actor"), b.unlink ? "login.unlink" : "login.link", app.name, err ? "failed" : "ok", c.get("trace"));
  return err ? problem(c, 422, "Can't link", err) : c.json({ ok: true, detail: b.unlink ? "Unlinked" : "Linked" });
});
api.get("/logins/env-keys", requireAdmin, (c) => c.json(envKeyNames()));

// The agent plans and ticks its own steps on the install checklist the owner watches.
api.post("/apps/:id/checklist", async (c) => {
  const b = await jsonBody(c);
  if (!b) return problem(c, 415, "Unsupported Media Type", "JSON only");
  try { return c.json({ checklist: agentChecklist(c.req.param("id"), { plan: Array.isArray(b.plan) ? b.plan.map(String) : undefined, label: b.label ? String(b.label) : undefined, state: b.state as never, note: b.note ? String(b.note) : undefined }) }); }
  catch (e) { return problem(c, 404, "Not Found", (e as Error).message); }
});
api.post("/apps/:id/ready", async (c) => {
  const b = await jsonBody(c);
  if (!b) return problem(c, 415, "Unsupported Media Type", "JSON only");
  try {
    const r = setReady(c.req.param("id"), { url: String(b.url ?? ""), username: b.username ? String(b.username) : undefined, secret: b.secret ? String(b.secret) : undefined, summary: String(b.summary ?? ""), steps: Array.isArray(b.steps) ? b.steps : [] });
    audit(c.get("actor"), "app.ready", c.req.param("id"), "ok", c.get("trace"));
    return c.json(r);
  } catch (e) { return problem(c, 422, "Can't save the ready card", (e as Error).message); }
});

// JSON dashboards.
api.get("/dashboards", (c) => c.json({ dashboards: listDashboards() }));
api.get("/dashboards/schema", (c) => c.json(DASH_SCHEMA));
api.get("/dashboards/:id", (c) => { const d = getDashboard(c.req.param("id")); return d ? c.json(d) : problem(c, 404, "Not Found", "No such dashboard"); });
api.put("/dashboards/:id", async (c) => {
  const b = await jsonBody(c);
  if (!b) return problem(c, 415, "Unsupported Media Type", "JSON only");
  const err = saveDashboard(c.req.param("id"), b as never);
  audit(c.get("actor"), "dashboard.save", c.req.param("id"), err ? "failed" : "ok", c.get("trace"));
  return err ? problem(c, 422, "Invalid dashboard", err) : c.json(getDashboard(c.req.param("id")));
});
api.delete("/dashboards/:id", (c) => {
  const ok = deleteDashboard(c.req.param("id"));
  audit(c.get("actor"), "dashboard.delete", c.req.param("id"), ok ? "ok" : "failed", c.get("trace"));
  return ok ? c.body(null, 204) : problem(c, 404, "Not Found", "No such dashboard");
});

// Logs, traces, audit. /logs is the per-app log tail (older API); these are the server's own.
api.get("/logs/server", (c) => { const q = c.req.query(); return c.json({ logs: queryLogs({ level: q.level, q: q.q, trace: q.trace, since: q.since, limit: Number(q.limit) || 200 }) }); });
api.get("/logs/summary", (c) => c.json(errorSummary()));
api.get("/audit", (c) => { const q = c.req.query(); return c.json({ audit: queryAudit({ actor: q.actor, action: q.action, limit: Number(q.limit) || 100 }) }); });
api.get("/traces/:id", (c) => c.json(getTrace(c.req.param("id"))));
// Lets the agent (and other tools) write to the audit log under their own name.
api.post("/audit", async (c) => {
  const b = await jsonBody(c);
  if (!b) return problem(c, 415, "Unsupported Media Type", "JSON only");
  const actor = String(b.actor ?? c.get("actor")).slice(0, 60);
  audit(actor, String(b.action ?? "note").slice(0, 60), String(b.target ?? "").slice(0, 200), b.result === "failed" ? "failed" : "ok", c.get("trace"), typeof b.attributes === "object" && b.attributes ? b.attributes as Record<string, unknown> : {});
  return c.body(null, 204);
});

// Remote screen (server/modules/screen.ts): the Mac's Screen Sharing piped over a WebSocket to noVNC in the panel.
api.get("/screen", async (c) => {
  const cfg0 = screenConfig(), cfg = cfg0 && !DEMO ? await resolveScreen(cfg0) : cfg0;
  const listening = cfg && !DEMO ? await vncListening(cfg) : false;
  // Not listening: say what is installed and how to start a VNC server (Linux). Text only; nothing is run.
  const setup = !listening && !DEMO ? await detectScreen() : null;
  return c.json({ ...screenStatus(cfg), platform: process.platform, noun: screenNoun(), listening, setup });
});
/** Browsers send Origin on a WebSocket handshake: it must be this panel's own address (Host, or the proxy's X-Forwarded-Host). */
const sameOrigin = (c: Context<Env>) => {
  const o = c.req.header("origin");
  if (!o) return true; // not a browser: still needs a token below
  try { const h = new URL(o).host; return h === c.req.header("host") || h === c.req.header("x-forwarded-host"); } catch { return false; }
};
api.get("/screen/ws", async (c) => {
  const cfg0 = screenConfig(), cfg = cfg0 && !DEMO ? await resolveScreen(cfg0) : cfg0;
  if (!cfg || DEMO) return problem(c, 404, "Not Found", "The remote screen is off. Set integrations.screen.enabled in config/server-os.yaml.");
  // The owner only: the local admin key or a paired device / signed-in browser. Never anonymous, never the agent.
  if (c.get("actor") !== "admin" && !c.get("device")) return problem(c, 403, "Forbidden", "Needs a paired device or the admin key.");
  if (!sameOrigin(c)) { audit(c.get("actor"), "screen.open", `${cfg.host}:${cfg.port}`, "failed", c.get("trace"), { reason: "origin" }); return problem(c, 403, "Forbidden", "Wrong origin"); }
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return problem(c, 426, "Upgrade Required", "Open this with a WebSocket.");
  const r = upgradeScreen(c.req.raw, c.env as Server<ScreenData>, { actor: c.get("actor"), ip: clientIp(c), trace: c.get("trace"), cfg, res: parseRes(c.req.query("res")) }, c.req.query("takeover") === "1");
  if (r?.status === 409) audit(c.get("actor"), "screen.open", `${cfg.host}:${cfg.port}`, "failed", c.get("trace"), { reason: "busy" });
  return r ?? new Response(null);
});

/** The viewer's resolution control: native | 1080p | 720p for the open session. Owner only, like the socket. */
api.post("/screen/resolution", async (c) => {
  if (!screenConfig() || DEMO) return problem(c, 404, "Not Found", "The remote screen is off.");
  if (c.get("actor") !== "admin" && !c.get("device")) return problem(c, 403, "Forbidden", "Needs a paired device or the admin key.");
  if (!sameOrigin(c)) return problem(c, 403, "Forbidden", "Wrong origin");
  const res = parseRes(((await c.req.json().catch(() => ({}))) as { res?: unknown }).res);
  if (!res) return problem(c, 400, "Bad Request", "res must be native, 1080p or 720p.");
  const r = await setResolution(res);
  if (r === false) return problem(c, 409, "No session", "Open the remote screen first.");
  return c.json({ res, result: r.result, why: r.why, message: r.message, display: r.display });
});
/** Which sizes the display really offers, for the Size buttons. Read-only. */
api.get("/screen/resolution", async (c) => {
  if (!screenConfig() || DEMO) return problem(c, 404, "Not Found", "The remote screen is off.");
  if (c.get("actor") !== "admin" && !c.get("device")) return problem(c, 403, "Forbidden", "Needs a paired device or the admin key.");
  return c.json(await resolutionOptions());
});

// v1-only: server info, pairing, devices.
const CAPABILITIES = ["system", "update", "history", "apps", "jobs", "scheduler", "webhooks", "catalog", "install", "logs-traces", "audit", "dashboards", "ports", "alerts", "logs", "claude", "pairing", ...(process.platform === "darwin" || process.platform === "linux" ? ["permissions"] : []),
  ...(BOTS_PROVIDER || DEMO ? ["bots"] : []), ...(storageAvailable() ? ["storage"] : []), ...(agentAvailable() ? ["agent"] : []), "voice", ...(houseVoiceAvailable() ? ["houseVoice"] : []), ...(screenConfig() && !DEMO ? ["screen"] : []), ...(voiceSessionAvailable() ? ["voiceSession"] : [])];
// addresses: where this panel answers (Caddy names → this port), so the panel and the apps can show "open on other devices".
api.get("/info", (c) => c.json({ name: config.name, version: VERSION, api: "v1", auth: config.auth, platform: process.platform, capabilities: CAPABILITIES, addresses: panelAddresses(PORT) }));
// Liveness for the self-updater's health check (and load balancers): open, cheap, says which version answers.
const STARTED = Date.now();
api.get("/health", (c) => c.json({ ok: true, version: VERSION, uptimeS: Math.round((Date.now() - STARTED) / 1000) }));

// Self-update (server/modules/update.ts): status + check for anyone signed in; apply and settings need the owner.
api.get("/update", (c) => c.json(updateStatus()));
api.post("/update/check", async (c) => {
  const s = await checkForUpdate({ manual: true });
  audit(c.get("actor"), "update.check", s.latest?.tag ?? "", s.checkError ? "failed" : "ok", c.get("trace"), s.checkError ? { error: s.checkError } : {});
  return c.json(s);
});
api.post("/update/apply", requireAdmin, (c) => {
  if (DEMO) return problem(c, 409, "Not available", "Updates are off in the demo");
  const r = applyUpdate(c.get("actor"), c.get("trace"));
  return r.ok ? c.json({ ...updateStatus(), started: r.to }, 202) : problem(c, 409, "Can't update", r.error);
});
api.put("/update/settings", requireAdmin, async (c) => {
  const b = await jsonBody(c);
  if (!b) return problem(c, 415, "Unsupported Media Type", "JSON only");
  const r = saveUpdateSettings(b, c.get("actor"), c.get("trace"));
  return typeof r === "string" ? problem(c, 422, "Invalid settings", r) : c.json(updateStatus());
});
api.post("/pair/start", requireAdmin, (c) => {
  const p = startPairing();
  audit(c.get("actor"), "pair.start", "", "ok", c.get("trace"));
  return c.json(p);
});
api.post("/pair", async (c) => {
  const b = await jsonBody(c);
  if (!b) return problem(c, 415, "Unsupported Media Type", "JSON only");
  const web = b.web === true;
  const r = completePairing(String(b.code ?? ""), String(b.name ?? ""), web ? "web" : String(b.platform ?? ""));
  audit(r.ok ? `device:${r.device.id}` : "anonymous", "pair.complete", r.ok ? r.device.name : "", r.ok ? "ok" : "failed", c.get("trace"));
  if (!r.ok) return problem(c, 400, "Pairing failed", r.error);
  // A browser keeps the token in an HttpOnly cookie (never readable by page scripts); apps get it in the body.
  if (web) { c.header("Set-Cookie", signInCookie(c, r.token)); return c.json({ device: r.device }); }
  return c.json({ device: r.device, token: r.token });
});
// A browser on the server itself talks to us directly; everything through Caddy / Tailscale Serve carries X-Forwarded-For.
const onServer = (c: Context<Env>) => {
  if (c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || c.req.header("forwarded")) return false;
  try { const a = getConnInfo(c).remote.address ?? ""; return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1"; } catch { return false; }
};
/** The caller's address: the proxy's X-Forwarded-For (we only listen on loopback, so only a local proxy can set it), else the socket. */
const clientIp = (c: Context<Env>) => (c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? (() => { try { return getConnInfo(c).remote.address ?? ""; } catch { return ""; } })()).replace(/^::ffff:/, "");
/** Home network or tailnet: 10/8, 172.16/12, 192.168/16, 100.64/10 (Tailscale), loopback, IPv6 ULA / link-local. */
const onPrivateNetwork = (ip: string) =>
  /^(10\.|192\.168\.|127\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip) || ip === "::1" || /^f[cd][0-9a-f]{2}:/i.test(ip) || /^fe80:/i.test(ip);
const clientKey = (c: Context<Env>) => c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? (() => { try { return getConnInfo(c).remote.address ?? "?"; } catch { return "?"; } })();
/** A signed-in browser is a paired device: it gets its own token, in an HttpOnly cookie. */
const browserDevice = (c: Context<Env>, name: string) => {
  const r = issueDevice(name || "Browser", "web");
  c.header("Set-Cookie", signInCookie(c, r.token));
  return r.device;
};

// Who is calling: lets the web panel choose between the dashboard, the sign-in form and "create the owner".
api.get("/auth/me", (c) => {
  const owner = hasOwner();
  const signedIn = config.auth === "off" || c.get("actor") === "admin" || !!c.get("device");
  const token = c.req.query("setup") ?? "";
  return c.json({ auth: config.auth, signedIn, owner, ownerName: signedIn ? ownerName() : null, device: c.get("device"),
    canClaim: !owner && (onServer(c) || onPrivateNetwork(clientIp(c)) || (!!token && token === setupToken())) });
});
// First visit: create the owner account (only on the server itself or with the installer's setup link).
api.post("/auth/setup", async (c) => {
  const b = await jsonBody(c);
  if (!b) return problem(c, 415, "Unsupported Media Type", "JSON only");
  if (hasOwner()) return problem(c, 409, "Already set up", "This server already has an owner — sign in instead.");
  const t = String(b.setupToken ?? "");
  // First visit from home: any device on the home network or tailnet may create the owner; from outside, only with the setup link.
  if (!onServer(c) && !onPrivateNetwork(clientIp(c)) && !(t && t === setupToken())) return problem(c, 403, "Forbidden", "Open the panel from your home network, or use the setup link the installer printed.");
  const err = await createOwner(String(b.username ?? "").trim(), String(b.password ?? ""));
  audit(String(b.username ?? ""), "owner.create", "", err ? "failed" : "ok", c.get("trace"));
  if (err) return problem(c, 422, "Can't create the account", err);
  return c.json({ device: browserDevice(c, String(b.deviceName ?? "Browser")) });
});
// Sign in with the owner's username + password; this browser becomes a paired device (cookie).
api.post("/auth/login", async (c) => {
  const b = await jsonBody(c);
  if (!b) return problem(c, 415, "Unsupported Media Type", "JSON only");
  const key = clientKey(c);
  if (tooManyAttempts(key)) return problem(c, 429, "Too many attempts", "Wait 15 minutes and try again.");
  const ok = await verifyOwner(String(b.username ?? "").trim(), String(b.password ?? ""));
  audit(String(b.username ?? "").slice(0, 60), "auth.login", key, ok ? "ok" : "failed", c.get("trace"));
  if (!ok) { noteFailure(key); return problem(c, 401, "Sign-in failed", "Wrong username or password."); }
  clearFailures(key);
  const web = b.web !== false;
  if (web) return c.json({ device: browserDevice(c, String(b.deviceName ?? "Browser")) });
  // Apps: same check, a token in the body instead of a cookie.
  return c.json(issueDevice(String(b.deviceName ?? "Device"), String(b.platform ?? "ios")));
});
api.post("/auth/password", async (c) => {
  if (c.get("actor") === "anonymous") return problem(c, 401, "Unauthorized", "Sign in first");
  const b = await jsonBody(c);
  if (!b) return problem(c, 415, "Unsupported Media Type", "JSON only");
  const err = await changePassword(String(b.current ?? ""), String(b.next ?? ""));
  audit(c.get("actor"), "owner.password", "", err ? "failed" : "ok", c.get("trace"));
  return err ? problem(c, 422, "Can't change it", err) : c.body(null, 204);
});
// Sign out this browser/device: forget the token server-side and drop the cookie.
api.post("/auth/logout", (c) => {
  const d = c.get("device");
  if (d) { revoke(d.id); audit(`device:${d.id}`, "device.signout", d.name, "ok", c.get("trace")); }
  c.header("Set-Cookie", signOutCookie());
  return c.body(null, 204);
});
api.get("/devices", requireAdmin, (c) => c.json({ devices: listDevices() }));
api.delete("/devices/:id", requireAdmin, (c) => {
  const ok = revoke(c.req.param("id"));
  audit(c.get("actor"), "device.revoke", c.req.param("id"), ok ? "ok" : "failed", c.get("trace"));
  return ok ? c.body(null, 204) : problem(c, 404, "Not Found", "No such device");
});
app.route("/api/v1", api);
app.route("/svc-api", api);
app.all("/api/*", (c) => problem(c, 404, "Not Found", `No route ${c.req.method} ${c.req.path}`));
app.onError((e, c) => { logEvent("error", String(e), { stack: e.stack }, c.get("trace")); return problem(c, 500, "Internal Server Error"); });

app.get("/storage", (c) => c.redirect("/#storage")); // old bookmark → the Storage tab

app.get("/icons/*", (c) => {
  const rel = normalize(c.req.path.replace(/^\/icons\//, ""));
  if (rel.startsWith("..")) return c.notFound();
  // installed/<file>: logos the installer downloaded into <home>/data/icons
  const f = rel.startsWith("installed/") ? Bun.file(join(dir("data"), "icons", rel.slice(10))) : Bun.file(join(SVC, "icons", rel));
  return new Response(f, { headers: { "Cache-Control": "max-age=86400" } });
});

app.get("*", (c) => {
  const p = normalize(c.req.path).replace(/^\/+/, "");
  const file = p && !p.startsWith("..") && existsSync(join(DIST, p)) ? join(DIST, p) : join(DIST, "index.html");
  const html = file.endsWith(".html");
  return new Response(Bun.file(file), { headers: { "Cache-Control": html ? "no-store" : "max-age=31536000, immutable" } });
});

if (DEMO) startDemo(); // made-up data, no collectors touch the machine
else {
startAppCollectors();
startSystemCollectors();
startConsumerCollector(every);
startOpsCollectors();
}
startScheduler();
if (!DEMO) startUpdater();
startCatalog();
startInstaller();
ensureDefault();
onAppsChanged(() => computeApps());
onJobsChange(() => void refreshJobs());
if (!DEMO) every(30_000, refreshJobs);
if (!DEMO) { every(15_000, houseVoiceWatchdog);
startLifecycle(); }
// Bot sessions (Claude OS or native), pushed like every other slice.
if (COS && !DEMO) every(5_000, async () => {
  try { const r = await fetch(`${COS}/botSessions`, { signal: AbortSignal.timeout(8000) }); if (r.ok) cosBots = ((await r.json()).botSessions ?? []).map((b: object) => ({ ...b, provider: "claudeOS" })); }
  catch { cosBots = null; }
  pushBots();
});
if (NATIVE) every(3_000, pushBots);
if (NATIVE && !DEMO) every(30_000, () => rearmWatchers(NATIVE));
// Listening ports joined with apps, Docker maps and Caddy names (the Ports page).
if (!DEMO) every(30_000, async () => { setSlice("ports", await collectPorts(appRefs())); });
// Claude account usage limits + every running Claude process.
if (!DEMO) startClaudeCollectors();

// HOST=0.0.0.0 to serve the LAN directly; by default only a local proxy (Caddy, Tailscale Serve) reaches it.
export default { port: PORT, hostname: process.env.HOST || "127.0.0.1", fetch: app.fetch, idleTimeout: 0, websocket: screenSocket };
console.log(`server-os on http://127.0.0.1:${PORT}`);
// Remote screen: heal a display left small by a crashed run, and put it back on shutdown.
if (!DEMO) { void recoverDisplay(); for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => void shutdownScreen().finally(() => process.exit(0))); }
// No owner yet: print the one-time link that lets a browser elsewhere create it (the installer shows it too).
{ const t = setupToken(); if (t) console.log(`Set up this server: http://<this server>:${PORT}/?setup=${t}  (or open http://localhost:${PORT} on the server itself)`); }
