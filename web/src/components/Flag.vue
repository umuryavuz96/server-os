<script lang="ts">
// A country flag for a voice's language (flag-icons, 4:3). Only the ten countries the speech services cover are
// imported, so only those SVGs end up in the bundle. A faint inner outline keeps dark flags readable on the dark panels.
import br from "flag-icons/flags/4x3/br.svg";
import cn from "flag-icons/flags/4x3/cn.svg";
import es from "flag-icons/flags/4x3/es.svg";
import fr from "flag-icons/flags/4x3/fr.svg";
import gb from "flag-icons/flags/4x3/gb.svg";
import ind from "flag-icons/flags/4x3/in.svg";
import it from "flag-icons/flags/4x3/it.svg";
import jp from "flag-icons/flags/4x3/jp.svg";
import tr from "flag-icons/flags/4x3/tr.svg";
import us from "flag-icons/flags/4x3/us.svg";

const FLAGS: Record<string, string> = { br, cn, es, fr, gb, in: ind, it, jp, tr, us };
const BY_LANG: Record<string, string> = { tr: "tr", es: "es", fr: "fr", hi: "in", it: "it", ja: "jp", pt: "br", zh: "cn" };
/** The flag code for a voice's language ("" when there is none): English splits by accent, American unless British. */
export const flagOf = (lang: string, accent?: string) => (lang === "en" ? (accent === "British" ? "gb" : "us") : BY_LANG[lang] ?? "");
</script>

<script setup lang="ts">
defineProps<{ code: string; size?: "sm" | "lg" }>();
</script>

<template>
  <img v-if="FLAGS[code]" :src="FLAGS[code]" alt="" class="flag" :class="size ?? 'sm'" />
</template>

<style scoped>
.flag{width:18px;height:13.5px;border-radius:3px;outline:1px solid rgba(255,255,255,.14);outline-offset:-1px;flex:none}
.flag.lg{width:24px;height:18px;border-radius:4px}
</style>
