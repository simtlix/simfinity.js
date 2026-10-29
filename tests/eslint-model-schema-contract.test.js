import { afterEach, describe, expect, test, vi } from 'vitest';
import { Linter } from 'eslint';
import {
  GraphQLID, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLSchema, GraphQLString,
  buildClientSchema, introspectionFromSchema, validateSchema,
} from 'graphql';
import mongoose from 'mongoose';
import { createRuntime } from '../packages/core/src/index.js';
import { createMongoAdapter } from '../packages/mongodb/src/mongo/adapter.js';
import { createPostgres } from '../packages/postgres/src/index.js';
import rule from '../tools/eslint-plugin-simfinity/src/rules/valid-model-schema.js';
import cloning from '../tools/eslint-plugin-simfinity/src/rules/no-schema-cloning.js';

// Synthetic declarations pair lint diagnostics with actual schema behavior.
// Linting never imports or executes the supplied source, even in these tests.
const lint = (source, selected = rule) => new Linter().verify(source, [{
  plugins: { contract: { rules: { schema: selected } } }, rules: { 'contract/schema': 'error' },
}]).map(diagnostic => diagnostic.messageId);
const imports = `import { createRuntime } from '@simtlix/simfinity-core';
import { GraphQLObjectType as Type, GraphQLList as List, GraphQLNonNull as NonNull, GraphQLID as ID, GraphQLString as StringType } from 'graphql';
const api = createRuntime(adapter);\n`;
const code = 'UNREGISTERED_RELATION_TARGET';
const error = code => expect.objectContaining({ extensions: expect.objectContaining({ code }) });
const reference = { relation: { connectionField: 'owner' } };
const embedded = { relation: { embedded: true } };
const created = [];
let next = 0;
const memory = () => createRuntime({ createModel: type => ({ name: type.name }) });
const backends = {
  core: memory,
  mongodb: () => {
    const runtime = createRuntime(createMongoAdapter());
    runtime.preventCreatingCollection(true);
    return runtime;
  },
  postgres: () => createPostgres({ pool: { connect() {}, query() {} }, schema: `lint_schema_${next++}` }),
};
const object = fields => {
  const type = new GraphQLObjectType({ name: `LintSchema${next++}`, fields });
  created.push(type);
  return type;
};
const connect = (runtime, type) => runtime.connect(null, type, type.name.toLowerCase(), `${type.name.toLowerCase()}s`);
afterEach(() => {
  for (const type of created.splice(0)) if (mongoose.models[type.name]) mongoose.deleteModel(type.name);
  vi.restoreAllMocks();
});

describe.each(Object.keys(backends))('schema lint contracts on %s', backend => {
  test.each(['embedded', 'embeddedList', 'referenceList'])('rejects an unregistered %s used by generated inputs', shape => {
    const runtime = backends[backend]();
    const target = object({ label: { type: GraphQLString } });
    const owner = object({
      id: { type: GraphQLID },
      field: { type: shape.endsWith('List') ? new GraphQLList(target) : target, extensions: shape.startsWith('embedded') ? embedded : reference },
    });
    connect(runtime, owner);
    expect(() => runtime.createSchema()).toThrow(error(code));
    const targetType = shape.endsWith('List') ? 'new List(Target)' : 'Target';
    const relation = shape.startsWith('embedded') ? 'embedded: true' : 'connectionField: "owner"';
    expect(lint(imports + `const Target = new Type({ name: 'Target', fields: { label: { type: StringType } } });
const Owner = new Type({ name: 'Owner', fields: { id: { type: ID }, field: { type: ${targetType}, extensions: { relation: { ${relation} } } } } });
api.connect(null, Owner, 'owner', 'owners'); api.createSchema();`)).toEqual(['schemaUnregisteredTarget']);
  });

  test('accepts a readOnly collection with an application resolver without target registration', () => {
    const runtime = backends[backend]();
    const target = object({ label: { type: GraphQLString } });
    const owner = object({ id: { type: GraphQLID }, label: { type: GraphQLString }, field: {
      type: new GraphQLList(target), extensions: { ...reference, readOnly: true }, resolve: () => [],
    } });
    connect(runtime, owner);
    expect(validateSchema(runtime.createSchema())).toEqual([]);
    expect(lint(imports + `const Target = new Type({ name: 'Target', fields: { label: { type: StringType } } });
const Owner = new Type({ name: 'Owner', fields: { label: { type: StringType }, field: { type: new List(Target), extensions: { readOnly: true, relation: { connectionField: 'owner' } }, resolve: () => [] } } });
api.connect(null, Owner, 'owner', 'owners'); api.createSchema();`)).toEqual([]);
  });

  test('rejects required empty embedded inputs only when generated mutations reach them', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = backends[backend]();
    const target = object({ stamp: { type: GraphQLString, extensions: { readOnly: true } } });
    const owner = object({ id: { type: GraphQLID }, label: { type: GraphQLString }, field: { type: new GraphQLNonNull(target), extensions: embedded } });
    runtime.addNoEndpointType(target);
    connect(runtime, owner);
    const declarations = imports + `const Target = new Type({ name: 'Target', fields: { stamp: { type: StringType, extensions: { readOnly: true } } } });
const Owner = new Type({ name: 'Owner', fields: { id: { type: ID }, label: { type: StringType }, field: { type: new NonNull(Target), extensions: { relation: { embedded: true } } } } });
api.addNoEndpointType(Target); api.connect(null, Owner, 'owner', 'owners');`;
    expect(() => runtime.createSchema(undefined, [])).not.toThrow();
    expect(lint(declarations + 'api.createSchema(undefined, []);')).toEqual([]);
    expect(() => runtime.createSchema()).toThrow(error('INVALID_MODEL'));
    expect(lint(declarations + 'api.createSchema(undefined, []); api.createSchema();')).toEqual(['schemaRequiredEmpty']);
  });

  test('an id-only root omits add while keeping update and delete', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = backends[backend]();
    const type = object({ id: { type: GraphQLID } });
    connect(runtime, type);
    const schema = runtime.createSchema();
    expect(validateSchema(schema)).toEqual([]);
    expect(Object.keys(schema.getMutationType().getFields())).toEqual([
      `delete${type.name.toLowerCase()}`, `update${type.name.toLowerCase()}`,
    ]);
    expect(lint(imports + 'const Item = new Type({ name: \'Item\', fields: { id: { type: ID } } }); api.connect(null, Item, \'item\', \'items\'); api.createSchema();')).toEqual([]);
  });
});

describe('runtime ownership and schema-copy lint contracts', () => {
  const library = () => {
    const target = object({ label: { type: GraphQLString } });
    const owner = object({ id: { type: GraphQLID }, target: { type: target, extensions: reference } });
    const first = memory();
    connect(first, target); connect(first, owner);
    return { first, owner, target };
  };
  const librarySource = imports + `const Target = new Type({ name: 'Target', fields: { label: { type: StringType } } });
const Owner = new Type({ name: 'Owner', fields: { id: { type: ID }, target: { type: Target, extensions: { relation: { connectionField: 'owner' } } } } });
api.connect(null, Target, 'target', 'targets'); api.connect(null, Owner, 'owner', 'owners');
const second = createRuntime(adapter); second.connect(null, Target, 'target', 'targets');\n`;

  test('a late field copy retains the foreign resolver, and clearing it preserves a legal copy', () => {
    const { first, owner, target } = library();
    first.createSchema();
    const copy = object(owner.toConfig().fields);
    const second = memory(); connect(second, target); connect(second, copy);
    expect(() => second.createSchema()).toThrow(error('TYPE_BOUND_TO_OTHER_RUNTIME'));
    expect(lint(librarySource + 'api.createSchema(); const Copy = new Type({ name: \'Copy\', fields: Owner.toConfig().fields }); second.connect(null, Copy, \'copy\', \'copies\'); second.createSchema();')).toEqual(['schemaBoundField']);
    const fields = owner.toConfig().fields;
    fields.target.resolve = undefined;
    const clean = object(fields);
    const third = memory(); connect(third, target); connect(third, clean);
    expect(validateSchema(third.createSchema())).toEqual([]);
    expect(lint(librarySource + 'api.createSchema(); const Copy = new Type({ name: \'Copy\', fields: { target: { ...Owner.toConfig().fields.target, resolve: undefined } } }); second.connect(null, Copy, \'copy\', \'copies\'); second.createSchema();')).toEqual([]);
  });

  test('a copy materialized before binding remains independent', () => {
    const { first, owner, target } = library();
    const copy = object(owner.toConfig().fields);
    first.createSchema();
    const second = memory(); connect(second, target); connect(second, copy);
    expect(validateSchema(second.createSchema())).toEqual([]);
    expect(lint(librarySource + 'const Copy = new Type({ name: \'Copy\', fields: Owner.toConfig().fields }); api.createSchema(); second.connect(null, Copy, \'copy\', \'copies\'); second.createSchema();')).toEqual([]);
  });

  test('separate types made from one toConfig snapshot keep independent field objects', () => {
    const { first, owner, target } = library();
    const fields = owner.toConfig().fields;
    const copy = object(fields);
    first.createSchema();
    const second = memory(); connect(second, target); connect(second, copy);
    expect(validateSchema(second.createSchema())).toEqual([]);
    const another = object(fields);
    const third = memory(); connect(third, target); connect(third, another);
    expect(validateSchema(third.createSchema())).toEqual([]);
    expect(lint(librarySource + 'const fields = Owner.toConfig().fields; const Copy = new Type({ name: "Copy", fields }); api.createSchema(); second.connect(null, Copy, "copy", "copies"); second.createSchema(); const third = createRuntime(adapter); const Another = new Type({ name: "Another", fields }); third.connect(null, Target, "target", "targets"); third.connect(null, Another, "another", "anothers"); third.createSchema();')).toEqual([]);
  });

  test('an earlier getFields alias observes later binding while an earlier field spread stays independent', () => {
    const { first, owner, target } = library();
    const fields = owner.getFields();
    const eager = object({ target: { ...fields.target, args: {} } });
    first.createSchema();
    const late = object({ target: { ...fields.target, args: {} } });
    const second = memory(); connect(second, target); connect(second, late);
    expect(() => second.createSchema()).toThrow(error('TYPE_BOUND_TO_OTHER_RUNTIME'));
    const third = memory(); connect(third, target); connect(third, eager);
    expect(validateSchema(third.createSchema())).toEqual([]);
    const alias = 'const fields = Owner.getFields();';
    const copy = 'const Copy = new Type({ name: \'Copy\', fields: { target: { ...fields.target, args: {} } } });';
    const finish = 'second.connect(null, Copy, \'copy\', \'copies\'); second.createSchema();';
    expect(lint(librarySource + alias + 'api.createSchema();' + copy + finish)).toEqual(['schemaBoundField']);
    expect(lint(librarySource + alias + copy + 'api.createSchema();' + finish)).toEqual([]);
  });

  test('a resolver property read before binding retains its earlier value', () => {
    const { first, owner, target } = library();
    const fields = owner.getFields();
    const earlyResolver = fields.target.resolve;
    first.createSchema();
    const copy = object({ target: { ...fields.target, args: {}, resolve: earlyResolver, extensions: reference } });
    const second = memory(); connect(second, target); connect(second, copy);
    expect(validateSchema(second.createSchema())).toEqual([]);
    expect(lint(librarySource + 'const fields = Owner.getFields(); const earlyResolver = fields.target.resolve; api.createSchema(); const Copy = new Type({ name: "Copy", fields: { target: { ...fields.target, args: {}, resolve: earlyResolver, extensions: { relation: { connectionField: "owner" } } } } }); second.connect(null, Copy, "copy", "copies"); second.createSchema();')).toEqual([]);
  });

  test('replaced mutation outputs neither retain foreign bindings nor reserve earlier outputs', () => {
    const { first, owner, target } = library();
    first.createSchema();
    const second = memory(); connect(second, target);
    second.registerMutation('pick', 'pick', null, owner, () => null);
    second.registerMutation('pick', 'pick', null, target, () => null);
    expect(validateSchema(second.createSchema())).toEqual([]);
    expect(lint(librarySource + 'api.createSchema(); second.registerMutation("pick", "pick", null, Owner, () => null); second.registerMutation("pick", "pick", null, Target, () => null); second.createSchema();')).toEqual([]);

    const unbound = object({ target: { type: target, extensions: reference } });
    const third = memory(); connect(third, target);
    third.registerMutation('pick', 'pick', null, unbound, () => null);
    third.registerMutation('pick', 'pick', null, target, () => null);
    expect(validateSchema(third.createSchema())).toEqual([]);
    const fourth = memory(); connect(fourth, target); connect(fourth, unbound);
    expect(validateSchema(fourth.createSchema())).toEqual([]);
    expect(lint(librarySource.replace('api.connect(null, Owner, \'owner\', \'owners\');', '')
      + 'api.registerMutation("pick", "pick", null, Owner, () => null); api.registerMutation("pick", "pick", null, Target, () => null); api.createSchema(); second.connect(null, Owner, "owner", "owners"); second.createSchema();')).toEqual([]);
  });

  test('changing only a copied resolver retains the foreign extensions ownership', () => {
    const { first, owner, target } = library();
    first.createSchema();
    const copy = object({ target: { ...owner.toConfig().fields.target, resolve: () => null } });
    const second = memory(); connect(second, target); connect(second, copy);
    expect(() => second.createSchema()).toThrow(error('TYPE_BOUND_TO_OTHER_RUNTIME'));
    expect(lint(librarySource + 'api.createSchema(); const Copy = new Type({ name: \'Copy\', fields: { target: { ...Owner.toConfig().fields.target, resolve: () => null } } }); second.connect(null, Copy, \'copy\', \'copies\'); second.createSchema();')).toEqual(['schemaBoundField']);
  });

  test('introspection reconstruction duplicates metadata, while toConfig retains its identity', () => {
    const { first } = library();
    const schema = first.createSchema();
    expect(validateSchema(new GraphQLSchema(schema.toConfig()))).toEqual([]);
    expect(() => buildClientSchema(introspectionFromSchema(schema))).toThrow(/multiple types named/);
    const source = 'import * as api from \'@simtlix/simfinity-js\'; import { buildClientSchema, introspectionFromSchema, GraphQLSchema } from \'graphql\'; const schema = api.createSchema(); ';
    expect(lint(source + 'buildClientSchema(introspectionFromSchema(schema));', cloning)).toEqual(['introspection']);
    expect(lint(source + 'new GraphQLSchema(schema.toConfig());', cloning)).toEqual([]);
  });
});

describe('managed state input lint contracts', () => {
  const stateMachine = { initialState: { value: 'ready' }, actions: {} };
  const machineSource = '{ initialState: { value: \'ready\' }, actions: {} }';
  const declarations = imports + `const Empty = new Type({ name: 'Empty', fields: { stamp: { type: StringType, extensions: { readOnly: true } } } });
const Owner = new Type({ name: 'Owner', fields: { label: { type: StringType }, state: { type: new NonNull(Empty), extensions: { relation: { embedded: true } } } } });`;

  test.each([true, false])('a managed embedded state is omitted with target registered=%s', registered => {
    const runtime = memory();
    const target = object({ stamp: { type: GraphQLString, extensions: { readOnly: true } } });
    const owner = object({ label: { type: GraphQLString }, state: { type: new GraphQLNonNull(target), extensions: embedded } });
    if (registered) runtime.addNoEndpointType(target);
    runtime.connect(null, owner, 'owner', 'owners', null, null, stateMachine);
    expect(validateSchema(runtime.createSchema())).toEqual([]);
    expect(lint(declarations + (registered ? 'api.addNoEndpointType(Empty);' : '')
      + `api.connect(null, Owner, 'owner', 'owners', null, null, ${machineSource}); api.createSchema();`)).toEqual([]);
  });

  test('output collection resolution still needs its target when state input is managed', () => {
    const runtime = memory();
    const target = object({ stamp: { type: GraphQLString, extensions: { readOnly: true } } });
    const owner = object({ label: { type: GraphQLString }, state: { type: new GraphQLList(target), extensions: reference } });
    runtime.connect(null, owner, 'owner', 'owners', null, null, stateMachine);
    expect(() => runtime.createSchema()).toThrow(error(code));
    expect(lint(declarations.replace('new NonNull(Empty)', 'new List(Empty)').replace('embedded: true', 'connectionField: "owner"')
      + `api.connect(null, Owner, 'owner', 'owners', null, null, ${machineSource}); api.createSchema();`)).toEqual(['schemaUnregisteredTarget']);
  });

  test('runtime reachability still visits required empty descendants below managed state', () => {
    const runtime = memory();
    const target = object({ stamp: { type: GraphQLString, extensions: { readOnly: true } } });
    const child = object({ required: { type: new GraphQLNonNull(target), extensions: embedded } });
    const owner = object({ label: { type: GraphQLString }, state: { type: child, extensions: embedded } });
    runtime.addNoEndpointType(target); runtime.addNoEndpointType(child);
    runtime.connect(null, owner, 'owner', 'owners', null, null, stateMachine);
    expect(() => runtime.createSchema(undefined, [owner])).toThrow(error('INVALID_MODEL'));
    expect(lint(declarations.replace('const Owner =', 'const Child = new Type({ name: "Child", fields: { required: { type: new NonNull(Empty), extensions: { relation: { embedded: true } } } } }); const Owner =')
      .replace('state: { type: new NonNull(Empty)', 'state: { type: Child')
      + `api.addNoEndpointType(Empty); api.addNoEndpointType(Child); api.connect(null, Owner, 'owner', 'owners', null, null, ${machineSource}); api.createSchema(undefined, [Owner]);`)).toEqual(['schemaRequiredEmpty']);
  });

  test('a successful managed state build still binds its other generated relation fields', () => {
    const runtime = memory();
    const empty = object({ stamp: { type: GraphQLString, extensions: { readOnly: true } } });
    const target = object({ label: { type: GraphQLString } });
    const owner = object({ label: { type: GraphQLString }, state: { type: new GraphQLNonNull(empty), extensions: embedded }, target: { type: target, extensions: reference } });
    connect(runtime, target);
    runtime.connect(null, owner, 'owner', 'owners', null, null, stateMachine);
    expect(validateSchema(runtime.createSchema())).toEqual([]);
    const second = memory();
    expect(() => connect(second, owner)).toThrow(error('TYPE_BOUND_TO_OTHER_RUNTIME'));
    expect(lint(declarations.replace('const Owner =', 'const Target = new Type({ name: "Target", fields: { label: { type: StringType } } }); const Owner =')
      .replace('state: { type:', 'target: { type: Target, extensions: { relation: { connectionField: "owner" } } }, state: { type:')
      + `api.connect(null, Target, 'target', 'targets'); api.connect(null, Owner, 'owner', 'owners', null, null, ${machineSource}); api.createSchema(); const second = createRuntime(adapter); second.connect(null, Owner, 'owner', 'owners');`)).toEqual(['schemaBoundType']);
  });
});
