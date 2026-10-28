<script setup lang="ts">
// A Lucide icon by name (web/src/icons.ts). Decorative unless a label is given; other attributes (fill, class) fall
// through to the <svg>, so a filled play button is <Icon name="play" fill="currentColor" />.
import { ICONS, type IconName } from "../icons";

withDefaults(defineProps<{ name: IconName; size?: number; label?: string }>(), { size: 18 });
</script>

<template>
  <component :is="ICONS[name]" :size="size" :stroke-width="1.8" :aria-hidden="label ? undefined : true" :aria-label="label" :role="label ? 'img' : undefined" class="icon" />
</template>

<style scoped>
.icon{flex:none}
</style>
