<script setup>
import { computed } from 'vue';
import DefaultTheme from 'vitepress/theme';
import { useData } from 'vitepress';

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
    <template #doc-footer-before>
      <div class="docs-feedback"><span>Help improve this page.</span><a :href="issueLink" target="_blank" rel="noreferrer">Report a documentation issue <span aria-hidden="true">↗</span></a></div>
    </template>
  </DefaultTheme.Layout>
</template>

<style scoped>
.docs-feedback { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; border-top: 1px solid var(--reading-rule); padding-top: 22px; margin-top: 40px; font-size: 12px; color: var(--reading-muted); }
a { color: var(--reading-blue); }
a:hover { text-decoration: underline; text-underline-offset: 4px; }
a:focus-visible { outline: 2px solid var(--reading-blue); outline-offset: 4px; }
</style>
