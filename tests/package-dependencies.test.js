import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const readJSON = (path) => JSON.parse(readFileSync(`${root}${path}`, 'utf8'));
const directories = ['packages/core', 'packages/sql', 'packages/mcp', 'packages/postgres', 'packages/mongodb'];
const installedGroups = ['dependencies', 'optionalDependencies'];

describe('published dependency declarations', () => {
  test.each(directories)('%s never repeats a peer as an installed dependency', (directory) => {
    const manifest = readJSON(`${directory}/package.json`);
    // npm replaces a peer edge with a later optional/prod edge, silently nesting a second copy.
    const repeated = Object.keys(manifest.peerDependencies || {})
      .filter((name) => installedGroups.some((group) => Object.hasOwn(manifest[group] || {}, name)));
    expect(repeated).toEqual([]);
  });

  test('the MongoDB facade shares the application graphql and mongoose peers', () => {
    const manifest = readJSON('packages/mongodb/package.json');
    const locked = readJSON('package-lock.json').packages['packages/mongodb'];

    for (const declaration of [manifest, locked]) {
      expect(declaration.optionalDependencies).toBeUndefined();
      expect(Object.keys(declaration.peerDependencies).sort()).toEqual(['@modelcontextprotocol/sdk', 'graphql', 'mongoose']);
      // Only the SDK is optional; graphql and mongoose stay required peers.
      expect(declaration.peerDependenciesMeta).toEqual({ '@modelcontextprotocol/sdk': { optional: true } });
    }
  });

  test.each(directories)('%s does not depend on graphql-middleware', (directory) => {
    const manifest = readJSON(`${directory}/package.json`);
    for (const group of [...installedGroups, 'peerDependencies']) {
      expect(Object.keys(manifest[group] || {})).not.toContain('graphql-middleware');
    }
  });
});
