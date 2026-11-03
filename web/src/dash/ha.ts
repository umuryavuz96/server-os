// Home Assistant cards: entity state comes from the live stream (S.haEntities); service calls go through the
// server's allowlist. A call can carry an optimistic overlay that is shown at once and dropped on error (rollback)
// or when the live state hasn't confirmed it after a few seconds.
import { reactive } from "vue";
import { S, api, toast, type HaEntity } from "../store";
import type { IconName } from "../icons";

export const HA_TYPES = ["entity", "toggle", "climate", "camera", "media", "history", "button", "group"];
export const HA_LABELS: [string, string][] = [["entity", "Value"], ["toggle", "Switch"], ["climate", "Climate"], ["camera", "Camera"], ["media", "Media"], ["history", "History"], ["button", "Button"], ["group", "Group"]];

const asked = new Set<string>(), pending = reactive<Record<string, Partial<HaEntity>>>({}), gen: Record<string, number> = {};

/** The entity as shown now: live state plus any optimistic overlay. Unknown ids are fetched once (which also subscribes the stream to them). */
export function entityOf(id: string): HaEntity | null {
  const e = S.haEntities[id];
  if (!e) {
    if (id && !asked.has(id)) { asked.add(id); api<HaEntity>(`/ha/entities/${id}`).then((x) => { S.haEntities[x.id] ??= x; }).catch(() => { asked.delete(id); }); }
    return null;
  }
  const o = pending[id];
  return o ? { ...e, ...o, attrs: { ...e.attrs, ...o.attrs } } : e;
}

/** Call a service on one entity. Returns true when Home Assistant accepted it. */
export async function callOn(id: string, service: string, data: Record<string, unknown> = {}, overlay?: Partial<HaEntity>): Promise<boolean> {
  const domain = id.split(".")[0];
  const mine = (gen[id] = (gen[id] ?? 0) + 1); // a newer call on the same entity owns the overlay
  if (overlay) pending[id] = overlay;
  try {
    await api("/ha/call", { body: { domain, service, data: { entity_id: id, ...data } } });
    if (overlay) setTimeout(() => { if (gen[id] === mine) delete pending[id]; }, 3000);
    return true;
  } catch (e) {
    if (overlay && gen[id] === mine) delete pending[id];
    toast(`${S.haEntities[id]?.name ?? id}: ${(e as Error).message}`);
    return false;
  }
}

export const dead = (e: HaEntity | null) => !e || e.state === "unavailable" || e.state === "unknown";
export const isOn = (e: HaEntity) => (e.domain === "cover" ? e.state === "open" || e.state === "opening" : e.domain === "media_player" ? !["off", "unavailable", "unknown", "standby"].includes(e.state) : e.state === "on");
/** Service that flips an entity to on/off; covers open and close. */
export const switchService = (e: HaEntity, on: boolean) => (e.domain === "cover" ? (on ? "open_cover" : "close_cover") : on ? "turn_on" : "turn_off");
export const switchable = (domain: string) => ["light", "switch", "fan", "input_boolean", "cover", "media_player"].includes(domain);
export const toggleEntity = (e: HaEntity) => { const on = !isOn(e); return callOn(e.id, switchService(e, on), {}, { state: e.domain === "cover" ? (on ? "open" : "closed") : on ? "on" : "off" }); };

const ICON: Record<string, IconName> = { light: "lightbulb", switch: "power", input_boolean: "power", fan: "fan", cover: "blinds", climate: "thermometer", media_player: "music", camera: "camera", scene: "sparkles", script: "play", sensor: "gauge", binary_sensor: "eye" };
export const iconFor = (domain: string): IconName => ICON[domain] ?? "gauge";

/** What a card type fits an entity, for group children and the editor's "pick an entity" default. */
export const typeFor = (domain: string) => (switchable(domain) && domain !== "media_player" ? "toggle" : domain === "media_player" ? "media" : domain === "climate" ? "climate" : domain === "camera" ? "camera" : domain === "scene" || domain === "script" ? "button" : "entity");

export function fmtValue(e: HaEntity): { text: string; unit: string } {
  const n = Number(e.state);
  if (e.state !== "" && Number.isFinite(n) && !/^\d{4}-\d\d-\d\d/.test(e.state)) return { text: Number.isInteger(n) || Math.abs(n) >= 100 ? String(Math.round(n * 10) / 10) : n.toFixed(1), unit: e.unit ?? "" };
  const s = e.state.replace(/_/g, " ");
  return { text: s.charAt(0).toUpperCase() + s.slice(1), unit: "" };
}
