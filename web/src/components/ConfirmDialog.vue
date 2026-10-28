<script setup lang="ts">
// Modal confirm: centered card on desktop, bottom sheet on phones. Esc / backdrop cancel; focus lands on the main action.
import { watch, nextTick, ref, onUnmounted } from "vue";

const props = defineProps<{ open: boolean; title: string; subtitle?: string; confirmLabel: string; danger?: boolean }>();
const emit = defineEmits<{ confirm: []; cancel: [] }>();
const primary = ref<HTMLButtonElement | null>(null);
let lastFocus: HTMLElement | null = null;

const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") emit("cancel"); };
watch(() => props.open, async (o) => {
  if (o) { lastFocus = document.activeElement as HTMLElement; addEventListener("keydown", onKey); await nextTick(); primary.value?.focus(); }
  else { removeEventListener("keydown", onKey); lastFocus?.focus?.(); }
});
onUnmounted(() => removeEventListener("keydown", onKey));
</script>

<template>
  <Teleport to="body">
    <Transition name="dlg">
      <div v-if="open" class="dlg-wrap">
        <div class="dlg-bg" @click="emit('cancel')"></div>
        <div class="dlg" :class="{ danger }" role="alertdialog" aria-modal="true" :aria-label="title">
          <div class="dlg-head">
            <slot name="icon" />
            <div style="min-width: 0">
              <h2>{{ title }}</h2>
              <div v-if="subtitle" class="sub">{{ subtitle }}</div>
            </div>
          </div>
          <slot />
          <div class="dlg-actions">
            <button type="button" @click="emit('cancel')">Cancel</button>
            <button ref="primary" type="button" class="primary" :class="{ danger }" @click="emit('confirm')">{{ confirmLabel }}</button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
