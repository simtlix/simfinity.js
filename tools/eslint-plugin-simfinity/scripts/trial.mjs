import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { Linter } from 'eslint';
import plugin from '../src/index.js';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const linter = new Linter();
const filesIn = async directory => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.filter(entry => !['node_modules', '__tests__', 'integration', 'generated'].includes(entry.name)).map(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesIn(path) : path.endsWith('.js') ? [path] : [];
  }));
  return files.flat();
};

for (const engine of ['mongodb', 'postgres']) {
  const files = await filesIn(join(repository, 'examples/barber', engine));
  const diagnostics = [];
  for (const file of files) {
    const code = await readFile(file, 'utf8');
    const messages = linter.verify(code, [plugin.configs['recommended-3.8']], { filename: relative(repository, file) });
    diagnostics.push(...messages.map(message => ({ file: relative(repository, file), rule: message.ruleId, line: message.line, message: message.message })));
  }
  assert.deepEqual(diagnostics, [], JSON.stringify(diagnostics, null, 2));
  console.log(`${engine}: ${files.length} application JS files, zero diagnostics.`);
  // Sentinel edits stay in memory. Prove the trial exercises actual contracts;
  // zero diagnostics alone could mean the files were outside the analysis.
  const application = await readFile(join(repository, 'examples/barber', engine, 'application.js'), 'utf8');
  assert.ok(application.includes("defaultPolicy: 'ALLOW'"));
  const policy = linter.verify(application.replace("defaultPolicy: 'ALLOW'", "defaultPolicy: 'allow'"), [plugin.configs['recommended-3.8']]);
  assert.deepEqual(policy.map(message => message.ruleId), ['simfinity/valid-default-policy']);
  const book = await readFile(join(repository, 'examples/barber', engine, 'types/booking.js'), 'utf8');
  assert.match(book, /connectionField: '[^']+'/);
  const link = linter.verify(book.replace(/connectionField: '[^']+'/, "connectionField: 'invalid.path'"), [plugin.configs['recommended-3.8']]);
  assert.deepEqual(link.map(message => message.ruleId), ['simfinity/valid-connection-field']);
  console.log(`${engine}: injected policy and relation violations detected in existing application files.`);
}
console.log('Bounded trial only: cross-file permission maps, dynamic configuration, lifecycle, scopes and transaction ownership are not certified. No application code was executed.');
