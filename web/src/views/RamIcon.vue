<script setup lang="ts">
// One small icon for a Ram row: the app's own icon (panel app, macOS bundle, Claude) or a neutral glyph for plain binaries.
import AppIcon from "../components/AppIcon.vue";
import Icon from "../components/Icon.vue";
import type { IconName } from "../icons";
withDefaults(defineProps<{ name: string; src?: string | null; glyph?: IconName }>(), { glyph: "cpu" });
</script>

<template>
  <span class="ri" aria-hidden="true">
    <AppIcon v-if="src" :name="name" :icon="src" />
    <span v-else class="gen"><Icon :name="glyph" :size="15" /></span>
  </span>
</template>

<style scoped>
.ri { flex: none; width: 28px; height: 28px; display: inline-grid; place-items: center; }
.ri :deep(.ico) { width: 28px; height: 28px; border-radius: 8px; font-size: 12px; }
.ri :deep(.ico img) { width: 20px; height: 20px; }
.ri :deep(.ico.own img) { width: 28px; height: 28px; }
.gen { width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; background: var(--bg); border: 1px solid var(--line); color: var(--muted); }
</style>
