// A sub-agent's own conversation, read from Claude Code's <session>/subagents/agent-<id>.jsonl (read-only, tail-limited).
// Text only: tool calls collapse to one line, tool results are dropped, and anything that looks like a secret is masked.
import { existsSync, readFileSync } from "node:fs";

export interface AgentEntry { ts: number; role: "prompt" | "assistant" | "tool"; text: string }

const SECRET = [
  /\b(?:sk|pk|rk|ghp|gho|ghs|xox[bap]|AKIA|AIza)[-_A-Za-z0-9]{16,}/g,
  /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, // Telegram bot tokens
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
  /((?:token|secret|password|passwd|api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi,
];
export const redact = (s: string) => SECRET.reduce((t, re) => t.replace(re, (m, p1) => (typeof p1 === "string" && p1 && m.startsWith(p1) ? `${p1}[hidden]` : "[hidden]")), s);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

function toolLine(b: Record<string, unknown>) {
  const input = (b.input ?? {}) as Record<string, unknown>;
  const arg = ["description", "command", "file_path", "pattern", "query", "url", "prompt"].map((k) => input[k]).find((v) => typeof v === "string") as string | undefined;
  return `${String(b.name)}${arg ? ` · ${clip(arg.replace(/\s+/g, " "), 160)}` : ""}`;
}

export function readAgentLog(file: string, limit = 200): AgentEntry[] {
  if (!existsSync(file)) return [];
  const out: AgentEntry[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let d: { type?: string; timestamp?: string; message?: { content?: unknown } };
    try { d = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(d.timestamp ?? "") || 0, c = d.message?.content;
    if (d.type === "user") {
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "";
      if (text.trim() && !out.length) out.push({ ts, role: "prompt", text: redact(clip(text.trim(), 4000)) });
    } else if (d.type === "assistant" && Array.isArray(c)) {
      for (const b of c as Record<string, unknown>[]) {
        if (b.type === "text" && String(b.text ?? "").trim()) out.push({ ts, role: "assistant", text: redact(clip(String(b.text).trim(), 4000)) });
        else if (b.type === "tool_use") out.push({ ts, role: "tool", text: redact(toolLine(b)) });
      }
    }
  }
  const first = out[0]?.role === "prompt" ? out[0] : null; // keep the prompt even when the tail is cut
  const tail = out.slice(first ? 1 : 0).slice(-limit);
  return first ? [first, ...tail] : tail;
}
