import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const fixture = fileURLToPath(new URL('./fixtures/introspection-configuration.js', import.meta.url));
test.each(['core', 'mongodb', 'postgres', 'late', 'foreign', 'invalid', 'repeated'])('introspection configuration: %s', (scenario) => {
  const result = spawnSync(process.execPath, [fixture, scenario], { encoding: 'utf8', timeout: 15000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr || result.stdout).toBe(0);
});
