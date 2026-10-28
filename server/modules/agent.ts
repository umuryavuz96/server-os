// Background agent runs: `claude -p` in the agent folder on the owner's subscription, used by the installer to
// install apps that have no automatic method and to finish setup after an install (admin user, first-run wizard).
// The run's events stream into an operation, so the panel and the apps watch it like any other install.
// Its server-os MCP calls carry the operation's trace id, so everything it did shows up under one trace.
import { dirname, join } from "node:path";
import { config, dir } from "../core/config";
import { traceparent, type Trace } from "../core/logger";
import { HOME } from "../lib";

// Bun's own folder comes first: the agent kit's MCP server runs with `bun`, which launchd's PATH may not have.
const PATH = `${dirname(process.execPath)}:${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;

/** What a background run may do without asking, on top of the agent folder's settings.json allow list.
 *  Anything else (uninstall, rm, sudo, …) is refused, because nobody is there to say yes. */
export const agentTools = () => [
  "mcp__server-os", "Read", "Glob", "Grep", "WebFetch", "WebSearch",
  // Edit rules cover every file-writing tool; "//" = absolute path.
  `Edit(/${dir("apps")}/**)`, `Edit(/${dir("config")}/recipes/**)`,
  "Bash(docker exec *)", "Bash(docker compose *)", "Bash(docker logs *)", "Bash(docker ps *)", "Bash(docker inspect *)",
  "Bash(curl *)", "Bash(sleep *)", "Bash(brew services *)", "Bash(brew info *)",
];

export const agentAvailable = () => !!Bun.which("claude", { PATH });

export interface AgentHooks { log: (text: string) => void; step: (text: string) => void }

/** One short line for a tool call, e.g. "install_app gitea" or "docker exec sd-gitea gitea admin …". */
function describe(name: string, input: Record<string, unknown>): string {
  const n = name.replace(/^mcp__server-os__/, "");
  if (n === "Bash") return String(input.command ?? "").split("\n")[0].slice(0, 160);
  const arg = input.app ?? input.catalogId ?? input.id ?? input.q ?? input.file_path ?? input.url ?? "";
  return `${n}${arg ? ` ${String(arg).slice(0, 120)}` : ""}`;
}

/** Run a prompt in the background. Resolves with the final answer; rejects when the run fails or times out. */
export async function runAgent(prompt: string, trace: Trace, hooks: AgentHooks, timeoutMs = 30 * 60_000): Promise<string> {
  const cmd = ["claude", "-p", prompt, "--output-format", "stream-json", "--verbose", "--allowedTools", ...agentTools(),
    ...(config.apps.agentModel ? ["--model", config.apps.agentModel] : [])];
  const p = Bun.spawn(cmd, {
    cwd: dir("agent"),
    env: { ...process.env, PATH, HOME, SERVER_OS_HOME: join(dir("agent"), ".."), SERVER_OS_TRACEPARENT: traceparent(trace),
      SERVER_DASH_HOME: join(dir("agent"), ".."), SERVER_DASH_TRACEPARENT: traceparent(trace) }, // SERVER_DASH_*: for agent folders created before the rename
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  let result: { text: string; error: boolean } | null = null, buf = "", stderr = "";
  const onLine = (line: string) => {
    let ev: any;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.type === "assistant") {
      for (const b of ev.message?.content ?? []) {
        if (b.type === "text" && b.text?.trim()) { hooks.log(`${b.text.trim()}\n`); hooks.step(b.text.trim().split("\n")[0].slice(0, 120)); }
        if (b.type === "tool_use") hooks.log(`→ ${describe(b.name, b.input ?? {})}\n`);
      }
    } else if (ev.type === "result") result = { text: String(ev.result ?? ""), error: !!ev.is_error || ev.subtype !== "success" };
  };
  const out = (async () => {
    for await (const chunk of p.stdout) {
      buf += new TextDecoder().decode(chunk);
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) onLine(l); }
    }
  })();
  const err = (async () => { for await (const chunk of p.stderr) stderr = (stderr + new TextDecoder().decode(chunk)).slice(-4000); })();
  await Promise.all([out, err]);
  const code = await p.exited;
  clearTimeout(timer);
  const r = result as { text: string; error: boolean } | null;
  if (!r) throw new Error(p.killed ? "the agent run timed out" : `the agent run ended without an answer (exit ${code})${stderr ? `: ${stderr.trim().split("\n").at(-1)}` : ""}`);
  if (r.error) throw new Error(`the agent stopped: ${r.text.split("\n")[0].slice(0, 200)}`);
  return r.text;
}
