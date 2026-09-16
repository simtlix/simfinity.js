<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { useData, withBase } from 'vitepress';
import SchemaGraph from './SchemaGraph.vue';
import ConnectionLoop from './ConnectionLoop.vue';
import CatalogExplorer from './CatalogExplorer.vue';
import CodeSnippet from './CodeSnippet.vue';
import { heroCapabilities } from './heroCapabilities.js';
import { useHomeMotion } from './useHomeMotion.js';

const root = ref(null);
useHomeMotion(root);
const { isDark } = useData();
const activeTab = ref('schema');
const activeNode = ref('schema');
const heroFocused = ref(false);
const heroPhase = ref('overview');
let heroTimer;
let heroRevision = 0;
let graphFlight;
const heroBack = ref(null);
const heroGraph = ref(null);
const selectedHeroNode = computed(() => heroCapabilities.find(node => node.id === activeNode.value));
let heroTrigger = 'schema';
const includeOpeningHours = ref(false);
const activeCapability = ref('01');
let capabilityObserver;
let heroResizeObserver;
const activeTool = ref('barbershops');
const database = ref('mongodb');
const databaseGuide = computed(() => database.value === 'postgres' ? '/guide/postgresql.html' : '/guide/getting-started.html');
const databaseName = computed(() => database.value === 'postgres' ? 'PostgreSQL' : 'MongoDB');
const installCommand = computed(() => database.value === 'postgres'
  ? 'npm i @simtlix/simfinity-postgres@3.2.0 graphql@^16.11.0 pg@^8.16.3'
  : 'npm i @simtlix/simfinity-js@3.2.0 graphql@^16.11.0 mongoose@^8.16.2');
const toolExamples = [
  { name: 'barbershops', kind: 'QUERY', description: 'Find approved shops with typed filters and pagination. Barber scopes decide which shops the caller can see.', link: '/guide/queries.html' },
  { name: 'bookings_aggregate', kind: 'AGGREGATE', description: 'Count bookings by state within the signed-in user’s query scope.', link: '/reference/aggregation.html' },
  { name: 'complete_booking', kind: 'MUTATION', description: 'An owner or administrator completes a confirmed booking through its state machine. Replace the illustrative ID with an accessible booking ID.', link: '/guide/state-machines.html' },
];
const copyState = ref('Copy install command');
let copyTimer;
function selectDatabase(value) {
  database.value = value;
  clearTimeout(copyTimer);
  copyState.value = 'Copy install command';
}
const capabilities = [
  { id: '01', category: 'MODEL', title: 'Relationships, already connected.', description: 'Embedded documents. References. Collections. Describe the connections in your domain and let Simfinity generate the resolvers.', link: '/guide/relationships.html', cta: 'Connect your data', symbol: 'relation' },
  { id: '02', category: 'QUERY', title: 'Questions without the boilerplate.', description: 'Compose nested filters, logical expressions, sorting, pagination, and aggregations through a familiar GraphQL interface.', link: '/guide/queries.html', cta: 'Explore queries', symbol: 'query' },
  { id: '03', category: 'PROTECT', title: 'Your application. Your rules.', description: 'Bring authorization, validation, and query scopes into your schema. Control access with the context your application provides.', link: '/guide/authorization.html', cta: 'Define your rules', symbol: 'protect' },
  { id: '04', category: 'EXTEND', title: 'Convention meets your ambition.', description: 'Make room for what is unique. Lifecycle hooks, custom mutations, and state machines keep your business logic in your hands.', link: '/guide/controllers.html', cta: 'Make it yours', symbol: 'extend' },
];

async function copyInstall() {
  try {
    await navigator.clipboard.writeText(installCommand.value);
    copyState.value = 'Copied!';
  } catch {
    copyState.value = 'Select the command to copy';
  }
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => { copyState.value = 'Copy install command'; }, 2500);
}

function captureMobileGraph() {
  if (!window.matchMedia('(max-width: 900px)').matches) return null;
  const rect = root.value.querySelector('.hero-system').getBoundingClientRect();
  return { left: rect.left, top: rect.top + window.scrollY, width: rect.width };
}

function animateMobileGraph(before) {
  graphFlight?.cancel();
  if (!before || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const graph = root.value.querySelector('.hero-system');
  const after = graph.getBoundingClientRect();
  const x = before.left - after.left;
  const y = before.top - after.top - window.scrollY;
  graphFlight = graph.animate([
    { transform: `translate(${x}px, ${y}px) scale(${before.width / after.width})` },
    { transform: 'translate(0, 0) scale(1)' },
  ], { duration: 1250, easing: 'cubic-bezier(.16, 1, .3, 1)' });
}

function settleHero(phase, delay, revision) {
  clearTimeout(heroTimer);
  heroTimer = setTimeout(async () => {
    if (revision !== heroRevision) return;
    heroPhase.value = phase;
    if (phase !== 'overview') return;
    await nextTick();
    if (revision !== heroRevision) return;
    heroGraph.value?.focusNode(heroTrigger);
    if (window.matchMedia('(max-width: 900px)').matches) {
      root.value.querySelector('.hero-system')?.scrollIntoView({
        block: 'center',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
      });
    }
  }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : delay);
}

async function selectNode(id) {
  if (heroFocused.value && activeNode.value === id) return;
  const revision = ++heroRevision;
  clearTimeout(heroTimer);
  const entering = !heroFocused.value;
  const before = entering ? captureMobileGraph() : null;
  if (entering) heroTrigger = id;
  activeNode.value = id;
  heroFocused.value = true;
  heroPhase.value = entering ? 'opening' : 'switching';
  await nextTick();
  if (revision !== heroRevision) return;
  if (entering) {
    animateMobileGraph(before);
    heroBack.value?.focus({ preventScroll: true });
    if (window.matchMedia('(max-width: 900px)').matches) {
      heroBack.value?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    }
  }
  settleHero('focused', entering ? 1850 : 1100, revision);
}

async function closeHero() {
  if (!heroFocused.value) return;
  const revision = ++heroRevision;
  const before = captureMobileGraph();
  const hero = root.value.querySelector('.sim-hero');
  hero.style.setProperty('--hero-detail-top', `${hero.querySelector('.hero-detail').offsetTop}px`);
  heroFocused.value = false;
  heroPhase.value = 'closing';
  await nextTick();
  if (revision !== heroRevision) return;
  animateMobileGraph(before);
  settleHero('overview', 1450, revision);
}

const capabilityDetails = {
  '01': { label: 'RELATIONSHIPS', title: 'A connection becomes a query.', code: 'barbershops { services { name price } }' },
  '02': { label: 'QUERIES', title: 'A question becomes a filter.', code: 'name: { operator: LIKE, value: "Barber" }' },
  '03': { label: 'ACCESS CONTROL', title: 'Your context guides access.', code: 'addservice: requireOwnerOrPlatformAdmin()' },
  '04': { label: 'LIFECYCLE HOOKS', title: 'Your logic joins the lifecycle.', code: 'onSaving(doc, args, session, context)' },
};
const currentCapability = computed(() => capabilityDetails[activeCapability.value]);
const mcpInputs = computed(() => ({
  barbershops: { slug: { operator: 'EQ', value: 'barber-demo' }, pagination: { page: 1, size: 10 } },
  bookings_aggregate: { aggregation: { groupId: 'state', facts: [{ operation: 'COUNT', factName: 'total', path: 'id' }] } },
  complete_booking: { input: { id: database.value === 'postgres' ? 'bd418461-9c86-489e-8062-32c56b81a171' : '507f1f77bcf86cd799439012' } },
}));
onMounted(() => {
  const hero = root.value.querySelector('.sim-hero');
  const system = hero.querySelector('.hero-system');
  const copy = hero.querySelector('.hero-copy');
  heroResizeObserver = new ResizeObserver(() => {
    const shift = copy.offsetLeft + copy.offsetWidth / 2 - system.offsetLeft - system.offsetWidth * .47;
    hero.style.setProperty('--hero-graph-shift', `${shift}px`);
  });
  heroResizeObserver.observe(hero.querySelector('.hero-inner'));
  capabilityObserver = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) activeCapability.value = entry.target.dataset.capability;
  }, { rootMargin: '-25% 0px -45% 0px' });
  root.value.querySelectorAll('[data-capability]').forEach(element => capabilityObserver.observe(element));
});

onUnmounted(() => {
  clearTimeout(copyTimer);
  clearTimeout(heroTimer);
  graphFlight?.cancel();
  capabilityObserver?.disconnect();
  heroResizeObserver?.disconnect();
});
</script>

<template>
  <main ref="root" class="sim-home">
    <section class="sim-hero" :class="{ 'hero-focused': heroFocused }" :data-node="activeNode" :data-phase="heroPhase" :aria-labelledby="heroFocused ? 'hero-detail-title' : 'hero-title'" @keydown.esc.stop="closeHero">
      <div class="hero-grain" aria-hidden="true"></div>
      <div class="hero-horizon" data-parallax="-24" aria-hidden="true"></div>
      <div class="hero-atmosphere" aria-hidden="true"><span></span><span></span></div>
      <div class="hero-inner">
        <div class="hero-copy" :inert="heroFocused" :aria-hidden="heroFocused">
          <p class="hero-overline"><span class="hero-wordmark">simfinity<span>.js</span></span><span class="overline-separator">/</span><span>THE GRAPHQL FRAMEWORK</span></p>
          <h1 id="hero-title"><span>Define once.</span><span class="hero-title-accent">Build beyond<span class="title-period">.</span></span></h1>
          <p class="hero-description">Define your GraphQL types. Build on MongoDB or PostgreSQL<br class="desktop-break"> with generated queries, mutations, and optional MCP tools.</p>
          <div class="database-choice" role="group" aria-label="Choose a database guide">
            <button type="button" :aria-pressed="database === 'mongodb'" @click="selectDatabase('mongodb')">MongoDB</button>
            <button type="button" :aria-pressed="database === 'postgres'" @click="selectDatabase('postgres')">PostgreSQL</button>
            <a :href="withBase('/guide/databases.html')">Compare databases <span aria-hidden="true">&#8599;</span></a>
          </div>
          <div class="hero-actions">
            <a class="sim-button primary" :href="withBase(databaseGuide)">Start with {{ databaseName }} <span aria-hidden="true">&#8599;</span></a>
            <a class="text-link" :href="withBase('/resources/barber.html')">Explore the Barber app <span aria-hidden="true">&#8599;</span></a>
          </div>
          <p class="preview-download"><a :href="withBase('/releases/simfinity-3.2.0-starters.zip')" download>Download v3.2.0 starters</a><span>Or install in your project:</span></p>
          <div class="install-command">
            <span class="terminal-prompt" aria-hidden="true">$</span>
            <code>{{ installCommand }}</code>
            <button type="button" :aria-label="copyState" :title="copyState" @click="copyInstall">
              <svg v-if="copyState !== 'Copied!'" viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true"><rect x="7" y="7" width="9" height="10" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M12 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" stroke="currentColor" stroke-width="1.4"/></svg>
              <span v-else aria-hidden="true">&#10003;</span>
            </button>
            <span class="copy-feedback" role="status">{{ copyState === 'Copy install command' ? '' : copyState }}</span>
          </div>
          <p class="database-note">Choose once when setting up your app. <a :href="withBase('/resources/compatibility.html')">v3.2.0 is available on npm.</a></p>
        </div>
        <div class="hero-system"><div class="hero-camera"><SchemaGraph ref="heroGraph" :active="activeNode" :focused="heroFocused" :phase="heroPhase" :light="!isDark" @select="selectNode" /></div></div>
        <div class="hero-explorer-controls" :inert="!heroFocused" :aria-hidden="!heroFocused">
          <button ref="heroBack" type="button" class="hero-back" @click="closeHero"><span aria-hidden="true">&#8592;</span> Back to overview <kbd aria-hidden="true">ESC</kbd></button>
        </div>
        <div class="hero-detail" :inert="!heroFocused" :aria-hidden="!heroFocused">
          <nav class="hero-node-nav" aria-label="Explore schema capabilities">
            <button v-for="node in heroCapabilities" :key="node.id" type="button" :aria-pressed="activeNode === node.id" :aria-label="`Explore ${node.label}`" @click="selectNode(node.id)"><span>{{ node.index }}</span>{{ node.short }}</button>
          </nav>
          <Transition name="hero-story" mode="out-in" :duration="{ enter: 2000, leave: 220 }">
            <div v-if="heroFocused" :key="activeNode" class="hero-detail-story">
              <p class="hero-detail-eyebrow"><span class="hero-detail-dot" aria-hidden="true"></span>{{ selectedHeroNode.index }} / {{ selectedHeroNode.eyebrow }}</p>
              <h2 id="hero-detail-title"><span class="hero-line-mask"><span>{{ selectedHeroNode.title }}</span></span><span class="hero-line-mask hero-detail-accent"><span>{{ selectedHeroNode.accent }}</span></span></h2>
              <p class="hero-detail-description">{{ selectedHeroNode.description }}</p>
              <ul class="hero-detail-features"><li v-for="feature in selectedHeroNode.features" :key="feature">{{ feature }}</li></ul>
              <CodeSnippet :code="selectedHeroNode.code" :file="selectedHeroNode.file" />
              <a class="text-link hero-detail-link" :href="withBase(selectedHeroNode.link)">{{ selectedHeroNode.cta }} <span aria-hidden="true">&#8599;</span></a>
            </div>
          </Transition>

        </div>
      </div>
    </section>

    <section id="from-schema-to-system" class="workflow-section" aria-labelledby="workflow-title">
      <div class="sim-section">
        <div class="chapter-label reveal"><span>01 / FROM SCHEMA TO SYSTEM</span><span class="chapter-line"></span><span>LESS REPETITION. MORE INTENTION.</span></div>
        <div class="section-heading reveal">
          <h2 id="workflow-title">A type is just<br><span class="muted-heading">the beginning.</span></h2>
          <p>One Barber app. Two database backends.<br><span>Explore a shop profile and its opening hours.</span></p>
        </div>
        <CatalogExplorer v-model:stage="activeTab" v-model:related="includeOpeningHours" :database="database" />
      </div>
    </section>

    <section class="capabilities-section" aria-labelledby="capabilities-title">
      <div class="sim-section capabilities-layout">
        <div class="capabilities-intro">
          <p class="section-eyebrow">02 / BUILT AROUND YOUR DOMAIN</p>
          <h2 id="capabilities-title">Less plumbing.<br><span class="muted-heading">More possibility.</span></h2>
          <p>A connected foundation, with the freedom to make it your own.</p>
          <div class="capabilities-loop"><ConnectionLoop :light="!isDark" /></div>
          <div class="capability-context" :key="activeCapability"><span class="context-index">{{ activeCapability }} / {{ currentCapability.label }}</span><p>{{ currentCapability.title }}</p><code>{{ currentCapability.code }}</code></div>
          <div class="capability-progress" aria-hidden="true"><span v-for="item in capabilities" :key="item.id" :class="{ active: item.id === activeCapability }"></span></div>
        </div>
        <div class="capability-list">
          <a v-for="capability in capabilities" :key="capability.id" class="capability-item reveal" :data-capability="capability.id" :class="{ 'capability-current': activeCapability === capability.id }" data-spotlight :href="withBase(capability.link)">
            <div class="capability-meta"><span>{{ capability.id }}</span><span>{{ capability.category }}</span><svg class="capability-icon" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g v-if="capability.symbol === 'relation'"><rect x="3" y="12" width="8" height="8" rx="2"/><rect x="21" y="3" width="8" height="8" rx="2"/><rect x="21" y="21" width="8" height="8" rx="2"/><path d="M11 16h5V7h5m-5 9v9h5"/></g><g v-else-if="capability.symbol === 'query'"><circle cx="13" cy="13" r="8"/><path d="m19 19 9 9M9 13h8m-4-4v8"/></g><g v-else-if="capability.symbol === 'protect'"><path d="m16 3 11 4v8c0 7-11 14-11 14S5 22 5 15V7Z"/><path d="m11 15 4 4 7-8"/></g><g v-else><path d="M4 9h24M4 23h24"/><circle cx="12" cy="9" r="4" fill="var(--cap-icon-bg)"/><circle cx="21" cy="23" r="4" fill="var(--cap-icon-bg)"/></g></svg></div>
            <h3>{{ capability.title }}</h3>
            <p>{{ capability.description }}</p>
            <code class="capability-preview">{{ capabilityDetails[capability.id].code }}</code>
            <span class="capability-link">{{ capability.cta }} <span aria-hidden="true">&#8599;</span></span>
          </a>
        </div>
      </div>
    </section>

    <section class="mcp-section" aria-labelledby="mcp-title">
      <div class="sim-section mcp-inner">
        <div class="mcp-copy reveal"><p class="section-eyebrow"><span class="blue-dot"></span> 03 / A NEW WAY TO CONNECT</p><h2 id="mcp-title">Your API.<br><span class="mcp-title-line">Meet <span class="mcp-ai">AI.</span></span></h2><p>Your schema already knows your data.<br>Now your AI tools can, too. Generate typed MCP<br class="desktop-break"> tools from the same GraphQL API, on either database.</p><a class="text-link" :href="withBase('/guide/mcp.html')">Explore MCP integration <span aria-hidden="true">&#8599;</span></a></div>
        <div class="mcp-terminal reveal" data-parallax="24" data-spotlight>
          <div class="terminal-heading"><span class="blue-dot"></span><span>schema &rarr; tools</span><span>MCP</span></div>
          <div class="terminal-source"><span class="terminal-label">BARBER SCHEMA + AUTH</span><code>generateMCPTools(schema, {<br>  schemaPlugins: [authPlugin],<br>  selectionDepth: 0,<br>})</code></div>
          <div class="tool-connection" aria-hidden="true"><span></span></div>
          <div class="tool-list" role="group" aria-label="Explore generated MCP tools"><button v-for="tool in toolExamples" :key="tool.name" class="tool-row" type="button" :aria-pressed="activeTool === tool.name" @click="activeTool = tool.name"><span class="tool-icon" aria-hidden="true">&#8599;</span><code>{{ tool.name }}</code><span>{{ tool.kind }}</span><span class="tool-signal" aria-hidden="true"></span></button></div>
          <template v-for="tool in toolExamples" :key="tool.name"><div v-if="activeTool === tool.name" class="tool-detail" role="status"><span class="terminal-label">{{ tool.kind }} TOOL</span><p>{{ tool.description }}</p><CodeSnippet :code="JSON.stringify(mcpInputs[tool.name], null, 2)" file="Example tool arguments" /><a :href="withBase(tool.link)">Explore this operation <span aria-hidden="true">&#8599;</span></a></div></template>
          <p class="terminal-footnote">GraphQL and MCP share Barber’s verified user context and rules.</p>
        </div>
      </div>
    </section>

    <section class="learning-section" aria-labelledby="learning-title">
      <div class="sim-section">
        <div class="chapter-label reveal"><span>04 / FIND YOUR NEXT CONNECTION</span><span class="chapter-line"></span><span>THE DOCUMENTATION</span></div>
        <div class="section-heading reveal"><h2 id="learning-title">A clear path.<br><span class="muted-heading">At every step.</span></h2><p>From the first query to the finer details.<br>Everything you need to keep building.</p></div>
        <div class="learning-links" data-line-reveal>
          <a class="reveal" :href="withBase('/guide/databases.html')"><span class="learning-number">01</span><div><span class="learning-label">START HERE</span><h3>Your first API</h3><p>A downloadable starter, a working query,<br>and the response to expect.</p></div><span class="learning-arrow" aria-hidden="true">&#8599;</span></a>
          <a class="reveal" :href="withBase('/reference/api.html')"><span class="learning-number">02</span><div><span class="learning-label">GET SPECIFIC</span><h3>Know the details</h3><p>Every function, every option.<br>Find the exact API.</p></div><span class="learning-arrow" aria-hidden="true">&#8599;</span></a>
          <a class="reveal" :href="withBase('/resources/barber.html')"><span class="learning-number">03</span><div><span class="learning-label">SEE IT WORK</span><h3>The Barber app</h3><p>MongoDB or PostgreSQL. One frontend.<br>Run the complete booking example.</p></div><span class="learning-arrow" aria-hidden="true">&#8599;</span></a>
        </div>
      </div>
    </section>

    <section class="final-section" aria-labelledby="final-title">
      <div class="final-connection" aria-hidden="true"><span></span><span></span><span></span></div>
      <div class="sim-section final-inner reveal"><p class="section-eyebrow">YOUR NEXT IDEA STARTS WITH A CONNECTION.</p><h2 id="final-title">What will you<br><span>connect next?</span></h2><a class="sim-button primary" :href="withBase('/guide/databases.html')">Build with Simfinity <span aria-hidden="true">&#8599;</span></a><div class="final-meta"><span>OPEN SOURCE</span><span>JAVASCRIPT</span><span>APACHE 2.0</span></div><div class="adoption-links"><a :href="withBase('/guide/choosing-simfinity.html')">Is Simfinity a fit?</a><a :href="withBase('/resources/compatibility.html')">Compatibility & releases</a><a :href="withBase('/guide/databases.html#download-the-starters')">Download the starter</a></div></div>
      <div class="brand-watermark" data-parallax="38" aria-hidden="true">simfinity.js</div>
    </section>
  </main>
</template>
