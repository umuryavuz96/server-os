#!/usr/bin/env bun
// PostToolUse hook: every shell command and file change the agent makes goes into <home>/logs/audit.jsonl
// (actor "agent"), next to what the panel, the apps and the server-os MCP tools record.
import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const HOME = process.env.SERVER_OS_HOME ?? process.env.SERVER_DASH_HOME ?? resolve(import.meta.dir, "../../..");
const input = JSON.parse(await Bun.stdin.text() || "{}") as { tool_name?: string; tool_input?: Record<string, unknown>; tool_response?: Record<string, unknown>; session_id?: string };
const t = input.tool_input ?? {};
const target = String(t.command ?? t.file_path ?? t.notebook_path ?? "").slice(0, 500);
const failed = input.tool_response && (input.tool_response.is_error || input.tool_response.interrupted);
const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
const rec = {
  time: new Date().toISOString(), actor: "agent", action: `agent.${(input.tool_name ?? "tool").toLowerCase()}`, target,
  result: failed ? "failed" : "ok", trace_id: hex(16), span_id: hex(8), attributes: { session: input.session_id ?? null },
};
mkdirSync(join(HOME, "logs"), { recursive: true });
appendFileSync(join(HOME, "logs", "audit.jsonl"), JSON.stringify(rec) + "\n");
