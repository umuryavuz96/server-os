import { describe, expect, test } from "bun:test";
import { guideFor, targetsOf } from "../../web/src/permGuide";

// The guides must match what System Settings really shows: Files & Folders / Removable Volumes / Automation are disclosure
// rows (expand the program, switch the places under it), Full Disk Access is a flat list with a + button.
const bun = { role: "Server OS (bun)", path: "/Users/me/.bun/bin/bun" };
const perm = (id: string, how: "dialog" | "settings", targets?: string[]) => ({ id, how, processes: [bun], targets });
const text = (g: NonNullable<ReturnType<typeof guideFor>>) => g.steps.map((s) => s.title + " " + s.body).join("\n");

describe("permission guides", () => {
  test("Files & Folders: expand step, per-folder switches, no + step", () => {
    for (const o of ["", "prompt", "pane"] as const) {
      const g = guideFor(perm("files-folders", "dialog", ["Documents Folder"]), o)!;
      expect(g.steps.some((s) => s.vis === "expand")).toBe(true);
      expect(g.steps.some((s) => s.vis === "folders")).toBe(true);
      expect(g.steps.some((s) => s.vis === "plus")).toBe(false);
      expect(/\+|plus/i.test(text(g))).toBe(false);
      expect(text(g)).toContain("Documents Folder");
      expect(text(g)).not.toContain("Switch bun on");
    }
  });
  test("with nothing configured it names the usual three folders", () => {
    expect(targetsOf({ id: "files-folders" })).toEqual(["Desktop Folder", "Documents Folder", "Downloads Folder"]);
    expect(text(guideFor(perm("files-folders", "dialog"), "pane")!)).toContain("Desktop Folder, Documents Folder, Downloads Folder");
  });
  test("the program is the real one the server reports, not a hard-coded path", () => {
    const g = guideFor(perm("files-folders", "dialog"), "pane")!;
    expect(g.name).toBe("bun");
    expect(g.steps.find((s) => s.vis === "expand")!.copy).toEqual(["/Users/me/.bun/bin/bun"]);
    expect(JSON.stringify(g)).not.toContain("/opt/");
  });
  test("outcome pane skips the popup step; prompt starts with it", () => {
    expect(guideFor(perm("files-folders", "dialog"), "pane")!.steps.some((s) => s.vis === "dialog")).toBe(false);
    expect(guideFor(perm("files-folders", "dialog"), "pane")!.steps[0].vis).toBe("sidebar");
    expect(guideFor(perm("files-folders", "dialog"), "prompt")!.steps[0].vis).toBe("dialog");
    expect(guideFor(perm("files-folders", "dialog"))!.steps[0].vis).toBe("dialog");
  });
  test("Removable Volumes and Automation are disclosure rows too", () => {
    for (const id of ["removable-volumes", "automation"]) expect(guideFor(perm(id, "dialog"), "pane")!.steps.some((s) => s.vis === "expand")).toBe(true);
    expect(text(guideFor(perm("automation", "dialog"), "pane")!)).toContain("System Events");
  });
  test("Full Disk Access keeps its + step and is a flat list", () => {
    const g = guideFor(perm("full-disk-access", "settings"))!;
    expect(g.steps.some((s) => s.vis === "plus")).toBe(true);
    expect(g.steps.some((s) => s.vis === "expand")).toBe(false);
    expect(g.steps.some((s) => s.vis === "toggle")).toBe(true);
  });
  test("Microphone and Local Network are flat lists with one switch", () => {
    for (const [id, how] of [["microphone", "settings"], ["local-network", "dialog"]] as const) {
      const g = guideFor(perm(id, how), "pane")!;
      expect(g.steps.some((s) => s.vis === "toggle")).toBe(true);
      expect(g.steps.some((s) => s.vis === "expand" || s.vis === "plus")).toBe(false);
    }
  });
  test("every step has a one-line label for the strip, at most 4 steps in a Fix", () => {
    for (const id of ["files-folders", "removable-volumes", "automation", "local-network"]) for (const o of ["", "pane"] as const) {
      const g = guideFor(perm(id, "dialog"), o)!;
      expect(g.steps.length).toBeLessThanOrEqual(4);
      for (const s of g.steps) expect(s.short.length).toBeGreaterThan(0);
    }
  });
});
