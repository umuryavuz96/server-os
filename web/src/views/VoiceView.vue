<script setup lang="ts">
// Voice: Lahmacun's voice session (channel "voice", ~/bots/voice): the same identity as the main bot in its own
// conversation, fed by the apps' voice screen and the desk speaker. The speaker's controls, then the chat live.
import { ref } from "vue";
import { useFeed } from "../bots";
import BotFeed from "../components/bots/BotFeed.vue";
import VoiceCloud from "../components/bots/VoiceCloud.vue";
import HouseVoice from "../components/bots/HouseVoice.vue";

const { grouped, meta, state } = useFeed(ref("voice"));
</script>

<template>
  <main class="page vv">
    <header class="ph">
      <h1>Voice</h1>
      <p class="meta">Talk to Lahmacun from the app's voice screen, or say “Hey Jarvis” at the desk speaker. Both go to this conversation.</p>
    </header>
    <div class="vv-hv"><HouseVoice /><VoiceCloud /></div>
    <section class="vv-chat card" aria-label="Voice conversation">
      <div class="vt"><span>Conversation</span><span>{{ state === "live" ? (meta?.session?.working ? "thinking…" : "live") : state }}</span></div>
      <p v-if="!grouped.length" class="meta">Nothing said yet.</p>
      <BotFeed v-else :blocks="grouped" :meta="meta" name="voice" :can-interrupt="false" />
    </section>
  </main>
</template>

<style scoped>
.vv{display:flex;flex-direction:column;gap:14px;max-width:860px}
/* wide: the speaker controls beside the conversation instead of stacked above it */
@media(min-width:1180px){.vv{display:grid;grid-template-columns:minmax(300px,380px) minmax(0,860px);align-items:start;max-width:1300px;margin-inline:auto}.vv .ph{grid-column:1/-1}.vv-hv{max-width:none;position:sticky;top:20px;grid-column:1;grid-row:2}.vv-chat{grid-column:2;grid-row:2;max-height:calc(100vh - 150px)}.vv:not(:has(.vv-hv)){grid-template-columns:minmax(0,860px)}.vv:not(:has(.vv-hv)) .vv-chat{grid-column:1}}
.vv .ph{flex-direction:column;align-items:flex-start;gap:4px}
.vv-hv{max-width:420px;margin:0}
.vv-chat{display:flex;flex-direction:column;gap:10px;min-height:320px;max-height:calc(100vh - 300px)}
</style>
