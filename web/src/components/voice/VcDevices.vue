<script setup lang="ts">
// Where the voice chat listens and where it answers. Microphones in fallback order: this browser (needs https or the
// server itself), a phone paired over the panel's https address, the desk speaker (when house voice is set up), and
// Sonos, listed only to say why it can't be one. Outputs: this browser, a Home Assistant speaker (Sonos), or text only.
import Icon from "../Icon.vue";
import type { IconName } from "../../icons";

export type InputKind = "browser" | "phone" | "desk" | "tv";
export interface DevState {
  input: InputKind; output: string;
  browser: { problem: string | null; secureUrl: string | null; devices: { id: string; label: string }[]; deviceId: string; open: boolean };
  phone: { state: string | null; device: string | null };
  desk: { available: boolean; enabled: boolean; state: string | null };
  /** The TV's own mic (a USB mic recorded by the TV launcher that embeds the kiosk); null when there is no such host. */
  tv: { usb: boolean; name: string | null; state: string | null } | null;
  speakers: { id: string; name: string; available: boolean }[]; speakersNote: string | null;
}
const p = defineProps<{ s: DevState }>();
const emit = defineEmits<{ input: [k: InputKind]; output: [o: string]; device: [id: string]; pairPhone: []; deskOn: [] }>();

const PHONE: Record<string, string> = { waiting: "Waiting for the phone to open the link", connected: "Connected · tap the mic on the phone", listening: "Listening on the phone", recording: "Hearing you on the phone", sending: "Transcribing…", gone: "Phone disconnected" };
const TV: Record<string, string> = { listening: "Listening…", recording: "Hearing you…", sending: "Transcribing…" };
const DESK: Record<string, string> = { idle: "Say the wake word to talk", listening: "Listening…", thinking: "Thinking…", speaking: "Speaking", starting: "Starting…", offline: "Speaker not connected", off: "Off" };
function row(k: InputKind): { icon: IconName; title: string; sub: string; ok: boolean } {
  if (k === "browser") return { icon: "laptop", title: "This browser", sub: p.s.browser.problem ?? (p.s.browser.open ? "Microphone on" : "Asks for the microphone the first time"), ok: !p.s.browser.problem };
  if (k === "tv") return { icon: "mic", title: p.s.tv?.name || "TV mic", sub: !p.s.tv?.usb ? "Plug in a USB mic" : TV[p.s.tv.state ?? ""] ?? "Press the mic button on the remote", ok: !!p.s.tv?.usb };
  if (k === "phone") return { icon: "smartphone", title: "My phone", sub: p.s.phone.state ? PHONE[p.s.phone.state] ?? p.s.phone.state : "Use your iPhone's mic: scan a code", ok: p.s.phone.state !== "gone" };
  return { icon: "volume", title: "Desk speaker", sub: !p.s.desk.enabled ? "Switched off" : DESK[p.s.desk.state ?? ""] ?? p.s.desk.state ?? "", ok: p.s.desk.enabled };
}
const kinds = (): InputKind[] => [...(p.s.tv ? (["tv"] as InputKind[]) : []), "browser", "phone", ...(p.s.desk.available ? (["desk"] as InputKind[]) : [])];
</script>

<template>
  <div class="vc-dev">
    <section aria-labelledby="vc-dev-mic">
      <h3 id="vc-dev-mic">Microphone</h3>
      <ul class="vc-dev-l" role="radiogroup" aria-label="Microphone">
        <li v-for="k in kinds()" :key="k">
          <button type="button" class="vc-dev-r" role="radio" :aria-checked="s.input === k" :class="{ bad: !row(k).ok && s.input === k }" @click="emit('input', k)">
            <span class="vc-dev-i"><Icon :name="row(k).icon" /></span>
            <span class="vc-dev-t"><b>{{ row(k).title }}</b><small>{{ row(k).sub }}</small></span>
            <span class="vc-dev-dot" aria-hidden="true"></span>
          </button>
          <div v-if="k === 'browser' && s.input === 'browser'" class="vc-dev-x">
            <template v-if="s.browser.problem && s.browser.secureUrl">
              <a class="btn" :href="s.browser.secureUrl + '/#voice'">Open the secure address</a>
              <span class="meta">or use your phone below</span>
            </template>
            <select v-else-if="s.browser.devices.length > 1" :value="s.browser.deviceId" aria-label="Which microphone" @change="emit('device', ($event.target as HTMLSelectElement).value)">
              <option value="">System default</option>
              <option v-for="d in s.browser.devices" :key="d.id" :value="d.id">{{ d.label || "Microphone" }}</option>
            </select>
          </div>
          <div v-if="k === 'phone' && s.input === 'phone'" class="vc-dev-x">
            <button type="button" class="btn go" @click="emit('pairPhone')"><Icon name="qr-code" :size="15" /> {{ s.phone.state && s.phone.state !== "gone" ? "Show the code again" : "Connect my phone" }}</button>
          </div>
          <div v-if="k === 'desk' && s.input === 'desk' && !s.desk.enabled" class="vc-dev-x">
            <button type="button" class="btn go" @click="emit('deskOn')">Switch the desk speaker on</button>
          </div>
        </li>
        <li>
          <div class="vc-dev-r off" aria-disabled="true">
            <span class="vc-dev-i"><Icon name="speaker" /></span>
            <span class="vc-dev-t"><b>Sonos</b><small>Can't be a microphone: Sonos keeps its mics for its own voice assistants and offers no way to read them. It can play the answers (below).</small></span>
            <Icon name="lock" :size="15" class="vc-dev-lock" />
          </div>
        </li>
      </ul>
    </section>
    <section aria-labelledby="vc-dev-out">
      <h3 id="vc-dev-out">Answer on</h3>
      <p v-if="s.input === 'desk'" class="meta vc-dev-n">The desk speaker answers out loud by itself.</p>
      <ul v-else class="vc-dev-l" role="radiogroup" aria-label="Answer on">
        <li><button type="button" class="vc-dev-r" role="radio" :aria-checked="s.output === 'browser'" @click="emit('output', 'browser')"><span class="vc-dev-i"><Icon name="volume" /></span><span class="vc-dev-t"><b>{{ s.input === "phone" ? "This computer" : "This browser" }}</b><small>Spoken here as it is made</small></span><span class="vc-dev-dot"></span></button></li>
        <li v-for="sp in s.speakers" :key="sp.id"><button type="button" class="vc-dev-r" role="radio" :aria-checked="s.output === 'speaker:' + sp.id" :disabled="!sp.available" @click="emit('output', 'speaker:' + sp.id)"><span class="vc-dev-i"><Icon name="speaker" /></span><span class="vc-dev-t"><b>{{ sp.name }}</b><small>{{ sp.available ? "Through Home Assistant · output only" : "Unavailable" }}</small></span><span class="vc-dev-dot"></span></button></li>
        <li><button type="button" class="vc-dev-r" role="radio" :aria-checked="s.output === 'off'" @click="emit('output', 'off')"><span class="vc-dev-i"><Icon name="file-text" /></span><span class="vc-dev-t"><b>Text only</b><small>Don't read the answers out</small></span><span class="vc-dev-dot"></span></button></li>
      </ul>
      <p v-if="s.speakersNote" class="meta vc-dev-n">{{ s.speakersNote }}</p>
    </section>
  </div>
</template>

<style scoped>
.vc-dev{display:flex;flex-direction:column;gap:18px}
h3{margin:0 0 8px;font:700 11.5px var(--body);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.vc-dev-l{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.vc-dev-r{width:100%;display:flex;align-items:center;gap:11px;min-height:56px;padding:9px 11px;border-radius:12px;border:1px solid var(--line);background:var(--panel-2);color:var(--ink);text-align:left;cursor:pointer;font:inherit;transition:border-color .15s var(--ease),background .15s var(--ease)}
.vc-dev-r:hover:not(:disabled):not(.off){border-color:#3a3a40}
.vc-dev-r[aria-checked="true"]{border-color:#d97757;background:rgba(217,119,87,.08)}
.vc-dev-r.bad[aria-checked="true"]{border-color:var(--warn);background:var(--warn-bg)}
.vc-dev-r:disabled{opacity:.5;cursor:default}
.vc-dev-r.off{cursor:default;opacity:.72;border-style:dashed}
.vc-dev-r:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.vc-dev-i{flex:none;width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:#151518;border:1px solid #232327;color:#c7c7cc}
.vc-dev-r[aria-checked="true"] .vc-dev-i{color:#ffb59c;border-color:rgba(217,119,87,.4)}
.vc-dev-t{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.vc-dev-t b{font:600 13.5px var(--body)}
.vc-dev-t small{font-size:12px;line-height:1.35;color:var(--muted)}
.vc-dev-r.bad .vc-dev-t small{color:#ffd38a}
.vc-dev-dot{flex:none;width:18px;height:18px;border-radius:50%;border:1.5px solid #3a3a40}
.vc-dev-r[aria-checked="true"] .vc-dev-dot{border:5px solid #d97757}
.vc-dev-lock{color:#6f6f77}
.vc-dev-x{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 2px 2px 45px}
.vc-dev-x .btn{display:inline-flex;align-items:center;gap:6px;min-height:36px;text-decoration:none}
.vc-dev-x select{flex:1;min-width:0;min-height:36px;background:var(--panel-2);color:var(--ink);border:1px solid var(--line);border-radius:9px;padding:0 8px;font:500 13px var(--body)}
.vc-dev-n{margin:6px 2px 0;font-size:12px}
</style>
