import { defineConfig } from 'vitepress';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const repository = 'https://github.com/simtlix/simfinity.js';
const base = `/${(process.env.DOCS_BASE_PATH || '').replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');
const siteUrl = process.env.DOCS_SITE_URL;

export default defineConfig({
  title: 'Simfinity.js',
  description: 'Define your GraphQL types. Generate MongoDB or PostgreSQL storage, queries, mutations, relationships, and optional MCP tools with Simfinity.js.',
  lang: 'en-US',
  srcExclude: ['public/**', 'superpowers/**', 'preview/**', 'starters/**'],
  base,
  lastUpdated: true,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}favicon.svg` }],
    ['meta', { name: 'theme-color', content: '#14161b' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'Simfinity.js' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
  ],
  sitemap: siteUrl ? { hostname: new URL(base, siteUrl).href } : undefined,
  transformHead({ pageData }) {
    const head: [string, Record<string, string>][] = [
      ['meta', { property: 'og:title', content: `${pageData.title || 'Simfinity.js'} | Simfinity.js` }],
      ['meta', { property: 'og:description', content: pageData.description }],
    ];
    if (siteUrl) {
      const socialImage = new URL(`${base}social-cover.png`, siteUrl).href;
      head.push(['meta', { property: 'og:image', content: socialImage }], ['meta', { name: 'twitter:image', content: socialImage }], ['meta', { property: 'og:image:width', content: '1200' }], ['meta', { property: 'og:image:height', content: '630' }], ['meta', { property: 'og:image:alt', content: 'Simfinity.js: GraphQL types connected to MongoDB or PostgreSQL, generated operations, and optional MCP tools.' }]);
      const pagePath = pageData.relativePath.replace(/index\.md$/, '').replace(/\.md$/, '.html');
      const url = new URL(`${base}${pagePath}`, siteUrl).href;
      head.push(['link', { rel: 'canonical', href: url }], ['meta', { property: 'og:url', content: url }]);
    }
    return head;
  },
  markdown: {
    theme: { light: 'github-light', dark: 'github-dark' },
  },
  themeConfig: {
    logo: { src: '/brand-mark.svg', alt: '' },
    siteTitle: 'simfinity.js',
    nav: [
      { text: 'Documentation', link: '/guide/introduction', activeMatch: '/guide/' },
      { text: 'Databases', items: [
        { text: 'Choose a database', link: '/guide/databases' },
        { text: 'MongoDB', link: '/guide/getting-started' },
        { text: 'PostgreSQL', link: '/guide/postgresql' },
        { text: 'SQL core & plugins', link: '/guide/sql-plugins' },
      ] },
      { text: 'Example app', link: '/resources/barber' },
      { text: 'API reference', link: '/reference/api', activeMatch: '/reference/' },
      { text: 'Resources', items: [
        { text: 'Barber example app', link: '/resources/barber' },
        { text: 'Series sample (MongoDB)', link: 'https://github.com/simtlix/series-sample' },
        { text: 'Compatibility & releases', link: '/resources/compatibility' },
        { text: 'Contributing', link: '/resources/contributing' },
        { text: 'Troubleshooting', link: '/resources/troubleshooting' },
      ] },
      { text: `v${version}`, items: [
        { text: 'Downloads & compatibility', link: '/guide/databases#download-the-starters' },
        { text: 'Release history', link: `${repository}/releases` },
        { text: 'MongoDB package on npm', link: 'https://www.npmjs.com/package/@simtlix/simfinity-js' },
        { text: 'SQL package on npm', link: 'https://www.npmjs.com/package/@simtlix/simfinity-sql' },
        { text: 'PostgreSQL package on npm', link: 'https://www.npmjs.com/package/@simtlix/simfinity-postgres' },
      ] },
    ],
    sidebar: [
      { text: 'Start here', items: [
        { text: 'Introduction', link: '/guide/introduction' },
        { text: 'Choose a database', link: '/guide/databases' },
        { text: 'Is Simfinity a fit?', link: '/guide/choosing-simfinity' },
        { text: 'MongoDB quick start', link: '/guide/getting-started' },
        { text: 'MongoDB reference integrity', link: '/guide/mongodb-integrity' },
        { text: 'PostgreSQL quick start', link: '/guide/postgresql' },
        { text: 'SQL core & plugins', link: '/guide/sql-plugins' },
      ] },
      { text: 'Build your API', collapsed: false, items: [
        { text: 'Schema & models', link: '/guide/schema' },
        { text: 'Relationships', link: '/guide/relationships' },
        { text: 'Queries & filtering', link: '/guide/queries' },
        { text: 'Mutations', link: '/guide/mutations' },
        { text: 'Validation', link: '/guide/validation' },
        { text: 'Controllers & hooks', link: '/guide/controllers' },
        { text: 'State machines', link: '/guide/state-machines' },
      ] },
      { text: 'Protect & extend', collapsed: false, items: [
        { text: 'Authorization', link: '/guide/authorization' },
        { text: 'Query scope', link: '/guide/query-scope' },
        { text: 'Middleware', link: '/guide/middleware' },
        { text: 'MCP & AI tools', link: '/guide/mcp' },
      ] },
      { text: 'Reference', collapsed: false, items: [
        { text: 'Core API', link: '/reference/api' },
        { text: 'Field extensions', link: '/reference/extensions' },
        { text: 'Scalars', link: '/reference/scalars' },
        { text: 'Aggregation', link: '/reference/aggregation' },
        { text: 'Plugins', link: '/reference/plugins' },
        { text: 'Errors', link: '/reference/errors' },
        { text: 'MCP API', link: '/reference/mcp' },
      ] },
      { text: 'Resources', collapsed: false, items: [
        { text: 'Barber example app', link: '/resources/barber' },
        { text: 'Troubleshooting', link: '/resources/troubleshooting' },
        { text: 'Compatibility & releases', link: '/resources/compatibility' },
        { text: 'Contributing', link: '/resources/contributing' },
      ] },
    ],
    search: { provider: 'local', options: {
      detailedView: true,
      miniSearch: { searchOptions: { boost: { title: 12, titles: 4, text: 1 }, fuzzy: 0.15, prefix: true } },
    } },
    outline: { level: [2, 3], label: 'On this page' },
    socialLinks: [{ icon: 'github', link: repository, ariaLabel: 'Simfinity.js on GitHub' }],
    editLink: { pattern: `${repository}/edit/master/docs/:path`, text: 'Edit this page on GitHub' },
    docFooter: { prev: 'Previous', next: 'Next' },
    footer: {
      message: 'Open source. Released under the Apache 2.0 License.',
      copyright: 'Built by Simtlix. Made for developers.',
    },
  },
});
