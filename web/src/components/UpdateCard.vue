<script setup lang="ts">
// Server OS update: "Update available vX" with the release notes, the Update button, live progress and the outcome
// ("Updated to vX" / "Update failed, rolled back: …"). Overview shows it only when there is something to say; Settings always.
import { computed, ref } from "vue";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { S, api, ago, toast, type UpdateStatus } from "../store";

const props = defineProps<{ always?: boolean }>();
const u = computed(() => S.update ?? null);
const STEPS = ["downloading", "verifying", "installing", "restarting"] as const;
const busy = computed(() => !!u.value && (STEPS as readonly string[]).includes(u.value.state));
const stepIdx = computed(() => (u.value ? STEPS.indexOf(u.value.state as (typeof STEPS)[number]) : -1));
const STEP_LABEL = { downloading: "Download", verifying: "Verify signature", installing: "Install", restarting: "Restart + health check" };
// An outcome from the last three days is news; older ones only show on Settings.
const recent = computed(() => !!u.value?.last && Date.now() - u.value.last.at < 3 * 86400_000);
const dismissed = ref(localStorageGet("sos.update.dismissed"));
const visible = computed(() => !!u.value && (props.always || busy.value || u.value.state === "failed" || u.value.updateAvailable || (recent.value && dismissed.value !== String(u.value.last!.at))));

function localStorageGet(k: string) { try { return localStorage.getItem(k) ?? ""; } catch { return ""; } }
function dismiss() { if (!u.value?.last) return; dismissed.value = String(u.value.last.at); try { localStorage.setItem("sos.update.dismissed", dismissed.value); } catch { /* private mode */ } }

// Release notes are Markdown from GitHub: rendered, then sanitized (no scripts, images, frames, forms, styles); links open outside.
const notes = computed(() => {
  const md = u.value?.latest?.notes?.trim();
  if (!md) return "";
  const html = DOMPurify.sanitize(marked.parse(md, { gfm: true, breaks: false, async: false }) as string,
    { FORBID_TAGS: ["style", "img", "iframe", "form", "input", "video", "audio", "svg", "math"], FORBID_ATTR: ["style"] });
  return html.replace(/<a /g, '<a target="_blank" rel="noopener noreferrer" ');
});
const showNotes = ref(false);

const isDev = computed(() => u.value?.mode === "git");
const working = ref(false);
async function update() {
  const l = u.value?.latest;
  if (!l) return;
  const what = isDev.value ? `Fast-forward this git checkout (${u.value!.dev?.upstream ?? "origin"}, ${u.value!.dev?.behind ?? 0} new commit(s)) and rebuild` : `Update Server OS ${u.value!.current} → ${l.tag}`;
  if (!window.confirm(`${what}?\n\nThe server restarts (about a minute). If the new version doesn't come up, it switches back by itself.`)) return;
  working.value = true;
  try { S.update = await api<UpdateStatus>("/update/apply", { method: "POST", body: {} }); } catch (e) { toast((e as Error).message); }
  working.value = false;
}
const checking = ref(false);
async function check() {
  checking.value = true;
  try { S.update = await api<UpdateStatus>("/update/check", { method: "POST", body: {} }); toast(S.update?.updateAvailable ? `${S.update.latest?.tag} is available` : S.update?.checkError ?? "Server OS is up to date"); }
  catch (e) { toast((e as Error).message); }
  checking.value = false;
}
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");
</script>

<template>
  <section v-if="visible && u" class="card2 upd" :class="{ avail: u.updateAvailable && !busy, bad: u.state === 'failed' || (recent && u.last && !u.last.ok && !u.updateAvailable) }" aria-label="Server OS update" aria-live="polite">
    <!-- in progress -->
    <template v-if="busy">
      <div class="ch"><h3>Updating to {{ u.latest?.tag }}</h3><span class="muted num">{{ u.current }} → {{ u.latest?.version }}</span></div>
      <ol class="upd-steps">
        <li v-for="(s, i) in STEPS" :key="s" :class="{ done: i < stepIdx, now: i === stepIdx }"><span class="sdot" :class="i < stepIdx ? 'ok' : i === stepIdx ? 'warn' : 'off'"></span>{{ STEP_LABEL[s] }}</li>
      </ol>
      <p class="hint">{{ u.detail }}<template v-if="u.state === 'restarting'"> · the panel reconnects by itself; if the new version doesn't answer within 45 s it rolls back.</template></p>
    </template>

    <!-- available -->
    <template v-else-if="u.updateAvailable && u.latest">
      <div class="ch">
        <h3>Update available <span class="num">{{ u.latest.tag }}</span></h3>
        <span class="muted"><span v-if="u.latest.prerelease" class="pill p-part">beta</span> {{ when(u.latest.publishedAt) }}</span>
      </div>
      <p class="hint">You run <b class="num">{{ u.current }}</b>.<template v-if="u.last && !u.last.ok && u.last.to === u.latest.version"> The last try failed{{ u.last.rolledBack ? " and was rolled back" : "" }}: {{ u.last.reason }}</template></p>
      <div v-if="notes" class="upd-notes">
        <!-- eslint-disable-next-line vue/no-v-html — Markdown sanitized with DOMPurify above -->
        <div class="md" :class="{ clip: !showNotes && !props.always }" v-html="notes"></div>
        <button v-if="!props.always" type="button" class="linkbtn" @click="showNotes = !showNotes">{{ showNotes ? "Show less" : "Release notes" }}</button>
      </div>
      <p v-if="u.blocked" class="upd-block">{{ u.blocked }}</p>
      <div class="upd-act">
        <button v-if="!u.blocked" type="button" class="btn primary" :disabled="working || !u.canApply" @click="update">{{ working ? "Starting…" : u.last && !u.last.ok && u.last.to === u.latest.version ? `Try ${u.latest.tag} again` : `Update to ${u.latest.tag}` }}<template v-if="isDev && !working"> (developer checkout)</template></button>
        <button v-if="props.always" type="button" class="btn" :disabled="checking" @click="check">{{ checking ? "Checking…" : "Check again" }}</button>
        <a v-if="u.latest.url" class="btn ghost" :href="u.latest.url" target="_blank" rel="noopener noreferrer">On GitHub</a>
        <span class="hint">{{ isDev ? `Developer checkout${u.dev?.upstream ? ` · ${u.dev.upstream}` : ""}` : "Signed release" }} · checked {{ ago(u.checkedAt ? u.checkedAt / 1000 : null) }}</span>
      </div>
    </template>

    <!-- outcome / failure / up to date -->
    <template v-else>
      <div class="ch">
        <h3 v-if="u.state === 'failed'">Update failed</h3>
        <h3 v-else-if="u.last && recent && u.last.ok">Updated to <span class="num">v{{ u.last.to }}</span></h3>
        <h3 v-else-if="u.last && recent">Update failed, rolled back</h3>
        <h3 v-else>Server OS <span class="num">{{ u.current }}</span></h3>
        <button v-if="!props.always && u.last && recent && u.state !== 'failed'" type="button" class="btn sm ghost" aria-label="Dismiss" @click="dismiss">✕</button>
      </div>
      <p v-if="u.state === 'failed'" class="hint">{{ u.error }} Nothing was changed; {{ u.current }} keeps running.</p>
      <p v-else-if="u.last && recent && u.last.ok" class="hint">{{ u.last.from }} → {{ u.last.to }}, {{ ago(u.last.at / 1000) }}. The previous version is kept for rollback.</p>
      <p v-else-if="u.last && recent" class="hint">{{ u.last.reason }}. {{ u.last.rolledBack ? `Back on ${u.last.from}, nothing lost.` : "The rollback did not come up either — check logs/update.log." }}</p>
      <p v-else class="hint">Up to date<template v-if="u.checkedAt"> · checked {{ ago(u.checkedAt / 1000) }}</template>.<template v-if="u.checkError"> {{ u.checkError }}</template></p>
      <p v-if="props.always && u.blocked && u.mode !== 'release' && !u.updateAvailable" class="upd-block">{{ u.blocked }}</p>
    </template>

    <div v-if="props.always && !busy && !(u.updateAvailable && u.latest)" class="upd-act">
      <button type="button" class="btn" :disabled="checking || u.state === 'checking'" @click="check">{{ checking || u.state === "checking" ? "Checking…" : "Check now" }}</button>
    </div>
  </section>
</template>

<style scoped>
.upd{gap:8px}
.upd.avail{border-color:rgba(47,211,138,.45);background:linear-gradient(180deg,rgba(47,211,138,.07),transparent 60%),var(--panel)}
.upd.bad{border-color:rgba(255,59,69,.45)}
.upd .ch{margin-bottom:0;gap:10px}
.upd .ch h3 .num{font-size:15px}
.upd-steps{list-style:none;margin:4px 0;padding:0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.upd-steps li{display:flex;align-items:center;gap:7px;font-size:13px;color:var(--muted)}
.upd-steps li.done,.upd-steps li.now{color:var(--ink)}
.upd-steps li.now .sdot{animation:dp 1.4s ease-in-out infinite}
@media(max-width:620px){.upd-steps{grid-template-columns:repeat(2,minmax(0,1fr))}}
.upd-notes{border-top:1px solid #1d1d21;padding-top:8px;font-size:13.5px;color:#d4d4d8}
.upd-notes .md.clip{max-height:4.6em;overflow:hidden;-webkit-mask-image:linear-gradient(#000 55%,transparent)}
.upd-notes .md :deep(h2),.upd-notes .md :deep(h3){font:700 14px var(--body);margin:2px 0 6px;text-transform:none;letter-spacing:0;color:var(--ink)}
.linkbtn{background:none;border:0;padding:4px 0;color:var(--muted);font:600 12.5px var(--body);cursor:pointer}
.linkbtn:hover{color:var(--ink)}
.upd-block{margin:0;padding:8px 10px;border-radius:9px;background:#151518;border:1px solid var(--line);font-size:13px;color:#d4d4d8}
.upd-act{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;margin-top:4px}
.upd-act .btn{text-decoration:none;display:inline-flex;align-items:center}
</style>
