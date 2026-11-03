import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { bucketHistory, callService, checkCall, DEFAULT_ALLOW, mapState } from "./ha";
import { validate } from "./dashboards";

const card = (type: string, query?: Record<string, unknown>) => ({ title: "t", cards: [{ id: "c", type, x: 0, y: 0, w: 3, h: 2, query }] });

describe("service allowlist", () => {
  test("the default covers the controllable domains and nothing else", () => {
    expect(DEFAULT_ALLOW).toEqual(["light", "switch", "fan", "climate", "media_player", "scene", "script", "input_boolean", "cover"]);
    for (const d of ["lock", "alarm_control_panel", "button", "camera", "automation", "homeassistant"]) expect(DEFAULT_ALLOW).not.toContain(d);
  });
  test("allows a plain call on an allowed domain", () => {
    expect(checkCall("light", "toggle", { entity_id: "light.kitchen" })).toBeNull();
    expect(checkCall("climate", "set_temperature", { entity_id: "climate.hall", temperature: 20.5 })).toBeNull();
    expect(checkCall("media_player", "volume_set", { entity_id: ["media_player.a", "media_player.b"], volume_level: 0.3 })).toBeNull();
  });
  test("refuses domains outside the list, including through a mismatched entity", () => {
    expect(checkCall("lock", "unlock", { entity_id: "lock.front" })).toMatch(/not allowed/);
    expect(checkCall("alarm_control_panel", "alarm_disarm", { entity_id: "alarm_control_panel.home" })).toMatch(/not allowed/);
    expect(checkCall("button", "press", { entity_id: "button.volvo_flash" })).toMatch(/not allowed/);
    expect(checkCall("light", "turn_on", { entity_id: "lock.front" })).toMatch(/not allowed/);
    expect(checkCall("light", "turn_on", { entity_id: "switch.plug" })).toMatch(/does not belong/);
  });
  test("refuses wide targets, missing entities and reload", () => {
    expect(checkCall("light", "turn_off", { area_id: "kitchen" })).toMatch(/area_id/);
    expect(checkCall("light", "turn_off", { entity_id: "light.a", device_id: "x" })).toMatch(/device_id/);
    expect(checkCall("light", "turn_off", {})).toMatch(/entity_id/);
    expect(checkCall("light", "turn_off", { entity_id: "all" })).toMatch(/not an entity id/);
    expect(checkCall("script", "reload", {})).toMatch(/reload/);
    expect(checkCall("light", "../x", { entity_id: "light.a" })).toMatch(/service/);
  });
  test("script.<name> runs without an entity_id; script.turn_on needs one", () => {
    expect(checkCall("script", "good_night", {})).toBeNull();
    expect(checkCall("script", "turn_on", {})).toMatch(/entity_id/);
  });
  test("the allowlist is configurable", () => {
    expect(checkCall("lock", "lock", { entity_id: "lock.front" }, ["lock"])).toBeNull();
    expect(checkCall("light", "toggle", { entity_id: "light.a" }, ["lock"])).toMatch(/not allowed/);
  });
  test("callService refuses before sending, and dry runs send nothing", async () => {
    let sent = 0;
    const send = async () => { sent++; return { ok: true, status: 200 }; };
    expect((await callService("lock", "unlock", { entity_id: "lock.x" }, { send })).status).toBe(403);
    const dry = await callService("light", "toggle", { entity_id: "light.x" }, { dry: true, send });
    expect(dry).toMatchObject({ ok: true, dry: true, sent: { path: "/api/services/light/toggle" } });
    expect(sent).toBe(0);
    expect((await callService("light", "toggle", { entity_id: "light.x" }, { send })).ok).toBe(true);
    expect(sent).toBe(1);
  });
});

describe("state mapping", () => {
  test("keeps what the cards read and drops the rest", () => {
    const e = mapState({ entity_id: "climate.hall", state: "heat", attributes: { friendly_name: "Hall", current_temperature: 19.2, temperature: 20, hvac_modes: ["off", "heat"], secret_blob: "x", icon: "mdi:thermostat" } });
    expect(e).toEqual({ id: "climate.hall", domain: "climate", state: "heat", name: "Hall", icon: "mdi:thermostat", attrs: { current_temperature: 19.2, temperature: 20, hvac_modes: ["off", "heat"] } });
  });
  test("sensors carry their unit; a missing friendly name falls back to the id", () => {
    expect(mapState({ entity_id: "sensor.t", state: "21.4", attributes: { unit_of_measurement: "°C" } })).toEqual({ id: "sensor.t", domain: "sensor", state: "21.4", name: "sensor.t", unit: "°C" });
  });
  test("lights carry brightness and colour (the House page tints their glow)", () => {
    const e = mapState({ entity_id: "light.salon_1", state: "on", attributes: { friendly_name: "Salon 1", brightness: 125, rgb_color: [255, 137, 14], color_temp_kelvin: 2000, hs_color: [30, 94] } });
    expect(e.attrs).toEqual({ brightness: 125, rgb_color: [255, 137, 14] });
  });
});

describe("history buckets", () => {
  const now = 100_800, hour = 3600; // on an hour boundary
  test("fixed steps, last value held across empty buckets, gap before the first state", () => {
    const s = bucketHistory([[now - 3 * hour + 100, 10], [now - hour + 100, 20]], now, 4 * hour, 4);
    expect(s.step).toBe(3600);
    expect(s.t.length).toBe(4);
    expect(s.avg[0]).toBeNull();
    expect(s.avg[1]).toBe(10);
    expect(s.avg[2]).toBe(10);
    expect(s.avg.at(-1)).toBe(15); // held 10, then 20 inside the bucket
    expect(s.min.at(-1)).toBe(10); expect(s.max.at(-1)).toBe(20);
  });
  test("a state from before the range holds from the start; unavailable becomes a gap value of null", () => {
    const s = bucketHistory([[now - 10 * hour, 5], [now - 2 * hour, null]], now, 4 * hour, 4);
    expect(s.avg[0]).toBe(5);
    expect(s.avg.at(-1)).toBeNull();
  });
});

describe("dashboard schema: Home Assistant cards", () => {
  test("every new type validates with its entity", () => {
    for (const t of ["entity", "toggle", "climate", "camera", "media", "history", "button"]) expect(validate(card(t, { entity: "sensor.x" }))).toBeNull();
    expect(validate(card("group", { entities: ["light.a", "light.b"] }))).toBeNull();
    expect(validate(card("history", { entity: "sensor.t", range: "24h", points: 100 }))).toBeNull();
  });
  test("an entity card without an entity, or with a bad id, is rejected", () => {
    expect(validate(card("toggle"))).toMatch(/needs query.entity/);
    expect(validate(card("group", { entities: [] }))).toMatch(/needs query.entities/);
    expect(validate(card("toggle", { entity: "Light Kitchen" }))).toMatch(/pattern/);
    expect(validate(card("group", { entities: Array(21).fill("light.a") }))).not.toBeNull();
  });
});

describe("example house dashboard", () => {
  const d = JSON.parse(readFileSync(join(import.meta.dir, "../../docs/examples/house-dashboard.json"), "utf8"));
  test("is valid and every cell of its 12-column grid is used once (no holes, no overlaps)", () => {
    expect(validate(d)).toBeNull();
    const rows = Math.max(...d.cards.map((c: { y: number; h: number }) => c.y + c.h));
    const used = Array.from({ length: rows }, () => Array(12).fill(0));
    for (const c of d.cards) for (let y = c.y; y < c.y + c.h; y++) for (let x = c.x; x < c.x + c.w; x++) used[y][x]++;
    expect(used.flat().every((n: number) => n === 1)).toBe(true);
  });
});
