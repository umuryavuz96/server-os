<script setup lang="ts">
// One dashboard card. The JSON says what to show (type + query) and how (design); data comes from the live
// state stream or, for history cards, from the server's range query.
import { computed, ref, watch, onUnmounted } from "vue";
import { S, appList, mb, ago, api, uptimeFor } from "../store";
import AppIcon from "../components/AppIcon.vue";
import BarChart from "../components/BarChart.vue";
import LineChart, { type Series } from "./LineChart.vue";

export interface Card { id: string; type: string; title?: string; x: number; y: number; w: number; h: number; design?: string; query?: Record<string, any>; text?: string }
const props = defineProps<{ card: Card; refresh: number }>();
const q = computed(() => props.card.query ?? {});

// ---- metrics: current value from the stream, history from the range query ----
const METRIC: Record<string, { label: string; unit: string; cur: () => number | null; fmt: (v: number) => string; minSpan: number }> = {
  ram: { label: "Memory", unit: "GB", cur: () => S.system?.ramUsedGB ?? null, fmt: (v) => v.toFixed(1), minSpan: 1 },
  cpu: { label: "CPU temp", unit: "°C", cur: () => S.system?.cpuTemp ?? null, fmt: (v) => v.toFixed(0), minSpan: 10 },
  swap: { label: "Swap", unit: "GB", cur: () => S.system?.swapGB ?? null, fmt: (v) => v.toFixed(1), minSpan: 1 },
  load: { label: "Load", unit: "", cur: () => S.system?.load1 ?? null, fmt: (v) => v.toFixed(2), minSpan: 1 },
  disk: { label: "Disk used", unit: "%", cur: () => (S.system?.internal ? 100 - (S.system.internal.freeGB / S.system.internal.totalGB) * 100 : null), fmt: (v) => v.toFixed(1), minSpan: 2 },
  net: { label: "Download", unit: "Mb/s", cur: () => S.speed?.last?.down ?? null, fmt: (v) => String(Math.round(v)), minSpan: 100 },
};
const m = computed(() => METRIC[q.value.metric as string] ?? null);
const unit = computed(() => q.value.unit ?? m.value?.unit ?? "");
const fmt = (v: number) => (m.value ? m.value.fmt(v) : Math.abs(v) >= 100 ? String(Math.round(v)) : v.toFixed(1));

const series = ref<Series | null>(null);
let timer: ReturnType<typeof setInterval> | undefined;
async function loadSeries() {
  if (!["metric", "bar"].includes(props.card.type) || !q.value.metric) return;
  const points = q.value.points ?? (props.card.type === "bar" ? 24 : 120);
  try { series.value = await api<Series>(`/history?metric=${q.value.metric}&range=${q.value.range ?? "24h"}&points=${points}`); } catch { /* keep the last one */ }
}
watch(() => JSON.stringify(q.value) + props.card.type, () => { series.value = null; void loadSeries(); }, { immediate: true });
timer = setInterval(loadSeries, Math.max(10, props.refresh) * 1000);
onUnmounted(() => clearInterval(timer));

const pathValue = (path: string): number | null => {
  let v: any = S;
  for (const k of path.split(".")) v = v?.[k];
  return typeof v === "number" ? v : null;
};
const current = computed(() => (q.value.value ? pathValue(q.value.value) : m.value?.cur() ?? null));
const level = computed(() => {
  const v = current.value; if (v == null) return "";
  return q.value.bad != null && v >= q.value.bad ? "bad" : q.value.warn != null && v >= q.value.warn ? "warn" : "";
});
const color = computed(() => (level.value === "bad" ? "var(--bad)" : level.value === "warn" ? "var(--warn)" : "var(--ink)"));
const lineRef = ref<InstanceType<typeof LineChart> | null>(null);
const shown = computed(() => lineRef.value?.hv?.v ?? current.value);
const gaugePct = computed(() => (current.value == null ? 0 : Math.max(0, Math.min(1, current.value / (q.value.max ?? 100)))));
const bars = computed(() => (series.value ? series.value.t.map((t, i) => ({ t, v: series.value!.avg[i] })) : []));
const barMax = computed(() => { const vs = bars.value.map((b) => b.v ?? 0); const hi = Math.max(1, ...vs); const p = Math.pow(10, Math.floor(Math.log10(hi))); return Math.ceil(hi / p) * p; });
const xfmt = computed(() => ((q.value.range ?? "24h").endsWith("d") ? (t: number) => new Date(t * 1000).toLocaleDateString("en-GB", { weekday: "short", day: "numeric" }) : undefined));

// ---- lists ----
const limit = computed(() => q.value.limit ?? 6);
const apps = computed(() => {
  const f = q.value.filter ?? "all";
  let list = appList.value.filter((a) => (f === "all" ? true : f === "on" ? a.state !== "off" : f === "off" ? a.state === "off" : a.group === f));
  const sort = q.value.sort ?? "mem";
  list = [...list].sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : sort === "uptime" ? (uptimeFor(b.name)?.pct ?? -1) - (uptimeFor(a.name)?.pct ?? -1) : b.mem - a.mem));
  return list.slice(0, limit.value);
});
const jobs = computed(() => {
  const js = S.jobs ?? [], f = q.value.filter ?? "next";
  const list = f === "failing" ? js.filter((j) => j.status === "fail") : f === "next" ? [...js.filter((j) => j.status === "fail"), ...js.filter((j) => j.enabled && j.status !== "fail" && j.nextRun).sort((a, b) => a.nextRun! - b.nextRun!)] : [...js].sort((a, b) => a.name.localeCompare(b.name));
  return list.slice(0, limit.value);
});
const bots = computed(() => [...(S.botSessions ?? [])].filter((b) => (q.value.filter === "running" ? b.running : true)).sort((a, b) => Number(b.running) - Number(a.running)).slice(0, limit.value));
const usage = computed(() => (S as any).claudeUsage as { plan: string | null; session: { pct: number; resetsAt: number | null } | null; week: { pct: number; resetsAt: number | null } | null } | null);
const claudeJobs = computed(() => (((S as any).claudeJobs ?? []) as { pid: number; label: string; kind: string; model: string | null; endedAt: number | null }[]).filter((j) => !j.endedAt).slice(0, limit.value));

const logs = ref<{ time: string; level: string; message: string; trace_id?: string }[] | null>(null);
async function loadLogs() { if (props.card.type !== "logs") return; try { logs.value = (await api<{ logs: any[] }>(`/logs/server?level=${q.value.filter ?? "warn"}&limit=${limit.value}`)).logs; } catch { logs.value = []; } }
watch(() => props.card.type + JSON.stringify(q.value), loadLogs, { immediate: true });
const logTimer = setInterval(loadLogs, 30_000);
onUnmounted(() => clearInterval(logTimer));

// ---- text: a small, safe Markdown subset (escape first, then format) ----
const md = computed(() => {
  const esc = (props.card.text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return esc.split(/\n{2,}/).map((block) => {
    if (/^#{1,3} /.test(block)) { const n = block.match(/^#+/)![0].length; return `<h${n + 2}>${block.slice(n + 1)}</h${n + 2}>`; }
    if (/^[-*] /m.test(block)) return `<ul>${block.split("\n").filter((l) => /^[-*] /.test(l)).map((l) => `<li>${l.slice(2)}</li>`).join("")}</ul>`;
    return `<p>${block.replace(/\n/g, "<br>")}</p>`;
  }).join("")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
});
const title = computed(() => props.card.title ?? m.value?.label ?? props.card.type);
</script>

<template>
  <div class="dc" :class="[`dc-${card.type}`, `dd-${card.design ?? 'default'}`, level]">
    <!-- metric -->
    <template v-if="card.type === 'metric'">
      <div class="dc-head"><span class="dc-t">{{ title }}</span><span class="dc-r">{{ (q.range ?? "24h").toUpperCase() }}</span></div>
      <div class="dc-num" :class="{ big: card.design === 'hero' }">{{ shown != null ? fmt(shown) : "–" }}<small>{{ unit }}</small></div>
      <LineChart ref="lineRef" class="dc-chart" :series="series" :fmt="fmt" :color="color" :band="(series?.step ?? 0) >= 300 && card.design !== 'area'" :min-span="m?.minSpan" :axis="card.design === 'hero'" />
    </template>

    <!-- stat -->
    <template v-else-if="card.type === 'stat'">
      <div class="dc-head"><span class="dc-t">{{ title }}</span></div>
      <div class="dc-num" :class="{ big: card.design === 'big' }" :style="{ color: level ? color : undefined }">{{ current != null ? fmt(current) : "–" }}<small>{{ unit }}</small></div>
    </template>

    <!-- gauge -->
    <template v-else-if="card.type === 'gauge'">
      <div class="dc-head"><span class="dc-t">{{ title }}</span></div>
      <div v-if="card.design === 'bar'" style="margin-top: auto">
        <div class="dc-num">{{ current != null ? fmt(current) : "–" }}<small>{{ unit }}</small></div>
        <div class="bar" style="height: 10px"><i :style="{ width: gaugePct * 100 + '%', background: color }"></i></div>
      </div>
      <div v-else class="dc-ring">
        <svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="42" fill="none" stroke="var(--track)" stroke-width="9" />
          <circle cx="50" cy="50" r="42" fill="none" :stroke="color" stroke-width="9" stroke-linecap="round" :stroke-dasharray="`${gaugePct * 263.9} 263.9`" transform="rotate(-90 50 50)" style="transition: stroke-dasharray .6s var(--ease)" /></svg>
        <div class="dc-ring-v">{{ current != null ? fmt(current) : "–" }}<small>{{ unit }}</small></div>
      </div>
    </template>

    <!-- bar -->
    <template v-else-if="card.type === 'bar'">
      <div class="dc-head"><span class="dc-t">{{ title }}</span><span class="dc-r">{{ (q.range ?? "24h").toUpperCase() }}</span></div>
      <BarChart v-if="series" :bars="bars" :max="barMax" :threshold="q.warn" :fmt="fmt" :label="title" :xfmt="xfmt" />
      <div v-else class="lc-load">Loading…</div>
    </template>

    <!-- apps -->
    <template v-else-if="card.type === 'apps'">
      <div class="dc-head"><span class="dc-t">{{ title }}</span><a class="dc-r" href="#apps">All</a></div>
      <div v-if="card.design === 'grid'" class="dc-grid">
        <a v-for="a in apps" :key="a.name" class="dc-gi" :href="a.href || '#apps'" target="_blank" rel="noopener"><AppIcon :name="a.name" :icon="a.icon" /><span>{{ a.name }}</span></a>
      </div>
      <div v-else class="dc-list">
        <div v-for="a in apps" :key="a.name" class="dc-li"><AppIcon :name="a.name" :icon="a.icon" /><span class="dc-ln"><b>{{ a.name }}</b><small>{{ a.group }}</small></span><span class="num">{{ a.mem > 0 ? mb(a.mem) : a.state === "off" ? "off" : "–" }}</span></div>
      </div>
    </template>

    <!-- jobs -->
    <template v-else-if="card.type === 'jobs'">
      <div class="dc-head"><span class="dc-t">{{ title }}</span><a class="dc-r" href="#jobs">All</a></div>
      <div class="dc-list">
        <div v-for="j in jobs" :key="j.id" class="dc-li"><span class="led" :class="{ on: j.status !== 'fail', bad: j.status === 'fail' }"></span>
          <span class="dc-ln"><b>{{ j.name }}</b><small>{{ j.status === "fail" ? j.cause || "failed" : j.when }}</small></span>
          <span class="num muted">{{ j.status === "fail" ? ago(j.lastRun) : j.nextRun ? ago(j.nextRun) : "—" }}</span></div>
        <p v-if="!jobs.length" class="hint">Nothing here.</p>
      </div>
    </template>

    <!-- bots -->
    <template v-else-if="card.type === 'bots'">
      <div class="dc-head"><span class="dc-t">{{ title }}</span><a class="dc-r" href="#bots">All</a></div>
      <div class="dc-list">
        <div v-for="b in bots" :key="b.channel" class="dc-li"><span class="led" :class="{ on: b.running }"></span><span class="dc-ln"><b>{{ b.channel }}</b><small>{{ b.running ? `up ${b.uptime ?? ""}` : "stopped" }}</small></span><span class="num muted">{{ b.activeModel ?? b.model }}</span></div>
      </div>
    </template>

    <!-- claude -->
    <template v-else-if="card.type === 'claude'">
      <div class="dc-head"><span class="dc-t">{{ title }}</span><span class="dc-r">{{ usage?.plan ?? "" }}</span></div>
      <template v-if="card.design !== 'jobs' && usage">
        <div v-for="[k, l] in ([['session', 'Session (5 h)'], ['week', 'Week']] as const)" :key="k" style="margin-top: 8px">
          <div style="display: flex; justify-content: space-between; font-size: 13px"><span class="muted">{{ l }}</span><b class="num">{{ usage[k]?.pct ?? "–" }}%</b></div>
          <div class="bar"><i :style="{ width: (usage[k]?.pct ?? 0) + '%', background: (usage[k]?.pct ?? 0) >= 90 ? 'var(--bad)' : (usage[k]?.pct ?? 0) >= 70 ? 'var(--warn)' : 'var(--ink)' }"></i></div>
        </div>
      </template>
      <div class="dc-list" style="margin-top: 10px">
        <div v-for="j in claudeJobs" :key="j.pid" class="dc-li"><span class="led on"></span><span class="dc-ln"><b>{{ j.label }}</b><small>{{ j.kind }}</small></span><span class="num muted">{{ j.model ?? "" }}</span></div>
        <p v-if="!claudeJobs.length" class="hint">No Claude jobs running.</p>
      </div>
    </template>

    <!-- logs -->
    <template v-else-if="card.type === 'logs'">
      <div class="dc-head"><span class="dc-t">{{ title }}</span><a class="dc-r" href="#logs">All</a></div>
      <div class="dc-logs">
        <a v-for="(l, i) in logs ?? []" :key="i" class="dc-log" :class="l.level" :href="l.trace_id ? `#logs?trace=${l.trace_id}` : '#logs'"><span class="num">{{ l.time.slice(11, 16) }}</span>{{ l.message }}</a>
        <p v-if="logs && !logs.length" class="hint">Nothing at this level.</p>
      </div>
    </template>

    <!-- text -->
    <template v-else-if="card.type === 'text'">
      <div v-if="card.title" class="dc-head"><span class="dc-t">{{ card.title }}</span></div>
      <!-- eslint-disable-next-line vue/no-v-html — escaped above, only our own tags are added -->
      <div class="dc-md" v-html="md"></div>
    </template>
  </div>
</template>
