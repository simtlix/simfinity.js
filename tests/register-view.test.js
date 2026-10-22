import { expect, test, vi } from 'vitest';
import {
  GraphQLEnumType, GraphQLID, GraphQLInputObjectType, GraphQLInt, GraphQLList, GraphQLNonNull,
  GraphQLObjectType, GraphQLString,
} from 'graphql';
import { createRuntime } from '../packages/core/src/runtime.js';

const createAdapter = () => ({
  prepare: vi.fn(),
  createModel: vi.fn((type) => ({ name: type.name })),
  withTransaction: vi.fn(async (session, body) => body(session || { attempt: 1 })),
});

const entity = (name, extensions) => new GraphQLObjectType({
  name,
  fields: { id: { type: GraphQLID }, name: { type: GraphQLString } },
  extensions,
});

const Base = entity('NvBase');
const options = (extra = {}) => ({ type: Base, description: 'Open items', where: () => [], ...extra });

const invalidView = expect.objectContaining({ extensions: expect.objectContaining({ code: 'INVALID_VIEW', status: 500 }) });
const nameConflict = expect.objectContaining({ extensions: expect.objectContaining({ code: 'QUERY_NAME_CONFLICT', status: 500 }) });

test.each([
  ['empty name', '', {}],
  ['invalid name', 'open-items', {}],
  ['reserved name', '__openItems', {}],
  ['aggregate suffix', 'openItems_aggregate', {}],
  ['unknown option', 'openItems', { fields: {} }],
  ['missing description', 'openItems', { description: undefined }],
  ['empty description', 'openItems', { description: '' }],
  ['type not an object type', 'openItems', { type: GraphQLString }],
  ['where not a function', 'openItems', { where: [] }],
  ['param without type', 'openItems', { params: { from: {} } }],
  ['param entry null', 'openItems', { params: { from: null } }],
  ['param typed with an input object', 'openItems', { params: { from: { type: new GraphQLInputObjectType({ name: 'NvIn', fields: { a: { type: GraphQLString } } }) } } }],
  ['param typed with a list of input objects', 'openItems', { params: { from: { type: new GraphQLList(new GraphQLInputObjectType({ name: 'NvIn2', fields: { a: { type: GraphQLString } } })) } } }],
  ['param with an unknown key', 'openItems', { params: { from: { type: GraphQLString, resolve: () => 1 } } }],
  ['param description not a string', 'openItems', { params: { from: { type: GraphQLString, description: 1 } } }],
])('rejects %s at registration without keeping the entry', (label, name, invalid) => {
  const runtime = createRuntime(createAdapter());
  expect(() => runtime.registerView(name, options(invalid))).toThrow(invalidView);
  expect(() => runtime.registerView('openItems', options())).not.toThrow(); // the registry is intact
});

test.each([['no options', undefined], ['null options', null], ['array options', []]])('rejects %s', (label, value) => {
  expect(() => createRuntime(createAdapter()).registerView('openItems', value)).toThrow(invalidView);
});

test('accepts scalar, enum, list and NonNull param types', () => {
  const runtime = createRuntime(createAdapter());
  const Kind = new GraphQLEnumType({ name: 'NvKind', values: { A: { value: 'A' } } });
  expect(() => runtime.registerView('typedParams', options({
    params: {
      a: { type: GraphQLString },
      b: { type: new GraphQLNonNull(Kind) },
      c: { type: new GraphQLList(GraphQLID) },
      d: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLInt))), description: 'd', defaultValue: [1] },
    },
  }))).not.toThrow();
});

test('rejects a duplicate view name with QUERY_NAME_CONFLICT and keeps the first registration', async () => {
  const runtime = createRuntime(createAdapter());
  expect(() => runtime.registerView('openItems', options())).not.toThrow();
  expect(() => runtime.registerView('openItems', options({ description: 'Other' }))).toThrow(nameConflict);
  expect(() => runtime.registerView('openItems', options())).toThrow(nameConflict); // the first registration is kept
  expect(() => runtime.registerView('otherItems', options())).not.toThrow();
});

test('is exposed by the MongoDB and PostgreSQL facades', async () => {
  const mongo = await import('../packages/mongodb/src/index.js');
  const postgres = await import('../packages/postgres/src/index.js');
  expect(typeof mongo.registerView).toBe('function');
  expect(typeof postgres.registerView).toBe('function');
});
