// Logs & traces: read back the JSON-line logs the server writes, filter them,
// and assemble one trace — every log line, audit entry and job run that shares a trace id.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dir } from "../core/config";
import { db } from "../core/db";

export interface LogRecord { time: string; level: string; service: string; message: string; trace_id?: string; span_id?: string; attributes?: Record<string, unknown> }
export interface AuditRecord { time: string; actor: string; action: string; target: string; result: string; trace_id?: string; attributes?: Record<string, unknown> }

const RANK: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MAX_SCAN = 8 * 1024 * 1024; // read at most the last 8 MB of each file

function readLines(file: string): string[] {
  if (!existsSync(file)) return [];
  const buf = readFileSync(file);
  const text = buf.subarray(Math.max(0, buf.length - MAX_SCAN)).toString("utf8");
  return text.split("\n").filter(Boolean);
}
function parse<T>(lines: string[]): T[] {
  const out: T[] = [];
  for (const l of lines) { try { out.push(JSON.parse(l)); } catch { /* torn line at the cut */ } }
  return out;
}
/** Newest first, across the current file and its one rotated predecessor. */
const records = <T>(name: string): T[] => parse<T>([...readLines(join(dir("logs"), `${name}.1`)), ...readLines(join(dir("logs"), name))]).reverse();

export interface LogQuery { level?: string; q?: string; trace?: string; since?: string; limit?: number }
export function queryLogs(o: LogQuery): LogRecord[] {
  const min = RANK[o.level ?? "debug"] ?? 0, q = o.q?.toLowerCase(), limit = Math.min(o.limit ?? 200, 2000);
  const out: LogRecord[] = [];
  for (const r of records<LogRecord>("server.jsonl")) {
    if (o.since && r.time < o.since) break;
    if ((RANK[r.level] ?? 1) < min) continue;
    if (o.trace && r.trace_id !== o.trace) continue;
    if (q && !(r.message + " " + JSON.stringify(r.attributes ?? {})).toLowerCase().includes(q)) continue;
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

export function queryAudit(o: { actor?: string; action?: string; limit?: number }): AuditRecord[] {
  const limit = Math.min(o.limit ?? 100, 2000), out: AuditRecord[] = [];
  for (const r of records<AuditRecord>("audit.jsonl")) {
    if (o.actor && !r.actor.startsWith(o.actor)) continue;
    if (o.action && !r.action.startsWith(o.action)) continue;
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

/** Everything that happened under one trace id, oldest first. */
export function trace(id: string) {
  const logs = queryLogs({ trace: id, limit: 2000 }).reverse();
  const audit = records<AuditRecord>("audit.jsonl").filter((r) => r.trace_id === id).reverse();
  const runs = db().query("SELECT id, job, trigger, actor, started, ended, exit_code AS exitCode, ok, duration_ms AS durationMs, substr(output, -2000) AS output FROM runs WHERE trace_id = ? ORDER BY started").all(id);
  const t = [...logs.map((l) => l.time), ...audit.map((a) => a.time)].sort();
  return { trace_id: id, start: t[0] ?? null, end: t.at(-1) ?? null, logs, audit, runs };
}

/** Error counts per hour for the last 24 h — the headline on the Logs page. */
export function errorSummary() {
  const since = new Date(Date.now() - 86400_000).toISOString();
  const recent = queryLogs({ level: "warn", since, limit: 2000 });
  const byMessage = new Map<string, { message: string; level: string; count: number; last: string; trace_id?: string }>();
  for (const r of recent) {
    const key = r.message.replace(/\d+/g, "#");
    const cur = byMessage.get(key);
    if (cur) cur.count++;
    else byMessage.set(key, { message: r.message, level: r.level, count: 1, last: r.time, trace_id: r.trace_id });
  }
  return { errors: recent.filter((r) => r.level === "error").length, warnings: recent.filter((r) => r.level === "warn").length, groups: [...byMessage.values()].sort((a, b) => b.count - a.count).slice(0, 20) };
}
