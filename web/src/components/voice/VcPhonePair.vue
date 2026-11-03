<script setup lang="ts">
// "Use my phone's mic": a QR code (and the link) that opens the phone's mic page on the panel's https address for this
// chat. A phone that isn't signed in pairs with the one-time code in the link (the normal device pairing, 5 minutes).
import { ref, watch, computed, onMounted, onUnmounted } from "vue";
import QRCode from "qrcode";
import Icon from "../Icon.vue";

// big: the TV kiosk's version, centred over the whole screen: a short title, one line of help, the QR, the buttons. It is
// laid out in the kiosk's 1920×1080 canvas px and never taller than the screen (the dialog scrolls inside instead).
// lead: the TV's own line of help (Salon TV: press the remote's mic button after scanning).
const p = defineProps<{ session: { url: string; secure: boolean; code: string | null; expires: number | null } | null; phone: string | null; device: string | null; error: string | null; big?: boolean; lead?: string }>();
const emit = defineEmits<{ close: []; renew: []; expired: [] }>();
const qr = ref(""), copied = ref(false), now = ref(Date.now());
watch(() => p.session?.url, async (u) => { qr.value = u ? await QRCode.toString(u, { type: "svg", margin: 1, color: { dark: "#f2f2f2", light: "#00000000" } }) : ""; }, { immediate: true });
let t: ReturnType<typeof setInterval>;
onMounted(() => { t = setInterval(() => (now.value = Date.now()), 1000); });
onUnmounted(() => clearInterval(t));
const left = computed(() => (p.session?.expires ? Math.max(0, Math.round((p.session.expires - now.value) / 1000)) : null));
watch(left, (l, before) => { if (l === 0 && before) emit("expired"); });
const connected = computed(() => !!p.phone && p.phone !== "waiting" && p.phone !== "gone");
async function copy() { try { await navigator.clipboard.writeText(p.session?.url ?? ""); copied.value = true; setTimeout(() => (copied.value = false), 1500); } catch { /* shown anyway */ } }
const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !p.big) emit("close"); }; // on the TV, Back is handled by the chat
const renewBtn = ref<HTMLButtonElement | null>(null);
onMounted(() => { addEventListener("keydown", onKey); if (p.big) renewBtn.value?.focus(); }); // D-pad: start inside the dialog
onUnmounted(() => removeEventListener("keydown", onKey));
</script>

<template>
  <Teleport to="body">
    <div class="dlg-wrap" :class="{ 'vc-pair-big': big }" data-dpad-trap>
      <div class="dlg-bg" @click="!big && emit('close')"></div>
      <div class="dlg vc-pair" role="dialog" aria-modal="true" aria-labelledby="vc-pair-t">
        <h2 id="vc-pair-t">{{ big ? (connected ? "Your phone is the mic" : "Use your phone as the mic") : "Use my phone's mic" }}</h2>
        <template v-if="connected">
          <div class="vc-pair-ok"><Icon name="circle-check" :size="34" /><b>Listening on {{ device || "your phone" }}</b><span class="meta">{{ big ? (lead ? "Press the mic button on the remote, then talk to the phone." : "Tap the mic on the phone and talk.") : "Tap the mic on the phone and talk. What you say shows up in this chat and is answered here." }}</span></div>
        </template>
        <template v-else>
          <p v-if="big" class="meta vc-pair-sub">{{ lead ?? "Scan the code with your phone's camera, then talk to the phone." }}</p>
          <p v-else class="meta vc-pair-sub">Scan with the iPhone camera. The page opens in Safari over your secure address; allow the microphone when it asks.</p>
          <p v-if="error" class="form-err">{{ error }}</p>
          <!-- eslint-disable-next-line vue/no-v-html — SVG generated locally from our own link -->
          <div v-if="qr" class="pair-qr" :class="{ dead: left === 0 }" v-html="qr" aria-label="QR code for the phone's mic page"></div>
          <div v-else class="vc-pair-wait"><Icon name="loader" class="vc-spin" /></div>
          <p v-if="session && !session.secure" class="vc-pair-warn">This link isn't https, so the phone's browser won't allow the microphone. Set up the panel's https address (Tailscale Serve or a certificate) and open a new code.</p>
          <div class="vc-pair-st"><span class="vc-pair-dot" :class="phone === 'gone' ? 'bad' : ''"></span>{{ phone === "gone" ? "The phone disconnected. Scan again." : "Waiting for the phone…" }}<template v-if="left !== null"> · code {{ left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "expired" }}</template></div>
          <button v-if="session && !big" type="button" class="vc-pair-link" :title="session.url" @click="copy">{{ copied ? "Link copied" : session.url.replace(/^https?:\/\//, "").replace(/\/?#.*/, "") + "/#mic…" }} <Icon name="copy" :size="13" /></button>
        </template>
        <div class="dlg-actions">
          <button v-if="!connected" type="button" ref="renewBtn" @click="emit('renew')">New code</button>
          <button type="button" class="primary" @click="emit('close')">{{ connected ? "Done" : "Close" }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.vc-pair{gap:12px}
.vc-pair-sub{margin:0}
.vc-pair-wait{display:grid;place-items:center;height:220px;color:var(--muted)}
.vc-spin{animation:vc-pair-spin .9s linear infinite}
@keyframes vc-pair-spin{to{transform:rotate(360deg)}}
.vc-pair-warn{margin:0;font-size:13px;color:#ffd38a;background:var(--warn-bg);border:1px solid rgba(255,178,30,.35);border-radius:10px;padding:9px 11px}
.vc-pair-st{display:flex;align-items:center;justify-content:center;gap:8px;font-size:13px;color:var(--muted)}
.vc-pair-dot{width:8px;height:8px;border-radius:50%;background:#d97757;animation:vc-pair-pulse 1.4s ease-in-out infinite}
.vc-pair-dot.bad{background:var(--bad);animation:none}
@keyframes vc-pair-pulse{50%{opacity:.35}}
.vc-pair-link{align-self:center;display:inline-flex;align-items:center;gap:6px;max-width:100%;font:500 12px var(--mono);color:#c7c7cc;background:var(--panel-2);border:1px solid var(--line);border-radius:8px;padding:6px 10px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vc-pair-ok{display:flex;flex-direction:column;align-items:center;text-align:center;gap:8px;padding:18px 4px;color:var(--on)}
.vc-pair-ok b{color:var(--ink);font:700 17px var(--body)}
/* TV: 1920×1080 canvas px (VoiceKiosk zooms the page); % and insets only, since vh is zoomed too */
.vc-pair-big{padding:48px}
.vc-pair-big .dlg-bg{background:rgba(13,14,17,.94);backdrop-filter:none;-webkit-backdrop-filter:none}
.vc-pair-big .dlg{width:min(760px,100%);max-height:100%;overflow-y:auto;align-items:center;text-align:center;gap:20px;padding:44px 48px 40px;border-radius:28px;border:0;background:#17181c;box-shadow:none}
.vc-pair-big .dlg h2{font:600 38px/1.2 var(--body);letter-spacing:0;text-transform:none}
.vc-pair-big .vc-pair-sub{font-size:22px;line-height:1.4;color:#a9a9b1}
.vc-pair-big .pair-qr{flex:none;width:280px;height:280px;margin:0;border:0;padding:14px;border-radius:20px;background:#0d0e11}
.vc-pair-big .pair-qr :deep(svg){display:block;width:100%;height:100%}
.vc-pair-big .vc-pair-wait{height:280px}
.vc-pair-big .vc-pair-st{font-size:19px;gap:10px}
.vc-pair-big .vc-pair-dot{width:10px;height:10px}
.vc-pair-big .vc-pair-warn{font-size:19px;padding:12px 16px}
.vc-pair-big .vc-pair-ok{gap:12px;padding:12px 0}
.vc-pair-big .vc-pair-ok b{font-size:28px}
.vc-pair-big .vc-pair-ok .meta{font-size:22px}
.vc-pair-big .dlg-actions{justify-content:center;gap:16px;margin-top:4px}
.vc-pair-big .dlg-actions button{min-height:64px;padding:0 34px;border-radius:999px;font:600 22px var(--body);border:0;background:#24252b}
.vc-pair-big .dlg-actions button.primary{background:#f2f2f2;color:#0d0e11}
.vc-pair-big .dlg-actions button:focus,.vc-pair-big .dlg-actions button:focus-visible{outline:4px solid #f2b26b!important;outline-offset:5px;border-radius:999px}
</style>
