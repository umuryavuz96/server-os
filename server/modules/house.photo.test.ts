// The photo view's maths (web/src/house/photo.ts): pure functions, so they're tested with the server suite.
import { describe, expect, test } from "bun:test";
import { isLamp, lampTint, overlayFor, projectTo, roomAtPixel, roomGlow, sunElevation, type RenderFloor } from "../../web/src/house/photo";
import { groupEntity, roomMap, type Floor, type House } from "../../web/src/house/model";

const floor: RenderFloor = {
  base: 2.8, project: [[10, 0, 0, 5], [0, 10, -20, 100]], images: { day: "d", night: "n" }, mask: "m",
  lights: { "room:kitchen": "k.webp", "light:light.desk": "desk.webp" }, rooms: { kitchen: { colour: "#2f61b0" }, hal: { colour: "#5e9fe1" } },
};

describe("house photo view", () => {
  test("projects model points with the manifest's camera", () => {
    expect(projectTo(floor, 1, 2, 0)).toEqual({ u: 15, v: 100 + 20 - 56 });
  });
  test("a light shows its own overlay, else its room's", () => {
    expect(overlayFor(floor, "light.desk", "kitchen")).toBe("desk.webp");
    expect(overlayFor(floor, "light.other", "kitchen")).toBe("k.webp");
    expect(overlayFor(floor, "light.other", null)).toBeNull();
    expect(isLamp("switch.night_light")).toBe(true);
    expect(isLamp("switch.kettle_plug")).toBe(false);
  });
  test("the 3D glow counts night-light switches (a little) and skips plugs, off and dead lamps", () => {
    const states: Record<string, { state: string; attrs?: Record<string, unknown> }> = {
      "light.salon_1": { state: "on", attrs: { brightness: 128 } }, "switch.night_light": { state: "on" },
      "switch.tv_plug": { state: "on" }, "light.hal": { state: "off" }, "light.dead": { state: "unavailable" },
    };
    const g = roomGlow([{ id: "light.salon_1", room: "living" }, { id: "switch.night_light", room: "bedroom-1" }, { id: "switch.tv_plug", room: "living" },
      { id: "light.hal", room: "hal" }, { id: "light.dead", room: "hal" }, { id: "light.nowhere", room: null }], (id) => states[id] ?? null);
    expect(Object.keys(g).sort()).toEqual(["bedroom-1", "living"]);
    expect(g.living.level).toBeCloseTo(128 / 255);
    expect(g["bedroom-1"].level).toBeGreaterThan(0);
    expect(g["bedroom-1"].level).toBeLessThan(0.1);
    expect(g.living.lamp[1]).toBeCloseTo(128 / 255); // no colour: white × brightness
    expect(g.living.own).toEqual([0, 0, 0]);
  });
  test("a night light baked on its own lights only its own map, at full strength, in its colour", () => {
    const states = { "switch.night_light": { state: "on" }, "light.bedroom": { state: "on", attrs: { brightness: 255, rgb_color: [255, 137, 14] } } };
    const pins = [{ id: "switch.night_light", room: "bedroom-1" }, { id: "light.bedroom", room: "bedroom-1" }];
    const g = roomGlow(pins, (id) => states[id as keyof typeof states] ?? null, (id) => id === "switch.night_light")["bedroom-1"];
    expect(g.own).toEqual([1, 1, 1]);
    expect(g.lamp[0]).toBeGreaterThan(g.lamp[2]); // the 2000 K ceiling light, warm
    expect(g.level).toBe(1);
  });
  test("a lamp's colour tints the baked 2700 K light: warmer for 2000 K, cooler for white, none without a colour", () => {
    expect(lampTint({})).toEqual([1, 1, 1]);
    const warm = lampTint({ rgb_color: [255, 137, 14] }), cold = lampTint({ rgb_color: [255, 255, 255] });
    expect(warm[0]).toBeGreaterThan(1); expect(warm[2]).toBeLessThan(0.6);
    expect(cold[2]).toBeGreaterThan(1.2); expect(cold[0]).toBeLessThan(1);
    const y = (t: number[]) => 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2];
    expect(y(warm)).toBeCloseTo(1, 1); expect(y(cold)).toBeCloseTo(1, 1);
  });
  test("reads the room under a pixel from the mask, tolerating a little blending", () => {
    const data = { width: 2, height: 1, data: new Uint8ClampedArray([0x2f, 0x61, 0xb2, 255, 0, 0, 0, 0]) } as unknown as ImageData;
    expect(roomAtPixel(floor, data, 0, 0)).toBe("kitchen");
    expect(roomAtPixel(floor, data, 1, 0)).toBeNull();
    expect(roomAtPixel(floor, data, 5, 0)).toBeNull();
  });
  test("sun elevation over Utrecht: high in June, low in December, down at night", () => {
    expect(sunElevation(new Date("2026-06-21T11:40:00Z"))).toBeGreaterThan(58);
    expect(sunElevation(new Date("2026-12-21T11:40:00Z"))).toBeLessThan(17);
    expect(sunElevation(new Date("2026-10-30T22:00:00Z"))).toBeLessThan(-20);
  });
  test("the 3D view's room map: room numbers per 10 cm over the plan, 0 outside", () => {
    const f: Floor = { id: "g", name: "G", level: 0, depth: 4, rooms: [{ id: "a", name: "A", rects: [{ x: 0, y: 0, w: 2, d: 4 }] }, { id: "b", name: "B", rects: [{ x: 2, y: 0, w: 1, d: 4 }] }] };
    const h: House = { name: "H", width: 3, wall: { outer: 0.3 }, floors: [f] };
    const m = roomMap(h, f), at = (x: number, y: number) => m.data[Math.floor((y - m.y0) / 0.1) * m.w + Math.floor((x - m.x0) / 0.1)];
    expect([m.x0, m.y0]).toEqual([-0.5, -0.5]);
    expect(m.sx).toBeCloseTo(m.w * 0.1);
    expect(at(1, 2)).toBe(1);
    expect(at(2.5, 3.9)).toBe(2);
    expect(at(-0.2, 1)).toBe(0);
  });
});

describe("group pins on the page", () => {
  test("on when any member is on, off when none is, unavailable when every member is dead or unknown", () => {
    const on = { state: "on" }, off = { state: "off" }, gone = { state: "unavailable" };
    expect(groupEntity("light.tv_unit_lights", "TV unit lights", [off, on, off, gone])).toEqual({ id: "light.tv_unit_lights", name: "TV unit lights", domain: "light", state: "on", attrs: { members: 4, on: 1, live: 3 } });
    expect(groupEntity("light.g", "G", [off, off, gone, null]).state).toBe("off");
    expect(groupEntity("light.g", "G", [gone, { state: "unknown" }, null]).state).toBe("unavailable");
    expect(isLamp("light.tv_unit_lights")).toBe(true);
  });
  test("a lit group glows its room like a lamp", () => {
    const g = groupEntity("light.tv_unit_lights", "TV", [{ state: "on" }, { state: "off" }]);
    expect(roomGlow([{ id: g.id, room: "living" }], () => g).living.level).toBe(1);
  });
});
