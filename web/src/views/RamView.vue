<script setup lang="ts">
// Ram: where the memory of this Mac goes. Overview of the macOS figures, history, a breakdown bar,
// VMs, panel apps, Claude sessions, everything else and the biggest movers. Read-only.
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { S, appList, mb, api, memText, type AppState, type RamGroup } from "../store";
import LineChart, { type Series } from "../dash/LineChart.vue";
import RamIcon from "./RamIcon.vue";
import RamList from "./RamList.vue";
import Icon from "../components/Icon.vue";
import { stable } from "./ramStable";

const R = computed(() => S.ram ?? null);
const gb = (m: number) => (m / 1024).toFixed(m >= 10240 ? 0 : 1);
const dur = (s: number) => (s >= 86400 ? Math.floor(s / 86400) + " d " + Math.floor((s % 86400) / 3600) + " h" : s >= 3600 ? Math.floor(s / 3600) + " h " + Math.floor((s % 3600) / 60) + " m" : Math.max(1, Math.floor(s / 60)) + " m");

// ---- icons ----
const iconUrl = (name: string) => `/api/v1/ram/icon?name=${encodeURIComponent(name)}`;
const squash = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, "");
const appIcon = (n: string | null | undefined) => (n ? (S.apps[n] ?? Object.values(S.apps).find((x) => squash(x.name) === squash(n)))?.icon || null : null);
const CLAUDE_ICON = "/icons/installed/proc/Claude%20Code.png";
const gIcon = (g: { name: string; icon?: boolean; src?: string | null }) => (g.src || (g.icon ? iconUrl(g.name) : null));
const mvIcon = (name: string) => { const g = R.value?.groups.find((x) => x.name === name); return g ? gIcon(g) : null; };

// ---- details (collapsed by default) and the sticky footer ----
const det = ref(false), detEl = ref<HTMLElement | null>(null);
const PRESS: Record<string, string> = { normal: "Pressure OK", warn: "Pressure high", critical: "Pressure critical", unknown: "Pressure —" };
const footLabel = computed(() => { const m = R.value; if (!m) return ""; return `Total in use ${m.usedMB != null ? gb(m.usedMB) : "unknown"} of ${gb(m.totalMB)} GB, ${PRESS[m.pressure]}, swap ${mb(m.swapUsedMB)}. Show details.`; });
function toDetails() {
  const was = det.value, calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  det.value = true;
  // wait for the opening animation: before it the page is too short to scroll the details to the top
  setTimeout(() => detEl.value?.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "start" }), was || calm ? 0 : 420);
}

// ---- 1. overview strip ----
const cards = computed(() => {
  const m = R.value; if (!m) return [];
  const pr = { normal: "OK", warn: "Warning", critical: "Critical", unknown: "Unknown" }[m.pressure];
  const sz = (v: number) => (v >= 1024 ? gb(v) + " GB" : Math.round(v) + " MB");
  return [
    { k: "total", cap: "Installed memory.", label: "Total", v: gb(m.totalMB) + " GB", tip: "Installed memory. It is shared by every program, the system and the file cache." },
    { k: "used", cap: "In use per macOS: app + wired + compressed.", label: "Used", v: m.usedMB != null ? gb(m.usedMB) + " GB" : "—", tip: "What macOS counts as in use: app memory + wired + compressed. Same figure as the Overview tab." },
    { k: "pressure", cap: "How hard macOS works to free memory.", label: "Pressure", v: pr, lvl: m.pressure, tip: "How hard macOS works to find free memory. OK is fine, warning means it compresses and swaps a lot, critical means programs are being starved." },
    { k: "swap", cap: "RAM overflow written to the SSD. Slow.", label: "Swap", v: sz(m.swapUsedMB), sub: m.swapTotalMB ? "of " + sz(m.swapTotalMB) : "", tip: "Memory pushed out to the SSD because RAM was full. Swap in use means the Mac ran short at some point. It is slow and wears the SSD." },
    { k: "compressed", cap: "Idle memory squeezed small. Cheap, normal.", label: "Compressed", v: gb(m.compressedMB) + " GB", tip: "Idle memory squeezed into less space instead of going to swap. This is cheap and normal." },
    { k: "wired", cap: "System memory that cannot be swapped.", label: "Wired", v: gb(m.wiredMB) + " GB", tip: "Memory the system itself needs (kernel, drivers). It can never be compressed or swapped out." },
    { k: "app", cap: "Held by running programs.", label: "App memory", v: gb(m.appMB) + " GB", tip: "Memory held by running programs, without the system and the file cache." },
    { k: "cached", cap: "Files kept in RAM. Given back on demand.", label: "Cached files", v: gb(m.cachedMB) + " GB", tip: "File contents kept in RAM for speed. macOS gives it back the moment a program needs it, so a big number here is healthy." },
    { k: "free", cap: "Empty. Near zero is normal on macOS.", label: "Free", v: gb(m.freeMB) + " GB", tip: "Memory holding nothing at all. Near zero is normal on macOS, it uses spare memory as cache." },
  ];
});

// ---- 2. history ----
type Rng = "1h" | "24h" | "7d";
const rng = ref<Rng>("1h");
const ramS = ref<Series | null>(null), swapS = ref<Series | null>(null);
let timer: ReturnType<typeof setInterval> | undefined, hseq = 0;
async function loadHist() {
  const n = ++hseq, r = rng.value;
  try {
    const [a, b] = await Promise.all([api<Series>(`/history?metric=ram&range=${r}&points=120`), api<Series>(`/history?metric=swap&range=${r}&points=120`)]);
    if (n === hseq) { ramS.value = a; swapS.value = b; }
  } catch { /* keep the last one */ }
}
watch(rng, () => { ramS.value = null; swapS.value = null; void loadHist(); });
onMounted(() => { void loadHist(); timer = setInterval(loadHist, 60_000); });
onUnmounted(() => clearInterval(timer));
const fGB = (v: number) => v.toFixed(1) + " GB";

// ---- 3. breakdown ----
const COL: Record<string, string> = { vms: "var(--rm-vm)", apps: "var(--rm-app)", claude: "var(--rm-claude)", other: "var(--rm-other)", macos: "var(--rm-os)" };
const TIP: Record<string, string> = {
  vms: "Home Assistant VM and the Docker VM, as the Mac sees them.", apps: "Apps on the Apps tab that are not VMs.", claude: "Every running claude process with its helpers.",
  other: "Everything else that runs.", macos: "Wired memory and the kernel.",
};
const lbl = (x: { key: string; label: string }) => (x.key === "apps" ? "Panel apps (outside VMs)" : x.label);
const bsum = computed(() => (R.value ? R.value.breakdown.reduce((t, s) => t + s.mb, 0) : 0));
const bden = computed(() => Math.max(1, R.value?.totalMB ?? 1, bsum.value));
const bpct = (m: number) => (m / bden.value) * 100;

// ---- 4. VMs ----
const vmMax = computed(() => Math.max(1, ...(R.value?.vms ?? []).map((v) => Math.max(v.footprintMB, v.configuredMB ?? 0))));

// ---- 5. panel apps ----
type AKey = "name" | "group" | "mem" | "src" | "state";
const aKey = ref<AKey>("mem"), aDesc = ref(true);
const aSort = (k: AKey) => { if (aKey.value === k) aDesc.value = !aDesc.value; else { aKey.value = k; aDesc.value = k === "mem"; } };
const aAria = (k: AKey) => (aKey.value === k ? (aDesc.value ? "descending" : "ascending") : "none");
const aArrow = (k: AKey) => (aKey.value === k ? (aDesc.value ? "↓" : "↑") : "↕");
const SRC: Record<string, string> = { vm: "VM footprint", docker: "Docker stats", process: "Process memory", port: "Port owner", static: "Static site", remote: "Another machine", off: "Stopped", unknown: "Not measurable" };
const stateOf = (a: AppState) => (a.kind === "lock" ? "core" : a.state === "off" ? "stopped" : a.state === "part" ? "partly on" : "running");
const apps = stable(() => {
  const key = (a: AppState): number | string => aKey.value === "name" ? a.name.toLowerCase() : aKey.value === "group" ? a.group.toLowerCase() : aKey.value === "mem" ? a.mem : aKey.value === "src" ? a.memSrc ?? "" : stateOf(a);
  return [...appList.value].sort((a, b) => { const x = key(a), y = key(b); const c = x < y ? -1 : x > y ? 1 : 0; return aDesc.value ? -c : c; });
}, (a) => a.name, () => aKey.value + aDesc.value, (a) => (aKey.value === "mem" ? (aDesc.value ? a.mem : -a.mem) : 0));
const appsMax = computed(() => Math.max(1, ...appList.value.map((a) => a.mem)));

// ---- 6. Claude sessions ----
const claudeRows = stable(() => R.value?.claude ?? [], (c) => String(c.pid), () => 0, (c) => c.mb);
const claudeTotal = computed(() => (R.value?.claude ?? []).reduce((t, c) => t + c.mb, 0));
const up = (t: number) => dur(Math.max(0, (Date.now() - (t > 1e12 ? t : t * 1000)) / 1000));

// ---- 7. everything else ----
const q = ref(""), all = ref(false), openG = ref<Set<string>>(new Set());
const extra = ref<{ total: number; groups: RamGroup[] } | null>(null);
let qt: ReturnType<typeof setTimeout> | undefined, qn = 0;
// Top 50 come with the live slice; search and "show all" ask the server for the full list.
async function loadGroups() {
  const n = ++qn, term = q.value.trim();
  if (!term && !all.value) { extra.value = null; return; }
  try { const r = await api<{ total: number; groups: RamGroup[] }>(`/ram/groups?q=${encodeURIComponent(term)}&limit=${all.value || term ? 0 : 50}`); if (n === qn) extra.value = r; } catch { /* keep the live top 50 */ }
}
watch([q, all], () => { clearTimeout(qt); qt = setTimeout(loadGroups, 200); });
let gt: ReturnType<typeof setInterval> | undefined;
onMounted(() => { gt = setInterval(() => { if (extra.value) void loadGroups(); }, 15_000); });
onUnmounted(() => { clearTimeout(qt); clearInterval(gt); });
const gsrc = stable(() => (extra.value ? extra.value.groups : R.value?.groups ?? []), (g) => g.name, () => q.value.trim() + all.value + (extra.value ? 1 : 0), (g) => g.mb);
const groups = computed(() => ({ n: extra.value ? extra.value.total : R.value?.groupCount ?? 0, list: gsrc.value }));
const gMax = computed(() => Math.max(1, R.value?.groups[0]?.mb ?? 1));
function toggle(n: string) { const s = new Set(openG.value); s.has(n) ? s.delete(n) : s.add(n); openG.value = s; }

// ---- 8. movers ----
const movers = stable(() => R.value?.movers.up ?? [], (m) => m.name, () => 0, (m) => m.deltaMB);
const mvMax = computed(() => Math.max(1, ...movers.value.map((m) => m.deltaMB)));
</script>

<template>
  <main class="page ramtab">
    <header class="ph">
      <h1>Ram</h1>
      <span v-if="R" class="hint">Updated live · read-only</span>
    </header>

    <p v-if="!R" class="hint rm-wait">Reading memory…</p>

    <template v-else>
      <!-- main view: one list of everything that holds RAM -->
      <section class="rm-sec rm-main" aria-labelledby="rm-h-list">
        <div class="rm-hd"><h2 id="rm-h-list">Using RAM now <small>biggest first · tap to open</small></h2></div>
        <RamList v-if="R.list?.length" :rows="R.list" />
        <p v-else class="hint">Reading programs…</p>
        <p class="hint rm-note">Sizes as Activity Monitor shows them. They include memory macOS has compressed or moved to swap, so the rows add up to more than “Total in use”.</p>
      </section>

      <section ref="detEl" class="rm-det" :class="{ on: det }" aria-labelledby="rm-h-det">
        <button id="rm-h-det" type="button" class="rm-det-h" :aria-expanded="det" aria-controls="rm-det-b" @click="det = !det">
          <span>Details</span><small>overview, history, VMs, panel apps, Claude sessions, all processes, growth</small><Icon name="chevron-down" :size="18" class="rm-det-c" />
        </button>
        <div id="rm-det-b" class="rm-det-x" :inert="!det"><div class="rm-det-in">
      <!-- 1. overview -->
      <section class="rm-cards" aria-label="Memory overview">
        <div v-for="c in cards" :key="c.k" class="rm-card" :class="c.lvl && 'lvl-' + c.lvl" :title="c.tip" tabindex="0">
          <small>{{ c.label }}</small>
          <b>{{ c.v }}</b><em v-if="c.sub">{{ c.sub }}</em>
          <p>{{ c.cap }}</p>
        </div>
      </section>

      <!-- 2. history -->
      <section class="rm-sec" aria-labelledby="rm-h-hist">
        <div class="rm-hd">
          <h2 id="rm-h-hist">History</h2>
          <div class="rm-rng" role="group" aria-label="Time range">
            <button v-for="r in (['1h', '24h', '7d'] as Rng[])" :key="r" type="button" :aria-pressed="rng === r" @click="rng = r">{{ r === "1h" ? "1 hour" : r === "24h" ? "24 hours" : "7 days" }}</button>
          </div>
        </div>
        <div class="rm-charts">
          <figure><figcaption>RAM used <small>of {{ gb(R.totalMB) }} GB</small></figcaption><div class="rm-chart"><LineChart :series="ramS" :fmt="fGB" :min-span="2" axis :band="(ramS?.step ?? 0) >= 300" /></div></figure>
          <figure><figcaption>Swap used</figcaption><div class="rm-chart"><LineChart :series="swapS" :fmt="fGB" :min-span="0.5" color="var(--rm-claude)" axis :band="(swapS?.step ?? 0) >= 300" /></div></figure>
        </div>
      </section>

      <!-- 3. breakdown -->
      <section class="rm-sec" aria-labelledby="rm-h-brk">
        <h2 id="rm-h-brk">Where it goes <small>{{ mb(R.procSumMB) }} summed from processes</small></h2>
        <div class="rm-bar" role="img" :aria-label="R.breakdown.map((x) => `${lbl(x)} ${mb(x.mb)}`).join(', ')">
          <i v-for="x in R.breakdown" :key="x.key" :style="{ width: bpct(x.mb) + '%', background: COL[x.key] }" :title="`${lbl(x)}: ${mb(x.mb)}`"></i>
          <i class="rest" :style="{ width: bpct(R.restMB) + '%' }" title="Cache, free and not measured"></i>
        </div>
        <ul class="rm-key">
          <li v-for="x in R.breakdown" :key="x.key" :title="TIP[x.key]"><i :style="{ background: COL[x.key] }"></i>{{ lbl(x) }} <b>{{ mb(x.mb) }}</b></li>
          <li title="File cache, free memory and anything not measured per process."><i class="rest"></i>Cache, free, not measured <b>{{ mb(R.restMB) }}</b></li>
        </ul>
        <p class="hint">Measured per process (resident memory) and per VM (host footprint). Memory shared between programs and memory macOS has compressed is counted more than once, so these parts can add up to more than the “Used” figure above.</p>
      </section>

      <!-- 4. virtual machines -->
      <section class="rm-sec" aria-labelledby="rm-h-vm">
        <h2 id="rm-h-vm">Virtual machines</h2>
        <p v-if="!R.vms.length" class="hint">No virtual machines.</p>
        <ul class="rm-vms">
          <li v-for="v in R.vms" :key="v.name">
            <div class="vm-hd"><RamIcon :name="v.name" :src="appIcon(v.name) ?? (v.kind === 'docker' ? iconUrl('Docker') : null)" glyph="boxes" /><b>{{ v.name }}</b><span class="pill" :class="v.running ? 'p-on' : 'p-off'">{{ v.running ? "RUNNING" : "STOPPED" }}</span></div>
            <div class="vm-row"><span>Live on the Mac</span><span class="rb"><i :style="{ width: (v.footprintMB / vmMax) * 100 + '%' }"></i></span><span class="num">{{ mb(v.footprintMB) }}</span></div>
            <div class="vm-row"><span>Set aside</span><span class="rb"><i class="cfg" :style="{ width: ((v.configuredMB ?? 0) / vmMax) * 100 + '%' }"></i></span><span class="num">{{ v.configuredMB ? mb(v.configuredMB) : "—" }}</span></div>
            <template v-if="v.kind === 'docker'">
              <h3>Inside: {{ v.items.length }} container{{ v.items.length === 1 ? "" : "s" }}</h3>
              <ul class="rm-list scrl">
                <li v-for="c in [...v.items].sort((a, b) => a.name.localeCompare(b.name))" :key="c.name">
                  <span class="rn"><RamIcon :name="c.app ?? c.name" :src="appIcon(c.app)" glyph="boxes" />{{ c.name }}<a v-if="c.app" class="lnk" :href="'#apps?open=' + encodeURIComponent(c.app)">{{ c.app }}</a><small v-else class="np">not in panel</small></span>
                  <span class="rb"><i :style="{ width: (c.mb / Math.max(1, v.footprintMB)) * 100 + '%' }"></i></span>
                  <span class="rv num">{{ mb(c.mb) }}</span>
                </li>
                <li>
                  <span class="rn"><RamIcon name="Docker" :src="iconUrl('Docker')" />VM itself <small class="np">kernel and page cache</small></span>
                  <span class="rb"><i class="cfg" :style="{ width: (v.overheadMB / Math.max(1, v.footprintMB)) * 100 + '%' }"></i></span>
                  <span class="rv num">{{ mb(v.overheadMB) }}</span>
                </li>
              </ul>
            </template>
          </li>
        </ul>
      </section>

      <!-- 5. panel apps -->
      <section class="rm-sec" aria-labelledby="rm-h-apps">
        <div class="rm-hd"><h2 id="rm-h-apps">Panel apps <small>{{ appList.length }}</small></h2><a class="lnk" href="#apps">Open Apps</a></div>
        <div class="tbl rm-tbl scrl" role="table" aria-label="Panel apps by memory">
          <div class="tr th" role="row">
            <button type="button" role="columnheader" :aria-sort="aAria('name')" class="c-n" @click="aSort('name')">Name {{ aArrow("name") }}</button>
            <button type="button" role="columnheader" :aria-sort="aAria('group')" class="c-g" @click="aSort('group')">Group {{ aArrow("group") }}</button>
            <button type="button" role="columnheader" :aria-sort="aAria('mem')" class="c-m" @click="aSort('mem')">RAM {{ aArrow("mem") }}</button>
            <button type="button" role="columnheader" :aria-sort="aAria('src')" class="c-s" @click="aSort('src')">Measured by {{ aArrow("src") }}</button>
            <button type="button" role="columnheader" :aria-sort="aAria('state')" class="c-t" @click="aSort('state')">Status {{ aArrow("state") }}</button>
          </div>
          <a v-for="a in apps" :key="a.name" class="tr" :class="{ dim: a.state === 'off' }" role="row" :href="'#apps?open=' + encodeURIComponent(a.name)">
            <span class="c-n" role="cell"><RamIcon :name="a.name" :src="a.icon" glyph="blocks" /><b>{{ a.name }}</b></span>
            <span class="c-g" role="cell">{{ a.group }}</span>
            <span class="c-m num" role="cell"><span class="rb"><i :style="{ width: (a.mem / appsMax) * 100 + '%' }"></i></span>{{ memText(a) || "—" }}</span>
            <span class="c-s" role="cell">{{ SRC[a.memSrc ?? ""] ?? "—" }}</span>
            <span class="c-t" role="cell">{{ stateOf(a) }}</span>
          </a>
        </div>
      </section>

      <!-- 6. Claude sessions -->
      <section class="rm-sec" aria-labelledby="rm-h-cl">
        <h2 id="rm-h-cl">Claude sessions <small>{{ R.claude.length }} running · {{ mb(claudeTotal) }}</small></h2>
        <p v-if="!R.claude.length" class="hint">No claude sessions running.</p>
        <ul class="rm-list rm-cl">
          <li v-for="c in claudeRows" :key="c.pid">
            <span class="rn"><RamIcon :name="c.name" :src="c.src || CLAUDE_ICON" glyph="bot" /><b>{{ c.name }}</b> <span v-if="c.agent" class="tag k-agent">{{ c.agent }}</span><span class="tag">{{ c.status }}</span><small class="path">{{ c.cwd }}</small></span>
            <span class="rb"><i :style="{ width: (c.mb / Math.max(1, R.claude[0]?.mb)) * 100 + '%' }"></i></span>
            <span class="rv num">{{ mb(c.mb) }}<small>{{ c.n }} proc · {{ up(c.startedAt) }}</small></span>
          </li>
        </ul>
      </section>

      <!-- 7. everything else -->
      <section class="rm-sec" aria-labelledby="rm-h-else">
        <div class="rm-hd">
          <h2 id="rm-h-else">Everything else <small>{{ groups.n }} groups</small></h2>
          <label class="search2">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
            <input v-model="q" type="search" placeholder="Search processes…" aria-label="Search processes" />
          </label>
        </div>
        <ul class="rm-list rm-else scrl" style="max-height: 640px">
          <li v-for="g in groups.list" :key="g.name" :class="{ 'g-on': openG.has(g.name) }">
            <button type="button" class="gbtn" :aria-expanded="openG.has(g.name)" :disabled="!g.procs.length" @click="toggle(g.name)">
              <span class="rn"><span class="chev" aria-hidden="true">›</span><RamIcon :name="g.name" :src="gIcon(g)" />{{ g.name }} <small v-if="g.app && g.bins?.length" class="np">{{ g.bins.join(", ") }}</small><small v-else-if="g.n > 1">× {{ g.n }}</small></span>
              <span class="rb"><i :style="{ width: (g.mb / gMax) * 100 + '%' }"></i></span>
              <span class="rv num">{{ mb(g.mb) }}</span>
            </button>
            <div class="gx" :class="{ on: openG.has(g.name) }"><div>
              <table v-if="g.procs.length" class="ptbl"><thead><tr><th>pid</th><th v-if="g.app">program</th><th>RAM</th><th>running</th></tr></thead>
                <tbody><tr v-for="p in g.procs" :key="p.pid"><td class="num">{{ p.pid }}</td><td v-if="g.app">{{ p.bin }}</td><td class="num">{{ mb(p.mb) }}</td><td class="num">{{ dur(p.upSec) }}</td></tr></tbody></table>
            </div></div>
          </li>
        </ul>
        <p v-if="!groups.n" class="hint">Nothing matches.</p>
        <button v-if="!all && !q.trim() && groups.n > groups.list.length" type="button" class="btn" @click="all = true">Show all {{ groups.n }}</button>
        <p class="hint">Process names are the program name only, never the command line.</p>
      </section>

      <!-- 8. movers -->
      <section class="rm-sec" aria-labelledby="rm-h-mv">
        <h2 id="rm-h-mv">Biggest growth <small>last {{ R.movers.spanMin >= 60 ? Math.round(R.movers.spanMin / 60) + " hour" : R.movers.spanMin + " min" }}</small></h2>
        <p v-if="R.movers.spanMin < 2" class="hint">Collecting samples, ready in {{ Math.max(1, Math.ceil(2 - R.movers.spanMin)) }} min.</p>
        <p v-else-if="!movers.length" class="hint">Nothing has grown noticeably.</p>
        <ul class="rm-list">
          <li v-for="m in R.movers.spanMin >= 2 ? movers : []" :key="m.name">
            <span class="rn"><RamIcon :name="m.name" :src="mvIcon(m.name)" />{{ m.name }} <small v-if="m.isNew">new</small></span>
            <span class="rb"><i class="up" :style="{ width: (m.deltaMB / mvMax) * 100 + '%' }"></i></span>
            <span class="rv num">+{{ mb(m.deltaMB) }}<small>{{ mb(m.beforeMB) }} → {{ mb(m.nowMB) }}</small></span>
          </li>
        </ul>
      </section>
        </div></div>
      </section>

      <!-- sticky footer: the macOS figure -->
      <button type="button" class="rm-foot" :class="'lvl-' + R.pressure" :aria-label="footLabel" @click="toDetails">
        <span class="rf-dot" aria-hidden="true"></span>
        <span class="rf-t"><small>Total in use</small><b class="num">{{ R.usedMB != null ? gb(R.usedMB) : "—" }} <em>of {{ gb(R.totalMB) }} GB</em></b></span>
        <span class="rf-bar" aria-hidden="true"><i :style="{ width: ((R.usedMB ?? 0) / Math.max(1, R.totalMB)) * 100 + '%' }"></i></span>
        <span class="rf-s"><small>{{ PRESS[R.pressure] }}</small><b class="num">Swap {{ R.swapUsedMB >= 1024 ? gb(R.swapUsedMB) + " GB" : Math.round(R.swapUsedMB) + " MB" }}</b></span>
      </button>
    </template>
  </main>
</template>

<style scoped>
.ramtab { --rm-vm: #6f9bff; --rm-app: #4cc79a; --rm-claude: #e9a24f; --rm-other: #b184ee; --rm-os: #8b909a; }
.rm-wait { padding: 18px; }
.rm-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(168px, 1fr)); gap: 10px; }
.rm-card { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 12px 14px; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.rm-card small { color: var(--muted); font: 600 11.5px var(--body); text-transform: uppercase; letter-spacing: .04em; }
.rm-card b { font: 700 22px/1.15 var(--mono); }
.rm-card em { font: 500 11.5px var(--mono); color: var(--muted); font-style: normal; margin-top: -2px; }
.rm-card p { margin: 4px 0 0; color: var(--muted); font: 400 12px/1.35 var(--body); }
.rm-card.lvl-warn b { color: var(--warn, #e9a24f); }
.rm-card.lvl-critical b { color: var(--bad, #ff6b6b); }
.rm-sec { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 16px 18px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.rm-sec h2 { font: 700 15px var(--body); margin: 0; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.rm-sec h2 small { color: var(--muted); font: 600 12px var(--mono); }
.rm-sec h3 { font: 700 12.5px var(--body); margin: 8px 0 2px; color: var(--muted); }
.rm-hd { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.rm-rng { display: inline-flex; border: 1px solid var(--line); border-radius: 9px; overflow: hidden; }
.rm-rng button { font: 600 12.5px var(--body); padding: 6px 12px; min-height: 32px; background: transparent; color: var(--muted); border: 0; cursor: pointer; transition: background .2s, color .2s; }
.rm-rng button[aria-pressed="true"] { background: color-mix(in srgb, var(--accent) 22%, transparent); color: var(--ink); }
.rm-charts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.rm-charts figure { margin: 0; min-width: 0; }
.rm-charts figcaption { font: 600 12.5px var(--body); margin-bottom: 6px; }
.rm-charts figcaption small { color: var(--muted); font-weight: 500; }
.rm-chart { height: 170px; }
.rm-bar { display: flex; height: 16px; border-radius: 8px; overflow: hidden; background: var(--bg); border: 1px solid var(--line); }
.rm-bar i { display: block; height: 100%; transition: width .4s cubic-bezier(.2, .8, .2, 1); }
.rm-key { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px 18px; font: 600 12.5px var(--body); }
.rm-key li { display: inline-flex; align-items: center; gap: 6px; }
.rm-key i { width: 10px; height: 10px; border-radius: 3px; }
.rm-key i.rest, .rm-bar i.rest { background: repeating-linear-gradient(45deg, color-mix(in srgb, var(--muted) 35%, transparent) 0 4px, transparent 4px 8px); }
.rm-key b { font-family: var(--mono); }
.rm-vms { list-style: none; margin: 0; padding: 0; display: grid; gap: 18px; }
.vm-hd { display: flex; gap: 10px; align-items: center; margin-bottom: 6px; }
.vm-row { display: grid; grid-template-columns: 110px minmax(60px, 1fr) 76px; gap: 12px; align-items: center; font: 500 12.5px var(--body); color: var(--muted); margin: 3px 0; }
.vm-row .num { color: var(--ink); text-align: right; }
.rm-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.rm-list > li, .gbtn { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(60px, 2fr) 96px; gap: 12px; align-items: center; font: 600 13px var(--body); }
.rn { min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 2px 8px; overflow-wrap: anywhere; }
.rn small { color: var(--muted); font-weight: 500; }
.rn .np { color: var(--muted); }
.rn .path { flex-basis: 100%; padding-left: 36px; font: 400 11.5px var(--mono); color: var(--muted); overflow-wrap: anywhere; }
.rv { text-align: right; }
.rm-list .rv { display: flex; flex-direction: column; align-items: flex-end; }
.rm-list .rv small { color: var(--muted); font: 500 11px var(--body); white-space: nowrap; }
.rb { height: 6px; border-radius: 3px; background: var(--bg); overflow: hidden; }
.rb i { display: block; height: 100%; background: color-mix(in srgb, var(--accent) 45%, var(--muted)); border-radius: 3px; transition: width .4s cubic-bezier(.2, .8, .2, 1); }
.rb i.cfg { background: color-mix(in srgb, var(--muted) 55%, transparent); }
.rb i.up { background: var(--rm-claude); }
.lnk { color: var(--accent); text-decoration: none; font: 600 12px var(--body); }
.lnk:hover { text-decoration: underline; }
.tag { font: 600 10.5px var(--mono); padding: 2px 7px; border-radius: 999px; background: color-mix(in srgb, var(--muted) 20%, transparent); color: var(--ink); }
.tag.k-bot { background: color-mix(in srgb, var(--rm-app) 24%, transparent); }
.tag.k-agent { background: color-mix(in srgb, var(--rm-vm) 26%, transparent); }
.rm-tbl .tr { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr) minmax(120px, 1.4fr) minmax(0, 1.4fr) 90px; gap: 12px; align-items: center; color: inherit; text-decoration: none; padding: 9px 12px; }
.scrl { max-height: 460px; overflow: auto; overscroll-behavior: contain; }
.rm-tbl .th { position: sticky; top: 0; background: var(--panel); z-index: 1; }
.rm-tbl .th button { text-align: left; font: 600 12px var(--body); color: var(--muted); background: none; border: 0; cursor: pointer; padding: 0; min-height: 28px; }
.rm-tbl .c-n { display: flex; align-items: center; gap: 10px; min-width: 0; }
.rm-tbl .c-m { display: flex; flex-direction: column; gap: 4px; align-items: stretch; text-align: left; }
.rm-tbl a.tr:hover { background: color-mix(in srgb, var(--accent) 8%, transparent); }
.rm-tbl .dim { opacity: .55; }
.rm-tbl .c-s, .rm-tbl .c-g, .rm-tbl .c-t { color: var(--muted); font-size: 12.5px; overflow-wrap: anywhere; }
.rm-else > li { display: block; }
.gbtn { width: 100%; background: none; border: 0; padding: 4px 0; color: inherit; cursor: pointer; text-align: left; min-height: 32px; }
.gbtn:disabled { cursor: default; }
.chev { display: inline-block; width: 12px; color: var(--muted); transition: transform .25s cubic-bezier(.2, .8, .2, 1); }
.g-on .chev { transform: rotate(90deg); }
.gx { display: grid; grid-template-rows: 0fr; transition: grid-template-rows .28s cubic-bezier(.2, .8, .2, 1); }
.gx.on { grid-template-rows: 1fr; }
.gx > div { overflow: hidden; min-height: 0; }
.ptbl { margin: 4px 0 8px 14px; border-collapse: collapse; font: 500 12px var(--mono); max-height: 240px; display: block; overflow: auto; }
.ptbl th { text-align: left; color: var(--muted); font: 600 11px var(--body); padding: 2px 18px 2px 0; }
.ptbl td { padding: 2px 18px 2px 0; }
.rm-main { padding: 10px 12px 6px; gap: 4px; }
.rm-note { margin: 4px 4px 8px; font-size: 12px; }
.rm-main h2 small { text-transform: none; letter-spacing: 0; font: 500 12px var(--body); }
.rm-main .rm-hd { padding: 6px 4px 2px; }
.rm-det { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; min-width: 0; }
.rm-det-h { width: 100%; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 4px 12px; padding: 14px 18px; min-height: 52px; background: none; border: 0; color: inherit; font: inherit; text-align: left; cursor: pointer; border-radius: 16px; }
.rm-det-h span { font: 700 15px var(--body); }
.rm-det-h small { color: var(--muted); font: 400 12px var(--body); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rm-det-c { color: var(--muted); transition: transform .3s cubic-bezier(.2, .8, .2, 1); }
.rm-det.on .rm-det-c { transform: rotate(180deg); }
.rm-det-h:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.rm-det-x { display: grid; grid-template-rows: 0fr; transition: grid-template-rows .4s cubic-bezier(.2, .8, .2, 1); }
.rm-det.on .rm-det-x { grid-template-rows: 1fr; }
.rm-det-x > div { overflow: hidden; min-height: 0; opacity: 0; transition: opacity .3s; }
.rm-det.on .rm-det-x > div { opacity: 1; }
.rm-det-in { display: flex; flex-direction: column; gap: 14px; padding: 0 12px; }
.rm-det.on .rm-det-in { padding-bottom: 12px; }
.rm-det-in .rm-sec { background: color-mix(in srgb, var(--bg) 35%, transparent); }
.rm-foot {
  position: sticky; bottom: calc(10px + env(safe-area-inset-bottom, 0px)); z-index: 5; margin-top: auto;
  display: grid; grid-template-columns: 12px auto minmax(40px, 1fr) auto; align-items: center; gap: 12px;
  padding: 11px 16px; min-height: 58px; border-radius: 16px; border: 1px solid var(--line); color: var(--ink); font: inherit; text-align: left; cursor: pointer;
  background: var(--panel); backdrop-filter: blur(18px) saturate(1.3); -webkit-backdrop-filter: blur(18px) saturate(1.3);
  box-shadow: 0 10px 28px rgba(0, 0, 0, .35);
}
.rm-foot:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.rf-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--ok, #4cc79a); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok, #4cc79a) 25%, transparent); }
.lvl-warn .rf-dot { background: var(--warn, #e9a24f); box-shadow: 0 0 0 3px color-mix(in srgb, var(--warn, #e9a24f) 25%, transparent); }
.lvl-critical .rf-dot { background: var(--bad, #ff6b6b); box-shadow: 0 0 0 3px color-mix(in srgb, var(--bad, #ff6b6b) 25%, transparent); }
.lvl-unknown .rf-dot { background: var(--muted); box-shadow: none; }
.rf-t, .rf-s { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.rf-s { align-items: flex-end; }
.rm-foot small { color: var(--muted); font: 600 11px var(--body); text-transform: uppercase; letter-spacing: .04em; white-space: nowrap; }
.rf-t b { font: 700 17px var(--mono); white-space: nowrap; }
.rf-t em { font: 500 12.5px var(--mono); color: var(--muted); font-style: normal; }
.rf-s b { font: 600 13px var(--mono); white-space: nowrap; }
.rf-bar { height: 6px; border-radius: 3px; background: color-mix(in srgb, var(--muted) 20%, transparent); overflow: hidden; }
.rf-bar i { display: block; height: 100%; border-radius: 3px; background: color-mix(in srgb, var(--accent) 70%, var(--muted)); transition: width .45s cubic-bezier(.2, .8, .2, 1); }
.lvl-warn .rf-bar i { background: var(--warn, #e9a24f); }
.lvl-critical .rf-bar i { background: var(--bad, #ff6b6b); }
/* glass: the panels are see-through, the footer must not be (rows scroll under it) */
:root[data-layout="desktop"] .rm-foot { background: rgba(26, 20, 16, .94); border-color: rgba(255, 240, 224, .14); }
/* phone glass: the dock floats 64 px over the bottom; sticky offsets count from inside the 104 px bottom padding of the page frame */
@media (max-width: 700px) {
  :root[data-layout="desktop"] .rm-foot { bottom: -28px; }
}
@media (max-width: 420px) {
  .rm-foot { grid-template-columns: 12px minmax(0, 1fr) auto; gap: 6px 12px; padding: 10px 14px; }
  .rf-bar { grid-column: 1 / -1; grid-row: 2; }
  .rm-det-h small { display: none; }
}
@media (max-width: 760px) {
  .rm-charts { grid-template-columns: 1fr; }
  .rm-tbl .th { display: none; }
  .rm-tbl .tr { grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px; }
  .rm-tbl .c-m { grid-column: 1 / -1; grid-row: 2; }
  .rm-tbl .c-g { grid-column: 1; grid-row: 3; }
  .rm-tbl .c-s { grid-column: 1; grid-row: 4; }
  .rm-tbl .c-t { grid-column: 2; grid-row: 1; text-align: right; }
}
@media (max-width: 500px) {
  .rm-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rm-sec { padding: 14px; }
  .rm-list > li, .gbtn { grid-template-columns: minmax(0, 1fr) auto; gap: 4px 12px; }
  .rm-list .rb { grid-column: 1 / -1; grid-row: 2; }
  .rm-list .rv { grid-column: 2; grid-row: 1; }
  .vm-row { grid-template-columns: 92px minmax(40px, 1fr) 68px; gap: 8px; }
}
@media (prefers-reduced-motion: reduce) { .rm-det-x, .rm-det-x > div, .rm-det-c, .rf-bar i, .rm-bar i, .rb i, .gx, .chev, .rm-rng button { transition: none; } }
</style>
