import { expect, test } from "bun:test";
import { expiry, isUserInput, parseClientSettings, ScreenStats, screenConfig } from "./screen";
import type { Config } from "../core/config";

const cfg = (screen: unknown) => ({ integrations: { screen } }) as unknown as Config;

test("off unless enabled, and only ever this machine", () => {
  expect(screenConfig(cfg(undefined))).toBeNull();
  expect(screenConfig(cfg({ enabled: false }))).toBeNull();
  expect(screenConfig(cfg({ enabled: true }))).toEqual({ host: "127.0.0.1", port: 5900, portFixed: false, idleMinutes: 5, maxMinutes: 30, debug: false });
  expect(screenConfig(cfg({ enabled: true, host: "::1", port: 5901, idleMinutes: 2, maxMinutes: 10, debug: false }))).toEqual({ host: "::1", port: 5901, portFixed: true, idleMinutes: 2, maxMinutes: 10, debug: false });
  expect(screenConfig(cfg({ enabled: true, host: "192.168.1.20" }))).toBeNull(); // never a relay to another host
  expect(screenConfig(cfg({ enabled: true, resizeDisplay: false }))!.resizeDisplay).toBe(false);
  expect(screenConfig(cfg({ enabled: true, resizeDisplay: "any" }))!.resizeDisplay).toBe("any");
  expect(screenConfig(cfg({ enabled: true, resizeDisplay: "yes" }))!.resizeDisplay).toBeUndefined(); // default applies
  expect(screenConfig(cfg({ enabled: true, idleMinutes: -1, maxMinutes: "x" }))!.idleMinutes).toBe(5);
});

test("screen-update requests are not activity; keys, pointer and the handshake are", () => {
  const fbur = [3, 1, 0, 0, 0, 0, 7, 128, 4, 56];
  expect(isUserInput(new Uint8Array(fbur))).toBe(false);
  expect(isUserInput(new Uint8Array([...fbur, ...fbur]))).toBe(false);
  expect(isUserInput(new Uint8Array([5, 0, 0, 10, 0, 20]))).toBe(true); // PointerEvent
  expect(isUserInput(new Uint8Array([4, 1, 0, 0, 0, 0, 0, 97]))).toBe(true); // KeyEvent
  expect(isUserInput(new TextEncoder().encode("RFB 003.008\n"))).toBe(true);
  expect(isUserInput(new Uint8Array([5, 0, 0, 10, 0, 20, 0, 0, 0, 0]))).toBe(true); // 10 bytes but not type 3
  expect(isUserInput(new Uint8Array())).toBe(false);
});

test("idle timeout and hard cap", () => {
  const c = { host: "127.0.0.1", port: 5900, portFixed: false, idleMinutes: 5, maxMinutes: 30, debug: false }, t0 = 1_000_000;
  expect(expiry({ started: t0, lastInput: t0 }, c, t0 + 60_000)).toBeNull();
  expect(expiry({ started: t0, lastInput: t0 }, c, t0 + 5 * 60_000)).toBe("idle");
  expect(expiry({ started: t0, lastInput: t0 + 29 * 60_000 }, c, t0 + 30 * 60_000)).toBe("max"); // busy, but over the cap
  expect(expiry({ started: t0, lastInput: t0 + 20 * 60_000 }, c, t0 + 24 * 60_000)).toBeNull();
});

test("debug is opt-in", () => {
  expect(screenConfig(cfg({ enabled: true, debug: true }))!.debug).toBe(true);
});

test("client picture settings are read from exact-length frames only", () => {
  const enc = [0, 7, 16, 5, -223, 1000], f = new Uint8Array(4 + 4 * enc.length), v = new DataView(f.buffer);
  f[0] = 2; v.setUint16(2, enc.length); enc.forEach((e, i) => v.setInt32(4 + 4 * i, e));
  expect(parseClientSettings(f)).toEqual({ encodings: enc });
  expect(parseClientSettings(f.subarray(0, f.length - 1))).toBeNull(); // wrong length: not a SetEncodings
  const pf = new Uint8Array(20); pf[4] = 16;
  expect(parseClientSettings(pf)).toEqual({ bpp: 16 });
  expect(parseClientSettings(new TextEncoder().encode("RFB 003.889\n"))).toBeNull();
  expect(parseClientSettings(new Uint8Array())).toBeNull();
});

test("stats turn counters into per-second rates", () => {
  const s = new ScreenStats(), t0 = Date.now();
  s.down = 2048 * 10; s.downMsgs = 40; s.up = 100; s.upMsgs = 4;
  expect(s.rates(t0 + 2000)).toMatchObject({ downKBps: 10, downMsgsPerSec: 20, upMsgsPerSec: 2 });
  expect(s.rates(t0 + 4000)).toMatchObject({ downKBps: 0, downMsgsPerSec: 0 }); // the next window starts from zero
});
