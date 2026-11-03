<script setup lang="ts">
// Alerts in the dashboard language: Insights-style headline + bar chart of notify-bot messages over time,
// then one card per job with its recent messages.
import AnimatedNumber from "../components/AnimatedNumber.vue";
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { S, ago, type Alerts, type HistEntry } from "../store";
import BarChart from "../components/BarChart.vue";

interface Bb { installed: boolean; totalMb: number; age: number | null; history: { t: number; availMb: number; swapMb: number; pressure: string }[]; top: { name: string; pid: number; mb: number }[];
  last: { availMb: number; swapMb: number | null; pressure: string | null; claude: number; dockerOk: boolean } | null; reports: { name: string; ts: number; md: string }[] }
const bb = ref<Bb | null>(null);
let bbTimer: ReturnType<typeof setInterval> | undefined;
const loadBb = async () => { try { bb.value = await (await fetch("/svc-api/blackbox")).json(); } catch { /* keep the old data */ } };
onMounted(() => { loadBb(); bbTimer = setInterval(loadBb, 60_000); });
onBeforeUnmount(() => clearInterval(bbTimer));
const usedBars = computed(() => (bb.value?.history ?? []).map((h) => ({ t: h.t, v: Math.max(0, bb.value!.totalMb - h.availMb), label: `${((bb.value!.totalMb - h.availMb) / 1024).toFixed(1)} GB in use · swap ${(h.swapMb / 1024).toFixed(1)} GB` })));
const gb = (mb: number) => (mb / 1024).toFixed(1) + " GB";
const fresh = computed(() => bb.value?.age != null && bb.value.age < 180);
const mdText = (m: string) => m.replace(/^#+\s*/gm, "").replace(/<[^>]+>/g, "").replace(/\|[-| ]+\|\n?/g, "").replace(/\*\*/g, "");
const days = ref<1 | 7>(1);
const week = ref<Alerts | null>(null);
watch(days, async (d) => { if (d === 7 && !week.value) { try { week.value = await (await fetch("/svc-api/alerts?days=7")).json(); } catch {} } }, { immediate: true });
const data = computed(() => (days.value === 7 ? week.value : S.alerts24));
const all = computed<HistEntry[]>(() => (data.value?.groups ?? []).flatMap((g) => g.items));

// bars: per hour for 24 h, per day for 7 d (sent messages only; held-back duplicates are not noise you saw)
const bars = computed(() => {
  const now = Date.now() / 1000, step = days.value === 1 ? 3600 : 86400, n = days.value === 1 ? 24 : 7;
  const start = Math.floor(now / step) * step - (n - 1) * step;
  return Array.from({ length: n }, (_, i) => { const a = start + i * step; return { t: a, v: all.value.filter((e) => e.sent && e.t >= a && e.t < a + step).length }; });
});
const maxBar = computed(() => Math.max(4, ...bars.value.map((b) => b.v)));
const fails = computed(() => all.value.filter((e) => e.action.startsWith("send_failure")).length);
const ACT: Record<string, [string, string]> = {
  send_failure_first: ["p-bad", "FAILED"], send_failure_new_cause: ["p-bad", "NEW CAUSE"], send_failure_escalate: ["p-bad", "STILL FAILING"],
  dedup_silent: ["p-off", "HELD BACK"], send_recovery: ["p-on", "RECOVERED"], send_signal: ["p-on", "SIGNAL"], send_heartbeat: ["p-on", "HEARTBEAT"], legacy: ["p-off", "MESSAGE"],
};
const when = (t: number) => new Date(t * 1000).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });
const xfmt = computed(() => (days.value === 1 ? undefined : (t: number) => new Date(t * 1000).toLocaleDateString("en-GB", { weekday: "short" })));
</script>

<template>
  <main class="page">
    <header class="ph">
      <h1>Alerts</h1>
      <div class="segctl" role="tablist" aria-label="Period">
        <button type="button" role="tab" :aria-selected="days === 1" @click="days = 1">24 h</button>
        <button type="button" role="tab" :aria-selected="days === 7" @click="days = 7">7 days</button>
      </div>
    </header>

    <section class="insight card2">
      <div class="headline">
        <h2><AnimatedNumber :value="data?.sent" /> messages sent <span v-if="fails" class="down">({{ fails }} failures)</span></h2>
        <p>{{ data ? `${data.silent} duplicates held back` : "" }}{{ data?.newCause ? ` · ${data.newCause} with a new cause` : "" }} · last {{ days === 1 ? "24 hours" : "7 days" }}</p>
      </div>
      <BarChart :bars="bars" :max="maxBar" :fmt="(v: number) => `${Math.round(v)} sent`" :ticks="[0, Math.round(maxBar / 2), maxBar]" :xfmt="xfmt" :label="`Messages sent per ${days === 1 ? 'hour' : 'day'}`" />
    </section>

    <section v-if="bb?.installed" class="card2 bbx">
      <div class="ch"><h3>Black box</h3>
        <span class="pill" :class="fresh ? 'p-on' : 'p-bad'">{{ fresh ? "RECORDING" : "NOT RECORDING" }}</span></div>
      <p class="muted">Memory every minute, kept 7 days, so a crash can be explained afterwards.
        <template v-if="bb.last">Now: {{ gb(bb.totalMb - bb.last.availMb) }} in use, swap {{ gb(bb.last.swapMb ?? 0) }}, pressure {{ bb.last.pressure }}, {{ bb.last.claude }} Claude sessions, Docker {{ bb.last.dockerOk ? "answers" : "NOT answering" }}.</template></p>
      <BarChart v-if="usedBars.length" :bars="usedBars" :max="bb.totalMb" :threshold="bb.totalMb - 1024" :fmt="(v: number) => gb(v)" :ticks="[0, bb.totalMb / 2, bb.totalMb]" label="Memory in use, last 24 hours" />
      <div v-if="bb.top.length" class="bb-top"><span v-for="p in bb.top" :key="p.pid" class="pill p-off">{{ p.name }} · {{ gb(p.mb) }}</span></div>
      <details v-for="r in bb.reports" :key="r.name" class="bb-rep">
        <summary>Boot report · {{ new Date(r.ts * 1000).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) }}</summary>
        <pre>{{ mdText(r.md) }}</pre>
      </details>
      <p v-if="!bb.reports.length" class="muted">No boot report yet. One is written after every reboot.</p>
    </section>

    <p v-if="!data" class="hint">Loading…</p>
    <p v-else-if="!data.groups.length" class="hint">No alerts in this period. All quiet.</p>
    <TransitionGroup tag="div" name="tl" class="cards">
      <section v-for="g in data?.groups ?? []" :key="g.job" class="card2">
        <div class="ch"><h3>{{ g.job }}</h3><span class="muted">{{ g.sent }} sent<template v-if="g.silent"> · {{ g.silent }} held</template></span></div>
        <div v-for="(i, n) in g.items" :key="n" class="al-item">
          <div class="al-h"><span class="pill" :class="(ACT[i.action] ?? ['p-off'])[0]">{{ (ACT[i.action] ?? ["", i.action.toUpperCase()])[1] }}</span><span class="muted">{{ i.id != null ? "#" + i.id + " · " : "" }}{{ when(i.t) }} · {{ ago(i.t) }}</span></div>
          <p v-if="i.cause" class="al-b"><b>{{ i.cause }}</b></p>
          <p v-else-if="i.body" class="al-b">{{ i.body.slice(0, 240) }}{{ i.body.length > 240 ? "…" : "" }}</p>
        </div>
      </section>
    </TransitionGroup>
    <p class="foot">Every message the notify bot sent (or held back as a duplicate). #numbers match the IDs in the Telegram messages.</p>
  </main>
</template>
