<script setup>
import { computed } from 'vue';
import DefaultTheme from 'vitepress/theme';
import { useData, withBase } from 'vitepress';
import { version } from '../../../package.json';
import AnimatedLogo from './AnimatedLogo.vue';

const { page } = useData();
const issueLink = computed(() => {
  const query = new URLSearchParams({
    title: `Docs: ${page.value.title}`,
    body: `Page: docs/${page.value.relativePath}\n\nWhat were you trying to do?\n\nWhat could be clearer?\n`,
  });
  return `https://github.com/simtlix/simfinity.js/issues/new?${query}`;
});
</script>

<template>
  <DefaultTheme.Layout>
    <template #nav-bar-title-before><AnimatedLogo/></template>
    <template #doc-before>
      <p class="docs-version-note">v{{ version }} · MongoDB & PostgreSQL. <a :href="withBase('/guide/databases.html#download-the-starters')">Install from npm or download the starters.</a></p>
    </template>
    <template #doc-footer-before>
      <div class="docs-feedback"><span>Help improve this page.</span><a :href="issueLink" target="_blank" rel="noreferrer">Report a documentation issue <span aria-hidden="true">↗</span></a></div>
    </template>
  </DefaultTheme.Layout>
</template>

<style scoped>
.docs-version-note { margin: 0 0 24px; padding: 12px 16px; border: 1px solid var(--vp-c-divider); border-radius: 8px; background: var(--vp-c-bg-soft); color: var(--vp-c-text-2); font-size: 13px; line-height: 1.6; }
.docs-feedback { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; border-top: 1px solid var(--reading-rule); padding-top: 22px; margin-top: 40px; font-size: 12px; color: var(--reading-muted); }
a { color: var(--reading-blue); }
a:hover { text-decoration: underline; text-underline-offset: 4px; }
a:focus-visible { outline: 2px solid var(--reading-blue); outline-offset: 4px; }
</style>
