import assert from 'node:assert/strict';
import { GraphQLID, GraphQLObjectType, GraphQLString, graphql } from 'graphql';
import Client from '../../packages/client/src/SimfinityClient.js';
const mode = process.argv[2];
if (mode.endsWith('-disabled')) {
  const { configureIntrospection } = await import('@simtlix/simfinity-core/introspection');
  configureIntrospection({ fieldExtensions: false });
}
const core = await import('@simtlix/simfinity-core');
const { buildClientDescriptor } = await import('@simtlix/simfinity-descriptor');
let runtime;
if (mode.startsWith('mongo')) {
  const { createMongoAdapter } = await import('@simtlix/simfinity-js');
  runtime = core.createRuntime(createMongoAdapter()); runtime.preventCreatingCollection(true);
} else {
  const { createPostgres } = await import('@simtlix/simfinity-postgres');
  runtime = createPostgres({ pool: { connect() { throw new Error('No DB access for metadata'); }, query() { throw new Error('No DB query for metadata'); } } });
}
const Book = new GraphQLObjectType({ name: 'FixtureClientBook', fields: { id: { type: GraphQLID }, title: { type: GraphQLString } } });
runtime.connect(null, Book, 'lookupBook', 'catalog'); runtime.registerView('recentBooks', { description: 'Recent', type: Book, where: () => [] });
runtime.registerCustomQuery('health', 'Health', null, GraphQLString, () => 'ready');
const schema = runtime.createSchema(); const descriptor = buildClientDescriptor(schema);
const fetch = async (_, options) => {
  const { query, variables } = JSON.parse(options.body);
  if (query.includes('__schema')) throw new Error('Introspection disabled for descriptor client');
  return new Response(JSON.stringify(await graphql({ schema, source: query, variableValues: variables })));
};
const client = new Client('/g', { descriptor, fetch }); await client.init();
assert.equal(client.getPluralQueryName('FixtureClientBook'), 'catalog'); assert.equal(await client.query('health'), 'ready');
const introspected = new Client('/g', { introspection: mode.endsWith('-disabled') ? 'standard' : 'extended', fetch: async (_, options) => {
  const { query } = JSON.parse(options.body); return new Response(JSON.stringify(await graphql({ schema, source: query })));
} }); await introspected.init();
assert.equal(introspected.getPluralQueryName('FixtureClientBook'), 'catalog');
assert.equal(introspected.getTypes().FixtureClientBookInput.fields[0].type.name, 'String');
console.log('client metadata and query passed');
