<script setup lang="ts">
// Voices: everything the server can speak with today (live from the speech services) with a cached ▶ sample each,
// and a catalog of open-source voices worth trying. "Use this voice" sets the desk speaker's voice, like the picker on the Voice page.
import { ref, computed, onMounted, onUnmounted } from "vue";
import { api, toast } from "../store";

type Voice = { id: string; name: string; lang: string; language: string; accent?: string; engine: string; cloud: boolean; cost: string; sample: boolean; speed: { rtf: number; seconds: number } | null };
type Entry = { id: string; name: string; kind: string; languages: string; turkish: string; cloning: boolean; license: string; size: string; repo: string; demo: string; note: string; installed: boolean };
const d = ref<{ available: boolean; cloudEnabled: boolean; installed: Voice[]; catalog: Entry[] } | null>(null);
const current = ref<string | null>(null), canUse = ref(false), filter = ref<"all" | "tr" | "en" | "other">("tr");
const loading = ref<string | null>(null), playing = ref<string | null>(null), copied = ref<string | null>(null);
let audio: HTMLAudioElement | null = null;

async function load() {
  try { d.value = await api("/voice/showcase"); } catch (e) { toast((e as Error).message); }
  try { const h = await api<{ available: boolean; voice?: string }>("/house-voice"); canUse.value = !!h.available; current.value = h.voice ?? null; } catch { /* no desk speaker */ }
}
onMounted(load);
onUnmounted(() => { audio?.pause(); });

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
    if (!v.sample) void load(); // the sample was just made: refresh its speed
  } catch (e) { toast((e as Error).message); }
  loading.value = null;
}
async function use(v: Voice) {
  try { await api("/house-voice", { method: "PATCH", body: { voice: v.id } }); current.value = v.id; toast(`Desk speaker now uses ${v.name}`); } catch (e) { toast((e as Error).message); }
}
async function copyAsk(e: Entry) {
  const text = `Please install ${e.name} as a voice on this server (${e.repo}) and add it to the Voices page.`;
  try { await navigator.clipboard.writeText(text); } catch { /* the text is shown anyway */ }
  copied.value = e.id; setTimeout(() => { if (copied.value === e.id) copied.value = null; }, 2500);
}

const shown = computed(() => (d.value?.installed ?? []).filter((v) => filter.value === "all" || (filter.value === "other" ? !["tr", "en"].includes(v.lang) : v.lang === filter.value)));
const count = (f: string) => (d.value?.installed ?? []).filter((v) => (f === "all" ? true : f === "other" ? !["tr", "en"].includes(v.lang) : v.lang === f)).length;
const speed = (v: Voice) => (v.speed ? (v.speed.rtf <= 1 ? `${(1 / v.speed.rtf).toFixed(1)}× faster than real time` : `${v.speed.rtf.toFixed(1)}× slower than real time`) : "speed unknown until played");
const TR: Record<string, string> = { yes: "Turkish: yes", no: "No Turkish", community: "Turkish: community only", "n/a": "Language-independent" };
</script>

<template>
  <main class="page vs">
    <header class="ph">
      <h1>Voices</h1>
      <p class="meta">Every voice this server can speak with, and open-source voices worth trying. Press play to hear a sample: it is made once and kept.</p>
    </header>

    <h2>Installed</h2>
    <p v-if="d && !d.available" class="meta">The speech services aren't answering, so no voices are listed.</p>
    <div v-else class="vs-chips" role="group" aria-label="Language">
      <button v-for="[k, l] in [['all', 'All'], ['tr', 'Turkish'], ['en', 'English'], ['other', 'Other']]" :key="k" type="button" class="chip" :aria-pressed="filter === k" @click="filter = k as typeof filter">{{ l }} <span class="count">{{ count(k) }}</span></button>
    </div>
    <ul class="vs-list">
      <li v-for="v in shown" :key="v.id" class="card vs-row" :class="{ on: current === v.id }">
        <button type="button" class="vs-play" :class="{ busy: loading === v.id, live: playing === v.id }" :disabled="!!loading || (v.cloud && !d?.cloudEnabled)" :aria-label="(playing === v.id ? 'Stop ' : 'Play sample of ') + v.name" @click="play(v)">
          <svg v-if="playing !== v.id" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M7 4.5v15l13-7.5z" fill="currentColor"/></svg>
          <svg v-else viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z" fill="currentColor"/></svg>
        </button>
        <div class="vs-t">
          <b>{{ v.name }}<small v-if="v.accent"> · {{ v.accent }}</small></b>
          <span>{{ v.language }} · {{ v.engine }} · {{ speed(v) }}</span>
        </div>
        <span class="vs-tag" :class="v.cloud ? 'cloud' : 'local'">{{ v.cloud ? "Cloud · " + v.cost : "Local · free" }}</span>
        <span v-if="current === v.id" class="vs-use on">In use</span>
        <button v-else-if="canUse" type="button" class="vs-use" :disabled="v.cloud && !d?.cloudEnabled" @click="use(v)">{{ v.cloud && !d?.cloudEnabled ? "Cloud off" : "Use this voice" }}</button>
      </li>
    </ul>

    <h2>Open-source voices to try</h2>
    <p class="meta vs-sub">Nothing here is installed by a button yet: open the demo to listen, and ask Lahmacun to install one. Licences and languages are from each model card.</p>
    <ul class="vs-cat">
      <li v-for="e in d?.catalog ?? []" :key="e.id" class="card vs-c">
        <div class="vs-ct"><b>{{ e.name }}</b><span v-if="e.installed" class="vs-tag local">Installed</span></div>
        <div class="vs-chipline">
          <span class="vs-pill" :class="'tr-' + e.turkish.replace('/', '')">{{ TR[e.turkish] }}</span>
          <span class="vs-pill">{{ e.kind === "tts" ? "Text to speech" : "Voice conversion" }}</span>
          <span class="vs-pill">{{ e.cloning ? "Clones voices" : "No cloning" }}</span>
        </div>
        <p class="vs-n">{{ e.note }}</p>
        <dl class="vs-dl"><dt>Languages</dt><dd>{{ e.languages }}</dd><dt>Licence</dt><dd>{{ e.license }}</dd><dt>Size</dt><dd>{{ e.size }}</dd></dl>
        <div class="vs-links">
          <a :href="e.repo" target="_blank" rel="noopener noreferrer">Repo / model card</a>
          <a :href="e.demo" target="_blank" rel="noopener noreferrer">Demo &amp; samples</a>
          <button v-if="!e.installed" type="button" @click="copyAsk(e)">{{ copied === e.id ? "Copied. Paste it to Lahmacun" : "Ask Lahmacun to install" }}</button>
        </div>
      </li>
    </ul>
  </main>
</template>

<style scoped>
.vs{max-width:1100px}
.vs .ph{flex-direction:column;align-items:flex-start;gap:4px}
.vs h2{margin-top:22px}
.vs-sub{margin:-4px 2px 12px}
.vs-chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
.vs-list{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,420px),1fr));gap:8px}
.vs-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;grid-template-areas:"p t tag" "p t use";gap:2px 12px;align-items:center}
.vs-row.on{border-color:var(--on)}
.vs-play{grid-area:p;width:40px;height:40px;border-radius:50%;border:1px solid var(--line);background:var(--panel-2);color:var(--ink);display:grid;place-items:center;cursor:pointer}
.vs-play:hover:not(:disabled){background:var(--ink);color:var(--bg)}
.vs-play:disabled{opacity:.45;cursor:default}
.vs-play.live{background:var(--ink);color:var(--bg)}
.vs-play.busy{animation:vs-pulse 1s infinite}
@keyframes vs-pulse{50%{opacity:.4}}
.vs-t{grid-area:t;min-width:0;display:flex;flex-direction:column}
.vs-t b{font:600 14px var(--body)}
.vs-t b small{font-weight:500;color:var(--muted);font-size:12px}
.vs-t span{font-size:12px;color:var(--muted)}
.vs-tag{grid-area:tag;justify-self:end;font:600 11px var(--body);padding:3px 8px;border-radius:999px;white-space:nowrap}
.vs-tag.local{color:var(--on);background:var(--on-bg)}
.vs-tag.cloud{color:var(--warn);background:var(--warn-bg)}
.vs-use{grid-area:use;justify-self:end;font:600 12px var(--body);padding:5px 10px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer}
.vs-use:disabled{opacity:.5;cursor:default}
.vs-use.on{border-color:transparent;color:var(--on);background:none;cursor:default;padding-right:0}
.vs-cat{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,320px),1fr));gap:10px}
.vs-c{display:flex;flex-direction:column;gap:8px}
.vs-ct{display:flex;justify-content:space-between;gap:8px;align-items:center}
.vs-ct b{font:700 15px var(--body)}
.vs-chipline{display:flex;flex-wrap:wrap;gap:6px}
.vs-pill{font:600 11px var(--body);padding:3px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.vs-pill.tr-yes{color:var(--on);background:var(--on-bg);border-color:transparent}
.vs-pill.tr-no{color:var(--bad);background:var(--bad-bg);border-color:transparent}
.vs-pill.tr-community{color:var(--warn);background:var(--warn-bg);border-color:transparent}
.vs-n{margin:0;font-size:13px;line-height:1.45}
.vs-dl{margin:0;display:grid;grid-template-columns:auto minmax(0,1fr);gap:3px 10px;font-size:12px}
.vs-dl dt{color:var(--muted)}
.vs-dl dd{margin:0;overflow-wrap:anywhere}
.vs-links{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:auto;padding-top:4px;font-size:12.5px;align-items:center}
.vs-links a{color:var(--ink);text-decoration:underline;text-underline-offset:3px}
.vs-links button{font:600 12px var(--body);padding:5px 10px;border-radius:8px;border:1px solid var(--line);background:var(--panel-2);color:var(--ink);cursor:pointer}
@media(max-width:520px){.vs-row{grid-template-columns:auto minmax(0,1fr);grid-template-areas:"p t" "p tag" "use use"}.vs-tag,.vs-use{justify-self:start}.vs-use{grid-column:2}}
</style>
