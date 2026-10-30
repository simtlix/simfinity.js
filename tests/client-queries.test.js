import { describe, expect, test } from 'vitest';
import { buildSchema } from 'graphql';
import SimfinityClient from '../packages/client/src/SimfinityClient.js';
import { clientSchema, schemaFetch } from './helpers/client-schema.js';

const initialized = async (fixture = clientSchema()) => {
  const requests = [];
  const client = new SimfinityClient('/graphql', { descriptor: fixture.descriptor, fetch: schemaFetch(fixture.schema, fixture.descriptor, requests) });
  await client.init(); return { ...fixture, client, requests };
};
describe('client query construction', () => {
  test('keeps canonical lists distinct from views and resolves exact scalar custom roots', async () => {
    const fixture = clientSchema({ singular: 'lookup', plural: 'catalog' });
    fixture.schema.getQueryType().getFields().catalog.resolve = () => [{ id: '1', title: 'canonical' }];
    fixture.schema.getQueryType().getFields().recent.resolve = (_, { term }) => [{ id: '2', title: term }];
    const { client } = await initialized(fixture);
    expect(await client.find('book').fields('id title').exec()).toEqual([{ id: '1', title: 'canonical' }]);
    expect(await client.findView('recent', { term: 'quoted " title' }).fields('title').exec()).toEqual([{ title: 'quoted " title' }]);
    expect(client.getViews('book').map((v) => v.name)).toEqual(['recent']);
    expect(await client.query('same')).toBe('query');
    expect(await client.customMutation('same')).toBe('mutation');
    await expect(client.query('same', { unknown: 1 })).rejects.toThrow(/unknown/i);
  });
  test('sends structured filters and preserves frame boundaries and parent paths', async () => {
    const fixture = clientSchema(); let received;
    fixture.schema.getQueryType().getFields().books.resolve = (_, args) => { received = args; return []; };
    const { client } = await initialized(fixture);
    const group = { ALL: [{ path: 'lines', conditions: [{ field: 'title', operator: 'EQ', valuePath: '$parent.title' }] }] };
    await client.find('book').where('title', { operator: 'EQ', valuePath: 'title' }).where('tags', 'CONTAINS_ALL', ['x']).filter(group).exec();
    expect(received.title).toMatchObject({ valuePath: 'title' });
    expect(received.tags).toMatchObject({ operator: 'CONTAINS_ALL', value: ['x'] });
    expect(received.AND[0]).toMatchObject(group);
  });
  test('builds nested collection args with independent variables and aliases', async () => {
    const schema = buildSchema('type Query { parents: [Parent!]! } type Parent { id: ID!, children(limit: Int, text: String): [Child!]! } type Child { id: ID!, name: String }');
    schema.getQueryType().getFields().parents.resolve = () => [{ id: 'p', children: ({ limit, text }) => [{ id: String(limit), name: text }] }];
    const client = new SimfinityClient('/graphql', { introspection: 'standard', fetch: schemaFetch(schema) }); await client.init();
    const result = await client.find('Parent').fields('id left: children { id name } right: children { id }')
      .collectionArgs('left', { limit: 1, text: '"}) injected' }).collectionArgs('right', { limit: 2 }).exec();
    expect(result).toEqual([{ id: 'p', left: [{ id: '1', name: '"}) injected' }], right: [{ id: '2' }] }]);
    await expect(client.find('Parent').joinCollection('children', 'id').collectionArgs('children', { misspelled: 1 }).exec()).rejects.toThrow(/misspelled/);
  });
  test('supports custom abstract outputs with explicit fragments and default object fields', async () => {
    const schema = buildSchema('interface Named { name: String } type Person implements Named { name: String } union Choice = Person type Query { choice: Choice, named: Named, person: Person, numbers: [Int!]! }');
    const person = { __typename: 'Person', name: 'Ada' };
    for (const field of ['choice', 'named', 'person']) schema.getQueryType().getFields()[field].resolve = () => person;
    schema.getQueryType().getFields().numbers.resolve = () => [1, 2];
    const client = new SimfinityClient('/graphql', { introspection: 'standard', fetch: schemaFetch(schema) }); await client.init();
    expect(await client.query('choice', {}, '__typename ... on Person { name }')).toEqual(person);
    expect(await client.query('named', {}, '__typename name')).toEqual(person);
    expect(await client.query('person')).toEqual({ name: 'Ada' });
    expect(await client.query('numbers')).toEqual([1, 2]);
  });
  test('keeps legacy builder filtering, joins, metadata and aggregate result shapes', async () => {
    const fixture = clientSchema();
    fixture.schema.getQueryType().getFields().books.resolve = () => [{ id: 'id', title: 'legacy' }];
    fixture.schema.getQueryType().getFields().books_aggregate.resolve = () => [{ groupId: 'title', facts: { count: 1 } }];
    const { client } = await initialized(fixture);
    const builder = client.find('book').where('title', 'LIKE', 'leg').or([SimfinityClient.condition('title', 'EQ', 'legacy')]).sort('title', 'ASC').page(1, 5, true).fields('id title');
    expect(await builder.execWithMeta()).toEqual({ data: [{ id: 'id', title: 'legacy' }], extensions: null });
    expect(await client.aggregate('book').groupBy('title').fact('COUNT', 'count', 'id').filter({ conditions: [{ field: 'title', operator: 'IS_NOT_EMPTY' }] }).exec()).toEqual([{ groupId: 'title', facts: { count: 1 } }]);
    expect(client.buildSelectionSet('book').selection).not.toContain('computed');
  });
});
