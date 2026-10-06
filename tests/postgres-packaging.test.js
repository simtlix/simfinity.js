import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = (name) => JSON.parse(readFileSync(join(root, 'packages', name, 'package.json'), 'utf8'));
const sources = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  return entry.isDirectory() ? sources(path) : [path];
});

describe('PostgreSQL package contents', () => {
  it('exports only its entry point and ships no wrappers over the SQL internals', () => {
    expect(Object.keys(manifest('postgres').exports)).toEqual(['.']);
    // These wrappers were never reachable through the package exports and nothing loaded them.
    for (const name of ['adapter', 'records', 'transactions']) {
      expect(existsSync(join(root, 'packages/postgres/src', `${name}.js`)), name).toBe(false);
    }
    for (const file of sources(join(root, 'packages/postgres/src'))) {
      expect(readFileSync(file, 'utf8'), file).not.toContain('@simtlix/simfinity-sql/internal');
    }
  });

  it('keeps the deprecated SQL internal subpaths through 3.x', () => {
    const { exports } = manifest('sql');
    for (const name of ['adapter', 'records', 'transactions']) {
      expect(exports[`./internal/${name}`]).toBe(`./src/${name}.js`);
      expect(existsSync(join(root, 'packages/sql/src', `${name}.js`)), name).toBe(true);
    }
  });
});
