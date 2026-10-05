import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const fixture = fileURLToPath(new URL('./fixtures/mongodb-global-options.js', import.meta.url));

describe('MongoDB facade global options', () => {
  test.each(['throw', 'true', 'unset'])('importing the facade keeps the application strictQuery setting (%s)', (scenario) => {
    // A fresh process: the facade must be evaluated after the application configured Mongoose, and
    // module state from other tests must not hide a global change.
    const result = spawnSync(process.execPath, [fixture, scenario], {
      encoding: 'utf8',
      timeout: 15000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout.trim()).toBe(`${scenario}: passed`);
  });
});
