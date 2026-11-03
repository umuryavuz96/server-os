// Money and time-left formatting shared by the Usage and Costs tabs.
export const money = (n: number | null | undefined, cur: string, digits?: number) => {
  if (n == null) return "–";
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: cur, minimumFractionDigits: digits ?? (Math.abs(n) >= 100 ? 0 : 2), maximumFractionDigits: digits ?? (Math.abs(n) >= 100 ? 0 : 2) }).format(n); }
  catch { return `${cur} ${n.toFixed(2)}`; }
};
/** "3 d 4 h" / "5 h 10 m" / "12 m" until an epoch (seconds). */
export function leftLabel(t: number | null | undefined, now = Date.now()) {
  if (!t) return "";
  const s = t - now / 1000;
  if (s <= 0) return "now";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} m` : `${Math.max(1, m)} m`;
}
export const compact = (n: number) => (n >= 1e9 ? (n / 1e9).toFixed(1) + " B" : n >= 1e6 ? (n / 1e6).toFixed(1) + " M" : n >= 1e3 ? (n / 1e3).toFixed(0) + " k" : String(Math.round(n)));
