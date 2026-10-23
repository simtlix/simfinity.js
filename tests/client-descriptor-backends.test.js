import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const fixture = fileURLToPath(new URL('./fixtures/client-descriptor.js', import.meta.url));
const describe = (mode) => {
  const result = spawnSync(process.execPath, [fixture, mode], { encoding: 'utf8', timeout: 15000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
};
test.each(['core', 'mongodb', 'mongodb-transactional', 'postgres'])('%s has identical metadata with or without the legacy patch', (mode) => {
  expect(describe(mode)).toEqual(describe(`${mode}-disabled`));
});
test('the same GraphQL model has the same descriptor across all bundled adapters', () => {
  const expected = describe('core-disabled');
  for (const mode of ['mongodb', 'mongodb-transactional', 'postgres']) expect(describe(`${mode}-disabled`)).toEqual(expected);
});
