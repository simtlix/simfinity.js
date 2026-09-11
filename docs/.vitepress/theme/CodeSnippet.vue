<script setup>
import { computed, onUnmounted, ref } from 'vue';

const props = defineProps({ code: { type: String, required: true }, file: { type: String, default: '' } });
const feedback = ref('');
let timer;
const tokens = computed(() => {
  const result = [];
  const pattern = /\/\/[^\n]*|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:import|from|as|const|export|new|await|return|query|mutation|type|true|false|null)\b|\b\d+\b/g;
  let cursor = 0;
  for (const match of props.code.matchAll(pattern)) {
    if (match.index > cursor) result.push({ text: props.code.slice(cursor, match.index) });
    const text = match[0];
    const kind = /^(\/\/|#)/.test(text) ? 'comment' : /^["']/.test(text) ? 'string' : /^\d/.test(text) ? 'number' : 'keyword';
    result.push({ text, kind });
    cursor = match.index + text.length;
  }
  result.push({ text: props.code.slice(cursor) });
  return result;
});
async function copy() {
  try {
    await navigator.clipboard.writeText(props.code);
    feedback.value = 'Copied';
  } catch {
    feedback.value = 'Select code to copy';
  }
  clearTimeout(timer);
  timer = setTimeout(() => { feedback.value = ''; }, 2200);
}
onUnmounted(() => clearTimeout(timer));
</script>

<template>
  <div class="example-code">
    <div class="example-toolbar"><span>{{ file }}</span><button type="button" :aria-label="`Copy ${file || 'code'}`" @click="copy">{{ feedback || 'Copy' }} <span aria-hidden="true">{{ feedback === 'Copied' ? '✓' : '⧉' }}</span></button><span class="sr-only" role="status">{{ feedback }}</span></div>
    <pre tabindex="0" :aria-label="file"><code><span v-for="(token, index) in tokens" :key="index" :class="token.kind && `syntax-${token.kind}`">{{ token.text }}</span></code></pre>
  </div>
</template>

<style scoped>
.example-code { min-width: 0; background: var(--example-surface, #171c25); color: var(--example-ink, #dce2ec); }
.example-toolbar { display: flex; align-items: center; justify-content: space-between; min-height: 52px; padding: 4px 22px; gap: 14px; border-bottom: 1px solid var(--example-line, #343c4a); font: 11px var(--vp-font-family-mono); color: var(--example-muted, #a4afc1); }
.example-toolbar > span:first-child { overflow-wrap: anywhere; }
button { flex-shrink: 0; display: flex; gap: 9px; align-items: center; min-height: 40px; padding: 0 7px; color: inherit; border-radius: 4px; transition: color .2s, background .2s; }
button:hover { color: var(--example-ink, #fff); background: #8294b51a; }
button:focus-visible, pre:focus-visible { outline: 2px solid var(--vp-c-brand-1); outline-offset: -3px; }
pre { margin: 0; padding: 22px; overflow: auto; tab-size: 2; font: 12px/1.85 var(--vp-font-family-mono); }
code { font: inherit; }
.syntax-comment { color: var(--example-muted, #a4afc1); }
.syntax-string { color: var(--example-string, #dfc18a); }
.syntax-keyword { color: var(--example-keyword, #a7bdff); }
.syntax-number { color: var(--example-number, #9ed3c3); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
:global(html:not(.dark) .example-code) { --example-surface: #f4f5f7; --example-ink: #2c3545; --example-line: #d7dce5; --example-muted: #626e81; --example-string: #836016; --example-keyword: #3e5a9d; --example-number: #276b5a; }
@media (max-width: 560px) { pre { padding: 18px; } .example-toolbar { padding-inline: 18px; } }
</style>
