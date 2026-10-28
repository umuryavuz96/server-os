#!/usr/bin/env bun
// server-os MCP server (stdio). Gives the root Claude Code agent the Server OS API as tools, so every change
// the agent makes goes through the same validated, logged, audited path as the panel and the apps.
//
// Self-contained on purpose (no packages): it is copied into <home>/agent/.claude/mcp/ and run with Bun.
// Protocol: MCP over stdio — newline-delimited JSON-RPC 2.0 (spec 2025-06-18): initialize, tools/list, tools/call, ping.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const HOME = process.env.SERVER_OS_HOME ?? process.env.SERVER_DASH_HOME ?? resolve(import.meta.dir, "../../.."); // <home>/agent/.claude/mcp → <home>
const port = (() => {
  try { return Number(/^port:\s*(\d+)/m.exec(readFileSync(join(HOME, existsSync(join(HOME, "config/server-os.yaml")) ? "config/server-os.yaml" : "config/server-dash.yaml"), "utf8"))?.[1]) || 3094; } catch { return 3094; }
})();
const BASE = process.env.SERVER_OS_URL ?? process.env.SERVER_DASH_URL ?? `http://127.0.0.1:${port}/api/v1`;
const KEY_FILE = join(HOME, "data/admin.key");
// A background run started by the server (installer) passes its operation's trace, so its calls group under it.
const TRACE = process.env.SERVER_OS_TRACEPARENT ?? process.env.SERVER_DASH_TRACEPARENT ?? "";
const key = () => (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, "utf8").trim() : "");

async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${key()}`, "X-Actor": "agent", ...(TRACE ? { traceparent: TRACE } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await r.text();
  if (!r.ok) {
    let detail = text;
    try { const j = JSON.parse(text); detail = j.detail ?? j.title ?? j.error ?? text; } catch { /* plain text */ }
    throw new Error(`${method} ${path} → ${r.status}: ${detail}`);
  }
  return text ? JSON.parse(text) : { ok: true };
}
const qs = (o: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "" && v !== null) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

type Schema = { type: "object"; properties: Record<string, unknown>; required?: string[] };
interface Tool { name: string; description: string; inputSchema: Schema; run: (a: any) => Promise<unknown> }
const S = (properties: Record<string, unknown> = {}, required: string[] = []): Schema => ({ type: "object", properties, required });
const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });
const bool = (description: string) => ({ type: "boolean", description });

const JOB_FIELDS = {
  name: str("Display name"), kind: { type: "string", enum: ["command", "claude", "http"] },
  schedule: str('5-field cron ("0 8 * * *") or "@every 10m"; empty = manual/webhook only'),
  command: str("command kind: shell command (sh -c)"), prompt: str("claude kind: the prompt for `claude -p`"),
  allowedTools: { type: "array", items: { type: "string" }, description: "claude kind: tools it may use, e.g. [\"Bash(df *)\"]" },
  url: str("http kind: URL to check"), expect: num("http kind: expected status (default 200)"),
  timeout: num("seconds (default 3600)"), enabled: bool("false = paused"), webhook: bool("expose POST /api/v1/hooks/<id>"),
  about: str("one line for the job's ID card"), category: str("grouping label"),
};

const TOOLS: Tool[] = [
  { name: "server_info", description: "Server name, version, auth mode and capabilities.", inputSchema: S(), run: () => call("GET", "/info") },
  { name: "update_status", description: "Server OS's own updater: running version, latest release + notes, whether it can apply here (blocked says why not: git checkout, Homebrew, Docker), progress and the last outcome.", inputSchema: S(), run: () => call("GET", "/update") },
  { name: "update_check", description: "Ask GitHub for a new Server OS release now; returns the same as update_status.", inputSchema: S(), run: () => call("POST", "/update/check") },
  { name: "update_apply", description: "Install the latest Server OS release: verify signature, switch, restart, roll back on failure. Ask the owner first. The restart drops this connection; check update_status after a minute.", inputSchema: S(), run: () => call("POST", "/update/apply") },
  { name: "server_status", description: "Compact health overview: system vitals, apps that are off or unhealthy, failing jobs, Claude usage. Start here.", inputSchema: S(), run: async () => {
    const s = await call("GET", "/state");
    const apps = Object.values<any>(s.apps ?? {});
    return {
      system: s.system,
      apps: { total: apps.length, off: apps.filter((a) => a.state === "off").map((a) => a.name), partlyOn: apps.filter((a) => a.state === "part").map((a) => a.name),
        unhealthy: Object.entries<any>(s.life ?? {}).filter(([, l]) => l.healthy === false).map(([n]) => n) },
      jobs: { total: (s.jobs ?? []).length, failing: (s.jobs ?? []).filter((j: any) => j.status === "fail").map((j: any) => ({ id: j.id, name: j.name, cause: j.cause })) },
      claudeUsage: s.claudeUsage ?? null,
      operations: (s.operations ?? []).filter((o: any) => o.status === "running"),
    };
  } },
  { name: "list_apps", description: "Every app with its state (on/off/part), kind, RAM and parts (containers / services).", inputSchema: S(), run: async () => Object.values((await call("GET", "/state")).apps ?? {}) },
  { name: "set_app_power", description: "Switch an app on or off (Docker containers, launchd services, gated sites). Ask the user before stopping anything they rely on.", inputSchema: S({ name: str("App name exactly as listed"), on: bool("true = start, false = stop") }, ["name", "on"]), run: (a) => call("POST", "/toggle", { name: a.name, on: a.on }) },
  { name: "app_logs", description: "Recent log lines of an app.", inputSchema: S({ app: str("App name") }, ["app"]), run: (a) => call("GET", `/logs${qs({ app: a.app })}`) },

  { name: "search_catalog", description: "Search the Discover catalog (awesome-selfhosted, CasaOS, LinuxServer, Homebrew, recipes). Each result lists its install options.", inputSchema: S({ q: str("search words"), category: str("exact category"), installable: bool("only entries with an automatic install"), scope: { type: "string", enum: ["selfhosted", "all"] }, limit: num("default 10") }), run: (a) => call("GET", `/catalog${qs({ ...a, limit: a.limit ?? 10 })}`) },
  { name: "catalog_entry", description: "One catalog entry with links, license and install options.", inputSchema: S({ id: str("catalog id") }, ["id"]), run: (a) => call("GET", `/catalog/${encodeURIComponent(a.id)}`) },
  { name: "plan_install", description: "Dry run: the exact compose file / Homebrew package an install would use. No changes.", inputSchema: S({ catalogId: str("catalog id"), method: { type: "string", enum: ["recipe", "casaos", "linuxserver", "brew", "cask"] } }, ["catalogId"]), run: (a) => call("POST", "/apps/plan", a) },
  { name: "install_app", description: "Install an app from the catalog. Returns an operation; poll operation_status until it is ok or failed.", inputSchema: S({ catalogId: str("catalog id"), method: { type: "string", enum: ["recipe", "casaos", "linuxserver", "brew", "cask"] } }, ["catalogId"]), run: (a) => call("POST", "/apps", a) },
  { name: "uninstall_app", description: "Remove an installed app. Data is kept unless purge is true — never purge without the user's explicit yes.", inputSchema: S({ id: str("installed app id"), purge: bool("also delete its data folder") }, ["id"]), run: (a) => call("DELETE", `/apps/${encodeURIComponent(a.id)}${qs({ purge: a.purge ? "true" : undefined })}`) },
  { name: "operation_status", description: "Progress and output of an install/uninstall operation.", inputSchema: S({ id: str("operation id") }, ["id"]), run: (a) => call("GET", `/operations/${encodeURIComponent(a.id)}`) },
  { name: "reload_recipes", description: "Re-read recipes after writing one in ../config/recipes/, so search_catalog and install_app see it right away.", inputSchema: S(), run: () => call("POST", "/catalog/refresh-recipes") },
  { name: "new_secret", description: "Make a random password for an installed app and store it with the app (the owner sees it on the ready card). Returns the value — use it to configure the app; never print it in your answer.", inputSchema: S({ app: str("installed app id"), name: str("e.g. admin_password, admin_token"), length: num("default 24") }, ["app", "name"]), run: (a) => call("POST", `/apps/${encodeURIComponent(a.app)}/secrets`, { name: a.name, length: a.length }) },
  { name: "plan_steps", description: "Background runs: set the checklist the owner watches for this app's install/setup — short plain steps in order (\"Create your admin account\", \"Add the media folders\"). Call once at the start; steps already done are kept.", inputSchema: S({ app: str("app id"), steps: { type: "array", items: { type: "string" }, description: "3–8 short steps" } }, ["app", "steps"]), run: (a) => call("POST", `/apps/${encodeURIComponent(a.app)}/checklist`, { plan: a.steps }) },
  { name: "check_step", description: "Background runs: tick a checklist step as you go — state doing when you start it, done (with a short note the owner reads, e.g. \"admin umur created\") when finished, skipped or failed with the reason. A step not in the plan is added.", inputSchema: S({ app: str("app id"), step: str("the step's label"), state: { type: "string", enum: ["doing", "done", "skipped", "failed"] }, note: str("one short line for the owner; never a password") }, ["app", "step"]), run: (a) => call("POST", `/apps/${encodeURIComponent(a.app)}/checklist`, { label: a.step, state: a.state ?? "done", note: a.note }) },
  { name: "report_ready", description: "Finish an app's setup: the ready card the owner sees — where to open it, how to log in, what is left for them. Call once at the end of every install/setup, also when steps are left.", inputSchema: S({ app: str("installed app id"), url: str("address to open, e.g. its href"), username: str("login name, if you made one"), secret: str("name of the new_secret holding the password"), summary: str("one or two plain sentences: what is set up"), steps: { type: "array", items: { type: "string" }, description: "what the owner still has to do, short imperative lines; empty if nothing" } }, ["app", "url", "summary"]), run: ({ app, ...rest }) => call("POST", `/apps/${encodeURIComponent(app)}/ready`, rest) },
  { name: "list_recipes", description: "Curated and user recipes (<home>/config/recipes/*.yaml).", inputSchema: S(), run: () => call("GET", "/recipes") },

  { name: "list_jobs", description: "All jobs: built-in (id sd:<id>, editable) and crontab ones (read-only), with status, schedule and next run.", inputSchema: S(), run: async () => (await call("GET", "/state")).jobs ?? [] },
  { name: "get_job", description: "A built-in job's definition.", inputSchema: S({ id: str("job id without the sd: prefix") }, ["id"]), run: (a) => call("GET", `/jobs/${encodeURIComponent(a.id)}`) },
  { name: "create_job", description: "Create a built-in job (command, claude prompt or http check) with an optional schedule and webhook.", inputSchema: S({ id: str("optional slug"), ...JOB_FIELDS }, ["name", "kind"]), run: (a) => call("POST", "/jobs", a) },
  { name: "update_job", description: "Change fields of a built-in job (send only what changes; enabled:false pauses it).", inputSchema: S({ id: str("job id"), ...JOB_FIELDS }, ["id"]), run: ({ id, ...rest }) => call("PUT", `/jobs/${encodeURIComponent(id)}`, rest) },
  { name: "delete_job", description: "Delete a built-in job and its history. Ask first.", inputSchema: S({ id: str("job id") }, ["id"]), run: (a) => call("DELETE", `/jobs/${encodeURIComponent(a.id)}`) },
  { name: "run_job", description: "Run a job now (built-in: id or sd:<id>; crontab: cron:<n>).", inputSchema: S({ id: str("job id") }, ["id"]), run: (a) => String(a.id).startsWith("cron:") ? call("POST", "/jobs/run", { id: a.id }) : call("POST", `/jobs/${encodeURIComponent(String(a.id).replace(/^sd:/, ""))}/run`) },
  { name: "job_runs", description: "Recent runs of a built-in job with output, exit code and trace id.", inputSchema: S({ id: str("job id"), limit: num("default 10") }, ["id"]), run: (a) => call("GET", `/jobs/${encodeURIComponent(a.id)}/runs${qs({ limit: a.limit ?? 10 })}`) },
  { name: "job_webhook", description: "Webhook URL + secret of a job that has webhook: true.", inputSchema: S({ id: str("job id") }, ["id"]), run: (a) => call("GET", `/jobs/${encodeURIComponent(a.id)}/webhook`) },

  { name: "query_metric", description: "Metric history as fixed-step buckets (avg/min/max). Metrics: cpu (°C), ram (GB), swap (GB), load, disk (% used), net (Mb/s).", inputSchema: S({ metric: { type: "string", enum: ["cpu", "ram", "swap", "load", "disk", "net"] }, range: { type: "string", enum: ["1h", "2h", "6h", "24h", "7d", "30d", "90d"] }, points: num("buckets, default 24") }, ["metric"]), run: (a) => call("GET", `/history${qs({ metric: a.metric, range: a.range ?? "24h", points: a.points ?? 24 })}`) },
  { name: "read_logs", description: "The server's structured log, newest first. Filter by level, text or trace id.", inputSchema: S({ level: { type: "string", enum: ["debug", "info", "warn", "error"] }, q: str("text filter"), trace: str("trace id"), limit: num("default 50") }), run: (a) => call("GET", `/logs/server${qs({ ...a, limit: a.limit ?? 50 })}`) },
  { name: "error_summary", description: "Errors and warnings of the last 24 h, grouped.", inputSchema: S(), run: () => call("GET", "/logs/summary") },
  { name: "get_trace", description: "Everything that happened under one trace id: log lines, audit entries, job runs.", inputSchema: S({ id: str("trace id") }, ["id"]), run: (a) => call("GET", `/traces/${encodeURIComponent(a.id)}`) },
  { name: "alerts", description: "Notifications of the last day (or 7 days).", inputSchema: S({ days: { type: "number", enum: [1, 7] } }), run: (a) => call("GET", `/alerts${qs({ days: a.days ?? 1 })}`) },
  { name: "audit_note", description: "Write an entry to the audit log (actor 'agent') — for changes made outside these tools, e.g. editing a config file.", inputSchema: S({ action: str("short verb.noun, e.g. config.edit"), target: str("what was changed"), result: { type: "string", enum: ["ok", "failed"] } }, ["action", "target"]), run: (a) => call("POST", "/audit", { actor: "agent", ...a }) },
];

// ---------- JSON-RPC over stdio ----------
const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const fail = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(m: { id?: unknown; method?: string; params?: any }) {
  const isRequest = m.id !== undefined && m.id !== null;
  switch (m.method) {
    case "initialize":
      return reply(m.id, {
        protocolVersion: m.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "server-os", version: "0.1.0" },
        instructions: "Tools to run this Server OS server: status, apps (power, install from the catalog), jobs (create/run/schedule), metrics, logs and traces. Every call is logged and audited.",
      });
    case "ping": return reply(m.id, {});
    case "tools/list": return reply(m.id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const t = TOOLS.find((x) => x.name === m.params?.name);
      if (!t) return fail(m.id, -32602, `unknown tool ${m.params?.name}`);
      try {
        const out = await t.run(m.params?.arguments ?? {});
        return reply(m.id, { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out, null, 2) }] });
      } catch (e) {
        return reply(m.id, { content: [{ type: "text", text: String((e as Error).message ?? e) }], isError: true });
      }
    }
    default:
      if (isRequest) return fail(m.id, -32601, `method not found: ${m.method}`);
      // notifications (initialized, cancelled, …) need no answer
  }
}

let buf = "";
const pending = new Set<Promise<void>>();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg: any;
    try { msg = JSON.parse(line); } catch { fail(null, -32700, "parse error"); continue; }
    for (const m of Array.isArray(msg) ? msg : [msg]) { const p = handle(m).finally(() => pending.delete(p)); pending.add(p); }
  }
});
process.stdin.on("end", async () => { await Promise.allSettled([...pending]); process.exit(0); }); // finish answering, then go
