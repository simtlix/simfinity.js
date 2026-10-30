import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { GraphQLInt, GraphQLList, GraphQLObjectType, GraphQLString } from 'graphql';
import mongoose from 'mongoose';
import pg from 'pg';
import { createRuntime } from '../../packages/core/src/index.js';
import { createMongoAdapter } from '../../packages/mongodb/src/index.js';
import { createPostgres } from '../../packages/postgres/src/index.js';
import { buildClientDescriptor } from '../../packages/descriptor/src/index.js';
import Client from '../../packages/client/src/SimfinityClient.js';
import { clientWriteSchema } from '../helpers/client-writes.js';
import { schemaFetch } from '../helpers/client-schema.js';

for (const [engine, uri] of [['mongo', process.env.SIMFINITY_MONGODB_URI], ['postgres', process.env.SIMFINITY_POSTGRES_URI]]) {
  describe.skipIf(!uri)(`${engine} browser client through GraphQL`, () => {
    const namespace = `client_${randomUUID().replaceAll('-', '')}`;
    let pool; let runtime; let client;
    beforeAll(async () => {
      if (engine === 'mongo') await mongoose.connect(uri, { dbName: namespace });
      else pool = new pg.Pool({ connectionString: uri });
      runtime = engine === 'mongo' ? createRuntime(createMongoAdapter({ batchedCollections: true })) : createPostgres({ pool, schema: namespace });
      let Probe;
      const fixture = clientWriteSchema(runtime, ({ Entry }) => {
      // Extra stored embedded-list values exercise the new element-frame inputs.
      // Register a separate type before building the schema that the client uses.
      const Element = new GraphQLObjectType({ name: 'ClientElement', fields: { amount: { type: GraphQLInt } } });
      Probe = new GraphQLObjectType({ name: 'ClientProbe', fields: { name: { type: GraphQLString }, limit: { type: GraphQLInt }, elements: { type: new GraphQLList(Element), extensions: { relation: { embedded: true } } } } });
      runtime.addNoEndpointType(Element); runtime.connect(null, Probe, 'probe', 'probes');
      runtime.registerView('namedEntries', { description: 'Entries by literal name prefix', type: Entry, params: { prefix: { type: GraphQLString } }, where: ({ params }) => [{ conditions: [{ field: 'name', operator: 'STARTS_WITH', value: params.prefix || '' }] }] });
      });
      const schema = fixture.schema;
      if (engine === 'mongo') await Promise.all([fixture.Entry, fixture.Line, Probe].map((type) => runtime.getModel(type).init()));
      else await runtime.initializeDatabase();
      const descriptor = buildClientDescriptor(schema);
      const fetchGraphQL = schemaFetch(schema, descriptor);
      client = new Client('/graphql', { descriptor, fetch: async (...args) => {
        const response = await fetchGraphQL(...args); const envelope = await response.json();
        return new Response(JSON.stringify(envelope));
      } }); await client.init();
    }, 30000);
    afterAll(async () => {
      if (engine === 'mongo' && mongoose.connection.readyState) { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
      if (pool) { await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); await pool.end(); }
    });
    test('filters real rows with new operators, element comparisons and named views', async () => {
      await client.add('ClientEntry', { name: 'Alpha', tags: ['x', 'y'] });
      await client.add('ClientEntry', { name: 'Beta', tags: [] });
      expect((await client.find('ClientEntry').where('tags', 'CONTAINS_ALL', ['x', 'y']).fields('name').exec()).map((row) => row.name)).toEqual(['Alpha']);
      expect((await client.find('ClientEntry').where('name', 'IIN', ['ALPHA']).fields('name').exec()).map((row) => row.name)).toEqual(['Alpha']);
      expect((await client.find('ClientEntry').where('tags', 'IS_EMPTY').fields('name').exec()).map((row) => row.name)).toEqual(['Beta']);
      expect((await client.findView('namedEntries', { prefix: 'Al' }).where('name', 'ILIKE', 'alp').fields('name').exec()).map((row) => row.name)).toEqual(['Alpha']);
      const counted = await client.findView('namedEntries', { prefix: 'Al' }).fields('name').page(1, 10, true).execWithMeta();
      expect(counted.extensions?.count).toBe(1);
      await client.add('ClientProbe', { name: 'fits', limit: 5, elements: [{ amount: 4 }, { amount: 5 }] });
      await client.add('ClientProbe', { name: 'large', limit: 5, elements: [{ amount: 9 }] });
      expect((await client.find('ClientProbe').filter({ ALL: [{ path: 'elements', conditions: [{ field: 'amount', operator: 'LTE', valuePath: '$parent.limit' }] }] }).fields('name').exec()).map((row) => row.name)).toEqual(['fits']);
    });
    test('keeps real versions, nested input shapes and rollback/error positions', async () => {
      const added = await client.add('ClientEntry', { name: 'versioned', lines: { added: [{ title: 'child' }] } }, 'id name version lines { id version }', { transform: true, includeCollections: true });
      const child = added.lines[0];
      await expect(client.update('ClientEntry', added.id, { name: 'rejected', version: 1, lines: { deleted: [{ id: child.id, version: 8 }] } }, 'id version', { transform: true, includeCollections: true })).rejects.toMatchObject({ graphQLErrors: [expect.objectContaining({ extensions: expect.objectContaining({ code: 'VERSION_CONFLICT' }) })] });
      expect(await client.getById('ClientEntry', added.id, 'name version')).toEqual({ name: 'versioned', version: 1 });
      const changed = await client.update('ClientEntry', added.id, { name: 'updated', version: 1 }, 'id version', { transform: true }); expect(changed.version).toBe(2);
      await expect(client.transaction([{ updateentry: { id: added.id, version: 2, name: 'rollback' } }, { deleteline: { id: child.id, version: 8 } }])).rejects.toMatchObject({ graphQLErrors: [expect.objectContaining({ extensions: expect.objectContaining({ code: 'VERSION_CONFLICT', operationIndex: 1, operation: 'deleteline' }) })] });
      expect(await client.getById('ClientEntry', added.id, 'name version')).toEqual({ name: 'updated', version: 2 });
      const result = await client.transaction([{ addentry: { name: 'batch' } }, { updateentry: { id: '$0', version: 1, name: 'batch updated' } }], 'id updateentry { name version }'); expect(result[1].updateentry).toEqual({ name: 'batch updated', version: 2 });
      await client.delete('ClientLine', child.id, 'id version', { version: 1 });
      const deleted = await client.delete('ClientEntry', added.id, 'id version', { version: 2 }); expect(deleted.version).toBe(2);
    });
  });
}
