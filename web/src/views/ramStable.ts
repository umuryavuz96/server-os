// Rows keep their place while numbers jitter (Ram tab). Shared by the main list and the detail sections.
import { computed } from "vue";

/** Order kept for `ms`; a clear inversion (a row 1.5x bigger than the one above it) re-sorts at once. */
export function keepOrder<T>(st: { order: string[]; at: number }, list: T[], key: (t: T) => string, val?: (t: T) => number, ms = 60_000, force = false): T[] {
  const now = Date.now(), byKey = new Map(list.map((t) => [key(t), t]));
  const cur = st.order.map((k) => byKey.get(k)).filter((t): t is T => !!t);
  const bad = !!val && cur.some((t, i) => i > 0 && val(t) > val(cur[i - 1]) * 1.5 + 5);
  if (force || now - st.at > ms || bad) { st.order = list.map(key); st.at = now; }
  const idx = new Map(st.order.map((k, i) => [k, i]));
  // New rows (not in the kept order) go where the server put them relative to each other, after the known ones.
  return [...list].sort((a, b) => (idx.get(key(a)) ?? 1e9) - (idx.get(key(b)) ?? 1e9));
}

/** Rows keep their place while numbers jitter: the order is recomputed at most every `ms`, or at once when `dep` (sort key, search) changes. Values stay live. */
export function stable<T>(rows: () => T[], key: (t: T) => string, dep: () => unknown = () => 0, val?: (t: T) => number, ms = 60_000) {
  const st = { order: [] as string[], at: 0 }; let last: unknown = Symbol();
  return computed(() => {
    const list = rows(), d = dep(), force = d !== last; last = d;
    return keepOrder(st, list, key, val, ms, force);
  });
}
