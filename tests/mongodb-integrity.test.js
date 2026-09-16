import { describe, expect, test } from 'vitest';
import { GraphQLID, GraphQLObjectType, GraphQLString } from 'graphql';
import { createMongoAdapter, createRuntime } from '../packages/mongodb/src/index.js';

describe('MongoDB integrity configuration', () => {
  test.each(['strict', '', true, null, 0])('rejects invalid mode %s instead of silently disabling protection', (mode) => {
    expect(() => createMongoAdapter({ referentialIntegrity: mode })).toThrow();
  });

  test('rejects misspelled option names', () => {
    expect(() => createMongoAdapter({ referenceIntegrity: 'transactional' })).toThrow();
  });

  test('captures immutable startup configuration and keeps the default off', () => {
    const options = { referentialIntegrity: 'transactional' };
    const adapter = createMongoAdapter(options);
    options.referentialIntegrity = 'off';
    expect(adapter.referentialIntegrity).toBe('transactional');
    expect(() => { adapter.referentialIntegrity = 'off'; }).toThrow();
    expect(createMongoAdapter().referentialIntegrity).toBe('off');
  });

  test('rejects binding a protected adapter to multiple registries', () => {
    const adapter = createMongoAdapter({ referentialIntegrity: 'transactional' });
    createRuntime(adapter);
    expect(() => createRuntime(adapter)).toThrow();
  });

  test('rejects a domain field that collides with the lock metadata', () => {
    const runtime = createRuntime(createMongoAdapter({ referentialIntegrity: 'transactional' }));
    runtime.preventCreatingCollection(true);
    runtime.connect(null, new GraphQLObjectType({
      name: 'ReservedIntegrityField',
      fields: { id: { type: GraphQLID }, _simfinityReferenceLock: { type: GraphQLString } },
    }), 'reserved', 'reserveds');
    expect(() => runtime.createSchema()).toThrow();
  });
});
