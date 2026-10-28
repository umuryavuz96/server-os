<script setup lang="ts">
// Jobs in the dashboard language: stat cards that filter, a "next up" strip, a sortable table, and a drawer
// per job (schedule, last result, command, log, Run now behind a confirm dialog).
import AnimatedNumber from "../components/AnimatedNumber.vue";
import { ref, reactive, computed, watch } from "vue";
import { S, ago, post, toast, type Job } from "../store";
import ConfirmDialog from "../components/ConfirmDialog.vue";
import JobEditor from "../components/JobEditor.vue";
import { api } from "../store";

// Built-in (server scheduler) jobs: editor drawer + run history.
interface Run { id: number; trigger: string; actor: string; started: number; ended: number | null; exitCode: number | null; ok: boolean | null; durationMs: number | null; output: string; traceId: string }
const editing = ref<string | null | "new">(null); // job id (without "sd:"), "new", or closed
const runs = ref<Run[] | null>(null);
const builtIn = (j: Job | null) => !!j && j.id.startsWith("sd:");
async function loadRuns() { const j = opened.value; if (!builtIn(j)) { runs.value = null; return; } try { runs.value = (await api<{ runs: Run[] }>(`/jobs/${j!.id.slice(3)}/runs?limit=15`)).runs; } catch { runs.value = []; } }
async function setEnabled(j: Job, on: boolean) {
  try { await api(`/jobs/${j.id.slice(3)}`, { method: "PUT", body: { enabled: on } }); toast(on ? `${j.name} resumed` : `${j.name} paused`); } catch (e) { toast((e as Error).message); }
}
const dur = (ms: number | null) => (ms == null ? "running…" : ms < 1000 ? `${ms} ms` : ms < 90_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60000)} min`);

type Seg = "all" | "fail" | "ok" | "untracked" | "paused";
const seg = ref<Seg>("all"), q = ref("");
const sortKey = ref<"name" | "last" | "next">("next"), desc = ref(false);
const openId = ref<string | null>(null), runAsk = ref<string | null>(null);
const logs = reactive<Record<string, string>>({});

const jobs = computed(() => S.jobs ?? []);
const isOk = (j: Job) => ["ok", "ran"].includes(j.status);
const counts = computed(() => ({ all: jobs.value.length, fail: jobs.value.filter((j) => j.status === "fail").length, ok: jobs.value.filter(isOk).length,
  untracked: jobs.value.filter((j) => ["untracked", "unknown"].includes(j.status)).length, paused: jobs.value.filter((j) => !j.enabled).length }));
const SEGS = computed(() => [["all", "All jobs", counts.value.all], ["fail", "Failing", counts.value.fail], ["ok", "OK", counts.value.ok], ["untracked", "Not tracked", counts.value.untracked], ["paused", "Paused", counts.value.paused]] as [Seg, string, number][]);
const rows = computed(() => {
  const ql = q.value.trim().toLowerCase();
  const list = jobs.value.filter((j) => (seg.value === "all" || (seg.value === "fail" ? j.status === "fail" : seg.value === "ok" ? isOk(j) : seg.value === "untracked" ? ["untracked", "unknown"].includes(j.status) : !j.enabled))
    && (!ql || (j.name + " " + j.command + " " + j.when).toLowerCase().includes(ql)));
  const key = (j: Job): number | string => sortKey.value === "name" ? j.name : sortKey.value === "last" ? j.lastRun ?? 0 : j.nextRun ?? Infinity;
  return [...list].sort((a, b) => { if (a.status === "fail" && b.status !== "fail" && sortKey.value === "next") return -1; if (b.status === "fail" && a.status !== "fail" && sortKey.value === "next") return 1;
    const x = key(a), y = key(b); const c = x < y ? -1 : x > y ? 1 : 0; return desc.value ? -c : c; });
});
function sortBy(k: typeof sortKey.value) { if (sortKey.value === k) desc.value = !desc.value; else { sortKey.value = k; desc.value = k === "last"; } }
const arrow = (k: typeof sortKey.value) => (sortKey.value === k ? (desc.value ? "↓" : "↑") : "↕");
const nextUp = computed(() => jobs.value.filter((j) => j.enabled && j.nextRun).sort((a, b) => a.nextRun! - b.nextRun!).slice(0, 6));
const ST: Record<string, [string, string]> = { running: ["p-part", "RUNNING"], ok: ["p-on", "OK"], ran: ["p-on", "RAN"], fail: ["p-bad", "FAILED"], paused: ["p-off", "PAUSED"], unknown: ["p-off", "NO RUNS YET"], untracked: ["p-off", "NOT TRACKED"] };
const st = (j: Job) => ST[j.status] ?? ST.unknown;

const opened = computed(() => jobs.value.find((j) => j.id === openId.value) ?? null);
watch(openId, () => { runs.value = null; void loadRuns(); });
watch(() => opened.value?.lastRun, () => void loadRuns());
// While the open job runs, keep its log fresh so output appears as it is written (and once more when it ends).
watch(() => [opened.value?.id, opened.value?.status, opened.value?.lastRun] as const, async ([id, status], [pid, pstatus]) => {
  const j = opened.value;
  if (!j || !j.log || (status !== "running" && !(pid === id && pstatus === "running"))) return;
  const poll = async () => { try { logs[j.id] = (await (await fetch(`/svc-api/jobs/log?id=${encodeURIComponent(j.id)}`)).json()).log || "(empty)"; } catch {} };
  await poll();
  if (status === "running") { const t = setInterval(async () => { if (opened.value?.id !== id || opened.value?.status !== "running") { clearInterval(t); await poll(); } else await poll(); }, 700); }
});
watch(openId, async (id) => {
  const j = jobs.value.find((x) => x.id === id);
  if (!j || !j.log || logs[j.id]) return;
  logs[j.id] = "Loading…";
  try { logs[j.id] = (await (await fetch(`/svc-api/jobs/log?id=${encodeURIComponent(j.id)}`)).json()).log || "(empty)"; } catch { logs[j.id] = "Couldn't load the log."; }
});
const runJob = computed(() => jobs.value.find((j) => j.id === runAsk.value) ?? null);
async function runNow(id: string) {
  runAsk.value = null;
  try { const r = await post<{ ok: boolean; detail: string }>("/svc-api/jobs/run", { id }); toast(r.ok ? r.detail : "Couldn't run: " + r.detail); if (r.ok) setTimeout(loadRuns, 600); } catch { toast("Couldn't reach the server"); }
}
const nextTxt = (t: number | null) => (!t ? "—" : t <= Date.now() / 1000 + 30 ? "due now" : ago(t));
const clock = (t: number | null) => (t ? new Date(t * 1000).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "—");
</script>

<template>
  <main class="page">
    <header class="ph">
      <h1>Jobs</h1>
      <button type="button" class="btn primary" style="margin-left: auto" @click="editing = 'new'">+ New job</button>
      <label class="search2">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
        <input v-model="q" type="search" placeholder="Search jobs…" aria-label="Search jobs" />
      </label>
    </header>

    <div class="segs segs5" role="group" aria-label="Filter by status">
      <button v-for="[k, label, n] in SEGS" :key="k" type="button" class="seg" :class="{ bad: k === 'fail' && n > 0 }" :aria-pressed="seg === k" @click="seg = k"><span>{{ label }}</span><b><AnimatedNumber :value="n" /></b></button>
    </div>

    <section class="card2 nextup" aria-label="Next up">
      <div class="ch"><h3>Next up</h3><span class="muted">upcoming runs</span></div>
      <div class="nu-row">
        <button v-for="j in nextUp" :key="j.id" type="button" class="nu" @click="openId = j.id">
          <span class="nu-t">{{ nextTxt(j.nextRun) }}</span><b>{{ j.name }}</b><small>{{ j.when }}</small>
        </button>
      </div>
    </section>

    <div class="tbl" role="table" aria-label="Jobs">
      <div class="tr th jr" role="row">
        <button type="button" role="columnheader" @click="sortBy('name')">Job {{ arrow("name") }}</button>
        <span role="columnheader">Status</span>
        <button type="button" role="columnheader" @click="sortBy('last')">Last run {{ arrow("last") }}</button>
        <button type="button" role="columnheader" @click="sortBy('next')">Next run {{ arrow("next") }}</button>
        <span role="columnheader"><span class="sr">Actions</span></span>
      </div>
      <p v-if="!S.jobs" class="hint" style="padding: 16px">Loading jobs…</p>
      <TransitionGroup tag="div" name="tl" class="tbody">
        <div v-for="j in rows" :key="j.id" class="tr jr" :class="{ dim: !j.enabled }" role="row" tabindex="0" @click="openId = j.id" @keydown.enter="openId = j.id">
          <span class="an" role="cell"><b>{{ j.name }}</b><small>{{ j.status === "fail" && j.cause ? j.cause : j.when }}</small></span>
          <span role="cell"><span class="pill" :class="st(j)[0]">{{ st(j)[1] }}</span></span>
          <span class="num" role="cell">{{ j.lastRun ? ago(j.lastRun) : "—" }}</span>
          <span class="num" role="cell">{{ j.enabled ? nextTxt(j.nextRun) : "—" }}</span>
          <span class="c-act" role="cell"><button type="button" class="dots" :aria-label="`Open ${j.name}`" @click.stop="openId = j.id">⋯</button></span>
        </div>
      </TransitionGroup>
    </div>
    <p class="foot">Built-in jobs run on the server's own scheduler and can be created, edited and paused here. Crontab jobs are listed read-only; their status comes from each job's last report to the notify bot.</p>

    <Teleport to="body">
      <Transition name="drawer">
        <div v-if="opened" class="dr-wrap">
          <div class="dr-bg" @click="openId = null"></div>
          <aside class="dr" role="dialog" aria-modal="true" :aria-label="opened.name">
            <div class="dr-h"><span class="dr-title">{{ opened.name }}</span><button type="button" class="btn" aria-label="Close" @click="openId = null">✕</button></div>
            <div class="dr-b">
              <div style="display: flex; gap: 8px; align-items: center"><span class="pill" :class="st(opened)[0]">{{ st(opened)[1] }}</span><span class="muted">{{ opened.when }}</span></div>
              <div v-if="opened.status === 'fail' && opened.cause" class="warnbox">{{ opened.cause }}</div>
              <div class="dbox lifebox">
                <div class="kv2"><span>Last run</span><b>{{ clock(opened.lastRun) }}</b></div>
                <div class="kv2"><span>Next run</span><b>{{ opened.enabled ? clock(opened.nextRun) : "paused" }}</b></div>
                <div class="kv2"><span>Schedule</span><b>{{ opened.schedule }}</b></div>
              </div>
              <div class="logsrc">Command</div>
              <pre class="log" style="max-height: 140px">{{ opened.command }}</pre>
              <p v-if="opened.about" style="margin: 0; color: var(--muted)">{{ opened.about }}</p>
              <template v-if="builtIn(opened)">
                <div style="display: flex; gap: 8px">
                  <button type="button" class="btn" @click="editing = opened.id.slice(3)">Edit</button>
                  <button type="button" class="btn" @click="setEnabled(opened, !opened.enabled)">{{ opened.enabled ? "Pause" : "Resume" }}</button>
                </div>
                <div class="logsrc">Runs</div>
                <p v-if="runs && !runs.length" class="hint">No runs yet.</p>
                <div class="runs">
                  <details v-for="r in runs ?? []" :key="r.id" class="run">
                    <summary><span class="pill" :class="r.ok == null ? 'p-part' : r.ok ? 'p-on' : 'p-bad'">{{ r.ok == null ? "RUNNING" : r.ok ? "OK" : `EXIT ${r.exitCode}` }}</span>
                      <span class="num">{{ clock(r.started / 1000) }}</span><span class="muted">{{ r.trigger }} · {{ dur(r.durationMs) }}</span></summary>
                    <pre class="log" style="max-height: 220px">{{ r.output || "(no output)" }}</pre>
                    <small class="muted num" style="display: block; margin: 0 10px 8px">trace {{ r.traceId }}</small>
                  </details>
                </div>
              </template>
              <template v-else-if="opened.log"><div class="logsrc">Log (last 60 lines)</div><pre class="log">{{ logs[opened.id] ?? "" }}</pre></template>
              <p v-else-if="!builtIn(opened)" class="hint">This job does not run through cron_wrap, so it has no log or status history.</p>
              <button v-if="opened.enabled" type="button" class="btn primary big" @click="runAsk = opened.id">▶ Run now</button>
            </div>
          </aside>
        </div>
      </Transition>
    </Teleport>

    <Teleport to="body">
      <Transition name="drawer">
        <div v-if="editing !== null" class="dr-wrap">
          <div class="dr-bg" @click="editing = null"></div>
          <aside class="dr" role="dialog" aria-modal="true" :aria-label="editing === 'new' ? 'New job' : 'Edit job'">
            <div class="dr-h"><span class="dr-title">{{ editing === "new" ? "New job" : "Edit job" }}</span><button type="button" class="btn" aria-label="Close" @click="editing = null">✕</button></div>
            <div class="dr-b"><JobEditor :job-id="editing === 'new' ? null : editing" @close="editing = null; openId = null" @saved="(id) => { editing = null; openId = 'sd:' + id; }" /></div>
          </aside>
        </div>
      </Transition>
    </Teleport>

    <ConfirmDialog :open="!!runJob" :title="`Run ${runJob?.name ?? ''} now?`" :subtitle="runJob?.when" confirm-label="Run now" @confirm="runNow(runJob!.id)" @cancel="runAsk = null">
      <ul>
        <li>{{ runJob?.id.startsWith("sd:") ? "Starts the job on the server's scheduler, right now." : "Runs the exact crontab command in the background, right now." }}</li>
        <li>It is the real job: it may send Telegram messages, write files or deploy.</li>
        <li>{{ runJob?.id.startsWith("sd:") ? "The run and its output appear under Runs." : "Output lands in the job's log; status updates within 30 s." }}</li>
      </ul>
    </ConfirmDialog>
  </main>
</template>
