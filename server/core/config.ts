// Server OS home folder + config file.
// SERVER_OS_HOME (legacy: SERVER_DASH_HOME; default ~/server-os, or an existing ~/server-dash) holds config/, logs/, data/ …;
// config/server-os.yaml (legacy name: server-dash.yaml) is optional — every key has a default.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { HOME, setLogFile } from "../lib";

/** The running version: package.json of this copy (a release bundle is stamped with its tag; the release workflow checks they match). */
export const VERSION: string = (JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8")) as { version: string }).version;
export const ROOT = process.env.SERVER_OS_HOME ?? process.env.SERVER_DASH_HOME
  ?? (!existsSync(join(HOME, "server-os")) && existsSync(join(HOME, "server-dash")) ? join(HOME, "server-dash") : join(HOME, "server-os"));
export const DIRS = ["config", "agent", "apps", "jobs", "dashboards", "logs", "data"] as const;
export const dir = (d: (typeof DIRS)[number]) => join(ROOT, d);
const NEW_CONFIG = join(ROOT, "config", "server-os.yaml"), OLD_CONFIG = join(ROOT, "config", "server-dash.yaml");
export const CONFIG_FILE = !existsSync(NEW_CONFIG) && existsSync(OLD_CONFIG) ? OLD_CONFIG : NEW_CONFIG;

export type AuthMode = "off" | "token";
export interface Integrations {
  /** Claude OS bot manager API (tmux bot sessions), e.g. http://127.0.0.1:3090/api — enables the Bots tab. */
  claudeOS?: string;
  /** Home Assistant: URL + the ~/.env variable that holds a long-lived token. */
  homeAssistant?: { url: string; tokenEnv?: string };
  /** AdGuard Home admin API + ~/.env variables for its user/password; unbound: read unbound-control stats. */
  adguard?: { url: string; userEnv?: string; passwordEnv?: string };
  unbound?: boolean;
  /** Claude Code Telegram channels in ~/.claude/channels/* (bot liveness). */
  telegramBots?: boolean;
  /** Cron jobs: list the user crontab as the Jobs tab. Off unless set. The optional paths enrich it with a notify bot's
   *  history (JSONL, feeds Alerts + last-run status), job ID cards (JSON) and cron_wrap-style per-job logs. */
  cron?: { history?: string; cards?: string; logs?: string };
  /** Folder with one sub-folder per Claude Code Telegram channel (launch.command, bot.pid, run.pid). Default for telegramBots: ~/.claude/channels.
   *  Also where the claudeOS provider reads each bot's launch flags. */
  channelsDir?: string;
  /** Desk speaker (wake-word listener) and the bot session it talks to. Off unless set. dir: the listener project (listen.py,
   *  config.json, status.json); session: its tmux session (default house-voice). voiceLaunch: script that starts the bot's
   *  voice session, kept up by a watchdog in tmux session voiceSession (default bot-voice); it powers the app's voice screen. */
  houseVoice?: { dir?: string; session?: string; voiceSession?: string; voiceLaunch?: string };
  /** A folder with catalog.json (+ gates/, icons/, off-containers.txt) that lists apps you manage outside the installer. Off unless set. */
  catalog?: string;
  /** Remote screen: the web panel shows this Mac's screen through its built-in Screen Sharing (VNC) so a permission switch
   *  can be clicked from anywhere. Off unless enabled. host must be loopback (default 127.0.0.1), port default 5900;
   *  a session closes after idleMinutes without input (default 5) and after maxMinutes in any case (default 30). */
  screen?: { enabled?: boolean; host?: string; port?: number; idleMinutes?: number; maxMinutes?: number; debug?: boolean;
    /** macOS: shrink the display while a web session is open (default true = Screen Sharing's virtual display only; "any" = a real monitor too; false = never). */
    resizeDisplay?: boolean | "any" };
  /** Existing webhook listeners to watch (launchd service + port + log file). */
  webhooks?: { slug: string; label: string; description: string; service: string; port: number; log: string }[];
}
export interface AppsConfig {
  /** Give each installed app an address. command runs after the install with {id} and {port} filled in
   *  (e.g. a reverse-proxy + DNS helper); url is the address it makes, e.g. "http://{id}.home". */
  link?: { command: string; url: string; /** runs on uninstall with {id}: takes the address away again */ remove?: string };
  /** Hand every install to a background Claude Code run that finishes setup (admin user, first-run wizard). */
  agentSetup: boolean;
  /** Model for those runs (claude --model), e.g. "sonnet". Empty = Claude Code's default. */
  agentModel?: string;
}
export interface Config {
  name: string;
  /** off: anyone who can reach the server may use it (today's tailnet-only setup). token: paired devices only. */
  auth: AuthMode;
  /** A second disk to show next to "/" (e.g. /Volumes/ExternalSSD or /mnt/data). */
  externalDisk?: string;
  /** Storage tab: extra folders the "Trim old logs" cleanup may prune (default: Server OS's logs/ and, on macOS, ~/Library/Logs). */
  storage?: { logDirs?: string[] };
  /** Where vitals history, uptime buckets and lifecycle events are kept (default: <home>/data). */
  stateDir?: string;
  /** Host name used in links to installed apps (default: <hostname>.local). */
  host?: string;
  logging: { level: "debug" | "info" | "warn" | "error"; maxFileMB: number };
  /** Optional links to things that already run on this machine. Everything is off unless listed. */
  integrations: Integrations;
  /** The person who owns this server: the agent makes their admin accounts in installed apps with these. */
  owner: { name: string; email?: string };
  /** What happens after an app is installed. */
  apps: AppsConfig;
  /** Bots tab. provider: claudeOS (default when integrations.claudeOS is set), native (Server OS runs the Claude Code
   *  sessions itself in tmux; the default otherwise) or both (Claude OS bots and native bots side by side). prefix: tmux session prefix for native bots (default "sos-").
   *  team: the agmsg team every native bot joins (default "server-os"); agmsg.dir / agmsg.storage: another agmsg install
   *  or message store (AGMSG_STORAGE_PATH). telegram.ownerChatIds: chats pre-approved in every bot's Telegram access.json. */
  bots?: { provider?: "claudeOS" | "native" | "both"; prefix?: string; team?: string; agmsg?: { dir?: string; storage?: string }; telegram?: { ownerChatIds?: (string | number)[] } };
  /** Optional local names for apps (jellyfin.home): see server/modules/names.ts. Set up by the wizard. */
  names?: import("../modules/names").NamesConfig;
  /** Optional OpenTelemetry export: logs are also sent to <endpoint>/v1/logs (OTLP/HTTP JSON). */
  otlp?: { endpoint: string; headers?: Record<string, string> };
}

const DEFAULTS: Config = {
  name: process.env.SERVER_OS_DEMO === "1" ? "homelab" : hostname().replace(/\.local$/, ""),
  auth: "off",
  logging: { level: "info", maxFileMB: 10 },
  integrations: {},
  owner: { name: process.env.SERVER_OS_DEMO === "1" ? "alex" : userInfo().username },
  apps: { agentSetup: true, agentModel: "sonnet" },
};

export function loadConfig(file = CONFIG_FILE): Config {
  if (!existsSync(file)) return DEFAULTS;
  const raw = (Bun.YAML.parse(readFileSync(file, "utf8")) ?? {}) as Partial<Config>;
  const auth = raw.auth === "token" ? "token" : "off";
  return { ...DEFAULTS, ...raw, auth, logging: { ...DEFAULTS.logging, ...(raw.logging ?? {}) }, integrations: { ...(raw.integrations ?? {}) },
    owner: { ...DEFAULTS.owner, ...(raw.owner ?? {}) }, apps: { ...DEFAULTS.apps, ...(raw.apps ?? {}) } };
}
export const config = loadConfig();
const tilde = (p: string) => p.replace(/^~(?=\/|$)/, HOME);
for (const k of ["history", "cards", "logs"] as const) if (config.integrations.cron?.[k]) config.integrations.cron[k] = tilde(config.integrations.cron[k]!);
if (config.integrations.channelsDir) config.integrations.channelsDir = tilde(config.integrations.channelsDir);
for (const k of ["dir", "voiceLaunch"] as const) if (config.integrations.houseVoice?.[k]) config.integrations.houseVoice[k] = tilde(config.integrations.houseVoice[k]!);
if (config.integrations.catalog) config.integrations.catalog = tilde(config.integrations.catalog);
for (const k of ["dir", "storage"] as const) if (config.bots?.agmsg?.[k]) config.bots.agmsg[k] = tilde(config.bots.agmsg[k]!);
export const STATE_DIR = config.stateDir ? tilde(config.stateDir) : join(ROOT, "data");
setLogFile(join(STATE_DIR, "server-os.log"));

const TEMPLATE = (name: string) => `# Server OS configuration — see docs/configuration.md
name: ${name}

# off: anyone who can reach the server can use it (fine behind Tailscale).
# token: only paired devices (run \`server-os pair\`).
auth: off

logging:
  level: info      # debug | info | warn | error
  maxFileMB: 10    # logs/server.jsonl rotates at this size

# The owner's name (and email) — used for admin accounts the agent creates in installed apps.
# owner: { name: alex, email: alex@example.com }

# After an install, a background Claude Code run finishes setup: admin user, first-run wizard, the ready card.
# apps:
#   agentSetup: true
#   agentModel: sonnet
#   link: { command: "my-proxy-add {id} {port}", url: "http://{id}.home", remove: "my-proxy-remove {id}" }   # optional: give each app an address

# Optional: also send logs to an OpenTelemetry collector (Grafana Alloy, Loki, SigNoz, …)
# otlp:
#   endpoint: http://localhost:4318
#   headers: { Authorization: "Bearer …" }
`;

/** Create the disk layout and a default config. Idempotent: never overwrites an existing file. */
export function initLayout(): string[] {
  const made: string[] = [];
  for (const d of DIRS) if (!existsSync(dir(d))) { mkdirSync(dir(d), { recursive: true }); made.push(dir(d)); }
  if (!existsSync(CONFIG_FILE)) { writeFileSync(CONFIG_FILE, TEMPLATE(DEFAULTS.name)); made.push(CONFIG_FILE); }
  return made;
}
