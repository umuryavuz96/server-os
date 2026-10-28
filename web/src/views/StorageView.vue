<script setup lang="ts">
// Storage, inside the SPA and in the same language as Overview/Apps: hero volume cards, a "where the space goes"
// composition bar (hover a segment), one-tap cleanup cards with confirm dialogs and live progress,
// and a folder explorer table whose rows open a drill-down drawer. Data: /svc-api/storage* (scan runs on the server).
import AnimatedNumber from "../components/AnimatedNumber.vue";
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { S, post, toast, ago } from "../store";
import HeroMetric from "../components/HeroMetric.vue";
import ConfirmDialog from "../components/ConfirmDialog.vue";

interface Item { label: string; path: string | null; bytes: number; note?: string }
interface Group { id: string; label: string; note: string; items: Item[] }
interface Action { id: string; label: string; risk: "safe" | "careful"; desc: string; cmd: string; volume: string; estimate: number | null; available: boolean; note: string | null;
  run: { state: string; freed?: number; log?: string[]; started?: number; finished?: number } | null }
interface Vol { label: string; path: string; total: number; used: number; free: number; pct: number }
interface Resp { volumes: Vol[]; scan: { state: string; started: number; finished: number | null; duration: number | null; groups: Group[]; denied?: string[] }; actions: Action[] }

const data = ref<Resp | null>(null);
const err = ref("");
async function load() {
  try { data.value = await (await fetch("/svc-api/storage")).json(); err.value = ""; } catch (e) { err.value = String(e); }
}
let timer: ReturnType<typeof setTimeout> | null = null;
const busy = computed(() => data.value?.scan.state === "scanning" || (data.value?.actions ?? []).some((a) => a.run?.state === "running"));
async function tick() { await load(); timer = setTimeout(tick, busy.value ? 3000 : 30000); }
onMounted(tick);
onUnmounted(() => { if (timer) clearTimeout(timer); });

const gb = (b: number | null | undefined) => (b == null ? "–" : b >= 1e9 ? (b / 1e9).toFixed(b >= 1e11 ? 0 : 1) + " GB" : b >= 1e6 ? Math.round(b / 1e6) + " MB" : Math.round(b / 1e3) + " KB");
const internal = computed(() => data.value?.volumes.find((v) => v.label.startsWith("Internal")) ?? null);
const external = computed(() => data.value?.volumes.find((v) => !v.label.startsWith("Internal")) ?? null);
const H = computed(() => S.sysHistory ?? { t: [], cpu: [], ram: [], swap: [], load: [], disk: [] });
const lvl = (p: number) => (p >= 90 ? "r" : p >= 80 ? "a" : "g") as "r" | "a" | "g";

// ---- composition of the internal SSD ----
const groups = computed(() => data.value?.scan.groups ?? []);
const sumOf = (id: string) => (groups.value.find((g) => g.id === id)?.items ?? []).reduce((s, i) => s + i.bytes, 0);
const COLORS = ["#f2f2f3", "#9a9aa1", "#5b5b63", "#e00018", "#ffb21e", "#2fd38a"];
const parts = computed(() => {
  const v = internal.value; if (!v || !groups.value.length) return [];
  const sys = sumOf("system"), home = sumOf("home"), outside = sumOf("outside");
  const known = sys + home + outside;
  const P = [
    { label: "macOS & system volumes", bytes: sys }, { label: "Your home folders", bytes: home }, { label: "Apps, Homebrew & /Library", bytes: outside },
    { label: "Other / hidden by privacy", bytes: Math.max(0, v.used - known) }, { label: "Free", bytes: v.free },
  ];
  return P.map((p, i) => ({ ...p, pct: (p.bytes / v.total) * 100, color: i === 4 ? "transparent" : COLORS[i] }));
});
const hoverPart = ref<number | null>(null);

// ---- cleanup ----
const confirmA = ref<Action | null>(null);
async function run(a: Action) {
  confirmA.value = null;
  try { const r = await post<{ ok?: boolean; detail?: string }>("/svc-api/storage/run", { id: a.id, confirm: true }); toast(r.ok ? `${a.label} started` : r.detail ?? "could not start"); } catch (e) { toast(String(e)); }
  if (timer) clearTimeout(timer); tick();
}
async function rescan() { await post("/svc-api/storage/rescan", {}); toast("Rescan started — takes about a minute"); if (timer) clearTimeout(timer); tick(); }
const totalEst = computed(() => (data.value?.actions ?? []).filter((a) => a.available && a.risk === "safe").reduce((s, a) => s + (a.estimate ?? 0), 0));

// ---- explorer ----
const tab = ref("home");
watch(groups, (g) => { if (g.length && !g.find((x) => x.id === tab.value)) tab.value = g[0].id; });
const cur = computed(() => groups.value.find((g) => g.id === tab.value) ?? null);
const maxB = computed(() => Math.max(1, ...(cur.value?.items ?? []).map((i) => i.bytes)));

// ---- drill drawer ----
const drill = ref<{ path: string; state: string; children: Item[]; total: number | null } | null>(null);
const trail = ref<string[]>([]);
let dtimer: ReturnType<typeof setTimeout> | null = null;
async function openDrill(path: string, push = true) {
  if (push) trail.value.push(path);
  const poll = async () => {
    const r = await (await fetch(`/svc-api/storage/drill?path=${encodeURIComponent(path)}`)).json();
    if (r.error || r.detail) { drill.value = { path, state: "error: " + (r.detail ?? r.error), children: [], total: null }; return; }
    // drill API: state "scanning" | "ready"; children carry name/path/bytes/dir
    const kids = (r.children ?? []).map((c: { name?: string; label?: string; path?: string; bytes: number; dir?: boolean }) => ({ label: c.name ?? c.label ?? "?", path: c.dir === false ? null : c.path ?? null, bytes: c.bytes }));
    drill.value = { path, state: r.state === "ready" ? "done" : r.state, children: kids, total: r.total ?? null };
    if (r.state === "scanning") dtimer = setTimeout(poll, 1500);
  };
  if (dtimer) clearTimeout(dtimer);
  drill.value = { path, state: "scanning", children: [], total: null };
  poll();
}
function closeDrill() { if (dtimer) clearTimeout(dtimer); drill.value = null; trail.value = []; }
function back() { trail.value.pop(); const p = trail.value[trail.value.length - 1]; if (p) openDrill(p, false); else closeDrill(); }
const short = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");
const dmax = computed(() => Math.max(1, ...(drill.value?.children ?? []).map((c) => c.bytes)));
</script>

<template>
  <main class="page">
    <header class="ph">
      <h1>Storage</h1>
      <div style="display: flex; gap: 8px; align-items: center">
        <span class="muted">{{ data?.scan.state === "scanning" ? "Scanning…" : data?.scan.finished ? "Scanned " + ago(data.scan.finished) : "" }}</span>
        <button type="button" class="btn" :disabled="data?.scan.state === 'scanning'" @click="rescan">↻ Rescan</button>
      </div>
    </header>
    <p v-if="err" class="err">Storage service not answering: {{ err }}</p>

    <section v-if="data" class="ov-top st-top">
      <div class="bento st-bento">
        <HeroMetric v-if="internal" class="bx-ram" size="xl" label="Internal SSD used" :value="internal.pct.toFixed(1)" unit="%" :level="lvl(internal.pct)"
          :badge="`${gb(internal.free)} free of ${gb(internal.total)}`" :t="H.t" :v="H.disk" :fmt="(v: number) => v.toFixed(1) + ' %'" from="2 h ago" :min-span="5" metric="disk" :ranges="['2H', '24H', '7D', '30D']" />
        <div v-if="external" class="hero md st-ext" :class="'l-' + lvl(external.pct)">
          <div class="hero-top"><div class="hero-l"><span>External SSD used</span></div>
            <div class="hero-v"><AnimatedNumber :value="external.pct" :fmt="(v: number) => v.toFixed(1)" /><small>%</small></div>
            <div class="hero-b" :class="'b-' + lvl(external.pct)">{{ gb(external.free) }} free of {{ gb(external.total) }}</div></div>
          <div class="st-bar"><i :style="{ width: external.pct + '%' }"></i></div>
        </div>
        <div class="hero md st-ext l-g">
          <div class="hero-top"><div class="hero-l"><span>Safe to clean now</span></div>
            <div class="hero-v"><span>{{ gb(totalEst).split(" ")[0] }}</span><small>{{ gb(totalEst).split(" ")[1] }}</small></div>
            <div class="hero-b b-g">across {{ (data.actions ?? []).filter((a) => a.available && a.risk === "safe").length }} one-tap cleanups</div></div>
        </div>
      </div>

      <div class="card2 ov-alerts">
        <div class="ch"><h3>Where the space goes</h3><span class="muted">internal SSD</span></div>
        <div class="comp-big" aria-live="polite">
          <span class="cb-v"><AnimatedNumber :value="hoverPart != null ? parts[hoverPart].bytes : internal?.used" :fmt="gb" :duration="220" /></span>
          <span class="cb-l">{{ hoverPart != null ? `${parts[hoverPart].label} · ${parts[hoverPart].pct.toFixed(0)}%` : internal ? `used of ${gb(internal.total)}` : "" }}</span>
        </div>
        <div class="comp" @pointerleave="hoverPart = null">
          <span v-for="(p, i) in parts" :key="p.label" class="seg2" :class="{ dimseg: hoverPart != null && hoverPart !== i, free: i === parts.length - 1 }"
            :style="{ width: p.pct + '%', background: p.color }" @pointerenter="hoverPart = i" @pointerdown="hoverPart = i"></span>
        </div>
        <div class="comp-legend" @pointerleave="hoverPart = null">
          <div v-for="(p, i) in parts" :key="p.label" class="kv2" :class="{ hl: hoverPart === i }" @pointerenter="hoverPart = i">
            <span><i class="sw2" :style="{ background: i === parts.length - 1 ? 'transparent' : p.color }"></i>{{ p.label }}</span><b>{{ gb(p.bytes) }} · {{ p.pct.toFixed(0) }}%</b>
          </div>
        </div>
        <p v-if="data.scan.denied?.length" class="hint">{{ data.scan.denied.length }} folders are hidden by macOS privacy (Desktop, Documents, …), so “Other” is partly unmeasured. Give Full Disk Access to bun to see everything.</p>
      </div>
    </section>

    <section v-if="data" aria-label="Cleanup">
      <div class="ch" style="margin-top: 4px"><h3 style="font-size: 18px">One-tap cleanups</h3><span class="muted">every run is logged · nothing irreplaceable</span></div>
      <TransitionGroup tag="div" name="tl" class="clean-grid">
        <div v-for="a in data.actions" :key="a.id" class="card2 clean" :class="{ off: !a.available }">
          <div class="clean-h">
            <b>{{ a.label }}</b>
            <span class="pill" :class="a.risk === 'safe' ? 'p-on' : 'p-part'">{{ a.risk === "safe" ? "SAFE" : "CAREFUL" }}</span>
          </div>
          <div class="clean-v">{{ a.estimate ? "~" + gb(a.estimate) : "—" }}<small>&nbsp; {{ a.volume === "Internal" ? "internal SSD" : a.volume }}</small></div>
          <p class="clean-d">{{ a.desc }}</p>
          <div class="clean-f">
            <template v-if="a.run?.state === 'running'"><span class="spin" aria-hidden="true"></span><span class="muted">Running…</span></template>
            <template v-else-if="a.run?.state === 'done'"><span class="pill p-on">FREED {{ gb(a.run.freed) }}</span><span class="muted">{{ ago(a.run.finished) }}</span></template>
            <template v-else-if="a.run?.state === 'failed'"><span class="pill p-bad">FAILED</span></template>
            <span v-if="!a.available" class="muted clean-note">{{ a.note ?? "Nothing to clean right now." }}</span>
            <span class="sp"></span>
            <button v-if="a.available" type="button" class="btn" :class="a.risk === 'careful' ? 'danger' : 'primary'" :disabled="a.run?.state === 'running'" @click="confirmA = a">Clean</button>
          </div>
        </div>
      </TransitionGroup>
    </section>

    <section v-if="data" aria-label="Explore">
      <div class="ch" style="margin-top: 4px"><h3 style="font-size: 18px">Explore</h3><span class="muted">tap a folder to look inside</span></div>
      <div class="gtabs" role="tablist" aria-label="Area">
        <button v-for="g in groups" :key="g.id" type="button" role="tab" :aria-selected="tab === g.id" @click="tab = g.id">{{ g.label }}</button>
      </div>
      <p v-if="cur" class="hint" style="margin: 8px 2px">{{ cur.note }}</p>
      <TransitionGroup v-if="cur" tag="div" name="tl" class="tbl">
        <div v-for="it in cur.items" :key="it.label" class="tr st-row" :class="{ nodrill: !it.path }" role="row" :tabindex="it.path ? 0 : -1"
          @click="it.path && openDrill(it.path)" @keydown.enter="it.path && openDrill(it.path)">
          <span class="an"><b>{{ it.label }}</b><small v-if="it.note || (it.path && short(it.path) !== it.label)">{{ it.note ?? short(it.path!) }}</small></span>
          <span class="st-sz"><span class="ubar wide"><i :style="{ width: (it.bytes / maxB) * 100 + '%' }"></i></span><b class="num">{{ gb(it.bytes) }}</b></span>
          <span class="c-act">{{ it.path ? "›" : "" }}</span>
        </div>
      </TransitionGroup>
    </section>

    <!-- drill drawer -->
    <Teleport to="body">
      <Transition name="drawer">
        <div v-if="drill" class="dr-wrap">
          <div class="dr-bg" @click="closeDrill"></div>
          <aside class="dr" role="dialog" aria-modal="true" :aria-label="`Inside ${short(drill.path)}`">
            <div class="dr-h">
              <button type="button" class="btn" @click="back">‹ {{ trail.length > 1 ? "Up" : "Close" }}</button>
              <span class="dr-path">{{ short(drill.path) }}</span>
              <button type="button" class="btn" aria-label="Close" @click="closeDrill">✕</button>
            </div>
            <div class="dr-b">
              <p v-if="drill.state === 'scanning'" class="hint"><span class="spin"></span> Measuring folders… (big folders take a moment)</p>
              <p v-else-if="drill.state.startsWith('error')" class="hint">⚠ {{ drill.state }}</p>
              <div v-if="drill.total" class="kv2"><span>Total</span><b>{{ gb(drill.total) }}</b></div>
              <TransitionGroup tag="div" name="tl" class="tbl">
                <div v-for="c in drill.children" :key="c.label" class="tr st-row" :class="{ nodrill: !c.path }" role="row" :tabindex="c.path ? 0 : -1" @click="c.path && openDrill(c.path)" @keydown.enter="c.path && openDrill(c.path)">
                  <span class="an"><b>{{ c.label }}</b></span>
                  <span class="st-sz"><span class="ubar wide"><i :style="{ width: (c.bytes / dmax) * 100 + '%' }"></i></span><b class="num">{{ gb(c.bytes) }}</b></span>
                  <span class="c-act">{{ c.path ? "›" : "" }}</span>
                </div>
              </TransitionGroup>
            </div>
          </aside>
        </div>
      </Transition>
    </Teleport>

    <ConfirmDialog :open="!!confirmA" :title="`${confirmA?.label ?? ''}?`" :subtitle="confirmA ? `${confirmA.volume} · ${confirmA.estimate ? '~' + gb(confirmA.estimate) : 'size unknown'}` : ''"
      confirm-label="Clean" :danger="confirmA?.risk === 'careful'" @confirm="confirmA && run(confirmA)" @cancel="confirmA = null">
      <div v-if="confirmA?.risk === 'careful'" class="warnbox">Careful: this removes things that are not caches. Read what it does first.</div>
      <ul><li>{{ confirmA?.desc }}</li></ul>
      <pre class="log" style="max-height: 120px">{{ confirmA?.cmd }}</pre>
    </ConfirmDialog>
  </main>
</template>
