import assert from 'node:assert/strict';
import { GraphQLID, GraphQLObjectType, GraphQLString, GraphQLList, GraphQLInterfaceType, GraphQLUnionType, GraphQLScalarType, printSchema, introspectionFromSchema } from 'graphql';

const mode = process.argv[2];
if (mode.endsWith('-disabled')) {
  const { configureIntrospection } = await import('@simtlix/simfinity-core/introspection');
  configureIntrospection({ fieldExtensions: false });
}
const core = await import('@simtlix/simfinity-core');
const { buildClientDescriptor, createClientDescriptorHandler } = await import('@simtlix/simfinity-descriptor');
let api;
if (mode.startsWith('mongodb')) {
  const mongo = await import('@simtlix/simfinity-js');
  assert.equal(mongo.buildClientDescriptor, undefined);
  api = core.createRuntime(mongo.createMongoAdapter({ referentialIntegrity: mode.includes('transactional') ? 'transactional' : 'off' }));
  api.preventCreatingCollection(true);
} else if (mode.startsWith('postgres')) {
  const pg = await import('@simtlix/simfinity-postgres');
  assert.equal(pg.buildClientDescriptor, undefined);
  api = pg.createPostgres({ pool: { connect() { throw new Error('Descriptor must not access database'); }, query() { throw new Error('Descriptor must not query'); } } });
} else api = core.createRuntime({ createModel: (type) => ({ name: type.name }) });
const Named = new GraphQLInterfaceType({ name: 'Named', fields: { name: { type: GraphQLString } } });
const Person = new GraphQLObjectType({ name: 'Person', interfaces: [Named], fields: { name: { type: GraphQLString } } });
const Choice = new GraphQLUnionType({ name: 'Choice', types: [Person] });
const Chapter = new GraphQLObjectType({ name: 'Chapter', fields: { id: { type: GraphQLID }, title: { type: GraphQLString } } });
const Money = new GraphQLScalarType({ name: 'Money', serialize: (value) => value });
const Value = new GraphQLObjectType({ name: 'RelationType', fields: { value: { type: GraphQLString } } });
const Book = new GraphQLObjectType({ name: 'Book', fields: {
  id: { type: GraphQLID }, title: { type: GraphQLString },
  value: { type: Value, extensions: { relation: { embedded: true } } },
  ...(mode.includes('permissive') ? {
    price: { type: Money },
    named: { type: Named, extensions: { readOnly: true } },
    choice: { type: Choice, extensions: { readOnly: true } },
    chapters: { type: new GraphQLList(Chapter), extensions: { readOnly: true, relation: {} }, resolve: () => [] },
  } : {}),
  computed: { type: GraphQLString, extensions: { virtual: { mcp: 'select' } }, resolve: () => 'value' },
} });
api.addNoEndpointType(Value); if (mode.includes('permissive')) api.addNoEndpointType(Chapter); api.connect(null, Book, 'book', 'books');
api.registerCustomQuery('choices', 'Choices', null, new GraphQLList(Choice), () => []);
const schema = api.createSchema();
const sdl = printSchema(schema); const introspection = introspectionFromSchema(schema);
const descriptor = buildClientDescriptor(schema);
assert.deepEqual(descriptor.types.Named.possibleTypes, ['Person']);
assert.deepEqual(descriptor.types.Choice.possibleTypes, ['Person']);
assert.ok(descriptor.types.RelationType);
assert.equal(descriptor.types.SimfinityRelationType, undefined);
assert.equal(printSchema(schema), sdl); assert.deepEqual(introspectionFromSchema(schema), introspection);
const foreign = await import('../../packages/descriptor/src/client-descriptor.js?other-copy');
assert.deepEqual(foreign.buildClientDescriptor(schema), descriptor); // Both consumers share core ownership.
if (mode.includes('permissive')) {
  assert.throws(() => core.describeModels(api.getRegistrations()), (error) => error.getCode() === 'INVALID_MODEL');
  const fields = Object.fromEntries(descriptor.types.Book.fields.map((f) => [f.name, f]));
  assert.equal(fields.price.kind, 'scalar'); assert.equal(fields.named.kind, 'interface');
  assert.equal(fields.choice.kind, 'union'); assert.equal(fields.chapters.relation.inverseField, null);
}
const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
await createClientDescriptorHandler(schema, { authorize: 'public' })({ method: 'GET', headers: {} }, response);
assert.equal(response.statusCode, 200);
console.log(JSON.stringify({ descriptor, body: response.body, etag: response.headers.ETag }));
