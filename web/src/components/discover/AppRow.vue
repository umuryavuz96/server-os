<script setup lang="ts">
// A catalog app as a chart row (rank, logo, name, one meta line) with Get / Open, like a store's top charts.
import AppIcon from "../AppIcon.vue";
import LifeAction from "./LifeAction.vue";
import { LIFE_LABEL, TIER, stars, tierOf, type Item, type Life } from "./types";

defineProps<{ item: Item; rank?: number; running?: string | null; life?: Life | null; pending?: boolean }>();
defineEmits<{ open: [Item] }>();
</script>

<template>
  <div class="arow">
    <span v-if="rank" class="rk2">{{ rank }}</span>
    <button type="button" class="a-main" @click="$emit('open', item)">
      <AppIcon :name="item.name" :icon="item.logo ?? ''" />
      <span class="a-n">
        <b>{{ item.name }}</b>
        <small>{{ item.why || item.sub || item.category }}</small>
        <span class="a-m"><i :class="`h-${item.health ?? 'unknown'}`"></i>{{ life ? LIFE_LABEL[life.state] : running != null ? "Installed" : TIER[tierOf(item)].label }}<template v-if="item.stars"> · ★ {{ stars(item.stars) }}</template></span>
      </span>
    </button>
    <LifeAction :item="item" :life="life" :running="running" :pending="pending" @get="$emit('open', item)" @open="$emit('open', item)" />
  </div>
</template>

<style scoped>
.arow { display: flex; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid #1a1a1e; min-width: 0 }
.rk2 { width: 22px; flex: 0 0 auto; font: 700 20px var(--display); color: #6c6c74; text-align: center }
.a-main { display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0; background: none; border: 0; color: var(--ink); text-align: left; padding: 0; cursor: pointer; font: inherit }
.a-main:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; border-radius: 8px }
.a-n { display: flex; flex-direction: column; min-width: 0 }
.a-n b { font-size: 15px }
.a-n small { color: var(--muted); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
.a-m { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted) }
</style>
