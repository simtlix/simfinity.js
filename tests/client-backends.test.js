import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
const fixture = fileURLToPath(new URL('./fixtures/client-runtime.js', import.meta.url));
test.each(['mongo', 'mongo-disabled', 'postgres', 'postgres-disabled'])('client uses %s schema with no metadata database access', (mode) => {
  const result = spawnSync(process.execPath, [fixture, mode], { encoding: 'utf8', timeout: 15000 });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('client metadata and query passed');
});
