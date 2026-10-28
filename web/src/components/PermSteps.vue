<script setup lang="ts">
// The "how to grant" card for one permission: numbered steps, each with a mock visual. `compact` is the strip under the
// Mac screen while a Fix session is open. The wording follows what the last Fix did (P.outcome): a popup is up, macOS had
// nothing to ask, or only the Settings switch is left. Shows a green tick as soon as the permission flips to granted.
import { computed, ref } from "vue";
import { guideFor } from "../permGuide";
import { P, openSettings, type Perm } from "../permissions";
import PermVisual from "./PermVisual.vue";

const props = defineProps<{ perm: Perm; compact?: boolean }>();
const outcome = computed(() => P.outcome[props.perm.id] ?? "");
const guide = computed(() => guideFor(props.perm, outcome.value));
const on = computed(() => props.perm.status === "granted");
const already = computed(() => outcome.value === "granted");
const done = computed(() => on.value || already.value);
const copied = ref("");
async function copy(t: string) { try { await navigator.clipboard.writeText(t); copied.value = t; setTimeout(() => (copied.value = ""), 1500); } catch { /* plain http: the path is selectable */ } }
const lead = computed(() => outcome.value === "prompt" ? "Click Allow on the Mac screen" : outcome.value === "pane" ? "Settings is open: switch it on there" : "");
const waiting = computed(() => P.fixing?.id === props.perm.id && !done.value);
</script>

<template>
  <section v-if="guide" class="ps" :class="{ compact, done }" :aria-label="`How to grant ${perm.title}`">
    <p v-if="done" class="ps-ok" role="status"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3.2 3.2L13 4.8" /></svg>{{ already ? "Already allowed. macOS has nothing to ask" : `${perm.title} is on` }}</p>
    <template v-else>
      <p v-if="lead" class="ps-lead">{{ lead }}</p>
      <ol class="ps-steps">
        <li v-for="(s, i) in guide.steps" :key="i" class="ps-step" :class="{ opt: s.optional }" :title="compact ? s.title : undefined">
          <PermVisual :kind="s.vis" :name="guide.name" :pane="guide.paneLabel" :lines="s.lines" />
          <div class="ps-txt">
            <h3><span class="ps-n" aria-hidden="true">{{ i + 1 }}</span><span class="ps-t">{{ compact ? s.short : s.title }}</span><span v-if="s.optional && !compact" class="ps-if">if needed</span></h3>
            <p v-if="!compact">{{ s.body }}</p>
            <div v-for="c in (compact ? [] : s.copy)" :key="c" class="ps-copy"><code>{{ c }}</code><button type="button" class="btn" @click="copy(c)">{{ copied === c ? "Copied" : "Copy" }}</button></div>
            <button v-if="s.pane && !compact" type="button" class="btn" @click="openSettings(perm.id, true)">Open Settings</button>
          </div>
        </li>
      </ol>
      <div v-if="compact" class="ps-act">
        <button type="button" class="btn" @click="openSettings(perm.id, true)">Open Settings</button>
        <p v-if="waiting" class="ps-wait" role="status" title="Checking every 2 seconds"><span class="ps-pulse" aria-hidden="true" />Waiting for the switch…</p>
      </div>
      <p v-else-if="waiting" class="ps-wait" role="status"><span class="ps-pulse" aria-hidden="true" />Waiting for the switch, checking every 2 seconds</p>
    </template>
  </section>
</template>

<style scoped>
.ps{width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:12px;background:var(--panel-2);padding:14px;display:flex;flex-direction:column;gap:12px;min-width:0}
.ps-steps{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px}
.ps-step{display:flex;flex-direction:column;gap:8px;min-width:0}
.ps-step.opt .pv{opacity:.82}
.ps-txt{display:flex;flex-direction:column;gap:6px;align-items:flex-start;min-width:0}
.ps-txt h3{margin:0;font:700 13px/1.3 var(--body);text-transform:none;letter-spacing:0;display:flex;gap:7px;align-items:baseline;flex-wrap:wrap}
.ps-txt p{margin:0;font-size:12.5px;line-height:1.45;color:var(--muted)}
.ps-n{display:inline-grid;place-items:center;flex:none;width:18px;height:18px;border-radius:50%;background:var(--ink);color:var(--bg);font:700 11px var(--body)}
.ps-if{font:600 10.5px var(--body);color:var(--muted);border:1px solid var(--line);border-radius:99px;padding:1px 7px}
.ps-copy{display:flex;gap:6px;align-items:center;width:100%;min-width:0}
.ps-copy code{flex:1;min-width:0;overflow-wrap:anywhere;font:11px var(--mono);background:var(--panel);padding:5px 7px;border-radius:6px}
.ps-ok{margin:0;display:flex;align-items:center;gap:8px;color:var(--on);font:700 15px var(--body)}
.ps-ok svg{padding:3px;border-radius:50%;background:var(--on-bg);box-sizing:content-box}
.ps.done{border-color:rgba(47,211,138,.45);background:var(--on-bg)}
.ps-wait{margin:0;display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted)}
.ps-pulse{width:8px;height:8px;border-radius:50%;background:var(--warn);animation:psp 1.4s ease-in-out infinite;flex:none}
@keyframes psp{50%{opacity:.3}}
.ps-lead{margin:0;font:700 14px var(--body);color:var(--ink)}

/* compact: the floating strip under the Mac screen. One row on desktop: heading, step chips, Open Settings + status.
   Two rows on a phone: heading and button, then the chips. Same look as the floating pills. */
.compact{display:grid;grid-template-columns:auto minmax(0,1fr) auto;grid-template-areas:"lead steps act";align-items:center;gap:8px 12px;padding:8px 12px;border-radius:16px;border:1px solid rgba(255,255,255,.08);background:rgba(22,22,25,.86);box-shadow:0 8px 24px rgba(0,0,0,.35);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);text-align:left}
.compact .ps-lead{grid-area:lead;font-size:13.5px;max-width:140px;line-height:1.3}
.compact .ps-steps{grid-area:steps;display:flex;flex-wrap:wrap;gap:8px 10px;justify-content:center;min-width:0}
.compact .ps-step{flex:0 1 auto;flex-direction:row;align-items:center;gap:8px;min-width:0}
.compact .pv{width:72px;height:44px;aspect-ratio:auto;flex:none;border-radius:6px}
.compact .ps-txt{gap:0}
.compact .ps-txt h3{font-size:12px;flex-wrap:nowrap;align-items:center;gap:5px;white-space:nowrap}
.compact .ps-t{overflow:hidden;text-overflow:ellipsis;max-width:112px}
.compact .ps-n{width:16px;height:16px;font-size:10px}
.compact .ps-act{grid-area:act;display:flex;flex-direction:column;align-items:flex-end;gap:4px}
.compact .ps-act .btn{min-height:32px;padding:0 12px;font-size:12px;white-space:nowrap}
.compact .ps-wait{font-size:11.5px;white-space:nowrap}
.compact.done{display:flex;justify-content:center}
.compact:not(:has(.ps-lead)){grid-template-areas:"steps act";grid-template-columns:minmax(0,1fr) auto}
@media (max-width:620px){
  .compact{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"lead act" "steps steps";padding:8px 10px;gap:8px}
  .compact:not(:has(.ps-lead)){grid-template-areas:"act act" "steps steps";grid-template-columns:1fr}
  .compact .ps-lead{max-width:none;font-size:13px}
  .compact .ps-steps{flex-wrap:nowrap;justify-content:space-between;gap:6px}
  .compact .ps-step{flex:1 1 0;flex-direction:column;align-items:stretch;gap:4px}
  .compact .pv{width:100%;height:auto;aspect-ratio:72/44}
  .compact .ps-txt h3{white-space:normal;align-items:flex-start;font-size:10.5px;line-height:1.2}
  .compact .ps-t{max-width:none;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  .compact .ps-n{width:14px;height:14px;font-size:9px}
  .compact .ps-act{flex-direction:row;align-items:center;justify-content:flex-end;flex-wrap:wrap}
}
@media (prefers-reduced-motion:reduce){.ps-pulse{animation:none}}
</style>
