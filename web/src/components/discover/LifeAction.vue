<script setup lang="ts">
// The one action button for an app, driven by its lifecycle: Get → Installing… → Setting up… → Open,
// with Retry / Finish setup when something failed. Every screen uses it, so they never disagree.
import { computed } from "vue";
import { BUSY, LIFE_LABEL, type Item, type Life } from "./types";

const props = defineProps<{ item: Item; life?: Life | null; running?: string | null; pending?: boolean; size?: "s" | "m" | "l" | "xl"; label?: string }>();
const emit = defineEmits<{ get: [Item]; open: [Item] }>();
const busy = computed(() => props.pending || (props.life && BUSY.includes(props.life.state)));
const href = computed(() => props.life?.href || props.running || "");
const kind = computed(() => {
  if (busy.value) return "busy";
  const s = props.life?.state;
  if (s === "failed") return "retry";
  if (s === "setup-failed") return "fix";
  if (s === "ready" || s === "installed" || props.running !== undefined && props.running !== null) return href.value ? "open" : "on";
  return "get";
});
const text = computed(() => {
  if (props.pending && !props.life) return "Starting…";
  if (busy.value) return `${props.life!.agent && props.life!.state === "installing" ? "Agent installing" : LIFE_LABEL[props.life!.state]}…`;
  return { retry: "Retry", fix: "Finish setup", open: "Open", on: "Installed", get: props.label ?? "Get" }[kind.value as "retry"];
});
</script>

<template>
  <a v-if="kind === 'open'" class="la" :class="[size ?? 's', 'k-open']" :href="href" target="_blank" rel="noopener" :aria-label="`Open ${item.name}`" @click.stop>{{ text }}</a>
  <button v-else type="button" class="la" :class="[size ?? 's', `k-${kind}`]" :disabled="kind === 'busy' || kind === 'on'" :aria-busy="kind === 'busy'"
    :aria-label="`${text} ${item.name}`" @click.stop="kind === 'fix' ? emit('open', item) : emit('get', item)">
    <span v-if="kind === 'busy'" class="spin" aria-hidden="true"></span>{{ text }}
  </button>
</template>

<style scoped>
.la { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; gap: 8px; border: 0; border-radius: 999px; font: 700 13px var(--body); cursor: pointer; text-decoration: none; white-space: nowrap; height: 32px; min-width: 64px; padding: 0 14px; background: var(--ink); color: var(--bg) }
.la.m { height: 40px; border-radius: 10px; font-size: 14px; padding: 0 16px }
.la.l { height: 44px; padding: 0 24px; font-size: 15px }
.la.xl { height: 52px; width: 100%; border-radius: 14px; font-size: 16px }
.k-open, .k-on { background: #232327; color: var(--ink) }
.k-on { cursor: default; opacity: .7 }
.k-busy { background: #1d1d22; color: #c9c9ce; cursor: progress }
.k-retry { background: rgba(255,122,122,.16); color: #ffb3b3 }
.k-fix { background: rgba(245,181,68,.16); color: #f5c76a }
.la:disabled { cursor: default }
.la:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px }
.spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: sp .8s linear infinite }
@keyframes sp { to { transform: rotate(360deg) } }
@media (prefers-reduced-motion: reduce) { .spin { animation-duration: 2.4s } }
</style>
