<script setup lang="ts">
// Routing tab of the Agent network page: the current usage mode, every tunable of var/config/model-routing.json as a form
// (the same file ~/scripts/lib/pick-model.sh reads), and the recent decisions it logged. Save checks every value on the
// server, backs the file up and writes it atomically; the 90% reserve cannot be set lower.
import { ref, computed, onMounted, watch } from "vue";
import { S, api, ago, toast } from "../store";
import Icon from "../components/Icon.vue";

interface Field { path: string; group: string; label: string; hint?: string; type: "int" | "float" | "bool" | "enum" | "string[]" | "bands"; value: any; min?: number; max?: number; options?: string[]; locked?: string }
interface Band { max_score: number | null; model: string; effort: string }
interface Win { key: string; pct: number; resetsAt: number | null; hours: number }
interface Mode { mode: "normal" | "careful" | "eco" | "reserve"; usagePct: number; windows: Win[]; pace: string | null; source: string; override: boolean; thresholds: { careful: number; eco: number; reserve: number } }
interface Decision { ts: string; agent: string; job: string; mode: string; usage: number | null; model: string; effort: string; score: number | null; reason: string; status: string; warnings: string[] }
interface Res { fields: Field[]; mode: Mode; decisions: Decision[]; backups: string[]; error: string | null }

const data = ref<Res | null>(null), draft = ref<Record<string, any>>({}), err = ref(""), saving = ref(false), shut = ref(new Set<string>());
const MODELS = ["haiku", "sonnet", "opus", "fable"], EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const groups = computed(() => { const m = new Map<string, Field[]>(); for (const f of data.value?.fields ?? []) (m.get(f.group) ?? m.set(f.group, []).get(f.group)!).push(f); return [...m.entries()]; });
const cur = (f: Field) => (f.path in draft.value ? draft.value[f.path] : f.value);
const dirty = computed(() => Object.keys(draft.value).filter((p) => JSON.stringify(draft.value[p]) !== JSON.stringify(data.value?.fields.find((f) => f.path === p)?.value)));
function set(f: Field, v: any) { err.value = ""; draft.value = { ...draft.value, [f.path]: v }; }
function bump(f: Field, d: number) { const step = f.type === "float" ? 0.05 : 1; const v = Math.round((Number(cur(f)) + d * step) * 100) / 100; set(f, Math.min(f.max ?? Infinity, Math.max(f.min ?? -Infinity, v))); }
function typed(f: Field, e: Event) { const n = Number((e.target as HTMLInputElement).value); if (Number.isFinite(n)) set(f, f.type === "int" ? Math.round(n) : n); }
const toggle = (g: string) => { const s = new Set(shut.value); s.has(g) ? s.delete(g) : s.add(g); shut.value = s; };
const word = ref<Record<string, string>>({});
function addWord(f: Field) { const w = (word.value[f.path] ?? "").trim().toLowerCase(); if (!w) return; const l = cur(f) as string[]; if (!l.includes(w)) set(f, [...l, w]); word.value = { ...word.value, [f.path]: "" }; }
const bands = (f: Field) => cur(f) as Band[];
function setBand(f: Field, i: number, k: keyof Band, v: any) { const l = bands(f).map((b, j) => (j === i ? { ...b, [k]: v } : b)); set(f, l); }
function addBand(f: Field) { const l = [...bands(f)]; const last = l.pop()!; const prev = l.length ? (l[l.length - 1].max_score ?? 0) : 0; set(f, [...l, { max_score: prev + 2, model: last.model, effort: last.effort }, last]); }
function dropBand(f: Field, i: number) { const l = bands(f); if (l.length > 1 && i < l.length - 1) set(f, l.filter((_, j) => j !== i)); }

async function load() { try { data.value = await api<Res>("/agent-routing"); } catch (e) { err.value = (e as Error).message; } }
async function save() {
  if (!dirty.value.length || saving.value) return; saving.value = true; err.value = "";
  try { data.value = await api<Res>("/agent-routing", { method: "PUT", body: { changes: Object.fromEntries(dirty.value.map((p) => [p, draft.value[p]])) } }); draft.value = {}; toast("Routing saved"); }
  catch (e) { err.value = (e as Error).message; } finally { saving.value = false; }
}
const discard = () => { draft.value = {}; err.value = ""; };
onMounted(load);
watch(() => S.claudeUsage?.fetchedAt, load);
const when = (ts: string) => ago(Date.parse(ts) / 1000);
const MODE_NOTE: Record<string, string> = { normal: "Full rubric: every agent gets the model its score says.", careful: "One effort level lower; Fable falls back to Opus unless asked for.", eco: "Builders max Sonnet, light roles Haiku, one team of at most three agents.", reserve: "No new heavy work. Chat and light checks only." };
</script>

<template>
  <section class="ar" aria-label="Model routing">
    <p v-if="data?.error" class="ar-err" role="alert">{{ data.error }}</p>
    <div v-if="data" class="ar-mode" :class="data.mode.mode">
      <div class="ar-mh">
        <span class="ar-dot"></span><b class="ar-mn">{{ data.mode.mode }}</b>
        <span class="ar-mp num">{{ Math.round(data.mode.usagePct) }}% used</span>
        <span v-if="data.mode.override" class="ar-tag">reserve override on</span>
      </div>
      <p class="ar-note">{{ MODE_NOTE[data.mode.mode] }}<template v-if="data.mode.pace"> Raised one step because {{ data.mode.pace }}.</template></p>
      <div class="ar-track" role="img" :aria-label="`Usage ${Math.round(data.mode.usagePct)} percent; careful from ${data.mode.thresholds.careful}, eco from ${data.mode.thresholds.eco}, reserve from ${data.mode.thresholds.reserve}`">
        <i class="ar-fill" :style="{ width: Math.min(100, data.mode.usagePct) + '%' }"></i>
        <span v-for="(t, k) in data.mode.thresholds" :key="k" class="ar-mark" :style="{ left: t + '%' }"><em>{{ t }}</em></span>
      </div>
      <p class="ar-src num">Careful from {{ data.mode.thresholds.careful }}% · eco from {{ data.mode.thresholds.eco }}% · reserve from {{ data.mode.thresholds.reserve }}%<br />{{ data.mode.windows.map((w) => `${w.key === "seven_day" ? "week" : "5 h"} ${Math.round(w.pct)}%`).join(" · ") || "no fresh usage reading" }} · source {{ data.mode.source }}</p>
    </div>

    <div v-for="[g, list] in groups" :key="g" class="ar-grp" :class="{ shut: shut.has(g) }">
      <button type="button" class="ar-gh" :aria-expanded="!shut.has(g)" @click="toggle(g)"><h2>{{ g }}</h2><Icon name="chevron-down" :size="14" class="ar-chev" /></button>
      <div class="ar-gb"><div class="ar-gi">
        <div v-for="f in list" :key="f.path" class="ar-row" :class="{ changed: dirty.includes(f.path), wide: f.type === 'bands' || f.type === 'string[]' }">
          <div class="ar-l"><label :for="'f-' + f.path" class="ar-lt">{{ f.label }}</label><p v-if="f.hint" class="ar-h">{{ f.hint }}</p><p v-if="f.locked" class="ar-lock"><Icon name="lock" :size="11" /> {{ f.locked }}</p></div>
          <div class="ar-c">
            <div v-if="f.type === 'int' || f.type === 'float'" class="ar-step">
              <button type="button" aria-label="Less" :disabled="f.min !== undefined && cur(f) <= f.min" @click="bump(f, -1)">−</button>
              <input :id="'f-' + f.path" type="number" inputmode="decimal" :min="f.min" :max="f.max" :step="f.type === 'float' ? 0.05 : 1" :value="cur(f)" @change="typed(f, $event)" />
              <button type="button" aria-label="More" :disabled="f.max !== undefined && cur(f) >= f.max" @click="bump(f, 1)">+</button>
            </div>
            <button v-else-if="f.type === 'bool'" :id="'f-' + f.path" type="button" class="sw" role="switch" :aria-checked="!!cur(f)" :aria-label="f.label" @click="set(f, !cur(f))"></button>
            <div v-else-if="f.type === 'enum'" class="ar-seg" role="radiogroup" :aria-label="f.label"><button v-for="o in f.options" :key="o" type="button" role="radio" :aria-checked="cur(f) === o" @click="set(f, o)">{{ o.replace("_", " ") }}</button></div>
            <div v-else-if="f.type === 'string[]'" class="ar-chips">
              <span v-for="w in cur(f)" :key="w" class="ar-chip">{{ w }}<button type="button" :aria-label="`Remove ${w}`" @click="set(f, cur(f).filter((x: string) => x !== w))">×</button></span>
              <input :id="'f-' + f.path" v-model="word[f.path]" placeholder="add a word" maxlength="40" @keydown.enter.prevent="addWord(f)" @blur="addWord(f)" />
            </div>
            <div v-else-if="f.type === 'bands'" class="ar-bands">
              <div v-for="(b, i) in bands(f)" :key="i" class="ar-band">
                <span class="ar-bl">{{ b.max_score === null ? "above" : "score ≤" }}</span>
                <input v-if="b.max_score !== null" type="number" :aria-label="`Band ${i + 1} score limit`" :value="b.max_score" @change="setBand(f, i, 'max_score', Number(($event.target as HTMLInputElement).value))" />
                <span v-else class="ar-inf num">{{ bands(f)[i - 1]?.max_score ?? 0 }}</span>
                <div class="ar-seg sm" role="radiogroup" :aria-label="`Band ${i + 1} model`"><button v-for="m in MODELS" :key="m" type="button" role="radio" :aria-checked="b.model === m" @click="setBand(f, i, 'model', m)">{{ m }}</button></div>
                <div class="ar-seg sm" role="radiogroup" :aria-label="`Band ${i + 1} effort`"><button v-for="e in EFFORTS" :key="e" type="button" role="radio" :aria-checked="b.effort === e" @click="setBand(f, i, 'effort', e)">{{ e }}</button></div>
                <button type="button" class="ar-x" :disabled="i === bands(f).length - 1 || bands(f).length < 2" :aria-label="`Remove band ${i + 1}`" @click="dropBand(f, i)">×</button>
              </div>
              <button type="button" class="ar-add" :disabled="bands(f).length >= 8" @click="addBand(f)">+ Add band</button>
            </div>
          </div>
        </div>
      </div></div>
    </div>

    <div v-if="data" class="ar-grp">
      <button type="button" class="ar-gh" disabled><h2>Recent decisions</h2></button>
      <div class="ar-dec" role="table" aria-label="Recent routing decisions">
        <p v-if="!data.decisions.length" class="ar-h">Nothing logged yet.</p>
        <div v-for="d in data.decisions" :key="d.ts + d.agent" class="ar-d" role="row" :class="{ bad: d.status !== 'ok' }">
          <span class="ar-dt num">{{ when(d.ts) }}</span>
          <span class="ar-da"><b>{{ d.agent || "—" }}</b><small v-if="d.job">{{ d.job }}</small></span>
          <span class="ar-dm"><span class="ar-pill">{{ d.model }}</span><span class="ar-pill dim">{{ d.effort }}</span><span class="num ar-ds">score {{ d.score ?? "—" }}</span><span class="ar-pill" :class="d.mode">{{ d.mode }}</span></span>
          <span class="ar-dr" :title="d.reason">{{ d.reason }}</span>
        </div>
      </div>
    </div>

    <Transition name="ar-bar">
      <div v-if="dirty.length || err" class="ar-save" role="region" aria-label="Unsaved changes">
        <span class="ar-sm" :class="{ bad: err }">{{ err || `${dirty.length} change${dirty.length > 1 ? "s" : ""} not saved` }}</span>
        <button type="button" class="ar-b" :disabled="saving" @click="discard">Discard</button>
        <button type="button" class="ar-b go" :disabled="saving || !dirty.length" @click="save">{{ saving ? "Saving…" : "Save" }}</button>
      </div>
    </Transition>
  </section>
</template>

<style scoped>
.ar{display:flex;flex-direction:column;gap:12px;padding-bottom:24px}
.ar-err,.bad{color:var(--warn)}
.ar-mode{--mc:var(--ac);padding:14px 16px;border-radius:14px;border:1px solid var(--hair);background:var(--soft);display:flex;flex-direction:column;gap:8px}
.ar-mode.careful{--mc:#e8c547}.ar-mode.eco{--mc:#f08a3c}.ar-mode.reserve{--mc:#ef5b5b}
.ar-mh{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ar-dot{width:10px;height:10px;border-radius:50%;background:var(--mc);box-shadow:0 0 0 4px color-mix(in srgb,var(--mc) 22%,transparent)}
.ar-mn{font:700 18px var(--body);text-transform:capitalize}.ar-mp{color:var(--muted);font:500 13px var(--body)}
.ar-tag{font:500 11px var(--mono);padding:2px 8px;border-radius:999px;border:1px solid var(--hair);color:var(--muted)}
.ar-note{margin:0;color:rgba(255,255,255,.8);font:400 13px/1.45 var(--body)}
.ar-track{position:relative;height:8px;border-radius:4px;background:rgba(255,255,255,.1);margin:14px 0 22px}
.ar-fill{position:absolute;left:0;top:0;bottom:0;border-radius:4px;background:var(--mc);transition:width .4s cubic-bezier(.2,.8,.2,1)}
.ar-mark{position:absolute;top:-3px;bottom:-3px;width:2px;background:rgba(255,255,255,.55)}
.ar-mark em{position:absolute;top:100%;left:50%;transform:translateX(-50%);margin-top:3px;font:500 10.5px var(--body);color:var(--muted);font-style:normal;white-space:nowrap}
.ar-src{margin:0;color:var(--muted);font:400 12px var(--body)}
.ar-grp{border:1px solid var(--hair);border-radius:14px;background:var(--soft)}
.ar-gh{display:flex;align-items:center;justify-content:space-between;width:100%;min-height:46px;padding:0 16px;background:none;border:0;color:var(--ink);cursor:pointer}
.ar-gh:disabled{cursor:default}
.ar-gh h2{margin:0;font:600 13px var(--body);letter-spacing:.01em}
.ar-chev{color:var(--muted);transition:transform .22s}.ar-grp.shut .ar-chev{transform:rotate(-90deg)}
.ar-gb{display:grid;grid-template-rows:1fr;transition:grid-template-rows .26s cubic-bezier(.2,.8,.2,1)}
.ar-grp.shut .ar-gb{grid-template-rows:0fr}
.ar-gi{overflow:hidden;min-height:0;padding:0 16px}
.ar-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:11px 0;border-top:1px solid var(--hair)}
.ar-row.wide{flex-direction:column;align-items:stretch;gap:8px}
.ar-row.changed .ar-lt::after{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--hook);margin-left:8px;vertical-align:middle}
.ar-l{min-width:0;flex:1}.ar-lt{font:500 13px var(--body);text-transform:capitalize}
.ar-h{margin:2px 0 0;color:var(--muted);font:400 12px/1.4 var(--body)}
.ar-lock{margin:3px 0 0;color:var(--hook);font:400 11.5px var(--body);display:flex;align-items:center;gap:5px}
.ar-c{flex:none;max-width:100%}.ar-row.wide .ar-c{flex:1}
.ar-step{display:inline-flex;align-items:center;border:1px solid var(--hair);border-radius:10px;overflow:hidden}
.ar-step button{width:36px;height:36px;border:0;background:rgba(255,255,255,.05);color:var(--ink);font:600 16px var(--body);cursor:pointer}
.ar-step button:disabled{opacity:.3;cursor:default}
.ar-step input,.ar-band input{width:58px;height:36px;border:0;background:none;color:var(--ink);text-align:center;font:600 14px var(--body);-moz-appearance:textfield;appearance:textfield}
.ar-step input::-webkit-outer-spin-button,.ar-step input::-webkit-inner-spin-button,.ar-band input::-webkit-outer-spin-button,.ar-band input::-webkit-inner-spin-button{-webkit-appearance:none}
.ar-seg{display:inline-flex;flex-wrap:wrap;gap:2px;padding:2px;border-radius:10px;background:rgba(255,255,255,.06)}
.ar-seg button{min-height:32px;padding:0 11px;border:0;border-radius:8px;background:none;color:var(--muted);font:600 12.5px var(--body);cursor:pointer;transition:background .15s,color .15s}
.ar-seg button[aria-checked="true"]{background:rgba(255,255,255,.16);color:var(--ink)}
.ar-seg.sm button{min-height:28px;padding:0 8px;font-size:11.5px}
.ar-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.ar-chip{display:inline-flex;align-items:center;gap:4px;padding:3px 4px 3px 10px;border-radius:999px;background:rgba(255,255,255,.08);font:500 12px var(--body)}
.ar-chip button{width:20px;height:20px;border:0;border-radius:50%;background:none;color:var(--muted);cursor:pointer;font-size:14px}
.ar-chips input{height:30px;min-width:110px;padding:0 10px;border-radius:999px;border:1px dashed var(--hair);background:none;color:var(--ink);font:400 12px var(--body)}
.ar-bands{display:flex;flex-direction:column;gap:8px}
.ar-band{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px;border-radius:10px;background:rgba(255,255,255,.04)}
.ar-bl{width:52px;color:var(--muted);font:400 12px var(--body)}.ar-band input{width:48px;border:1px solid var(--hair);border-radius:8px;height:30px}.ar-inf{width:48px;text-align:center;color:var(--muted)}
.ar-x,.ar-add{border:1px solid var(--hair);background:none;color:var(--muted);border-radius:8px;min-height:30px;padding:0 10px;cursor:pointer;font:500 12px var(--body)}
.ar-x:disabled,.ar-add:disabled{opacity:.3;cursor:default}.ar-add{align-self:flex-start}
.ar-dec{padding:0 16px 8px}
.ar-d{display:grid;grid-template-columns:78px minmax(120px,1.1fr) auto minmax(0,2fr);gap:12px;align-items:start;padding:9px 0;border-top:1px solid var(--hair);font:400 12.5px var(--body)}
.ar-dt{color:var(--muted);white-space:nowrap}.ar-da{display:flex;flex-direction:column;min-width:0}.ar-da small{color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ar-dm{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.ar-ds{color:var(--muted)}
.ar-pill{padding:2px 8px;border-radius:999px;background:rgba(255,255,255,.1);font:600 11px var(--mono)}.ar-pill.dim{background:rgba(255,255,255,.05);color:var(--muted)}
.ar-pill.careful{color:#e8c547}.ar-pill.eco{color:#f08a3c}.ar-pill.reserve{color:#ef5b5b}
.ar-dr{color:var(--muted);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}
.ar-save{position:sticky;bottom:0;margin-top:auto;display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:12px;background:rgba(20,20,23,.97);border:1px solid rgba(255,255,255,.18);box-shadow:0 -10px 30px rgba(0,0,0,.4);z-index:2}
.ar-sm{flex:1;font:500 13px var(--body)}
.ar-b{min-height:36px;padding:0 14px;border-radius:9px;border:1px solid var(--hair);background:none;color:var(--ink);font:600 13px var(--body);cursor:pointer}
.ar-b.go{background:var(--ink);color:var(--bg);border-color:var(--ink)}.ar-b:disabled{opacity:.5;cursor:default}
.ar-bar-enter-active,.ar-bar-leave-active{transition:transform .25s cubic-bezier(.2,.8,.2,1),opacity .2s}
.ar-bar-enter-from,.ar-bar-leave-to{transform:translateY(16px);opacity:0}
@media (max-width:700px){.ar-d{grid-template-columns:52px 1fr}.ar-dm,.ar-dr{grid-column:1/-1}.ar-row:not(.wide){flex-wrap:wrap}}
@media (prefers-reduced-motion:reduce){.ar-gb,.ar-fill,.ar-bar-enter-active,.ar-bar-leave-active,.ar-chev{transition:none}}
</style>
