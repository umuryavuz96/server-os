<script setup lang="ts">
// Needs-attention stack. Every alert is one absolutely positioned card; collapsed they pile up behind the worst one
// (same height, offset edges), expanded they slide into a list. Top / sides / height / content all transition,
// so "Show all" and "Collapse" are one continuous animation. Heights are measured with a ResizeObserver.
import { ref, computed, reactive, onMounted, onUnmounted } from "vue";
import { lamps } from "../composables/lamps";

const props = defineProps<{ startOpen?: boolean }>();
const open = ref(!!props.startOpen); // desktop side panel has room: start expanded
const items = computed(() => lamps.value.filter((l) => l.level !== "g").sort((a, b) => (a.level === "r" ? 0 : 1) - (b.level === "r" ? 0 : 1)));
const TITLE: Record<string, string> = { DISK: "Internal disk", JOBS: "Scheduled jobs", SWAP: "Swap", CPU: "CPU", APPS: "Apps down", HOME: "Home Assistant", DNS: "DNS", NET: "Internet", BOTS: "Bots", ALERTS: "Alerts" };
const GAP = 10, PEEK = 8, INSET = 10, MAXPEEK = 2;

const heights = reactive<Record<string, number>>({});
const inner = new Map<string, HTMLElement>();
let ro: ResizeObserver | null = null;
const setRef = (id: string) => (el: unknown) => {
  const node = el as HTMLElement | null;
  const prev = inner.get(id);
  if (prev && prev !== node) ro?.unobserve(prev);
  if (node) { inner.set(id, node); ro?.observe(node); heights[id] = node.offsetHeight; } else inner.delete(id);
};
onMounted(() => {
  ro = new ResizeObserver((es) => { for (const e of es) for (const [id, n] of inner) if (n === e.target) heights[id] = (e.target as HTMLElement).offsetHeight; });
  for (const n of inner.values()) ro.observe(n);
});
onUnmounted(() => ro?.disconnect());

const layout = computed(() => {
  const list = items.value, h0 = heights[list[0]?.id] ?? 64;
  let y = 0;
  const pos = list.map((l, i) => {
    const h = heights[l.id] ?? 64;
    if (open.value) { const p = { top: y, inset: 0, h, opacity: 1, content: 1, z: 20 - i }; y += h + GAP; return p; }
    const k = Math.min(i, MAXPEEK + 1); // beyond the visible peeks everything hides behind the last edge
    return { top: k * PEEK, inset: k * INSET, h: i === 0 ? h0 : h0, opacity: i === 0 ? 1 : i > MAXPEEK ? 0 : 1 - i * 0.3, content: i === 0 ? 1 : 0, z: 20 - i };
  });
  const height = open.value ? Math.max(0, y - GAP) : h0 + Math.min(list.length - 1, MAXPEEK) * PEEK;
  return { pos, height };
});
</script>

<template>
  <section class="astack-wrap" aria-label="Needs attention">
    <div class="ch">
      <h3>Needs attention <span v-if="items.length" class="acount">{{ items.length }}</span></h3>
      <button v-if="items.length > 1" type="button" class="linkbtn" :aria-expanded="open" @click="open = !open">{{ open ? "Collapse" : "Show all" }}</button>
    </div>
    <p v-if="!items.length" class="hint">All {{ lamps.length }} checks green.</p>
    <div v-else class="astack2" :style="{ height: layout.height + 'px' }">
      <div v-for="(l, i) in items" :key="l.id" class="acard" :class="'l-' + l.level"
        :style="{ top: layout.pos[i].top + 'px', left: layout.pos[i].inset + 'px', right: layout.pos[i].inset + 'px', height: layout.pos[i].h + 'px', opacity: layout.pos[i].opacity, zIndex: layout.pos[i].z }"
        :aria-hidden="!open && i > 0">
        <div :ref="setRef(l.id)" class="ainner" :style="{ opacity: layout.pos[i].content }">
          <span class="aicon" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg></span>
          <div class="atext"><b>{{ TITLE[l.id] ?? l.id }}</b><span>{{ l.text }}</span></div>
          <a v-if="l.link" :href="l.link[0]" class="aact" :tabindex="!open && i > 0 ? -1 : 0">{{ l.link[1].replace("Open ", "") }} →</a>
        </div>
      </div>
    </div>
  </section>
</template>
