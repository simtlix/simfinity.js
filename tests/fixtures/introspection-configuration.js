import assert from 'node:assert/strict';
import { GraphQLObjectType, GraphQLSchema, GraphQLString, __Field, buildClientSchema, introspectionFromSchema, validateSchema } from 'graphql';

const scenario = process.argv[2];
const config = await import('../../packages/core/src/introspection-config.js');
const configure = config.configureIntrospection;
const plain = () => new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Plain', fields: { hello: { type: GraphQLString } } }) });
const before = plain();
assert.equal(__Field.getFields().extensions, undefined);
if (scenario === 'late' || scenario === 'foreign') {
  if (scenario === 'late') await import('../../packages/core/src/index.js');
  else __Field.getFields().extensions = { name: 'extensions', type: GraphQLString, args: [] };
  const field = __Field.getFields().extensions;
  assert.throws(() => configure({ fieldExtensions: false }), (error) => error.getCode() === 'INVALID_INTROSPECTION_CONFIGURATION' && error.getStatus() === 500);
  assert.equal(__Field.getFields().extensions, field);
} else {
  if (scenario === 'invalid') {
    for (const value of [undefined, null, false, {}, [], { fieldExtensions: true }, { fieldExtensions: false, extra: true }, Object.assign(Object.create({ fieldExtensions: false }), {})]) {
      assert.throws(() => configure(value), /fieldExtensions/);
    }
  }
  configure({ fieldExtensions: false });
  const runtimeModule = await import('../../packages/core/src/index.js');
  if (scenario === 'mongodb') await import('../../packages/mongodb/src/index.js');
  if (scenario === 'postgres') await import('../../packages/postgres/src/index.js');
  if (scenario === 'repeated') {
    await import('../../packages/core/src/introspection.js?again');
    const other = await import('../../packages/core/src/introspection-config.js?again');
    other.configureIntrospection({ fieldExtensions: false });
  }
  configure({ fieldExtensions: false });
  const runtime = runtimeModule.createRuntime({ createModel: (type) => ({ name: type.name }) });
  runtime.connect(null, new GraphQLObjectType({ name: 'RelationType', fields: { title: { type: GraphQLString } } }), 'book', 'books');
  const schema = runtime.createSchema();
  assert.deepEqual(validateSchema(schema), []);
  assert.equal(schema.getType('FieldExtensionsType'), undefined);
  assert.equal(__Field.getFields().extensions, undefined);
  for (const item of [before, plain(), schema]) assert.deepEqual(validateSchema(buildClientSchema(introspectionFromSchema(item))), []);
}
