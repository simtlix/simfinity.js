<script setup>
import { computed } from 'vue';

const props = defineProps({ kind: { type: String, default: 'relationships' } });
const diagrams = {
  relationships: { label: 'Two ways to connect your domain', rows: [
    { start: 'Embedded', middle: 'Serie document', end: 'seasons: [{ number }]', note: 'The parent stores the nested data.' },
    { start: 'Referenced', middle: 'Serie ← Season.serie', end: 'Separate documents', note: 'A child reference connects records with their own lifecycle.' },
  ] },
  states: { label: 'Season lifecycle', rows: [
    { start: 'SCHEDULED', middle: 'activate_season', end: 'ACTIVE', note: 'The action requires the scheduled source state.' },
    { start: 'ACTIVE', middle: 'finalize_season', end: 'FINISHED', note: 'Ordinary updates do not change the managed state field.' },
  ] },
  access: { label: 'Separate access decisions', rows: [
    { start: 'Identity', middle: 'Application authentication', end: 'Trusted context', note: 'Your server verifies the caller.' },
    { start: 'Permission', middle: 'Envelop rules', end: 'Operation / field access', note: 'Decide which operations and fields that caller may use.' },
    { start: 'Read scope', middle: 'Server-owned filters', end: 'Matching records', note: 'Root query scopes restrict reads. Authorize writes separately.' },
  ] },
  schema: { label: 'From a type to an API', rows: [
    { start: 'Define', middle: 'GraphQLObjectType', end: 'Fields + metadata', note: 'Describe data, relationships and application behavior.' },
    { start: 'Register', middle: 'connect()', end: 'Endpoint names', note: 'Choose the singular and plural names explicitly.' },
    { start: 'Build', middle: 'createSchema()', end: 'Executable GraphQL', note: 'Models, inputs and generated resolvers are ready for your server.' },
  ] },
};
const diagram = computed(() => diagrams[props.kind] || diagrams.relationships);
</script>

<template>
  <figure class="domain-diagram" :aria-label="diagram.label">
    <figcaption>{{ diagram.label }}</figcaption>
    <div v-for="(row, index) in diagram.rows" :key="row.start" class="diagram-row" :style="{ '--diagram-delay': `${index * .12}s` }">
      <div class="diagram-flow"><strong>{{ row.start }}</strong><span class="diagram-edge" aria-hidden="true"></span><code>{{ row.middle }}</code><span class="diagram-edge" aria-hidden="true"></span><span>{{ row.end }}</span></div>
      <p>{{ row.note }}</p>
    </div>
  </figure>
</template>

<style scoped>
.domain-diagram { margin: 30px 0; padding: 24px; border: 1px solid var(--reading-rule); border-radius: 8px; background: var(--reading-surface); }
figcaption { color: var(--reading-muted); font: 11px var(--vp-font-family-mono); text-transform: uppercase; letter-spacing: .06em; margin-bottom: 24px; }
.diagram-row + .diagram-row { margin-top: 24px; padding-top: 22px; border-top: 1px solid var(--reading-rule); }
.diagram-flow { display: grid; grid-template-columns: minmax(68px, .65fr) minmax(12px, .2fr) minmax(0, 1.3fr) minmax(12px, .2fr) minmax(0, 1fr); align-items: center; gap: 10px; font-size: 12px; line-height: 1.6; }
.diagram-flow strong { color: var(--reading-amber); font-size: 11px; }
.diagram-flow code { background: none; padding: 0; color: var(--reading-strong); font-size: 11px; overflow-wrap: anywhere; }
.diagram-flow > span:last-child { color: var(--reading-blue); overflow-wrap: anywhere; }
.diagram-edge { height: 1px; background: var(--reading-amber); transform-origin: left; position: relative; }
.diagram-edge::after { content: ''; width: 4px; height: 4px; border-right: 1px solid var(--reading-amber); border-top: 1px solid var(--reading-amber); transform: rotate(45deg); position: absolute; right: 0; top: -2px; }
.diagram-row p { margin: 12px 0 0; color: var(--reading-muted); font-size: 12px; line-height: 1.7; }
@media (prefers-reduced-motion: no-preference) { .diagram-edge { animation: diagram-connect 1s ease var(--diagram-delay) both; } }
@keyframes diagram-connect { from { transform: scaleX(0); } to { transform: scaleX(1); } }
@media (max-width: 560px) { .domain-diagram { padding: 20px; } .diagram-flow { grid-template-columns: 1fr; gap: 12px; } .diagram-edge { width: 26px; } .diagram-flow strong, .diagram-flow code, .diagram-flow > span:last-child { font-size: 12px; } }
</style>
