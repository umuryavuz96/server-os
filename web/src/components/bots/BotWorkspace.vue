<script setup lang="ts">
// Workspace tab of a native bot: its identity, scope (folders, network, sandbox), tool rules, skills/plugins/MCP,
// secrets, isolation and Telegram owners. Saved into the bot's own Claude Code config (.claude/settings.json, .mcp.json,
// .claude/skills, CLAUDE.md) by /cos/bot/save-settings; a restart applies it to a running bot.
import { ref, computed, watch } from "vue";
import { post, toast, type BotSession } from "../../store";

interface Policy {
  scope: { folders: { path: string; write: boolean }[]; network: boolean; sandbox: boolean; readAnywhere?: boolean };
  tools: { preset: "safe" | "dev" | "full"; allow: string[]; deny: string[] };
  skills: Record<string, boolean>; plugins: Record<string, boolean>; mcp: Record<string, boolean>;
  secrets: string[]; isolated: boolean; globalInstructions: boolean; role: string;
}
interface Settings {
  ok: boolean; error?: string; policy: Policy; permissionMode: string; cwd: string; ownerChatIds: string[]; defaultOwnerChatIds: string[]; configDir: string;
  catalog: { skills: { id: string; name: string; source: "global" | "agents"; description: string }[]; plugins: { id: string; enabled: boolean }[];
    mcp: { id: string; name: string; source: "user" | "mcpjson" }[]; envKeys: string[] };
  agmsg: { installed: boolean; team?: string; scripts?: string; repo?: string; install?: string };
}
const props = defineProps<{ bot: BotSession }>();
const s = ref<Settings | null>(null), p = ref<Policy | null>(null), busy = ref(false);
const form = ref({ permissionMode: "dontAsk", allow: "", deny: "", owners: "", newFolder: "" });

async function load() {
  s.value = null;
  try {
    const j = await (await fetch(`/svc-api/cos/bot/settings?channel=${encodeURIComponent(props.bot.channel)}`)).json() as Settings;
    if (!j.ok) { toast(j.error ?? "Couldn't load settings"); return; }
    s.value = j; p.value = structuredClone(j.policy);
    form.value = { permissionMode: j.permissionMode, allow: j.policy.tools.allow.join("\n"), deny: j.policy.tools.deny.join("\n"), owners: j.ownerChatIds.join(", "), newFolder: "" };
  } catch (e) { toast(String(e)); }
}
watch(() => props.bot.channel, load, { immediate: true });

const PRESETS = [["safe", "Safe", "Read, edit its folders, a few shell commands. No rm -rf, sudo, git push, curl | sh."],
  ["dev", "Dev", "Any shell command except sudo, force-push, rm -rf of / or ~, curl | sh."], ["full", "Full", "Every tool. Scope and secrets rules still apply."]] as const;
const MODES = [["dontAsk", "Deny unlisted (recommended)"], ["default", "Ask (waits in the terminal)"], ["acceptEdits", "Accept edits"], ["auto", "Auto"], ["plan", "Plan"], ["bypassPermissions", "Bypass"]] as const;
const skillOn = (id: string, source: string) => p.value!.skills[id] ?? (source === "global" && !p.value!.isolated);
const mcpOn = (id: string) => p.value!.mcp[id] ?? (id.startsWith("user:") && !p.value!.isolated);
const pluginOn = (id: string, dflt: boolean) => p.value!.plugins[id] ?? dflt;
const flip = (k: "skills" | "mcp" | "plugins", id: string, cur: boolean) => { p.value![k] = { ...p.value![k], [id]: !cur }; };
const toggleSecret = (k: string) => { const l = p.value!.secrets; p.value!.secrets = l.includes(k) ? l.filter((x) => x !== k) : [...l, k]; };
function addFolder() { const f = form.value.newFolder.trim(); if (!f) return; p.value!.scope.folders.push({ path: f, write: false }); form.value.newFolder = ""; }
const home = (x: string) => x.replace(/^\/Users\/[^/]+/, "~");
const envKeys = computed(() => (s.value?.catalog.envKeys ?? []).filter((k) => k !== props.bot.tokenKey));

async function save() {
  if (!p.value || busy.value) return;
  busy.value = true;
  const v = p.value, f = form.value;
  const j = await post<{ ok?: boolean; error?: string; detail?: string }>("/svc-api/cos/bot/save-settings", {
    channel: props.bot.channel, role: v.role, preset: v.tools.preset, allow: f.allow, deny: f.deny, folders: v.scope.folders,
    network: v.scope.network, sandbox: v.scope.sandbox, readAnywhere: !!v.scope.readAnywhere, isolated: v.isolated, globalInstructions: v.globalInstructions, secrets: v.secrets, skills: v.skills, plugins: v.plugins, mcp: v.mcp,
    permissionMode: f.permissionMode, ...(props.bot.telegram ? { ownerChatIds: f.owners } : {}),
  }).catch((e) => ({ ok: false, error: String(e), detail: undefined }));
  busy.value = false;
  toast(j.ok === false ? j.error ?? "Save failed" : j.detail ?? "Saved");
  if (j.ok !== false) await load();
}
</script>

<template>
  <div class="bwk">
    <p v-if="!s || !p" class="hint">Loading…</p>
    <form v-else class="bwk-grid" @submit.prevent="save">
      <section class="card bwk-s">
        <h3>Identity</h3>
        <label class="bwk-l">Role <input v-model="p.role" placeholder="e.g. researcher — finds and summarises sources" maxlength="200" /></label>
        <p class="hint">Written into the identity block of <code>CLAUDE.md</code> with the owner, the other bots and how to reach them. Edit the rest of the persona under Instructions.</p>
        <div class="bwk-team">
          <template v-if="s.agmsg.installed"><span class="pill p-on">AGMSG</span> team <b>{{ s.agmsg.team }}</b> as <b>{{ bot.channel }}</b> · monitor delivery</template>
          <template v-else><span class="pill p-off">AGMSG MISSING</span> Bots can't message each other yet. Install agmsg (<a :href="s.agmsg.repo" target="_blank" rel="noopener">fujibee/agmsg</a>, MIT): <code>{{ s.agmsg.install }}</code>, then restart Server OS.</template>
        </div>
      </section>

      <section class="card bwk-s">
        <h3>Scope</h3>
        <div class="bwk-f"><code>{{ home(s.cwd) }}</code><span class="pill p-on">READ + WRITE</span><small class="muted">own folder</small></div>
        <div v-for="(f, i) in p.scope.folders" :key="i" class="bwk-f">
          <code>{{ home(f.path) }}</code>
          <button type="button" class="btn sm" :aria-pressed="f.write" @click="f.write = !f.write">{{ f.write ? "Read + write" : "Read only" }}</button>
          <button type="button" class="btn sm ghost" :aria-label="`Remove ${f.path}`" @click="p.scope.folders.splice(i, 1)">✕</button>
        </div>
        <div class="bwk-f"><input v-model="form.newFolder" placeholder="/absolute/folder or ~/folder" aria-label="Add a folder" @keydown.enter.prevent="addFolder" /><button type="button" class="btn sm" @click="addFolder">Add folder</button></div>
        <p class="hint">{{ p.scope.readAnywhere ? "Read anywhere is on: the Read tool may also open files outside these folders. " : "Everything else is off limits: reads outside these folders are refused. " }}Always denied: <code>~/.env</code>, <code>~/.ssh</code>, <code>~/.claude.json</code>.</p>
        <div class="bwk-t"><span>Network <small class="muted">web tools, curl, git fetch</small></span><button type="button" class="sw sm" role="switch" :aria-checked="p.scope.network" aria-label="Network" @click="p.scope.network = !p.scope.network"></button></div>
        <div class="bwk-t"><span>Read anywhere <small class="muted">Read tool outside these folders (secret files stay blocked)</small></span><button type="button" class="sw sm" role="switch" :aria-checked="!!p.scope.readAnywhere" aria-label="Read anywhere" @click="p.scope.readAnywhere = !p.scope.readAnywhere"></button></div>
        <div class="bwk-t"><span>Sandbox <small class="muted">OS-enforced limits for shell commands (Claude Code sandbox)</small></span><button type="button" class="sw sm" role="switch" :aria-checked="p.scope.sandbox" aria-label="Sandbox" @click="p.scope.sandbox = !p.scope.sandbox"></button></div>
      </section>

      <section class="card bwk-s">
        <h3>Tool rules</h3>
        <div class="seg2 bwk-seg" role="radiogroup" aria-label="Preset">
          <button v-for="[id, name] in PRESETS" :key="id" type="button" role="radio" :aria-checked="p.tools.preset === id" @click="p.tools.preset = id">{{ name }}</button>
        </div>
        <p class="hint">{{ PRESETS.find((x) => x[0] === p!.tools.preset)?.[2] }}</p>
        <label class="bwk-l">When a rule doesn't match<select v-model="form.permissionMode"><option v-for="[id, name] in MODES" :key="id" :value="id">{{ name }}</option></select></label>
        <div class="frow">
          <label class="bwk-l">Also allow <textarea v-model="form.allow" rows="3" placeholder="Bash(npm run *)&#10;WebFetch(domain:docs.example.com)" spellcheck="false"></textarea></label>
          <label class="bwk-l">Also deny <textarea v-model="form.deny" rows="3" placeholder="Bash(docker *)" spellcheck="false"></textarea></label>
        </div>
        <p class="hint">Claude Code permission rules, one per line. Deny wins.</p>
      </section>

      <section class="card bwk-s">
        <h3>Skills &amp; MCP</h3>
        <div class="bwk-chips">
          <button v-for="sk in s.catalog.skills" :key="sk.id" type="button" class="chip" :aria-pressed="skillOn(sk.id, sk.source)" :title="sk.description" @click="flip('skills', sk.id, skillOn(sk.id, sk.source))">{{ sk.name }}<small>{{ sk.source === "global" ? "" : " · " + sk.source }}</small></button>
        </div>
        <div class="bwk-chips">
          <button v-for="m in s.catalog.mcp" :key="m.id" type="button" class="chip mcp" :aria-pressed="mcpOn(m.id)" @click="flip('mcp', m.id, mcpOn(m.id))">{{ m.name }}<small> · {{ m.source === "user" ? "user" : ".mcp.json" }}</small></button>
        </div>
        <div v-if="!p.isolated" class="bwk-chips">
          <button v-for="pl in s.catalog.plugins" :key="pl.id" type="button" class="chip plug" :aria-pressed="pluginOn(pl.id, pl.enabled)" @click="flip('plugins', pl.id, pluginOn(pl.id, pl.enabled))">{{ pl.id.split("@")[0] }}</button>
        </div>
        <p class="hint">Global skills, plugins and user MCP servers are switched off per bot in its settings; other skills are linked into its <code>.claude/skills</code>, <code>.mcp.json</code> servers copied into its folder. Global files are never changed.</p>
      </section>

      <section class="card bwk-s">
        <h3>Secrets</h3>
        <div class="bwk-chips">
          <button v-for="k in envKeys" :key="k" type="button" class="chip key" :aria-pressed="p.secrets.includes(k)" @click="toggleSecret(k)">{{ k }}</button>
          <span v-if="!envKeys.length" class="muted">No variables in ~/.env.</span>
        </div>
        <p class="hint">Only ticked ~/.env variables are exported to the bot; nothing else from ~/.env or the tmux environment reaches it. It still runs as your OS user, so treat the scope above as the real boundary.</p>
        <div class="bwk-t"><span>Isolated <small class="muted">own Claude config: plugins, MCP, memory, login</small></span><button type="button" class="sw sm" role="switch" :aria-checked="p.isolated" aria-label="Isolated" @click="p.isolated = !p.isolated"></button></div>
        <p v-if="p.isolated" class="hint warn">Uses <code>{{ home(s.configDir) }}</code> as CLAUDE_CONFIG_DIR. Needs its own login: on first start, open Terminal and run <kbd>/login</kbd>.</p>
        <div v-if="!p.isolated" class="bwk-t"><span>Use my global instructions <small class="muted">~/.claude/CLAUDE.md and ~/.claude/rules</small></span><button type="button" class="sw sm" role="switch" :aria-checked="p.globalInstructions" aria-label="Use my global instructions" @click="p.globalInstructions = !p.globalInstructions"></button></div>
        <label v-if="bot.telegram" class="bwk-l">Telegram owner chat ids <input v-model="form.owners" placeholder="123456789" inputmode="numeric" />
          <small class="muted">Pre-approved in its access.json{{ s.defaultOwnerChatIds.length ? ` with ${s.defaultOwnerChatIds.join(", ")} from config` : "" }}.</small></label>
      </section>

      <div class="bwk-save"><span class="muted">{{ bot.running ? "Saved changes apply on restart." : "Applied on the next launch." }}</span><button type="submit" class="btn primary" :disabled="busy">{{ busy ? "Saving…" : "Save workspace" }}</button></div>
    </form>
  </div>
</template>

<style scoped>
.bwk { overflow: auto; padding: 16px 22px 28px; flex: 1; min-height: 0; }
.bwk-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 12px; align-items: start; }
.bwk-s { display: flex; flex-direction: column; gap: 9px; }
.bwk-s h3 { margin: 0; font-size: 13px; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
.bwk-l { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; font-weight: 600; flex: 1; }
.bwk-l input, .bwk-l select, .bwk-l textarea, .bwk-f input { font: 500 13px var(--body); background: var(--panel-2); color: var(--ink); border: 1px solid var(--line); border-radius: 8px; padding: 7px 9px; }
.bwk-l textarea { font-family: var(--mono); font-size: 12px; resize: vertical; }
.bwk-f { display: flex; align-items: center; gap: 8px; min-width: 0; }
.bwk-f code { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.bwk-f input { flex: 1; min-width: 0; }
.bwk-t { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 13px; font-weight: 600; }
.bwk-t small { display: block; font-weight: 500; }
.bwk-t .sw { margin-top: 0; flex: 0 0 auto; }
.bwk-seg { align-self: flex-start; }
.bwk-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.bwk-chips .chip { font-size: 12px; padding: 5px 10px; opacity: .55; }
.bwk-chips .chip[aria-pressed="true"] { opacity: 1; border-color: var(--on); color: var(--ink); }
.bwk-chips .chip small { color: var(--muted); font-weight: 500; }
.bwk-team { font-size: 12.5px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.bwk-save { grid-column: 1 / -1; display: flex; justify-content: flex-end; align-items: center; gap: 12px; }
.hint { margin: 0; font-size: 12px; color: var(--muted); }
.hint.warn { color: var(--warn); }
.frow { display: flex; gap: 8px; }
</style>
