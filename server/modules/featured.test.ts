import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SERVER_OS_HOME ??= mkdtempSync(join(tmpdir(), "sd-feat-"));
const { Database } = await import("bun:sqlite");
const { useDatabase } = await import("../core/db");
const { dir } = await import("../core/config");
const cat = await import("./catalog");

beforeAll(() => {
  useDatabase(new Database(":memory:"));
  const d = join(dir("data"), "catalog");
  mkdirSync(d, { recursive: true });
  const cats = ["Media Streaming", "Document Management", "Password Managers", "Photo and Video Galleries", "Automation"];
  writeFileSync(join(d, "awesome-selfhosted.json"), JSON.stringify(Array.from({ length: 40 }, (_, i) => (
    { name: `App ${i}`, description: `Self-hosted tool number ${i}`, category: cats[i % cats.length], stars: 5000 - i * 10, install: { method: "linuxserver", ref: `app${i}`, label: "Docker" } }))));
  cat.rebuild();
});

// the home dir is shared with the other catalog tests in this process: leave nothing behind
afterAll(() => rmSync(join(dir("data"), "catalog", "awesome-selfhosted.json"), { force: true }));

const ids = (l: { id: string }[]) => l.map((x) => x.id);
describe("featured", () => {
  test("deterministic per week, different across weeks", () => {
    expect(ids(cat.featured(2900).hero)).toEqual(ids(cat.featured(2900).hero));
    expect(cat.featured(2900).side.map(ids)).toEqual(cat.featured(2900).side.map(ids));
    expect(ids(cat.featured(2900).hero)).not.toEqual(ids(cat.featured(2901).hero));
  });
  test("every pick resolves to a catalog item and has a kicker", () => {
    const f = cat.featured(2900);
    for (const p of [...f.hero, ...f.side.flat()]) { expect(cat.getItem(p.id)?.id).toBe(p.id); expect(p.item.id).toBe(p.id); expect(p.kicker.length).toBeGreaterThan(0); }
  });
  test("hero and sides are filled and no app is in two slots, so none shows twice at once", () => {
    const f = cat.featured(2900);
    expect(f.hero.length).toBeGreaterThanOrEqual(6);
    expect(f.side.length).toBe(2);
    for (const s of f.side) expect(s.length).toBeGreaterThanOrEqual(3);
    const all = ids([...f.hero, ...f.side.flat()]);
    expect(new Set(all).size).toBe(all.length);
    const n = Math.max(f.hero.length, ...f.side.map((s) => s.length));
    for (let i = 0; i < n * 3; i++) {
      const shown = [f.hero[i % f.hero.length], ...f.side.map((s) => s[i % s.length])].map((x) => x.id);
      expect(new Set(shown).size).toBe(shown.length);
    }
  });
});
