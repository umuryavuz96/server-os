<script setup lang="ts">
// Voice: the voice assistant's session (integrations.houseVoice; the bot channel "voice" by default), the same identity
// as the owner's main bot in its own conversation, fed by the apps' voice screen, the desk speaker and this chat.
// Two tabs: Chat (the full chat with voice mode, VoiceChat) and Voices (the desk speaker, cloud credits, the voice it
// answers with, and open-source voices to try). The assistant's name comes from the server (/voice/chat), never
// from this file.
import { ref, onMounted } from "vue";
import { api } from "../store";
import HouseVoice from "../components/bots/HouseVoice.vue";
import VoiceCloud from "../components/bots/VoiceCloud.vue";
import VoicePicker from "../components/bots/VoicePicker.vue";
import VoiceCatalog from "../components/bots/VoiceCatalog.vue";
import VoiceChat, { type ChatInfo } from "../components/voice/VoiceChat.vue";

// session: the voice session exists on this server (without it there is no conversation to show, only the voices).
const props = withDefaults(defineProps<{ session?: boolean }>(), { session: true });
const info = ref<ChatInfo | null>(null), err = ref<string | null>(null);
const tab = ref<"chat" | "voices">(props.session ? (location.hash.includes("voices") ? "voices" : "chat") : "voices");
const cloudOn = ref<boolean | undefined>();
async function load() { try { info.value = await api<ChatInfo>("/voice/chat"); err.value = null; } catch (e) { err.value = (e as Error).message; } }
onMounted(load);
const name = () => info.value?.name ?? "the assistant";
function pick(t: "chat" | "voices") { tab.value = t; history.replaceState(null, "", t === "voices" ? "#voice?voices" : "#voice"); }
</script>

<template>
  <main class="vv" :class="{ 'vv-chatmode': tab === 'chat' }">
    <header class="vv-h">
      <h1>Voice</h1>
      <div v-if="session" class="seg2 vv-tabs" role="tablist" aria-label="Voice">
        <button type="button" role="tab" :aria-selected="tab === 'chat'" @click="pick('chat')">Chat</button>
        <button type="button" role="tab" :aria-selected="tab === 'voices'" @click="pick('voices')">Voices &amp; speaker</button>
      </div>
    </header>
    <template v-if="tab === 'chat'">
      <VoiceChat v-if="info" class="vv-chat" :info="info" @refresh="load">
        <template #side><HouseVoice v-if="info.deskSpeaker.available" :name="info.name" /></template>
      </VoiceChat>
      <p v-else-if="err" class="vv-err">{{ err }}</p>
      <p v-else class="meta vv-err">Loading…</p>
    </template>
    <div v-else class="vv-voices">
      <p class="meta">Talk to {{ name() }} from the chat, the app's voice screen or the desk speaker. Choose the voice it answers with.</p>
      <div class="vv-pair"><HouseVoice :name="name()" /><VoiceCloud @change="cloudOn = $event" /></div>
      <VoicePicker :cloud-on="cloudOn" :name="name()" />
      <VoiceCatalog :name="name()" />
    </div>
  </main>
</template>

<style scoped>
.vv{display:flex;flex-direction:column;gap:14px;max-width:1100px}
.vv-h{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.vv-tabs{height:auto}.vv-tabs button{min-height:34px;padding:0 12px}
.vv-voices{display:flex;flex-direction:column;gap:14px}
.vv-voices>.meta{margin:0}
/* the status strip reflows with the width: one column on a phone, two from about 640px */
.vv-pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:12px}
.vv-err{padding:16px}
.vv.vv-chatmode{max-width:none;gap:0;height:100dvh;min-height:480px}
.vv-chatmode .vv-h{padding:10px 16px;border-bottom:1px solid #1f1f23;background:#0b0b0d}
.vv-chatmode .vv-h h1{font-size:19px}
.vv-chat{flex:1;min-height:0}
@media(max-width:860px){.vv.vv-chatmode{height:calc(100dvh - 52px)}.vv-chatmode .vv-h{padding:0 12px 8px;border-bottom:0;background:none}}
@media(max-width:620px){.vv-chatmode .vv-h h1{display:none}.vv-chatmode .vv-tabs{flex:1}}
</style>
