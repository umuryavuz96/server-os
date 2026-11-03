<script setup lang="ts">
// House page: a live 3D dollhouse of the house (server/modules/house.ts holds the model) with Home Assistant devices
// pinned in their rooms. Rooms glow with their lights; tap a pin for its card; edit mode moves pins and places the
// devices that have no room yet. The scene is three.js (web/src/house/scene.ts); pins and labels are HTML laid over it.
// With renders (bun run house:render) the 3D view shows the baked photo scene (web/src/house/baked.ts) and a Photo
// view shows the renders themselves.
// kiosk (the TV, #house?kiosk=1, views/HouseKiosk.vue): full screen, no tools, big labels, D-pad only (see tvKey below).
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch, watchEffect } from "vue";
import { S, api, toast, type HaEntity } from "../store";
import Icon from "../components/Icon.vue";
import HouseRooms from "./HouseRooms.vue";
import HaCard from "../dash/HaCard.vue";
import { callOn, dead, entityOf as haEntityOf, fmtValue, iconFor, isOn, toggleEntity, typeFor } from "../dash/ha";
import type { IconName } from "../icons";
import { HouseScene, paletteFrom } from "../house/scene";
import { PIN_Z, biggest, groupEntity, roomAt, shellOf, type HouseView, type PinSpot, type RegEntity } from "../house/model";
import { isLamp, lampLevel, lampTint, overlayFor, projectTo, renderUrl, roomAtPixel, roomGlow, sunElevation, type RenderManifest } from "../house/photo";
import type { GlbManifest } from "../house/baked";

const props = defineProps<{ kiosk?: boolean }>();
const emit = defineEmits<{ exit: [] }>();
const stage = ref<HTMLElement | null>(null), host = ref<HTMLElement | null>(null);
const data = ref<HouseView | null>(null), err = ref(""), loading = ref(true);
const VIEW_KEY = "sd.house.view";
const view = ref<string>((() => { try { return props.kiosk ? "ground" : localStorage.getItem(VIEW_KEY) ?? "all"; } catch { return "all"; } })());
const edit = ref(false), saving = ref(false);
/** Unsaved pin changes: a spot, { hidden } (taken off the house) or null (back to its HA area). */
const draft = reactive<Record<string, PinSpot | null>>({});
const dirty = computed(() => Object.keys(draft).length);
const openId = ref<string | null>(null);
const armed = ref<string | null>(null); // a tray device waiting for a tap on a room (touch)
const q = ref(""), showDead = ref(false);
let sc: HouseScene | null = null;

// ---------- group pins: one pin for several HA entities (the TV unit's power strip) ----------
const groups = computed(() => new Map((data.value?.pins ?? []).filter((p) => p.entities?.length).map((p) => [p.id, p])));
/** The live entity behind a pin: an HA entity, or a group pin worked out from its members. */
function entityOf(id: string): HaEntity | null {
  const g = groups.value.get(id);
  return g ? groupEntity(id, g.name ?? id, g.entities!.map(haEntityOf)) : haEntityOf(id);
}
/** Flip a pin: a group switches every reachable member the same way (off when any is on). */
function togglePin(e: HaEntity): Promise<boolean> {
  const g = groups.value.get(e.id);
  if (!g) return toggleEntity(e);
  const on = !isOn(e), live = g.entities!.filter((m) => !dead(haEntityOf(m)));
  return Promise.all(live.map((m) => callOn(m, on ? "turn_on" : "turn_off", {}, { state: on ? "on" : "off" }))).then((r) => r.every(Boolean));
}

// ---------- photo view (renders from tools/house-render) ----------
const manifest = ref<RenderManifest | null>(null);
const MODE_KEY = "sd.house.mode", SKY_KEY = "sd.house.sky", PFLOOR_KEY = "sd.house.pfloor";
const stored = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const store = (k: string, v: string) => { if (props.kiosk) return; try { localStorage.setItem(k, v); } catch { /* private window */ } };
// no choice made yet: 3D when there are baked models (it looks like the photo and turns), else the photo
const mode = ref<"photo" | "3d" | "rooms">(props.kiosk ? "3d" : (stored(MODE_KEY) as "photo" | "3d" | "rooms" | null) ?? "3d");
const hasRooms = ref(false); // eye-level renders exist (data/house-views): the Rooms view
const rooms = computed(() => mode.value === "rooms" && hasRooms.value && !edit.value);
const sky = ref<"auto" | "day" | "night">((stored(SKY_KEY) as "auto" | "day" | "night" | null) ?? "auto");
const roomPop = ref<{ room: string; x: number; y: number } | null>(null);
watch(mode, (m) => {
  store(MODE_KEY, m); openId.value = null; roomPop.value = null;
  // same storey across the switch; the 3D view starts at the photo's angle
  if (m === "3d" && glb.value?.floors[pfloor.value]) view.value = pfloor.value;
  else if (m === "photo" && manifest.value?.floors[view.value]) pfloor.value = view.value;
});
watch(sky, (v) => store(SKY_KEY, v));
/** Photo view whenever there are renders and we're not editing (moving pins needs the 3D view). */
const photo = computed(() => mode.value === "photo" && !!manifest.value && !edit.value);
const glb = computed(() => (manifest.value as (RenderManifest & { glb?: GlbManifest }) | null)?.glb ?? null);
const glbUrl = (file: string) => `/api/v1/house/render/${file}?v=${encodeURIComponent(glb.value?.generated ?? "")}`;
const pfloors = computed(() => floors.value.filter((f) => manifest.value?.floors[f.id]));
const pfloor = ref<string>((!props.kiosk && stored(PFLOOR_KEY)) || "ground");
watch(pfloor, (v) => { store(PFLOOR_KEY, v); openId.value = null; roomPop.value = null; });
const rf = computed(() => manifest.value?.floors[pfloor.value] ?? null);
const now = ref(Date.now());
const clock = setInterval(() => { now.value = Date.now(); }, 60_000);
/** Night from HA's sun.sun when it's streamed, else from the sun's height over Utrecht. */
const night = computed(() => {
  if (sky.value !== "auto") return sky.value === "night";
  const sun = S.haEntities["sun.sun"];
  if (sun && (sun.state === "below_horizon" || sun.state === "above_horizon")) return sun.state === "below_horizon";
  return sunElevation(new Date(now.value)) < -3;
});
const skyNext = computed(() => ({ auto: "day", day: "night", night: "auto" } as const)[sky.value]);
/** Light overlays on the shown storey: one per lit lamp, its brightness as the opacity and its colour as a tint (the
 *  brightest wins per picture). */
const overlays = computed(() => {
  const f = rf.value, out = new Map<string, { o: number; tint: [number, number, number] }>();
  if (!f) return out;
  for (const p of pins.value) {
    if (p.floor !== pfloor.value || !isLamp(p.id)) continue;
    const e = entityOf(p.id);
    if (!e || dead(e) || !isOn(e)) continue;
    const file = overlayFor(f, p.id, p.room);
    if (!file) continue;
    const b = lampLevel(e, 0.3);
    if (b > (out.get(file)?.o ?? 0)) out.set(file, { o: b, tint: lampTint(e.attrs) });
  }
  return out;
});
/** Per tinted overlay a colour filter (the renders are 2700 K): the tint, taken to the pictures' sRGB. */
const tintFilters = computed(() => [...overlays.value].map(([file, { tint }]) => [file, tint] as const).filter(([, t]) => t.some((v) => Math.abs(v - 1) > 0.02)).map(([file, t], i) => ({ file, id: `hs-tint-${i}`, values: `${t.map((v, k) => [0, 1, 2].map((j) => (j === k ? Math.pow(v, 1 / 2.2).toFixed(3) : "0")).join(" ") + " 0 0").join(" ")} 0 0 0 1 0` })));
const tintOf = (file: string) => { const f = tintFilters.value.find((x) => x.file === file); return f ? `url(#${f.id})` : undefined; };
/** Every overlay of this storey stays in the DOM (loaded, at opacity 0), so a light fades in at once when it turns on. */
const overlayFiles = computed(() => (rf.value ? [...new Set(Object.values(rf.value.lights))] : []));
const litRooms = computed(() => {
  const f = rf.value, out = new Set<string>();
  if (f) for (const r of Object.keys(f.rooms)) if (f.lights[`room:${r}`] && overlays.value.has(f.lights[`room:${r}`])) out.add(r);
  for (const p of pins.value) if (p.floor === pfloor.value && p.room && f && overlays.value.has(overlayFor(f, p.id, p.room) ?? "")) out.add(p.room);
  return out;
});

// the picture's box inside the stage: contain, centred
const photoBox = ref({ w: 0, h: 0, s: 1 });
let pro: ResizeObserver | null = null;
function fitPhoto() {
  const el = stage.value, m = manifest.value;
  if (!el || !m) return;
  const W = el.clientWidth, H = el.clientHeight, s = Math.min(W / m.width, H / m.height) * 0.97;
  photoBox.value = { w: m.width * s, h: m.height * s, s };
}
watch([manifest, photo], () => nextTick(fitPhoto));
const photoPins = computed(() => {
  const f = rf.value, m = manifest.value, s = photoBox.value.s;
  if (!f || !m) return [];
  return shownPins.value.filter((p) => p.floor === pfloor.value).map((p) => {
    const fixed = !p.moved && p.z == null ? m.pins?.[p.id] : undefined; // the renders place pins at the default height
    const { u, v } = fixed && fixed.floor === p.floor ? fixed : projectTo(f, p.x, p.y, p.z ?? PIN_Z);
    return { ...p, left: u * s, top: v * s };
  });
});
const photoLabels = computed(() => {
  const f = rf.value, s = photoBox.value.s, fl = floors.value.find((x) => x.id === pfloor.value);
  if (!f || !fl) return [];
  return fl.rooms.filter((r) => f.rooms[r.id]?.centre && biggest(r).w * biggest(r).d >= 1.2).map((r) => {
    const [u, v] = f.rooms[r.id].centre!;
    return { id: r.id, name: r.name, left: u * s, top: v * s };
  });
});
// room taps: the mask's colour under the finger
const masks = new Map<string, ImageData>();
async function maskData(): Promise<ImageData | null> {
  const f = rf.value, m = manifest.value;
  if (!f || !m) return null;
  if (masks.has(f.mask)) return masks.get(f.mask)!;
  const img = new Image();
  img.src = renderUrl(m, f.mask);
  try { await img.decode(); } catch { return null; }
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext("2d", { willReadFrequently: true });
  if (!g) return null;
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height);
  masks.set(f.mask, d);
  return d;
}
const photoEl = ref<HTMLElement | null>(null);
async function photoTap(ev: PointerEvent) {
  const f = rf.value, el = photoEl.value, box = stage.value?.getBoundingClientRect(), m = manifest.value;
  if (!f || !el || !box || !m) return;
  const r = el.getBoundingClientRect(), s = photoBox.value.s;
  const data = await maskData();
  const room = data ? roomAtPixel(f, data, ((ev.clientX - r.left) / s) * (data.width / m.width), ((ev.clientY - r.top) / s) * (data.height / m.height)) : null;
  openId.value = null;
  roomPop.value = room && roomPop.value?.room !== room ? { room, x: Math.min(Math.max(12, ev.clientX - box.left - 130), box.width - 272), y: Math.min(ev.clientY - box.top + 12, box.height - 220) } : null;
}
const roomPins = computed(() => (roomPop.value ? pins.value.filter((p) => p.floor === pfloor.value && p.room === roomPop.value!.room) : []));
function openPin(id: string) { roomPop.value = null; openId.value = id; }
async function loadManifest() {
  try { manifest.value = await api<RenderManifest>("/house/render/manifest.json"); }
  catch { manifest.value = null; }
  if (manifest.value && !manifest.value.floors[pfloor.value]) pfloor.value = Object.keys(manifest.value.floors)[0] ?? "ground";
  if (!stored(MODE_KEY) && manifest.value && !glb.value) mode.value = "photo";
  sc?.setBaked(glb.value, glbUrl);
}
watch(night, (n) => sc?.setNight(n));
watch(photo, (on) => { if (sc) { sc.paused = on; if (!on) nextTick(() => sc?.frame(false)); } });
watch(edit, (on) => { if (on && mode.value === "photo" && manifest.value) view.value = pfloor.value; });

const house = computed(() => data.value?.house ?? null);
const floors = computed(() => house.value?.floors ?? []);
const floorName = (id: string) => floors.value.find((f) => f.id === id)?.name ?? id;
const roomName = (floor: string, room: string | null) => floors.value.find((f) => f.id === floor)?.rooms.find((r) => r.id === room)?.name ?? "";

interface ShownPin { id: string; floor: string; room: string | null; x: number; y: number; z?: number; auto: boolean; moved: boolean }
const pins = computed<ShownPin[]>(() => {
  const out = new Map<string, ShownPin>();
  for (const p of data.value?.pins ?? []) out.set(p.id, { ...p, moved: false });
  for (const [id, d] of Object.entries(draft)) {
    if (!d || "hidden" in d) { out.delete(id); continue; }
    const f = floors.value.find((x) => x.id === d.floor);
    out.set(id, { id, floor: d.floor, x: d.x, y: d.y, z: d.z, room: f ? roomAt(f, d.x, d.y)?.id ?? null : null, auto: false, moved: true });
  }
  return [...out.values()];
});
/** The pins drawn: the TV shows only the lamps (a sofa away, sensors and speakers are clutter). */
const shownPins = computed(() => (props.kiosk ? pins.value.filter((p) => isLamp(p.id)) : pins.value));
const regById = computed(() => new Map((data.value?.unplaced ?? []).map((e) => [e.id, e])));
const nameOf = (id: string) => groups.value.get(id)?.name ?? S.haEntities[id]?.name ?? regById.value.get(id)?.name ?? id;
const tray = computed<(RegEntity & { hidden?: boolean })[]>(() => {
  const placed = new Set(pins.value.map((p) => p.id)), needle = q.value.trim().toLowerCase();
  const list = [...(data.value?.unplaced ?? []), ...(data.value?.hidden ?? []).map((id) => ({ id, name: nameOf(id), domain: id.split(".")[0], area: null, deviceClass: null, device: null, hidden: true }))];
  return list.filter((e) => !placed.has(e.id) && (!needle || e.id.includes(needle) || e.name.toLowerCase().includes(needle)));
});
// Home Assistant keeps many dead entities (old cast targets): the tray hides them unless asked.
const deadInTray = computed(() => tray.value.filter((e) => !e.hidden && (S.haEntities[e.id]?.state ?? e.state) === "unavailable").length);
const trayShown = computed(() => (showDead.value ? tray.value : tray.value.filter((e) => e.hidden || (S.haEntities[e.id]?.state ?? e.state) !== "unavailable")));
const stats = computed(() => ({ placed: pins.value.length, waiting: tray.value.filter((e) => !e.hidden).length - deadInTray.value }));

// ---------- pin faces ----------
const ICONS: Record<string, IconName> = { vacuum: "bot", water_heater: "thermometer", humidifier: "droplets", binary_sensor: "eye" };
function face(id: string): { icon: IconName; cls: string; value: string; title: string } {
  const e = entityOf(id), domain = id.split(".")[0];
  const icon = (ICONS[domain] ?? (domain === "sensor" && e?.attrs?.device_class === "humidity" ? "droplets" : domain === "sensor" && e?.attrs?.device_class === "temperature" ? "thermometer" : domain === "camera" ? "cctv" : iconFor(domain))) as IconName;
  if (!e) return { icon, cls: "na", value: "", title: id };
  const title = `${e.name}: ${e.state}`;
  if (dead(e)) return { icon, cls: "na", value: "", title };
  if (domain === "sensor") { const v = fmtValue(e); return { icon, cls: "val", value: v.text.length > 7 ? "" : `${v.text}${v.unit && v.unit.length <= 3 ? v.unit.replace(/^°C$/, "°") : ""}`, title }; }
  if (domain === "climate") return { icon, cls: e.state === "off" ? "off" : "on", value: e.attrs?.current_temperature != null ? `${e.attrs.current_temperature}°` : "", title };
  if (domain === "binary_sensor") return { icon, cls: e.state === "on" ? "alert" : "off", value: "", title };
  if (domain === "camera") return { icon, cls: "val", value: "", title };
  return { icon, cls: isOn(e) ? (domain === "light" ? "lit" : "on") : "off", value: "", title };
}

// ---------- the scene ----------
async function load() {
  try { data.value = await api<HouseView>("/house/layout"); err.value = ""; }
  catch (e) { err.value = (e as Error).message; }
  loading.value = false;
}
function rebuild() {
  if (!sc || !house.value) return;
  sc.build(house.value, paletteFrom());
  sc.setView(view.value, false);
  applyGlow();
}
watch(view, (v) => { try { if (!props.kiosk) localStorage.setItem(VIEW_KEY, v); } catch { /* private window */ } sc?.setView(v); openId.value = null; });

/** Glow per room from its lamps (night-light switches too): brightness and colour. A lamp the 3D models bake on its own
 *  (a placed night light) lights only its own map, so it glows where its pin is. */
const glow = computed(() => {
  const own = new Set(Object.values(glb.value?.floors ?? {}).flatMap((f) => (f.maps.every((m) => m.place) ? f.placed ?? [] : [])));
  return roomGlow(pins.value, entityOf, (id) => own.has(id));
});
function applyGlow() { if (sc) for (const id of sc.rooms.keys()) sc.setGlow(id, glow.value[id]); }
watchEffect(() => { void glow.value; applyGlow(); });

// HTML pins and labels follow the camera: positions are written straight to the elements every frame.
const pinEls = new Map<string, HTMLElement>(), labelEls = new Map<string, HTMLElement>(), floorEls = new Map<string, HTMLElement>();
const setPinEl = (id: string) => (el: unknown) => { if (el) pinEls.set(id, el as HTMLElement); else pinEls.delete(id); };
const ppinEls = new Map<string, HTMLElement>(); // the photo view's pins (the 3D pins stay mounted underneath)
const setPPinEl = (id: string) => (el: unknown) => { if (el) ppinEls.set(id, el as HTMLElement); else ppinEls.delete(id); };
const setLabelEl = (id: string) => (el: unknown) => { if (el) labelEls.set(id, el as HTMLElement); else labelEls.delete(id); };
const setFloorEl = (id: string) => (el: unknown) => { if (el) floorEls.set(id, el as HTMLElement); else floorEls.delete(id); };
const place = (el: HTMLElement, p: { x: number; y: number; depth: number } | null, show: boolean) => {
  if (!p || !show) { el.style.visibility = "hidden"; return; }
  el.style.visibility = ""; el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`; el.style.zIndex = String(Math.round(2000 - p.depth * 20));
};
const dragPos = ref<{ id: string; x: number; y: number; z?: number; floor: string; room: string | null } | null>(null);
function frame() {
  if (!sc || !house.value || photo.value) return;
  for (const p of shownPins.value) {
    const el = pinEls.get(p.id); if (!el) continue;
    const at = dragPos.value?.id === p.id ? dragPos.value : p;
    place(el, sc.project(sc.at(at.floor, at.x, at.y, at.z ?? PIN_Z)), sc.visible(at.floor));
  }
  for (const [id, r] of sc.rooms) { const el = labelEls.get(id); if (el) place(el, sc.project(sc.local(r.floor, r.label)), sc.visible(r.floor)); }
  for (const f of sc.floors) { const el = floorEls.get(f.id); if (el) place(el, sc.project(sc.local(f.id, f.label)), view.value === "all"); }
}

// ---------- tapping, dragging ----------
let press: { id: string | null; x: number; y: number; from: "pin" | "tray"; moved: boolean } | null = null;
const ghost = ref<{ id: string; x: number; y: number } | null>(null);
function pinDown(ev: PointerEvent, id: string) {
  ev.stopPropagation();
  press = { id, x: ev.clientX, y: ev.clientY, from: "pin", moved: false };
}
function trayDown(ev: PointerEvent, id: string) {
  if (ev.pointerType === "mouse" && ev.button !== 0) return;
  press = { id, x: ev.clientX, y: ev.clientY, from: "tray", moved: false };
}
function onMove(ev: PointerEvent) {
  if (!press || !press.id) return;
  if (!press.moved && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) < 6) return;
  if (press.from === "pin" && !edit.value) return;
  if (press.from === "tray" && ev.pointerType !== "mouse" && !press.moved && Math.abs(ev.clientY - press.y) > Math.abs(ev.clientX - press.x)) { press = null; return; } // a vertical swipe scrolls the tray
  press.moved = true;
  if (sc) sc.controls.enabled = false;
  if (press.from === "tray") ghost.value = { id: press.id, x: ev.clientX, y: ev.clientY };
  else { const hit = sc?.pick(ev.clientX, ev.clientY); if (hit) dragPos.value = { id: press.id, ...hit, z: pins.value.find((p) => p.id === press!.id)?.z }; }
}
function onCancel() { sc?.setPress(null); press = null; ghost.value = null; dragPos.value = null; if (sc) sc.controls.enabled = true; }
function onUp(ev: PointerEvent) {
  const p = press; press = null;
  sc?.setPress(null);
  if (sc) sc.controls.enabled = true;
  ghost.value = null;
  if (!p?.id) return;
  if (!p.moved) {
    if (p.from === "pin") { openId.value = openId.value === p.id ? null : p.id; armed.value = null; }
    else armed.value = armed.value === p.id ? null : p.id;
    return;
  }
  const hit = sc?.pick(ev.clientX, ev.clientY);
  dragPos.value = null;
  if (hit) drop(p.id, hit); else if (p.from === "tray") toast("Drop it on a room");
}
function drop(id: string, hit: { floor: string; room: string; x: number; y: number }) {
  const z = pins.value.find((p) => p.id === id)?.z; // dragging on the floor keeps the height
  draft[id] = { floor: hit.floor, x: hit.x, y: hit.y, ...(z != null ? { z } : {}) };
  armed.value = null;
}
// ---------- moving along X, Y, Z: the gizmo's arrows and the popup's fields ----------
const storeyH = computed(() => house.value?.storeyHeight ?? 2.8);
/** The limits of the open pin: its storey's walls and 0 … storey height. */
const bounds = computed(() => {
  const f = open.value && floors.value.find((x) => x.id === open.value!.floor);
  if (!f || !house.value) return null;
  const S = shellOf(house.value, f);
  return { x: [S.x, S.x + S.w], y: [S.y, S.y + S.d], z: [0, storeyH.value] } as Record<"x" | "y" | "z", [number, number]>;
});
/** Move the open pin to a new x, y and/or z (clamped, to the centimetre); a pin without a height keeps none until Z moves. */
function moveOpen(patch: { x?: number; y?: number; z?: number }) {
  const p = open.value, b = bounds.value;
  if (!p || !b) return;
  const c = (k: "x" | "y" | "z", v: number) => +Math.min(Math.max(v, b[k][0]), b[k][1]).toFixed(2);
  const z = patch.z != null ? c("z", patch.z) : p.z;
  draft[p.id] = { floor: p.floor, x: c("x", patch.x ?? p.x), y: c("y", patch.y ?? p.y), ...(z != null ? { z } : {}) };
}
function field(k: "x" | "y" | "z", ev: Event) {
  const v = parseFloat((ev.target as HTMLInputElement).value.replace(",", "."));
  if (Number.isFinite(v)) moveOpen({ [k]: v }); else (ev.target as HTMLInputElement).value = fmtM(open.value ? (k === "z" ? open.value.z ?? PIN_Z : open.value[k]) : 0);
}
const fmtM = (v: number) => v.toFixed(2);
function nudge(k: "x" | "y" | "z", d: number) { const p = open.value; if (p) moveOpen({ [k]: (k === "z" ? p.z ?? PIN_Z : p[k]) + d }); }
function resetHeight() {
  const p = open.value; if (!p) return;
  draft[p.id] = { floor: p.floor, x: p.x, y: p.y };
}
// a tap on the house (not a drag of the view): place the armed tray device, or close the popup
let down: { x: number; y: number; t: number } | null = null;
const reach = (ev: PointerEvent) => (ev.pointerType === "mouse" ? 0 : 22); // a finger covers ~40 px: forgive a near miss on a small leaf
const stageDown = (ev: PointerEvent) => {
  down = { x: ev.clientX, y: ev.clientY, t: performance.now() };
  if (!photo.value && !edit.value && !armed.value && ev.target === sc?.renderer.domElement && (ev.pointerType !== "mouse" || ev.button === 0)) sc.setPress("at", ev.clientX, ev.clientY, reach(ev)); // a door under the finger lights up
};
const stageLeave = () => sc?.clearHover();
// desktop: a pointer cursor and a soft glow on a door under the mouse
function stageMove(ev: PointerEvent) {
  if (ev.pointerType !== "mouse" || !sc) return;
  if (photo.value || edit.value || armed.value || ev.buttons || ev.target !== sc.renderer.domElement) { sc.clearHover(); return; }
  sc.hoverAtPoint(ev.clientX, ev.clientY);
}
function stageUp(ev: PointerEvent) {
  const d = down; down = null;
  if (sc?.gizmoHit) { sc.gizmoHit = false; return; } // a press on the gizmo's arrows, not a tap on the house
  if (!d || Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > (ev.pointerType === "mouse" ? 6 : 12) || performance.now() - d.t > 700 || press) return; // finger jitter allowed; a long press is not a tap
  if (photo.value) { void photoTap(ev); return; }
  if (armed.value) { const hit = sc?.pick(ev.clientX, ev.clientY); if (hit) drop(armed.value, hit); else toast("Tap a room"); return; }
  if (!edit.value && ev.target === sc?.renderer.domElement && sc.toggleDoorAt(ev.clientX, ev.clientY, reach(ev))) return; // a tap on a door swings it
  openId.value = null;
}

async function save() {
  saving.value = true;
  try {
    data.value = await api<HouseView>("/house/pins", { method: "PUT", body: { pins: { ...draft } } });
    for (const k of Object.keys(draft)) delete draft[k];
    toast("House saved");
  } catch (e) { toast((e as Error).message); }
  saving.value = false;
}
function cancel() { for (const k of Object.keys(draft)) delete draft[k]; armed.value = null; }
function takeOff(id: string) { draft[id] = { hidden: true }; openId.value = null; }
function backToArea(id: string) { draft[id] = null; openId.value = null; }
async function flip() {
  if (!house.value) return;
  try { data.value = { ...data.value!, ...(await api<{ house: HouseView["house"] }>("/house", { method: "PUT", body: { ...house.value, mirror: !house.value.mirror } })) }; rebuild(); }
  catch (e) { toast((e as Error).message); }
}
watch(edit, (on) => { if (!on) { armed.value = null; if (dirty.value && !window.confirm("Leave without saving the moved pins?")) { edit.value = true; return; } cancel(); } });

// ---------- the popup ----------
const open = computed(() => (openId.value ? pins.value.find((p) => p.id === openId.value) ?? null : null));
const openEntity = computed<HaEntity | null>(() => (openId.value ? entityOf(openId.value) : null));
const card = computed(() => {
  const id = openId.value ?? "", t = typeFor(id.split(".")[0]);
  return { id: "house-" + id, type: t, design: t === "toggle" ? "row" : undefined, query: { entity: id } };
});
const CARD_H: Record<string, number> = { toggle: 76, entity: 112, climate: 176, media: 168, camera: 236, button: 76 };
const popXY = ref<{ x: number; y: number; low?: boolean } | null>(null);
watch([openId, () => pins.value.length, pfloor, photo, edit], async () => {
  await nextTick();
  const el = open.value && (photo.value ? ppinEls : pinEls).get(open.value.id), box = stage.value?.getBoundingClientRect();
  if (!el || !box) { popXY.value = null; return; }
  const r = el.getBoundingClientRect();
  // editing: a top corner away from the pin, so its gizmo stays free to grab
  if (edit.value) popXY.value = { x: r.left - box.left < box.width / 2 ? Math.max(12, box.width - 332) : 12, y: 12, low: r.top - box.top > box.height / 2 };
  else popXY.value = { x: Math.min(Math.max(12, r.left - box.left - 150), box.width - 312), y: Math.min(r.bottom - box.top + 8, box.height - 280) };
});
const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") { openId.value = null; armed.value = null; roomPop.value = null; } };

// ---------- theme ----------
let mo: MutationObserver | null = null, mq: MediaQueryList | null = null;
const retheme = () => rebuild();

onMounted(async () => {
  if (!props.kiosk) api<{ views: unknown[] }>("/house/views").then((r) => { hasRooms.value = r.views.length > 0; }, () => {});
  await Promise.all([load(), loadManifest()]);
  await nextTick();
  if (!host.value) return;
  sc = new HouseScene(host.value, { lowPower: props.kiosk, antialias: props.kiosk ? !/[?&]aa=0/.test(location.hash) : true });
  if (/[?&]e2e\b/.test(location.href)) (window as unknown as { __hs: HouseScene }).__hs = sc; // test hook: Playwright reads door positions from it
  sc.onFrame = props.kiosk ? () => { frame(); meter(); } : frame;
  sc.onGizmo = (p) => moveOpen(p);
  sc.paused = photo.value;
  sc.setBaked(glb.value, glbUrl);
  sc.setNight(night.value);
  rebuild();
  // the scene draws on demand: anything that moves a pin or a label asks for a frame
  watch([pins, dragPos, view, edit, openId, () => S.haEntities], () => sc?.invalidate(), { flush: "post" });
  // the gizmo sits on the open pin while editing (and follows it when it's dragged on the floor)
  watch([edit, open, dragPos, photo], () => {
    const p = edit.value && !photo.value && open.value ? (dragPos.value?.id === open.value.id ? dragPos.value : open.value) : null;
    sc?.setGizmo(p && { floor: p.floor, x: p.x, y: p.y, z: p.z ?? PIN_Z });
  }, { flush: "post" });
  if (stage.value) { pro = new ResizeObserver(fitPhoto); pro.observe(stage.value); }
  addEventListener("pointermove", onMove); addEventListener("pointerup", onUp); addEventListener("pointercancel", onCancel); addEventListener("keydown", onKey);
  mo = new MutationObserver(retheme); mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
  mq = matchMedia("(prefers-color-scheme: dark)"); mq.addEventListener("change", retheme);
  if (props.kiosk) kioskStart();
});
onUnmounted(() => {
  sc?.dispose(); sc = null; pro?.disconnect(); clearInterval(clock);
  removeEventListener("pointermove", onMove); removeEventListener("pointerup", onUp); removeEventListener("pointercancel", onCancel); removeEventListener("keydown", onKey);
  mo?.disconnect(); mq?.removeEventListener("change", retheme);
});
// The model can change under us (another tab saved): pick it up when the page is shown again.
const onVis = () => { if (!document.hidden && !edit.value) { void load().then(rebuild); void loadManifest(); } };
onMounted(() => document.addEventListener("visibilitychange", onVis));
onUnmounted(() => document.removeEventListener("visibilitychange", onVis));

// ---------- TV kiosk: D-pad, lamp focus, frame-rate fallback ----------
// ◀ ▶ turn the house (3D; the photo view has one angle, so there they change storey) · ▲ ▼ storey up / down (below the
// ground floor: the whole house) · OK: lamp mode, the first lamp of the shown storey gets the ring; in lamp mode ◀ ▶ move
// between lamps and OK switches the ringed one · Back leaves lamp mode, then closes the kiosk.
const lampFocus = ref<string | null>(null), kNote = ref("");
const shownFloor = computed(() => (photo.value ? pfloor.value : view.value));
const floorIdx = (id: string) => floors.value.findIndex((f) => f.id === id);
const lamps = computed(() => pins.value.filter((p) => isLamp(p.id) && (shownFloor.value === "all" || p.floor === shownFloor.value))
  .sort((a, b) => (a.floor === b.floor ? a.x - b.x : floorIdx(a.floor) - floorIdx(b.floor))));
const kFloorName = computed(() => (shownFloor.value === "all" ? "Whole house" : floorName(shownFloor.value)));
const kLamp = computed(() => (lampFocus.value ? pins.value.find((p) => p.id === lampFocus.value) ?? null : null));
let noteT: ReturnType<typeof setTimeout> | undefined, keysT: ReturnType<typeof setTimeout> | undefined;
/** The key hints show on start and after every key, then fade (they cover the bottom of the house). */
const keysOn = ref(true);
const wake = () => { keysOn.value = true; clearTimeout(keysT); keysT = setTimeout(() => { keysOn.value = false; }, 7000); };
const note = (t: string) => { kNote.value = t; clearTimeout(noteT); noteT = setTimeout(() => { kNote.value = ""; }, 2500); };
function stepFloor(d: number) {
  const ids = photo.value ? pfloors.value.map((f) => f.id) : ["all", ...floors.value.map((f) => f.id)];
  const i = ids.indexOf(shownFloor.value), n = ids[Math.max(0, Math.min(ids.length - 1, (i < 0 ? 0 : i) + d))];
  if (!n || n === shownFloor.value) return;
  if (photo.value) pfloor.value = n; else view.value = n;
}
function stepLamp(d: number) {
  const l = lamps.value, i = l.findIndex((p) => p.id === lampFocus.value);
  if (l.length) lampFocus.value = l[i < 0 ? 0 : (i + d + l.length) % l.length].id;
}
function toggleFocused() {
  const e = lampFocus.value ? entityOf(lampFocus.value) : null;
  if (!e || dead(e)) { note("That lamp is offline"); return; }
  const was = isOn(e);
  void togglePin(e).then((ok) => note(ok ? `${e.name} ${was ? "off" : "on"}` : `${e.name}: Home Assistant said no`));
}
/** Back: true when something closed here (lamp mode), false when the kiosk itself should close. */
function tvBack() { if (lampFocus.value) { lampFocus.value = null; return true; } return false; }
// Zoom: CH+ / CH− (Salon TV's shell hands them over as {sdKiosk: "zoom"}; a WebView that gets them itself sees
// ChannelUp / ChannelDown), the number keys 2 (in) and 8 (out), and + / − (and the wheel) in a browser.
const KEYS: Record<string, string> = { ArrowLeft: "l", ArrowRight: "r", ArrowUp: "u", ArrowDown: "d", Enter: "ok", " ": "ok", Escape: "back", Backspace: "back", GoBack: "back", BrowserBack: "back",
  ChannelUp: "in", ChannelDown: "out", PageUp: "in", PageDown: "out", "+": "in", "=": "in", "-": "out", _: "out", "2": "in", "8": "out" };
const tvRemote = /[?&]tv=1/.test(location.hash);
/** Inline (#…&inline=1, or {sdKiosk: "inline"}): Salon TV shows the house as a card on its Home screen and draws its own
 * key hints there, so ours stay hidden; going full screen it sends inline: false and they come back. */
const inline = ref(/[?&]inline=1/.test(location.hash)), inlineHost = /[?&]inline=/.test(location.hash);
/** The photo view's zoom (CSS scale on the picture, towards the ringed lamp or the middle). */
const pzoom = ref(1), pzoomAt = ref<{ x: number; y: number } | null>(null);
watch([pfloor, mode], () => { pzoom.value = 1; });
function zoomBy(dir: 1 | -1) {
  if (photo.value) {
    const z = Math.min(2.5, Math.max(1, +(pzoom.value * (dir > 0 ? 1.25 : 0.8)).toFixed(3)));
    if (z === pzoom.value) { note(dir > 0 ? "Zoomed in all the way" : "Zoomed out all the way"); return; }
    const pp = lampFocus.value ? photoPins.value.find((p) => p.id === lampFocus.value) : null;
    pzoomAt.value = pp ? { x: pp.left, y: pp.top } : null;
    pzoom.value = z < 1.02 ? 1 : z;
    return;
  }
  if (!sc) return;
  const p = kLamp.value, focus = p ? sc.at(p.floor, p.x, p.y, p.z ?? PIN_Z) : null;
  sc.spin(false);
  if (!sc.zoom(dir > 0 ? 0.8 : 1.25, focus)) note(dir > 0 ? "Zoomed in all the way" : "Zoomed out all the way");
}
function tvKey(ev: KeyboardEvent) {
  const k = KEYS[ev.key]; if (!k) return;
  ev.preventDefault(); wake();
  if (k === "back") { if (!tvBack()) exitKiosk(); return; }
  if (k === "in" || k === "out") { zoomBy(k === "in" ? 1 : -1); return; }
  if (k === "u" || k === "d") { stepFloor(k === "u" ? 1 : -1); return; }
  if (k === "ok") { if (lampFocus.value) toggleFocused(); else if (lamps.value.length) stepLamp(0); else note("No lamps on this storey"); return; }
  const d = k === "l" ? -1 : 1;
  if (lampFocus.value) stepLamp(d);
  else if (photo.value) stepFloor(d);
  else { sc?.spin(false); sc?.orbit(d * 30); }
}
// a storey change keeps lamp mode on that storey's lamps (or ends it when there are none)
watch(lamps, (l) => { if (lampFocus.value && !l.some((p) => p.id === lampFocus.value)) lampFocus.value = l[0]?.id ?? null; });
watch(lampFocus, () => sc?.invalidate());
// Embedded in the Salon TV launcher: it keeps the remote's Back key and posts {sdKiosk: "back"}; we answer
// "back-handled", or "exit" so it closes the frame (the voice chat kiosk's protocol).
const embedded = typeof window !== "undefined" && window.parent !== window;
const tellParent = (m: Record<string, unknown>) => { if (embedded) try { window.parent.postMessage(m, "*"); } catch { /* gone */ } };
function exitKiosk() { if (embedded) tellParent({ sdKiosk: "exit" }); else emit("exit"); }
function onParent(ev: MessageEvent) {
  if (ev.source !== window.parent) return;
  const m = ev.data as { sdKiosk?: string; dir?: number } | null;
  if (m?.sdKiosk === "zoom") { wake(); zoomBy(m.dir === -1 ? -1 : 1); return; } // CH+ / CH− from Salon TV's shell
  // inline the launcher keeps the keyboard focus and hands the remote's keys over (the frame is cross-origin)
  if (m?.sdKiosk === "key") { const key = String((m as { key?: unknown }).key ?? ""); tvKey({ key, preventDefault() {} } as KeyboardEvent); return; }
  if (m?.sdKiosk === "inline") { inline.value = !!(m as { on?: unknown }).on; if (!inline.value) wake(); return; }
  if (m?.sdKiosk !== "back") return;
  tellParent({ sdKiosk: tvBack() ? "back-handled" : "exit" });
}
// Resolution: the canvas is laid out at 960×540 CSS px (HouseKiosk zooms the page), but drawn at the screen's real
// pixels: device pixels per canvas CSS px, at least 1920 wide on a TV (#…&tv=1: a 1080p panel, whatever the WebView
// reports inside Salon's zoomed frame) and never more than 1920×1080. #…&px=<ratio> pins it (testing).
const PX = (() => { const m = /[?&]px=([\d.]+)/.exec(location.hash); return m ? Math.min(4, Math.max(0.25, +m[1])) : null; })();
function fullRatio(): number {
  const el = host.value, w = el?.clientWidth || 960, h = el?.clientHeight || 540;
  const zoom = parseFloat(document.documentElement.style.zoom) || 1, dev = (devicePixelRatio || 1) * zoom;
  return +Math.min(tvRemote ? Math.max(dev, 1920 / w) : dev, 1920 / w, 1080 / h).toFixed(3);
}
/** Resolution steps: full, ¾, ½ (2× → 1.5× → 1× on the TV); the frame-rate check walks down them before the photo view. */
let ladder: number[] = [], rung = 0;
function setRes(i: number) {
  rung = i; sc?.setResolution(ladder[i]);
  const b = sc?.bufferSize();
  if (b) tellParent({ sdKiosk: "px", ratio: ladder[i], w: b.w, h: b.h, dpr: devicePixelRatio, zoom: document.documentElement.style.zoom || "1" });
}
// Frame rate: a weak TV GPU first gets fewer pixels, then the photo view. Frames drawn back to back (the intro turn, a
// glide) are timed; under MIN_FPS over 3 s: one resolution step down (and another 3 s of turning to measure it); below
// the last step, the photo view when there are renders, else half a pixel per CSS px. #…&minfps=<n> overrides (0 = never).
const MIN_FPS = (() => { const m = /[?&]minfps=(\d+)/.exec(location.hash); return m ? +m[1] : 20; })();
let ft: number[] = [], slowDone = false;
function meter() {
  if (slowDone || photo.value || !MIN_FPS) return;
  const t = performance.now();
  if (ft.length && t - ft[ft.length - 1] > 250) ft = []; // an idle gap: a new run
  ft.push(t);
  while (ft.length > 2 && t - ft[1] >= 3000) ft.shift();
  const span = t - ft[0], fps = ((ft.length - 1) * 1000) / span;
  if (span < 3000 || fps >= MIN_FPS) return;
  ft = [];
  if (rung + 1 < ladder.length) {
    setRes(rung + 1);
    tellParent({ sdKiosk: "perf", fps: +fps.toFixed(1), fallback: "resolution", ratio: ladder[rung] });
    if (sc) { sc.spin(true); clearTimeout(spinT); spinT = setTimeout(() => sc?.spin(false), 3500); } // keep turning to measure the new step
    return;
  }
  slowDone = true; sc?.spin(false);
  if (manifest.value) { mode.value = "photo"; note(`Photo view: the 3D ran at ${fps.toFixed(0)} fps here`); }
  else if (sc) { sc.renderer.setPixelRatio(0.5); sc.invalidate(); note(`Lighter 3D: ${fps.toFixed(0)} fps here`); }
  tellParent({ sdKiosk: "perf", fps: +fps.toFixed(1), fallback: manifest.value ? "photo" : "pixels" });
}
let spinT: ReturnType<typeof setTimeout> | undefined;
function kioskStart() {
  const full = PX ?? fullRatio();
  ladder = PX ? [PX] : [...new Set([full, full * 0.75, full * 0.5].map((r) => +Math.max(0.5, r).toFixed(3)))];
  addEventListener("keydown", tvKey); wake();
  if (embedded) addEventListener("message", onParent);
  setRes(0);
  tellParent({ sdKiosk: "ready" });
  // a slow turn to open with; it is also the frame-rate test
  setTimeout(() => { if (sc && !photo.value) { sc.spin(true); spinT = setTimeout(() => sc?.spin(false), 6000); } }, 800);
}
onUnmounted(() => { removeEventListener("keydown", tvKey); removeEventListener("message", onParent); clearTimeout(spinT); clearTimeout(noteT); clearTimeout(keysT); });

const bridge = computed(() => (!S.haBridge?.configured ? "Home Assistant isn't set up" : !S.haBridge.online || !data.value?.online ? "Home Assistant isn't reachable: showing the house without live devices" : ""));
const roomList = computed(() => floors.value.flatMap((f) => f.rooms.map((r) => ({ ...r, floor: f.id, big: biggest(r) }))));
const devicesHref = "/api/v1/house/devices";
</script>

<template>
  <main class="page house" :class="{ kiosk }">
    <header v-if="!kiosk" class="ph">
      <h1>House</h1>
      <div class="hs-tools">
        <div v-if="rooms" class="chips" role="group" aria-label="Floor" hidden></div>
        <div v-else-if="photo" class="chips" role="group" aria-label="Floor">
          <button v-for="f in pfloors" :key="f.id" type="button" class="chip" :aria-pressed="pfloor === f.id" @click="pfloor = f.id">{{ f.name.replace(/ floor$/i, "") }}</button>
        </div>
        <div v-else class="chips" role="group" aria-label="Floor">
          <button type="button" class="chip" :aria-pressed="view === 'all'" @click="view = 'all'"><Icon name="layers" :size="14" /> All</button>
          <button v-for="f in floors" :key="f.id" type="button" class="chip" :aria-pressed="view === f.id" @click="view = f.id">{{ f.name.replace(/ floor$/i, "") }}</button>
        </div>
        <button v-if="photo || rooms || (glb && !edit)" type="button" class="btn icon-btn" :title="`Sky: ${sky} (tap for ${skyNext})`" :aria-label="`Sky: ${sky}`" @click="sky = skyNext"><Icon :name="night ? 'moon' : 'sun'" :size="15" /><span class="hs-sky">{{ sky === "auto" ? "Auto" : sky === "day" ? "Day" : "Night" }}</span></button>
        <div v-if="(manifest || hasRooms) && !edit" class="chips" role="group" aria-label="View">
          <button v-if="manifest" type="button" class="chip" :aria-pressed="mode === 'photo'" @click="mode = 'photo'"><Icon name="image" :size="14" /> Photo</button>
          <button v-if="manifest" type="button" class="chip" :aria-pressed="mode === '3d'" @click="mode = '3d'"><Icon name="house" :size="14" /> 3D</button>
          <button v-if="hasRooms" type="button" class="chip" :aria-pressed="mode === 'rooms'" @click="mode = 'rooms'"><Icon name="camera" :size="14" /> Rooms</button>
        </div>
        <button type="button" class="btn" :class="{ primary: edit }" :aria-pressed="edit" @click="edit = !edit"><Icon name="move" :size="15" /> {{ edit ? "Done" : "Edit" }}</button>
      </div>
    </header>
    <p v-if="bridge && !kiosk" class="hint hs-note">{{ bridge }}</p>
    <p v-if="err" class="err">{{ err }}</p>

    <HouseRooms v-if="rooms" :night="night" />
    <div v-show="!rooms" class="hs-body" :class="{ editing: edit }">
      <div ref="stage" class="hs-stage" :class="{ photo }" :style="photo && manifest ? { '--ar': `${manifest.width} / ${manifest.height}` } : undefined" @pointerdown="stageDown" @pointerup="stageUp" @pointermove="stageMove" @pointerleave="stageLeave">
        <div v-show="!photo" ref="host" class="hs-canvas" :class="{ aiming: armed || ghost }"></div>
        <Transition name="hs-fade">
        <div v-if="photo && manifest && rf" ref="photoEl" class="hs-photo" :class="{ night }" :style="{ width: photoBox.w + 'px', height: photoBox.h + 'px', ...(pzoom !== 1 ? { scale: String(pzoom), transformOrigin: pzoomAt ? `${pzoomAt.x}px ${pzoomAt.y}px` : 'center' } : {}) }">
          <img class="hs-img" :src="renderUrl(manifest, rf.images.day)" alt="" draggable="false" />
          <img class="hs-img hs-night" :class="{ on: night }" :src="renderUrl(manifest, rf.images.night)" alt="" draggable="false" />
          <img v-for="file in overlayFiles" :key="file" class="hs-img hs-light" :src="renderUrl(manifest, file)" alt="" draggable="false"
            :style="{ opacity: (overlays.get(file)?.o ?? 0) * (night ? 1 : 0.55), filter: tintOf(file) }" />
          <svg class="hs-tints" width="0" height="0" aria-hidden="true"><filter v-for="t in tintFilters" :id="t.id" :key="t.id" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" :values="t.values" /></filter></svg>
          <span v-for="l in photoLabels" :key="'pl-' + l.id" class="hs-room hs-plabel" :class="{ lit: litRooms.has(l.id) }" :style="{ transform: `translate(${l.left}px, ${l.top}px)` }">{{ l.name }}</span>
          <button v-for="p in photoPins" :key="'pp-' + p.id" :ref="setPPinEl(p.id)" type="button" class="hp hs-ppin" :class="[face(p.id).cls, { sel: openId === p.id, kfocus: lampFocus === p.id }]"
            :style="{ transform: `translate(${p.left}px, ${p.top}px)` }" :title="face(p.id).title" :aria-label="`${nameOf(p.id)}${p.room ? ', ' + roomName(p.floor, p.room) : ''}`" @pointerdown="pinDown($event, p.id)">
            <span class="hp-dot"><Icon :name="face(p.id).icon" :size="14" /></span><span v-if="face(p.id).value" class="hp-v num">{{ face(p.id).value }}</span>
          </button>
        </div>
        </Transition>
        <div v-if="roomPop" class="hpop hs-roompop" :style="{ left: roomPop.x + 'px', top: roomPop.y + 'px' }" role="dialog" :aria-label="roomName(pfloor, roomPop.room)" @pointerdown.stop @pointerup.stop>
          <div class="hpop-h">
            <span><b>{{ roomName(pfloor, roomPop.room) }}</b><small>{{ floorName(pfloor) }} · {{ roomPins.length }} {{ roomPins.length === 1 ? "device" : "devices" }}</small></span>
            <button type="button" class="btn" aria-label="Close" @click="roomPop = null"><Icon name="x" :size="15" /></button>
          </div>
          <button v-for="p in roomPins" :key="'rp-' + p.id" type="button" class="hs-item" @click="openPin(p.id)">
            <span class="hp-dot sm" :class="face(p.id).cls"><Icon :name="face(p.id).icon" :size="13" /></span>
            <span class="hs-n"><b>{{ nameOf(p.id) }}</b><small>{{ entityOf(p.id)?.state ?? "unknown" }}</small></span>
          </button>
          <p v-if="!roomPins.length" class="hint">No devices in this room yet. Place them with Edit.</p>
        </div>
        <div v-show="!photo" class="hs-ov" :class="{ compact: view === 'all' }">
          <span v-for="f in floors" :key="'f-' + f.id" :ref="setFloorEl(f.id)" class="hs-floor">{{ f.name }}</span>
          <span v-for="r in roomList" :key="'r-' + r.id" :ref="setLabelEl(r.id)" class="hs-room" :class="{ lit: glow[r.id] }">{{ r.name }}</span>
          <button v-for="p in shownPins" :key="p.id" :ref="setPinEl(p.id)" type="button" class="hp" :class="[face(p.id).cls, { sel: openId === p.id, moved: p.moved, edit, kfocus: lampFocus === p.id }]"
            :title="face(p.id).title" :aria-label="`${nameOf(p.id)}${p.room ? ', ' + roomName(p.floor, p.room) : ''}`" @pointerdown="pinDown($event, p.id)">
            <span class="hp-dot"><Icon :name="face(p.id).icon" :size="14" /></span><span v-if="face(p.id).value" class="hp-v num">{{ face(p.id).value }}</span>
          </button>
        </div>
        <div v-if="loading" class="hs-empty">Loading the house…</div>
        <p v-if="armed" class="hs-armed"><span>Tap a room to place <b>{{ nameOf(armed) }}</b></span><button type="button" class="btn" @click.stop="armed = null">Cancel</button></p>
        <div v-if="mode === 'photo' && !manifest && !loading && !edit" class="hs-stat hs-norender">No photo renders yet: run <code>bun run house:render</code></div>
        <div v-else-if="!kiosk" class="hs-stat num">{{ stats.placed }} placed · {{ stats.waiting }} waiting<template v-if="S.haBridge?.mode && S.haBridge.mode !== 'off'"> · {{ S.haBridge.mode === "ws" ? "live" : "polling" }}</template></div>

        <template v-if="kiosk">
          <div class="hk-hud">
            <b>{{ kFloorName }}</b>
            <span v-if="kLamp" class="hk-lamp" :class="{ on: entityOf(kLamp.id) && isOn(entityOf(kLamp.id)!) }"><Icon name="lightbulb" :size="18" /> {{ nameOf(kLamp.id) }} · {{ entityOf(kLamp.id)?.state ?? "unknown" }}</span>
            <span v-else-if="bridge" class="hk-sub">Lamps offline: Home Assistant isn't reachable</span>
          </div>
          <div class="hk-keys" :class="{ off: !keysOn || inline }">
            <template v-if="kLamp"><span><kbd>◀ ▶</kbd> lamp</span><span><kbd>OK</kbd> switch</span><span><kbd>{{ tvRemote ? "CH + −" : "+ −" }}</kbd> zoom</span><span><kbd>Back</kbd> done</span></template>
            <template v-else><span v-if="!photo"><kbd>◀ ▶</kbd> turn</span><span><kbd>{{ photo ? "◀ ▶ ▲ ▼" : "▲ ▼" }}</kbd> floor</span><span><kbd>{{ tvRemote ? "CH + −" : "+ −" }}</kbd> zoom</span><span v-if="lamps.length"><kbd>OK</kbd> lamps</span><span><kbd>Back</kbd> {{ inlineHost ? "smaller" : "close" }}</span></template>
          </div>
          <Transition name="hs-fade"><div v-if="kNote" class="hk-note">{{ kNote }}</div></Transition>
        </template>
        <div v-if="open" class="hpop" :class="{ 'hpop-edit': edit, low: popXY?.low }" :style="popXY ? { left: popXY.x + 'px', top: popXY.y + 'px' } : {}" role="dialog" :aria-label="nameOf(open.id)" @pointerdown.stop @pointerup.stop>
          <div class="hpop-h">
            <span><b>{{ roomName(open.floor, open.room) || floorName(open.floor) }}</b><small>{{ floorName(open.floor) }}<template v-if="open.auto"> · placed by HA area</template></small></span>
            <button type="button" class="btn" aria-label="Close" @click="openId = null"><Icon name="x" :size="15" /></button>
          </div>
          <div v-if="!edit && openEntity && groups.has(open.id)" class="hs-group">
            <span><b>{{ openEntity.name }}</b><small class="num">{{ dead(openEntity) ? "offline" : `${openEntity.attrs?.on} of ${openEntity.attrs?.members} on` }}</small></span>
            <button type="button" class="btn" :class="{ primary: isOn(openEntity) }" :disabled="dead(openEntity)" @click="togglePin(openEntity)"><Icon name="power" :size="14" /> {{ isOn(openEntity) ? "Turn off" : "Turn on" }}</button>
          </div>
          <div v-else-if="!edit" class="dc hpop-card" :class="`ha-k-${card.type}`" :style="{ height: (CARD_H[card.type] ?? 112) + 'px' }"><HaCard :key="card.id" :card="card" :refresh="60" /></div>
          <div class="hpop-f"><code>{{ groups.get(open.id)?.entities?.join(", ") ?? open.id }}</code><span v-if="openEntity && !openEntity.attrs?.brightness && openEntity.unit" class="num">{{ openEntity.unit }}</span></div>
          <div v-if="edit && bounds" class="hpop-xyz" role="group" aria-label="Position in metres">
            <label v-for="k in (['x', 'y', 'z'] as const)" :key="k" :class="`ax-${k}`">
              <span class="ax-n"><b>{{ k.toUpperCase() }}</b><small>{{ k === "x" ? "across" : k === "y" ? "depth" : "height" }}</small></span>
              <button type="button" class="btn icon-btn" :aria-label="`${k.toUpperCase()} −5 cm`" @click="nudge(k, -0.05)"><Icon name="minus" :size="13" /></button>
              <input class="num" type="text" inputmode="decimal" :value="fmtM(k === 'z' ? open.z ?? PIN_Z : open[k])" :aria-label="`${k.toUpperCase()} in metres, ${bounds[k][0]} to ${bounds[k][1].toFixed(2)}`"
                @change="field(k, $event)" @keydown.enter="($event.target as HTMLInputElement).blur()" />
              <button type="button" class="btn icon-btn" :aria-label="`${k.toUpperCase()} +5 cm`" @click="nudge(k, 0.05)"><Icon name="plus" :size="13" /></button>
            </label>
            <p class="hint">Drag the arrows on the pin, or the pin itself across the floor. Height 0 – {{ storeyH.toFixed(1) }} m<template v-if="open.z != null"> · <button type="button" class="linkish" @click="resetHeight">reset height</button></template></p>
          </div>
          <div v-if="edit" class="hpop-a">
            <button type="button" class="btn" @click="takeOff(open.id)"><Icon name="trash" :size="14" /> Remove from house</button>
            <button v-if="!open.auto" type="button" class="btn" @click="backToArea(open.id)">Back to its HA area</button>
          </div>
        </div>
      </div>

      <aside v-if="edit" class="hs-tray" aria-label="Devices without a room">
        <div class="hs-tray-h">
          <b>Not in a room <span class="num">{{ trayShown.length }}</span></b>
          <small>Drag onto a room, or tap one and then tap the room. Drag pins to move them.</small>
          <label class="search hs-q"><Icon name="search" :size="15" /><input v-model="q" type="search" placeholder="Filter devices" aria-label="Filter devices" /></label>
        </div>
        <ul class="hs-list">
          <li v-for="e in trayShown" :key="e.id">
            <button type="button" class="hs-item" :class="{ armed: armed === e.id }" @pointerdown="trayDown($event, e.id)">
              <span class="hp-dot sm"><Icon :name="face(e.id).icon" :size="13" /></span>
              <span class="hs-n"><b>{{ e.name }}</b><small>{{ e.id }}{{ e.hidden ? " · removed" : "" }}</small></span>
            </button>
          </li>
          <li v-if="!trayShown.length" class="hint">Every device has a place.</li>
          <li v-if="deadInTray"><button type="button" class="btn hs-dead" @click="showDead = !showDead">{{ showDead ? "Hide" : "Show" }} {{ deadInTray }} unavailable</button></li>
        </ul>
        <div class="hs-tray-f">
          <button type="button" class="btn" title="The plans may be of a mirrored neighbour house" @click="flip"><Icon name="flip" :size="14" /> Flip left/right</button>
          <a class="btn" :href="devicesHref" target="_blank" rel="noopener">Device list</a>
        </div>
      </aside>
    </div>

    <div v-if="edit && dirty" class="hs-save">
      <span><b class="num">{{ dirty }}</b> unsaved {{ dirty === 1 ? "change" : "changes" }}</span>
      <button type="button" class="btn" :disabled="saving" @click="cancel">Undo</button>
      <button type="button" class="btn primary" :disabled="saving" @click="save">{{ saving ? "Saving…" : "Save" }}</button>
    </div>
    <div v-if="ghost" class="hs-ghost" :style="{ transform: `translate(${ghost.x}px, ${ghost.y}px)` }"><span class="hp-dot"><Icon :name="face(ghost.id).icon" :size="14" /></span>{{ nameOf(ghost.id) }}</div>
  </main>
</template>
