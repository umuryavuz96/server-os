// Remote screen, per OS: what to call it, what is already listening, and the exact commands to get a VNC server
// running on Linux. Nothing here installs or starts anything: it only reads (ss, /etc/os-release, which) and builds
// text for the panel to show, with copy buttons.
import { readFileSync } from "node:fs";
import { run } from "../lib";

export type Family = "apt" | "dnf" | "pacman" | "unknown";
export type Desktop = "gnome" | "kde" | "wlroots" | "x11" | "headless";

export const screenNoun = (platform: NodeJS.Platform = process.platform) => (platform === "darwin" ? "Mac screen" : "Server screen");

/** Package manager family from /etc/os-release contents (ID and ID_LIKE). */
export function distroFamily(osRelease: string): Family {
  const v = (k: string) => new RegExp(`^${k}=(.*)$`, "m").exec(osRelease)?.[1]?.replace(/["']/g, "").toLowerCase() ?? "";
  const ids = `${v("ID")} ${v("ID_LIKE")}`.split(/\s+/);
  if (ids.some((i) => ["debian", "ubuntu", "raspbian", "linuxmint", "pop"].includes(i))) return "apt";
  if (ids.some((i) => ["fedora", "rhel", "centos", "rocky", "almalinux", "suse", "opensuse"].includes(i))) return "dnf";
  if (ids.some((i) => ["arch", "manjaro", "endeavouros"].includes(i))) return "pacman";
  return "unknown";
}

/** Which kind of desktop session this is, from XDG_CURRENT_DESKTOP / XDG_SESSION_TYPE (empty on a headless box). */
export function desktopKind(desktop = "", session = ""): Desktop {
  const d = desktop.toLowerCase(), s = session.toLowerCase();
  if (!d && !s) return "headless";
  if (d.includes("gnome") || d.includes("unity")) return "gnome";
  if (d.includes("kde") || d.includes("plasma")) return "kde";
  if (s === "wayland") return "wlroots"; // sway, hyprland, river, ...: anything Wayland that is not GNOME/KDE
  return s === "x11" || d ? "x11" : "headless";
}

export interface SetupOption { id: string; title: string; note: string; install: string[]; then: string[] }

const PKG: Record<string, Record<Exclude<Family, "unknown">, string>> = {
  x11vnc: { apt: "x11vnc", dnf: "x11vnc", pacman: "x11vnc" },
  wayvnc: { apt: "wayvnc", dnf: "wayvnc", pacman: "wayvnc" },
  krfb: { apt: "krfb", dnf: "krfb", pacman: "krfb" },
  gnome: { apt: "gnome-remote-desktop", dnf: "gnome-remote-desktop", pacman: "gnome-remote-desktop" },
  tigervnc: { apt: "tigervnc-standalone-server tigervnc-common", dnf: "tigervnc-server", pacman: "tigervnc" },
};
export function installCommands(pkg: keyof typeof PKG, family: Family): string[] {
  const p = PKG[pkg];
  const one = (f: Exclude<Family, "unknown">) => (f === "apt" ? `sudo apt install -y ${p.apt}` : f === "dnf" ? `sudo dnf install -y ${p.dnf}` : `sudo pacman -S --needed ${p.pacman}`);
  return family === "unknown" ? (["apt", "dnf", "pacman"] as const).map((f) => `# ${f}: ${one(f)}`) : [one(family)];
}

/** The ways to get a VNC server for this desktop, best first. Every one binds to loopback only, so the panel's pipe is the only way in. */
export function setupOptions(family: Family, desktop: Desktop): SetupOption[] {
  const all: Record<string, SetupOption> = {
    x11vnc: { id: "x11vnc", title: "x11vnc (X11 desktop)", note: "Shares the running X11 session. Password login (VNC auth), works with the panel's viewer.",
      install: installCommands("x11vnc", family),
      then: ["x11vnc -storepasswd   # asks for a password, stores it in ~/.vnc/passwd", "x11vnc -display :0 -localhost -rfbauth ~/.vnc/passwd -forever -shared -bg"] },
    wayvnc: { id: "wayvnc", title: "wayvnc (Wayland: sway, Hyprland, other wlroots)", note: "Shares a wlroots Wayland session. Plain VNC on loopback.",
      install: installCommands("wayvnc", family), then: ["wayvnc 127.0.0.1 5900   # run inside the Wayland session"] },
    krfb: { id: "krfb", title: "KDE Desktop Sharing (krfb)", note: "Shares a Plasma session. Set an unattended-access password in its settings; Wayland sessions ask for approval at the desk.",
      install: installCommands("krfb", family), then: ["krfb   # open Settings → Unattended Access → set a password; then keep it running"] },
    gnome: { id: "gnome", title: "GNOME Remote Desktop", note: "Built into GNOME. Its VNC mode uses an encrypted VeNCrypt that the panel's viewer does not speak yet, so prefer x11vnc, wayvnc or TigerVNC if the viewer reports a security failure.",
      install: installCommands("gnome", family),
      then: ["grdctl vnc enable", "grdctl vnc set-auth-method password", "grdctl vnc set-password   # prompts for the password", "systemctl --user enable --now gnome-remote-desktop"] },
    tigervnc: { id: "tigervnc", title: "TigerVNC (virtual desktop, no monitor needed)", note: "Starts its own desktop session. Needs a desktop installed (xfce4, openbox, ...). Listens on 5901.",
      install: installCommands("tigervnc", family),
      then: ["vncpasswd   # sets the password", "vncserver :1 -localhost yes -geometry 1920x1080 -xstartup /usr/bin/startxfce4   # port 5901"] },
  };
  const order: Record<Desktop, string[]> = {
    gnome: ["x11vnc", "gnome", "tigervnc"], kde: ["krfb", "x11vnc", "tigervnc"], wlroots: ["wayvnc", "tigervnc"],
    x11: ["x11vnc", "tigervnc"], headless: ["tigervnc", "x11vnc"],
  };
  return order[desktop].map((k) => all[k]);
}

export interface Found { port: number; process?: string; /** listens on more than loopback */ exposed: boolean }
/** VNC-looking listeners (5900-5910) from `ss -Hltnp`, only those a loopback connection reaches. */
export function parseVnc(ss: string, from = 5900, to = 5910): Found[] {
  const out = new Map<number, Found>();
  for (const line of ss.split("\n")) {
    const m = /^\S+\s+\d+\s+\d+\s+(\S+):(\d+)\s/.exec(line.trim());
    if (!m) continue;
    const addr = m[1].replace(/[\[\]]/g, ""), port = Number(m[2]);
    if (port < from || port > to) continue;
    const loop = addr === "127.0.0.1" || addr === "::1", any = addr === "*" || addr === "0.0.0.0" || addr === "::";
    if (!loop && !any) continue;
    const prev = out.get(port);
    out.set(port, { port, process: /users:\(\("([^"]+)"/.exec(line)?.[1] ?? prev?.process, exposed: (prev?.exposed ?? false) || any });
  }
  return [...out.values()].sort((a, b) => a.port - b.port);
}

const SERVERS = ["x11vnc", "Xvnc", "Xtigervnc", "vncserver", "wayvnc", "krfb", "grdctl"];
export interface ScreenDetect { platform: string; noun: string; family: Family; desktop: Desktop; found: Found[]; installed: string[]; options: SetupOption[] }

export interface DetectDeps { ss: () => Promise<string>; osRelease: () => string; which: (n: string) => string | null; env: Record<string, string | undefined> }
const realDeps: DetectDeps = {
  ss: async () => (await run(["ss", "-Hltnp"], 4000)).out,
  osRelease: () => { try { return readFileSync("/etc/os-release", "utf8"); } catch { return ""; } },
  which: (n) => Bun.which(n), env: process.env,
};

/** What this machine has for a remote screen. Linux only does real work; macOS answers with its name. */
export async function detectScreen(platform: NodeJS.Platform = process.platform, deps: DetectDeps = realDeps): Promise<ScreenDetect> {
  const base = { platform, noun: screenNoun(platform) };
  if (platform !== "linux") return { ...base, family: "unknown", desktop: "x11", found: [], installed: [], options: [] };
  const family = distroFamily(deps.osRelease()), desktop = desktopKind(deps.env.XDG_CURRENT_DESKTOP, deps.env.XDG_SESSION_TYPE);
  return { ...base, family, desktop, found: parseVnc(await deps.ss()), installed: SERVERS.filter((s) => deps.which(s)), options: setupOptions(family, desktop) };
}
