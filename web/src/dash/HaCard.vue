<script setup lang="ts">
// Home Assistant dashboard cards (entity, toggle, climate, camera, media, history, button, group). Live state and
// optimistic service calls live in ha.ts; this file is only the faces.
import { computed, onUnmounted, ref, watch } from "vue";
import { S, api } from "../store";
import Icon from "../components/Icon.vue";
import LineChart, { type Series } from "./LineChart.vue";
import { callOn, dead, entityOf, fmtValue, iconFor, isOn, toggleEntity, typeFor } from "./ha";

interface Card { id: string; type: string; title?: string; h?: number; design?: string; query?: Record<string, any> }
const props = defineProps<{ card: Card; refresh: number }>();
const id = computed<string>(() => props.card.query?.entity ?? "");
const e = computed(() => entityOf(id.value));
const title = computed(() => props.card.title || e.value?.name || id.value || props.card.type);
const off = computed(() => dead(e.value));
/** Why there is nothing to show yet, or "". */
const gone = computed(() => {
  if (props.card.type === "group") return "";
  if (!S.haBridge?.configured) return "Home Assistant isn't set up";
  if (!e.value) return S.haBridge.online ? (id.value ? "Loading…" : "Pick an entity") : "Home Assistant isn't reachable";
  return "";
});
const sub = computed(() => [e.value?.area, e.value && off.value ? "unavailable" : ""].filter(Boolean).join(" · "));

// ---- entity ----
const val = computed(() => (e.value ? fmtValue(e.value) : { text: "–", unit: "" }));

// ---- toggle ----
const on = computed(() => !!e.value && isOn(e.value));
const bright = computed(() => (e.value?.domain === "light" && on.value && (e.value.attrs?.brightness ?? 0) > 0 ? `${Math.round(((e.value.attrs?.brightness ?? 0) / 255) * 100)}%` : ""));

// ---- climate: − / + move a local setpoint at once, the call goes out after a pause so repeated taps are one request ----
const attrs = computed(() => e.value?.attrs ?? {});
const step = computed(() => attrs.value.target_temp_step ?? 0.5);
const local = ref<number | null>(null);
let sendTimer: ReturnType<typeof setTimeout> | undefined;
const setpoint = computed<number | null>(() => local.value ?? attrs.value.temperature ?? null);
function bump(dir: 1 | -1) {
  const cur = setpoint.value ?? attrs.value.current_temperature; if (cur == null) return;
  const next = Math.min(attrs.value.max_temp ?? 35, Math.max(attrs.value.min_temp ?? 5, Math.round((cur + dir * step.value) * 10) / 10));
  local.value = next; clearTimeout(sendTimer);
  sendTimer = setTimeout(async () => { await callOn(id.value, "set_temperature", { temperature: next }, { attrs: { temperature: next } }); local.value = null; }, 700);
}
const action = computed(() => (e.value?.state === "off" ? "off" : attrs.value.hvac_action ?? e.value?.state ?? ""));

// ---- camera: a still every 5 s (paused while the tab is hidden); click to enlarge ----
const tick = ref(Date.now()), big = ref(false), camErr = ref(false);
// A still every 5 s on the card, every 2.5 s while enlarged.
const camTimer = setInterval(() => { if (!document.hidden && props.card.type === "camera" && (big.value || Date.now() - tick.value >= 4900)) tick.value = Date.now(); }, 2500);
// Load the next still off-screen and swap it in, so the picture never blanks between refreshes.
const snap = ref("");
watch([tick, id], () => {
  if (!id.value || props.card.type !== "camera") return;
  const url = `/api/v1/ha/camera/${id.value}?t=${tick.value}`, im = new Image();
  im.onload = () => { snap.value = url; camErr.value = false; };
  im.onerror = () => { camErr.value = true; };
  im.src = url;
}, { immediate: true });
watch(big, (o) => { if (o) tick.value = Date.now(); });

// ---- media ----
const playing = computed(() => e.value?.state === "playing");
const vol = computed<number | null>(() => attrs.value.volume_level ?? null);
const playPause = () => callOn(id.value, e.value?.state === "idle" || e.value?.state === "off" ? "media_play" : "media_play_pause", {}, { state: playing.value ? "paused" : "playing" });
function nudge(d: number) {
  if (vol.value == null) return;
  const v = Math.min(1, Math.max(0, Math.round((vol.value + d) * 100) / 100));
  void callOn(id.value, "volume_set", { volume_level: v }, { attrs: { volume_level: v } });
}

// ---- history ----
const series = ref<Series | null>(null), hErr = ref(false);
async function loadSeries() {
  if (props.card.type !== "history" || !id.value) return;
  try { series.value = await api<Series>(`/ha/history/${id.value}?range=${props.card.query?.range ?? "24h"}&points=${props.card.query?.points ?? 120}`); hErr.value = false; } catch { hErr.value = true; }
}
watch(() => props.card.type + JSON.stringify(props.card.query), () => { series.value = null; void loadSeries(); }, { immediate: true });
const histTimer = setInterval(loadSeries, Math.max(30, props.refresh) * 1000);
const hfmt = (v: number) => (Math.abs(v) >= 100 ? String(Math.round(v)) : v.toFixed(1));
const lineRef = ref<InstanceType<typeof LineChart> | null>(null);
const shown = computed(() => lineRef.value?.hv?.v ?? (e.value && !off.value && Number.isFinite(Number(e.value.state)) ? Number(e.value.state) : null));

// ---- button ----
const done = ref(false), busy = ref(false);
async function press() {
  busy.value = true;
  done.value = await callOn(id.value, "turn_on");
  busy.value = false;
  if (done.value) setTimeout(() => { done.value = false; }, 1800);
}

// ---- group ----
const kids = computed<string[]>(() => props.card.query?.entities ?? []);
const kidStates = computed(() => kids.value.map((k) => entityOf(k)));
const kidsOn = computed(() => kidStates.value.filter((k) => k && isOn(k) && ["light", "switch", "fan", "input_boolean"].includes(k.domain)).length);
const open = ref(false);
const kidCard = (k: string): Card => ({ id: "g-" + k, type: typeFor(k.split(".")[0]), design: "row", query: { entity: k } });
const onKey = (ev: KeyboardEvent) => { if (ev.key === "Escape") { open.value = false; big.value = false; } };
watch(() => open.value || big.value, (o) => (o ? addEventListener("keydown", onKey) : removeEventListener("keydown", onKey)));
onUnmounted(() => { clearInterval(camTimer); clearInterval(histTimer); clearTimeout(sendTimer); removeEventListener("keydown", onKey); });
</script>

<template>
  <div class="ha" :class="`ha-${card.type}`">
    <!-- entity -->
    <template v-if="card.type === 'entity'">
      <div class="dc-head"><span class="dc-t">{{ title }}</span><Icon v-if="e" :name="iconFor(e.domain)" :size="15" /></div>
      <p v-if="gone" class="hint">{{ gone }}</p>
      <template v-else>
        <div class="dc-num ha-bottom" :class="{ big: card.design === 'big', dim: off }">{{ off ? "–" : val.text }}<small>{{ val.unit }}</small></div>
        <div v-if="sub" class="ha-sub">{{ sub }}</div>
      </template>
    </template>

    <!-- toggle -->
    <template v-else-if="card.type === 'toggle'">
      <div class="ha-tg" :class="{ row: card.design === 'row' }">
        <span class="ha-ico" :class="{ on }"><Icon :name="iconFor(e?.domain ?? 'switch')" :size="18" /></span>
        <span class="ha-name"><b>{{ title }}</b><small>{{ gone || [bright, sub].filter(Boolean).join(" · ") || (on ? "On" : "Off") }}</small></span>
        <button v-if="e" type="button" class="sw" role="switch" :aria-checked="on" :aria-label="title" :disabled="off" @click="toggleEntity(e)"></button>
      </div>
    </template>

    <!-- climate -->
    <template v-else-if="card.type === 'climate'">
      <div class="dc-head"><span class="dc-t">{{ title }}</span><span class="dc-r">{{ action }}</span></div>
      <p v-if="gone" class="hint">{{ gone }}</p>
      <template v-else>
        <div class="dc-num ha-bottom" :class="{ dim: off }">{{ attrs.current_temperature != null ? attrs.current_temperature : "–" }}<small>°C now</small></div>
        <div class="ha-step">
          <button type="button" class="ha-rb" aria-label="Lower the setpoint" :disabled="off || setpoint == null" @click="bump(-1)"><Icon name="minus" :size="18" /></button>
          <span class="ha-sp"><b class="num">{{ setpoint != null ? setpoint.toFixed(1) + " °C" : "–" }}</b><small>target</small></span>
          <button type="button" class="ha-rb" aria-label="Raise the setpoint" :disabled="off || setpoint == null" @click="bump(1)"><Icon name="plus" :size="18" /></button>
        </div>
      </template>
    </template>

    <!-- camera -->
    <template v-else-if="card.type === 'camera'">
      <div class="dc-head"><span class="dc-t">{{ title }}</span><span class="dc-r">{{ e?.state === "unavailable" ? "offline" : "live" }}</span></div>
      <p v-if="gone" class="hint">{{ gone }}</p>
      <button v-else type="button" class="ha-cam" :aria-label="`Enlarge ${title}`" @click="big = true">
        <img v-if="snap" :src="snap" :alt="title" />
        <span v-if="camErr || !snap" class="ha-cam-x">{{ camErr ? "No snapshot" : "Loading…" }}</span>
      </button>
    </template>

    <!-- media -->
    <template v-else-if="card.type === 'media'">
      <div class="dc-head"><span class="dc-t">{{ title }}</span><span class="dc-r">{{ e?.state ?? "" }}</span></div>
      <p v-if="gone" class="hint">{{ gone }}</p>
      <template v-else>
        <div class="ha-now"><b>{{ attrs.media_title || (off ? "Unavailable" : on ? "Nothing playing" : "Off") }}</b><small>{{ attrs.media_artist || attrs.source || sub }}</small></div>
        <div class="ha-ctl">
          <button type="button" class="ha-rb big" :aria-label="playing ? 'Pause' : 'Play'" :disabled="off" @click="playPause"><Icon :name="playing ? 'pause' : 'play'" :size="20" fill="currentColor" /></button>
          <span class="ha-vol">
            <button type="button" class="ha-rb" aria-label="Volume down" :disabled="off || vol == null" @click="nudge(-0.05)"><Icon name="minus" :size="16" /></button>
            <span class="num" aria-label="Volume">{{ vol != null ? Math.round(vol * 100) + "%" : "–" }}</span>
            <button type="button" class="ha-rb" aria-label="Volume up" :disabled="off || vol == null" @click="nudge(0.05)"><Icon name="plus" :size="16" /></button>
          </span>
        </div>
      </template>
    </template>

    <!-- history -->
    <template v-else-if="card.type === 'history'">
      <div class="dc-head"><span class="dc-t">{{ title }}</span><span class="dc-r">{{ (card.query?.range ?? "24h").toUpperCase() }}</span></div>
      <div class="dc-num">{{ shown != null ? hfmt(shown) : "–" }}<small>{{ e?.unit ?? "" }}</small></div>
      <LineChart ref="lineRef" class="dc-chart" :series="series" :fmt="hfmt" :min-span="1" :axis="(card.h ?? 4) >= 4" />
      <p v-if="hErr" class="hint">No history from Home Assistant.</p>
    </template>

    <!-- button -->
    <template v-else-if="card.type === 'button'">
      <button type="button" class="ha-go" :class="{ done }" :disabled="busy || off || !!gone" @click="press">
        <Icon :name="done ? 'check' : iconFor(e?.domain ?? 'scene')" :size="22" />
        <span><b>{{ title }}</b><small>{{ gone || (done ? "Done" : e?.domain === "script" ? "Run" : "Activate") }}</small></span>
      </button>
    </template>

    <!-- group -->
    <template v-else-if="card.type === 'group'">
      <button type="button" class="ha-grp" :aria-label="`Open ${title}`" @click="open = true">
        <span class="dc-head"><span class="dc-t">{{ title }}</span><span class="dc-r">{{ kidsOn }} on</span></span>
        <span class="ha-chips"><span v-for="(k, i) in kidStates.slice(0, 3)" :key="i" class="ha-chip"><i class="led" :class="{ on: k && isOn(k) }"></i>{{ k?.name ?? kids[i] }}</span></span>
        <span class="dc-r ha-more">{{ kids.length > 3 ? `+${kids.length - 3} more · ` : "" }}open</span>
      </button>
      <Teleport to="body">
        <div v-if="open" class="ha-lb" role="dialog" aria-modal="true" :aria-label="title">
          <div class="ha-lb-bg" @click="open = false"></div>
          <div class="ha-sheet">
            <div class="dr-h"><span class="dr-title">{{ title }}</span><button type="button" class="btn" aria-label="Close" @click="open = false"><Icon name="x" :size="16" /></button></div>
            <div class="ha-kids"><div v-for="k in kids" :key="k" class="dc ha-kid" :class="`ha-k-${typeFor(k.split('.')[0])}`"><HaCard :card="kidCard(k)" :refresh="refresh" /></div></div>
          </div>
        </div>
      </Teleport>
    </template>

    <Teleport to="body">
      <div v-if="big && card.type === 'camera'" class="ha-lb" role="dialog" aria-modal="true" :aria-label="title">
        <div class="ha-lb-bg" @click="big = false"></div>
        <figure class="ha-photo"><img v-if="snap" :src="snap" :alt="title" /><figcaption>{{ title }}<button type="button" class="btn" aria-label="Close" @click="big = false"><Icon name="x" :size="16" /></button></figcaption></figure>
      </div>
    </Teleport>
  </div>
</template>
