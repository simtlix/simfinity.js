<script setup>
import { computed, ref } from 'vue';
import CapabilitySculpture from './CapabilitySculpture.vue';

const props = defineProps({
  active: { type: String, default: 'schema' },
  light: { type: Boolean, default: false },
  focused: { type: Boolean, default: false },
  phase: { type: String, default: 'overview' },
});
const emit = defineEmits(['select']);
const inspected = ref(null);
const graphRoot = ref(null);
const nodes = [
  { id: 'models', label: 'MongoDB models', eyebrow: 'PERSISTENCE', position: 'models', index: '01', detail: 'Mongoose models, shaped by your types.', path: 'M287 226 C219 210 282 114 162 110', color: 'amber' },
  { id: 'query', label: 'GraphQL queries', eyebrow: 'READ', position: 'query', index: '02', detail: 'Filter, sort, and paginate your data.', path: 'M369 220 C439 194 427 103 543 103', color: 'amber' },
  { id: 'mutation', label: 'Mutations', eyebrow: 'WRITE', position: 'mutation', index: '03', detail: 'Create, update, and delete through GraphQL.', path: 'M379 267 C449 265 450 341 563 341', color: 'amber' },
  { id: 'relations', label: 'Relationships', eyebrow: 'CONNECT', position: 'relations', index: '04', detail: 'Connected types become queryable relationships.', path: 'M277 265 C206 264 234 354 142 354', color: 'amber' },
  { id: 'mcp', label: 'MCP tools', eyebrow: 'AI INTERFACE', position: 'mcp', index: '05', detail: 'Expose your API as tools for AI clients.', path: 'M344 297 C428 358 315 441 413 462', color: 'blue' },
];
const highlighted = computed(() => props.phase !== 'overview' ? props.active : inspected.value || props.active);
const detail = computed(() => nodes.find((node) => node.id === highlighted.value)?.detail || 'One definition. A connected system.');

function selectNode(id) {
  inspected.value = null;
  emit('select', id);
}

function focusNode(id) {
  const target = id === 'schema' ? '.core-target' : `.node-${id}`;
  graphRoot.value?.querySelector(target)?.focus({ preventScroll: true });
}

defineExpose({ focusNode });
</script>

<template>
  <div ref="graphRoot" class="schema-instrument" :class="{ 'graph-focused': focused }" :data-active="highlighted" :data-light="light" aria-label="Explore what Simfinity generates from your GraphQL schema">
    <div class="instrument-coordinate coordinate-top" aria-hidden="true"><span>GRAPHQL / SCHEMA</span><span>GENERATED CAPABILITIES</span></div>

    <div class="instrument-plane">
      <div class="node-focus-orbit" aria-hidden="true"><span></span><span></span><span></span></div>
      <div class="focus-reticle" aria-hidden="true"><span></span><span></span></div>
      <Transition name="sculpture" mode="out-in" :duration="{ enter: 1500, leave: 200 }">
        <CapabilitySculpture v-if="focused" :key="active" :node="active" />
      </Transition>
      <div :key="active" class="focus-node-caption" aria-hidden="true"><span>{{ active === 'schema' ? '00 / THE SOURCE' : `${nodes.find(node => node.id === active)?.index} / GENERATED FROM YOUR SCHEMA` }}</span><strong>{{ active === 'schema' ? 'GraphQL schema' : nodes.find(node => node.id === active)?.label }}</strong></div>
      <svg class="system-topology" viewBox="0 0 700 540" fill="none" role="img" aria-labelledby="sim-graph-title sim-graph-description" focusable="false">
        <title id="sim-graph-title">One schema becomes a connected system</title>
        <desc id="sim-graph-description">A central GraphQL schema connects to MongoDB models, GraphQL queries, mutations, relationships, and MCP tools. Traveling signals show the connections between the schema and each generated capability.</desc>
        <defs>
          <pattern id="sim-graph-grid" width="28" height="28" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".65" fill="var(--graph-grid)" opacity=".28"/></pattern>
          <radialGradient id="sim-graph-grid-mask"><stop offset=".1" stop-color="white"/><stop offset="1" stop-color="black"/></radialGradient>
          <mask id="sim-graph-field-mask"><rect width="700" height="540" fill="url(#sim-graph-grid-mask)"/></mask>
          <linearGradient id="sim-graph-face" x1="253" y1="178" x2="397" y2="322" gradientUnits="userSpaceOnUse"><stop stop-color="var(--graph-face-high)"/><stop offset=".5" stop-color="var(--graph-face-mid)"/><stop offset="1" stop-color="var(--graph-face-low)"/></linearGradient>
          <linearGradient id="sim-graph-core-rim" x1="270" y1="175" x2="385" y2="302" gradientUnits="userSpaceOnUse"><stop stop-color="var(--graph-rim-high)"/><stop offset=".4" stop-color="var(--graph-rim-mid)"/><stop offset="1" stop-color="var(--graph-rim-low)"/></linearGradient>
          <radialGradient id="sim-graph-core-glow"><stop stop-color="var(--graph-core-glow)" stop-opacity=".16"/><stop offset="1" stop-color="var(--graph-core-glow)" stop-opacity="0"/></radialGradient>
          <filter id="sim-graph-signal-glow" x="-200%" y="-200%" width="500%" height="500%"><feGaussianBlur stdDeviation="3"/></filter>
        </defs>

        <g class="field-lines">
          <rect width="700" height="540" fill="url(#sim-graph-grid)" mask="url(#sim-graph-field-mask)"/>
          <path d="M48 249H653M329 30V505" stroke="var(--graph-crosshair)" stroke-opacity=".07" stroke-dasharray="3 7"/>
          <ellipse cx="329" cy="250" rx="244" ry="157" transform="rotate(-25 329 250)" stroke="var(--graph-orbit)" stroke-opacity=".1"/>
          <ellipse cx="329" cy="250" rx="190" ry="225" transform="rotate(-25 329 250)" stroke="var(--graph-orbit)" stroke-opacity=".055"/>
          <ellipse cx="329" cy="250" rx="226" ry="116" transform="rotate(29 329 250)" stroke="var(--graph-orbit)" stroke-opacity=".09" stroke-dasharray="2 9"/>
          <path d="M251 169l-8-8m161 8 8-8M251 329l-8 8m161-8 8 8" stroke="var(--graph-registration)" stroke-opacity=".55"/>
          <circle cx="329" cy="250" r="128" fill="url(#sim-graph-core-glow)"/>
          <g stroke="var(--graph-reference)" stroke-opacity=".3"><path d="M53 45v12m-6-6h12M643 456v12m-6-6h12M256 464v10m-5-5h10M580 217v10m-5-5h10"/></g>
        </g>

        <g v-for="(node, index) in nodes" :key="node.id" class="signal-route" :class="[{ 'route-active': highlighted === node.id }, `route-${node.color}`]" :style="{ '--signal-delay': `${index * -1.17}s`, '--signal-duration': `${4.8 + index * .37}s` }">
          <path :d="node.path" class="route-shadow"/>
          <path :d="node.path" class="route-line" pathLength="100"/>
          <path :d="node.path" class="route-highlight"/>
          <path :d="node.path" class="route-pulse" pathLength="100"/>
          <path :d="node.path" class="route-pulse pulse-glow" pathLength="100" filter="url(#sim-graph-signal-glow)"/>
        </g>

        <g class="schema-core-plates">
          <path d="M329 201 404 249v37l-75 48-75-48v-37Z" fill="var(--graph-core-base)" stroke="var(--graph-base-outline)" stroke-opacity=".55"/>
          <path d="m254 263 75 48 75-48M329 311v23" stroke="var(--graph-base-edge)" stroke-opacity=".7"/>
          <path d="m254 250 75 48 75-48" stroke="var(--graph-layer-edge)" stroke-opacity=".42"/>
          <path d="m254 239 75 48 75-48" stroke="var(--graph-layer-edge)" stroke-opacity=".2"/>
          <path d="m266 275 26 16m8 5 8 5" stroke="var(--graph-base-indicator)" stroke-width="2" stroke-linecap="round"/>
          <path d="M329 167 404 215v35l-75 48-75-48v-35Z" fill="url(#sim-graph-face)" stroke="url(#sim-graph-core-rim)"/>
          <path d="m254 215 75 48 75-48M329 263v35" stroke="var(--graph-face-seam)" stroke-opacity=".5"/>
          <path d="m267 215 62-39 62 39-62 40Z" stroke="var(--graph-face-inset)" stroke-opacity=".17"/>
          <path d="m292 234 12 8m6 4 7 4" stroke="var(--graph-face-indicator)" stroke-opacity=".5" stroke-linecap="round"/>
        </g>

        <g class="core-symbol" stroke="var(--graph-symbol)" stroke-width="1.4" stroke-linejoin="round">
          <path d="m329 189-26 16v21l26 17 26-17v-21Z"/><path d="m329 189-26 37h52Zm-26 16 26 38 26-38" opacity=".6"/>
          <circle cx="329" cy="189" r="3.4" fill="var(--graph-symbol-node)"/><circle cx="303" cy="205" r="3.4" fill="var(--graph-symbol-node)"/><circle cx="303" cy="226" r="3.4" fill="var(--graph-symbol-node)"/><circle cx="329" cy="243" r="3.4" fill="var(--graph-symbol-node)"/><circle cx="355" cy="226" r="3.4" fill="var(--graph-symbol-node)"/><circle cx="355" cy="205" r="3.4" fill="var(--graph-symbol-node)"/>
        </g>

        <g class="satellite-markers">
          <circle cx="108" cy="278" r="3" fill="var(--graph-satellite-amber)"/><circle cx="108" cy="278" r="7" stroke="var(--graph-satellite-amber)" stroke-opacity=".2"/>
          <circle cx="481" cy="409" r="2.5" fill="var(--graph-satellite-blue)"/><circle cx="481" cy="409" r="7" stroke="var(--graph-satellite-blue)" stroke-opacity=".2"/>
          <circle cx="430" cy="75" r="2" fill="var(--graph-satellite-muted)"/>
        </g>
      </svg>

      <button type="button" class="core-target" :inert="focused" :aria-pressed="focused && active === 'schema'" aria-label="GraphQL schema: the single source of your API" @mouseenter="inspected = 'schema'" @mouseleave="inspected = null" @focus="inspected = 'schema'" @blur="inspected = null" @click="selectNode('schema')">
        <span class="core-accessible-label">GraphQL schema</span>
      </button>
      <div class="core-caption" aria-hidden="true"><span>YOUR SCHEMA</span><strong>Single source of truth</strong></div>

      <button v-for="node in nodes" :key="node.id" type="button" class="system-node" :style="{ '--node-order': Number(node.index) }" :class="[`node-${node.position}`, `node-${node.color}`, { 'node-active': highlighted === node.id }]" :inert="focused" :aria-pressed="focused && active === node.id" :aria-label="`${node.label}: ${node.detail}`" @mouseenter="inspected = node.id" @mouseleave="inspected = null" @focus="inspected = node.id" @blur="inspected = null" @click="selectNode(node.id)">
        <span class="node-contact" aria-hidden="true"></span>
        <span class="node-eyebrow"><span>{{ node.eyebrow }}</span><span class="node-index">{{ node.index }}</span></span>
        <span class="node-main">
          <svg class="node-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <g v-if="node.id === 'models'"><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/></g>
            <g v-else-if="node.id === 'query'"><path d="M9 4H6v16h3m6-16h3v16h-3M10 9l4 3-4 3"/></g>
            <g v-else-if="node.id === 'mutation'"><path d="m14 3-8 11h6l-2 7 9-12h-7Z"/></g>
            <g v-else-if="node.id === 'relations'"><circle cx="5" cy="12" r="3"/><circle cx="18" cy="5" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8 10.5 7.5-4m-7.5 7 7.5 4"/></g>
            <g v-else><path d="m8 15 8-8a3 3 0 0 1 4 4l-6 6m-8-5 8-8a3 3 0 0 1 4 4L9 18m-6-3 3 3 4-4m-4 4 4 4"/></g>
          </svg>
          <strong>{{ node.label }}</strong>
        </span>
        <span class="node-bottom-line" aria-hidden="true"></span>
      </button>
      <span class="annotation annotation-types" aria-hidden="true">type → model</span>
      <span class="annotation annotation-tools" aria-hidden="true">schema → tools</span>
    </div>

    <span class="core-accessible-label" role="status">{{ detail }}</span>
  </div>
</template>

<style scoped>
.schema-instrument {
  --signal-amber: #f5bd55;
  --signal-blue: #81a7ff;
  --graph-grid: #a1a1a1;
  --graph-face-high: #333029;
  --graph-face-mid: #1d1e21;
  --graph-face-low: #141518;
  --graph-rim-high: #ffd377;
  --graph-rim-mid: #80622f;
  --graph-rim-low: #353126;
  --graph-core-glow: #efab27;
  --graph-crosshair: #b7b0a2;
  --graph-orbit: #baab90;
  --graph-registration: #b7a175;
  --graph-reference: #777267;
  --graph-core-base: #171719;
  --graph-base-outline: #52412a;
  --graph-base-edge: #6f5229;
  --graph-layer-edge: #f4b745;
  --graph-base-indicator: #f7ba46;
  --graph-face-seam: #a17a38;
  --graph-face-inset: #c29e59;
  --graph-face-indicator: #ecc16e;
  --graph-symbol: #f4c573;
  --graph-symbol-node: #f6c773;
  --graph-satellite-amber: #e8b35b;
  --graph-satellite-blue: #719af8;
  --graph-satellite-muted: #84765d;
  position: relative;
  width: 100%;
  max-width: 780px;
  margin-inline: auto;
  color: #efebe3;
  isolation: isolate;
  container: schema-graph / inline-size;
}
.instrument-coordinate { display: flex; align-items: center; justify-content: space-between; padding: 0 20px; font-family: var(--vp-font-family-mono); font-size: 9px; letter-spacing: .12em; color: #8b877f; }
.coordinate-top::before, .coordinate-top::after { content: ''; position: absolute; width: 8px; height: 8px; top: 3px; border-top: 1px solid #70604a; }
.coordinate-top::before { left: 0; border-left: 1px solid #70604a; }
.coordinate-top::after { right: 0; border-right: 1px solid #70604a; }
.instrument-plane { position: relative; width: 100%; aspect-ratio: 700 / 540; }
.system-topology { display: block; width: 100%; height: 100%; overflow: visible; }
.route-shadow { stroke: #101113; stroke-width: 8px; }
.route-line { stroke: #c08e3a; stroke-width: 1; opacity: .32; transition: opacity .35s, stroke-width .35s; }
.route-blue .route-line { stroke: #739cfb; opacity: .43; }
.route-highlight { stroke: #e3b666; stroke-width: 1; stroke-dasharray: 1 8; opacity: .4; }
.route-blue .route-highlight { stroke: #81a7ff; }
.route-pulse { stroke: #ffd47e; stroke-width: 2; stroke-linecap: round; stroke-dasharray: 2 98; stroke-dashoffset: 100; animation: signal-travel var(--signal-duration) linear infinite; animation-delay: var(--signal-delay); }
.route-blue .route-pulse { stroke: #91b3ff; }
.pulse-glow { stroke-width: 4; opacity: .65; }
.route-active .route-line { opacity: .86; stroke-width: 1.4; }
.route-active .route-highlight { opacity: .8; }
.schema-core-plates, .core-symbol { transform-origin: 329px 250px; animation: core-breathe 7s ease-in-out infinite; }
.core-target { position: absolute; left: 35.5%; top: 30%; width: 23%; height: 30%; border: 0; background: transparent; cursor: pointer; clip-path: polygon(50% 0, 100% 30%, 100% 73%, 50% 100%, 0 73%, 0 30%); }
.core-target:focus-visible { outline: none; background: #ffcc7420; }
.core-accessible-label { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.core-caption { position: absolute; top: 63.5%; left: 47%; display: flex; flex-direction: column; align-items: center; transform: translateX(-50%); white-space: nowrap; line-height: 1.4; pointer-events: none; }
.core-caption span { color: #f0c16e; font-family: var(--vp-font-family-mono); font-size: 10px; letter-spacing: .15em; }
.core-caption strong { margin-top: 4px; color: #a29c90; font-size: 11px; font-weight: 400; }
.system-node { --node-color: var(--signal-amber); position: absolute; z-index: 2; display: flex; flex-direction: column; width: 25%; max-width: 172px; min-height: 67px; padding: 12px 13px 13px; text-align: left; border: 1px solid #5b4a306b; border-radius: 5px; background: linear-gradient(130deg, #24231feb, #1a1b1de8); box-shadow: 0 9px 23px #00000026, inset 0 1px #ffffff04; transform: translate(-50%, -50%); transition: border-color .3s, box-shadow .3s, background .3s; cursor: pointer; }
.system-node:hover, .system-node:focus-visible, .node-active { border-color: #c19549a6; background: linear-gradient(130deg, #302a1fee, #201f1bea); box-shadow: 0 9px 28px #0003, 0 0 20px #e9b1500a; outline: none; }
.system-node:focus-visible { outline: 2px solid var(--node-color); outline-offset: 4px; }
.node-models { left: 21%; top: 20.5%; }
.node-query { left: 80%; top: 19%; }
.node-mutation { left: 82%; top: 63.1%; }
.node-relations { left: 18%; top: 65.5%; }
.node-mcp { left: 59%; top: 87%; }
.node-blue { --node-color: var(--signal-blue); border-color: #485d815f; background: linear-gradient(130deg, #232832ed, #1a1d24e8); }
.node-blue:hover, .node-blue:focus-visible, .node-blue.node-active { border-color: #769ce5a1; background: linear-gradient(130deg, #283449ed, #1a202ae8); box-shadow: 0 9px 28px #0003, 0 0 20px #6e99ed0a; }
.node-contact { position: absolute; top: 50%; width: 5px; height: 5px; border-radius: 50%; background: var(--node-color); box-shadow: 0 0 8px color-mix(in srgb, var(--node-color), transparent 65%); }
.node-models .node-contact, .node-relations .node-contact { right: -3px; }
.node-query .node-contact, .node-mutation .node-contact { left: -3px; }
.node-mcp .node-contact { left: 50%; top: -3px; }
.node-eyebrow { display: flex; justify-content: space-between; width: 100%; color: #a8997d; font-family: var(--vp-font-family-mono); font-size: 8px; letter-spacing: .105em; line-height: 1.3; }
.node-blue .node-eyebrow { color: #98a9c9; }
.node-index { opacity: .65; }
.node-main { display: flex; align-items: center; gap: 9px; margin-top: 9px; width: 100%; min-width: 0; }
.node-icon { flex: 0 0 21px; width: 21px; height: 21px; color: var(--node-color); }
.node-main strong { color: #e9e5dd; min-width: 0; flex: 1; font-size: 12px; line-height: 1.3; font-weight: 500; white-space: normal; overflow-wrap: anywhere; }
.node-bottom-line { position: absolute; bottom: -1px; left: 13px; height: 1px; width: 25px; background: var(--node-color); opacity: .5; transition: width .4s; }
.system-node:hover .node-bottom-line, .node-active .node-bottom-line { width: calc(100% - 26px); }
.annotation { position: absolute; pointer-events: none; font-family: var(--vp-font-family-mono); font-size: 8px; letter-spacing: .035em; color: #b39d7394; }
.annotation-types { left: 27%; top: 33%; transform: rotate(34deg); }
.annotation-tools { left: 53.3%; top: 73%; color: #819fca94; transform: rotate(60deg); }
.schema-instrument[data-light="true"] {
  --signal-amber: #956019;
  --signal-blue: #4468c5;
  --graph-grid: #71634e;
  --graph-face-high: #fffef9;
  --graph-face-mid: #f8f1e1;
  --graph-face-low: #e9dec8;
  --graph-rim-high: #e5b953;
  --graph-rim-mid: #b2925f;
  --graph-rim-low: #ad9570;
  --graph-core-glow: #e0b960;
  --graph-crosshair: #5d5446;
  --graph-orbit: #64553a;
  --graph-registration: #8e7346;
  --graph-reference: #76684e;
  --graph-core-base: #e8dfce;
  --graph-base-outline: #a18b65;
  --graph-base-edge: #ab8c54;
  --graph-layer-edge: #a7772b;
  --graph-base-indicator: #ad7520;
  --graph-face-seam: #a68851;
  --graph-face-inset: #88672a;
  --graph-face-indicator: #8b641e;
  --graph-symbol: #91601a;
  --graph-symbol-node: #a46c19;
  --graph-satellite-amber: #af7a27;
  --graph-satellite-blue: #4e70bd;
  --graph-satellite-muted: #8b7b5e;
  color: #332e25;
}
.schema-instrument[data-light="true"] .instrument-coordinate { color: #716854; }
.schema-instrument[data-light="true"] .coordinate-top::before, .schema-instrument[data-light="true"] .coordinate-top::after { border-color: #a59474; }
.schema-instrument[data-light="true"] .route-shadow { stroke: none; }
.schema-instrument[data-light="true"] .route-line { stroke: #936111; opacity: .8; }
.schema-instrument[data-light="true"] .route-highlight { stroke: #b1883d; opacity: .5; }
.schema-instrument[data-light="true"] .route-pulse { stroke: #9a6009; stroke-width: 2.3; }
.schema-instrument[data-light="true"] .route-blue .route-line { stroke: #4b69b0; opacity: .78; }
.schema-instrument[data-light="true"] .route-blue .route-highlight { stroke: #587acc; }
.schema-instrument[data-light="true"] .route-blue .route-pulse { stroke: #365fbe; }
.schema-instrument[data-light="true"] .route-active .route-line { opacity: 1; stroke-width: 1.5; }
.schema-instrument[data-light="true"] .pulse-glow { opacity: .18; }
.schema-instrument[data-light="true"] .core-target:focus-visible { background: #bd881535; }
.schema-instrument[data-light="true"] .core-caption span { color: #82591d; }
.schema-instrument[data-light="true"] .core-caption strong { color: #706754; }
.schema-instrument[data-light="true"] .system-node { border-color: #c9bba0; background: linear-gradient(135deg, #fffefa, #f7f2e8); box-shadow: 0 8px 23px #6953230d, inset 0 1px #fff; }
.schema-instrument[data-light="true"] .system-node:hover, .schema-instrument[data-light="true"] .system-node:focus-visible, .schema-instrument[data-light="true"] .node-active { border-color: #ab8135; background: linear-gradient(135deg, #fffcf0, #f5e9cd); box-shadow: 0 9px 26px #82672814, inset 0 1px #fff; }
.schema-instrument[data-light="true"] .node-blue { border-color: #b4c2df; background: linear-gradient(135deg, #fcfdff, #ecf0fa); }
.schema-instrument[data-light="true"] .node-blue:hover, .schema-instrument[data-light="true"] .node-blue:focus-visible, .schema-instrument[data-light="true"] .node-blue.node-active { border-color: #718cc2; background: linear-gradient(135deg, #f8faff, #e5ebfa); box-shadow: 0 9px 26px #475f9712, inset 0 1px #fff; }
.schema-instrument[data-light="true"] .node-eyebrow { color: #77613d; }
.schema-instrument[data-light="true"] .node-blue .node-eyebrow { color: #546993; }
.schema-instrument[data-light="true"] .node-index { opacity: 1; }
.schema-instrument[data-light="true"] .node-main strong { color: #302b23; }
.schema-instrument[data-light="true"] .node-blue .node-main strong { color: #29354d; }
.schema-instrument[data-light="true"] .node-bottom-line { opacity: .8; }
.schema-instrument[data-light="true"] .annotation { color: #7d6b49; }
.schema-instrument[data-light="true"] .annotation-tools { color: #546b98; }
@keyframes signal-travel { to { stroke-dashoffset: 0; } }
@keyframes core-breathe { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-5px); } }
@container schema-graph (max-width: 620px) {
  .instrument-coordinate { padding-inline: 12px; font-size: 8px; }
  .system-node { padding: 9px 10px 10px; min-height: 59px; width: 26.5%; }
  .node-eyebrow { font-size: 7px; letter-spacing: .05em; }
  .node-main { gap: 6px; margin-top: 7px; }
  .node-icon { width: 17px; height: 17px; flex-basis: 17px; }
  .node-main strong { font-size: 10px; }
  .core-caption span { font-size: 8px; }
  .core-caption strong { font-size: 9px; }
}
@container schema-graph (max-width: 420px) {
  .instrument-plane { aspect-ratio: 700 / 610; }
  .system-topology { position: absolute; top: 5.75%; height: 88.5%; }
  .system-node { min-height: 54px; width: 29%; padding: 8px; }
  .node-main { gap: 4px; }
  .node-main strong { font-size: 10px; white-space: normal; }
  .node-icon { display: none; }
  .node-eyebrow { font-size: 6px; }
  .node-index { display: none; }
  .node-models { top: 23.8%; left: 18%; }
  .node-query { top: 22.6%; left: 81%; }
  .node-mutation { top: 61.6%; left: 84%; }
  .node-relations { top: 63.7%; left: 16%; }
  .node-mcp { top: 82.8%; }
  .core-target { top: 32.3%; height: 26.5%; }
  .core-caption { top: 62%; }
  .core-caption span { font-size: 7px; }
  .core-caption strong { display: none; }
  .annotation { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .schema-core-plates, .core-symbol, .route-pulse { animation: none; }
  .route-pulse { stroke-dashoffset: 48; }
  .system-node, .node-bottom-line, .route-line { transition: none; }
}
</style>
