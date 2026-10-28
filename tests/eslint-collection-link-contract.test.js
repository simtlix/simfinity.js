import { describe, expect, it, vi } from 'vitest';
import { Linter } from 'eslint';
import { GraphQLID, GraphQLList, GraphQLObjectType, GraphQLString } from 'graphql';
import { createRuntime } from '../packages/core/src/index.js';
import { createMongoAdapter } from '../packages/mongodb/src/mongo/adapter.js';
import { createPostgres } from '../packages/postgres/src/index.js';
import { createOptimisticMemoryAdapter } from './helpers/optimistic-memory-adapter.js';
import plugin from '../tools/eslint-plugin-simfinity/src/index.js';

const source = relation => `import * as sf from '@simtlix/simfinity-js';
import { GraphQLObjectType, GraphQLList, GraphQLID, GraphQLString } from 'graphql';
const Child = new GraphQLObjectType({ name: 'Child', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
const Owner = new GraphQLObjectType({ name: 'Owner', fields: { id: { type: GraphQLID }, children: { type: new GraphQLList(Child), extensions: { relation: ${relation} } } } });
sf.connect(null, Child, 'child', 'children'); sf.connect(null, Owner, 'owner', 'owners');`;
const register = (runtime, relation, extra = {}) => {
  const Child = new GraphQLObjectType({ name: 'Child', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
  const Owner = new GraphQLObjectType({ name: 'Owner', fields: {
    id: { type: GraphQLID },
    children: { type: new GraphQLList(Child), ...extra, extensions: { ...extra.extensions, relation } },
  } });
  runtime.connect(null, Child, 'child', 'children');
  runtime.connect(null, Owner, 'owner', 'owners');
};

describe.each([
  ['core', () => createRuntime(createOptimisticMemoryAdapter())],
  ['mongodb', () => createRuntime(createMongoAdapter())],
  ['postgres', () => createPostgres({ pool: { query: () => { throw new Error('Unexpected database access'); } } })],
])('ESLint required collection links match %s startup', (engine, create) => {
  // Hand-paired syntax and values, never evaluate linted application source.
  for (const [syntax, value] of [
    ['{}', {}],
    ['{ connectionField: null }', { connectionField: null }],
    ['{ connectionField: undefined }', { connectionField: undefined }],
    ['{ connectionField: "" }', { connectionField: '' }],
  ]) {
    it(`diagnoses a rejected link: ${syntax}`, () => {
      const runtime = create();
      register(runtime, value);
      expect(() => runtime.createSchema()).toThrow(expect.objectContaining({
        message: 'Owner.children requires a child connectionField',
        extensions: expect.objectContaining({ code: 'INVALID_MODEL', status: 400 }),
      }));
      expect(new Linter().verify(source(syntax), [plugin.configs['recommended-3.8']]).map(message => message.messageId)).toEqual(['missing']);
    });
  }
});

describe('core accepted missing-link variants remain outside the error rule', () => {
  for (const [syntax, extra] of [
    ['readOnly: true', { extensions: { readOnly: true } }],
    ['resolve: () => []', { resolve: () => [] }],
    ['readOnly: true, resolve: () => []', { extensions: { readOnly: true }, resolve: () => [] }],
  ]) {
    it(`preserves ${syntax}`, () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const runtime = createRuntime(createOptimisticMemoryAdapter());
        register(runtime, {}, extra);
        expect(() => runtime.createSchema()).not.toThrow();
        let text = source('{}');
        if (extra.extensions) text = text.replace('relation: {}', 'relation: {}, readOnly: true');
        if (extra.resolve) text = text.replace('type: new GraphQLList(Child),', 'type: new GraphQLList(Child), resolve: () => [],');
        expect(new Linter().verify(text, [plugin.configs['recommended-3.8']])).toEqual([]);
      } finally {
        warn.mockRestore();
      }
    });
  }
});
