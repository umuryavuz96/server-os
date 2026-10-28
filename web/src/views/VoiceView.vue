<script setup lang="ts">
// Voice: Lahmacun's voice session (channel "voice", ~/bots/voice): the same identity as the main bot in its own
// conversation, fed by the apps' voice screen and the desk speaker. One fluid page: the speaker and the cloud credits
// side by side when there is room, the voice picker (every installed voice, with a sample each), the chat live, and
// the open-source voices to try folded away at the end.
import { ref } from "vue";
import { useFeed } from "../bots";
import BotFeed from "../components/bots/BotFeed.vue";
import HouseVoice from "../components/bots/HouseVoice.vue";
import VoiceCloud from "../components/bots/VoiceCloud.vue";
import VoicePicker from "../components/bots/VoicePicker.vue";
import VoiceCatalog from "../components/bots/VoiceCatalog.vue";

// session: the voice session exists on this server (without it there is no conversation to show, only the voices).
withDefaults(defineProps<{ session?: boolean }>(), { session: true });
const { grouped, meta, state } = useFeed(ref("voice"));
const cloudOn = ref<boolean | undefined>();
</script>

<template>
  <main class="page vv">
    <header class="ph">
      <h1>Voice</h1>
      <p class="meta">Talk to Lahmacun from the app's voice screen or the desk speaker. Choose the voice it answers with.</p>
    </header>
    <div class="vv-pair"><HouseVoice /><VoiceCloud @change="cloudOn = $event" /></div>
    <VoicePicker :cloud-on="cloudOn" />
    <section v-if="session" class="vv-chat card" aria-label="Voice conversation">
      <div class="vt"><span>Conversation</span><span :class="{ 'vv-live': state === 'live' }">{{ state === "live" ? (meta?.session?.working ? "thinking…" : "live") : state }}</span></div>
      <p v-if="!grouped.length" class="meta">Nothing said yet.</p>
      <BotFeed v-else :blocks="grouped" :meta="meta" name="voice" :can-interrupt="false" />
    </section>
    <VoiceCatalog />
  </main>
</template>

<style scoped>
.vv{display:flex;flex-direction:column;gap:14px;max-width:1100px}
.vv .ph{flex-direction:column;align-items:flex-start;gap:4px}
/* the status strip reflows with the width: one column on a phone, two from about 640px */
.vv-pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:12px}
.vv-chat{display:flex;flex-direction:column;gap:10px;min-height:240px;max-height:min(640px,calc(100vh - 200px));border-radius:16px;padding:14px}
.vv-live{color:var(--on)}
</style>
