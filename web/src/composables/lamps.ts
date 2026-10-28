// Health checks ("lamps") derived from live state. Shared by the overview banner and the "Needs attention" card.
import { computed } from "vue";
import { S, appList, uptimeFor, ago } from "../store";

export type Level = "r" | "a" | "g";
export interface Lamp { id: string; level: Level; text: string; link?: [string, string]; }

export const lamps = computed<Lamp[]>(() => {
  const L: Lamp[] = [], s = S.system, sp = S.speed?.last;
  if (s?.internal) {
    const used = Math.round(100 - (s.internal.freeGB / s.internal.totalGB) * 100);
    L.push({ id: "DISK", level: used >= 90 ? "r" : used >= 80 ? "a" : "g", text: `Internal SSD ${used}% full — ${s.internal.freeGB} GB free.`, link: used >= 80 ? ["#storage", "Open Storage"] : undefined });
  }
  if (s?.cpuTemp != null) L.push({ id: "CPU", level: s.cpuTemp >= 85 ? "r" : s.cpuTemp >= 75 ? "a" : "g", text: `CPU ${s.cpuTemp} °C, load ${s.load1 ?? "–"}.` });
  if (s?.swapGB != null) L.push({ id: "SWAP", level: s.swapGB >= 8 ? "r" : s.swapGB >= 4 ? "a" : "g", text: `Swap ${s.swapGB} GB in use${s.swapGB >= 4 ? " — the VMs reserve most of the 16 GB RAM" : ""}.` });
  if (S.jobs) {
    const f = S.jobs.filter((j) => j.status === "fail");
    L.push({ id: "JOBS", level: f.length ? "r" : "g", text: f.length ? `${f.length} failing: ` + f.map((j) => `${j.name} (${j.cause || "error"})`).join("; ") : `All ${S.jobs.filter((j) => j.enabled).length} jobs OK.`, link: f.length ? ["#jobs", "Open Jobs"] : undefined });
  }
  if (appList.value.length) {
    const down = appList.value.filter((a) => { const u = uptimeFor(a.name); return u && u.pct != null && !u.up && a.state !== "off"; });
    L.push({ id: "APPS", level: down.length ? "r" : "g", text: down.length ? "Monitor says down: " + down.map((a) => a.name).join(", ") + "." : `${appList.value.filter((a) => a.state !== "off" && a.kind !== "lock").length} apps running, none reported down.` });
  }
  if (S.ha) L.push({ id: "HOME", level: S.ha.online ? "g" : "r", text: S.ha.online ? `Home Assistant online · ${S.ha.peopleHome}/${S.ha.people} home · ${S.ha.lightsOn}/${S.ha.lights} lights on.` : "Home Assistant is not answering (192.168.1.81)." });
  if (S.dns) { const a = S.dns.adguard; L.push({ id: "DNS", level: a ? "g" : "r", text: a ? `${a.queries.toLocaleString("en-US")} queries today from ${a.clients} devices · ${S.dns.unboundHitRate}% cache hits.` : "AdGuard stats not answering." }); }
  if (sp) L.push({ id: "NET", level: sp.down < 300 || Date.now() / 1000 - sp.t > 10800 ? "a" : "g", text: `${sp.down} down / ${sp.up} up Mb/s, ${sp.ping} ms — tested ${ago(sp.t)}.` });
  if (S.bots) {
    const up = S.bots.filter((b) => b.state === "up"), main = S.bots.find((b) => b.dir === "telegram");
    L.push({ id: "BOTS", level: main && main.state !== "up" ? "r" : S.bots.some((b) => b.state === "session only") ? "a" : "g", text: `${up.length} bots up: ${up.map((b) => (b.dir === "telegram" ? "main" : b.name)).join(", ")}.`, link: ["#bots", "Open Bots"] });
  }
  if (S.alerts24) L.push({ id: "ALERTS", level: S.alerts24.newCause ? "a" : "g", text: `${S.alerts24.sent} notify messages in the last 24 h${S.alerts24.newCause ? `, ${S.alerts24.newCause} with a new cause` : ""}.`, link: ["#alerts", "Open Alerts"] });
  return L;
});
