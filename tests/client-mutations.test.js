import { describe, expect, test } from 'vitest';
import { GraphQLEnumType, GraphQLID, GraphQLObjectType } from 'graphql';
import { createRuntime } from '../packages/core/src/index.js';
import { createOptimisticMemoryAdapter } from './helpers/optimistic-memory-adapter.js';
import { buildClientDescriptor } from '../packages/descriptor/src/index.js';
import SimfinityClient from '../packages/client/src/SimfinityClient.js';
import { clientWriteSchema } from './helpers/client-writes.js';
import { clientSchema, schemaFetch } from './helpers/client-schema.js';
const setup = async () => {
  const fixture = clientWriteSchema(); const requests = [];
  const client = new SimfinityClient('/graphql', { descriptor: fixture.descriptor, fetch: schemaFetch(fixture.schema, fixture.descriptor, requests) }); await client.init();
  return { ...fixture, client, requests };
};
describe('client managed writes', () => {
  test('uses exact generated roots and preserves versions through transformed updates and actions', async () => {
    const { client } = await setup();
    const added = await client.add('ClientEntry', { name: 'one' }, 'id name version state');
    expect(added).toMatchObject({ name: 'one', version: 1, state: 'OPEN' });
    const updated = await client.update('ClientEntry', added.id, { name: 'two', version: 1 }, 'id name version', { transform: true });
    expect(updated).toMatchObject({ name: 'two', version: 2 });
    expect(await client.transition('ClientEntry', 'close', added.id, { version: 2 }, 'id version state')).toMatchObject({ version: 3, state: 'CLOSED' });
    expect(await client.delete('ClientEntry', added.id, 'id version', { version: 3 })).toMatchObject({ id: added.id, version: 3 });
  });
  test('transforms actual nested inputs and rolls back on a stale protected child', async () => {
    const { client } = await setup(); const input = { name: 'parent', lines: { added: [{ id: 'temp_1', title: 'child', __status: 'added' }] } }; const snapshot = structuredClone(input);
    const added = await client.add('ClientEntry', input, 'id name version lines { id title version }', { transform: true, includeCollections: true });
    expect(input).toEqual(snapshot); expect(added.lines[0]).toMatchObject({ title: 'child', version: 1 });
    const child = added.lines[0];
    await expect(client.update('ClientEntry', added.id, { name: 'rejected', version: 1, lines: { deleted: [{ id: child.id, version: 9 }] } }, 'id version', { transform: true, includeCollections: true })).rejects.toMatchObject({ graphQLErrors: [expect.objectContaining({ extensions: expect.objectContaining({ code: 'VERSION_CONFLICT' }) })] });
    expect(await client.getById('ClientEntry', added.id, 'name version lines { id version }')).toMatchObject({ name: 'parent', version: 1, lines: [{ id: child.id, version: 1 }] });
    const changed = await client.update('ClientEntry', added.id, { version: 1, lines: { deleted: [{ id: child.id, version: 1 }] } }, 'id version lines { id }', { transform: true, includeCollections: true });
    expect(changed).toMatchObject({ version: 2, lines: [] });
  });
  test('keeps protected delete references and opaque IDs, and rejects lost preconditions', async () => {
    const { client } = await setup();
    expect(client.transformCollectionDelta('ClientLine', { deleted: [{ id: 'uuid-or-$0', version: 7 }, null] })).toEqual({ deleted: [{ id: 'uuid-or-$0', version: 7 }, null] });
    expect(() => client.transformCollectionDelta('ClientLine', { deleted: ['uuid'] })).toThrow(/version/i);
    expect(() => client.transformInput('ClientEntry', { version: '1' }, { mode: 'update' })).toThrow(/version/i);
    const old = clientSchema(); const unprotected = new SimfinityClient('/g', { descriptor: old.descriptor }); await unprotected.init();
    expect(unprotected.transformCollectionDelta('book', { deleted: [{ id: 'opaque' }] })).toEqual({ deleted: ['opaque'] });
    await expect(unprotected.delete('book', 'opaque', 'id', { version: 1 })).rejects.toThrow(/version/i);
  });
  test('preserves clears and scalar list shape only with explicit form-cleaning options', async () => {
    const { client } = await setup();
    const input = { name: null, tags: [], numbers: ['1', '2'], detail: { text: '', count: '2' }, version: 1, __typename: 'ClientEntry' };
    expect(client.transformInput('ClientEntry', input, { mode: 'update', preserveEmpty: true })).toEqual({ name: null, tags: [], numbers: [1, 2], detail: { text: '', count: 2 }, version: 1 });
    expect(input.numbers).toEqual(['1', '2']);
    expect(client.transformInput('ClientEntry', { id: 'id', name: '', lines: { added: [] }, state: 'OPEN', unknown: 'x' })).toEqual({});
  });
  test('sends one transaction mutation with explicit versions and unmodified reference tokens', async () => {
    const { client, requests } = await setup();
    const operations = [{ addentry: { name: '$0' } }, { updateentry: { id: '$0', name: 'updated', version: 1 } }, { addline: { title: '$$0', entry: { id: '$0' } } }];
    const result = await client.transaction(operations, 'id addentry { name version } updateentry { name version } addline { title version }');
    expect(result).toHaveLength(3); expect(result[0].addentry).toEqual({ name: '$0', version: 1 }); expect(result[1].updateentry).toEqual({ name: 'updated', version: 2 });
    expect(result[2].addline).toMatchObject({ title: '$$0', version: 1 });
    expect(JSON.parse(requests[0].body).variables.operations).toEqual(operations);
    await expect(client.transaction([{ updateentry: { id: result[0].id, version: 1, name: 'stale' } }])).rejects.toMatchObject({ graphQLErrors: [expect.objectContaining({ extensions: expect.objectContaining({ code: 'VERSION_CONFLICT', operationIndex: 0, operation: 'updateentry' }) })] });
  });
});

test('discovers legacy state actions when GraphQL type and endpoint names differ', async () => {
  const fixture = clientWriteSchema();
  const client = new SimfinityClient('/g', { fetch: schemaFetch(fixture.schema) }); await client.init();
  const added = await client.add('ClientEntry', { name: 'legacy' }, 'id version');
  expect(await client.transition('ClientEntry', 'close', added.id, { version: 1 }, 'state version')).toEqual({ state: 'CLOSED', version: 2 });
});
test('transforms protected child deletes even when that child has no mutation roots', async () => {
  const fixture = clientWriteSchema();
  const schema = fixture.runtime.createSchema(null, [fixture.Entry], []);
  const client = new SimfinityClient('/g', { descriptor: buildClientDescriptor(schema) }); await client.init();
  expect(client.getDescriptor().operations.mutation.addentry.operation).toBe('add');
  expect(client.getDescriptor().types.ClientLine.endpoints?.delete).toBeUndefined();
  expect(client.transformCollectionDelta('ClientLine', { deleted: [{ id: 'opaque', version: 1 }] })).toEqual({ deleted: [{ id: 'opaque', version: 1 }] });
});

test('retains protected child identity and version without exposed child roots under introspection', async () => {
  const fixture = clientWriteSchema(); const schema = fixture.runtime.createSchema(null, [fixture.Entry], []);
  const client = new SimfinityClient('/g', { fetch: schemaFetch(schema) }); await client.init();
  expect(client.transformCollectionDelta('ClientLine', { updated: [{ id: 'uuid', title: 'changed', version: 1 }] })).toEqual({ updated: [{ id: 'uuid', title: 'changed', version: 1 }] });
  expect(() => client.transformCollectionDelta('ClientLine', { updated: [{ id: 'uuid', title: 'changed' }] })).toThrow(/version/i);
});
test('converts automatic unprotected nested deletion forms to scalar identities', async () => {
  const fixture = clientWriteSchema(undefined, undefined, { protectedRecords: false });
  const client = new SimfinityClient('/g', { descriptor: fixture.descriptor, fetch: schemaFetch(fixture.schema) }); await client.init();
  const added = await client.add('ClientEntry', { name: 'p', lines: { added: [{ title: 'c' }] } }, 'id lines { id }');
  const changed = await client.update('ClientEntry', added.id, { lines: { deleted: [{ id: added.lines[0].id, __status: 'deleted' }] } }, 'id lines { id }', { transform: true, includeCollections: true });
  expect(changed.lines).toEqual([]);
});
test('preserveEmpty retains explicit blanks before numeric coercion at every depth', async () => {
  const { client } = await setup();
  expect(client.transformInput('ClientEntry', { detail: { count: '' }, numbers: ['', '2'], version: 1 }, { mode: 'update', preserveEmpty: true })).toEqual({ detail: { count: '' }, numbers: ['', 2], version: 1 });
});
test('does not numerically coerce enum members whose enum name resembles a validated scalar', async () => {
  const runtime = createRuntime(createOptimisticMemoryAdapter());
  const Priority = new GraphQLEnumType({ name: 'Priority_Int', values: { HIGH: {}, LOW: {} } });
  const Item = new GraphQLObjectType({ name: 'EnumItem', fields: { id: { type: GraphQLID }, priority: { type: Priority } } });
  runtime.connect(null, Item, 'item', 'items'); const schema = runtime.createSchema();
  const client = new SimfinityClient('/g', { descriptor: buildClientDescriptor(schema), fetch: schemaFetch(schema) }); await client.init();
  expect(await client.add('EnumItem', { priority: 'HIGH' }, 'priority', { transform: true })).toEqual({ priority: 'HIGH' });
});
