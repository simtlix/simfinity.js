import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';

test('the opt-in descriptor imports before configuration without patching GraphQL', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { __Field } from 'graphql';
    import { buildClientDescriptor, createClientDescriptorHandler } from '@simtlix/simfinity-descriptor';
    import { configureIntrospection } from '@simtlix/simfinity-core/introspection';
    assert.equal(__Field.getFields().extensions, undefined);
    configureIntrospection({ fieldExtensions: false });
    const core = await import('@simtlix/simfinity-core');
    const mongo = await import('@simtlix/simfinity-js');
    const postgres = await import('@simtlix/simfinity-postgres');
    for (const api of [core, mongo, postgres]) {
      assert.equal(api.buildClientDescriptor, undefined);
      assert.equal(api.createClientDescriptorHandler, undefined);
    }
    assert.equal(typeof buildClientDescriptor, 'function');
    assert.equal(typeof createClientDescriptorHandler, 'function');
    assert.equal(__Field.getFields().extensions, undefined);
  `], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
});

test('core keeps no production dependency and descriptor depends only on exact core', () => {
  const read = (name) => JSON.parse(readFileSync(new URL(`../packages/${name}/package.json`, import.meta.url), 'utf8'));
  expect(read('core').dependencies || {}).toEqual({});
  expect(read('core').exports['./http']).toBeUndefined();
  expect(read('descriptor').dependencies).toEqual({ '@simtlix/simfinity-core': read('core').version });
});
