import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const fixture = fileURLToPath(new URL('./fixtures/field-metadata-names.js', import.meta.url));

// Application types named like Simfinity's field metadata types (#162).
describe('field metadata type names', () => {
  test.each([
    ['no-clash', 'core'],
    ['registered-clash', 'core'],
    ['registered-clash', 'mongodb'],
    ['registered-clash', 'postgres'],
    ['nested-clash', 'core'],
    ['nested-clash', 'mongodb'],
    ['nested-clash', 'postgres'],
    ['input-clash', 'core'],
    ['fallback-taken', 'core'],
    ['clash-after-schema', 'core'],
    ['clash-after-schema', 'mongodb'],
    ['clash-after-schema', 'postgres'],
    ['failed-construction', 'core'],
    ['second-evaluation', 'core'],
    ['auth', 'core'],
    // Registered inputs whose fields function reads a generated input, in a later schema of the process.
    // PostgreSQL takes no registrations after its schema is created.
    ['input-thunk-second-runtime', 'core'],
    ['input-thunk-second-runtime', 'mongodb'],
    ['input-thunk-second-runtime', 'postgres'],
    ['input-thunk-after-schema', 'core'],
    ['input-thunk-after-schema', 'mongodb'],
  ])('%s on %s', (scenario, backend) => {
    // A fresh process is essential: the metadata types are shared by every schema of a process.
    const result = spawnSync(process.execPath, [fixture, scenario, backend], { encoding: 'utf8', timeout: 15000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout.trim()).toBe(`${scenario} ${backend}: passed`);
  });
});
