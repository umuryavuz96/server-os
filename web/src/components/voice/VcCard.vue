<script setup lang="ts">
// A ```card block: a titled card with an optional image, badge, short body, label/value fields and a link.
import { ref } from "vue";
import { domainOf, type Card } from "../../chat/blocks";

defineProps<{ card: Card }>();
const imgOk = ref(true);
</script>

<template>
  <article class="vc-card">
    <img v-if="card.image && imgOk" class="vc-card-img" :src="card.image" alt="" loading="lazy" referrerpolicy="no-referrer" @error="imgOk = false" />
    <div class="vc-card-b">
      <div class="vc-card-h">
        <span class="vc-card-tt"><b>{{ card.title }}</b><small v-if="card.subtitle">{{ card.subtitle }}</small></span>
        <span v-if="card.badge" class="vc-card-badge">{{ card.badge }}</span>
      </div>
      <p v-if="card.body" class="vc-card-p">{{ card.body }}</p>
      <dl v-if="card.fields?.length" class="vc-card-f">
        <div v-for="f in card.fields" :key="f.label"><dt>{{ f.label }}</dt><dd>{{ f.value }}</dd></div>
      </dl>
      <a v-if="card.url" class="vc-card-a" :href="card.url" target="_blank" rel="noopener noreferrer">{{ domainOf(card.url) }} ↗</a>
    </div>
  </article>
</template>

<style scoped>
.vc-card{margin:4px 0;border:1px solid var(--line);border-radius:14px;background:linear-gradient(180deg,#151518,#111113);overflow:hidden;max-width:460px}
.vc-card-img{display:block;width:100%;aspect-ratio:16/8;object-fit:cover;background:#1a1a1d}
.vc-card-b{display:flex;flex-direction:column;gap:9px;padding:12px 14px}
.vc-card-h{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.vc-card-tt{display:flex;flex-direction:column;gap:2px;min-width:0}
.vc-card-tt b{font:700 16px/1.2 var(--body)}
.vc-card-tt small{font-size:12.5px;color:var(--muted)}
.vc-card-badge{flex:none;font:700 10.5px var(--body);letter-spacing:.06em;text-transform:uppercase;padding:4px 8px;border-radius:999px;color:#ffcfbd;background:rgba(217,119,87,.16);border:1px solid rgba(217,119,87,.35)}
.vc-card-p{margin:0;font-size:13.5px;line-height:1.45;color:#d6d6db}
.vc-card-f{margin:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:6px}
.vc-card-f div{padding:7px 9px;border-radius:9px;background:#0b0b0d;border:1px solid #1d1d21;min-width:0}
.vc-card-f dt{font:600 10.5px var(--body);letter-spacing:.06em;text-transform:uppercase;color:#7b7b83}
.vc-card-f dd{margin:2px 0 0;font:600 13.5px var(--body);color:var(--ink);overflow-wrap:anywhere}
.vc-card-a{align-self:flex-start;font:600 12.5px var(--mono);color:var(--ink);text-decoration:none;border-bottom:1px solid #3a3a40}
.vc-card-a:hover{border-color:var(--ink)}
</style>
