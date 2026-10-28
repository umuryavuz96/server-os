import { expect, test } from "bun:test";
import { desktopKind, detectScreen, distroFamily, installCommands, parseVnc, screenNoun, setupOptions } from "./screenSetup";
import { resolveScreen } from "./screen";

const SS = `LISTEN 0 5 127.0.0.1:5900 0.0.0.0:* users:(("x11vnc",pid=812,fd=6))
LISTEN 0 5 0.0.0.0:5901 0.0.0.0:* users:(("Xtigervnc",pid=900,fd=7))
LISTEN 0 5 192.168.1.9:5902 0.0.0.0:*
LISTEN 0 128 127.0.0.1:8080 0.0.0.0:*
LISTEN 0 5 [::]:5903 [::]:*`;

test("names follow the OS", () => {
  expect(screenNoun("darwin")).toBe("Mac screen");
  expect(screenNoun("linux")).toBe("Server screen");
});

test("distro family and desktop are read from the usual places", () => {
  expect(distroFamily('ID=ubuntu\nID_LIKE=debian')).toBe("apt");
  expect(distroFamily('ID="fedora"')).toBe("dnf");
  expect(distroFamily('ID=rocky\nID_LIKE="rhel centos fedora"')).toBe("dnf");
  expect(distroFamily('ID=endeavouros\nID_LIKE=arch')).toBe("pacman");
  expect(distroFamily('ID=gentoo')).toBe("unknown");
  expect(desktopKind("ubuntu:GNOME", "wayland")).toBe("gnome");
  expect(desktopKind("KDE", "x11")).toBe("kde");
  expect(desktopKind("sway", "wayland")).toBe("wlroots");
  expect(desktopKind("XFCE", "x11")).toBe("x11");
  expect(desktopKind("", "")).toBe("headless");
});

test("only loopback-reachable VNC listeners are found, with their process and exposure", () => {
  expect(parseVnc(SS)).toEqual([
    { port: 5900, process: "x11vnc", exposed: false },
    { port: 5901, process: "Xtigervnc", exposed: true }, // listens on every interface: flagged
    { port: 5903, process: undefined, exposed: true },
  ]); // 5902 is bound to a LAN address only: a loopback connection cannot reach it
});

test("install commands per family; unknown lists all three, nothing is run", () => {
  expect(installCommands("x11vnc", "apt")).toEqual(["sudo apt install -y x11vnc"]);
  expect(installCommands("tigervnc", "dnf")).toEqual(["sudo dnf install -y tigervnc-server"]);
  expect(installCommands("tigervnc", "pacman")).toEqual(["sudo pacman -S --needed tigervnc"]);
  expect(installCommands("x11vnc", "unknown")).toHaveLength(3);
});

test("best option first per desktop, and every command keeps VNC on loopback", () => {
  expect(setupOptions("apt", "kde")[0].id).toBe("krfb");
  expect(setupOptions("apt", "wlroots")[0].id).toBe("wayvnc");
  expect(setupOptions("apt", "headless")[0].id).toBe("tigervnc");
  for (const o of setupOptions("apt", "x11")) if (o.id !== "krfb") expect(o.then.join(" ")).toMatch(/localhost|127\.0\.0\.1/);
});

test("detectScreen on a mocked Debian GNOME box", async () => {
  const d = await detectScreen("linux", { ss: async () => SS, osRelease: () => "ID=debian", which: (n) => (n === "x11vnc" ? "/usr/bin/x11vnc" : null), env: { XDG_CURRENT_DESKTOP: "GNOME", XDG_SESSION_TYPE: "x11" } });
  expect(d).toMatchObject({ noun: "Server screen", family: "apt", desktop: "gnome", installed: ["x11vnc"] });
  expect(d.found.map((f) => f.port)).toEqual([5900, 5901, 5903]);
  expect((await detectScreen("darwin")).options).toEqual([]);
});

test("Linux picks the first listening port unless one is configured; macOS never scans", async () => {
  const cfg = { host: "127.0.0.1", port: 5900, portFixed: false, idleMinutes: 5, maxMinutes: 30, debug: false };
  const up = (ports: number[]) => async (c: { port: number }) => ports.includes(c.port);
  expect((await resolveScreen(cfg, "linux", up([5901, 5905]))).port).toBe(5901);
  expect((await resolveScreen(cfg, "linux", up([]))).port).toBe(5900);
  expect((await resolveScreen({ ...cfg, port: 5950, portFixed: true }, "linux", up([5901]))).port).toBe(5950);
  expect((await resolveScreen(cfg, "darwin", up([5901]))).port).toBe(5900);
});
