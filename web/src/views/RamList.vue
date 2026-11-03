<script setup lang="ts">
// The Ram tab's main view: every running thing that holds RAM as one row, biggest first. Bundles (Docker, Claude Code,
// apps, macOS, panel apps) expand on tap into what they are made of. Rows update in place and keep their order through jitter.
import { ref, computed } from "vue";
import { S, mb, type RamRow, type RamKid } from "../store";
import type { IconName } from "../icons";
import Icon from "../components/Icon.vue";
import RamIcon from "./RamIcon.vue";
import { keepOrder } from "./ramStable";

const props = defineProps<{ rows: RamRow[] }>();

// ---- order: kept through jitter, for the rows and for the kids of every row ----
const rowSt = { order: [] as string[], at: 0 };
const kidSt = new Map<string, { order: string[]; at: number }>();
const rows = computed(() => keepOrder(rowSt, props.rows, (r) => r.key, (r) => r.mb));
function kids(r: RamRow): RamKid[] {
  let st = kidSt.get(r.key); if (!st) kidSt.set(r.key, (st = { order: [], at: 0 }));
  return keepOrder(st, r.kids, (k) => k.key, (k) => k.mb);
}
const max = computed(() => Math.max(1, ...props.rows.map((r) => r.mb)));

// ---- icons ----
const iconUrl = (name: string) => `/api/v1/ram/icon?name=${encodeURIComponent(name)}`;
const squash = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, "");
const appIcon = (n: string | null | undefined) => (n ? (S.apps[n] ?? Object.values(S.apps).find((x) => squash(x.name) === squash(n)))?.icon || null : null);
const CLAUDE_ICON = "/icons/installed/proc/Claude%20Code.png";
const GLYPH: Record<RamRow["kind"], IconName> = { vm: "boxes", docker: "boxes", panel: "blocks", claude: "bot", app: "layers", proc: "cpu", macos: "laptop", small: "layers" };
function rowIcon(r: RamRow) {
  if (r.src) return r.src;
  if (r.icon) return iconUrl(r.name);
  if (r.kind === "claude") return CLAUDE_ICON;
  return appIcon(r.name);
}
/** Kids that are processes of one program show no icon (it would repeat the parent's 20 times). */
const procKids = (r: RamRow) => r.kind === "app" || r.kind === "proc" || r.kind === "panel";
function kidIcon(r: RamRow, k: RamKid) {
  if (k.src) return k.src;
  // group kids are keyed by their group name ("g:Finder", "h:Docker"); the shown name can differ ("Docker Desktop")
  if (k.icon) return iconUrl(/^[gh]:/.test(k.key) ? k.key.slice(2) : k.name);
  if (r.kind === "claude") return CLAUDE_ICON;
  if (r.kind === "docker") return k.key === "c:-vm" ? iconUrl("Docker") : appIcon(k.app);
  return appIcon(k.name);
}
const kidGlyph = (r: RamRow, k: RamKid): IconName => (r.kind === "docker" ? "boxes" : k.key === "wired" ? "cpu" : r.kind === "claude" ? "bot" : "cpu");

// ---- expand ----
const open = ref<Set<string>>(new Set());
const canOpen = (r: RamRow) => r.kids.length > 0;
function toggle(r: RamRow) { if (!canOpen(r)) return; const s = new Set(open.value); s.has(r.key) ? s.delete(r.key) : s.add(r.key); open.value = s; }
const pct = (v: number, of: number) => Math.min(100, (v / Math.max(1, of)) * 100) + "%";
</script>

<template>
  <ul class="rl" aria-label="Programs by memory, biggest first">
    <TransitionGroup name="rl">
      <li v-for="r in rows" :key="r.key" class="rl-i" :class="{ 'rl-on': open.has(r.key), leaf: !canOpen(r) }">
        <component :is="canOpen(r) ? 'button' : r.href ? 'a' : 'div'" class="rl-row" :type="canOpen(r) ? 'button' : undefined" :href="!canOpen(r) ? r.href : undefined"
          :aria-expanded="canOpen(r) ? open.has(r.key) : undefined" :aria-controls="canOpen(r) ? 'rl-k-' + r.key : undefined" @click="toggle(r)">
          <RamIcon class="rl-ic" :name="r.name" :src="rowIcon(r)" :glyph="GLYPH[r.kind]" />
          <span class="rl-t"><b>{{ r.name }}</b><small v-if="r.sub">{{ r.sub }}</small></span>
          <span class="rl-v num">{{ mb(r.mb) }}</span>
          <span class="rl-chev" aria-hidden="true"><Icon v-if="canOpen(r)" name="chevron-down" :size="16" /><Icon v-else-if="r.href" name="arrow-up-right" :size="14" /></span>
          <span class="rl-bar" aria-hidden="true"><i :style="{ width: pct(r.mb, max) }"></i></span>
        </component>
        <div v-if="canOpen(r)" :id="'rl-k-' + r.key" class="rl-x" :class="{ on: open.has(r.key) }" :inert="!open.has(r.key)"><div>
          <ul class="rl-kids" :class="{ procs: procKids(r) }">
            <li v-for="k in kids(r)" :key="k.key">
              <RamIcon v-if="!procKids(r)" class="rl-kic" :name="k.app ?? k.name" :src="kidIcon(r, k)" :glyph="kidGlyph(r, k)" />
              <span class="rl-t"><b>{{ k.name }}</b><small v-if="k.sub">{{ k.sub }}</small></span>
              <span class="rl-v num">{{ mb(k.mb) }}</span>
              <span class="rl-bar" aria-hidden="true"><i :style="{ width: pct(k.mb, r.mb) }"></i></span>
            </li>
            <li v-if="r.more" class="rl-more">+ {{ r.more.n }} more · {{ mb(r.more.mb) }}</li>
          </ul>
          <a v-if="r.href" class="rl-lnk" :href="r.href">Open in Apps <Icon name="arrow-up-right" :size="13" /></a>
        </div></div>
      </li>
    </TransitionGroup>
  </ul>
</template>

<style scoped>
.rl { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.rl-i { border-top: 1px solid color-mix(in srgb, var(--line) 70%, transparent); }
.rl-i:first-child { border-top: 0; }
.rl-row {
  width: 100%; display: grid; grid-template-columns: 34px minmax(0, 1fr) auto 18px; grid-template-rows: auto 4px; column-gap: 12px; row-gap: 7px; align-items: center;
  padding: 11px 4px 10px; background: none; border: 0; color: inherit; text-align: left; font: inherit; text-decoration: none; cursor: default; min-height: 60px;
  -webkit-tap-highlight-color: transparent; border-radius: 12px; transition: background .2s;
}
button.rl-row, a.rl-row { cursor: pointer; }
button.rl-row:hover, a.rl-row:hover { background: color-mix(in srgb, var(--ink) 5%, transparent); }
button.rl-row:active { background: color-mix(in srgb, var(--ink) 9%, transparent); }
.rl-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.rl-ic { grid-row: 1 / 3; align-self: center; width: 34px; height: 34px; }
.rl-ic :deep(.ico), .rl-ic :deep(.gen) { width: 34px; height: 34px; border-radius: 9px; }
.rl-ic :deep(.ico img) { width: 24px; height: 24px; }
.rl-ic :deep(.ico.own img) { width: 34px; height: 34px; }
.rl-t { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.rl-t b { font: 600 14.5px/1.25 var(--body); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rl-t small { font: 400 12px/1.3 var(--body); color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rl-v { font: 700 14px var(--mono); text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.rl-chev { color: var(--muted); display: grid; place-items: center; transition: transform .28s cubic-bezier(.2, .8, .2, 1); }
.rl-on .rl-chev { transform: rotate(180deg); }
.rl-bar { grid-column: 2 / 4; height: 4px; border-radius: 2px; background: color-mix(in srgb, var(--muted) 16%, transparent); overflow: hidden; }
.rl-bar i { display: block; height: 100%; border-radius: 2px; background: color-mix(in srgb, var(--accent) 70%, var(--muted)); transition: width .45s cubic-bezier(.2, .8, .2, 1); }
.rl-x { display: grid; grid-template-rows: 0fr; transition: grid-template-rows .32s cubic-bezier(.2, .8, .2, 1); }
.rl-x.on { grid-template-rows: 1fr; }
.rl-x > div { overflow: hidden; min-height: 0; opacity: 0; transition: opacity .25s; }
.rl-x.on > div { opacity: 1; }
.rl-kids { list-style: none; margin: 0 0 8px 46px; padding: 2px 0 0 12px; border-left: 2px solid color-mix(in srgb, var(--accent) 35%, transparent); display: flex; flex-direction: column; gap: 2px; }
.rl-kids > li { display: grid; grid-template-columns: 26px minmax(0, 1fr) auto; grid-template-rows: auto 3px; column-gap: 10px; row-gap: 5px; align-items: center; padding: 6px 4px 6px 0; }
.rl-kids.procs > li { grid-template-columns: minmax(0, 1fr) auto; }
.rl-kids .rl-kic { grid-row: 1 / 3; width: 26px; height: 26px; }
.rl-kids .rl-kic :deep(.ico), .rl-kids .rl-kic :deep(.gen) { width: 26px; height: 26px; border-radius: 7px; }
.rl-kids .rl-kic :deep(.ico img) { width: 18px; height: 18px; }
.rl-kids .rl-kic :deep(.ico.own img) { width: 26px; height: 26px; }
.rl-kids .rl-t b { font-size: 13px; font-weight: 600; }
.rl-kids .rl-t small { font-size: 11.5px; }
.rl-kids .rl-v { font-size: 12.5px; font-weight: 600; }
.rl-kids .rl-bar { grid-column: 2 / 4; height: 3px; }
.rl-kids.procs .rl-bar { grid-column: 1 / 3; }
.rl-kids .rl-bar i { background: color-mix(in srgb, var(--accent) 45%, var(--muted)); }
.rl-more { display: block !important; color: var(--muted); font: 500 12px var(--body); padding: 6px 0 2px !important; }
.rl-lnk { display: inline-flex; align-items: center; gap: 4px; margin: 0 0 12px 58px; color: var(--accent); font: 600 12.5px var(--body); text-decoration: none; min-height: 32px; }
.rl-move { transition: transform .4s cubic-bezier(.2, .8, .2, 1); }
.rl-enter-active { transition: opacity .3s; }
.rl-enter-from { opacity: 0; }
@media (min-width: 900px) {
  .rl-row { grid-template-columns: 34px minmax(160px, 1fr) minmax(120px, 1.4fr) 84px 18px; grid-template-rows: auto; row-gap: 0; min-height: 56px; padding: 9px 8px; }
  .rl-ic { grid-row: 1; }
  .rl-row .rl-bar { grid-column: 3; grid-row: 1; height: 6px; border-radius: 3px; }
  .rl-row .rl-v { grid-column: 4; grid-row: 1; }
  .rl-row .rl-chev { grid-column: 5; grid-row: 1; }
  .rl-kids { margin-left: 54px; }
}
@media (prefers-reduced-motion: reduce) { .rl-x, .rl-x > div, .rl-chev, .rl-bar i, .rl-move, .rl-enter-active, .rl-row { transition: none; } }
</style>
