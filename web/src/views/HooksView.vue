<script setup lang="ts">
// Webhooks in the dashboard language: one hero-style card per deploy hook with live status, and its log in a drawer.
import { ref, computed } from "vue";
import { S, ago, type Hook } from "../store";

const openSlug = ref<string | null>(null);
const opened = computed(() => (S.hooks ?? []).find((h) => h.slug === openSlug.value) ?? null);
const lvl = (h: Hook) => (h.listening ? "g" : h.state === "not loaded" ? "off" : "r");
const label = (h: Hook) => (h.listening ? "Listening" : h.state === "not loaded" ? "Switched off" : "Not listening");
</script>

<template>
  <main class="page">
    <header class="ph"><h1>Webhooks</h1><span class="muted">deploy receivers · switch them in Apps</span></header>
    <p v-if="!S.hooks" class="hint">Loading…</p>
    <TransitionGroup tag="div" name="tl" class="cards">
      <button v-for="h in S.hooks ?? []" :key="h.slug" type="button" class="card2 hook" :class="'l-' + lvl(h)" @click="openSlug = h.slug">
        <div class="ch"><h3>{{ h.label }}</h3><span class="sdot" :class="lvl(h) === 'g' ? 'ok' : lvl(h) === 'r' ? 'bad' : 'off'"></span></div>
        <div class="hook-v">{{ label(h) }}</div>
        <p class="muted" style="margin: 0; text-align: left">{{ h.description }}</p>
        <div class="kv2"><span>Port</span><b>{{ h.port }}</b></div>
        <div class="kv2"><span>Log updated</span><b>{{ h.logMtime ? ago(h.logMtime) : "—" }}</b></div>
      </button>
    </TransitionGroup>

    <Teleport to="body">
      <Transition name="drawer">
        <div v-if="opened" class="dr-wrap">
          <div class="dr-bg" @click="openSlug = null"></div>
          <aside class="dr" role="dialog" aria-modal="true" :aria-label="opened.label">
            <div class="dr-h"><span class="dr-title">{{ opened.label }}</span><button type="button" class="btn" aria-label="Close" @click="openSlug = null">✕</button></div>
            <div class="dr-b">
              <div class="dbox lifebox">
                <div class="kv2"><span>Status</span><b>{{ label(opened) }}</b></div>
                <div class="kv2"><span>Port</span><b>{{ opened.port }}</b></div>
                <div class="kv2"><span>Log updated</span><b>{{ opened.logMtime ? ago(opened.logMtime) : "—" }}</b></div>
              </div>
              <div class="logsrc">Log (last 25 lines)</div>
              <pre class="log">{{ opened.logTail || "(empty)" }}</pre>
            </div>
          </aside>
        </div>
      </Transition>
    </Teleport>
  </main>
</template>
