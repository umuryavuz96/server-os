<script setup lang="ts">
// The glass desktop's chrome (2026-10-30, the user: "dock on the left like the reel; everything floats in the air"):
// a wallpaper, a floating glass dock on the left (bottom on a phone) with hover magnification, a menu bar of floating
// pills on top, and a launcher with every page. The page content itself is App.vue's; style.css turns its cards to glass.
import { computed, onMounted, onUnmounted, ref } from "vue";
import Icon from "../components/Icon.vue";
import type { IconName } from "../icons";
import { look } from "./prefs";
import { canFullscreen, isFull, standalone, toggleFullscreen } from "./fullscreen";

export interface DockItem { id: string; label: string; icon: IconName; badge?: string | number; bad?: boolean }
const props = defineProps<{
  page: string; dock: DockItem[]; all: DockItem[]; serverName: string; initials: string; connected: boolean;
  alerts: number; failing: number; botsLive: number; now: number;
}>();

const current = computed(() => props.all.find((i) => i.id === props.page) ?? props.dock[0]);
const QUICK = ["overview", "apps", "jobs", "alerts"];
// a phone's bottom dock keeps five pages (plus the open one); the launcher has the rest
const PHONE = new Set(["overview", "apps", "jobs", "alerts", "voice"]);
const quick = computed(() => QUICK.map((id) => props.all.find((i) => i.id === id)).filter((x): x is DockItem => !!x));
const clock = computed(() => new Date(props.now).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }));
const day = computed(() => new Date(props.now).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }));

// Magnification: each icon grows with the pointer's distance along the dock (vertical on a desktop, horizontal on a phone).
const dockEl = ref<HTMLElement | null>(null);
const reduce = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
let raf = 0, pending: PointerEvent | null = null;
function magnify(e: PointerEvent) {
  if (e.pointerType !== "mouse" || reduce?.matches) return;
  pending = e;
  if (!raf) raf = requestAnimationFrame(() => {
    raf = 0; const ev = pending; if (!ev || !dockEl.value) return;
    const vertical = dockEl.value.clientHeight > dockEl.value.clientWidth;
    for (const el of dockEl.value.querySelectorAll<HTMLElement>(".dock-i")) {
      const r = el.getBoundingClientRect();
      const d = vertical ? Math.abs(ev.clientY - (r.top + r.height / 2)) : Math.abs(ev.clientX - (r.left + r.width / 2));
      el.style.setProperty("--m", String(1 + 0.22 * Math.max(0, 1 - d / 90) ** 1.6));
    }
  });
}
function unmagnify() { pending = null; dockEl.value?.querySelectorAll<HTMLElement>(".dock-i").forEach((el) => el.style.setProperty("--m", "1")); }

// Wallpaper parallax: the picture drifts a few pixels against the pointer, so the glass on top reads as a layer above it.
const wall = ref<HTMLElement | null>(null);
let praf = 0;
function parallax(e: PointerEvent) {
  if (reduce?.matches || !look.motion || praf) return;
  const x = e.clientX / innerWidth - 0.5, y = e.clientY / innerHeight - 0.5;
  praf = requestAnimationFrame(() => { praf = 0; wall.value?.style.setProperty("--px", `${(-x * 18).toFixed(1)}px`); wall.value?.style.setProperty("--py", `${(-y * 12).toFixed(1)}px`); });
}

const launcher = ref(false);
function key(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  if (e.key === "Escape" && launcher.value) { launcher.value = false; return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if ((e.key === "f" || e.key === "F") && canFullscreen) { e.preventDefault(); void toggleFullscreen(); }
}
onMounted(() => { addEventListener("keydown", key); addEventListener("pointermove", parallax, { passive: true }); });
onUnmounted(() => { removeEventListener("keydown", key); removeEventListener("pointermove", parallax); cancelAnimationFrame(raf); cancelAnimationFrame(praf); });
</script>

<template>
  <div class="desk-wall" :class="'wp-' + look.wallpaper" aria-hidden="true"><div ref="wall" class="desk-wall-i"></div></div>

  <header class="mbar" aria-label="Menu bar">
    <div class="mgrp">
      <button type="button" class="glass mround" :aria-expanded="launcher" aria-label="All pages" title="All pages" @click="launcher = !launcher"><Icon name="grip" :size="15" /></button>
      <button type="button" class="glass mround" title="Classic layout" aria-label="Switch to the classic layout" @click="look.layout = 'classic'"><Icon name="layout-dashboard" :size="15" /></button>
    </div>
    <nav class="mgrp mmid" aria-label="Quick pages">
      <a v-for="q in quick" :key="q.id" :href="'#' + q.id" class="glass mq" :aria-current="page === q.id ? 'page' : undefined"><Icon :name="q.icon" :size="14" />{{ q.label }}</a>
    </nav>
    <div class="mgrp">
      <a href="#alerts" class="glass mround" :class="{ hot: alerts }" :title="alerts ? `${alerts} new alert${alerts === 1 ? '' : 's'}` : 'Alerts'"><Icon name="bell" :size="15" /><i v-if="alerts">{{ alerts }}</i></a>
      <a href="#jobs" class="glass mround" :class="{ hot: failing }" :title="failing ? `${failing} failing job${failing === 1 ? '' : 's'}` : 'Jobs'"><Icon name="clock" :size="15" /><i v-if="failing">{{ failing }}</i></a>
      <a href="#bots" class="glass mround" :title="`${botsLive} bots live`"><Icon name="bot" :size="15" /><i class="ok" v-if="botsLive">{{ botsLive }}</i></a>
      <button v-if="canFullscreen && !standalone" type="button" class="glass mround" :title="isFull ? 'Exit full screen (F)' : 'Full screen (F)'" :aria-label="isFull ? 'Exit full screen' : 'Full screen'" :aria-pressed="isFull" @click="toggleFullscreen"><Icon :name="isFull ? 'minimize' : 'maximize'" :size="15" /></button>
      <span class="glass mclock" :title="day"><span class="mday">{{ day }}</span>{{ clock }}</span>
      <span class="mavatar" :title="connected ? `${serverName} · live` : 'Reconnecting…'" :aria-label="connected ? `${serverName}, live` : 'Reconnecting'" role="img">{{ initials }}<span class="mdot" :class="{ off: !connected }"></span></span>
    </div>
  </header>

  <nav ref="dockEl" class="glass dock" aria-label="Dock" @pointermove="magnify" @pointerleave="unmagnify">
    <a v-for="it in dock" :key="it.id" :href="'#' + it.id" class="dock-i" :class="{ extra: !PHONE.has(it.id) && page !== it.id }" :aria-current="page === it.id ? 'page' : undefined" :aria-label="it.label">
      <span class="dock-ic"><Icon :name="it.icon" :size="16" /><i v-if="it.badge" class="dock-b" :class="{ bad: it.bad }">{{ it.badge }}</i></span>
      <span class="dock-tip" role="tooltip">{{ it.label }}</span>
    </a>
    <span class="dock-sep" aria-hidden="true"></span>
    <button type="button" class="dock-i" :aria-expanded="launcher" aria-label="All pages" @click="launcher = !launcher">
      <span class="dock-ic"><Icon name="grip" :size="16" /></span>
      <span class="dock-tip" role="tooltip">All pages</span>
    </button>
  </nav>

  <Transition name="lp">
    <div v-if="launcher" class="lp-wrap" @click.self="launcher = false">
      <div class="glass lp" role="dialog" aria-label="All pages">
        <a v-for="it in all" :key="it.id" :href="'#' + it.id" class="lp-i" :aria-current="page === it.id ? 'page' : undefined" @click="launcher = false">
          <span class="lp-ic"><Icon :name="it.icon" :size="24" /><i v-if="it.badge" class="dock-b" :class="{ bad: it.bad }">{{ it.badge }}</i></span>
          <span>{{ it.label }}</span>
        </a>
      </div>
    </div>
  </Transition>
</template>
