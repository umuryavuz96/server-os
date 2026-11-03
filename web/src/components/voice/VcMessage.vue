<script setup lang="ts">
// One assistant reply: Markdown (sanitized; tables scroll, links open in a new tab, https images load lazily without a
// referrer) with the component blocks in place: cards, charts and code with a copy button. ```sources blocks are
// gathered into the turn's source cards instead (VoiceChat), so they aren't drawn twice. Widgets (weather, timer, …)
// go to VcWidget. tv: the TV kiosk, the whole message scaled for its 1920×1080 canvas, and a block that didn't parse
// is left out (the spoken text stands on its own) instead of shown as code.
import { computed, ref } from "vue";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { segments } from "../../chat/blocks";
import VcCard from "./VcCard.vue";
import VcChart from "./VcChart.vue";
import VcWidget from "./VcWidget.vue";

const p = defineProps<{ text: string; ts?: number; tv?: boolean }>();
const parts = computed(() => segments(p.text).filter((s) => s.type !== "sources" && !(p.tv && s.type === "code" && s.broken)));

let hooked = false;
function html(md: string) {
  if (!hooked) {
    hooked = true;
    DOMPurify.addHook("afterSanitizeAttributes", (n) => {
      if (n.tagName === "A" && n.getAttribute("href")) { n.setAttribute("target", "_blank"); n.setAttribute("rel", "noopener noreferrer"); }
      if (n.tagName === "IMG") {
        if (!/^https:\/\//.test(n.getAttribute("src") ?? "")) n.remove();
        else { n.setAttribute("loading", "lazy"); n.setAttribute("referrerpolicy", "no-referrer"); }
      }
    });
  }
  const raw = marked.parse(md, { gfm: true, breaks: true, async: false }) as string;
  return DOMPurify.sanitize(raw, { FORBID_TAGS: ["style", "iframe", "form", "input", "video", "audio", "object", "embed"], FORBID_ATTR: ["style"] })
    .replace(/<table>/g, '<div class="vc-tw"><table>').replace(/<\/table>/g, "</table></div>");
}
const copied = ref<number | null>(null);
async function copy(i: number, code: string) {
  try { await navigator.clipboard.writeText(code); copied.value = i; setTimeout(() => { if (copied.value === i) copied.value = null; }, 1500); } catch { /* no clipboard */ }
}
</script>

<template>
  <div class="vc-msg" :class="{ tv }">
    <template v-for="(s, i) in parts" :key="i">
      <!-- eslint-disable-next-line vue/no-v-html — sanitized with DOMPurify above -->
      <div v-if="s.type === 'md'" class="vc-md" v-html="html(s.text)"></div>
      <VcCard v-else-if="s.type === 'card'" :card="s.card" />
      <VcChart v-else-if="s.type === 'chart'" :chart="s.chart" />
      <VcWidget v-else-if="s.type === 'widget'" :w="s.w" :ts="ts" />
      <div v-else-if="s.type === 'code'" class="vc-code">
        <div class="vc-code-h"><span>{{ s.lang || "code" }}</span><button type="button" @click="copy(i, s.code)">{{ copied === i ? "Copied" : "Copy" }}</button></div>
        <pre><code>{{ s.code }}</code></pre>
      </div>
    </template>
  </div>
</template>

<style scoped>
.vc-msg{display:flex;flex-direction:column;gap:10px;min-width:0}
/* TV: 15 px panel type → 26 px on the 1920×1080 canvas; one zoom keeps text, cards and charts in proportion */
.vc-msg.tv{zoom:1.75;gap:14px;--vw-ac:#f2b26b;--vw-ac-ink:#f5c58c}
.vc-msg.tv :deep(.vw-img img){max-height:280px}
.vc-msg.tv :deep(.vc-card-badge){color:#f5c58c;background:rgba(242,178,107,.14);border-color:rgba(242,178,107,.35)}
.vc-msg.tv .vc-md{color:#ececef;line-height:1.5}
.vc-msg.tv .vc-md :deep(strong){font-weight:600}
.vc-md{font-size:15px;line-height:1.55;color:#e8e8ec;overflow-wrap:anywhere;min-width:0}
.vc-md :deep(p){margin:0 0 .6em}
.vc-md :deep(p:last-child){margin-bottom:0}
.vc-md :deep(ul),.vc-md :deep(ol){margin:.2em 0 .6em;padding-left:1.3em}
.vc-md :deep(li){margin:.15em 0}
.vc-md :deep(strong){color:#fff;font-weight:650}
.vc-md :deep(a){color:#ffb59c;text-decoration:underline;text-decoration-color:rgba(255,181,156,.4);text-underline-offset:3px}
.vc-md :deep(code){font:500 .86em var(--mono);background:#1b1b1f;border:1px solid #26262b;padding:1px 5px;border-radius:5px}
.vc-md :deep(h1),.vc-md :deep(h2),.vc-md :deep(h3){font:700 15.5px var(--body);color:#fff;margin:.6em 0 .3em;letter-spacing:0;text-transform:none}
.vc-md :deep(blockquote){margin:.4em 0;padding:2px 12px;border-left:3px solid #3a3a40;color:#bdbdc3}
.vc-md :deep(img){display:block;max-width:100%;max-height:320px;border-radius:12px;margin:6px 0;border:1px solid var(--line)}
.vc-md :deep(hr){border:0;border-top:1px solid var(--line);margin:12px 0}
.vc-md :deep(.vc-tw){overflow-x:auto;margin:6px 0 10px;border:1px solid var(--line);border-radius:12px;background:var(--panel-2)}
.vc-md :deep(table){border-collapse:collapse;width:100%;font-size:13.5px;min-width:max-content}
.vc-md :deep(th){text-align:left;font:600 11.5px var(--body);letter-spacing:.05em;text-transform:uppercase;color:var(--muted);background:#131316}
.vc-md :deep(th),.vc-md :deep(td){padding:8px 12px;border-bottom:1px solid #1d1d21;white-space:nowrap}
.vc-md :deep(tr:last-child td){border-bottom:0}
.vc-md :deep(td[align="right"]),.vc-md :deep(th[align="right"]){text-align:right;font-family:var(--mono)}
.vc-code{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#0a0a0c}
.vc-code-h{display:flex;justify-content:space-between;align-items:center;padding:5px 8px 5px 12px;background:#131316;border-bottom:1px solid #1d1d21;font:500 11.5px var(--mono);color:var(--muted)}
.vc-code-h button{font:600 11.5px var(--body);border:1px solid var(--line);background:transparent;color:var(--ink);border-radius:7px;padding:3px 9px;cursor:pointer}
.vc-code pre{margin:0;padding:10px 12px;overflow-x:auto;font:500 12.5px/1.5 var(--mono);color:#dcdce2}
</style>
