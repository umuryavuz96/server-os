<script setup lang="ts">
// Dashboards: JSON-defined grids of cards (spec/dashboard.schema.json). View mode renders; edit mode lets you
// drag cards, resize them from the corner, change or add cards, then save. Import/export as files.
import { ref, reactive, computed, onMounted, watch } from "vue";
import { api, toast } from "../store";
import DashCard, { type Card } from "../dash/DashCard.vue";

interface Dash { id?: string; title: string; description?: string; refresh?: number; cards: Card[] }
const list = ref<{ id: string; title: string; cards: number }[]>([]);
const current = ref<string>("");
const dash = ref<Dash | null>(null);
const editing = ref(false), dirty = ref(false), busy = ref(false), err = ref("");
let saved = "";

const readHashId = () => new URLSearchParams(location.hash.split("?")[1] ?? "").get("d") ?? "";
async function loadList() { list.value = (await api<{ dashboards: typeof list.value }>("/dashboards")).dashboards; }
async function open(id: string) {
  current.value = id; editing.value = false; err.value = "";
  dash.value = await api<Dash>(`/dashboards/${id}`);
  saved = JSON.stringify(dash.value); dirty.value = false;
  history.replaceState(null, "", `#dashboards?d=${id}`);
}
onMounted(async () => { await loadList(); const want = readHashId(); await open(list.value.some((d) => d.id === want) ? want : list.value[0]?.id ?? "home"); });
watch(dash, () => { dirty.value = JSON.stringify(dash.value) !== saved; }, { deep: true });

// ---- layout ----
const sorted = computed(() => [...(dash.value?.cards ?? [])].sort((a, b) => a.y - b.y || a.x - b.x));
const rows = computed(() => Math.max(4, ...(dash.value?.cards ?? []).map((c) => c.y + c.h)) + (editing.value ? 3 : 0));
const gridEl = ref<HTMLElement | null>(null);
const ROW = 72, GAP = 12;
const style = (c: Card) => ({ gridColumn: `${c.x + 1} / span ${c.w}`, gridRow: `${c.y + 1} / span ${c.h}` });

// Drag to move, drag the corner to resize: pointer delta → whole grid cells.
const drag = reactive<{ id: string | null; mode: "move" | "size"; sx: number; sy: number; ox: number; oy: number; ow: number; oh: number }>({ id: null, mode: "move", sx: 0, sy: 0, ox: 0, oy: 0, ow: 0, oh: 0 });
function start(e: PointerEvent, c: Card, mode: "move" | "size") {
  if (!editing.value) return;
  (e.target as HTMLElement).setPointerCapture(e.pointerId);
  Object.assign(drag, { id: c.id, mode, sx: e.clientX, sy: e.clientY, ox: c.x, oy: c.y, ow: c.w, oh: c.h });
}
function move(e: PointerEvent) {
  if (!drag.id || !gridEl.value || !dash.value) return;
  const c = dash.value.cards.find((x) => x.id === drag.id)!;
  const colW = (gridEl.value.clientWidth + GAP) / 12;
  const dx = Math.round((e.clientX - drag.sx) / colW), dy = Math.round((e.clientY - drag.sy) / (ROW + GAP));
  if (drag.mode === "move") { c.x = Math.max(0, Math.min(12 - c.w, drag.ox + dx)); c.y = Math.max(0, drag.oy + dy); }
  else { c.w = Math.max(1, Math.min(12 - c.x, drag.ow + dx)); c.h = Math.max(1, Math.min(12, drag.oh + dy)); }
}
function end() { if (drag.id) settle(drag.id); drag.id = null; }

// Like react-grid-layout's vertical compaction: the card you moved keeps its place, anything it now overlaps
// is pushed below it, then every card floats up as far as it can.
const hit = (a: Card, b: Card) => a !== b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
function settle(fixedId?: string) {
  const cards = dash.value?.cards; if (!cards) return;
  const fixed = cards.find((c) => c.id === fixedId);
  const order = [...cards].sort((a, b) => (a === fixed ? -1 : b === fixed ? 1 : a.y - b.y || a.x - b.x));
  const placed: Card[] = [];
  for (const c of order) {
    if (c !== fixed) { while (placed.some((p) => hit(c, p))) c.y++; }
    placed.push(c);
  }
  for (const c of [...cards].sort((a, b) => a.y - b.y || a.x - b.x)) {
    while (c.y > 0) { c.y--; if (cards.some((o) => hit(c, o))) { c.y++; break; } }
  }
}

// ---- edit a card ----
const TYPES: [string, string][] = [["metric", "Chart"], ["stat", "Number"], ["gauge", "Gauge"], ["bar", "Bar chart"], ["apps", "Apps"], ["jobs", "Jobs"], ["bots", "Bots"], ["claude", "Claude"], ["logs", "Logs"], ["text", "Text"]];
const DESIGNS: Record<string, string[]> = { metric: ["hero", "line", "area"], stat: ["tile", "big"], gauge: ["ring", "bar"], apps: ["list", "grid"], jobs: ["list"], bots: ["list"], claude: ["usage", "jobs"], logs: ["stream"], text: ["plain"], bar: ["default"] };
const METRICS = ["ram", "cpu", "disk", "swap", "load", "net"], RANGES = ["1h", "2h", "6h", "24h", "7d", "30d", "90d"];
const sel = ref<Card | null>(null);
function addCard() {
  const d = dash.value!; let n = d.cards.length + 1; while (d.cards.some((c) => c.id === `card-${n}`)) n++;
  const c: Card = { id: `card-${n}`, type: "stat", title: "New card", x: 0, y: rows.value - 3, w: 3, h: 2, design: "tile", query: { metric: "ram" } };
  d.cards.push(c); sel.value = c; settle(c.id);
}
function removeCard(c: Card) { dash.value!.cards = dash.value!.cards.filter((x) => x !== c); sel.value = null; settle(); }
function setType(c: Card, t: string) {
  c.type = t; c.design = DESIGNS[t][0];
  c.query = t === "metric" ? { metric: "ram", range: "24h" } : t === "bar" ? { metric: "ram", range: "7d", points: 28 } : t === "stat" || t === "gauge" ? { metric: "ram" } : t === "logs" ? { filter: "warn", limit: 20 } : ["apps", "jobs", "bots", "claude"].includes(t) ? { limit: 6 } : undefined;
  if (t === "text") c.text = c.text ?? "## Notes\n\nWrite **Markdown** here.";
}
const qset = (c: Card, k: string, v: unknown) => { c.query = { ...(c.query ?? {}) }; if (v === "" || v == null || Number.isNaN(v)) delete c.query[k]; else c.query[k] = v; };

async function save() {
  busy.value = true; err.value = "";
  try {
    const { id: _id, ...body } = dash.value!;
    dash.value = await api<Dash>(`/dashboards/${current.value}`, { method: "PUT", body });
    saved = JSON.stringify(dash.value); dirty.value = false; editing.value = false; sel.value = null;
    toast("Dashboard saved"); await loadList();
  } catch (e) { err.value = (e as Error).message; }
  busy.value = false;
}
function cancel() { dash.value = JSON.parse(saved); editing.value = false; sel.value = null; err.value = ""; }
async function newDashboard() {
  const title = window.prompt("Name of the new dashboard", "My dashboard"); if (!title) return;
  const id = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "dashboard";
  try { await api(`/dashboards/${id}`, { method: "PUT", body: { title, cards: [{ id: "intro", type: "text", x: 0, y: 0, w: 6, h: 2, text: `## ${title}\n\nPress **Edit** to add cards.` }] } }); await loadList(); await open(id); editing.value = true; }
  catch (e) { toast((e as Error).message); }
}
async function removeDashboard() {
  if (!window.confirm(`Delete the dashboard “${dash.value?.title}”?`)) return;
  try { await api(`/dashboards/${current.value}`, { method: "DELETE" }); await loadList(); await open(list.value[0]?.id ?? "home"); } catch (e) { toast((e as Error).message); }
}
function exportFile() {
  const { id: _id, ...body } = dash.value!;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: "application/json" }));
  a.download = `${current.value}.json`; a.click(); URL.revokeObjectURL(a.href);
}
const fileIn = ref<HTMLInputElement | null>(null);
async function importFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return;
  try {
    const body = JSON.parse(await f.text());
    const id = f.name.replace(/\.json$/, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 40);
    await api(`/dashboards/${id}`, { method: "PUT", body }); await loadList(); await open(id); toast("Imported");
  } catch (e2) { toast((e2 as Error).message); }
  (e.target as HTMLInputElement).value = "";
}
</script>

<template>
  <main class="page">
    <header class="ph">
      <h1>{{ dash?.title ?? "Dashboards" }}</h1>
      <div style="display: flex; gap: 8px; flex-wrap: wrap">
        <template v-if="!editing">
          <button type="button" class="btn" @click="newDashboard">+ New</button>
          <button type="button" class="btn" @click="fileIn?.click()">Import</button>
          <button type="button" class="btn" :disabled="!dash" @click="exportFile">Export</button>
          <button type="button" class="btn primary" :disabled="!dash" @click="editing = true">Edit</button>
        </template>
        <template v-else>
          <button type="button" class="btn" @click="addCard">+ Card</button>
          <button type="button" class="btn" style="color: var(--bad)" @click="removeDashboard">Delete</button>
          <button type="button" class="btn" @click="cancel">Cancel</button>
          <button type="button" class="btn primary" :disabled="busy || !dirty" @click="save">Save</button>
        </template>
        <input ref="fileIn" type="file" accept="application/json,.json" hidden @change="importFile" />
      </div>
    </header>
    <div v-if="list.length > 1" class="chips" role="tablist" aria-label="Dashboards">
      <button v-for="d in list" :key="d.id" type="button" class="chip" role="tab" :aria-pressed="d.id === current" @click="open(d.id)">{{ d.title }}</button>
    </div>
    <p v-if="err" class="form-err" role="alert">{{ err }}</p>
    <p v-if="editing" class="hint">Drag a card to move it, drag its corner to resize, click it to change what it shows.</p>

    <div v-if="dash" ref="gridEl" class="dgrid" :class="{ editing }" :style="{ gridTemplateRows: `repeat(${rows}, ${ROW}px)` }" @pointermove="move" @pointerup="end" @pointercancel="end">
      <div v-for="c in sorted" :key="c.id" class="dcell" :class="{ sel: sel === c, dragging: drag.id === c.id }" :style="{ ...style(c), '--h': c.h }"
        @pointerdown="start($event, c, 'move')" @click="editing && (sel = c)">
        <DashCard :card="c" :refresh="dash.refresh ?? 60" />
        <span v-if="editing" class="dresize" aria-label="Resize" @pointerdown.stop="start($event, c, 'size')"></span>
      </div>
    </div>

    <Teleport to="body">
      <Transition name="drawer">
        <div v-if="editing && sel" class="dr-wrap dr-side">
          <aside class="dr" role="dialog" aria-label="Edit card">
            <div class="dr-h"><span class="dr-title">Card</span><button type="button" class="btn" aria-label="Close" @click="sel = null">✕</button></div>
            <div class="dr-b form">
              <label class="fld">Title<input v-model="sel.title" maxlength="80" /></label>
              <div class="fld">Type<div class="kinds" style="grid-template-columns: repeat(5, 1fr)"><button v-for="[t, l] in TYPES" :key="t" type="button" :aria-pressed="sel.type === t" @click="setType(sel, t)">{{ l }}</button></div></div>
              <div v-if="DESIGNS[sel.type].length > 1" class="fld">Design<div class="kinds"><button v-for="d in DESIGNS[sel.type]" :key="d" type="button" :aria-pressed="(sel.design ?? DESIGNS[sel.type][0]) === d" @click="sel.design = d">{{ d }}</button></div></div>
              <template v-if="['metric', 'bar', 'stat', 'gauge'].includes(sel.type)">
                <div class="fld-row">
                  <label class="fld">Metric<select :value="sel.query?.metric ?? ''" @change="qset(sel, 'metric', ($event.target as HTMLSelectElement).value)"><option value="">— state path —</option><option v-for="m in METRICS" :key="m">{{ m }}</option></select></label>
                  <label v-if="['metric', 'bar'].includes(sel.type)" class="fld">Range<select :value="sel.query?.range ?? '24h'" @change="qset(sel, 'range', ($event.target as HTMLSelectElement).value)"><option v-for="r in RANGES" :key="r">{{ r }}</option></select></label>
                  <label v-else class="fld">State path<input :value="sel.query?.value ?? ''" placeholder="system.load1" @change="qset(sel, 'value', ($event.target as HTMLInputElement).value)" /></label>
                </div>
                <div class="fld-row">
                  <label class="fld">Unit<input :value="sel.query?.unit ?? ''" @change="qset(sel, 'unit', ($event.target as HTMLInputElement).value)" /></label>
                  <label v-if="sel.type === 'gauge'" class="fld">Full scale<input type="number" :value="sel.query?.max ?? 100" @change="qset(sel, 'max', Number(($event.target as HTMLInputElement).value))" /></label>
                  <label v-else-if="sel.type === 'bar'" class="fld">Bars<input type="number" min="10" max="400" :value="sel.query?.points ?? 24" @change="qset(sel, 'points', Number(($event.target as HTMLInputElement).value))" /></label>
                </div>
                <div class="fld-row">
                  <label class="fld">Warn at<input type="number" :value="sel.query?.warn ?? ''" @change="qset(sel, 'warn', ($event.target as HTMLInputElement).value === '' ? '' : Number(($event.target as HTMLInputElement).value))" /></label>
                  <label class="fld">Bad at<input type="number" :value="sel.query?.bad ?? ''" @change="qset(sel, 'bad', ($event.target as HTMLInputElement).value === '' ? '' : Number(($event.target as HTMLInputElement).value))" /></label>
                </div>
              </template>
              <template v-if="['apps', 'jobs', 'bots', 'logs', 'claude'].includes(sel.type)">
                <div class="fld-row">
                  <label class="fld">Show<select :value="sel.query?.filter ?? ''" @change="qset(sel, 'filter', ($event.target as HTMLSelectElement).value)">
                    <option value="">default</option>
                    <template v-if="sel.type === 'apps'"><option value="on">running</option><option value="off">stopped</option><option value="all">all</option></template>
                    <template v-if="sel.type === 'jobs'"><option value="next">up next</option><option value="failing">failing</option><option value="all">all</option></template>
                    <template v-if="sel.type === 'bots'"><option value="running">running</option><option value="all">all</option></template>
                    <template v-if="sel.type === 'logs'"><option>error</option><option>warn</option><option>info</option></template>
                  </select></label>
                  <label class="fld">How many<input type="number" min="1" max="50" :value="sel.query?.limit ?? 6" @change="qset(sel, 'limit', Number(($event.target as HTMLInputElement).value))" /></label>
                </div>
                <label v-if="sel.type === 'apps'" class="fld">Sort<select :value="sel.query?.sort ?? 'mem'" @change="qset(sel, 'sort', ($event.target as HTMLSelectElement).value)"><option value="mem">RAM</option><option value="name">name</option><option value="uptime">uptime</option></select></label>
              </template>
              <label v-if="sel.type === 'text'" class="fld">Text (Markdown)<textarea v-model="sel.text" rows="8"></textarea></label>
              <div class="fld-row">
                <label class="fld">Width (of 12)<input v-model.number="sel.w" type="number" min="1" :max="12 - sel.x" @change="settle(sel.id)" /></label>
                <label class="fld">Height (rows)<input v-model.number="sel.h" type="number" min="1" max="12" @change="settle(sel.id)" /></label>
              </div>
              <button type="button" class="btn big" style="color: var(--bad)" @click="removeCard(sel)">Remove card</button>
            </div>
          </aside>
        </div>
      </Transition>
    </Teleport>
  </main>
</template>
