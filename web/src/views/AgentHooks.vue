<script setup lang="ts">
// Hooks tab of the Agent network page: every Claude Code hook from ~/.claude/settings.json with a plain description,
// an on/off switch (the server backs up settings.json, validates it and can roll back) and, where a log exists,
// how the hook has been doing (runs, failures, latency, last runs).
import { ref, computed, onMounted } from "vue";
import { api, ago, toast } from "../store";
import Icon from "../components/Icon.vue";

interface Run { at: number; ms: number | null; ok: boolean; text: string }
interface HookInfo { id: string; event: string; matcher: string | null; command: string; script: string; timeout: number | null; enabled: boolean; name: string; about: string; log: string | null; runs: number; failures: number; avgMs: number | null; p95Ms: number | null; lastAt: number | null; recent: Run[] }
interface Res { hooks: HookInfo[]; backups: string[]; error?: string }

const hooks = ref<HookInfo[]>([]), backups = ref<string[]>([]), err = ref(""), loaded = ref(false), busy = ref<string | null>(null), open = ref<string | null>(null);
const ORDER = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Notification", "Stop", "StopFailure", "SubagentStop", "SessionEnd"];
const groups = computed(() => {
  const m = new Map<string, HookInfo[]>();
  for (const h of hooks.value) (m.get(h.event) ?? m.set(h.event, []).get(h.event)!).push(h);
  return [...m.entries()].sort((a, b) => (ORDER.indexOf(a[0]) + 99) % 99 - (ORDER.indexOf(b[0]) + 99) % 99 || a[0].localeCompare(b[0]));
});
const off = computed(() => hooks.value.filter((h) => !h.enabled).length);
const take = (r: Res) => { hooks.value = r.hooks; backups.value = r.backups; err.value = r.error ?? ""; loaded.value = true; };
async function load() { try { take(await api<Res>("/agent-hooks")); } catch (e) { err.value = (e as Error).message; loaded.value = true; } }
async function toggle(h: HookInfo) {
  if (busy.value) return; busy.value = h.id;
  try { take(await api<Res>(`/agent-hooks/${h.id}/enabled`, { body: { enabled: !h.enabled } })); toast(`${h.name} ${h.enabled ? "switched on" : "switched off"}`); }
  catch (e) { toast((e as Error).message); } finally { busy.value = null; }
}
async function rollback() {
  if (busy.value) return; busy.value = "rollback";
  try { const r = await api<Res & { restored: string }>("/agent-hooks/rollback", { body: {} }); take(r); toast(`Restored ${r.restored}`); }
  catch (e) { toast((e as Error).message); } finally { busy.value = null; }
}
const ms = (n: number | null) => (n == null ? "—" : n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`);
onMounted(load);
</script>

<template>
  <section class="ah" aria-label="Claude Code hooks">
    <header class="ah-top">
      <p class="ah-intro">Hooks run on Claude Code events, before or after Claude acts. Switching one off takes it out of <code>~/.claude/settings.json</code> (a backup is made first); it applies to new sessions.</p>
      <div class="ah-tools">
        <span class="num ah-sum">{{ hooks.length }} hooks · {{ off }} off</span>
        <button type="button" class="ah-btn" :disabled="!backups.length || !!busy" :title="backups.length ? 'Put the newest backup of settings.json back' : 'No backup yet'" @click="rollback"><Icon name="history" :size="13" /> Roll back</button>
      </div>
    </header>
    <p v-if="err" class="ah-err" role="alert">{{ err }}</p>
    <p v-else-if="loaded && !hooks.length" class="ah-empty">No hooks configured.</p>
    <div v-for="[ev, list] in groups" :key="ev" class="ah-grp">
      <h2>{{ ev }}</h2>
      <ul>
        <li v-for="h in list" :key="h.id" class="ah-row" :class="{ off: !h.enabled, expanded: open === h.id }">
          <div class="ah-main">
            <button type="button" class="ah-head" :aria-expanded="open === h.id" @click="open = open === h.id ? null : h.id">
              <span class="ah-name">{{ h.name }}</span>
              <span v-if="h.matcher" class="ah-tag">on {{ h.matcher }}</span>
              <span v-if="h.timeout" class="ah-tag num">{{ h.timeout }} s limit</span>
              <span v-if="h.runs" class="ah-tag num" :class="{ bad: h.failures }">{{ h.runs }} runs<template v-if="h.failures"> · {{ h.failures }} failed</template></span>
            </button>
            <p class="ah-about">{{ h.about }}</p>
            <div v-if="open === h.id" class="ah-more">
              <code class="ah-cmd">{{ h.command }}</code>
              <template v-if="h.log">
                <dl class="ah-stats num">
                  <div><dt>Runs</dt><dd>{{ h.runs }}</dd></div><div><dt>Failed</dt><dd :class="{ bad: h.failures }">{{ h.failures }}</dd></div>
                  <div><dt>Average</dt><dd>{{ ms(h.avgMs) }}</dd></div><div><dt>Slowest 5%</dt><dd>{{ ms(h.p95Ms) }}</dd></div>
                  <div><dt>Last run</dt><dd>{{ h.lastAt ? ago(h.lastAt / 1000) : "—" }}</dd></div>
                </dl>
                <ol class="ah-runs">
                  <li v-for="r in h.recent" :key="r.at" :class="{ bad: !r.ok }"><span class="num">{{ ago(r.at / 1000) }}</span><span class="num">{{ ms(r.ms) }}</span><span class="ah-txt">{{ r.text || (r.ok ? "ok" : "failed") }}</span></li>
                </ol>
              </template>
              <p v-else class="ah-nolog">This hook keeps no log, so there are no run numbers.</p>
            </div>
          </div>
          <button type="button" class="sw" role="switch" :aria-checked="h.enabled" :aria-label="`${h.name}: ${h.enabled ? 'on' : 'off'}`" :class="{ busy: busy === h.id }" :disabled="!!busy" @click="toggle(h)"></button>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.ah{display:flex;flex-direction:column;gap:14px;overflow:auto;min-height:0;padding-bottom:24px}
.ah-top{display:flex;gap:16px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap}
.ah-intro{margin:0;max-width:62ch;color:var(--muted);font:400 13px/1.5 var(--body)}
.ah-intro code,.ah-cmd{font:500 12px var(--mono)}
.ah-tools{display:flex;align-items:center;gap:12px;margin-left:auto}
.ah-sum{color:var(--muted);font:400 12.5px var(--body)}
.ah-btn{display:inline-flex;align-items:center;gap:6px;min-height:36px;padding:0 12px;border-radius:9px;border:1px solid var(--hair);background:var(--soft);color:var(--ink);font:600 12.5px var(--body);cursor:pointer}
.ah-btn:disabled{opacity:.45;cursor:default}
.ah-err{color:var(--warn);margin:0}.ah-empty{color:var(--muted)}
.ah-grp h2{margin:0 0 6px;font:600 11px var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.ah-grp ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.ah-row{display:flex;gap:14px;align-items:flex-start;justify-content:space-between;padding:12px 14px;border-radius:14px;border:1px solid var(--hair);background:var(--soft);transition:opacity .2s,border-color .2s}
.ah-row.expanded{border-color:rgba(255,255,255,.2)}
.ah-row.off{opacity:.55}
.ah-main{min-width:0;flex:1}
.ah-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;background:none;border:0;padding:0;color:var(--ink);cursor:pointer;text-align:left;min-height:28px}
.ah-name{font:600 14px var(--body)}
.ah-tag{font:500 11px var(--mono);color:var(--muted);padding:2px 7px;border-radius:999px;border:1px solid var(--hair)}
.ah-tag.bad,.bad{color:var(--warn)}
.ah-about{margin:4px 0 0;color:var(--muted);font:400 13px/1.45 var(--body)}
.ah-more{margin-top:10px;display:flex;flex-direction:column;gap:10px;animation:ahin .2s ease-out}
@keyframes ahin{from{opacity:0;transform:translateY(-4px)}}
.ah-cmd{display:block;padding:8px 10px;border-radius:8px;background:rgba(0,0,0,.3);overflow-wrap:anywhere;color:var(--muted)}
.ah-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(88px,1fr));gap:8px;margin:0}
.ah-stats div{padding:8px 10px;border-radius:10px;background:rgba(0,0,0,.22)}
.ah-stats dt{font:500 11px var(--body);color:var(--muted)}.ah-stats dd{margin:2px 0 0;font:600 15px var(--body)}
.ah-runs{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.ah-runs li{display:grid;grid-template-columns:84px 64px 1fr;gap:10px;font:400 12.5px var(--body);color:var(--muted);padding:3px 0;border-top:1px solid var(--hair)}
.ah-txt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ah-nolog{margin:0;color:var(--muted);font:400 12.5px var(--body)}
@media (prefers-reduced-motion:reduce){.ah-more{animation:none}}
@media (max-width:640px){.ah-runs li{grid-template-columns:70px 54px 1fr}}
</style>
