// Demo mode (SERVER_OS_DEMO=1): a made-up "homelab" for screenshots and trying the UI. Nothing here reads the machine.
import { setSlice, setMapEntry, getSlice } from "./store";
import { every } from "./lib";
import { logEvent } from "./core/logger";

export const DEMO = process.env.SERVER_OS_DEMO === "1";

const now = () => Math.floor(Date.now() / 1000);
// Deterministic wobble so screenshots look the same every run.
const wave = (i: number, period: number, amp: number, phase = 0) => Math.sin((i + phase) / period) * amp + Math.sin((i + phase) / (period / 3.1)) * amp * 0.3;

const APPS: { name: string; group: string; about: string; mem: number; state?: "on" | "off"; kind?: "lock" | "switch"; port?: number }[] = [
  { name: "Home Assistant", group: "Home", about: "Home automation hub", mem: 1480, port: 8123 },
  { name: "Pi-hole", group: "Network", about: "Network-wide ad blocking and local DNS", mem: 96, port: 8053 },
  { name: "Caddy", group: "Core", about: "Reverse proxy for every app on this server", mem: 48, kind: "lock", port: 80 },
  { name: "Jellyfin", group: "Media", about: "Movies, shows and music", mem: 910, port: 8096 },
  { name: "Nextcloud", group: "Files", about: "Files, calendar and contacts", mem: 760, port: 8080 },
  { name: "Immich", group: "Files", about: "Photo and video backup", mem: 1320, port: 2283 },
  { name: "Vaultwarden", group: "Security", about: "Password manager", mem: 54, port: 8222 },
  { name: "Uptime Kuma", group: "Monitoring", about: "Status checks and alerts", mem: 138, port: 3001 },
  { name: "Gitea", group: "Dev", about: "Self-hosted Git", mem: 210, port: 3000 },
  { name: "Paperless-ngx", group: "Files", about: "Scan, index and archive documents", mem: 0, state: "off", port: 8000 },
  { name: "Sonarr", group: "Media", about: "TV show manager", mem: 0, state: "off", port: 8989 },
  { name: "Grafana", group: "Monitoring", about: "Dashboards for metrics and logs", mem: 185, port: 3030 },
  { name: "Tailscale", group: "Network", about: "Private network between your devices", mem: 42, kind: "lock" },
  { name: "Ollama", group: "AI", about: "Run language models locally", mem: 3900, port: 11434 },
];

const JOBS: { name: string; schedule: string; when: string; status: string; ago: number; next: number; about: string; command: string }[] = [
  { name: "backup-photos", schedule: "30 2 * * *", when: "daily 02:30", status: "ok", ago: 8 * 3600, next: 16 * 3600, about: "Sync the photo library to the external disk", command: "rsync -a /srv/photos /mnt/backup/photos" },
  { name: "backup-config", schedule: "0 3 * * *", when: "daily 03:00", status: "ok", ago: 7 * 3600, next: 17 * 3600, about: "Archive app configs", command: "tar czf /mnt/backup/config.tgz ~/server-os" },
  { name: "dns-blocklist-update", schedule: "0 4 * * 0", when: "Sun 04:00", status: "ok", ago: 2 * 86400, next: 5 * 86400, about: "Refresh ad-block lists", command: "pihole -g" },
  { name: "cert-renew", schedule: "15 5 * * 1", when: "Mon 05:15", status: "fail", ago: 3 * 86400, next: 4 * 86400, about: "Renew local TLS certificates", command: "certbot renew --quiet" },
  { name: "disk-report", schedule: "0 8 * * *", when: "daily 08:00", status: "ok", ago: 2 * 3600, next: 22 * 3600, about: "Mail a short disk usage summary", command: "~/bin/disk-report" },
  { name: "docker-prune", schedule: "0 4 1 * *", when: "monthly on day 1, 04:00", status: "ran", ago: 12 * 86400, next: 18 * 86400, about: "Remove unused images and volumes", command: "docker system prune -f" },
  { name: "speedtest", schedule: "*/30 * * * *", when: "every 30 min", status: "ok", ago: 600, next: 1200, about: "Log internet speed", command: "speedtest --json" },
  { name: "update-check", schedule: "0 9 * * 6", when: "Sat 09:00", status: "paused", ago: 9 * 86400, next: 0, about: "Look for new app versions", command: "~/bin/update-check" },
];

function alertsPayload(days: 1 | 7) {
  const t0 = now();
  const mk = (job: string, secsAgo: number, action: string, title: string, body: string, sent = true) =>
    ({ t: t0 - secsAgo, job, action, sent, id: null, cause: "", title, body });
  const groups = [
    { job: "cert-renew", sent: 2, silent: 5, items: [
      mk("cert-renew", 3 * 3600, "send_failure_new_cause", "cert-renew failed", "certbot: could not reach the ACME server (timeout). Will retry on the next run."),
      mk("cert-renew", 27 * 3600, "send_failure_first", "cert-renew failed", "certbot: rate limit reached for this domain."),
      mk("cert-renew", 30 * 3600, "dedup_silent", "cert-renew failed", "Same cause as the last alert; held back.", false)] },
    { job: "backup-photos", sent: 3, silent: 0, items: [
      mk("backup-photos", 8 * 3600, "send_signal", "backup-photos done", "12,408 files in sync, 38 new."),
      mk("backup-photos", 32 * 3600, "send_signal", "backup-photos done", "12,370 files in sync, 11 new."),
      mk("backup-photos", 56 * 3600, "send_recovery", "backup-photos recovered", "Back to normal after the disk was remounted.")] },
    { job: "disk-report", sent: 4, silent: 0, items: [mk("disk-report", 2 * 3600, "send_heartbeat", "disk-report", "Internal 41% used, backup disk 63% used.")] },
    { job: "speedtest", sent: 0, silent: 9, items: [mk("speedtest", 40 * 60, "dedup_silent", "speedtest slow", "Download 212 Mb/s, below the 250 Mb/s threshold.", false)] },
  ];
  const k = days === 7 ? 3 : 1;
  return { days, sent: groups.reduce((s, g) => s + g.sent, 0) * k, silent: groups.reduce((s, g) => s + g.silent, 0) * k, newCause: 1, groups };
}
export const demoAlerts = alertsPayload;

export function demoHistory(metric: string, spanSec: number, step: number) {
  const t0 = now(), t: number[] = [], v: number[] = [];
  const base: Record<string, [number, number, number]> = { cpu: [49, 6, 40], ram: [9.4, 0.8, 60], swap: [0.6, 0.15, 90], load: [1.4, 0.6, 30], disk: [41.2, 0.05, 400] };
  const [mid, amp, per] = base[metric] ?? [0, 0, 1];
  for (let s = t0 - spanSec, i = 0; s <= t0; s += step, i++) {
    t.push(s);
    const trend = metric === "disk" ? (i / (spanSec / step)) * 0.6 : 0;
    v.push(Math.max(0, Math.round((mid + trend + wave(i, per, amp)) * 100) / 100));
  }
  return { t, v };
}

export function startDemo() {
  const t0 = now();
  for (const [lvl, msg] of [["info", "Jellyfin started"], ["info", "backup-photos finished: 12,408 files in sync"], ["warn", "cert-renew failed: ACME server timeout"], ["info", "Pi-hole blocklists refreshed (1.2 M domains)"],
    ["info", "Home Assistant health check ok (200, 38 ms)"], ["warn", "Immich restarted once in 7 days"], ["info", "Paperless-ngx switched off"], ["info", "speedtest: 238 Mb/s down, 41 Mb/s up"]] as const) logEvent(lvl, msg);
  const groups = [...new Set(APPS.map((a) => a.group))];
  setSlice("groups", groups);
  const life: Record<string, unknown> = {};
  APPS.forEach((a, i) => {
    const off = a.state === "off";
    setMapEntry("apps", a.name, { name: a.name, group: a.group, order: i, href: a.port ? `http://homelab.local:${a.port}` : "", icon: "", about: a.about,
      kind: a.kind ?? "switch", warn: false, state: off ? "off" : "on", parts: { [a.name.toLowerCase().replace(/\W/g, "-")]: !off }, mem: a.mem });
    life[a.name] = { uptime24: off ? null : a.name === "Immich" ? 99.1 : 100, uptime7d: off ? null : a.name === "Nextcloud" ? 99.6 : 99.98, healthy: !off, code: off ? null : 200,
      since: t0 - (3 + (i * 37) % 20) * 86400, restarts7d: a.name === "Immich" ? 1 : 0, lastChange: t0 - (3 + (i * 37) % 20) * 86400, checkedVia: a.port ? "http" : "process" };
  });
  setSlice("life", life);

  const hist = { t: [] as number[], cpu: [] as number[], ram: [] as number[], swap: [] as number[], load: [] as number[], disk: [] as number[] };
  for (const m of ["cpu", "ram", "swap", "load", "disk"] as const) { const h = demoHistory(m, 240, 1); hist[m] = h.v; hist.t = h.t; }
  setSlice("sysHistory", hist);

  const speedPts = Array.from({ length: 7 * 24 }, (_, i) => ({ t: t0 - (7 * 24 - i) * 3600, ping: Math.round(11 + wave(i, 9, 3)), down: Math.round(238 + wave(i, 14, 22)), up: Math.round(41 + wave(i, 11, 4)) }));
  setSlice("speed", { points: speedPts, last: speedPts.at(-1) });
  setSlice("dns", { unboundHitRate: 71.4, adguard: { queries: 18342, blocked: 4127, clients: 14 } });
  setSlice("ha", { online: true, peopleHome: 2, people: 3, lightsOn: 4, lights: 11, switchesOn: 3, switches: 8, weather: { state: "partly-cloudy", temp: 14 } });
  setSlice("uptime", { available: false, monitors: {} });
  setSlice("bots", null);
  setSlice("hooks", [
    { slug: "deploy", label: "Site deploy", description: "Git push → build → publish the static site", port: 9099, state: "running", listening: true, logMtime: t0 - 540, logTail: "[10:02:11] push received (main, 3 commits)\n[10:02:12] vite build\n[10:02:19] build ok, 412 files\n[10:02:20] published to /srv/www" },
    { slug: "notes", label: "Notes sync", description: "Git push → pull the notes vault", port: 9098, state: "running", listening: true, logMtime: t0 - 7200, logTail: "[08:15:02] push received\n[08:15:03] git pull: Already up to date." },
  ]); setSlice("botSessions", BOTS); setSlice("claudeUsage", null); setSlice("claudeJobs", []);

  setSlice("jobs", JOBS.map((j, i) => ({ id: `cron:${i}`, name: j.name, schedule: j.schedule, when: j.when, enabled: j.status !== "paused", nextRun: j.status === "paused" ? null : t0 + j.next, prevRun: t0 - j.ago,
    status: j.status, lastRun: t0 - j.ago, cause: j.status === "fail" ? "ACME server timeout" : "", log: "/var/log/demo", command: j.command, category: i < 3 ? "Backups" : "Maintenance", about: j.about, reports: null, project: null,
    runs: Array.from({ length: 10 }, (_, k) => ({ t: t0 - j.ago - k * 86400, ok: !(j.status === "fail" && k < 2) })) })));

  setSlice("alerts24", alertsPayload(1));

  const row = (port: number, process: string, scope: "local" | "network" | "tailnet", app: string | null, extra: Record<string, unknown> = {}) =>
    ({ port, proto: "tcp", scope, addresses: scope === "network" ? ["*"] : ["127.0.0.1"], process, pid: 1000 + port % 5000, app, service: null, docker: null, names: [], issue: null, ...extra });
  const rows = [
    row(22, "sshd", "network", null, { service: "SSH" }), row(80, "caddy", "network", "Caddy", { names: ["jellyfin.home", "nextcloud.home"] }),
    row(3000, "gitea", "network", "Gitea", { names: ["git.home"] }), row(3001, "node", "network", "Uptime Kuma", { docker: { container: "uptime-kuma", containerPort: 3001 }, names: ["status.home"] }),
    row(3094, "bun", "local", null, { service: "Server OS" }), row(3030, "grafana", "network", "Grafana", { docker: { container: "grafana", containerPort: 3000 } }),
    row(8053, "pihole-FTL", "network", "Pi-hole", { names: ["pihole.home"] }), row(8080, "apache2", "network", "Nextcloud", { docker: { container: "nextcloud", containerPort: 80 } }),
    row(8096, "jellyfin", "network", "Jellyfin", { docker: { container: "jellyfin", containerPort: 8096 } }), row(8123, "python3", "network", "Home Assistant", { names: ["ha.home"] }),
    row(8222, "vaultwarden", "network", "Vaultwarden", { docker: { container: "vaultwarden", containerPort: 80 } }), row(2283, "immich", "network", "Immich", { docker: { container: "immich-server", containerPort: 2283 } }),
    row(11434, "ollama", "local", "Ollama"), row(5353, "mDNSResponder", "network", null, { proto: "udp", service: "Bonjour" }), row(9777, "python3", "local", null, { issue: "unknown" }),
  ];
  setSlice("ports", { at: t0, rows, deadNames: [{ name: "paperless.home", port: 8000 }], routes: 9,
    counts: { total: rows.length, network: rows.filter((r) => r.scope === "network").length, local: rows.filter((r) => r.scope === "local").length, tailnet: 0, docker: rows.filter((r) => r.docker).length, issues: 1 } });

  // Values drift every second; the sparkline moves with them.
  let tick = 0;
  every(1_000, () => {
    tick++;
    const i = Math.floor(Date.now() / 1000);
    const cpu = Math.round(49 + wave(i, 22, 5) + wave(i, 5, 1.2)), ram = Math.round((9.4 + wave(i, 40, 0.5) + wave(i, 7, 0.08)) * 100) / 100;
    const load = Math.round((1.4 + wave(i, 18, 0.6) + wave(i, 4, 0.15)) * 100) / 100;
    setSlice("system", { cpuTemp: cpu, gpuTemp: null, load1: load, ramUsedGB: ram, ramTotalGB: 16, swapGB: 0.6, boot: t0 - 19 * 86400, internal: { totalGB: 228, freeGB: 134 }, ssd: { totalGB: 466, freeGB: 171 } });
    const h = { ...hist, t: [...hist.t.slice(1), now()], cpu: [...hist.cpu.slice(1), cpu], ram: [...hist.ram.slice(1), ram], swap: [...hist.swap.slice(1), 0.6], load: [...hist.load.slice(1), load], disk: [...hist.disk.slice(1), hist.disk.at(-1)!] };
    Object.assign(hist, h);
    setSlice("sysHistory", { ...hist });
    if (tick % 10 === 0) {
      const last = speedPts.at(-1)!, d = Math.round(238 + wave(i, 14, 22) + wave(i, 3, 6));
      setSlice("speed", { points: [...speedPts.slice(1), { ...last, t: now(), down: d }], last: { ...last, t: now(), down: d } });
    }
    if (tick % 7 === 0) setSlice("dns", { unboundHitRate: Math.round((71.4 + wave(i, 9, 0.8)) * 10) / 10, adguard: { queries: 18342 + tick * 3, blocked: 4127 + Math.floor(tick * 0.7), clients: 14 } });
  });
}

// ---------- actions: everything the demo lets you click ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function demoToggle(name: string, on: boolean) {
  const a = (getSlice<Record<string, { state: string; mem: number; parts: Record<string, boolean> }>>("apps") ?? {})[name];
  const def = APPS.find((x) => x.name === name);
  if (!a || !def) return { ok: false, detail: "unknown app" };
  void (async () => {
    await sleep(900);
    setMapEntry("apps", name, { ...a, state: on ? "on" : "off", mem: on ? def.mem || 220 : 0, parts: Object.fromEntries(Object.keys(a.parts).map((k) => [k, on])) });
    const life = (getSlice<Record<string, Record<string, unknown>>>("life") ?? {});
    setSlice("life", { ...life, [name]: { ...life[name], healthy: on, uptime24: on ? 100 : null, since: now() } });
  })();
  return { ok: true, detail: `${name} ${on ? "started" : "stopped"}` };
}

const LOG_LINES: Record<string, string[]> = {
  default: ["Starting {job}", "Checking prerequisites", "Reading configuration", "Working…", "Verifying the result", "Done in {s} s"],
  "backup-photos": ["Starting backup-photos", "Mounting /mnt/backup", "Scanning /srv/photos: 12,408 files", "Copying 38 new files (412 MB)", "Verifying checksums", "12,408 files in sync", "Done in 3.1 s"],
};
const runs = new Map<string, number>();
export function demoRunJob(id: string) {
  const jobs = getSlice<Record<string, unknown>[]>("jobs") ?? [], j = jobs.find((x) => x.id === id);
  if (!j) return { ok: false, detail: "unknown job" };
  runs.set(id, Date.now());
  const set = (patch: Record<string, unknown>) => setSlice("jobs", (getSlice<Record<string, unknown>[]>("jobs") ?? []).map((x) => (x.id === id ? { ...x, ...patch } : x)));
  set({ status: "running", cause: "" });
  setTimeout(() => set({ status: "ok", lastRun: now(), cause: "", runs: [{ t: now(), ok: true }, ...((j.runs as unknown[]) ?? []).slice(0, 9)] }), 4_500);
  return { ok: true, detail: `${j.name} started` };
}
export function demoJobLog(id: string) {
  const j = (getSlice<Record<string, unknown>[]>("jobs") ?? []).find((x) => x.id === id);
  if (!j) return null;
  const lines = LOG_LINES[String(j.name)] ?? LOG_LINES.default, at = runs.get(id);
  const shown = at ? Math.min(lines.length, Math.floor((Date.now() - at) / 700) + 1) : lines.length;
  const ts = (k: number) => new Date((at ?? Date.now() - 3600_000) + k * 700).toLocaleTimeString("en-GB", { timeZone: "UTC" });
  return lines.slice(0, shown).map((l, k) => `${ts(k)}  ${l.replace("{job}", String(j.name)).replace("{s}", "3.1")}`).join("\n");
}

let opSeq = 0;
export async function demoInstall(catalogId: string, name: string, about: string, logo: string | null, category: string) {
  const id = catalogId, started = Date.now(), opId = `demo-${++opSeq}`;
  const steps = ["Prepare the compose file", "Pull and start containers", "Wait for the web UI", "Give it an address"];
  const checklist = steps.map((label) => ({ label, state: "todo" as string, group: "Install" }));
  const publish = (state: string, step: string) => {
    setSlice("operations", [{ id: opId, app: id, name, action: "install", status: state === "installing" ? "running" : "ok", step, log: "", started, ended: state === "installing" ? null : Date.now(), traceId: "demo", actor: "web", checklist }]);
    setSlice("lifecycle", { ...(getSlice<Record<string, unknown>>("lifecycle") ?? {}), [id]: { name, logo, state, step, op: opId, agent: false, since: started, href: state === "ready" ? `http://${id}.home` : null, error: null, checklist } });
  };
  void (async () => {
    for (let k = 0; k < steps.length; k++) {
      checklist.forEach((c, i) => (c.state = i < k ? "done" : i === k ? "doing" : "todo"));
      publish("installing", steps[k]);
      await sleep(1800);
    }
    checklist.forEach((c) => (c.state = "done"));
    setMapEntry("apps", name, { name, group: category.split(" ")[0] || "Apps", order: 99, href: `http://${id}.home`, icon: "", about: about.slice(0, 120), kind: "switch", warn: false, state: "on", parts: { [id]: true }, mem: 180 });
    publish("ready", "Ready to use");
  })();
  return { id: opId, app: id, name, action: "install", status: "running", step: steps[0], log: "", started, ended: null, traceId: "demo", actor: "web", checklist };
}

export function demoStorage() {
  const GB = 1e9, total = 228 * GB, free = 134 * GB;
  const items = (xs: [string, number][]) => xs.map(([label, g]) => ({ label, path: null, bytes: g * GB }));
  const groups = [
    { id: "system", label: "System", note: "Operating system volumes", items: items([["System", 12], ["Preboot & recovery", 6], ["VM & swap", 3]]) },
    { id: "home", label: "Home folders", note: "Top-level folders in the home directory", items: items([["Documents", 9.4], ["Downloads", 6.1], ["projects", 4.8], ["Pictures", 2.2]]) },
    { id: "outside", label: "Outside home", note: "Big folders elsewhere on the disk", items: items([["Applications", 14], ["Homebrew", 6.3], ["Library", 3.9]]) },
    { id: "docker", label: "Docker", note: "Images, containers, volumes and build cache", items: items([["Images", 18.5], ["Volumes", 11.2], ["Build cache", 3.4]]) },
    { id: "notable", label: "Known space eaters", note: "Caches, dev tools, backups, logs", items: items([["Package caches", 4.1], ["Old logs", 0.6], ["Xcode caches", 2.8]]) },
  ];
  const vol = (label: string, path: string, t: number, f: number) => ({ label, path, total: t, used: t - f, free: f, pct: Math.round(((t - f) * 1000) / t) / 10 });
  const act = (id: string, label: string, desc: string, cmd: string, est: number, risk = "safe") => ({ id, label, risk, desc, cmd, volume: "Internal", estimate: est * GB, available: true, note: null, run: null });
  return { volumes: [vol("Internal SSD", "/", total, free), vol("Backup disk", "/mnt/backup", 466 * GB, 171 * GB)],
    scan: { state: "ready", started: now() - 120, finished: now() - 100, duration: 18.4, groups, error: null, denied: [] },
    actions: [act("docker-prune", "Prune Docker", "Remove unused images, stopped containers and build cache.", "docker system prune -f", 6.2),
      act("caches", "Clear package caches", "Homebrew, npm and pip caches. They download again when needed.", "brew cleanup --prune=all", 4.1),
      act("logs", "Trim old logs", "Delete logs older than 30 days.", "find <logs> -mtime +30 -delete", 0.6, "careful")], now: now() };
}

// ---------- bots: two made-up Claude Code sessions with a short conversation ----------
const BOT = (channel: string, running: boolean, protectedBot: boolean, model: string, cwd: string) => ({ channel, protected: protectedBot, restartable: true, scopable: false, tokenSet: true, cwd, model, activeModel: running ? model : null,
  running, pid: running ? 4100 + channel.length : null, telegramConnected: running, uptime: running ? "3d 4h" : null, inbox: 0,
  capabilities: { globalSkills: ["git-conventional-commit", "find-skills"], projectSkills: ["add-app", "diagnose"], mcps: [{ name: "server-os", scope: "project", enabled: true, toggleable: false }], plugins: [] } });
const BOTS = [BOT("assistant", true, true, "opus", "~/server-os/agent"), BOT("recipes", true, false, "sonnet", "~/bots/recipes"), BOT("garden", false, false, "haiku", "~/bots/garden")];
export const demoBotsFeed = () => {
  const t = now();
  const items = [
    { id: "m1", kind: "user", ts: t - 300, text: "Jellyfin feels slow tonight. Can you check?", via: "dash", from: "you" },
    { id: "s1", kind: "step", ts: t - 296, tool: "mcp__server-os__server_status", title: "server_status", detail: "", status: "ok", ms: 420, out: "RAM 9.4 of 16 GB, CPU 48 °C, load 1.4" },
    { id: "s2", kind: "step", ts: t - 290, tool: "mcp__server-os__app_logs", title: "app_logs Jellyfin", detail: "", status: "ok", ms: 610, out: "1 transcode started 21:58, hardware decoding off" },
    { id: "m2", kind: "assistant", ts: t - 280, text: "Jellyfin is healthy, but one stream is **transcoding in software** because hardware decoding is off. That keeps a CPU core busy.\n\nI can turn on hardware decoding in its settings. Want me to do that?" },
    { id: "m3", kind: "user", ts: t - 120, text: "Yes, go ahead.", via: "dash", from: "you" },
    { id: "m4", kind: "assistant", ts: t - 100, text: "Done. Hardware decoding is on and the stream now uses almost no CPU." },
  ];
  const meta = { session: { session: "demo", model: "claude-opus-5-5", contextTokens: 41200, contextLimit: 200000, permissionMode: "default", working: null, lastActivity: t - 100 }, effort: null, launchModel: "opus", jobs: [], schedules: [], requests: [], running: true, protected: true, tmux: true };
  return { items, meta };
};
