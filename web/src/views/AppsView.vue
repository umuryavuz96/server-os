<script setup lang="ts">
// Apps, after the Sweatpals reference: stat cards that filter, group tabs, search, sortable table; a row opens the side drawer.
import AnimatedNumber from "../components/AnimatedNumber.vue";
import { ref, computed, onMounted, onUnmounted } from "vue";
import { S, appList, uptimeFor, ago, api, toast, memText, memHow, type AppState } from "../store";
import AppIcon from "../components/AppIcon.vue";
import AppDrawer from "../components/AppDrawer.vue";
import AppCard from "../components/AppCard.vue";
import { look } from "../desktop/prefs";

type Seg = "all" | "on" | "off" | "core";
type SortKey = "name" | "mem" | "uptime" | "since";
const seg = ref<Seg>("all"), group = ref("All"), q = ref("");
const sortKey = ref<SortKey>("mem"), desc = ref(true);
const open = ref<string | null>(null);
// Other pages link straight to an app's drawer with #apps?open=<name> (e.g. the Ports inspector).
const readOpen = () => {
  const name = new URLSearchParams(location.hash.split("?")[1] ?? "").get("open");
  if (!name) return;
  open.value = name;
  history.replaceState(null, "", location.pathname + location.search + "#apps");
};
onMounted(() => { readOpen(); addEventListener("hashchange", readOpen); });
onUnmounted(() => removeEventListener("hashchange", readOpen));

const isOn = (a: AppState) => a.kind === "lock" || a.state !== "off";
const counts = computed(() => ({ all: appList.value.length, on: appList.value.filter((a) => a.kind !== "lock" && a.state !== "off").length, off: appList.value.filter((a) => a.state === "off").length, core: appList.value.filter((a) => a.kind === "lock").length }));
const SEGS = computed(() => [["all", "All apps", counts.value.all], ["on", "Running", counts.value.on], ["off", "Stopped", counts.value.off], ["core", "Core", counts.value.core]] as [Seg, string, number][]);
const life = (a: AppState) => S.life?.[a.name];
const upPct = (a: AppState) => (a.state !== "off" ? uptimeFor(a.name)?.pct ?? null : null);
const rows = computed(() => {
  const ql = q.value.trim().toLowerCase();
  const list = appList.value.filter((a) =>
    (seg.value === "all" || (seg.value === "on" ? a.kind !== "lock" && a.state !== "off" : seg.value === "off" ? a.state === "off" : a.kind === "lock")) &&
    (group.value === "All" || a.group === group.value) && (!ql || (a.name + " " + a.about + " " + a.group).toLowerCase().includes(ql)));
  const key = (a: AppState): number | string => sortKey.value === "name" ? a.name.toLowerCase() : sortKey.value === "mem" ? a.mem : sortKey.value === "uptime" ? upPct(a) ?? -1 : life(a)?.since ?? 0;
  return [...list].sort((a, b) => { const x = key(a), y = key(b); const c = x < y ? -1 : x > y ? 1 : 0; return desc.value ? -c : c; });
});
function sortBy(k: SortKey) { if (sortKey.value === k) desc.value = !desc.value; else { sortKey.value = k; desc.value = k !== "name"; } }
const aria = (k: SortKey) => (sortKey.value === k ? (desc.value ? "descending" : "ascending") : "none");
const arrow = (k: SortKey) => (sortKey.value === k ? (desc.value ? "↓" : "↑") : "↕");
const statusOf = (a: AppState): [string, string] => {
  if (a.kind === "lock") return ["p-lock", "CORE"];
  if (a.state === "off") return ["p-off", "STOPPED"];
  if (life(a)?.healthy === false) return ["p-bad", "DOWN"];
  return a.state === "part" ? ["p-part", "PARTLY ON"] : ["p-on", a.kind === "gate" ? "ONLINE" : "RUNNING"];
};
// Found on this server: running here, not on this tab yet. "Add to Apps" writes a catalog entry.
interface Found { id: string; kind: "site" | "docker" | "launchd"; name: string; about: string; detail: string; group: string; href?: string }
const found = ref<Found[]>([]), draft = ref<Record<string, { name: string; group: string }>>({}), busy = ref("");
async function loadFound() {
  try {
    found.value = (await api<{ items: Found[] }>("/apps/discovered")).items;
    for (const f of found.value) draft.value[f.id] ??= { name: f.name, group: f.group };
  } catch { found.value = []; }
}
async function addFound(f: Found) {
  busy.value = f.id;
  try { await api("/apps/discovered/add", { body: { id: f.id, ...draft.value[f.id] } }); toast(`${draft.value[f.id].name} added to Apps`); await loadFound(); }
  catch (e) { toast((e as Error).message); } finally { busy.value = ""; }
}
async function ignoreFound(f: Found) {
  busy.value = f.id;
  try { await api("/apps/discovered/ignore", { body: { id: f.id } }); await loadFound(); } catch (e) { toast((e as Error).message); } finally { busy.value = ""; }
}
onMounted(loadFound);
// Glass desktop: a home-screen grid of app cards instead of the table (the user 2026-10-31); filters and search stay.
const desk = computed(() => look.layout === "desktop");
const opened = computed(() => appList.value.find((a) => a.name === open.value) ?? null);
</script>

<template>
  <main class="page">
    <header class="ph">
      <h1>Apps</h1>
      <label class="search2">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
        <input v-model="q" type="search" placeholder="Search apps…" aria-label="Search apps" />
      </label>
    </header>

    <div class="segs" role="group" aria-label="Filter by state">
      <button v-for="[k, label, n] in SEGS" :key="k" type="button" class="seg" :aria-pressed="seg === k" @click="seg = k">
        <span>{{ label }}</span><b><AnimatedNumber :value="n" /></b>
      </button>
    </div>

    <div class="gtabs" role="tablist" aria-label="Group">
      <button v-for="g in ['All', ...S.groups]" :key="g" type="button" role="tab" :aria-selected="group === g" @click="group = g">{{ g }}</button>
    </div>

    <!-- glass desktop: the cards, the "found" list and the note scroll together inside this panel; classic: no box -->
    <div :class="desk ? 'at-scroll' : 'at-flat'">
    <template v-if="desk">
      <TransitionGroup tag="div" name="tl" class="at-grid" aria-label="Apps">
        <AppCard v-for="a in rows" :key="a.name" class="glass-tile" :app="a" :status="statusOf(a)" @open="open = a.name" />
      </TransitionGroup>
      <p v-if="!rows.length" class="hint" style="padding: 18px">No apps match.</p>
    </template>
    <div v-else class="tbl" role="table" aria-label="Apps">
      <div class="tr th" role="row">
        <button type="button" role="columnheader" :aria-sort="aria('name')" class="c-app" @click="sortBy('name')">App {{ arrow("name") }}</button>
        <span role="columnheader" class="c-st">Status</span>
        <button type="button" role="columnheader" :aria-sort="aria('mem')" class="c-mem" @click="sortBy('mem')">RAM {{ arrow("mem") }}</button>
        <button type="button" role="columnheader" :aria-sort="aria('uptime')" class="c-up" @click="sortBy('uptime')">Uptime 24 h {{ arrow("uptime") }}</button>
        <button type="button" role="columnheader" :aria-sort="aria('since')" class="c-since" @click="sortBy('since')">Since {{ arrow("since") }}</button>
        <span role="columnheader" class="c-act"><span class="sr">Actions</span></span>
      </div>
      <TransitionGroup tag="div" name="tl" class="tbody">
        <div v-for="a in rows" :key="a.name" class="tr" :class="{ dim: !isOn(a) }" role="row" tabindex="0" @click="open = a.name" @keydown.enter="open = a.name">
          <span class="c-app" role="cell">
            <AppIcon :name="a.name" :icon="a.icon" />
            <span class="an"><b>{{ a.name }} <small class="gb">{{ a.group }}</small></b><small>{{ a.about }}</small></span>
          </span>
          <span class="c-st" role="cell"><span class="pill" :class="statusOf(a)[0]">{{ statusOf(a)[1] }}</span></span>
          <span class="c-mem num" role="cell" :title="memHow(a)">{{ memText(a) || "—" }}</span>
          <span class="c-up num" role="cell">
            <template v-if="upPct(a) != null"><span class="ubar"><i :style="{ width: upPct(a) + '%' }" :class="{ low: upPct(a)! < 99 }"></i></span>{{ upPct(a)!.toFixed(1) }}%</template>
            <template v-else>—</template>
          </span>
          <span class="c-since num" role="cell">{{ life(a)?.since ? ago(life(a)!.since) : "—" }}</span>
          <span class="c-act" role="cell"><button type="button" class="dots" :aria-label="`Open ${a.name} details`" @click.stop="open = a.name">⋯</button></span>
        </div>
      </TransitionGroup>
      <p v-if="!rows.length" class="hint" style="padding: 18px">No apps match.</p>
    </div>
    <section v-if="found.length" class="found" aria-labelledby="found-h">
      <h2 id="found-h">Found on this server <small>{{ found.length }}</small></h2>
      <p class="hint">These run here but are not on the Apps tab. Add one to switch it, health-check it and see its RAM; ignore the ones that are not apps.</p>
      <ul>
        <li v-for="f in found" :key="f.id">
          <div class="fi">
            <input v-model="draft[f.id].name" class="fname" :aria-label="`Name for ${f.id}`" maxlength="60" />
            <small>{{ f.detail }}</small>
          </div>
          <input v-model="draft[f.id].group" class="fgroup" list="found-groups" :aria-label="`Group for ${f.name}`" maxlength="40" />
          <button type="button" class="btn primary" :disabled="busy === f.id || !draft[f.id].name.trim()" @click="addFound(f)">Add to Apps</button>
          <button type="button" class="btn" :disabled="busy === f.id" @click="ignoreFound(f)">Ignore</button>
        </li>
      </ul>
      <datalist id="found-groups"><option v-for="g in S.groups" :key="g" :value="g" /></datalist>
    </section>
    <p class="foot"><a href="#ram">Details in Ram</a> · Health is checked every minute for every app (HTTP if it has a web page, otherwise its process). Switched-off time never counts as downtime. Every switch is logged.</p>
    </div>

    <AppDrawer :app="opened" @close="open = null" />
  </main>
</template>

<style scoped>
.found { margin-top: 26px; }
.rn { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rn small { color: var(--muted); font: 600 11px var(--mono); }
.at-flat { display: contents; }
.at-scroll { min-width: 0; }
.at-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(196px, 1fr)); gap: 16px; }
@media (max-width: 700px) { .at-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; } }
.found h2 { font: 700 15px var(--body); margin: 0 0 4px; display: flex; gap: 8px; align-items: baseline; }
.found h2 small { color: var(--muted); font: 600 12px var(--mono); }
.found ul { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.found li { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; }
.fi { flex: 1 1 260px; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.fi small { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.found input { font: 600 13px var(--body); color: var(--ink); background: transparent; border: 1px solid transparent; border-radius: 8px; padding: 4px 8px; margin-left: -8px; min-width: 0; }
.found input:hover, .found input:focus { border-color: var(--line); background: var(--bg); }
.fgroup { width: 150px; margin-left: 0 !important; border-color: var(--line) !important; }
</style>
