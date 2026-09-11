import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const fixture = fileURLToPath(new URL('./fixtures/schema-initialization.js', import.meta.url));

describe('GraphQL introspection initialization', () => {
  test.each([
    'before-field-materialization',
    'after-field-materialization',
    'after-schema-creation',
    'repeated-imports-before-schema',
    'repeated-imports-after-schema',
    'repeated-create-schema',
  ])('%s preserves usable schemas and metadata', (scenario) => {
    // A fresh process is essential: GraphQL introspection types are global singletons.
    const result = spawnSync(process.execPath, [fixture, scenario], {
      encoding: 'utf8',
      timeout: 15000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout.trim()).toBe(`${scenario}: passed`);
  });
});
