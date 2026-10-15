import { execFileSync } from 'node:child_process';
import { test, expect } from 'vitest';

test('process-wide introspection opt-out supports standard schema roundtrip and repeated imports', () => {
  expect(
    execFileSync(process.execPath, ['tests/fixtures/registered-introspection.js'], {
      encoding: 'utf8',
    }),
  ).toContain('standard introspection roundtrip passed');
});
