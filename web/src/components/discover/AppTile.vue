<script setup lang="ts">
// A catalog app as a grid card: logo, name, shelf, install tier, one line of what it does, health · stars · replaces.
import AppIcon from "../AppIcon.vue";
import { BUSY, HEALTH, LIFE_LABEL, TIER, stars, tierOf, type Item, type Life } from "./types";

defineProps<{ item: Item; running?: string | null; life?: Life | null; pending?: boolean }>();
defineEmits<{ open: [Item] }>();
</script>

<template>
  <button type="button" class="tile2" :class="{ dim: item.archived }" @click="$emit('open', item)">
    <div class="t-h">
      <AppIcon :name="item.name" :icon="item.logo ?? ''" />
      <div class="t-n">
        <b>{{ item.name }}</b>
        <small>{{ item.sub || item.category }}</small>
      </div>
    </div>
    <p class="t-d">{{ item.why || item.description }}</p>
    <div class="t-m">
      <span v-if="pending || (life && BUSY.includes(life.state))" class="tier t-busy"><i class="dot-pulse"></i>{{ pending && !life ? "STARTING" : LIFE_LABEL[life!.state].toUpperCase() }}<template v-if="life?.checklist.length"> {{ life.checklist.filter((c) => c.state === "done" || c.state === "skipped").length }}/{{ life.checklist.length }}</template></span>
      <span v-else-if="life?.state === 'failed' || life?.state === 'setup-failed'" class="tier t-fail">{{ LIFE_LABEL[life.state].toUpperCase() }}</span>
      <span v-else-if="life?.state === 'ready'" class="tier t-ready">READY ✓</span>
      <span v-else-if="life || (running !== undefined && running !== null)" class="tier t-run">INSTALLED</span>
      <span v-else class="tier" :class="`t-${tierOf(item)}`" :title="TIER[tierOf(item)].hint">{{ TIER[tierOf(item)].label.toUpperCase() }}</span>
      <span class="hl"><i :class="`h-${item.health ?? 'unknown'}`"></i>{{ HEALTH[item.health ?? "unknown"] }}</span>
      <span v-if="item.stars" class="mono">★ {{ stars(item.stars) }}</span>
      <span v-if="item.replaces?.length" class="rep">Instead of {{ item.replaces[0] }}</span>
    </div>
  </button>
</template>

<style scoped>
.tile2 { display: flex; flex-direction: column; gap: 10px; padding: 16px; border-radius: 16px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); cursor: pointer; text-align: left; min-width: 0; font: inherit; transition: border-color .2s, transform .2s }
.tile2:hover { border-color: #4a4a50; transform: translateY(-1px) }
.tile2:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px }
.tile2.dim { opacity: .55 }
.t-h { display: flex; gap: 12px; align-items: center; min-width: 0 }
.t-n { display: flex; flex-direction: column; min-width: 0; flex: 1 }
.t-n b { font-size: 15.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
.t-n small { color: var(--muted); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
.t-d { margin: 0; color: #c9c9ce; font-size: 13.5px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden }
.t-m { display: flex; gap: 10px; align-items: center; font-size: 12px; color: var(--muted); flex-wrap: wrap }
.mono { font-family: var(--mono) }
.rep { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100% }
</style>
