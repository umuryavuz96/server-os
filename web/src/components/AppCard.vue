<script setup lang="ts">
// One app as a home-screen card (glass desktop's Apps page, 2026-10-31, the user: "a grid of apps, each app its own card,
// like a tablet page"). The card opens the app's drawer like a table row does; the switch flips it (after the same
// confirm dialog as the drawer's rocker) and "Open" goes to its web page.
import { ref, computed } from "vue";
import AppIcon from "./AppIcon.vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import { memText, memHow, type AppState } from "../store";
import { appIsOn, switchSteps, toggleApp } from "../composables/appSwitch";

const props = defineProps<{ app: AppState; status: [string, string] }>();
defineEmits<{ open: [] }>();
const confirming = ref(false), busy = ref(false);
const lock = computed(() => props.app.kind === "lock");
const isOn = computed(() => appIsOn(props.app));
const steps = computed(() => switchSteps(props.app));
async function apply() {
  confirming.value = false; busy.value = true;
  await toggleApp(props.app.name, !isOn.value);
  busy.value = false;
}
</script>

<template>
  <article class="at" :class="{ dim: !isOn }" tabindex="0" role="button" :aria-label="`${app.name} details`" @click="$emit('open')" @keydown.enter.self="$emit('open')">
    <div class="at-top">
      <span class="at-ic"><AppIcon :name="app.name" :icon="app.icon" /></span>
      <button v-if="!lock" type="button" class="at-sw" role="switch" :aria-checked="isOn" :class="{ busy }" :disabled="busy"
        :aria-label="`${isOn ? 'Stop' : 'Start'} ${app.name}`" :title="isOn ? 'Switch off' : 'Switch on'" @click.stop="confirming = true"><i></i></button>
      <span v-else class="at-lock" title="Core service: always on">core</span>
    </div>
    <div class="at-name">
      <b>{{ app.name }}</b>
      <small>{{ app.group }}</small>
    </div>
    <div class="at-foot">
      <span class="pill" :class="status[0]">{{ status[1] }}</span>
      <span class="at-mem num" :title="memHow(app)">{{ memText(app) === "—" ? "" : memText(app) }}</span>
      <a v-if="app.href && isOn" class="at-open" :href="app.href" target="_blank" rel="noopener" :aria-label="`Open ${app.name}`" title="Open" @click.stop>↗</a>
    </div>
    <ConfirmDialog :open="confirming" :title="`${isOn ? 'Stop' : 'Start'} ${app.name}?`" :subtitle="app.group"
      :confirm-label="isOn ? 'Stop' : 'Start'" :danger="isOn" @confirm="apply" @cancel="confirming = false">
      <template #icon><AppIcon :name="app.name" :icon="app.icon" /></template>
      <div v-if="isOn && app.warn" class="warnbox">Core service. {{ app.about }}</div>
      <ul>
        <li v-for="s in steps" :key="s">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></svg>{{ s }}
        </li>
      </ul>
    </ConfirmDialog>
  </article>
</template>

<style scoped>
.at{position:relative;display:flex;flex-direction:column;gap:10px;height:168px;padding:16px;border-radius:22px;cursor:pointer;min-width:0;outline:none}
.at:focus-visible{box-shadow:0 0 0 2px rgba(255,255,255,.7)}
.at-top{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.at-ic{display:grid;place-items:center;width:52px;height:52px;border-radius:15px;background:rgba(255,255,255,.10);box-shadow:inset 0 1px 0 rgba(255,255,255,.18)}
.at-ic > *{transform:scale(1.18)}
.at-name{display:flex;flex-direction:column;gap:2px;min-width:0;margin-top:auto}
.at-name b{font:700 15px var(--body);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.at-name small{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.at-foot{display:flex;align-items:center;gap:8px;min-height:24px}
.at-mem{font:600 12px var(--mono);color:var(--muted);margin-left:auto;white-space:nowrap}
.at-open{display:grid;place-items:center;width:26px;height:26px;border-radius:50%;background:rgba(255,255,255,.12);color:var(--ink);text-decoration:none;font-size:13px;flex:none}
.at-open:hover{background:#fff;color:#1d1712}
.at.dim .at-ic,.at.dim .at-name{opacity:.62}
/* iOS-style switch: green when the app is on */
.at-sw{position:relative;flex:none;width:44px;height:26px;padding:0;border-radius:999px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.14);cursor:pointer;transition:background .2s var(--ease)}
.at-sw i{position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 2px 6px rgba(0,0,0,.3);transition:translate .22s var(--spring,ease)}
.at-sw[aria-checked="true"]{background:#22c55e;border-color:transparent}
.at-sw[aria-checked="true"] i{translate:18px 0}
.at-sw.busy{opacity:.55;cursor:progress}
.at-lock{font:700 10px var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--muted);padding:4px 8px;border-radius:999px;background:rgba(255,255,255,.08)}
@media (max-width:700px){.at{height:150px;padding:13px;border-radius:18px}.at-ic{width:44px;height:44px;border-radius:13px}.at-ic > *{transform:none}.at-mem{display:none}}
@media (prefers-reduced-motion:reduce){.at-sw i,.at-sw{transition:none}}
</style>
