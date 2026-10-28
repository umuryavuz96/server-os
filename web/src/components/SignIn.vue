<script setup lang="ts">
// The panel's front door. A new server: create the owner account (only on the server itself or with the
// installer's setup link). Afterwards: sign in with that username + password. A code from another signed-in
// device works too ("Use a code").
import { ref, computed, nextTick, onMounted } from "vue";

const props = defineProps<{ owner: boolean; canClaim: boolean }>();
const emit = defineEmits<{ done: [] }>();
const mode = ref<"setup" | "login" | "code">(props.owner ? "login" : "setup");
const username = ref(""), password = ref(""), confirm = ref("");
const busy = ref(false), err = ref("");
const setupToken = new URLSearchParams(location.search).get("setup") ?? "";

function browserName() {
  const ua = navigator.userAgent;
  const b = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Mac OS X/.test(ua) ? "Mac" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${b} on ${os}` : b;
}
async function call(path: string, body: Record<string, unknown>) {
  busy.value = true; err.value = "";
  try {
    const r = await fetch(`/api/v1/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, deviceName: browserName(), web: true }) });
    if (!r.ok) { const p = await r.json().catch(() => ({})); throw new Error(p.detail ?? p.title ?? `HTTP ${r.status}`); }
    if (setupToken) history.replaceState(null, "", location.pathname + location.hash); // the link is spent
    emit("done");
  } catch (e) { err.value = (e as Error).message; }
  busy.value = false;
}
const setupOk = computed(() => username.value.trim().length >= 2 && password.value.length >= 10 && password.value === confirm.value);
const setup = () => setupOk.value && call("auth/setup", { username: username.value.trim(), password: password.value, setupToken });
const login = () => username.value && password.value && call("auth/login", { username: username.value.trim(), password: password.value });

// ---- code ----
const digits = ref<string[]>(["", "", "", "", "", ""]);
const inputs = ref<HTMLInputElement[]>([]);
const code = computed(() => digits.value.join(""));
async function submitCode() {
  if (code.value.length !== 6 || busy.value) return;
  await call("pair", { code: code.value, name: browserName() });
  if (err.value) { digits.value = ["", "", "", "", "", ""]; await nextTick(); inputs.value[0]?.focus(); }
}
function onInput(i: number, e: Event) {
  const v = (e.target as HTMLInputElement).value.replace(/\D/g, "");
  if (v.length > 1) { v.slice(0, 6).split("").forEach((d, k) => { digits.value[k] = d; }); inputs.value[Math.min(5, v.length - 1)]?.focus(); }
  else { digits.value[i] = v; if (v && i < 5) inputs.value[i + 1]?.focus(); }
  if (code.value.length === 6) void submitCode();
}
const onKey = (i: number, e: KeyboardEvent) => { if (e.key === "Backspace" && !digits.value[i] && i > 0) inputs.value[i - 1]?.focus(); };
onMounted(() => (document.querySelector(".signin-card input") as HTMLInputElement | null)?.focus());
</script>

<template>
  <main class="signin">
    <div class="signin-card">
      <div class="logo" aria-hidden="true">SO</div>

      <template v-if="mode === 'setup'">
        <h1>Welcome to Server OS</h1>
        <template v-if="canClaim">
          <p class="muted">Create the owner account. You'll use it to sign in here, and to connect your phone and other devices.</p>
          <form class="form wide" @submit.prevent="setup">
            <label class="fld">Username<input v-model="username" autocomplete="username" autocapitalize="off" spellcheck="false" placeholder="you" /></label>
            <label class="fld">Password<input v-model="password" type="password" autocomplete="new-password" placeholder="At least 10 characters" /></label>
            <label class="fld">Repeat password<input v-model="confirm" type="password" autocomplete="new-password" /></label>
            <p v-if="confirm && password !== confirm" class="form-err">The passwords don't match.</p>
            <p v-if="err" class="form-err" role="alert">{{ err }}</p>
            <button type="submit" class="btn primary big" :disabled="busy || !setupOk">{{ busy ? "Creating…" : "Create account" }}</button>
          </form>
        </template>
        <p v-else class="muted">This server isn't set up yet. Open this page from a device on your home network or tailnet, or use the setup link the installer showed.</p>
      </template>

      <template v-else-if="mode === 'login'">
        <h1>Sign in</h1>
        <form class="form wide" @submit.prevent="login">
          <label class="fld">Username<input v-model="username" autocomplete="username" autocapitalize="off" spellcheck="false" /></label>
          <label class="fld">Password<input v-model="password" type="password" autocomplete="current-password" /></label>
          <p v-if="err" class="form-err" role="alert">{{ err }}</p>
          <button type="submit" class="btn primary big" :disabled="busy || !username || !password">{{ busy ? "Signing in…" : "Sign in" }}</button>
        </form>
        <button type="button" class="nav-link" @click="mode = 'code'; err = ''">Use a code from another device instead</button>
      </template>

      <template v-else>
        <h1>Sign in with a code</h1>
        <p class="muted">On a device that's already signed in, choose <b>Connect a device</b> and type the code it shows.</p>
        <div class="code-in" role="group" aria-label="Code">
          <input v-for="(d, i) in digits" :key="i" :ref="(el) => { if (el) inputs[i] = el as HTMLInputElement; }" :value="d" inputmode="numeric" autocomplete="one-time-code"
            maxlength="6" :aria-label="`Digit ${i + 1}`" :disabled="busy" @input="onInput(i, $event)" @keydown="onKey(i, $event)" />
        </div>
        <p v-if="err" class="form-err" role="alert">{{ err }}</p>
        <button type="button" class="nav-link" @click="mode = 'login'; err = ''">Sign in with username and password</button>
      </template>
    </div>
  </main>
</template>
