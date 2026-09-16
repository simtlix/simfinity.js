<script setup>
import { computed, ref } from 'vue';
import { withBase } from 'vitepress';
import CodeSnippet from './CodeSnippet.vue';

const props = defineProps({ database: { type: String, default: 'mongodb' } });
const isPostgres = computed(() => props.database === 'postgres');
const stage = defineModel('stage', { default: 'schema' });
const related = defineModel('related', { default: false });
const stages = [
  { id: 'schema', label: 'Define', file: 'schema.js · simplified Barber types', title: 'A shop starts with a type.', note: 'Start with a shop profile, then add its embedded opening hours.' },
  { id: 'query', label: 'Query', file: 'barber.graphql', title: 'Find a shop. Read its hours.', note: 'The same query works with either Barber backend.' },
  { id: 'mcp', label: 'Connect AI', file: 'mcp.js · excerpt', title: 'The same API, another interface.', note: 'Generated tools invoke GraphQL operations through your schema.' },
];
const selected = computed(() => stages.find(item => item.id === stage.value) || stages[0]);
const outputView = ref('response');
const schemaCode = computed(() => `import { GraphQLObjectType, GraphQLID,
  GraphQLString, GraphQLNonNull${related.value ? ', GraphQLList, GraphQLInt' : ''} } from 'graphql';
${isPostgres.value ? `import pg from 'pg';
import { createPostgres } from '@simtlix/simfinity-postgres';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const simfinity = createPostgres({ pool, schema: 'barber_example' });` : `import * as simfinity from '@simtlix/simfinity-js';
// Connect Mongoose before registering types (see the quick start).`}
${related.value ? `
const businessHourSlotType = new GraphQLObjectType({
  name: 'businessHourSlot',
  fields: {
    dayOfWeek: { type: GraphQLInt },
    openTime: { type: GraphQLString },
    closeTime: { type: GraphQLString },
  },
});
simfinity.addNoEndpointType(businessHourSlotType);
` : ''}
const barbershopType = new GraphQLObjectType({
  name: 'barbershop',
  fields: {
    id: { type: GraphQLID },
    name: { type: new GraphQLNonNull(GraphQLString) },
    slug: { type: new GraphQLNonNull(GraphQLString) },${related.value ? `
    businessHours: {
      type: new GraphQLList(businessHourSlotType),
      extensions: { relation: { embedded: true } },
    },` : ''}
  },
});

simfinity.connect(null, barbershopType, 'barbershop', 'barbershops');
export const schema = simfinity.createSchema();${isPostgres.value ? '\nawait simfinity.initializeDatabase({ mode: \'create\' });' : ''}`);
const queryCode = computed(() => `query FindBarberShop {
  barbershops(
    slug: { operator: EQ, value: "barber-demo" }
    pagination: { page: 1, size: 10 }
  ) {
    id
    name
    slug${related.value ? '\n    businessHours { dayOfWeek openTime closeTime }' : ''}
  }
}`);
const mcpCode = `import { generateMCPTools } from '@simtlix/simfinity-mcp';
import { schema } from './schema.js';

const { tools, callTool } = generateMCPTools(schema, {
  include: ['barbershops'],
});

const result = await callTool('barbershops', {
  slug: { operator: 'EQ', value: 'barber-demo' },
  pagination: { page: 1, size: 10 },
});`;
const code = computed(() => stage.value === 'schema' ? schemaCode.value : stage.value === 'query' ? queryCode.value : mcpCode);
const response = computed(() => JSON.stringify({ data: { barbershops: [{ id: isPostgres.value ? 'b7c3b71c-4c5a-49a2-bfc8-7451e4f6408a' : '507f1f77bcf86cd799439011', name: 'Simfinity Barber Demo', slug: 'barber-demo', ...(related.value ? { businessHours: Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, openTime: '09:00', closeTime: '18:00' })) } : {}) }] } }, null, 2));
const fields = computed(() => `type barbershop {
  id: ID
  name: String!
  slug: String!${related.value ? '\n  businessHours: [businessHourSlot]' : ''}
}${related.value ? '\n\ntype businessHourSlot {\n  dayOfWeek: Int\n  openTime: String\n  closeTime: String\n}' : ''}`);
function navigate(event, index) {
  let next = index;
  if (event.key === 'ArrowRight') next = (index + 1) % stages.length;
  else if (event.key === 'ArrowLeft') next = (index + stages.length - 1) % stages.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = stages.length - 1;
  else return;
  event.preventDefault();
  stage.value = stages[next].id;
  event.currentTarget.parentElement.children[next].focus();
}
</script>

<template>
  <div class="catalog-explorer">
    <div class="explorer-controls">
      <div class="explorer-tabs" role="tablist" aria-label="Explore the Barber example">
        <button v-for="(item, index) in stages" :id="`catalog-tab-${item.id}`" :key="item.id" role="tab" type="button" :aria-selected="stage === item.id" aria-controls="catalog-panel" :tabindex="stage === item.id ? 0 : -1" @click="stage = item.id" @keydown="navigate($event, index)"><span>0{{ index + 1 }}</span>{{ item.label }}</button>
      </div>
      <label class="relation-control"><input v-model="related" type="checkbox"><span class="relation-toggle" aria-hidden="true"></span>Include opening hours</label>
    </div>
    <div id="catalog-panel" role="tabpanel" :aria-labelledby="`catalog-tab-${selected.id}`">
      <div class="explorer-intro"><div><span class="explorer-eyebrow">{{ isPostgres ? 'POSTGRESQL' : 'MONGODB' }} / {{ related ? 'CONNECTED TYPES' : 'ONE TYPE' }}</span><h3>{{ selected.title }}</h3></div><p>{{ selected.note }}</p></div>
      <div class="explorer-panes">
        <CodeSnippet :key="`${stage}-${related}`" :code="code" :file="selected.file" class="explorer-source" />
        <div class="explorer-result">
          <div class="result-path" :key="`${stage}-${related}`" aria-hidden="true"><span>TYPE</span><i></i><span>GRAPHQL</span><i></i><span>MCP</span></div>
          <div class="result-views" role="group" aria-label="Inspect the example"><button type="button" :aria-pressed="outputView === 'response'" @click="outputView = 'response'">Example response</button><button type="button" :aria-pressed="outputView === 'fields'" @click="outputView = 'fields'">Type shape</button></div>
          <CodeSnippet :key="`${outputView}-${related}`" :code="outputView === 'response' ? response : fields" :file="outputView === 'response' ? 'GraphQL response · sample data' : 'schema.graphql · selected types'" />
          <p class="result-note">{{ related ? 'Embedded opening hours become nested inputs and queryable fields.' : 'One registration adds list, detail, aggregation and CRUD operations.' }}</p>
        </div>
      </div>
    </div>
    <div class="explorer-footer"><span>Simplified types · illustrative IDs. The full Barber app adds scopes, authorization, and booking rules.</span><a :href="withBase('/resources/barber.html')">Run the Barber app <span aria-hidden="true">↗</span></a></div>
  </div>
</template>

<style scoped>
.catalog-explorer { --ex-rule: #39414e; --ex-muted: #a8b1c1; color: #e9edf6; border: 1px solid var(--ex-rule); border-radius: 12px; background: #171c25; box-shadow: 0 32px 75px -45px #0008; overflow: hidden; }
.explorer-controls { display: flex; align-items: center; justify-content: space-between; gap: 20px; border-bottom: 1px solid var(--ex-rule); padding: 0 26px; }
.explorer-tabs { display: flex; gap: 27px; }
.explorer-tabs button { min-height: 67px; color: var(--ex-muted); font-size: 13px; border-bottom: 2px solid transparent; }
.explorer-tabs button span { font: 10px var(--vp-font-family-mono); margin-right: 10px; opacity: .7; }
.explorer-tabs button[aria-selected='true'] { color: var(--vp-c-brand-1); border-bottom-color: currentColor; }
.relation-control { display: flex; align-items: center; position: relative; gap: 10px; min-height: 44px; color: var(--ex-muted); font-size: 12px; cursor: pointer; }
.relation-control input { position: absolute; width: 32px; height: 22px; opacity: 0; }
.relation-toggle { width: 30px; height: 18px; border: 1px solid #63708a; border-radius: 20px; padding: 3px; }
.relation-toggle::after { content: ''; display: block; width: 10px; height: 10px; border-radius: 50%; background: #8693ab; transition: transform .2s, background .2s; }
input:checked + .relation-toggle::after { transform: translateX(11px); background: var(--vp-c-brand-1); }
input:focus-visible + .relation-toggle, button:focus-visible, a:focus-visible { outline: 2px solid var(--vp-c-brand-1); outline-offset: 4px; }
.explorer-intro { display: flex; align-items: end; justify-content: space-between; gap: 30px; padding: 30px 26px; }
.explorer-eyebrow { color: var(--ex-muted); font: 10px var(--vp-font-family-mono); letter-spacing: .06em; }
.explorer-intro h3 { font-size: 24px; letter-spacing: -.7px; margin-top: 10px; }
.explorer-intro p { max-width: 300px; color: var(--ex-muted); font-size: 13px; line-height: 1.7; }
.explorer-panes { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); border-block: 1px solid var(--ex-rule); }
.explorer-source { border-right: 1px solid var(--ex-rule); }
.explorer-source :deep(pre) { height: 370px; }
.explorer-result { min-width: 0; }
.result-path { display: flex; align-items: center; gap: 12px; padding: 21px 22px; color: var(--ex-muted); font: 9px var(--vp-font-family-mono); }
.result-path i { height: 1px; flex: 1; background: linear-gradient(90deg, #be9555, #7899f0); transform-origin: left; }
.result-views { display: flex; gap: 22px; padding: 0 22px; border-bottom: 1px solid var(--ex-rule); }
.result-views button { min-height: 43px; color: var(--ex-muted); font-size: 12px; border-bottom: 1px solid transparent; }
.result-views button[aria-pressed='true'] { color: var(--vp-c-brand-1); border-color: currentColor; }
.explorer-result :deep(pre) { height: 222px; }
.result-note { margin: 0; padding: 16px 22px; color: var(--ex-muted); font-size: 12px; line-height: 1.6; }
.explorer-footer { display: flex; justify-content: space-between; align-items: center; gap: 24px; padding: 20px 26px; font-size: 12px; color: var(--ex-muted); }
.explorer-footer a { color: var(--vp-c-brand-1); white-space: nowrap; }
:global(html:not(.dark) .catalog-explorer) { --ex-rule: #d6dbe3; --ex-muted: #616c7e; background: #f4f5f7; color: #2c3545; }
@media (prefers-reduced-motion: no-preference) { .result-path i { animation: path-enter .7s ease both; } .result-path i:nth-of-type(2) { animation-delay: .2s; } .explorer-panes :deep(pre) { animation: example-enter .25s ease; } }
@keyframes path-enter { from { transform: scaleX(0); } to { transform: scaleX(1); } }
@keyframes example-enter { from { opacity: .5; } to { opacity: 1; } }
@media (max-width: 800px) { .explorer-intro { align-items: start; flex-direction: column; gap: 12px; } .explorer-intro p { max-width: none; } .explorer-controls { flex-wrap: wrap; gap: 0; padding-inline: 20px; } .explorer-tabs { gap: 20px; } .relation-control { margin-bottom: 10px; } .explorer-panes { grid-template-columns: 1fr; } .explorer-source { border-right: 0; border-bottom: 1px solid var(--ex-rule); } .explorer-source :deep(pre) { height: 320px; } .explorer-result :deep(pre) { height: auto; max-height: 330px; } .explorer-footer { align-items: start; flex-direction: column; gap: 12px; } }
@media (max-width: 400px) { .explorer-tabs { gap: 16px; } .explorer-tabs button { font-size: 12px; } .explorer-tabs button span { margin-right: 6px; } .explorer-intro { padding: 24px 20px; } .explorer-intro h3 { font-size: 22px; } }
</style>
