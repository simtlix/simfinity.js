import DefaultTheme from 'vitepress/theme';
import { withBase } from 'vitepress';
import type { Theme } from 'vitepress';
import { version } from '../../../package.json';
import '@fontsource-variable/space-grotesk';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import HomePage from './HomePage.vue';
import DomainDiagram from './DomainDiagram.vue';
import DocumentationLayout from './DocumentationLayout.vue';
import { installRouteTransitions } from './routeTransitions.js';
import './style.css';
import './home-refined.css';
import './home-motion.css';
import './reading.css';
import './hero-explorer.css';

// The current release's starter kit, for pages to name without writing the version by hand.
// `scripts/release-packages.js version` builds the archive these links point at.
const kit = `simfinity-${version}-starters`;
const starters = {
  version,
  directory: kit,
  zip: withBase(`/releases/${kit}.zip`),
  checksum: withBase(`/releases/${kit}.zip.sha256.txt`),
  checksumFile: `${kit}.zip.sha256.txt`,
  release: `https://github.com/simtlix/simfinity.js/releases/tag/v${version}`,
};

export default {
  extends: DefaultTheme,
  Layout: DocumentationLayout,
  enhanceApp({ app, router }) {
    app.component('HomePage', HomePage);
    app.component('DomainDiagram', DomainDiagram);
    app.config.globalProperties.$starters = starters;
    if (!import.meta.env.SSR) installRouteTransitions(router);
  },
} satisfies Theme;
