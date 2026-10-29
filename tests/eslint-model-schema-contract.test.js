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
