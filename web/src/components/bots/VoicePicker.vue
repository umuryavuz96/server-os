<script setup lang="ts">
// The voice Lahmacun answers with. Every installed voice (live from the speech services, /voice/showcase): the one in
// use up top, then flag tabs by language and tiles grouped by engine, each tile with a play button that fetches a short
// sample (made once on the server, then cached) and a tap that sets the desk speaker's voice (/house-voice).
import { ref, computed, onMounted, onUnmounted } from "vue";
import { api, toast } from "../../store";
import Flag, { flagOf } from "../Flag.vue";
import Icon from "../Icon.vue";

type Voice = { id: string; name: string; lang: string; language: string; accent?: string; engine: string; cloud: boolean; cost: string; sample: boolean; speed: { rtf: number; seconds: number } | null };
type Lang = "tr" | "en" | "other";
// cloudOn: the Cloud voices card's switch, so cloud tiles grey out the moment it moves.
const props = defineProps<{ cloudOn?: boolean }>();
const d = ref<{ available: boolean; cloudEnabled: boolean; installed: Voice[] } | null>(null);
const current = ref<string | null>(null), canUse = ref(false), filter = ref<Lang | null>(null), switching = ref<string | null>(null);
const loading = ref<string | null>(null), playing = ref<string | null>(null);
let audio: HTMLAudioElement | null = null, poll: ReturnType<typeof setInterval> | null = null;

const langOf = (v: Voice): Lang => (v.lang === "tr" || v.lang === "en" ? v.lang : "other");
const installed = computed(() => d.value?.installed ?? []);
const count = (l: Lang) => installed.value.filter((v) => langOf(v) === l).length;
const langs = computed(() => (["tr", "en", "other"] as Lang[]).filter((l) => count(l) > 0));
const LANG: Record<Lang, string> = { tr: "Turkish", en: "English", other: "Other" };
const TAB_FLAG: Record<Lang, string> = { tr: "tr", en: "gb", other: "" };

async function load() {
  try { d.value = await api("/voice/showcase"); } catch (e) { toast((e as Error).message); }
  await loadCurrent();
  // First look: open on the language of the voice in use, so its tile is in sight.
  if (!filter.value) { const cur = installed.value.find((v) => v.id === current.value); filter.value = cur ? langOf(cur) : langs.value[0] ?? "en"; }
}
async function loadCurrent() {
  try { const h = await api<{ available: boolean; voice?: string }>("/house-voice"); canUse.value = !!h.available; current.value = h.voice ?? null; } catch { /* no desk speaker */ }
}
onMounted(() => { void load(); poll = setInterval(loadCurrent, 10000); });
onUnmounted(() => { audio?.pause(); if (poll) clearInterval(poll); });

/** Play the voice's sample in this browser, stopping whatever else plays; pressed again, stop it. */
async function play(v: Voice) {
  if (playing.value === v.id) { audio?.pause(); playing.value = null; return; }
  audio?.pause(); playing.value = null; loading.value = v.id;
  try {
    const r = await fetch(`/api/v1/voice/sample?voice=${encodeURIComponent(v.id)}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? `HTTP ${r.status}`);
    const url = URL.createObjectURL(await r.blob());
    audio = new Audio(url);
    audio.onended = () => { playing.value = null; URL.revokeObjectURL(url); };
    await audio.play(); playing.value = v.id;
    if (!v.sample) void load(); // the sample was just made: pick up its measured speed
  } catch (e) { toast((e as Error).message); }
  loading.value = null;
}
/** The tile: make this the desk speaker's voice. */
async function use(v: Voice) {
  if (!canUse.value || current.value === v.id || switching.value || off(v)) return;
  switching.value = v.id;
  try { await api("/house-voice", { method: "PATCH", body: { voice: v.id } }); current.value = v.id; toast(`Lahmacun now speaks as ${v.name}`); } catch (e) { toast((e as Error).message); }
  switching.value = null;
}

const cloudOn = computed(() => props.cloudOn ?? d.value?.cloudEnabled ?? true);
const off = (v: Voice) => v.cloud && !cloudOn.value;
const cur = computed(() => installed.value.find((v) => v.id === current.value) ?? null);
// Tiles of the chosen language, grouped by engine (and accent) in the order the services list them.
const groups = computed(() => {
  const m = new Map<string, { label: string; flag: string; cloud: boolean; voices: Voice[] }>();
  for (const v of installed.value.filter((x) => langOf(x) === filter.value)) {
    const label = (langOf(v) === "other" ? [v.language, v.engine] : [v.engine, v.accent]).filter(Boolean).join(" · ");
    if (!m.has(label)) m.set(label, { label, flag: flagOf(v.lang, v.accent), cloud: v.cloud, voices: [] });
    m.get(label)!.voices.push(v);
  }
  return [...m.values()];
});
// A cold XTTS takes about 20 s to load before its first sample; say so instead of looking stuck.
const sub = (v: Voice) => (switching.value === v.id ? "Switching…"
  : loading.value === v.id ? (v.engine === "XTTS-v2" && !v.sample ? "Warming up XTTS, about 20 s the first time…" : "Making the sample, a few seconds…")
  : playing.value === v.id ? "Playing the sample…" : off(v) ? "Cloud voices are off"
  : (v.speed ? (v.speed.rtf <= 1 ? `${(1 / v.speed.rtf).toFixed(1)}× faster than real time` : `${v.speed.rtf.toFixed(1)}× slower than real time`) : "Not heard yet") + (v.cloud ? " · uses credits" : ""));
const tone = (v: Voice) => (loading.value === v.id && v.engine === "XTTS-v2" && !v.sample ? "warn" : playing.value === v.id ? "play" : off(v) ? "warn" : "");
</script>

<template>
  <section class="vp card" aria-label="Voice">
    <div v-if="canUse && current" class="vp-now">
      <span class="vp-disc"><Flag v-if="cur && flagOf(cur.lang, cur.accent)" :code="flagOf(cur.lang, cur.accent)" size="lg" /><Icon v-else name="globe" :size="22" /></span>
      <span class="vp-t"><small class="vp-k">Speaking as</small><b>{{ cur?.name ?? current }}</b><small v-if="cur">{{ cur.language }} · {{ cur.engine }}{{ cur.cloud ? " · cloud" : "" }}</small></span>
      <button v-if="cur" type="button" class="vp-play ghost" :class="{ busy: loading === cur.id, playing: playing === cur.id }" :disabled="(!!loading && loading !== cur.id) || off(cur)" :aria-label="(playing === cur.id ? 'Stop the sample of ' : 'Play a sample of ') + cur.name" @click="play(cur)">
        <Icon v-if="loading === cur.id" name="loader" :size="20" class="spin" /><Icon v-else-if="playing === cur.id" name="square" :size="14" fill="currentColor" /><Icon v-else name="play" fill="currentColor" />
      </button>
    </div>

    <p v-if="d && !d.available" class="meta">The speech services aren't answering, so no voices are listed.</p>
    <template v-else>
      <div class="vp-tabs" role="group" aria-label="Language">
        <button v-for="l in langs" :key="l" type="button" class="chip vp-tab" :aria-pressed="filter === l" @click="filter = l">
          <Flag v-if="TAB_FLAG[l]" :code="TAB_FLAG[l]" /><Icon v-else name="globe" :size="16" />{{ LANG[l] }} <span class="count">{{ count(l) }}</span>
        </button>
      </div>
      <p class="meta vp-hint">{{ canUse ? "Press play for a short sample. Tap a voice to switch to it." : "Press play for a short sample." }}</p>

      <div v-for="g in groups" :key="g.label" class="vp-group">
        <div class="vp-gh">
          <span class="vp-gt"><Flag v-if="g.flag" :code="g.flag" /><Icon v-else name="globe" :size="16" />{{ g.label }} <em>· {{ g.voices.length }}</em></span>
          <span :class="{ cloud: g.cloud }">{{ g.cloud ? "cloud · uses credits" : "on this Mac · free" }}</span>
        </div>
        <ul class="vp-tiles">
          <li v-for="v in g.voices" :key="v.id" class="vp-tile" :class="{ chosen: current === v.id, playing: playing === v.id, dimmed: off(v) }">
            <button type="button" class="vp-play" :class="{ busy: loading === v.id, playing: playing === v.id }" :disabled="(!!loading && loading !== v.id) || off(v)" :aria-label="(playing === v.id ? 'Stop the sample of ' : loading === v.id ? 'Making a sample of ' : 'Play a sample of ') + v.name" @click="play(v)">
              <Icon v-if="loading === v.id" name="loader" :size="20" class="spin" /><Icon v-else-if="playing === v.id" name="square" :size="14" fill="currentColor" /><Icon v-else name="play" fill="currentColor" />
            </button>
            <button type="button" class="vp-main" :disabled="!canUse || off(v) || !!switching" :aria-pressed="canUse ? current === v.id : undefined" :aria-label="canUse ? `Use ${v.name}` : v.name" @click="use(v)">
              <span class="vp-t">
                <b>{{ v.name }}</b>
                <small :class="tone(v)"><span v-if="playing === v.id" class="vp-bars" aria-hidden="true"><i></i><i></i><i></i></span>{{ sub(v) }}</small>
              </span>
              <span v-if="current === v.id" class="vp-inuse"><Icon name="circle-check" fill="var(--on)" class="vp-check" />In use</span>
              <Icon v-else-if="switching === v.id" name="loader" :size="22" class="spin vp-wait" />
              <span v-else-if="off(v)" class="vp-tag">Cloud</span>
              <span v-else-if="canUse" class="vp-radio" aria-hidden="true"></span>
            </button>
          </li>
        </ul>
      </div>
    </template>
  </section>
</template>

<style scoped>
.vp{display:flex;flex-direction:column;gap:12px;padding:14px;border-radius:16px;margin:0}
.vp-t{flex:1;min-width:0;display:flex;flex-direction:column}
.vp-t b{font:600 15px var(--body)}
.vp-t small{font-size:12px;color:var(--muted);display:inline-flex;align-items:center;gap:6px;min-width:0}
.vp-t small.warn{color:var(--warn)}
.vp-t small.play{color:#d97757}
.vp-now{display:flex;align-items:center;gap:12px;padding:12px;border-radius:12px;background:rgba(47,211,138,.10);border:1px solid rgba(47,211,138,.35)}
.vp-now .vp-t b{font:700 17px/1.2 var(--body)}
.vp-k{font:700 11px var(--body)!important;letter-spacing:.08em;text-transform:uppercase;color:var(--on)!important}
.vp-disc{flex:none;width:44px;height:44px;border-radius:50%;background:var(--panel-2);border:1px solid rgba(47,211,138,.4);display:grid;place-items:center;color:var(--on)}
.vp-tabs{display:flex;gap:6px;flex-wrap:wrap}
.vp-tab{display:inline-flex;align-items:center;gap:6px;min-height:38px;padding:0 11px 0 9px;background:var(--panel-2)}
.vp-tab .count{font-size:12px}
.vp-tab[aria-pressed="true"]{background:var(--ink)}
.vp-tab[aria-pressed="true"] .count{color:var(--bg);opacity:.55}
.vp-hint{margin:-4px 0 0;font-size:12px}
.vp-group{display:flex;flex-direction:column;gap:8px}
.vp-gh{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font:400 11px var(--body);color:var(--muted)}
.vp-gh .cloud{color:var(--warn)}
.vp-gt{display:inline-flex;align-items:center;gap:6px;font:700 12px var(--display);letter-spacing:.08em;text-transform:uppercase}
.vp-gt em{font-style:normal;color:#5c5c64}
.vp-tiles{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,250px),1fr));gap:8px}
.vp-tile{display:flex;align-items:center;gap:12px;padding:10px 12px 10px 10px;border-radius:14px;border:1px solid var(--line);background:var(--panel-2);transition:border-color .2s var(--ease),box-shadow .2s var(--ease)}
.vp-tile.playing{border-color:#3a3a40}
.vp-tile.chosen{border-color:var(--on);box-shadow:0 0 0 3px rgba(47,211,138,.12)}
.vp-tile.dimmed{opacity:.55}
.vp-play{flex:none;width:44px;height:44px;border-radius:50%;border:1px solid #2a2a30;background:#151518;color:var(--ink);display:grid;place-items:center;cursor:pointer;transition:background .15s var(--ease),color .15s var(--ease)}
.vp-play:hover:not(:disabled),.vp-play.playing{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.vp-play:disabled{cursor:default}
.vp-play.ghost{width:40px;height:40px;background:transparent;border-color:rgba(47,211,138,.4);color:var(--on)}
.vp-play.ghost:hover:not(:disabled),.vp-play.ghost.playing{background:var(--on);color:var(--bg);border-color:var(--on)}
.spin{animation:vp-spin .9s linear infinite}
@keyframes vp-spin{to{transform:rotate(360deg)}}
.vp-main{flex:1;min-width:0;display:flex;align-items:center;gap:10px;min-height:44px;padding:0;border:0;background:none;color:inherit;text-align:left;cursor:pointer;font:inherit}
.vp-main:disabled{cursor:default}
.vp-radio{flex:none;width:22px;height:22px;border-radius:50%;border:1.5px solid #3a3a40}
.vp-main:hover:not(:disabled) .vp-radio{border-color:var(--muted)}
.vp-inuse{flex:none;display:inline-flex;align-items:center;gap:5px;font:600 11px var(--mono);letter-spacing:.03em;text-transform:uppercase;color:var(--on)}
.vp-check{color:var(--bg)}
.vp-wait{color:var(--muted)}
.vp-tag{flex:none;font:600 11px var(--mono);letter-spacing:.03em;text-transform:uppercase;color:var(--warn)}
.vp-bars{display:inline-flex;align-items:flex-end;gap:2px;height:10px}
.vp-bars i{display:block;width:3px;border-radius:1px;background:currentColor;animation:vp-bar 1s ease-in-out infinite}
.vp-bars i:nth-child(1){height:10px}.vp-bars i:nth-child(2){height:5px;animation-delay:.2s}.vp-bars i:nth-child(3){height:8px;animation-delay:.4s}
@keyframes vp-bar{50%{transform:scaleY(.4)}}
.vp-play:focus-visible,.vp-main:focus-visible{outline:3px solid var(--accent);outline-offset:2px;border-radius:8px}
</style>
