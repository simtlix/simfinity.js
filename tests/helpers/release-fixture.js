import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const writeReleaseFixture = (root) => {
  mkdirSync(root, { recursive: true });
  const items = [
    ['packages/mongodb', '@simtlix/simfinity-js', { '@simtlix/simfinity-core': '0.1.0', '@simtlix/simfinity-mcp': '0.1.0' }],
    ['packages/core', '@simtlix/simfinity-core', {}],
    ['packages/mcp', '@simtlix/simfinity-mcp', { '@simtlix/simfinity-core': '0.1.0' }],
    ['packages/postgres', '@simtlix/simfinity-postgres', { '@simtlix/simfinity-core': '0.1.0', pg: '^8.16.3' }],
  ];
  const coordinator = { name: 'simfinity-workspace', version: '3.1.0', private: true, workspaces: ['packages/*'] };
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(coordinator, null, 2)}\n`.replaceAll('\n', '\r\n'));
  const lock = { name: coordinator.name, version: coordinator.version, lockfileVersion: 2, packages: { '': structuredClone(coordinator) }, dependencies: {} };
  for (const [directory, name, dependencies] of items) {
    const version = '0.1.0';
    mkdirSync(join(root, directory, 'src'), { recursive: true });
    const manifest = { name, version, type: 'module', files: ['src'], main: 'src/index.js', dependencies, peerDependencies: { graphql: '^16.11.0' }, scripts: { prepack: 'exit 97' } };
    writeFileSync(join(root, directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`.replaceAll('\n', '\r\n'));
    writeFileSync(join(root, directory, 'src/index.js'), 'export const value = 42;\n');
    lock.packages[directory] = structuredClone(manifest);
    if (directory) {
      lock.packages[`node_modules/${name}`] = { resolved: directory, link: true };
      lock.dependencies[name] = { version: `file:${directory}`, requires: { ...dependencies } };
    }
  }
  lock.packages['node_modules/pg'] = { version: '8.16.3', integrity: 'preserve-external-entry' };
  writeFileSync(join(root, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`.replaceAll('\n', '\r\n'));
  return root;
};
