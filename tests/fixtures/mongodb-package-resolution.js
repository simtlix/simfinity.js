import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(join(process.cwd(), 'package.json'));
const fixture = JSON.parse(readFileSync(new URL('./mongodb-published-paths.json', import.meta.url), 'utf8'));
const root = dirname(require.resolve(`${fixture.package}/package.json`));
for (const [path, target] of Object.entries(fixture.paths)) {
  const specifier = path ? `${fixture.package}/${path}` : fixture.package;
  const resolved = require.resolve(specifier);
  assert.equal(resolved, join(root, target), `${specifier} changed its target`);
  assert(statSync(resolved).isFile(), `${specifier} must resolve to a file`);
}
console.log(`MongoDB: ${Object.keys(fixture.paths).length} published paths and aliases preserved`);
