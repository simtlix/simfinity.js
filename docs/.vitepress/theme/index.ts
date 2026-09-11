import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
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

export default {
  extends: DefaultTheme,
  Layout: DocumentationLayout,
  enhanceApp({ app, router }) {
    app.component('HomePage', HomePage);
    app.component('DomainDiagram', DomainDiagram);
    if (!import.meta.env.SSR) installRouteTransitions(router);
  },
} satisfies Theme;
