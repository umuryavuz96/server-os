<script setup lang="ts">
// Small stylised System Settings snippets (inline SVG, 220×130): generic and neutral, not a copy of Apple's UI.
import { computed } from "vue";
import type { Vis } from "../permGuide";

const props = defineProps<{ kind: Vis; name: string; pane: string; lines?: string[] }>();
const label = computed(() => ({
  sidebar: `Illustration: Settings sidebar with Privacy & Security chosen, then ${props.pane}`,
  plus: `Illustration: the plus button under the list to add ${props.name}`,
  toggle: `Illustration: toggle ${props.name} on`,
  expand: `Illustration: click the arrow next to ${props.name} to expand it`,
  folders: `Illustration: ${props.name} expanded, with a switch for each place`,
  password: "Illustration: the Enter your Mac password sheet",
  dialog: `Illustration: Allow popup for ${props.name}`,
  quit: "Illustration: Quit & Reopen popup",
}[props.kind]));
const letter = computed(() => (props.name[0] ?? "?").toUpperCase());
const dots = [0, 1, 2, 3, 4, 5, 6, 7];
const rows = computed(() => (props.lines?.length ? props.lines : ["Desktop Folder", "Documents Folder", "Downloads Folder"]).slice(0, 3));
</script>

<template>
  <svg class="pv" viewBox="0 0 220 130" role="img" :aria-label="label">
    <rect class="v-win" x=".5" y=".5" width="219" height="129" rx="8" />
    <g aria-hidden="true">
      <circle cx="11" cy="9" r="2.4" fill="#ff5f57" /><circle cx="19" cy="9" r="2.4" fill="#febc2e" /><circle cx="27" cy="9" r="2.4" fill="#28c840" />

      <!-- sidebar + pane list -->
      <template v-if="kind === 'sidebar'">
        <path class="v-side" d="M.5 18h92v103a8 8 0 0 1-8 8H8.5a8 8 0 0 1-8-8z" />
        <rect class="v-bar" x="10" y="27" width="46" height="5" rx="2.5" /><rect class="v-bar" x="10" y="40" width="58" height="5" rx="2.5" />
        <rect class="v-hi" x="5" y="52" width="83" height="17" rx="5" /><text class="v-t v-b" x="11" y="63.5">Privacy &amp; Security</text>
        <rect class="v-bar" x="10" y="80" width="52" height="5" rx="2.5" /><rect class="v-bar" x="10" y="93" width="40" height="5" rx="2.5" /><rect class="v-bar" x="10" y="106" width="56" height="5" rx="2.5" />
        <text class="v-t v-b" x="102" y="31">Privacy &amp; Security</text>
        <rect class="v-card" x="100" y="38" width="112" height="76" rx="6" />
        <rect class="v-bar" x="108" y="48" width="64" height="5" rx="2.5" /><rect class="v-bar" x="108" y="66" width="48" height="5" rx="2.5" />
        <rect class="v-ring v-anim" x="103" y="76" width="106" height="17" rx="5" /><text class="v-t" x="109" y="87.5">{{ pane }}</text><path class="v-chev" d="M198 80.5l4 4-4 4" />
        <rect class="v-bar" x="108" y="100" width="56" height="5" rx="2.5" />
      </template>

      <!-- list with a switch -->
      <template v-else-if="kind === 'toggle'">
        <text class="v-t v-b v-mid" x="110" y="13">{{ pane }}</text>
        <rect class="v-card" x="10" y="24" width="200" height="98" rx="6" />
        <rect class="v-ico" x="19" y="33" width="16" height="16" rx="4" /><rect class="v-bar" x="42" y="39" width="70" height="5" rx="2.5" />
        <rect class="v-hi v-soft" x="14" y="56" width="192" height="24" rx="5" />
        <rect class="v-ico v-me" x="19" y="60" width="16" height="16" rx="4" /><text class="v-t v-ic" x="27" y="72" text-anchor="middle">{{ letter }}</text>
        <text class="v-t v-b" x="42" y="72">{{ name }}</text>
        <rect class="v-trk v-anim" x="170" y="62" width="28" height="13" rx="6.5" /><circle class="v-knob v-anim" cx="177" cy="68.5" r="5" />
        <rect class="v-ico" x="19" y="88" width="16" height="16" rx="4" /><rect class="v-bar" x="42" y="94" width="54" height="5" rx="2.5" />
        <rect class="v-trk v-off" x="170" y="90" width="28" height="13" rx="6.5" /><circle class="v-knob v-still" cx="177" cy="96.5" r="5" />
      </template>

      <!-- disclosure rows: every program has an arrow; the one to click is ringed -->
      <template v-else-if="kind === 'expand'">
        <text class="v-t v-b v-mid" x="110" y="13">{{ pane }}</text>
        <rect class="v-card" x="10" y="24" width="200" height="98" rx="6" />
        <rect class="v-ico" x="19" y="30" width="14" height="14" rx="4" /><text class="v-t v-m" x="40" y="40.5">2.1.101</text><path class="v-chev" d="M196 33l4 4-4 4" />
        <rect class="v-hi v-soft" x="14" y="49" width="192" height="22" rx="5" />
        <rect class="v-ico v-me" x="19" y="53" width="14" height="14" rx="4" /><text class="v-t v-b" x="40" y="64">{{ name }}</text>
        <rect class="v-ring v-anim" x="184" y="51" width="20" height="18" rx="5" /><path class="v-chev v-hot" d="M192 56l4 4-4 4" />
        <rect class="v-ico" x="19" y="78" width="14" height="14" rx="4" /><text class="v-t v-m" x="40" y="88.5">Claude</text><path class="v-chev" d="M196 81l4 4-4 4" />
        <rect class="v-ico" x="19" y="100" width="14" height="14" rx="4" /><text class="v-t v-m" x="40" y="110.5">cron</text><path class="v-chev" d="M196 103l4 4-4 4" />
      </template>

      <!-- the program expanded: one switch per place -->
      <template v-else-if="kind === 'folders'">
        <text class="v-t v-b v-mid" x="110" y="13">{{ pane }}</text>
        <rect class="v-card" x="10" y="24" width="200" height="98" rx="6" />
        <rect class="v-ico v-me" x="19" y="30" width="14" height="14" rx="4" /><text class="v-t v-b" x="40" y="40.5">{{ name }}</text><path class="v-chev" d="M194 34l4 4 4-4" />
        <g v-for="(r, i) in rows" :key="i">
          <text class="v-t" x="40" :y="62 + i * 21">{{ r }}</text>
          <rect class="v-trk v-anim" x="170" :y="52 + i * 21" width="28" height="13" rx="6.5" /><circle class="v-knob v-anim" cx="177" :cy="58.5 + i * 21" r="5" />
        </g>
      </template>

      <!-- + button -->
      <template v-else-if="kind === 'plus'">
        <text class="v-t v-b v-mid" x="110" y="13">{{ pane }}</text>
        <rect class="v-card" x="10" y="24" width="200" height="66" rx="6" />
        <rect class="v-ico" x="19" y="33" width="16" height="16" rx="4" /><rect class="v-bar" x="42" y="39" width="70" height="5" rx="2.5" /><rect class="v-trk v-off" x="170" y="35" width="28" height="13" rx="6.5" /><circle class="v-knob v-still" cx="177" cy="41.5" r="5" />
        <rect class="v-ico" x="19" y="60" width="16" height="16" rx="4" /><rect class="v-bar" x="42" y="66" width="54" height="5" rx="2.5" /><rect class="v-trk v-off" x="170" y="62" width="28" height="13" rx="6.5" /><circle class="v-knob v-still" cx="177" cy="68.5" r="5" />
        <rect class="v-foot" x="10" y="90" width="200" height="22" rx="0" />
        <rect class="v-btn1" x="14" y="93" width="20" height="16" rx="4" /><path class="v-plus" d="M24 97.5v7M20.5 101h7" />
        <rect class="v-ring v-anim" x="11" y="90.5" width="26" height="22" rx="6" />
        <rect class="v-btn1" x="38" y="93" width="20" height="16" rx="4" /><path class="v-plus v-dim" d="M45 101h6" />
        <text class="v-t v-m" x="68" y="104">Click +, then pick {{ name }}</text>
      </template>

      <!-- password sheet -->
      <template v-else-if="kind === 'password'">
        <rect class="v-dim-bg" x="1" y="18" width="218" height="111" rx="0" />
        <rect class="v-sheet" x="34" y="20" width="152" height="94" rx="9" />
        <circle class="v-lock" cx="110" cy="38" r="9" /><rect x="105" y="36" width="10" height="8" rx="2" fill="var(--bg)" /><path d="M107 36v-3a3 3 0 0 1 6 0v3" fill="none" stroke="var(--bg)" stroke-width="1.6" />
        <text class="v-t v-b v-mid" x="110" y="63">Enter your Mac password</text>
        <rect class="v-field" x="52" y="70" width="116" height="15" rx="4" />
        <circle v-for="d in dots" :key="d" class="v-dot" :cx="62 + d * 8" cy="77.5" r="2.2" />
        <rect class="v-btn2" x="52" y="93" width="48" height="15" rx="5" /><text class="v-t v-m v-mid" x="76" y="103.5">Cancel</text>
        <rect class="v-btn2 v-hi2 v-anim" x="104" y="93" width="64" height="15" rx="5" /><text class="v-t v-m v-mid v-on" x="136" y="103.5">Modify Settings</text>
      </template>

      <!-- Allow popup / Quit & Reopen popup -->
      <template v-else>
        <rect class="v-dim-bg" x="1" y="18" width="218" height="111" />
        <rect class="v-sheet" x="26" y="20" width="168" height="94" rx="9" />
        <rect class="v-ico v-me" x="35" y="30" width="20" height="20" rx="5" /><text class="v-t v-ic" x="45" y="44.5" text-anchor="middle">{{ kind === 'quit' ? "!" : letter }}</text>
        <text v-for="(l, i) in (lines ?? []).slice(0, 4)" :key="i" class="v-t" :class="{ 'v-b': i === 0 && kind === 'quit' }" x="62" :y="35 + i * 10.5">{{ l }}</text>
        <template v-if="kind === 'dialog'">
          <rect class="v-btn2" x="36" y="92" width="70" height="16" rx="5" /><text class="v-t v-m v-mid" x="71" y="103">Don’t Allow</text>
          <rect class="v-btn2 v-hi2 v-anim" x="112" y="92" width="72" height="16" rx="5" /><text class="v-t v-m v-mid v-on" x="148" y="103">Allow</text>
        </template>
        <template v-else>
          <rect class="v-btn2" x="36" y="92" width="56" height="16" rx="5" /><text class="v-t v-m v-mid" x="64" y="103">Later</text>
          <rect class="v-btn2 v-hi2 v-anim" x="98" y="92" width="86" height="16" rx="5" /><text class="v-t v-m v-mid v-on" x="141" y="103">Quit &amp; Reopen</text>
        </template>
      </template>
    </g>
  </svg>
</template>

<style scoped>
.pv{display:block;width:100%;height:auto;aspect-ratio:220/130;--hi:#6f8cff;font-family:var(--body)}
.v-win{fill:#17171b;stroke:#34343b}
.v-side{fill:#101013}
.v-card,.v-foot{fill:#1e1e23}
.v-sheet{fill:#222229;stroke:#3a3a43}
.v-dim-bg{fill:rgba(0,0,0,.45)}
.v-bar{fill:#3a3a43}
.v-ico{fill:#34343c}
.v-ico.v-me{fill:#5b5b66}
.v-hi{fill:rgba(111,140,255,.34)}
.v-hi.v-soft{fill:rgba(111,140,255,.14)}
.v-t{fill:#e8e8ec;font-size:8.5px;font-weight:500}
.v-t.v-b{font-weight:700}
.v-t.v-m{font-size:7.5px;fill:#c9c9d1}
.v-t.v-mid{text-anchor:middle}
.v-t.v-on{fill:#fff;font-weight:700}
.v-t.v-ic{fill:#fff;font-size:10px;font-weight:700}
.v-chev.v-hot{stroke:#fff}
.v-chev{fill:none;stroke:#9b9ba2;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.v-ring{fill:none;stroke:var(--hi);stroke-width:1.6}
.v-field{fill:#111114;stroke:#3a3a43}
.v-dot{fill:#d8d8de}
.v-lock{fill:#d8d8de}
.v-btn1,.v-btn2{fill:#34343c}
.v-btn2.v-hi2{fill:#4a6df0}
.v-plus{fill:none;stroke:#e8e8ec;stroke-width:1.8;stroke-linecap:round}
.v-plus.v-dim{stroke:#7b7b85}
.v-trk{fill:#4a4a54}
.v-trk.v-off{fill:#3a3a43}
.v-knob{fill:#f2f2f2}
.v-knob.v-still{fill:#9b9ba2}
/* motion: the switch flips on, the target pulses. Reduced motion shows the end state. */
.v-trk.v-anim{animation:trk 3.6s ease-in-out infinite}
.v-knob.v-anim{animation:knob 3.6s ease-in-out infinite}
.v-ring.v-anim,.v-hi2.v-anim{animation:pulse 1.8s ease-in-out infinite}
@keyframes trk{0%,28%{fill:#4a4a54}42%,100%{fill:var(--on)}}
@keyframes knob{0%,28%{transform:translateX(0)}42%,100%{transform:translateX(14px)}}
@keyframes pulse{50%{opacity:.45}}
@media (prefers-reduced-motion:reduce){
  .v-trk.v-anim,.v-knob.v-anim,.v-ring.v-anim,.v-hi2.v-anim{animation:none}
  .v-trk.v-anim{fill:var(--on)}
  .v-knob.v-anim{transform:translateX(14px)}
}
</style>
