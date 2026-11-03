<script setup lang="ts">
// Web findings: the pages the assistant searched or read for this answer (from its WebSearch / WebFetch steps) and any
// it listed in a ```sources block. A scrolling row of cards on a phone, a grid on wide screens; the first few show,
// the rest behind "+N more".
import { ref, computed } from "vue";
import { favicon, type WebSource } from "../../chat/blocks";

const p = withDefaults(defineProps<{ sources: WebSource[]; query?: string | null; compact?: boolean }>(), { query: null, compact: false });
const all = ref(false);
const shown = computed(() => (all.value ? p.sources : p.sources.slice(0, 4)));
const broken = ref(new Set<string>());
const letter = (d: string) => (d.replace(/^www\./, "")[0] ?? "?").toUpperCase();
</script>

<template>
  <section class="vc-src" :class="{ compact }" aria-label="Sources">
    <header class="vc-src-h">
      <span><b>Sources</b> · {{ sources.length }}</span>
      <span v-if="query" class="vc-src-q" :title="query">from “{{ query }}”</span>
    </header>
    <ul class="vc-src-l">
      <li v-for="s in shown" :key="s.url">
        <a class="vc-src-c" :href="s.url" target="_blank" rel="noopener noreferrer" :title="s.title">
          <span class="vc-src-d">
            <img v-if="!broken.has(s.domain)" :src="favicon(s.domain)" alt="" width="16" height="16" loading="lazy" referrerpolicy="no-referrer" @error="broken = new Set([...broken, s.domain])" />
            <i v-else aria-hidden="true">{{ letter(s.domain) }}</i>
            {{ s.domain }}
          </span>
          <b class="vc-src-t">{{ s.title }}</b>
          <span v-if="s.snippet" class="vc-src-s">{{ s.snippet }}</span>
        </a>
      </li>
      <li v-if="sources.length > 4 && !all"><button type="button" class="vc-src-c vc-src-more" @click="all = true">+{{ sources.length - 4 }} more</button></li>
    </ul>
  </section>
</template>

<style scoped>
.vc-src{display:flex;flex-direction:column;gap:7px;min-width:0}
.vc-src-h{display:flex;align-items:baseline;gap:8px;font-size:12px;color:var(--muted);min-width:0}
.vc-src-h>span:first-child{flex:none;white-space:nowrap}
.vc-src-h b{color:#c7c7cc;font-weight:600}
.vc-src-q{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-style:italic}
.vc-src-l{list-style:none;margin:0;padding:0 0 2px;display:grid;grid-auto-flow:column;grid-auto-columns:minmax(200px,72%);gap:8px;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;overscroll-behavior-x:contain}
.vc-src-l::-webkit-scrollbar{display:none}
@media(min-width:700px){.vc-src-l{grid-auto-flow:row;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));grid-auto-columns:auto;overflow:visible}}
.vc-src-l li{scroll-snap-align:start;min-width:0;display:flex}
.vc-src-c{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;padding:10px 11px;border-radius:12px;border:1px solid var(--line);background:#131316;color:var(--ink);text-decoration:none;transition:border-color .15s var(--ease),background .15s var(--ease)}
.vc-src-c:hover{border-color:#3a3a40;background:#17171b}
.vc-src-c:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.vc-src-d{display:flex;align-items:center;gap:6px;font:500 11.5px var(--mono);color:var(--muted);min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vc-src-d img{width:16px;height:16px;border-radius:4px;flex:none;background:#fff1}
.vc-src-d i{flex:none;width:16px;height:16px;border-radius:4px;display:grid;place-items:center;font:700 10px var(--body);font-style:normal;background:#26262b;color:#c7c7cc}
.vc-src-t{font:600 13px/1.3 var(--body);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.vc-src-s{font-size:12px;line-height:1.35;color:#a5a5ac;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.vc-src-more{align-items:center;justify-content:center;font:600 13px var(--body);color:var(--muted);cursor:pointer;min-height:64px}
.compact .vc-src-l{grid-auto-columns:minmax(180px,60%)}
</style>
