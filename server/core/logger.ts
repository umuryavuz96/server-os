// Structured logging: one JSON object per line, OpenTelemetry field names,
// written to logs/server.jsonl (rotated by size) and audit actions to logs/audit.jsonl (never rotated away).
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { config, dir } from "./config";
import { setLogSink } from "../lib";

export type Level = "debug" | "info" | "warn" | "error";
const RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Trace { trace_id: string; span_id: string }

const hex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
export const newTrace = (): Trace => ({ trace_id: hex(16), span_id: hex(8) });

/** W3C traceparent: "00-<32 hex trace>-<16 hex parent span>-<flags>". Keeps the caller's trace id, new span. */
export function fromTraceparent(h: string | undefined): Trace {
  const m = h?.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/);
  return m && !/^0+$/.test(m[1]) ? { trace_id: m[1], span_id: hex(8) } : newTrace();
}
export const traceparent = (t: Trace) => `00-${t.trace_id}-${t.span_id}-01`;

function write(file: string, line: string, rotateAt?: number) {
  try {
    const d = dir("logs");
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    const p = join(d, file);
    if (rotateAt && existsSync(p) && statSync(p).size > rotateAt) renameSync(p, `${p}.1`);
    appendFileSync(p, line + "\n");
  } catch { /* logging must never take the server down */ }
}

// ---------- OTLP/HTTP JSON export (optional) ----------
const SEVERITY: Record<Level, number> = { debug: 5, info: 9, warn: 13, error: 17 }; // OpenTelemetry SeverityNumber
const otlpValue = (v: unknown) => (typeof v === "number" ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }) : typeof v === "boolean" ? { boolValue: v } : { stringValue: typeof v === "string" ? v : JSON.stringify(v) });
let queue: Record<string, unknown>[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
export function toOtlp(level: Level, message: string, attrs: Record<string, unknown>, trace: Trace | undefined, at: Date) {
  return {
    timeUnixNano: String(at.getTime() * 1_000_000), severityNumber: SEVERITY[level], severityText: level.toUpperCase(),
    body: { stringValue: message }, ...(trace ? { traceId: trace.trace_id, spanId: trace.span_id } : {}),
    attributes: Object.entries(attrs).map(([key, value]) => ({ key, value: otlpValue(value) })),
  };
}
async function flush() {
  flushTimer = null;
  const o = config.otlp; if (!o?.endpoint || !queue.length) return;
  const logRecords = queue; queue = [];
  const body = { resourceLogs: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "server-os" } }, { key: "host.name", value: { stringValue: config.name } }] },
    scopeLogs: [{ scope: { name: "server-os" }, logRecords }] }] };
  try { await fetch(`${o.endpoint.replace(/\/$/, "")}/v1/logs`, { method: "POST", headers: { "Content-Type": "application/json", ...(o.headers ?? {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) }); }
  catch { /* the collector being down must never affect the server; local files keep everything */ }
}

export function logEvent(level: Level, message: string, attrs: Record<string, unknown> = {}, trace?: Trace) {
  if (RANK[level] < RANK[config.logging.level]) return;
  const at = new Date();
  const rec = { time: at.toISOString(), level, service: "server-os", message, ...trace, attributes: attrs };
  write("server.jsonl", JSON.stringify(rec), config.logging.maxFileMB * 1024 * 1024);
  if (config.otlp?.endpoint) {
    if (queue.length < 5000) queue.push(toOtlp(level, message, attrs, trace, at));
    flushTimer ??= setTimeout(flush, 2000);
  }
  if (level === "error") console.error(message, attrs);
}

/** Who did what: a device, the web panel or the agent. Kept separately from the rotated server log. */
export function audit(actor: string, action: string, target: string, result: "ok" | "failed", trace?: Trace, attrs: Record<string, unknown> = {}) {
  const rec = { time: new Date().toISOString(), actor, action, target, result, ...trace, attributes: attrs };
  write("audit.jsonl", JSON.stringify(rec));
  logEvent("info", `${action} ${target}`, { actor, result, ...attrs }, trace);
}

// Old-style log() lines (server/lib.ts) go to the structured log too, so nothing is only in svc-control.log.
setLogSink((line) => logEvent("info", line, { module: "legacy" }));
