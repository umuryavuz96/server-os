// The agent chat's view of a transcript item: plain-words step facts (verb, target, result) and no secrets.
// Applied only to what /agmsg/agents/:team/:name/chat and /snapshot send; the Bots tab and voice chat keep the raw items.
import { HOME } from "../../lib";
import type { FeedItem } from "./transcript";

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
const NAME = "[\\w.-]*(?:token|secret|passw(?:or)?d|pwd|key|auth|credential|cookie)[\\w.-]*";
const PATTERNS: [RegExp, string | ((m: string, ...g: string[]) => string)][] = [
  [/(\b[a-z0-9+.-]+:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1***@"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 ***"],
  [new RegExp(`(${NAME})(["']?\\s*[=:]\\s*)("[^"]*"|'[^']*'|\\S+)`, "gi"), "$1$2***"],
  [/(--?(?:token|password|passwd|secret|api-?key|key|auth|cookie)\b[ =])(\S+)/gi, "$1***"],
  [/\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*|\d{8,10}:[A-Za-z0-9_-]{30,})/g, "***"],
  // any other long opaque run that mixes letters and digits (a sha1 commit hash stays)
  [/\b[A-Za-z0-9_-]{32,}\b/g, (m) => (/^[0-9a-f]{40}$/.test(m) || !/\d/.test(m) || !/[A-Za-z]/.test(m) ? m : "***")],
];
/** Hide tokens, passwords, auth headers and credential-looking values in free text. */
export function mask(s: string): string {
  let out = s;
  for (const [re, to] of PATTERNS) out = out.replace(re, to as string);
  return out;
}

/** A command that prints credentials (env dumps, .env / key files): its output is dropped entirely. */
const SECRET_READ = /(^|[\s;&|(])(printenv|env|set|export|security\s+find-\S+|pass\s+show|op\s+read|infisical)(\s|$)|\.env\b|credentials|id_(rsa|ed25519)|\.pem\b|\.p12\b|\.netrc|secrets?\b|keychain/i;
const SECRET_PATH = /(^|\/)\.env|credentials|id_(rsa|ed25519)|\.pem$|\.p12$|\.netrc|secret|\.ssh\//i;

const rel = (p: string) => p.replace(/^.*\/projects\/[^/]+\//, "").replace(HOME, "~");
const domain = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return clip(u, 40); } };
/** First word of a command, plus a plain subcommand ("bun test", "git commit"); no flags, paths or values. */
export function shortCommand(cmd: string): string {
  const words = cmd.trim().replace(/^(cd\s+\S+\s*(&&|;)\s*)+/, "").split("\n")[0].split(/\s+/).filter((w) => !/^\w+=/.test(w) && w !== "sudo" && w !== "&&");
  if (!words.length) return "command";
  const first = words[0].split("/").pop()!.replace(/[^\w.-]/g, "");
  const second = words[1] && /^[a-z][a-z-]*$/.test(words[1]) ? ` ${words[1]}` : "";
  return clip((first || "command") + second, 40);
}

/** Verb + target + redacted detail/out for one item. Pure: never mutates the transcript's own item. */
export function publicItem(it: FeedItem): FeedItem {
  const o: FeedItem = { ...it };
  if (o.text) o.text = o.thinking ? clip(mask(o.text), 400) : mask(o.text);
  if (o.kind === "event" && o.agmsg?.dir === "in") { o.verb = "Received"; o.target = o.agmsg.peer; }
  if (o.kind !== "step") return o;
  const tool = o.tool ?? "", d = it.detail ?? "";
  const shell = tool === "Shell" || tool === "Monitor";
  if (o.title) o.title = clip(mask(o.title), 120);
  if (o.agmsg?.dir === "out") { o.verb = "Sent"; o.target = o.agmsg.peer; }
  else if (tool === "Read") { o.verb = "Read"; o.target = rel(d); }
  else if (tool === "Edit") { o.verb = "Edited"; o.target = rel(d); }
  else if (tool === "Write") { o.verb = "Wrote"; o.target = rel(d); }
  else if (tool === "Grep") { o.verb = "Searched"; o.target = clip(mask(it.title?.match(/“(.*)”/)?.[1] ?? "files"), 40); }
  else if (tool === "Glob") { o.verb = "Listed"; o.target = clip(d, 60); }
  else if (tool === "WebFetch") { o.verb = "Fetched"; o.target = domain(d); }
  else if (tool === "WebSearch") { o.verb = "Searched"; o.target = clip(mask(d), 60); }
  else if (tool === "Monitor") { o.verb = "Watching"; o.target = clip(mask((it.title ?? "").replace(/^Monitor · /, "")), 60); }
  else if (tool === "Shell") { o.verb = "Ran"; o.target = it.title && it.title !== "Ran a command" ? clip(mask(it.title), 60) : shortCommand(d); }
  else if (/^Telegram · reply/.test(tool)) { o.verb = "Replied"; o.target = "Telegram"; }
  else if (tool === "Agent" || tool === "Task") { o.verb = "Delegated"; o.target = clip(mask((it.title ?? "").replace(/^Sub-agent · /, "")), 60); }
  else { o.verb = tool.split(" · ")[0]; o.target = tool.split(" · ")[1] ?? ""; }
  if (shell) o.detail = ""; // command lines carry env values, tokens and passwords
  else if (o.detail) o.detail = clip(mask(o.detail), 200);
  const sensitive = (tool === "Shell" && SECRET_READ.test(d)) || ((tool === "Read" || tool === "Edit" || tool === "Write") && SECRET_PATH.test(d));
  if (o.out !== undefined) o.out = sensitive ? "" : clip(mask(o.out), 300);
  if (o.res) o.res = clip(mask(o.res), 60);
  if (o.summary) o.summary = mask(o.summary);
  return o;
}
