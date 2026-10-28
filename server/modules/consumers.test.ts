import { describe, expect, test } from "bun:test";
import { bundleOf, findEvents, parseMem } from "./consumers";

describe("memory users", () => {
  test("top's MEM column in MB", () => {
    expect(parseMem("8258M")).toBe(8258);
    expect(parseMem("1.5G")).toBe(1536);
    expect(parseMem("512K")).toBe(0.5);
    expect(parseMem("12M+")).toBe(12);
  });
  test("the outermost app bundle names a process", () => {
    expect(bundleOf("/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild")).toBe("Xcode");
    expect(bundleOf("/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper")).toBe("Google Chrome");
    expect(bundleOf("/opt/homebrew/bin/node")).toBeNull();
  });
  test("a swap jump becomes one event at its peak", () => {
    const t = Array.from({ length: 40 }, (_, i) => 1000 + i * 15);
    const v = t.map((_, i) => (i < 20 ? 3.4 : i < 22 ? 3.8 : 4.1));
    const ev = findEvents("swap", { t, v }, 0);
    expect(ev.length).toBe(1);
    expect(ev[0].value).toBe(4.1);
    expect(ev[0].delta).toBeCloseTo(0.7, 5);
  });
  test("small wobbles and unknown metrics give no events", () => {
    const t = [0, 15, 30, 45], v = [3.4, 3.5, 3.45, 3.5];
    expect(findEvents("swap", { t, v }, 0)).toEqual([]);
    expect(findEvents("disk", { t, v: [10, 50, 90, 99] }, 0)).toEqual([]);
  });
});
