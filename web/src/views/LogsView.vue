<script setup lang="ts">
// Logs & traces: the server's structured log (filter by level / text), errors of the last 24 h grouped, the audit
// trail (who did what), and one trace opened as a timeline of everything that shared its id.
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { api } from "../store";

interface Log { time: string; level: string; message: string; trace_id?: string; attributes?: Record<string, unknown> }
interface Audit { time: string; actor: string; action: string; target: string; result: string; trace_id?: string }
interface Run { id: number; job: string; trigger: string; started: number; ended: number | null; exitCode: number | null; ok: number | boolean | null; durationMs: number | null; output: string }
interface Trace { trace_id: string; start: string | null; end: string | null; logs: Log[]; audit: Audit[]; runs: Run[] }

const tab = ref<"logs" | "audit">("logs");
const level = ref("info"), q = ref("");
const logs = ref<Log[] | null>(null), audit = ref<Audit[] | null>(null);
const summary = ref<{ errors: number; warnings: number; groups: { message: string; level: string; count: number; last: string; trace_id?: string }[] } | null>(null);
const trace = ref<Trace | null>(null), traceId = ref<string | null>(null);

async function load() {
  try {
    const p = new URLSearchParams({ level: level.value, q: q.value, limit: "300" });
    logs.value = (await api<{ logs: Log[] }>(`/logs/server?${p}`)).logs;
    summary.value = await api("/logs/summary");
    if (tab.value === "audit") audit.value = (await api<{ audit: Audit[] }>("/audit?limit=200")).audit;
  } catch { /* keep what we have */ }
}
let t: ReturnType<typeof setTimeout>;
watch(q, () => { clearTimeout(t); t = setTimeout(load, 250); });
watch([level, tab], load);
const timer = setInterval(load, 15_000);
onUnmounted(() => clearInterval(timer));

async function openTrace(id?: string) {
  if (!id) return;
  traceId.value = id; trace.value = null;
  history.replaceState(null, "", `#logs?trace=${id}`);
  try { trace.value = await api<Trace>(`/traces/${id}`); } catch { trace.value = { trace_id: id, start: null, end: null, logs: [], audit: [], runs: [] }; }
}
function closeTrace() { traceId.value = null; history.replaceState(null, "", "#logs"); }
onMounted(() => { void load(); const id = new URLSearchParams(location.hash.split("?")[1] ?? "").get("trace"); if (id) void openTrace(id); });

/** One timeline of a trace: log lines, audit entries and job runs, oldest first, with offsets from the start. */
const timeline = computed(() => {
  const tr = trace.value; if (!tr) return [];
  const items = [
    ...tr.logs.map((l) => ({ at: Date.parse(l.time), kind: l.level, text: l.message, detail: l.attributes ? JSON.stringify(l.attributes) : "" })),
    ...tr.audit.map((a) => ({ at: Date.parse(a.time), kind: a.result === "ok" ? "audit" : "error", text: `${a.actor} · ${a.action} ${a.target}`, detail: "" })),
    ...tr.runs.flatMap((r) => [{ at: r.started, kind: r.ok ? "run" : "error", text: `job ${r.job} ran (${r.trigger}) — ${r.ok ? "OK" : `exit ${r.exitCode}`} in ${r.durationMs ?? "?"} ms`, detail: r.output }]),
  ].sort((a, b) => a.at - b.at);
  const t0 = items[0]?.at ?? 0;
  return items.map((i) => ({ ...i, off: i.at - t0 }));
});
const time = (s: string) => new Date(s).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const LV: Record<string, string> = { error: "p-bad", warn: "p-part", info: "p-on", debug: "p-off", audit: "p-lock", run: "p-on" };
</script>

<template>
  <main class="page">
    <header class="ph">
      <h1>Logs</h1>
      <label class="search2">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
        <input v-model="q" type="search" placeholder="Search messages…" aria-label="Search logs" />
      </label>
    </header>

    <div class="segs" role="group" aria-label="Last 24 hours">
      <button type="button" class="seg" :class="{ bad: (summary?.errors ?? 0) > 0 }" :aria-pressed="level === 'error'" @click="level = 'error'; tab = 'logs'"><span>Errors · 24 h</span><b>{{ summary?.errors ?? "–" }}</b></button>
      <button type="button" class="seg" :aria-pressed="level === 'warn'" @click="level = 'warn'; tab = 'logs'"><span>Warnings · 24 h</span><b>{{ summary?.warnings ?? "–" }}</b></button>
      <button type="button" class="seg" :aria-pressed="level === 'info' && tab === 'logs'" @click="level = 'info'; tab = 'logs'"><span>Activity</span><b>{{ logs?.length ?? "–" }}</b></button>
      <button type="button" class="seg" :aria-pressed="tab === 'audit'" @click="tab = 'audit'"><span>Audit</span><b>who did what</b></button>
    </div>

    <section v-if="summary?.groups.length && tab === 'logs'" class="card2">
      <div class="ch"><h3>Grouped problems</h3><span class="muted">last 24 h</span></div>
      <button v-for="g in summary.groups.slice(0, 6)" :key="g.message" type="button" class="lg-row" @click="openTrace(g.trace_id)">
        <span class="pill" :class="LV[g.level]">{{ g.count }}×</span><span class="lg-msg">{{ g.message }}</span><span class="num muted">{{ time(g.last) }}</span>
      </button>
    </section>

    <div v-if="tab === 'logs'" class="tbl lg">
      <div class="lg-filter chips">
        <button v-for="l in ['debug', 'info', 'warn', 'error']" :key="l" type="button" class="chip" :aria-pressed="level === l" @click="level = l">{{ l }}+</button>
      </div>
      <p v-if="logs && !logs.length" class="hint" style="padding: 16px">Nothing at this level.</p>
      <button v-for="(l, i) in logs ?? []" :key="i" type="button" class="lg-row" :disabled="!l.trace_id" @click="openTrace(l.trace_id)">
        <span class="num muted">{{ time(l.time) }}</span><span class="pill" :class="LV[l.level]">{{ l.level.toUpperCase() }}</span>
        <span class="lg-msg">{{ l.message }}</span><span v-if="l.trace_id" class="num muted lg-tr">{{ l.trace_id.slice(0, 8) }}</span>
      </button>
    </div>

    <div v-else class="tbl lg">
      <button v-for="(a, i) in audit ?? []" :key="i" type="button" class="lg-row" :disabled="!a.trace_id" @click="openTrace(a.trace_id)">
        <span class="num muted">{{ time(a.time) }}</span><span class="pill" :class="a.result === 'ok' ? 'p-on' : 'p-bad'">{{ a.result.toUpperCase() }}</span>
        <span class="lg-msg"><b>{{ a.actor }}</b> · {{ a.action }} <span class="muted">{{ a.target }}</span></span>
      </button>
    </div>
    <p class="foot">Structured JSON logs with OpenTelemetry field names: <code>logs/server.jsonl</code> (rotated) and <code>logs/audit.jsonl</code> (kept). Every request carries a W3C trace id; open one to see everything that happened under it.</p>

    <Teleport to="body">
      <Transition name="drawer">
        <div v-if="traceId" class="dr-wrap">
          <div class="dr-bg" @click="closeTrace"></div>
          <aside class="dr" role="dialog" aria-modal="true" aria-label="Trace">
            <div class="dr-h"><span class="dr-title num" style="font-size: 14px">trace {{ traceId.slice(0, 16) }}…</span><button type="button" class="btn" aria-label="Close" @click="closeTrace">✕</button></div>
            <div class="dr-b">
              <p v-if="!trace" class="hint">Loading…</p>
              <p v-else-if="!timeline.length" class="hint">Nothing recorded under this id (it may have rotated out).</p>
              <ol class="tl">
                <li v-for="(e, i) in timeline" :key="i" :class="e.kind">
                  <span class="num muted">+{{ e.off }} ms</span>
                  <div><b>{{ e.text }}</b><pre v-if="e.detail" class="log" style="max-height: 160px; margin-top: 4px">{{ e.detail }}</pre></div>
                </li>
              </ol>
            </div>
          </aside>
        </div>
      </Transition>
    </Teleport>
  </main>
</template>
