// Built-in scheduler. One folder per job: <home>/jobs/<id>/job.yaml.
// Kinds: command (sh -c), claude (`claude -p` with the user's subscription, run in the agent folder),
// http (a check that expects a status). Triggers: a schedule (5-field cron or "@every 10m"), run-now, and an
// optional webhook (POST /api/v1/hooks/<id> with the job's secret). Every run is recorded in SQLite with
// its output, exit code, duration and trace id.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dir } from "../core/config";
import { db, schema } from "../core/db";
import { logEvent, newTrace, type Trace } from "../core/logger";
import { HOME } from "../lib";
import { humanSchedule, nextRun, prevRun } from "../ops";

export type JobKind = "command" | "claude" | "http";
export interface JobSpec {
  name: string;
  kind: JobKind;
  /** 5-field cron ("*\/5 * * * *") or "@every 10m" / "@every 2h"; empty = only run-now / webhook. */
  schedule?: string;
  command?: string;
  prompt?: string;
  /** claude kind: tools the run may use without asking, e.g. ["Bash(df *)", "Read"]. */
  allowedTools?: string[];
  url?: string;
  expect?: number;
  cwd?: string;
  timeout?: number;
  enabled?: boolean;
  webhook?: boolean;
  about?: string;
  category?: string;
}
export interface Run {
  id: number; job: string; trigger: string; actor: string; started: number; ended: number | null;
  exitCode: number | null; ok: boolean | null; durationMs: number | null; output: string; traceId: string;
}

schema(
  `CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, job TEXT NOT NULL, trigger TEXT NOT NULL, actor TEXT NOT NULL,
    started INTEGER NOT NULL, ended INTEGER, exit_code INTEGER, ok INTEGER, duration_ms INTEGER,
    output TEXT NOT NULL DEFAULT '', trace_id TEXT NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS runs_job ON runs (job, started DESC)",
);

const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MAX_OUTPUT = 64 * 1024;
const jobsDir = () => dir("jobs");
const jobFile = (id: string) => join(jobsDir(), id, "job.yaml");
const secretFile = (id: string) => join(jobsDir(), id, ".secret");

// ---------- schedule ----------
const EVERY = /^@every\s+(\d+)\s*(s|m|h|d)$/;
const UNIT = { s: 1, m: 60, h: 3600, d: 86400 } as const;
const CRON_FIELD = /^(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*$/;

export function validSchedule(s: string): boolean {
  if (EVERY.test(s)) return true;
  const p = s.trim().split(/\s+/);
  return p.length === 5 && p.every((f) => CRON_FIELD.test(f));
}
const everySeconds = (s: string) => { const m = EVERY.exec(s); return m ? Math.max(10, +m[1] * UNIT[m[2] as keyof typeof UNIT]) : null; };

/** Next due time (unix s) after `last` run start (for @every) or after now (cron). */
export function nextDue(schedule: string, lastStart: number | null, now = Date.now() / 1000): number | null {
  const iv = everySeconds(schedule);
  if (iv) return lastStart ? Math.max(lastStart + iv, now) : now + iv;
  return nextRun(schedule, new Date(now * 1000));
}
export function describeSchedule(s: string | undefined): string {
  if (!s) return "manual";
  const iv = everySeconds(s);
  if (iv) return iv % 86400 === 0 ? `every ${iv / 86400} d` : iv % 3600 === 0 ? `every ${iv / 3600} h` : iv % 60 === 0 ? `every ${iv / 60} min` : `every ${iv} s`;
  return humanSchedule(s);
}

// ---------- specs on disk ----------
export function validate(spec: Partial<JobSpec>): string | null {
  if (!spec.name?.trim()) return "name is required";
  if (!["command", "claude", "http"].includes(spec.kind ?? "")) return "kind must be command, claude or http";
  if (spec.kind === "command" && !spec.command?.trim()) return "command is required";
  if (spec.kind === "claude" && !spec.prompt?.trim()) return "prompt is required";
  if (spec.kind === "http" && !/^https?:\/\//.test(spec.url ?? "")) return "url must start with http:// or https://";
  if (spec.schedule && !validSchedule(spec.schedule)) return `bad schedule "${spec.schedule}" — use 5-field cron or "@every 10m"`;
  if (spec.timeout != null && !(spec.timeout > 0 && spec.timeout <= 86400)) return "timeout must be 1–86400 seconds";
  return null;
}

const KEYS: (keyof JobSpec)[] = ["name", "kind", "schedule", "command", "prompt", "allowedTools", "url", "expect", "cwd", "timeout", "enabled", "webhook", "about", "category"];
const clean = (spec: Partial<JobSpec>) => Object.fromEntries(KEYS.filter((k) => spec[k] !== undefined && spec[k] !== "").map((k) => [k, spec[k]])) as unknown as JobSpec;

export function listSpecs(): { id: string; spec: JobSpec; error?: string }[] {
  if (!existsSync(jobsDir())) return [];
  return readdirSync(jobsDir()).filter((id) => ID.test(id) && existsSync(jobFile(id))).sort().map((id) => {
    try {
      const spec = clean((Bun.YAML.parse(readFileSync(jobFile(id), "utf8")) ?? {}) as Partial<JobSpec>);
      return { id, spec, error: validate(spec) ?? undefined };
    } catch (e) { return { id, spec: { name: id, kind: "command" } as JobSpec, error: `job.yaml: ${String(e)}` }; }
  });
}
export const getSpec = (id: string) => listSpecs().find((j) => j.id === id) ?? null;

export const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "job";

export function saveSpec(id: string, spec: Partial<JobSpec>): { ok: true; id: string } | { ok: false; error: string } {
  if (!ID.test(id)) return { ok: false, error: "id: lowercase letters, digits and dashes" };
  const c = clean(spec);
  const err = validate(c);
  if (err) return { ok: false, error: err };
  mkdirSync(join(jobsDir(), id), { recursive: true });
  writeFileSync(jobFile(id), `# Server OS job — edit here or in the panel/app.\n${Bun.YAML.stringify(c, null, 2)}\n`);
  if (c.webhook) webhookSecret(id);
  reschedule(id);
  return { ok: true, id };
}

export function deleteSpec(id: string): boolean {
  if (!ID.test(id) || !existsSync(jobFile(id))) return false;
  rmSync(join(jobsDir(), id), { recursive: true, force: true });
  next.delete(id);
  return true;
}

/** Per-job webhook secret, created on first use (mode 0600). */
export function webhookSecret(id: string): string {
  const f = secretFile(id);
  if (existsSync(f)) return readFileSync(f, "utf8").trim();
  const s = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
  writeFileSync(f, s + "\n", { mode: 0o600 });
  return s;
}

// ---------- runs ----------
const running = new Map<string, number>(); // job id → run id
const ROW = "id, job, trigger, actor, started, ended, exit_code AS exitCode, ok, duration_ms AS durationMs, output, trace_id AS traceId";
const toRun = (r: Run | null) => (r ? { ...r, ok: r.ok == null ? null : !!r.ok } : null);

export const listRuns = (job: string, limit = 20): Run[] =>
  (db().query(`SELECT ${ROW} FROM runs WHERE job = ? ORDER BY started DESC LIMIT ?`).all(job, limit) as Run[]).map((r) => toRun(r)!);
export const getRun = (id: number): Run | null => toRun(db().query(`SELECT ${ROW} FROM runs WHERE id = ?`).get(id) as Run | null);
const lastRun = (job: string) => listRuns(job, 1)[0] ?? null;

async function execute(spec: JobSpec, payload: string | undefined, signal: AbortSignal): Promise<{ code: number; out: string }> {
  const env = { ...process.env, PATH: `${HOME}/.local/bin:${HOME}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, HOME, SD_PAYLOAD: payload ?? "" };
  if (spec.kind === "http") {
    try {
      const r = await fetch(spec.url!, { signal, redirect: "manual" });
      const want = spec.expect ?? 200;
      return { code: r.status === want ? 0 : 1, out: `${r.status} ${r.statusText} (expected ${want})` };
    } catch (e) { return { code: 1, out: String(e) }; }
  }
  const cmd = spec.kind === "claude"
    ? ["claude", "-p", spec.prompt!, "--output-format", "text", ...(spec.allowedTools?.length ? ["--allowedTools", ...spec.allowedTools] : [])]
    : ["/bin/sh", "-c", spec.command!];
  const cwd = (spec.cwd ?? (spec.kind === "claude" ? dir("agent") : HOME)).replace(/^~(?=\/|$)/, HOME);
  try {
    const p = Bun.spawn(cmd, { cwd: existsSync(cwd) ? cwd : HOME, env, stdin: payload ? new Blob([payload]) : "ignore", stdout: "pipe", stderr: "pipe", detached: true });
    // Own process group, so a timeout stops the whole tree: `sh -c "sleep 5"` forks on dash (Debian/Ubuntu), and a killed
    // shell would leave its child holding the output pipes open until it finished by itself.
    signal.addEventListener("abort", () => { try { process.kill(-p.pid, "SIGKILL"); } catch { p.kill(); } });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    return { code: signal.aborted ? 124 : code, out: (out + (err ? `\n${err}` : "")).trim() + (signal.aborted ? "\n[timed out]" : "") };
  } catch (e) { return { code: 127, out: String(e) }; }
}

let onChange: () => void = () => {};
export function onJobsChange(fn: () => void) { onChange = fn; }

/** Start a run now (non-blocking). Returns the run id, or an error if the job is unknown/broken/already running. */
export function startRun(id: string, trigger: string, actor: string, trace: Trace = newTrace(), payload?: string):
  { ok: true; runId: number; trace: Trace } | { ok: false; error: string } {
  const j = getSpec(id);
  if (!j) return { ok: false, error: "unknown job" };
  if (j.error) return { ok: false, error: j.error };
  if (running.has(id)) return { ok: false, error: "already running" };
  const started = Date.now();
  const runId = Number(db().run("INSERT INTO runs (job, trigger, actor, started, trace_id) VALUES (?, ?, ?, ?, ?)", [id, trigger, actor, started, trace.trace_id]).lastInsertRowid);
  running.set(id, runId);
  logEvent("info", `job ${id} started`, { job: id, run: runId, trigger, actor }, trace);
  onChange();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), (j.spec.timeout ?? 3600) * 1000);
  execute(j.spec, payload, ctl.signal).then(({ code, out }) => {
    clearTimeout(timer);
    const ended = Date.now(), ok = code === 0;
    const output = out.length > MAX_OUTPUT ? "…" + out.slice(-MAX_OUTPUT) : out;
    db().run("UPDATE runs SET ended = ?, exit_code = ?, ok = ?, duration_ms = ?, output = ? WHERE id = ?", [ended, code, ok ? 1 : 0, ended - started, output, runId]);
    running.delete(id);
    logEvent(ok ? "info" : "error", `job ${id} ${ok ? "succeeded" : `failed (exit ${code})`}`, { job: id, run: runId, exit_code: code, duration_ms: ended - started, ...(ok ? {} : { output_tail: output.slice(-500) }) }, trace);
    // keep the last 200 runs per job
    db().run("DELETE FROM runs WHERE job = ? AND id NOT IN (SELECT id FROM runs WHERE job = ? ORDER BY started DESC LIMIT 200)", [id, id]);
    onChange();
  });
  return { ok: true, runId, trace };
}

// ---------- the clock ----------
const next = new Map<string, number | null>(); // job id → next due (unix s)
function reschedule(id: string) {
  const j = getSpec(id);
  if (!j || j.error || j.spec.enabled === false || !j.spec.schedule) { next.set(id, null); return; }
  const last = lastRun(id);
  next.set(id, nextDue(j.spec.schedule, last ? last.started / 1000 : null));
}

export function tick(now = Date.now() / 1000) {
  for (const { id, spec, error } of listSpecs()) {
    if (!next.has(id)) reschedule(id);
    const due = next.get(id);
    if (error || spec.enabled === false || !spec.schedule || due == null || now < due) continue;
    const r = startRun(id, "schedule", "scheduler");
    if (!r.ok && r.error !== "already running") logEvent("warn", `job ${id} not started: ${r.error}`, { job: id });
    next.set(id, nextDue(spec.schedule, now, now + 1));
  }
}

/** Jobs in the same shape as the crontab jobs (ops.ts Job), so the panel and apps show them side by side. */
export function serverJobs() {
  return listSpecs().map(({ id, spec, error }) => {
    const runs = listRuns(id, 14);
    const last = runs[0];
    const isRunning = running.has(id);
    const enabled = spec.enabled !== false;
    const status = error ? "fail" : isRunning ? "running" : !last ? "unknown" : last.ok ? "ok" : "fail";
    const cronLike = spec.schedule && !EVERY.test(spec.schedule);
    return {
      id: `sd:${id}`, name: spec.name, schedule: spec.schedule ?? "", when: describeSchedule(spec.schedule), enabled,
      nextRun: enabled && !error ? (next.get(id) ?? null) : null,
      prevRun: enabled && spec.schedule ? (cronLike ? prevRun(spec.schedule) : last ? Math.floor(last.started / 1000) : null) : null,
      status, lastRun: last ? Math.floor(last.started / 1000) : null,
      cause: error ?? (last && !last.ok ? last.output.split("\n").filter(Boolean).at(-1)?.slice(0, 200) ?? "" : ""),
      log: null, command: spec.kind === "command" ? spec.command! : spec.kind === "claude" ? `claude -p "${spec.prompt}"` : `GET ${spec.url}`,
      category: spec.category ?? null, about: spec.about ?? null, reports: null, project: null,
      runs: runs.filter((r) => r.ok != null).map((r) => ({ t: Math.floor(r.started / 1000), ok: !!r.ok })),
      source: "server" as const, kind: spec.kind, webhook: !!spec.webhook,
    };
  });
}

export function startScheduler() {
  for (const d of [jobsDir()]) if (!existsSync(d)) mkdirSync(d, { recursive: true });
  // Runs left open by a restart are closed as failed.
  db().run("UPDATE runs SET ended = started, ok = 0, exit_code = -1, output = output || '\n[server restarted during the run]' WHERE ended IS NULL");
  setInterval(() => { try { tick(); } catch (e) { logEvent("error", `scheduler tick: ${String(e)}`); } }, 5_000);
  tick();
}

