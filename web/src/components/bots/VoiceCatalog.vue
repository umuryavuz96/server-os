<script setup lang="ts">
// Open-source voices worth trying (voiceCatalog.json via /voice/showcase), folded away under the Voice page. Nothing here
// installs by a button yet: open the demo to listen, and ask Lahmacun to install one. Loaded the first time it is opened.
import { ref } from "vue";
import { api, toast } from "../../store";

type Entry = { id: string; name: string; kind: string; languages: string; turkish: string; cloning: boolean; license: string; size: string; repo: string; demo: string; note: string; installed: boolean };
const catalog = ref<Entry[] | null>(null), copied = ref<string | null>(null);

async function opened(e: Event) {
  if (!(e.target as HTMLDetailsElement).open || catalog.value) return;
  try { catalog.value = (await api<{ catalog: Entry[] }>("/voice/showcase")).catalog; } catch (err) { toast((err as Error).message); }
}
async function copyAsk(e: Entry) {
  const text = `Please install ${e.name} as a voice on this server (${e.repo}) and add it to the Voice page.`;
  try { await navigator.clipboard.writeText(text); } catch { /* the text is shown anyway */ }
  copied.value = e.id; setTimeout(() => { if (copied.value === e.id) copied.value = null; }, 2500);
}
const TR: Record<string, string> = { yes: "Turkish: yes", no: "No Turkish", community: "Turkish: community only", "n/a": "Language-independent" };
</script>

<template>
  <details class="card vcat" @toggle="opened">
    <summary><b>More voices to try</b><span class="meta">Open-source models, not installed yet</span></summary>
    <p class="meta vcat-sub">Open a demo to listen, and ask Lahmacun to install one. Licences and languages are from each model card.</p>
    <p v-if="catalog && !catalog.length" class="meta">The catalog is empty.</p>
    <ul v-else class="vcat-list">
      <li v-for="e in catalog ?? []" :key="e.id" class="vcat-c">
        <div class="vcat-t"><b>{{ e.name }}</b><span v-if="e.installed" class="vcat-tag">Installed</span></div>
        <div class="vcat-pills">
          <span class="vcat-pill" :class="'tr-' + e.turkish.replace('/', '')">{{ TR[e.turkish] }}</span>
          <span class="vcat-pill">{{ e.kind === "tts" ? "Text to speech" : "Voice conversion" }}</span>
          <span class="vcat-pill">{{ e.cloning ? "Clones voices" : "No cloning" }}</span>
        </div>
        <p class="vcat-n">{{ e.note }}</p>
        <dl class="vcat-dl"><dt>Languages</dt><dd>{{ e.languages }}</dd><dt>Licence</dt><dd>{{ e.license }}</dd><dt>Size</dt><dd>{{ e.size }}</dd></dl>
        <div class="vcat-links">
          <a :href="e.repo" target="_blank" rel="noopener noreferrer">Repo / model card</a>
          <a :href="e.demo" target="_blank" rel="noopener noreferrer">Demo &amp; samples</a>
          <button v-if="!e.installed" type="button" @click="copyAsk(e)">{{ copied === e.id ? "Copied. Paste it to Lahmacun" : "Ask Lahmacun to install" }}</button>
        </div>
      </li>
    </ul>
  </details>
</template>

<style scoped>
.vcat{padding-top:0;padding-bottom:0}
.vcat[open]{padding-bottom:14px}
.vcat summary{list-style:none;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;min-height:48px;cursor:pointer}
.vcat summary::-webkit-details-marker{display:none}
.vcat summary b{font:600 13.5px var(--body)}
.vcat summary .meta{font-size:12px}
.vcat-sub{margin:0 0 12px}
.vcat-list{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr));gap:10px}
.vcat-c{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--line);border-radius:12px;background:var(--panel-2)}
.vcat-t{display:flex;justify-content:space-between;gap:8px;align-items:center}
.vcat-t b{font:700 15px var(--body)}
.vcat-tag{font:600 11px var(--body);padding:3px 8px;border-radius:999px;color:var(--on);background:var(--on-bg)}
.vcat-pills{display:flex;flex-wrap:wrap;gap:6px}
.vcat-pill{font:600 11px var(--body);padding:3px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.vcat-pill.tr-yes{color:var(--on);background:var(--on-bg);border-color:transparent}
.vcat-pill.tr-no{color:var(--bad);background:var(--bad-bg);border-color:transparent}
.vcat-pill.tr-community{color:var(--warn);background:var(--warn-bg);border-color:transparent}
.vcat-n{margin:0;font-size:13px;line-height:1.45}
.vcat-dl{margin:0;display:grid;grid-template-columns:auto minmax(0,1fr);gap:3px 10px;font-size:12px}
.vcat-dl dt{color:var(--muted)}
.vcat-dl dd{margin:0;overflow-wrap:anywhere}
.vcat-links{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:auto;padding-top:4px;font-size:12.5px;align-items:center}
.vcat-links a{color:var(--ink);text-decoration:underline;text-underline-offset:3px}
.vcat-links button{font:600 12px var(--body);padding:5px 10px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer}
</style>
