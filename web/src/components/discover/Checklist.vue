<script setup lang="ts">
// The install journey as a checklist the owner can follow: the installer's steps, then the agent's own
// (it plans them with plan_steps and ticks them with check_step), grouped, with a short note per step.
import { computed } from "vue";
import type { Check } from "./types";

const props = defineProps<{ items: Check[]; compact?: boolean }>();
const groups = computed(() => {
  const out: { name: string; items: Check[] }[] = [];
  for (const c of props.items) {
    const g = c.group ?? "";
    if (!out.length || out.at(-1)!.name !== g) out.push({ name: g, items: [] });
    out.at(-1)!.items.push(c);
  }
  return out;
});
const done = computed(() => props.items.filter((c) => c.state === "done" || c.state === "skipped").length);
</script>

<template>
  <div class="cl" :class="{ compact }">
    <div class="cl-bar" role="progressbar" :aria-valuenow="done" :aria-valuemin="0" :aria-valuemax="items.length" :aria-label="`${done} of ${items.length} steps done`">
      <i :style="{ width: `${items.length ? (done / items.length) * 100 : 0}%` }"></i>
    </div>
    <div v-for="g in groups" :key="g.name" class="cl-g">
      <small v-if="g.name && groups.length > 1" class="cl-gn">{{ g.name }}</small>
      <ol>
        <li v-for="c in g.items" :key="c.label" :class="`s-${c.state}`">
          <span class="mk" aria-hidden="true">
            <svg v-if="c.state === 'done'" viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7" /></svg>
            <svg v-else-if="c.state === 'failed'" viewBox="0 0 16 16"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
            <svg v-else-if="c.state === 'skipped'" viewBox="0 0 16 16"><path d="M4 8h8" /></svg>
            <i v-else-if="c.state === 'doing'" class="spin"></i>
          </span>
          <span class="tx">
            <span class="lb">{{ c.label }}<span class="sr">, {{ c.state === "doing" ? "in progress" : c.state }}</span></span>
            <small v-if="c.note && !compact">{{ c.note }}</small>
          </span>
        </li>
      </ol>
    </div>
  </div>
</template>

<style scoped>
.cl { display: flex; flex-direction: column; gap: 10px }
.cl-bar { height: 4px; border-radius: 2px; background: #232327; overflow: hidden }
.cl-bar i { display: block; height: 100%; background: #3ecf8e; transition: width .4s }
.cl-g { display: flex; flex-direction: column; gap: 6px }
.cl-gn { color: var(--muted); font: 600 11px var(--mono); letter-spacing: .8px; text-transform: uppercase }
ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px }
li { display: flex; gap: 10px; align-items: flex-start; font-size: 14px; color: var(--muted) }
.mk { width: 20px; height: 20px; flex: 0 0 auto; border-radius: 50%; border: 1.5px solid #3a3a40; display: grid; place-items: center; margin-top: 1px }
.mk svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round }
.s-done .mk { background: #3ecf8e; border-color: #3ecf8e; color: #04140c }
.s-failed .mk { background: #ff7a7a; border-color: #ff7a7a; color: #1a0505 }
.s-skipped .mk { color: var(--muted) }
.s-doing .mk { border-color: var(--ink) }
.s-done, .s-doing, .s-failed { color: var(--ink) }
.s-doing .lb { font-weight: 700 }
.s-skipped .lb { text-decoration: line-through; text-decoration-color: #55555c }
.tx { display: flex; flex-direction: column; min-width: 0 }
.tx small { color: var(--muted); font-size: 12.5px }
.s-failed .tx small { color: #ffb3b3 }
.spin { width: 10px; height: 10px; border-radius: 50%; border: 2px solid var(--ink); border-right-color: transparent; animation: sp .8s linear infinite }
@keyframes sp { to { transform: rotate(360deg) } }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0) }
.compact li { font-size: 13px }
</style>
