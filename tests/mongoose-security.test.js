import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('the supported Mongoose dependency rejects prototype pollution during update casting', () => {
  const fixture = fileURLToPath(new URL('./fixtures/mongoose-update-security.js', import.meta.url));
  expect(() => execFileSync(process.execPath, [fixture], { stdio: 'pipe' })).not.toThrow();
});
