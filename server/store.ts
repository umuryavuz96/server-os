// Central state + change broadcast. Collectors write slices; only slices whose JSON changed are pushed to clients (SSE).
export type Listener = (event: string, data: unknown) => void;

const state: Record<string, unknown> = {};
const sig: Record<string, string> = {};
const listeners = new Set<Listener>();

/** Set a top-level slice. Returns true when it changed (and was broadcast). */
export function setSlice(key: string, value: unknown): boolean {
  const s = JSON.stringify(value);
  if (sig[key] === s) return false;
  sig[key] = s;
  state[key] = value;
  for (const l of listeners) l("slice", { key, value });
  return true;
}

/** Keyed map slice (e.g. apps by name): pushes only the entries that changed. */
const mapSig: Record<string, Record<string, string>> = {};
export function setMapEntry(key: string, id: string, value: unknown): boolean {
  const s = JSON.stringify(value);
  const m = (mapSig[key] ??= {});
  if (m[id] === s) return false;
  m[id] = s;
  const map = (state[key] ??= {}) as Record<string, unknown>;
  if (value === null) { delete map[id]; delete m[id]; } // removed: gone from snapshots too (clients get one null patch)
  else map[id] = value;
  for (const l of listeners) l("entry", { key, id, value });
  return true;
}

export const getState = () => state;
export function getSlice<T>(key: string): T | undefined { return state[key] as T | undefined; }

export function subscribe(l: Listener) {
  listeners.add(l);
  return () => listeners.delete(l);
}
