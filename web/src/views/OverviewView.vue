<script setup lang="ts">
// Overview: option 3 from the Claude Design round — hero card (big number on its trend) + chip switcher + alert stack on phones,
// a bento grid of hero tiles on desktop; then summary cards with "See all".
import { ref, computed, onUnmounted } from "vue";
import { S, appList, totalMem, uptimeFor, mb, ago, api, toast } from "../store";
import HeroMetric from "../components/HeroMetric.vue";
import AlertStack from "../components/AlertStack.vue";
import AppIcon from "../components/AppIcon.vue";
import UpdateCard from "../components/UpdateCard.vue";
import { missingRequired, P } from "../permissions";

// Time left in each usage window (5 h session, 7 d week), ticking so the thin bar under the meter keeps moving.
const WINDOW: Record<string, number> = { session: 5 * 3600, week: 7 * 86400 };
const nowS = ref(Date.now() / 1000);
const tick = setInterval(() => (nowS.value = Date.now() / 1000), 1000);
onUnmounted(() => clearInterval(tick));
const timeLeft = (k: string, resetsAt: number | null | undefined) => {
  if (!resetsAt) return null;
  const left = Math.max(0, resetsAt - nowS.value);
  return { pct: Math.min(100, Math.round((1 - left / WINDOW[k]) * 100)), left };
};
const leftLabel = (s: number) => {
  const t = Math.max(0, Math.floor(s)), d = Math.floor(t / 86400), h = Math.floor((t % 86400) / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  const p2 = (n: number) => String(n).padStart(2, "0");
  return d ? `${d} d ${p2(h)}:${p2(m)}:${p2(sec)}` : `${h}:${p2(m)}:${p2(sec)}`;
};

const usageBusy = ref(false);
async function refreshUsage() {
  usageBusy.value = true;
  const before = S.claudeUsage?.fetchedAt;
  try {
    await api("/claude/usage/refresh", { method: "POST", body: {} });
    await new Promise((r) => setTimeout(r, 600)); // the new numbers arrive over the live stream
    // The server skips the read while Anthropic rate-limits it; say so instead of doing nothing.
    if (S.claudeUsage?.fetchedAt === before) toast(`Anthropic is rate-limiting usage reads. Last read ${before ? ago(before) : "never"}; it retries by itself.`);
  } catch (e) { toast((e as Error).message); }
  usageBusy.value = false;
}

// ---- hero metrics (option 3: number on its trend; bento on desktop) ----
const H = computed(() => S.sysHistory ?? { t: [], cpu: [], ram: [], swap: [], load: [], disk: [] });
const sys = computed(() => S.system);
const diskPct = computed(() => (sys.value?.internal ? 100 - (sys.value.internal.freeGB / sys.value.internal.totalGB) * 100 : null));
const firstOf = (a: (number | null)[]) => a.find((v) => v != null) ?? null;
const span = computed(() => { const t = H.value.t; if (t.length < 2) return "2 h ago"; const m = Math.round((t[t.length - 1] - t[0]) / 60); return m >= 90 ? `${Math.round(m / 60)} h ago` : `${m} min ago`; });
function delta(now: number | null, then: number | null, unit: string, digits = 1, lowerIsBetter = true): [string, boolean] {
  if (now == null || then == null) return ["", true];
  const d = now - then;
  if (Math.abs(d) < Math.pow(10, -digits) / 2) return ["steady", true];
  return [`${d > 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(digits)}${unit} since ${span.value.replace(" ago", "")}`, lowerIsBetter ? d <= 0 : d >= 0];
}
type Key = "ram" | "cpu" | "disk" | "swap" | "net";
const metrics = computed(() => {
  const h = H.value, s = sys.value, sp = S.speed;
  const ram = s?.ramUsedGB ?? null, cpu = s?.cpuTemp ?? null, disk = diskPct.value, swap = s?.swapGB ?? null, net = sp?.last?.down ?? null;
  const dRam = delta(ram, firstOf(h.ram), " GB"), dCpu = delta(cpu, firstOf(h.cpu), " °C", 0), dSwap = delta(swap, firstOf(h.swap), " GB");
  const netPts = sp?.points ?? [];
  return [
    { key: "ram" as Key, minSpan: 2, chip: "Memory", label: "Memory in use", value: ram != null ? ram.toFixed(1) : "–", unit: `of ${s?.ramTotalGB ?? 16} GB`, t: h.t, v: h.ram, fmt: (v: number) => v.toFixed(1), from: span.value,
      level: (ram ?? 0) >= 14.4 ? "r" : (ram ?? 0) >= 12 ? "a" : "g", badge: dRam[0] || `apps ${mb(totalMem.value)}`, chipV: ram != null ? ram.toFixed(1) + " GB" : "–" },
    { key: "cpu" as Key, minSpan: 20, chip: "CPU", label: "CPU temp", value: cpu != null ? cpu.toFixed(0) : "–", unit: "°C", t: h.t, v: h.cpu, fmt: (v: number) => v.toFixed(0), from: span.value,
      level: (cpu ?? 0) >= 85 ? "r" : (cpu ?? 0) >= 75 ? "a" : "g", badge: `${dCpu[0] || "steady"} · load ${s?.load1 ?? "–"}`, chipV: cpu != null ? cpu.toFixed(0) + " °C" : "–" },
    { key: "disk" as Key, minSpan: 5, chip: "Disk", label: "Disk used", value: disk != null ? disk.toFixed(1) : "–", unit: "%", t: h.t, v: h.disk, fmt: (v: number) => v.toFixed(1), from: span.value,
      level: (disk ?? 0) >= 90 ? "r" : (disk ?? 0) >= 80 ? "a" : "g", badge: `${s?.internal?.freeGB ?? "–"} GB free${(disk ?? 0) >= 90 ? " · over the 90 % limit" : ""}`, chipV: disk != null ? disk.toFixed(1) + " %" : "–" },
    { key: "swap" as Key, minSpan: 2, chip: "Swap", label: "Swap on disk", value: swap != null ? swap.toFixed(1) : "–", unit: "GB", t: h.t, v: h.swap, fmt: (v: number) => v.toFixed(1), from: span.value,
      level: (swap ?? 0) >= 8 ? "r" : (swap ?? 0) >= 4 ? "a" : "g", badge: (swap ?? 0) >= 4 ? "above 4 GB" : dSwap[0] || "steady", chipV: swap != null ? swap.toFixed(1) + " GB" : "–" },
    { key: "net" as Key, minSpan: 300, chip: "Internet", label: "Download speed", value: net != null ? String(net) : "–", unit: "Mb/s", t: netPts.map((p) => p.t), v: netPts.map((p) => p.down), fmt: (v: number) => String(Math.round(v)), from: "7 days ago",
      level: net != null && net < 300 ? "a" : "g", badge: sp?.last ? `↑ ${sp.last.up} · ${sp.last.ping} ms · ${ago(sp.last.t)}` : "", chipV: net != null ? net + " Mb/s" : "–" },
  ] as const;
});
const sel = ref<Key>("ram");
const SYS_R = ["2H", "6H", "24H", "7D", "30D"], NET_R = ["7D", "30D", "90D", "24H"]; // first = live data
const selM = computed(() => metrics.value.find((m) => m.key === sel.value) ?? metrics.value[0]);

// ---- cards ----
const topApps = computed(() => appList.value.filter((a) => a.mem > 0).sort((a, b) => b.mem - a.mem).slice(0, 6));
const jobs = computed(() => { const js = S.jobs ?? []; return [...js.filter((j) => j.status === "fail"), ...js.filter((j) => j.enabled && j.status !== "fail" && j.nextRun).sort((a, b) => a.nextRun! - b.nextRun!)].slice(0, 5); });
const liveClaude = computed(() => [...(S.claudeJobs ?? [])].sort((a, b) => Number(!!a.endedAt) - Number(!!b.endedAt) || b.startedAt - a.startedAt).slice(0, 6));
const bots = computed(() => [...(S.botSessions ?? [])].sort((a, b) => Number(b.running) - Number(a.running)).slice(0, 6));
</script>

<template>
  <main class="page">
    <header class="ph">
      <h1>Overview</h1>
      <span class="livechip"><span></span>{{ S.connected ? "Live" : "Reconnecting" }}</span>
    </header>

    <a v-if="missingRequired.length" href="#permissions" class="perm-banner" role="alert">
      <b>{{ P.platform === "linux" ? "This system is missing access for" : "macOS is blocking" }} {{ missingRequired.map((p) => p.title).join(", ") }}.</b> Some features will not work until {{ P.platform === "linux" ? "you fix it" : "you allow it" }}.<span>Fix in Permissions →</span>
    </a>

    <UpdateCard />

    <!-- phone: one hero + chip switcher + alert stack -->
    <section class="hero-mobile" aria-label="Key metric">
      <HeroMetric :key="selM.key" size="xl" :label="selM.label" :value="selM.value" :unit="selM.unit" :badge="selM.badge" :level="selM.level" :t="[...selM.t]" :v="[...selM.v]" :fmt="selM.fmt" :from="selM.from" :min-span="selM.minSpan" :metric="selM.key" :ranges="selM.key === 'net' ? NET_R : SYS_R" />
      <div class="hchips" role="tablist" aria-label="Metric">
        <button v-for="m in metrics" :key="m.key" type="button" role="tab" :aria-selected="sel === m.key" @click="sel = m.key"><span class="cdot" :class="'l-' + m.level"></span>{{ m.chip }} <b>{{ m.chipV }}</b></button>
      </div>
      <AlertStack />
    </section>

    <!-- desktop: bento -->
    <div class="ov-top">
    <section class="bento" aria-label="Key metrics">
      <HeroMetric v-for="(m, i) in metrics" :key="m.key" :class="'bx-' + m.key" :size="i === 0 ? 'xl' : 'md'" :label="m.label" :value="m.value" :unit="m.unit" :badge="m.badge" :level="m.level" :t="[...m.t]" :v="[...m.v]" :fmt="m.fmt" :from="m.from" :min-span="m.minSpan" :metric="m.key" :ranges="m.key === 'net' ? NET_R : SYS_R" />
    </section>
    <div class="card2 ov-alerts"><AlertStack start-open /></div>
    </div>

    <div class="cards">
      <section v-if="S.claudeUsage || S.claudeJobs?.length" class="card2 ai-card" aria-label="Claude usage">
        <div class="ch"><h3>Claude</h3><span class="muted">{{ S.claudeUsage?.plan ?? "" }}</span>
          <button type="button" class="btn sm ghost" :disabled="usageBusy" :title="S.claudeUsage ? `Read ${ago(S.claudeUsage.fetchedAt)}` : ''" aria-label="Refresh Claude usage" @click="refreshUsage">{{ usageBusy ? "Reading…" : S.claudeUsage ? `↻ ${ago(S.claudeUsage.fetchedAt)}` : "↻ Refresh" }}</button></div>
        <template v-if="S.claudeUsage?.session || S.claudeUsage?.week">
          <div v-for="[k, label] in ([['session', 'Session · 5 h'], ['week', 'Week']] as const)" :key="k" class="ai-meter">
            <div class="ai-row"><span>{{ label }}</span><b class="num">{{ S.claudeUsage[k]?.pct ?? "–" }}%</b></div>
            <div class="bar"><i :class="(S.claudeUsage[k]?.pct ?? 0) >= 90 ? 'b' : (S.claudeUsage[k]?.pct ?? 0) >= 70 ? 'w' : ''" :style="{ width: (S.claudeUsage[k]?.pct ?? 0) + '%', background: (S.claudeUsage[k]?.pct ?? 0) >= 70 ? undefined : 'var(--ink)' }"></i></div>
            <template v-if="timeLeft(k, S.claudeUsage[k]?.resetsAt)">
              <div class="bar thin" role="img" aria-hidden="true"><i :style="{ width: timeLeft(k, S.claudeUsage[k]?.resetsAt)!.pct + '%' }"></i></div>
              <small class="muted">resets in <b class="num">{{ leftLabel(timeLeft(k, S.claudeUsage[k]?.resetsAt)!.left) }}</b></small>
            </template>
          </div>
        </template>
        <p v-if="S.claudeUsage?.error && (S.claudeUsage.session || S.claudeUsage.week)" class="hint">updated {{ ago(S.claudeUsage.fetchedAt) }} · {{ /429|rate/i.test(S.claudeUsage.error) ? "rate limited, retrying" : "last read failed, retrying" }}</p>
        <p v-else-if="S.claudeUsage?.error" class="hint">Usage unavailable: {{ S.claudeUsage.error }}</p>
        <div class="logsrc" style="margin-top: 10px">Running now</div>
        <div v-for="j in liveClaude" :key="j.pid" class="li">
          <span class="sdot" :class="j.endedAt ? 'off' : 'ok'"></span>
          <span class="lt"><b>{{ j.label }}</b><small>{{ j.detail || j.kind }}</small></span>
          <span class="lv"><small>{{ j.model?.replace(/^claude-/, "") ?? "" }}{{ j.endedAt ? " · ended" : "" }}</small></span>
        </div>
        <p v-if="!liveClaude.length" class="hint">No Claude jobs running.</p>
      </section>

      <section v-if="appList.length" class="card2">
        <div class="ch"><h3>Top apps by RAM</h3><a href="#apps">See all</a></div>
        <a v-for="a in topApps" :key="a.name" class="li" href="#apps">
          <AppIcon :name="a.name" :icon="a.icon" />
          <span class="lt"><b>{{ a.name }}</b><small>{{ a.group }}</small></span>
          <span class="lv">{{ mb(a.mem) }}<small>{{ uptimeFor(a.name)?.pct != null ? uptimeFor(a.name)!.pct!.toFixed(1) + "% up" : "" }}</small></span>
        </a>
      </section>

      <section v-if="S.botSessions?.length" class="card2">
        <div class="ch"><h3>Bots</h3><a href="#bots">See all</a></div>
        <a v-for="b in bots" :key="b.channel" class="li" href="#bots">
          <span class="sdot" :class="b.running ? (b.telegramConnected ? 'ok' : 'warn') : 'off'"></span>
          <span class="lt"><b>{{ b.channel === "telegram" ? "main" : b.channel }}</b><small>{{ b.running ? (b.uptime ? "up " + b.uptime : "live") : "stopped" }}</small></span>
          <span class="lv"><small>{{ b.activeModel ?? b.model }}</small></span>
        </a>
      </section>

      <section class="card2">
        <div class="ch"><h3>Scheduled jobs</h3><a href="#jobs">See all</a></div>
        <a v-for="j in jobs" :key="j.id" class="li" href="#jobs">
          <span class="sdot" :class="j.status === 'fail' ? 'bad' : 'ok'"></span>
          <span class="lt"><b>{{ j.name }}</b><small>{{ j.status === "fail" ? j.cause || "failed" : j.when }}</small></span>
          <span class="lv"><small>{{ j.status === "fail" ? "failed " + ago(j.lastRun) : "next " + ago(j.nextRun) }}</small></span>
        </a>
      </section>

      <section v-if="S.ha" class="card2">
        <div class="ch"><h3>Home</h3><span class="muted">{{ S.ha?.weather ? `${S.ha.weather.temp}° ${S.ha.weather.state}` : "" }}</span></div>
        <template v-if="S.ha?.online">
          <div class="kv2"><span>People home</span><b>{{ S.ha.peopleHome }} / {{ S.ha.people }}</b></div>
          <div class="kv2"><span>Lights on</span><b>{{ S.ha.lightsOn }} / {{ S.ha.lights }}</b></div>
          <div class="kv2"><span>Switches on</span><b>{{ S.ha.switchesOn }} / {{ S.ha.switches }}</b></div>
        </template>
        <p v-else class="hint">Home Assistant is not answering.</p>
      </section>

      <section v-if="S.dns || S.speed?.last" class="card2">
        <div class="ch"><h3>Network &amp; DNS</h3><span class="muted">{{ S.speed?.last ? "tested " + ago(S.speed.last.t) : "" }}</span></div>
        <div class="kv2"><span>Download / upload</span><b>{{ S.speed?.last ? `${S.speed.last.down} / ${S.speed.last.up} Mb/s` : "–" }}</b></div>
        <div class="kv2"><span>Ping</span><b>{{ S.speed?.last ? S.speed.last.ping + " ms" : "–" }}</b></div>
        <div class="kv2"><span>DNS queries today</span><b>{{ S.dns?.adguard ? S.dns.adguard.queries.toLocaleString("en-US") : "–" }}</b></div>
        <div class="kv2"><span>Devices · cache hits</span><b>{{ S.dns?.adguard?.clients ?? "–" }} · {{ S.dns?.unboundHitRate ?? "–" }}%</b></div>
      </section>
    </div>
  </main>
</template>

<style scoped>
.perm-banner{display:flex;align-items:center;flex-wrap:wrap;gap:4px 10px;padding:10px 14px;border-radius:12px;background:var(--bad-bg);border:1px solid rgba(255,59,69,.4);color:var(--ink);text-decoration:none;font-size:13.5px}
.perm-banner b{color:var(--bad)}
.perm-banner span{margin-left:auto;font-weight:700}
</style>
