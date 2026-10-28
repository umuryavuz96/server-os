import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowed, DisplayController, parseRes, wantedSize, whyText } from "./displayMode";
import type { ResizePolicy, Runner } from "./displayMode";

// A fake display: the "helper" mutates this state like CoreGraphics would.
let dir = "", cur: { id: number; pixelWidth: number; pixelHeight: number; hidpi: boolean }, virtual = true, calls: string[][] = [], failSet = false;
type M = { pixelWidth: number; pixelHeight: number; hidpi: boolean };
let modeList: M[] = [];
const FULL: M[] = [{ pixelWidth: 3840, pixelHeight: 2160, hidpi: true }, { pixelWidth: 1920, pixelHeight: 1080, hidpi: false }, { pixelWidth: 1280, pixelHeight: 720, hidpi: false }];
const ORIG = { id: 15, pixelWidth: 3840, pixelHeight: 2160, hidpi: true };
const run: Runner = async (a) => {
  calls.push(a);
  if (a[0] === "info") return { ok: true, display: 28, builtin: false, virtual, current: { ...cur, width: cur.hidpi ? cur.pixelWidth / 2 : cur.pixelWidth, height: 0 } };
  if (a[0] === "list") return { ok: true, current: { ...cur, width: cur.pixelWidth, height: cur.pixelHeight }, modes: modeList.map((m) => ({ id: 1, width: m.hidpi ? m.pixelWidth / 2 : m.pixelWidth, height: 0, ...m })) };
  if (a[0] === "set") { if (failSet) return { ok: false }; cur = { id: a[1] === "1920" ? 16 : 5, pixelWidth: +a[1], pixelHeight: +a[2], hidpi: false }; return { ok: true }; }
  if (a[0] === "restore") { cur = { ...ORIG }; return { ok: true }; }
  if (a[0] === "reidentify") { virtual = false; return { ok: true }; }
  return { ok: false };
};
const make = (policy: ResizePolicy = true, platform: NodeJS.Platform = "darwin") => new DisplayController(run, join(dir, "m.json"), () => policy, platform);
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sos-disp-")); cur = { ...ORIG }; modeList = [...FULL]; virtual = true; calls = []; failSet = false; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("resolution names and sizes", () => {
  expect(parseRes("720p")).toBe("720p"); expect(parseRes("4k")).toBeNull(); expect(parseRes(undefined)).toBeNull();
  expect(wantedSize("native")).toBeNull(); expect(wantedSize("1080p")).toEqual([1920, 1080]); expect(wantedSize("720p")).toEqual([1280, 720]);
});

test("only the virtual display, unless the flag says any", () => {
  expect(allowed({ virtual: true, builtin: false }, true)).toBe(true);
  expect(allowed({ virtual: false, builtin: false }, true)).toBe(false); // a real monitor
  expect(allowed({ virtual: false, builtin: true }, true)).toBe(false);
  expect(allowed({ virtual: false, builtin: false }, "any")).toBe(true);
  expect(allowed({ virtual: true, builtin: false }, false)).toBe(false);
});

test("switch to 1080p, remember the original, restore it", async () => {
  const d = make();
  expect(await d.apply("1080p")).toBe("switched");
  expect(cur).toMatchObject({ pixelWidth: 1920, pixelHeight: 1080, hidpi: false });
  expect(d.switched).toBe(true);
  expect(await d.restore()).toBe(true);
  expect(cur).toEqual(ORIG);
  expect(d.switched).toBe(false);
  expect(calls.at(-1)).toEqual(["restore", "3840", "2160", "1"]);
  expect(await d.restore()).toBe(false); // nothing left to undo
});

test("a second switch keeps the first original; native puts it back", async () => {
  const d = make();
  await d.apply("1080p"); await d.apply("720p");
  expect(cur).toMatchObject({ pixelWidth: 1280 });
  expect(await d.apply("native")).toBe("restored");
  expect(cur).toEqual(ORIG);
  expect(calls.filter((c) => c[0] === "restore")).toEqual([["restore", "3840", "2160", "1"]]); // the ORIGINAL size, not the 1080p one
});

test("already at the size: nothing to do, no marker", async () => {
  cur = { id: 16, pixelWidth: 1920, pixelHeight: 1080, hidpi: false };
  const d = make();
  expect(await d.apply("1080p")).toBe("kept");
  expect(d.switched).toBe(false);
  expect(await d.apply("native")).toBe("kept"); // not ours to touch
});

test("a real monitor is left alone", async () => {
  virtual = false;
  const d = make();
  expect(await d.apply("720p")).toBe("skipped");
  expect(calls.some((c) => c[0] === "set")).toBe(false);
  expect(await make("any").apply("720p")).toBe("switched");
});

test("disabled by config or on Linux: never calls the helper", async () => {
  expect(await make(false).apply("720p")).toBe("skipped");
  expect(await make(true, "linux").apply("720p")).toBe("skipped");
  expect(calls).toEqual([]);
});

test("a failed switch leaves no marker behind", async () => {
  failSet = true;
  const d = make();
  expect(await d.apply("720p")).toBe("skipped");
  expect(d.switched).toBe(false);
});

test("stale marker from a crashed run is healed by restore() at start", async () => {
  await make().apply("720p");                  // process "dies" here: marker stays, display stays small
  expect(cur.pixelWidth).toBe(1280);
  const next = make();                         // new process
  expect(next.switched).toBe(true);
  expect(await next.restore()).toBe(true);
  expect(cur).toEqual(ORIG);
  expect(existsSync(join(dir, "m.json"))).toBe(false);
});

test("calls are queued: takeover switch lands after the earlier one", async () => {
  const d = make();
  const order = await Promise.all([d.apply("1080p").then(() => "a"), d.apply("720p").then(() => "b")]);
  expect(order).toEqual(["a", "b"]);
  expect(cur.pixelWidth).toBe(1280);
});

test("after a switch the display looks different (re-created): still ours, still switchable and restorable", async () => {
  const d = make();
  await d.apply("1080p");
  virtual = false;                              // the helper no longer recognises the display
  expect(await d.apply("720p")).toBe("switched"); // marker says it is ours
  expect(await d.restore()).toBe(true);
  expect(cur).toEqual(ORIG);
  expect(await make().apply("720p")).toBe("skipped"); // no marker: a real monitor stays alone
});

// The re-created "Display" offers 1920x1080 only (live 2026-10-27): 720p must say why, and must not touch the display.
const ONLY_1080: M[] = [{ pixelWidth: 1920, pixelHeight: 1080, hidpi: false }];

test("a display without 720p: skipped with a reason, no marker, no set call", async () => {
  cur = { id: 0, pixelWidth: 1920, pixelHeight: 1080, hidpi: false }; modeList = ONLY_1080;
  const d = make();
  const o = await d.applyWhy("720p");
  expect(o).toEqual({ result: "skipped", why: "no-mode", sizes: "1920×1080" });
  expect(whyText(o)).toBe("This screen has no such size. It only offers 1920×1080.");
  expect(d.switched).toBe(false);
  expect(calls.some((c) => c[0] === "set")).toBe(false);
  expect((await d.applyWhy("1080p")).result).toBe("kept"); // already at this size
});

test("skip reasons: real monitor, disabled", async () => {
  virtual = false;
  expect(await make().applyWhy("720p")).toMatchObject({ result: "skipped", why: "not-virtual" });
  expect(await make(false).applyWhy("720p")).toMatchObject({ why: "disabled" });
});

test("describe lists real sizes only; native = current size; read-only", async () => {
  cur = { id: 0, pixelWidth: 1920, pixelHeight: 1080, hidpi: false }; modeList = ONLY_1080;
  const d = await make().describe();
  expect(d.sizes).toEqual([
    { res: "native", width: 1920, height: 1080, available: true },
    { res: "1080p", width: 1920, height: 1080, available: true },
    { res: "720p", width: 1280, height: 720, available: false }]);
  expect(calls.every((c) => c[0] === "list" || c[0] === "info")).toBe(true);
  modeList = FULL; cur = { ...ORIG };
  expect((await make().describe()).sizes.map((s) => s.available)).toEqual([true, true, true]);
});

test("describe on a real monitor offers nothing but native", async () => {
  virtual = false;
  const d = await make().describe();
  expect(d.why).toBe("not-virtual");
  expect(d.sizes.map((s) => s.available)).toEqual([true, false, false]);
});
