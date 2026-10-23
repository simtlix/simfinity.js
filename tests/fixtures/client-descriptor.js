import assert from 'node:assert/strict';
import { GraphQLID, GraphQLObjectType, GraphQLString, GraphQLList, GraphQLInterfaceType, GraphQLUnionType, printSchema, introspectionFromSchema } from 'graphql';

const mode = process.argv[2];
if (mode.endsWith('-disabled')) {
  const { configureIntrospection } = await import('@simtlix/simfinity-core/introspection');
  configureIntrospection({ fieldExtensions: false });
}
const core = await import('@simtlix/simfinity-core');
let api;
if (mode.startsWith('mongodb')) {
  const mongo = await import('@simtlix/simfinity-js');
  assert.equal(mongo.buildClientDescriptor, core.buildClientDescriptor);
  api = core.createRuntime(mongo.createMongoAdapter({ referentialIntegrity: mode.includes('transactional') ? 'transactional' : 'off' }));
  api.preventCreatingCollection(true);
} else if (mode.startsWith('postgres')) {
  const pg = await import('@simtlix/simfinity-postgres');
  assert.equal(pg.buildClientDescriptor, core.buildClientDescriptor);
  api = pg.createPostgres({ pool: { connect() { throw new Error('Descriptor must not access database'); }, query() { throw new Error('Descriptor must not query'); } } });
} else api = core.createRuntime({ createModel: (type) => ({ name: type.name }) });
const Value = new GraphQLObjectType({ name: 'RelationType', fields: { value: { type: GraphQLString } } });
const Book = new GraphQLObjectType({ name: 'Book', fields: {
  id: { type: GraphQLID }, title: { type: GraphQLString },
  value: { type: Value, extensions: { relation: { embedded: true } } },
  computed: { type: GraphQLString, extensions: { virtual: { mcp: 'select' } }, resolve: () => 'value' },
} });
api.addNoEndpointType(Value); api.connect(null, Book, 'book', 'books');
const Named = new GraphQLInterfaceType({ name: 'Named', fields: { name: { type: GraphQLString } } });
const Person = new GraphQLObjectType({ name: 'Person', interfaces: [Named], fields: { name: { type: GraphQLString } } });
const Choice = new GraphQLUnionType({ name: 'Choice', types: [Person] });
api.registerCustomQuery('choices', 'Choices', null, new GraphQLList(Choice), () => []);
const schema = api.createSchema();
const sdl = printSchema(schema); const introspection = introspectionFromSchema(schema);
const descriptor = core.buildClientDescriptor(schema);
assert.deepEqual(descriptor.types.Named.possibleTypes, ['Person']);
assert.deepEqual(descriptor.types.Choice.possibleTypes, ['Person']);
assert.ok(descriptor.types.RelationType);
assert.equal(descriptor.types.SimfinityRelationType, undefined);
assert.equal(printSchema(schema), sdl); assert.deepEqual(introspectionFromSchema(schema), introspection);
const foreign = await import('../../packages/core/src/client-descriptor.js?other-registry');
assert.throws(() => foreign.buildClientDescriptor(schema), /Simfinity schema/);
console.log(JSON.stringify(descriptor));
