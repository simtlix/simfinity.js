// Runs one scenario of Simfinity's field metadata type names (#162) in a fresh process, since the
// metadata types of `__Field.extensions` are shared by every schema of a process.
import assert from 'node:assert/strict';
import {
  GraphQLEnumType, GraphQLID, GraphQLInputObjectType, GraphQLNonNull, GraphQLObjectType, GraphQLSchema,
  GraphQLString, __Field, graphql, validateSchema,
} from 'graphql';
import mongoose from 'mongoose';
import { createRuntime, auth } from '../../packages/core/src/index.js';
import { createMongoAdapter } from '../../packages/mongodb/src/mongo/adapter.js';
import { createPostgres } from '../../packages/postgres/src/index.js';

const [scenario, backend = 'core'] = process.argv.slice(2);
const warnings = [];
console.warn = (message) => warnings.push(String(message));

let prepared = 0;
const runtimes = {
  core: (create = createRuntime) => create({
    prepare() { prepared += 1; },
    createModel: (gqltype) => ({ name: gqltype.name }),
    castId: String,
    withTransaction: async (session, body) => body(session || {}),
  }),
  mongodb: () => {
    const runtime = createRuntime(createMongoAdapter());
    runtime.preventCreatingCollection(true);
    return runtime;
  },
  postgres: () => createPostgres({ pool: { connect() {}, query() {} }, schema: 'field_metadata_names' }),
};
const newRuntime = () => runtimes[backend]();

const entity = (name, fields = {}) => new GraphQLObjectType({
  name,
  fields: () => ({
    id: { type: GraphQLID },
    name: { type: GraphQLString, extensions: { readOnly: true } },
    label: { type: GraphQLString },
    ...fields,
  }),
});
const connectAll = (runtime, types) => {
  for (const type of types) runtime.connect(null, type, type.name.toLowerCase(), `${type.name.toLowerCase()}s`);
  return runtime;
};
const schemaWith = (...types) => connectAll(newRuntime(), types).createSchema();
const metadataTypes = () => {
  const extensionsType = __Field.getFields().extensions.type;
  return [extensionsType, extensionsType.getFields().relation.type];
};
const metadataOf = async (schema, typeName, fragmentType) => {
  const result = await graphql({
    schema,
    source: `{ __type(name: "${typeName}") { fields { name extensions { ...Flags relation { embedded } } } } }
      fragment Flags on ${fragmentType} { readOnly }`,
  });
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  return JSON.parse(JSON.stringify(result.data.__type.fields.find((field) => field.name === 'name').extensions));
};
const assertReserved = (create, typeName) => assert.throws(create, (error) => {
  assert.equal(error.extensions.code, 'RESERVED_TYPE_NAME');
  assert.equal(error.extensions.status, 500);
  assert.match(error.message, new RegExp(`^Type ${typeName} has the name of a type that Simfinity adds to every schema`));
  return true;
});
const assertRenamed = (appType, suffix = '') => {
  const [extensionsType, relationType] = metadataTypes();
  assert.equal(extensionsType.name, `SimfinityFieldExtensionsType${suffix}`);
  assert.equal(relationType.name, `SimfinityRelationType${suffix}`);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], new RegExp(`^Configuration issue: the schema has a type named ${appType.name}, .*so `
    + `Simfinity names its types SimfinityFieldExtensionsType${suffix} and SimfinityRelationType${suffix} in every `
    + 'schema this process creates from now on'));
  return [extensionsType, relationType];
};
// A registered mutation whose input object type has the given name.
const withInputNamed = (runtime, inputName) => {
  runtime.registerMutation('importThings', 'Imports things', new GraphQLInputObjectType({
    name: inputName,
    fields: { count: { type: GraphQLString } },
  }), entity('Imported'), () => null);
  return runtime;
};
// A registered mutation whose input's fields function reads the runtime's generated input of `type`,
// as the relationships guide shows. That input exists only once the schema's inputs are built.
const withGeneratedInputThunk = (runtime, type) => {
  runtime.registerMutation(`import${type.name}`, 'Imports one item', new GraphQLInputObjectType({
    name: `${type.name}ImportInput`,
    fields: () => ({ item: { type: new GraphQLNonNull(runtime.getInputType(type)) } }),
  }), type, async ({ item }) => ({ id: '1', ...item }));
  return runtime;
};
// Runs that mutation. Core runs it in memory and MongoDB on the disposable database of
// SIMFINITY_MONGODB_URI when one is set; the PostgreSQL pool of this fixture is a stub.
const assertImportRuns = async (schema, type) => {
  const mongoUri = backend === 'mongodb' ? process.env.SIMFINITY_MONGODB_URI : undefined;
  if (backend === 'postgres' || (backend === 'mongodb' && !mongoUri)) return;
  if (mongoUri) {
    await mongoose.connect(mongoUri, {
      dbName: `field_metadata_names_${process.pid}`, autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 5000,
    });
  }
  try {
    const result = await graphql({
      schema, source: `mutation { import${type.name}(input: { item: { label: "T" } }) { id label } }`, contextValue: {},
    });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { data: { [`import${type.name}`]: { id: '1', label: 'T' } } });
  } finally {
    if (mongoUri) await mongoose.disconnect();
  }
};

if (scenario === 'no-clash') {
  const [extensionsType, relationType] = metadataTypes();
  const schema = schemaWith(entity('Plain'));
  assert.deepEqual(validateSchema(schema), []);
  assert.equal(schema.getType('FieldExtensionsType'), extensionsType);
  assert.equal(schema.getType('RelationType'), relationType);
  assert.deepEqual(metadataTypes(), [extensionsType, relationType]);
  assert.deepEqual(await metadataOf(schema, 'Plain', 'FieldExtensionsType'), { readOnly: true, relation: null });
  assert.deepEqual(warnings, []);
}

if (scenario === 'registered-clash' || scenario === 'nested-clash' || scenario === 'input-clash') {
  const runtime = newRuntime();
  let appType;
  let holder;
  if (scenario === 'registered-clash') {
    appType = entity('RelationType');
    holder = appType;
    connectAll(runtime, [appType]);
  } else if (scenario === 'nested-clash') {
    appType = new GraphQLEnumType({ name: 'FieldExtensionsType', values: { A: {} } });
    holder = entity('Holder', { kind: { type: appType } });
    connectAll(runtime, [holder]);
  } else {
    holder = entity('Holder');
    connectAll(runtime, [holder]);
    withInputNamed(runtime, 'RelationType');
  }
  const schema = runtime.createSchema();
  if (scenario === 'input-clash') {
    appType = schema.getType('RelationType');
    assert.ok(appType instanceof GraphQLInputObjectType);
  }
  assert.deepEqual(validateSchema(schema), []);
  const [extensionsType, relationType] = assertRenamed(appType);
  assert.equal(schema.getType(appType.name), appType);
  assert.equal(schema.getType('SimfinityFieldExtensionsType'), extensionsType);
  assert.equal(schema.getType('SimfinityRelationType'), relationType);
  assert.deepEqual(await metadataOf(schema, holder.name, 'SimfinityFieldExtensionsType'), { readOnly: true, relation: null });
  // The names belong to the process: later schemas, Simfinity or not, keep them, without a new warning.
  const again = schemaWith(entity('Later'));
  assert.equal(again.getType('SimfinityFieldExtensionsType'), extensionsType);
  assert.equal(again.getType('FieldExtensionsType'), undefined);
  const args = appType instanceof GraphQLInputObjectType ? { input: { type: appType } } : {};
  const plain = new GraphQLSchema({
    query: new GraphQLObjectType({ name: 'Query', fields: { app: { type: holder, args } } }),
  });
  assert.equal(plain.getType(appType.name), appType);
  assert.deepEqual(validateSchema(plain), []);
  assert.equal(warnings.length, 1);
}

if (scenario === 'fallback-taken') {
  const schema = schemaWith(entity('RelationType'), entity('SimfinityRelationType'));
  assert.deepEqual(validateSchema(schema), []);
  assertRenamed(schema.getType('RelationType'), '2');
}

if (scenario === 'clash-after-schema') {
  const [extensionsType, relationType] = metadataTypes();
  const first = schemaWith(entity('First'));
  // Rejected before models, resolvers or roots are built: by a registered type, a type one of its
  // fields reaches, or a registered mutation's input.
  const preparedBefore = prepared;
  const clashes = [
    ['RelationType', () => connectAll(newRuntime(), [entity('RelationType')])],
    ['FieldExtensionsType', () => connectAll(newRuntime(), [entity('Holder', {
      kind: { type: new GraphQLEnumType({ name: 'FieldExtensionsType', values: { A: {} } }) },
    })])],
    ['RelationType', () => withInputNamed(connectAll(newRuntime(), [entity('Holder')]), 'RelationType')],
  ];
  for (const [typeName, create] of clashes) {
    const runtime = create();
    assertReserved(() => runtime.createSchema(), typeName);
    for (const { gqltype } of runtime.getRegistrations()) assert.ok(!runtime.getModel(gqltype));
  }
  assert.equal(prepared, preparedBefore);
  // A clash inside a registered input's fields is found when the schema is constructed, once the
  // generated inputs that such fields may read exist.
  const inputFieldClash = connectAll(newRuntime(), [entity('KindHolder')]);
  inputFieldClash.registerMutation('importKinds', 'Imports kinds', new GraphQLInputObjectType({
    name: 'KindsInput',
    fields: () => ({ kind: { type: new GraphQLEnumType({ name: 'FieldExtensionsType', values: { A: {} } }) } }),
  }), entity('ImportedKind'), () => null);
  assertReserved(() => inputFieldClash.createSchema(), 'FieldExtensionsType');
  // A registered type that the schema leaves out does not clash.
  const partial = connectAll(newRuntime(), [entity('Kept'), entity('RelationType')]);
  const kept = partial.getType('Kept');
  const partialSchema = partial.createSchema([kept], [kept]);
  assert.deepEqual(validateSchema(partialSchema), []);
  assert.equal(partialSchema.getType('RelationType'), relationType);
  // The schema created first keeps its metadata types and names.
  assert.deepEqual(metadataTypes(), [extensionsType, relationType]);
  assert.equal(first.getType('FieldExtensionsType'), extensionsType);
  assert.deepEqual(await metadataOf(first, 'First', 'FieldExtensionsType'), { readOnly: true, relation: null });
  assert.deepEqual(warnings, []);
}

if (scenario === 'failed-construction') {
  const [extensionsType, relationType] = metadataTypes();
  // RelationType clashes, and a second type named Dup makes the construction fail.
  const runtime = newRuntime();
  connectAll(runtime, [
    entity('RelationType', { dup: { type: new GraphQLObjectType({ name: 'Dup', fields: { x: { type: GraphQLString } } }) } }),
    entity('Dup'),
  ]);
  assert.throws(() => runtime.createSchema(), /Schema must contain uniquely named types but contains multiple types named "Dup"/);
  // The rename is undone, with the same type objects, and the names are not fixed.
  const { fieldMetadataNamesFixed } = await import('../../packages/core/src/introspection.js');
  assert.deepEqual(metadataTypes(), [extensionsType, relationType]);
  assert.equal(fieldMetadataNamesFixed(), false);
  assert.deepEqual(warnings.filter((message) => message.includes('__Field.extensions')), []);
  const later = schemaWith(entity('Later'));
  assert.equal(later.getType('FieldExtensionsType'), extensionsType);
  assert.equal(later.getType('SimfinityFieldExtensionsType'), undefined);
  assert.deepEqual(await metadataOf(later, 'Later', 'FieldExtensionsType'), { readOnly: true, relation: null });
  assert.equal(fieldMetadataNamesFixed(), true);
}

if (scenario === 'second-evaluation') {
  const schema = schemaWith(entity('RelationType'));
  const [extensionsType, relationType] = assertRenamed(schema.getType('RelationType'));
  // Distinct URLs evaluate the modules again, as another copy of the package would, sharing the
  // GraphQL peer: they keep the renamed types and see that their names are fixed.
  const introspection = await import('../../packages/core/src/introspection.js?second-evaluation');
  assert.deepEqual(introspection.fieldMetadataTypes(), [extensionsType, relationType]);
  assert.equal(introspection.fieldMetadataNamesFixed(), true);
  const { createRuntime: createSecondRuntime } = await import('../../packages/core/src/runtime.js?second-evaluation');
  const second = connectAll(runtimes.core(createSecondRuntime), [entity('Second')]).createSchema();
  assert.equal(second.getType('SimfinityFieldExtensionsType'), extensionsType);
  assert.equal(second.getType('FieldExtensionsType'), undefined);
  assert.deepEqual(await metadataOf(second, 'Second', 'SimfinityFieldExtensionsType'), { readOnly: true, relation: null });
  const clashing = connectAll(runtimes.core(createSecondRuntime), [entity('SimfinityRelationType')]);
  assertReserved(() => clashing.createSchema(), 'SimfinityRelationType');
  assert.equal(warnings.length, 1);
}

if (scenario === 'auth') {
  const appType = entity('RelationType', { secret: { type: GraphQLString } });
  const schema = schemaWith(appType);
  const denyAll = auth.createAuthPlugin({ RootQueryType: { '*': () => true } }, { defaultPolicy: 'DENY' });
  denyAll.onSchemaChange({ schema });
  // Metadata introspection stays open under DENY; the application's RelationType does not.
  assert.deepEqual(await metadataOf(schema, 'RelationType', 'SimfinityFieldExtensionsType'), { readOnly: true, relation: null });
  assert.equal(schema.getType('RelationType').getFields().secret.resolve === undefined, false);
  const protectedSchema = schemaWith(entity('Guarded'));
  auth.createAuthPlugin({ SimfinityFieldExtensionsType: { '*': () => false } }, { defaultPolicy: 'ALLOW' })
    .onSchemaChange({ schema: protectedSchema });
  const denied = await graphql({
    schema: protectedSchema,
    source: '{ __type(name: "Guarded") { fields { extensions { readOnly } } } }',
  });
  assert.ok(denied.errors?.length > 0);
}

// Once an earlier schema of the process fixed the names, createSchema checks the application types
// before it builds anything, and must not read a registered input's fields then: a fields function
// that reads a generated input (getInputType) would get undefined, which graphql-js keeps.
if (scenario === 'input-thunk-second-runtime') {
  assert.deepEqual(validateSchema(schemaWith(entity('First'))), []);
  const book = entity('ThunkBook');
  const runtime = withGeneratedInputThunk(connectAll(newRuntime(), [book]), book);
  const schema = runtime.createSchema();
  assert.deepEqual(validateSchema(schema), []);
  assert.equal(String(schema.getType('ThunkBookImportInput').getFields().item.type), 'ThunkBookInput!');
  await assertImportRuns(schema, book);
  assert.deepEqual(warnings, []);
}

if (scenario === 'input-thunk-after-schema') {
  // One runtime: a first schema, then a type and a mutation registered after it, then a second schema.
  const runtime = connectAll(newRuntime(), [entity('Early')]);
  assert.deepEqual(validateSchema(runtime.createSchema()), []);
  const book = entity('ThunkBook');
  withGeneratedInputThunk(connectAll(runtime, [book]), book);
  const schema = runtime.createSchema();
  assert.deepEqual(validateSchema(schema), []);
  assert.equal(String(schema.getType('ThunkBookImportInput').getFields().item.type), 'ThunkBookInput!');
  await assertImportRuns(schema, book);
  assert.deepEqual(warnings, []);
}

console.log(`${scenario} ${backend}: passed`);
