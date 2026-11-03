// Saves land in the throwaway SERVER_OS_HOME that test/preload.ts sets for every run.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { wallsOf, type House as WebHouse } from "../../web/src/house/model";
import { atTv, devicesMarkdown, getHouse, globToRe, isCustom, layout, relevant, roomAt, saveHouse, savePins, spread, validateHouse, withDefaults, type RegEntity } from "./house";
import { joinRegistry } from "./ha";

const DEFAULT = JSON.parse(readFileSync(join(import.meta.dir, "house.default.json"), "utf8"));
const ent = (id: string, area: string | null, deviceClass: string | null = null): RegEntity => ({ id, name: id, domain: id.split(".")[0], area, deviceClass, device: null });
const AREAS = [{ id: "living_room", name: "Living Room", floor: null }, { id: "kitchen", name: "Kitchen", floor: null }, { id: "garage", name: "Garage", floor: null }];

describe("house model", () => {
  test("the shipped model is valid and has two storeys", () => {
    expect(validateHouse(DEFAULT)).toBeNull();
    expect(DEFAULT.floors.map((f: { id: string }) => f.id)).toEqual(["ground", "first"]);
    expect(DEFAULT.floors[0].depth).toBe(8);
  });
  test("furniture stands inside its storey and the stairwells sit over the stairs", () => {
    for (const f of DEFAULT.floors) {
      for (const it of f.furniture ?? []) { expect(it.x).toBeGreaterThan(0); expect(it.x).toBeLessThan(DEFAULT.width); expect(it.y).toBeGreaterThan(0); expect(it.y).toBeLessThan(f.depth); }
    }
    expect(DEFAULT.floors[0].furniture.some((x: { type: string }) => x.type === "stairs")).toBe(true);
    expect(DEFAULT.floors[1].furniture.some((x: { type: string }) => x.type === "bed-box")).toBe(true);
  });
  test("stairs stand clear of every wall and have their hole in the floor above", () => {
    type It = { type: string; x: number; y: number; w: number; d: number; rot?: number };
    const box = (it: It) => { const r = ((it.rot ?? 0) * Math.PI) / 180, hx = Math.abs(Math.cos(r)) * it.w / 2 + Math.abs(Math.sin(r)) * it.d / 2, hy = Math.abs(Math.sin(r)) * it.w / 2 + Math.abs(Math.cos(r)) * it.d / 2; return [it.x - hx, it.x + hx, it.y - hy, it.y + hy]; };
    const hit = (p: number[], q: number[]) => p[0] < q[1] - 0.002 && q[0] < p[1] - 0.002 && p[2] < q[3] - 0.002 && q[2] < p[3] - 0.002;
    const wi = DEFAULT.wall.inner, wo = DEFAULT.wall.outer;
    for (const [n, f] of DEFAULT.floors.entries()) {
      const S = f.shell ?? { x: 0, y: 0, w: DEFAULT.width, d: f.depth };
      for (const it of (f.furniture as It[]).filter((x) => x.type === "stairs")) {
        const s = box(it);
        for (const w of wallsOf(DEFAULT as WebHouse, f)) {
          const lo = w.along === "x" ? Math.abs(w.at - S.y) < 0.02 : Math.abs(w.at - S.x) < 0.02;
          const [c0, c1] = w.outer ? (lo ? [w.at - wo, w.at] : [w.at, w.at + wo]) : [w.at - wi / 2, w.at + wi / 2];
          const r = w.along === "x" ? [w.a, w.b, c0, c1] : [c0, c1, w.a, w.b];
          expect(hit(s, r), `${f.id} stairs vs wall ${w.along}=${w.at} ${w.a}..${w.b}`).toBe(false);
        }
        const up = DEFAULT.floors[n + 1];
        expect((up?.voids ?? []).some((v: { x: number; y: number; w: number; d: number }) => hit(s, [v.x, v.x + v.w, v.y, v.y + v.d])), `${f.id}: no stairwell above`).toBe(true);
      }
    }
  });
  test("the living room: U sofa faces the TV, which stands on the east wall", () => {
    const g = DEFAULT.floors[0], it = (t: string) => g.furniture.find((x: { type: string }) => x.type === t);
    expect(it("tv-unit")).toMatchObject({ rot: 90 });
    expect(it("tv-unit").x).toBeGreaterThan(5);
    expect(it("sofa-u").x).toBeLessThan(it("tv-unit").x);
    expect(Math.abs(it("sofa-u").y - it("tv-unit").y)).toBeLessThan(0.3);
    expect(validateHouse(DEFAULT)).toBeNull();
  });
  test("the first floor: beds, desk and pins sit in the rooms they belong to", () => {
    const f = DEFAULT.floors[1], it = (t: string) => f.furniture.filter((x: { type: string }) => x.type === t);
    const room = (id: string) => { const p = DEFAULT.pins[id]; expect(p.floor).toBe("first"); return roomAt(f, p.x, p.y)?.id; };
    expect(roomAt(f, it("bed-box")[0].x, it("bed-box")[0].y)?.id).toBe("bedroom-1");
    expect(roomAt(f, it("bed-day")[0].x, it("bed-day")[0].y)?.id).toBe("bedroom-2");
    expect(roomAt(f, it("desk-work")[0].x, it("desk-work")[0].y)?.id).toBe("study");
    expect(room("sensor.bedroom_temperature")).toBe("bedroom-1");
    expect(room("light.study_desk_lamp")).toBe("study");
    const lamp = DEFAULT.pins["light.study_desk_lamp"], desk = it("desk-work")[0];
    expect(Math.abs(lamp.y - desk.y)).toBeLessThan(desk.w / 2);
  });
  test("an older saved house borrows furniture and voids from the shipped model", () => {
    const old = structuredClone(DEFAULT);
    for (const f of old.floors) { delete f.furniture; delete f.voids; }
        const h = withDefaults(old);
    expect(h.floors[0].furniture?.length).toBe(DEFAULT.floors[0].furniture.length);
    expect(h.floors[1].voids).toEqual(DEFAULT.floors[1].voids);
  });
  test("rejects duplicate ids, rooms outside the walls and bad pins", () => {
    const h = structuredClone(DEFAULT);
    h.floors[0].rooms[1].id = h.floors[0].rooms[0].id;
    expect(validateHouse(h)).toMatch(/used twice/);
    const out = structuredClone(DEFAULT);
    out.floors[1].rooms[0].rects[0].w = 9;
    expect(validateHouse(out)).toMatch(/outside/);
    expect(validateHouse({ ...DEFAULT, pins: { "light.a": { floor: "roof", x: 1, y: 1 } } })).toMatch(/no floor/);
    expect(validateHouse({ ...DEFAULT, pins: { "light.a": { floor: "ground", x: 1, y: 40 } } })).toMatch(/outside/);
    expect(validateHouse({ ...DEFAULT, pins: { "not an id": { floor: "ground", x: 1, y: 1 } } })).not.toBeNull();
    expect(validateHouse({ ...DEFAULT, extra: 1 })).not.toBeNull();
  });
  test("saves to the home folder and pins merge, with null removing one", () => {
    expect(isCustom()).toBe(false);
    expect(savePins({ "light.salon_1": { floor: "ground", x: 1, y: 8 }, "switch.x": { hidden: true } })).toBeNull();
    expect(isCustom()).toBe(true);
    expect(getHouse().pins).toEqual({ ...DEFAULT.pins, "light.salon_1": { floor: "ground", x: 1, y: 8 }, "switch.x": { hidden: true } });
    expect(savePins({ "switch.x": null })).toBeNull();
    expect(Object.keys(getHouse().pins ?? {})).toEqual([...Object.keys(DEFAULT.pins), "light.salon_1"]);
    expect(savePins({ "light.a": { floor: "ground", x: 99, y: 1 } })).toMatch(/outside/);
    expect(saveHouse({ ...DEFAULT, mirror: true })).toBeNull();
    expect(getHouse().mirror).toBe(true);
  });
});

describe("pin height", () => {
  test("z is optional, at most the storey height, and survives a save", () => {
    expect(validateHouse({ ...DEFAULT, pins: { "light.a": { floor: "ground", x: 1, y: 1, z: 1.4 } } })).toBeNull();
    expect(validateHouse({ ...DEFAULT, pins: { "light.a": { floor: "ground", x: 1, y: 1, z: 0 } } })).toBeNull();
    expect(validateHouse({ ...DEFAULT, pins: { "light.a": { floor: "ground", x: 1, y: 1, z: -0.1 } } })).not.toBeNull();
    expect(validateHouse({ ...DEFAULT, pins: { "light.a": { floor: "ground", x: 1, y: 1, z: (DEFAULT.storeyHeight ?? 2.8) + 0.5 } } })).toMatch(/above the ceiling/);
    expect(validateHouse({ ...DEFAULT, pins: { "light.a": { floor: "ground", x: 1, y: 1, z: "high" } } })).not.toBeNull();
    expect(savePins({ "camera.cot": { floor: "first", x: 1, y: 1, z: 0.9 } })).toBeNull();
    expect(getHouse().pins?.["camera.cot"]).toEqual({ floor: "first", x: 1, y: 1, z: 0.9 });
    expect(savePins({ "camera.cot": null })).toBeNull();
  });
  test("layout passes a stored z through and adds none to pins without one", () => {
    const h = { ...structuredClone(DEFAULT), pins: { "light.desk": { floor: "first", x: 1, y: 1, z: 0.75 }, "light.lamp": { floor: "ground", x: 1, y: 5 } } };
    const l = layout(h, [ent("light.desk", null), ent("light.lamp", null), ent("light.salon_1", "living_room")], AREAS);
    expect(l.pins.find((p) => p.id === "light.desk")).toEqual({ id: "light.desk", floor: "first", room: "bedroom-1", x: 1, y: 1, z: 0.75, auto: false });
    expect("z" in l.pins.find((p) => p.id === "light.lamp")!).toBe(false);
    expect("z" in l.pins.find((p) => p.id === "light.salon_1")!).toBe(false);
  });
});

describe("placing devices", () => {
  test("relevant keeps lights, real switches and useful sensors; drops settings and noise", () => {
    expect(relevant(ent("light.salon_1", null))).toBe(true);
    expect(relevant(ent("switch.tv_plug_socket_1", null))).toBe(true);
    expect(relevant(ent("switch.cam_privacy_mode", null))).toBe(false);
    expect(relevant(ent("switch.zhimi_de_1_mc2_physical_controls_locked_p_7_1", null))).toBe(false);
    expect(relevant(ent("sensor.air_temperature", null, "temperature"))).toBe(true);
    expect(relevant(ent("sensor.phone_battery", null, "battery"))).toBe(false);
    expect(relevant(ent("binary_sensor.hall_motion", null, "motion"))).toBe(true);
    expect(relevant(ent("button.volvo_flash", null))).toBe(false);
    expect(relevant(ent("binary_sensor.volvo_xc60_door_front_left", null, "door"), [globToRe("*.volvo_*")])).toBe(false);
    expect(relevant({ ...ent("sensor.purifier_temperature_p_3_3", null), unit: "°C" })).toBe(true); // no class, but a unit
    expect(relevant({ ...ent("sensor.purifier_filter_left", null), unit: "%" })).toBe(false);
  });
  test("area-mapped entities spread inside their room; others wait in the tray; pins win", () => {
    const h = { ...structuredClone(DEFAULT), pins: { "light.desk": { floor: "first", x: 1, y: 1 }, "switch.gone": { hidden: true } } };
    const list = [ent("light.salon_1", "living_room"), ent("light.salon_2", "living_room"), ent("switch.kettle_plug", "kitchen"), ent("light.garage", "garage"), ent("light.loose", null), ent("light.desk", "living_room"), ent("switch.gone", "kitchen"), { ...ent("media_player.old_cast", "living_room"), state: "unavailable" }];
    const l = layout(h, list, AREAS);
    const pin = (id: string) => l.pins.find((p) => p.id === id);
    expect(pin("light.salon_1")).toMatchObject({ floor: "ground", room: "living", auto: true });
    expect(pin("switch.kettle_plug")?.room).toBe("kitchen");
    expect(pin("light.desk")).toEqual({ id: "light.desk", floor: "first", room: "bedroom-1", x: 1, y: 1, auto: false });
    expect(l.unplaced.map((e) => e.id).sort()).toEqual(["light.garage", "light.loose", "media_player.old_cast"]); // dead ones wait in the tray
    expect(l.hidden).toEqual(["switch.gone"]);
    expect(l.areas.find((a) => a.id === "living_room")).toMatchObject({ room: "living", floorId: "ground", entities: 4 });
    expect(l.areas.find((a) => a.id === "garage")?.room).toBeNull();
    // every auto pin lands inside its own room
    const g = h.floors[0];
    for (const p of l.pins.filter((x) => x.auto && x.floor === "ground")) expect(roomAt(g, p.x, p.y)?.id).toBe(p.room!);
  });
  test("TV things are pinned in front of the TV, the rest spread over the room", () => {
    const list = [ent("media_player.living_tv", "living_room"), ent("media_player.soundbar", "living_room"), ent("light.living_tv_ambilight", "living_room"), ent("switch.tv_plug_socket_1", "living_room"), ent("light.salon_1", "living_room")];
    const l = layout({ ...structuredClone(DEFAULT), pins: {} }, list, AREAS), tv = DEFAULT.floors[0].furniture.find((x: { type: string }) => x.type === "tv-unit"); // no group pin taking the plug
    for (const id of ["media_player.living_tv", "media_player.soundbar", "light.living_tv_ambilight", "switch.tv_plug_socket_1"]) {
      const p = l.pins.find((x) => x.id === id)!;
      expect(Math.hypot(p.x - tv.x, p.y - tv.y), id).toBeLessThan(1.6);
      expect(p.x, id).toBeLessThan(tv.x); // in front of it, in the room
      expect(p.room).toBe("living");
    }
    expect(Math.hypot(l.pins.find((x) => x.id === "light.salon_1")!.x - tv.x, 0)).toBeGreaterThan(0.5);
    expect(atTv(DEFAULT.floors[0], DEFAULT.floors[0].rooms.find((r: { id: string }) => r.id === "kitchen"), 2)).toBeNull();
  });
  test("spread stays inside the biggest rectangle and keeps spots apart", () => {
    const room = DEFAULT.floors[0].rooms.find((r: { id: string }) => r.id === "living");
    const pts = spread(room, 12);
    expect(pts.length).toBe(12);
    for (const p of pts) { expect(p.y).toBeGreaterThan(3); expect(p.y).toBeLessThan(8); expect(p.x).toBeGreaterThan(0); expect(p.x).toBeLessThan(6); }
    expect(new Set(pts.map((p) => `${p.x},${p.y}`)).size).toBe(12);
  });
  test("the device list names areas, rooms and the tray", () => {
    const md = devicesMarkdown(DEFAULT, [ent("light.salon_1", "living_room"), ent("light.loose", null)], AREAS, new Date("2026-10-30T10:00:00Z"));
    expect(md).toContain("## Living Room (`living_room`) → Living room, Ground floor");
    expect(md).toContain("- `light.salon_1` light.salon_1 → Living room, Ground floor");
    expect(md).toContain("## Garage (`garage`) → no room yet");
    expect(md).toContain("- `light.loose` light.loose");
  });
});

describe("group pins", () => {
  const SOCKETS = [1, 2, 3, 4].map((n) => `switch.tv_plug_socket_${n}`);
  test("the shipped house has the TV unit's power strip as one lamp pin on the TV unit", () => {
    const g = DEFAULT.pins["light.tv_unit_lights"], tv = DEFAULT.floors[0].furniture.find((x: { type: string }) => x.type === "tv-unit");
    expect(g.entities).toEqual(SOCKETS);
    expect(g.floor).toBe("ground");
    expect(Math.abs(g.x - tv.x)).toBeLessThan(tv.d); // on the unit (rot 90: its depth runs across x)
    expect(Math.abs(g.y - tv.y)).toBeLessThan(tv.w / 2);
    expect(roomAt(DEFAULT.floors[0], g.x, g.y)?.id).toBe("living");
  });
  test("schema and checks: 2 to 16 entity ids, not itself, members without pins of their own", () => {
    const at = { floor: "ground", x: 4.5, y: 6 };
    expect(validateHouse({ ...DEFAULT, pins: { "light.g": { ...at, entities: SOCKETS, name: "TV" } } })).toBeNull();
    expect(validateHouse({ ...DEFAULT, pins: { "light.g": { ...at, entities: ["switch.a"] } } })).not.toBeNull();
    expect(validateHouse({ ...DEFAULT, pins: { "light.g": { ...at, entities: ["switch.a", "switch.a"] } } })).not.toBeNull();
    expect(validateHouse({ ...DEFAULT, pins: { "light.g": { ...at, entities: ["switch.a", "not an id"] } } })).not.toBeNull();
    expect(validateHouse({ ...DEFAULT, pins: { "light.g": { ...at, entities: ["light.g", "switch.a"] } } })).toMatch(/itself/);
    expect(validateHouse({ ...DEFAULT, pins: { "light.g": { ...at, entities: ["switch.a", "switch.b"] }, "switch.a": at } })).toMatch(/pin of its own/);
    expect(validateHouse({ ...DEFAULT, pins: { "light.g": { ...at, entities: ["switch.a", "switch.b"] }, "switch.a": { hidden: true } } })).toBeNull();
  });
  test("layout: one pin with its members, which get no pins and stay out of the tray", () => {
    const list = [...SOCKETS.map((id) => ent(id, "living_room")), ent("switch.loose_socket", null), ent("media_player.living_tv", "living_room")];
    const l = layout(structuredClone(DEFAULT), list, AREAS);
    expect(l.pins.find((p) => p.id === "light.tv_unit_lights")).toMatchObject({ floor: "ground", room: "living", auto: false, name: "TV unit lights", entities: SOCKETS });
    for (const id of SOCKETS) expect(l.pins.some((p) => p.id === id) || l.unplaced.some((e) => e.id === id)).toBe(false);
    expect(l.pins.some((p) => p.id === "media_player.living_tv")).toBe(true);
    expect(l.unplaced.map((e) => e.id)).toEqual(["switch.loose_socket"]);
    // a group whose members HA lists with no area still shows (the key isn't an HA entity)
    expect(layout(structuredClone(DEFAULT), SOCKETS.map((id) => ent(id, null)), AREAS).pins.map((p) => p.id)).toContain("light.tv_unit_lights");
    const md = devicesMarkdown(DEFAULT, list, AREAS);
    expect(md).toContain("`switch.tv_plug_socket_1` switch.tv_plug_socket_1 → in the group pin `light.tv_unit_lights`");
  });
  test("moving a group pin in edit mode keeps its members and name", () => {
    expect(savePins({ "light.tv_unit_lights": { floor: "ground", x: 5.4, y: 6.5, z: 0.7 } })).toBeNull();
    expect(getHouse().pins?.["light.tv_unit_lights"]).toEqual({ floor: "ground", x: 5.4, y: 6.5, z: 0.7, entities: SOCKETS, name: "TV unit lights" });
    expect(savePins({ "light.tv_unit_lights": { hidden: true } })).toBeNull();
    expect(getHouse().pins?.["light.tv_unit_lights"]).toEqual({ hidden: true });
    expect(savePins({ "light.tv_unit_lights": null })).toBeNull();
  });
});

describe("HA registry join", () => {
  test("entities take their device's area and diagnostic/disabled ones are dropped", () => {
    const r = joinRegistry(
      [{ area_id: "kitchen", name: "Kitchen", floor_id: null }],
      [{ id: "dev1", area_id: "kitchen" }],
      [
        { entity_id: "switch.dishwasher_power", device_id: "dev1", original_name: "Power" },
        { entity_id: "sensor.dishwasher_wifi", device_id: "dev1", entity_category: "diagnostic" },
        { entity_id: "light.old", disabled_by: "user" },
        { entity_id: "light.own_area", area_id: "kitchen", device_id: "dev2", original_device_class: null },
        { entity_id: "sensor.t", device_class: "temperature" },
      ],
      (id) => (id === "sensor.t" ? { id, domain: "sensor", name: "Temp", state: "21.5", unit: "°C" } : undefined),
    );
    expect(r.areas).toEqual([{ id: "kitchen", name: "Kitchen", floor: null }]);
    expect(r.entities.map((e) => [e.id, e.area])).toEqual([["switch.dishwasher_power", "kitchen"], ["light.own_area", "kitchen"], ["sensor.t", null]]);
    expect(r.entities[2]).toMatchObject({ name: "Temp", state: "21.5", deviceClass: "temperature" });
  });
});
