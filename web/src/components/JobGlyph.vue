<script setup lang="ts">
// The icon for one entry on a job ID card: the real app icon from the Apps tab, a brand logo, a Lucide icon or a letter tile.
import { ref, computed, watch } from "vue";
import AppIcon from "./AppIcon.vue";
import Icon from "./Icon.vue";
import { appList } from "../store";
import { resolveGlyph, type Glyph } from "../jobIcons";
import type { IconName } from "../icons";

const props = withDefaults(defineProps<{ label?: string; hint?: string; glyph?: Glyph; size?: number; fallback?: IconName }>(), { size: 32, fallback: "package" });
const g = computed<Glyph>(() => props.glyph ?? resolveGlyph(props.label ?? "", appList.value, props.hint));
const broken = ref(false);
watch(g, () => { broken.value = false; });
</script>

<template>
  <span class="jc-g" :style="{ '--s': size + 'px' }">
    <AppIcon v-if="g.kind === 'app'" :name="g.app.name" :icon="g.app.icon" />
    <span v-else-if="g.kind === 'brand' && !broken" class="jc-g-b"><img :src="g.url" alt="" loading="lazy" @error="broken = true" /></span>
    <span v-else-if="g.kind === 'lucide'" class="jc-g-l"><Icon :name="g.icon" :size="Math.round(size * 0.56)" /></span>
    <span v-else-if="g.kind === 'brand'" class="jc-g-l"><Icon :name="fallback" :size="Math.round(size * 0.56)" /></span>
    <AppIcon v-else :name="label || '?'" icon="" />
  </span>
</template>
