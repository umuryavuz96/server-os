<script setup lang="ts">
// Entity picker for Home Assistant cards: search by name, id or area, narrow by domain, pick one (or several for a group).
import { onMounted, ref, watch } from "vue";
import { api, type HaEntity } from "../store";
import Icon from "../components/Icon.vue";

const props = defineProps<{ modelValue: string | string[] | undefined; multi?: boolean; domains?: string[] }>();
const emit = defineEmits<{ "update:modelValue": [v: string | string[]]; pick: [e: HaEntity] }>();
const q = ref(""), domain = ref(props.domains?.length === 1 ? props.domains[0] : "");
const rows = ref<HaEntity[]>([]), total = ref(0), all = ref<{ domain: string; count: number }[]>([]), err = ref("");
const picked = (id: string) => (Array.isArray(props.modelValue) ? props.modelValue.includes(id) : props.modelValue === id);

let t: ReturnType<typeof setTimeout> | undefined;
async function load() {
  try {
    const r = await api<{ total: number; entities: HaEntity[]; domains: { domain: string; count: number }[] }>(`/ha/entities?limit=40&q=${encodeURIComponent(q.value)}&domain=${domain.value}`);
    rows.value = r.entities; total.value = r.total; all.value = r.domains; err.value = "";
  } catch (e) { err.value = (e as Error).message; }
}
watch([q, domain], () => { clearTimeout(t); t = setTimeout(load, 200); });
onMounted(load);
function pick(e: HaEntity) {
  if (props.multi) {
    const cur = Array.isArray(props.modelValue) ? props.modelValue : [];
    emit("update:modelValue", cur.includes(e.id) ? cur.filter((x) => x !== e.id) : [...cur, e.id].slice(0, 20));
  } else emit("update:modelValue", e.id);
  emit("pick", e);
}
const shown = () => (props.domains?.length ? all.value.filter((d) => props.domains!.includes(d.domain)) : all.value);
</script>

<template>
  <div class="hp">
    <div class="fld-row">
      <label class="fld">Search<input v-model="q" type="search" placeholder="name, id or room" autocomplete="off" /></label>
      <label class="fld">Domain<select v-model="domain"><option value="">all</option><option v-for="d in shown()" :key="d.domain" :value="d.domain">{{ d.domain }} ({{ d.count }})</option></select></label>
    </div>
    <p v-if="err" class="form-err">{{ err }}</p>
    <div class="hp-list" role="listbox" :aria-multiselectable="multi">
      <button v-for="e in rows" :key="e.id" type="button" class="hp-row" role="option" :aria-selected="picked(e.id)" :aria-pressed="picked(e.id)" @click="pick(e)">
        <b>{{ e.name }}</b><small>{{ e.id }}{{ e.area ? " · " + e.area : "" }} · {{ e.state }}{{ e.unit ? " " + e.unit : "" }}</small>
      </button>
      <p v-if="!rows.length && !err" class="hint" style="padding: 10px">Nothing matches.</p>
    </div>
    <p class="hint"><Icon name="search" :size="12" /> {{ total > rows.length ? `Showing ${rows.length} of ${total}. Type to narrow it down.` : `${total} ${total === 1 ? "entity" : "entities"}` }}</p>
  </div>
</template>
