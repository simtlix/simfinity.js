import assert from 'node:assert/strict';
import {
  GraphQLID, GraphQLObjectType, GraphQLSchema, GraphQLString, __Field,
  getIntrospectionQuery, graphqlSync, validateSchema,
} from 'graphql';

const scenario = process.argv[2];
const customMetadata = { label: 'Preserved application metadata' };
const query = new GraphQLObjectType({
  name: 'IndependentQuery',
  fields: {
    greeting: {
      type: GraphQLString,
      resolve: () => 'hello',
      extensions: {
        readOnly: true,
        stateMachine: false,
        relation: { embedded: false, connectionField: 'author_id', displayField: 'name' },
        custom: customMetadata,
      },
    },
  },
});
const makeSchema = () => new GraphQLSchema({ query });
const metadataQuery = `{
  __type(name: "IndependentQuery") {
    fields {
      name
      extensions {
        readOnly
        stateMachine
        relation { embedded connectionField displayField }
      }
    }
  }
}`;

const assertUsable = (schema, includeMetadata = true) => {
  assert.deepEqual(validateSchema(schema), []);
  const response = graphqlSync({ schema, source: '{ greeting }' });
  assert.equal(response.errors, undefined);
  assert.equal(response.data.greeting, 'hello');
  assert.equal(schema.getQueryType(), query);
  assert.equal(query.getFields().greeting.extensions.custom, customMetadata);

  const introspection = graphqlSync({ schema, source: getIntrospectionQuery() });
  assert.equal(introspection.errors, undefined);
  assert.ok(introspection.data.__schema.types.some((type) => type.name === 'IndependentQuery'));

  if (includeMetadata) {
    const metadata = graphqlSync({ schema, source: metadataQuery });
    assert.equal(metadata.errors, undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(metadata.data.__type.fields)), [{
      name: 'greeting',
      extensions: {
        readOnly: true,
        stateMachine: false,
        relation: { embedded: false, connectionField: 'author_id', displayField: 'name' },
      },
    }]);
  }
};

let previousFields;
let previousSchema;
if (scenario === 'after-field-materialization') {
  previousFields = __Field.getFields();
}
if (scenario === 'after-schema-creation') {
  previousSchema = makeSchema();
  previousFields = __Field.getFields();
  assertUsable(previousSchema, false);
}

// Deliberately defer import to reproduce application load order in a fresh process.
const simfinity = await import('../../src/index.js');

if (scenario === 'repeated-imports-before-schema') {
  // Distinct URLs force module evaluation again while sharing the same GraphQL peer.
  await import('../../src/index.js?second-evaluation');
}

const schema = makeSchema();
assertUsable(schema);
const fields = __Field.getFields();
const extensionsField = fields.extensions;
const metadataType = extensionsField.type;
const relationType = metadataType.getFields().relation.type;
assert.equal(schema.getType('FieldExtensionsType'), metadataType);
assert.equal(schema.getType('RelationType'), relationType);

const fragmentResponse = graphqlSync({
  schema,
  source: `{
    __type(name: "IndependentQuery") {
      fields { extensions { ...Flags } }
    }
  }
  fragment Flags on FieldExtensionsType { readOnly }`,
});
assert.equal(fragmentResponse.errors, undefined);
assert.equal(fragmentResponse.data.__type.fields[0].extensions.readOnly, true);

if (previousFields) {
  assert.equal(__Field.getFields(), previousFields);
}
if (previousSchema) {
  assertUsable(previousSchema);
}

if (scenario === 'repeated-imports-after-schema') {
  await import('../../src/index.js?second-evaluation');
  const secondSchema = makeSchema();
  assertUsable(schema);
  assertUsable(secondSchema);
  assert.equal(__Field.getFields(), fields);
  assert.equal(__Field.getFields().extensions, extensionsField);
  assert.equal(secondSchema.getType('FieldExtensionsType'), metadataType);
  assert.equal(secondSchema.getType('RelationType'), relationType);
  // Reusing a schema config must not discover a second metadata type identity.
  assertUsable(new GraphQLSchema(schema.toConfig()));
}

if (scenario === 'repeated-create-schema') {
  simfinity.preventCreatingCollection(true);
  const serie = new GraphQLObjectType({
    name: 'InitializationSerie',
    fields: {
      id: { type: GraphQLID },
      name: { type: GraphQLString, extensions: { custom: customMetadata } },
    },
  });
  simfinity.connect(null, serie, 'initializationSerie', 'initializationSeries');
  const first = simfinity.createSchema();
  const second = simfinity.createSchema();
  for (const generated of [first, second]) {
    assert.deepEqual(validateSchema(generated), []);
    const introspection = graphqlSync({ schema: generated, source: getIntrospectionQuery() });
    assert.equal(introspection.errors, undefined);
    assert.equal(generated.getType('InitializationSerie'), serie);
    assert.equal(generated.getType('FieldExtensionsType'), metadataType);
    assert.equal(generated.getType('RelationType'), relationType);
    assert.equal(serie.getFields().name.extensions.custom, customMetadata);
  }
}

console.log(`${scenario}: passed`);
