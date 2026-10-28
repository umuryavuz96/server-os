import { expect, test } from "bun:test";
import { catalog, describe, oneAtATime, sampleFile, sampleText, wav } from "./voiceShowcase";

test("samples are made one at a time, and a failure doesn't block the next", async () => {
  const order: string[] = [];
  const slow = oneAtATime(async () => { order.push("a:start"); await Bun.sleep(20); order.push("a:end"); return "a"; });
  const failing = oneAtATime(async () => { order.push("b"); throw new Error("no sound"); });
  const quick = oneAtATime(async () => { order.push("c"); return "c"; });
  expect(await slow).toBe("a");
  await expect(failing).rejects.toThrow("no sound");
  expect(await quick).toBe("c");
  expect(order).toEqual(["a:start", "a:end", "b", "c"]);
});

test("voices get a name, language, engine and cost from their id", () => {
  expect(describe("af_heart")).toMatchObject({ name: "Heart", lang: "en", engine: "Kokoro", accent: "American", cloud: false, cost: "free" });
  expect(describe("bm_george")).toMatchObject({ name: "George", accent: "British" });
  expect(describe("ef_dora")).toMatchObject({ lang: "es", language: "Spanish" });
  expect(describe("chatterbox")).toMatchObject({ lang: "en", engine: "Chatterbox Turbo" });
  expect(describe("tr-xtts-damien")).toMatchObject({ name: "Damien", lang: "tr", engine: "XTTS-v2" });
  expect(describe("tr-piper")).toMatchObject({ name: "Piper", engine: "Piper" });
  expect(describe("tr-hasan", ["tr-hasan"], { "tr-hasan": "Hasan (ElevenLabs, cloud)" })).toMatchObject({ name: "Hasan", cloud: true, cost: "ElevenLabs credits", engine: "ElevenLabs Flash v2.5" });
});

test("sample sentences: Turkish for tr, English otherwise, and short enough for a cloud sample", () => {
  expect(sampleText("tr")).toContain("Merhaba");
  expect(sampleText("en")).toContain("Hello");
  expect(sampleText("tr").length).toBeLessThan(80);
});

test("PCM is wrapped as a playable WAV", () => {
  const w = wav(new Uint8Array(48000));
  expect(new TextDecoder().decode(w.slice(0, 4))).toBe("RIFF");
  expect(new TextDecoder().decode(w.slice(8, 12))).toBe("WAVE");
  expect(w.length).toBe(48044);
});

test("a sample is refused for a bad voice name", async () => {
  expect(await sampleFile("../etc/passwd")).toMatchObject({ status: 400 });
});

test("the open-source catalog is complete and its links are https", () => {
  const c = catalog();
  expect(c.length).toBeGreaterThanOrEqual(10);
  for (const e of c) {
    for (const k of ["name", "languages", "license", "size", "note"] as const) expect(e[k].length).toBeGreaterThan(0);
    expect(e.repo).toMatch(/^https:\/\//); expect(e.demo).toMatch(/^https:\/\//);
    expect(["yes", "no", "community", "n/a"]).toContain(e.turkish);
  }
  expect(c.find((e) => e.id === "freya")?.turkish).toBe("yes");
  expect(c.find((e) => e.id === "kokoro")?.turkish).toBe("no");
  expect(new Set(c.map((e) => e.id)).size).toBe(c.length);
});
