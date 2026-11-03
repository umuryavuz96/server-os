<script setup lang="ts">
// The living-room widgets an answer can carry (web/src/chat/blocks.ts asWidget, docs/voice-chat.md): weather, timer,
// home tiles, now playing, images, steps, stats, a comparison and an agenda. Display only: nothing here acts on a
// device or plays a sound, and the spoken answer stands without it. Sized for the panel; the TV kiosk scales them up.
import { computed, onUnmounted, ref } from "vue";
import type { HomeKind, Widget, WxIcon } from "../../chat/blocks";
import type { IconName } from "../../icons";
import Icon from "../Icon.vue";

const p = defineProps<{ w: Widget; ts?: number }>();
const WX: Record<WxIcon, IconName> = { sun: "sun", partly: "cloud-sun", cloud: "cloud", rain: "cloud-rain", drizzle: "cloud-drizzle", storm: "cloud-lightning", snow: "cloud-snow", fog: "cloud-fog", wind: "wind", night: "moon" };
const HOME: Record<HomeKind, IconName> = { light: "lightbulb", switch: "power", plug: "plug", climate: "thermometer", sensor: "gauge", media: "tv", lock: "lock", cover: "blinds", fan: "fan", scene: "sparkles", door: "door", other: "power" };
const deg = (n: number) => `${Math.round(n)}°`;

// ---------- weather: the day range bars share one scale ----------
const range = computed(() => {
  if (p.w.kind !== "weather" || !p.w.days.length) return null;
  const lo = Math.min(...p.w.days.map((d) => d.low)), hi = Math.max(...p.w.days.map((d) => d.high));
  return { lo, span: Math.max(1, hi - lo) };
});
const bar = (low: number, high: number) => { const r = range.value!; return { left: `${((low - r.lo) / r.span) * 100}%`, width: `${Math.max(4, ((high - low) / r.span) * 100)}%` }; };

// ---------- timer: counts down from when the answer arrived (or to a set time); no alarm sound ----------
const now = ref(Date.now());
let tick: ReturnType<typeof setInterval> | null = null;
if (p.w.kind === "timer" || p.w.kind === "media") tick = setInterval(() => (now.value = Date.now()), 1000);
onUnmounted(() => { if (tick) clearInterval(tick); });
const timer = computed(() => {
  if (p.w.kind !== "timer") return null;
  const start = p.ts ?? now.value;
  const end = p.w.until ? Date.parse(p.w.until) : start + (p.w.seconds ?? 0) * 1000;
  const total = p.w.seconds ? p.w.seconds * 1000 : Math.max(1, end - start);
  const left = Math.max(0, end - now.value);
  if (!left && tick) { clearInterval(tick); tick = null; }
  return { left, done: left === 0, frac: Math.min(1, left / total), end };
});
const clock = (ms: number) => { const s = Math.ceil(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60; return (h ? `${h}:${String(m).padStart(2, "0")}` : String(m)) + ":" + String(r).padStart(2, "0"); };
const R = 52, C = 2 * Math.PI * R;
const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// ---------- media: the position moves on while it plays ----------
const pos = computed(() => {
  if (p.w.kind !== "media" || !p.w.duration) return null;
  const moved = p.w.state === "playing" && p.ts ? (now.value - p.ts) / 1000 : 0;
  const at = Math.min(p.w.duration, (p.w.position ?? 0) + Math.max(0, moved));
  return { at, frac: at / p.w.duration };
});
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const broken = ref(new Set<string>());
</script>

<template>
  <!-- weather -->
  <section v-if="w.kind === 'weather'" class="vw vw-wx" :aria-label="`Weather${w.place ? ' in ' + w.place : ''}`">
    <div v-if="w.now" class="vw-wx-now">
      <Icon :name="WX[w.now.icon]" :size="46" class="vw-wx-big" />
      <span class="vw-wx-t">{{ deg(w.now.temp) }}<small>{{ w.unit }}</small></span>
      <span class="vw-wx-s">
        <b>{{ w.place ?? "Now" }}</b>
        <span v-if="w.now.summary">{{ w.now.summary }}</span>
        <span class="vw-mut">
          <template v-if="w.high !== undefined && w.low !== undefined">H {{ deg(w.high) }} · L {{ deg(w.low) }}</template>
          <template v-if="w.now.feels !== undefined"> · feels {{ deg(w.now.feels) }}</template>
          <template v-if="w.rain !== undefined"> · rain {{ w.rain }}%</template>
          <template v-if="w.wind"> · {{ w.wind }}</template>
        </span>
      </span>
    </div>
    <p v-else-if="w.place" class="vw-h">{{ w.place }}</p>
    <ol v-if="w.hours.length" class="vw-wx-hours">
      <li v-for="(h, i) in w.hours" :key="i"><span class="vw-mut">{{ h.label }}</span><Icon :name="WX[h.icon]" :size="22" /><b>{{ deg(h.temp) }}</b><small v-if="h.rain !== undefined" class="vw-rain">{{ h.rain }}%</small></li>
    </ol>
    <ol v-if="w.days.length" class="vw-wx-days">
      <li v-for="(d, i) in w.days" :key="i">
        <span class="vw-wx-dl">{{ d.label }}</span><Icon :name="WX[d.icon]" :size="20" />
        <small class="vw-rain">{{ d.rain !== undefined ? d.rain + "%" : "" }}</small>
        <span class="vw-mut num">{{ deg(d.low) }}</span>
        <span class="vw-wx-r" aria-hidden="true"><i :style="bar(d.low, d.high)"></i></span>
        <b class="num">{{ deg(d.high) }}</b>
      </li>
    </ol>
  </section>

  <!-- timer -->
  <section v-else-if="w.kind === 'timer' && timer" class="vw vw-timer" :class="{ done: timer.done }" role="timer" :aria-label="w.label ?? 'Timer'">
    <svg viewBox="0 0 120 120" aria-hidden="true">
      <circle cx="60" cy="60" :r="R" class="vw-tr-bg" />
      <circle cx="60" cy="60" :r="R" class="vw-tr-fg" :stroke-dasharray="C" :stroke-dashoffset="C * (1 - timer.frac)" transform="rotate(-90 60 60)" />
    </svg>
    <div class="vw-timer-b">
      <span class="vw-mut">{{ w.label ?? "Timer" }}</span>
      <b class="num">{{ timer.done ? "Done" : clock(timer.left) }}</b>
      <span class="vw-mut">{{ timer.done ? `at ${hhmm(timer.end)}` : `ends ${hhmm(timer.end)}` }}</span>
    </div>
  </section>

  <!-- home tiles: state only, no controls -->
  <section v-else-if="w.kind === 'home'" class="vw vw-home" :aria-label="w.title ?? 'Home'">
    <p v-if="w.title" class="vw-h">{{ w.title }}</p>
    <ul>
      <li v-for="(d, i) in w.items" :key="i" :class="{ on: d.on }">
        <span class="vw-home-i"><Icon :name="HOME[d.type]" :size="20" /></span>
        <span class="vw-home-t"><b>{{ d.name }}</b><span>{{ d.state }}<template v-if="d.area"> · {{ d.area }}</template></span></span>
      </li>
    </ul>
  </section>

  <!-- now playing -->
  <section v-else-if="w.kind === 'media'" class="vw vw-media" aria-label="Now playing">
    <img v-if="w.image && !broken.has(w.image)" :src="w.image" alt="" loading="lazy" referrerpolicy="no-referrer" @error="broken = new Set([...broken, w.image!])" />
    <span v-else class="vw-media-ph"><Icon name="music" :size="30" /></span>
    <div class="vw-media-b">
      <span class="vw-mut vw-media-s"><Icon :name="w.state === 'paused' ? 'pause' : w.state === 'idle' ? 'square' : 'play'" :size="13" />{{ w.state === "paused" ? "Paused" : w.state === "idle" ? "Stopped" : "Now playing" }}<template v-if="w.source"> · {{ w.source }}</template></span>
      <b class="vw-media-t">{{ w.title }}</b>
      <span v-if="w.artist || w.album" class="vw-media-a">{{ [w.artist, w.album].filter(Boolean).join(" · ") }}</span>
      <div v-if="pos" class="vw-media-p"><span class="num">{{ mmss(pos.at) }}</span><span class="vw-prog" aria-hidden="true"><i :style="{ transform: `scaleX(${pos.frac})` }"></i></span><span class="num">{{ mmss(w.duration!) }}</span></div>
    </div>
  </section>

  <!-- images -->
  <section v-else-if="w.kind === 'image'" class="vw-img" :class="{ many: w.items.length > 1 }">
    <template v-for="(im, i) in w.items" :key="i">
      <figure v-if="!broken.has(im.url)">
        <img :src="im.url" :alt="im.caption ?? ''" loading="lazy" referrerpolicy="no-referrer" @error="broken = new Set([...broken, im.url])" />
        <figcaption v-if="im.caption || im.credit">{{ im.caption }}<small v-if="im.credit">{{ im.caption ? " · " : "" }}{{ im.credit }}</small></figcaption>
      </figure>
    </template>
  </section>

  <!-- steps / list -->
  <section v-else-if="w.kind === 'steps'" class="vw vw-steps" :aria-label="w.title ?? 'Steps'">
    <p v-if="w.title" class="vw-h">{{ w.title }}</p>
    <component :is="w.ordered ? 'ol' : 'ul'">
      <li v-for="(s, i) in w.items" :key="i" :class="{ done: s.done }">
        <span class="vw-step-n" aria-hidden="true"><Icon v-if="s.done" name="check" :size="14" /><template v-else-if="w.ordered">{{ i + 1 }}</template></span>
        <span class="vw-step-t"><b>{{ s.title }}</b><span v-if="s.detail">{{ s.detail }}</span></span>
      </li>
    </component>
  </section>

  <!-- key numbers -->
  <section v-else-if="w.kind === 'stat'" class="vw-stats" :class="`n${w.items.length}`">
    <div v-for="(s, i) in w.items" :key="i" class="vw vw-stat">
      <span class="vw-lbl">{{ s.label }}</span>
      <b class="vw-stat-v">{{ s.value }}<small v-if="s.unit">{{ s.unit }}</small></b>
      <span v-if="s.delta" class="vw-stat-d" :class="s.trend && 'tr-' + s.trend"><Icon v-if="s.trend" :name="s.trend === 'up' ? 'trending-up' : s.trend === 'down' ? 'trending-down' : 'minus'" :size="15" />{{ s.delta }}</span>
      <span v-if="s.note" class="vw-mut">{{ s.note }}</span>
    </div>
  </section>

  <!-- comparison -->
  <section v-else-if="w.kind === 'compare'" class="vw vw-cmp" :aria-label="w.title ?? 'Comparison'">
    <p v-if="w.title" class="vw-h">{{ w.title }}</p>
    <div class="vw-cmp-w">
      <table>
        <thead><tr><th></th><th v-for="(it, i) in w.items" :key="i" :class="{ pick: w.pick === i }">{{ it }}<small v-if="w.pick === i">Pick</small></th></tr></thead>
        <tbody><tr v-for="(r, ri) in w.rows" :key="ri"><th scope="row">{{ r.label }}</th><td v-for="(v, i) in r.values" :key="i" :class="{ pick: w.pick === i }">{{ v }}</td></tr></tbody>
      </table>
    </div>
  </section>

  <!-- agenda -->
  <section v-else-if="w.kind === 'agenda'" class="vw vw-ag" :aria-label="w.title ?? 'Agenda'">
    <p v-if="w.title" class="vw-h">{{ w.title }}</p>
    <ol>
      <template v-for="(e, i) in w.items" :key="i">
        <li v-if="e.day && e.day !== w.items[i - 1]?.day" class="vw-ag-day">{{ e.day }}</li>
        <li class="vw-ag-e">
          <span class="vw-ag-time num">{{ e.time ?? "All day" }}</span>
          <span class="vw-ag-t"><b>{{ e.title }}</b><span v-if="e.detail || e.where"><template v-if="e.where"><Icon name="map-pin" :size="12" />{{ e.where }}</template>{{ e.where && e.detail ? " · " : "" }}{{ e.detail }}</span></span>
        </li>
      </template>
    </ol>
  </section>
</template>

<style scoped>
.vw{margin:2px 0;padding:14px 16px;border:1px solid #232327;border-radius:16px;background:#121215;max-width:520px;min-width:0;color:var(--ink)}
.vw-h{margin:0 0 10px;font:600 12px var(--body);letter-spacing:.06em;text-transform:uppercase;color:#8d8d95}
.vw-lbl{font:600 11.5px var(--body);letter-spacing:.06em;text-transform:uppercase;color:#8d8d95}
.vw-mut{color:#9b9ba2}
.vw-rain{color:#8fb4ff;font-size:11.5px}
ol,ul{list-style:none;margin:0;padding:0}

/* weather */
.vw-wx-now{display:flex;align-items:center;gap:14px}
.vw-wx-big{color:#f2f2f2}
.vw-wx-t{font:600 46px/1 var(--body);letter-spacing:-.02em}
.vw-wx-t small{font-size:18px;color:#9b9ba2;margin-left:2px;vertical-align:top}
.vw-wx-s{display:flex;flex-direction:column;gap:2px;min-width:0;font-size:13.5px}
.vw-wx-s b{font:600 15px var(--body)}
.vw-wx-hours{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:4px;margin-top:14px;padding-top:12px;border-top:1px solid #1f1f23}
.vw-wx-hours li{display:flex;flex-direction:column;align-items:center;gap:6px;font-size:12.5px}
.vw-wx-hours b{font:600 15px var(--body)}
.vw-wx-days{display:flex;flex-direction:column;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid #1f1f23}
.vw-wx-now+.vw-wx-days,.vw-h+.vw-wx-days{border-top:0;padding-top:0;margin-top:4px}
.vw-wx-days li{display:grid;grid-template-columns:52px 22px 34px 34px 1fr 34px;align-items:center;gap:8px;font-size:14px}
.vw-wx-dl{font-weight:600}
.vw-wx-days b{text-align:right;font-weight:600}
.vw-wx-days .vw-mut{text-align:right}
.vw-wx-r{position:relative;height:6px;border-radius:3px;background:#1f1f24;overflow:hidden}
.vw-wx-r i{position:absolute;top:0;bottom:0;border-radius:3px;background:linear-gradient(90deg,#8fb4ff,var(--vw-ac,#d97757))}

/* timer */
.vw-timer{position:relative;display:grid;place-items:center;width:200px;height:200px;padding:0;border:0;border-radius:50%;background:none;max-width:none}
.vw-timer svg{position:absolute;inset:0;width:100%;height:100%}
.vw-tr-bg{fill:none;stroke:#1f1f24;stroke-width:6}
.vw-tr-fg{fill:none;stroke:var(--vw-ac,#d97757);stroke-width:6;stroke-linecap:round;transition:stroke-dashoffset 1s linear}
.vw-timer-b{display:flex;flex-direction:column;align-items:center;gap:2px;font-size:12.5px;text-align:center}
.vw-timer-b b{font:600 38px/1.1 var(--body);letter-spacing:-.01em}
.vw-timer.done .vw-tr-fg{stroke:#2fd38a}
.vw-timer.done b{color:#2fd38a}

/* home */
.vw-home ul{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
.vw-home li{display:flex;align-items:center;gap:10px;min-width:0;padding:10px;border-radius:12px;background:#0c0c0e;border:1px solid #1d1d21}
.vw-home-i{flex:none;width:36px;height:36px;border-radius:50%;display:grid;place-items:center;background:#1c1c20;color:#8d8d95}
.vw-home li.on .vw-home-i{background:color-mix(in srgb,var(--vw-ac,var(--vw-ac,#d97757)) 16%,transparent);color:var(--vw-ac-ink,#ffb59c)}
.vw-home-t{display:flex;flex-direction:column;min-width:0}
.vw-home-t b{font:600 13.5px var(--body);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vw-home-t span{font-size:12px;color:#9b9ba2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vw-home li.on .vw-home-t span{color:var(--vw-ac-ink,#e6c3b6)}

/* media */
.vw-media{display:flex;gap:14px;align-items:center}
.vw-media img,.vw-media-ph{flex:none;width:92px;height:92px;border-radius:12px;object-fit:cover;background:#1c1c20}
.vw-media-ph{display:grid;place-items:center;color:#8d8d95}
.vw-media-b{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
.vw-media-s{display:inline-flex;align-items:center;gap:5px;font-size:12px}
.vw-media-t{font:600 17px/1.25 var(--body);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vw-media-a{font-size:13.5px;color:#c7c7cc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vw-media-p{display:flex;align-items:center;gap:8px;margin-top:6px;font-size:11.5px;color:#9b9ba2}
.vw-prog{flex:1;height:4px;border-radius:2px;background:#26262b;overflow:hidden}
.vw-prog i{display:block;height:100%;background:#f2f2f2;transform-origin:left;transition:transform 1s linear}

/* images */
.vw-img{display:grid;gap:8px;max-width:560px}
.vw-img.many{grid-template-columns:1fr 1fr}
.vw-img figure{margin:0;min-width:0}
.vw-img img{display:block;width:100%;max-height:340px;object-fit:cover;border-radius:14px;background:#1a1a1d}
.vw-img.many img{aspect-ratio:4/3;max-height:none}
.vw-img figcaption{margin-top:6px;font-size:13px;color:#c7c7cc}
.vw-img figcaption small{color:#8d8d95;font-size:12px}

/* steps */
.vw-steps li{display:flex;gap:12px;align-items:flex-start;padding:7px 0}
.vw-steps li+li{border-top:1px solid #1c1c20}
.vw-step-n{flex:none;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font:600 12.5px var(--body);color:var(--vw-ac-ink,#ffb59c);border:1.5px solid color-mix(in srgb,var(--vw-ac,var(--vw-ac,#d97757)) 55%,transparent)}
.vw-steps ul .vw-step-n{width:8px;height:8px;margin:7px 9px 0;background:var(--vw-ac,#d97757);border:0}
.vw-steps li.done .vw-step-n{background:rgba(47,211,138,.14);border-color:rgba(47,211,138,.5);color:#2fd38a}
.vw-step-t{display:flex;flex-direction:column;gap:2px;min-width:0;padding-top:2px}
.vw-step-t b{font:600 14.5px/1.35 var(--body)}
.vw-steps li.done .vw-step-t b{color:#9b9ba2}
.vw-step-t span{font-size:13px;line-height:1.4;color:#a5a5ac}

/* stats */
.vw-stats{display:grid;gap:8px;max-width:560px}
.vw-stats.n2{grid-template-columns:1fr 1fr}.vw-stats.n3{grid-template-columns:repeat(3,1fr)}.vw-stats.n4{grid-template-columns:repeat(2,1fr)}
.vw-stats.n1 .vw-stat{max-width:300px}
.vw-stat{display:flex;flex-direction:column;gap:4px;margin:0}
.vw-stat-v{font:600 34px/1.1 var(--body);letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.vw-stat-v small{font-size:15px;color:#9b9ba2;margin-left:4px;letter-spacing:0}
.vw-stat-d{align-self:flex-start;display:inline-flex;align-items:center;gap:5px;font:600 13px var(--body);color:#c7c7cc}
.vw-stat-d.tr-up{color:#5fe0a6}.vw-stat-d.tr-down{color:#ff8a94}
.vw-stat .vw-mut{font-size:12.5px}

/* compare */
.vw-cmp{max-width:620px}
.vw-cmp-w{overflow-x:auto}
.vw-cmp table{border-collapse:collapse;width:100%;font-size:13.5px}
.vw-cmp th,.vw-cmp td{padding:8px 10px;text-align:left;border-bottom:1px solid #1d1d21}
.vw-cmp tbody tr:last-child>*{border-bottom:0}
.vw-cmp thead th{font:600 14px var(--body);color:var(--ink);vertical-align:bottom}
.vw-cmp thead th small{display:block;width:max-content;margin-top:3px;font:700 10px var(--body);letter-spacing:.06em;text-transform:uppercase;padding:2px 7px;border-radius:999px;color:var(--vw-ac-ink,#ffcfbd);background:color-mix(in srgb,var(--vw-ac,var(--vw-ac,#d97757)) 16%,transparent)}
.vw-cmp tbody th{font:600 12px var(--body);color:#8d8d95;white-space:nowrap}
.vw-cmp .pick{background:color-mix(in srgb,var(--vw-ac,var(--vw-ac,#d97757)) 7%,transparent)}

/* agenda */
.vw-ag ol{display:flex;flex-direction:column}
.vw-ag-day{font:600 12px var(--body);letter-spacing:.06em;text-transform:uppercase;color:#8d8d95;padding:10px 0 4px}
.vw-ag-day:first-child{padding-top:0}
.vw-ag-e{display:grid;grid-template-columns:64px 1fr;gap:12px;padding:8px 0;border-left:0}
.vw-ag-e+.vw-ag-e{border-top:1px solid #1c1c20}
.vw-ag-time{font-size:13.5px;color:var(--vw-ac-ink,#ffb59c);padding-top:1px}
.vw-ag-t{display:flex;flex-direction:column;gap:2px;min-width:0}
.vw-ag-t b{font:600 14.5px/1.35 var(--body)}
.vw-ag-t span{display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap;font-size:13px;color:#a5a5ac}
</style>
