import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const directory = await mkdtemp(join(tmpdir(), 'simfinity-eslint-consumer-'));
const execute = (command, args, cwd = directory) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

try {
  const [archive] = JSON.parse(execute('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], root));
  const names = archive.files.map(file => file.path);
  for (const name of ['README.md', 'LICENSE', 'src/index.js', 'src/index.d.ts']) assert.ok(names.includes(name), `Missing packed ${name}`);
  assert.ok(names.every(name => name.startsWith('src/') || ['package.json', 'README.md', 'LICENSE'].includes(name)));
  assert.equal(manifest.dependencies, undefined);
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'isolated-eslint-consumer', private: true, type: 'module' }));
  execute('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(directory, archive.filename),
    `eslint@${manifest.devDependencies.eslint}`,
    `@typescript-eslint/parser@${manifest.devDependencies['@typescript-eslint/parser']}`,
    `typescript@${manifest.devDependencies.typescript}`]);
  const lock = JSON.parse(await readFile(join(directory, 'package-lock.json'), 'utf8'));
  for (const name of ['@simtlix/simfinity-core', '@simtlix/simfinity-js', '@simtlix/simfinity-postgres', '@simtlix/simfinity-sql', 'graphql', 'mongoose', 'pg', '@modelcontextprotocol/sdk']) {
    assert.ok(!Object.keys(lock.packages).some(path => path.endsWith(`node_modules/${name}`)), `Unexpected runtime dependency ${name}`);
  }
  await writeFile(join(directory, 'eslint.config.mjs'), `
import plugin from '@simtlix/eslint-plugin-simfinity';
import parser from '@typescript-eslint/parser';
export default [
  { ...plugin.configs['recommended-3.8'], files: ['**/*.{js,ts}'] },
  { files: ['**/*.ts'], languageOptions: { parser } },
];
`);
  const prelude = `import * as sf from '@simtlix/simfinity-js';
import { GraphQLObjectType } from 'graphql';
import { createAuthPlugin, requireAuth, anyRule, requireRole } from '@simtlix/simfinity-core/auth';
import { mapSchema } from '@graphql-tools/utils';
`;
  await mkdir(join(directory, 'fixtures'));
  await writeFile(join(directory, 'fixtures/invalid.js'), prelude + `mapSchema(sf.createSchema(), {});
createAuthPlugin({ RootQueryType: { books: requireAuth } }, { defaultPolicy: 'deny' });
sf.configureQueryLimits({ maxPageSize: 0 });
sf.connect(null, new GraphQLObjectType({ name: 'Book', fields: { author: { type: Author, extensions: { relation: { connectionField: 'author.id' } } } } }), 'book', 'books');
createAuthPlugin(null);
createAuthPlugin({ Book: { title: [] } });
anyRule(false);
requireRole(['admin', '']);
requireAuth(async context => context.user);
sf.use(createAuthPlugin({}));
throw new Error('Linting must not execute application code');
`);
  await writeFile(join(directory, 'fixtures/valid.js'), prelude + `const schema = sf.createSchema();
createAuthPlugin({ RootQueryType: { books: requireAuth() } }, { defaultPolicy: 'DENY' });
sf.configureQueryLimits({ maxPageSize: 100 });
sf.connect(null, new GraphQLObjectType({ name: 'Book', fields: { summary: { type: Summary, resolve: compute, extensions: { virtual: true } } } }), 'book', 'books');
createAuthPlugin({ Book: { title: [true, { allOf: [] }, async () => true] } });
anyRule(requireAuth(), async () => true);
requireRole(['admin', ' ']);
requireAuth(context => context.user);
createYoga({ schema, plugins: [createAuthPlugin({})] });
throw new Error('Linting must not execute application code');
`);
  await writeFile(join(directory, 'fixtures/invalid.ts'), "import { configureQueryLimits, auth, createRuntime } from '@simtlix/simfinity-core';\nconst cap = 0 as const; configureQueryLimits({ maxPageSize: cap });\nauth.createAuthPlugin({ Book: { title: [] } } satisfies Permissions);\nauth.createRule(false as const);\nauth.requirePermission(['read', ''] as const);\nauth.isOwner((async p => p.ownerId) as Extractor);\ncreateRuntime(adapter).use(auth.createAuthPlugin({}) as unknown as Middleware);\n");
  await writeFile(join(directory, 'fixtures/valid.ts'), "import { configureQueryLimits, auth, createRuntime } from '@simtlix/simfinity-core';\nconst cap = 100 as const; configureQueryLimits({ maxPageSize: cap });\nauth.createAuthPlugin({ Book: { title: true } } satisfies Permissions);\nauth.createRule(async () => true);\nauth.requirePermission(['read', 'write'] as const);\nauth.isOwner((p => p.ownerId) as Extractor);\ncreateRuntime(adapter).use(middleware as Middleware);\n");
  let output;
  try {
    output = execute(process.execPath, ['node_modules/eslint/bin/eslint.js', 'fixtures', '--format', 'json', '--fix']);
    assert.fail('The CLI should reject the invalid fixtures');
  } catch (error) {
    assert.equal(error.status, 1, error.stderr || error.message);
    output = error.stdout;
  }
  const reports = JSON.parse(output);
  const invalid = reports.find(report => report.filePath.endsWith('/invalid.js'));
  assert.deepEqual(invalid.messages.map(message => [message.ruleId, message.line]), [
    ['simfinity/no-schema-cloning', 5],
    ['simfinity/no-uncalled-auth-factory', 6],
    ['simfinity/valid-default-policy', 6],
    ['simfinity/valid-query-limits', 7],
    ['simfinity/valid-connection-field', 8],
    ['simfinity/valid-permissions', 9],
    ['simfinity/valid-permissions', 10],
    ['simfinity/valid-auth-composition', 11],
    ['simfinity/valid-required-claims', 12],
    ['simfinity/no-async-auth-extractor', 13],
    ['simfinity/no-auth-plugin-as-middleware', 14],
  ]);
  const ts = reports.find(report => report.filePath.endsWith('/invalid.ts'));
  assert.deepEqual(ts.messages.map(message => [message.ruleId, message.line]), [
    ['simfinity/valid-query-limits', 2],
    ['simfinity/valid-permissions', 3],
    ['simfinity/valid-auth-composition', 4],
    ['simfinity/valid-required-claims', 5],
    ['simfinity/no-async-auth-extractor', 6],
    ['simfinity/no-auth-plugin-as-middleware', 7],
  ]);
  for (const report of reports) {
    assert.equal(report.fatalErrorCount, 0);
    assert.equal(report.output, undefined, 'No automatic source changes');
    if (report.filePath.endsWith('/valid.js') || report.filePath.endsWith('/valid.ts')) assert.equal(report.messages.length, 0);
    for (const message of report.messages) assert.equal(message.fix, undefined);
  }
  await writeFile(join(directory, 'config.ts'), `import plugin from '@simtlix/eslint-plugin-simfinity';
import type { Linter, Rule } from 'eslint';
const config: Linter.Config = plugin.configs['recommended-3.8'];
const extractor: Rule.RuleModule = plugin.rules['no-async-auth-extractor'];
const middleware: Rule.RuleModule = plugin.rules['no-auth-plugin-as-middleware'];
export default config;
`);
  execute(process.execPath, ['node_modules/typescript/bin/tsc', '--strict', '--noEmit', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'config.ts']);
  console.log('Packed consumer passed: eleven JS and six TS diagnostics, config/rule types, valid fixtures, no runtime dependencies or source fixes.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
