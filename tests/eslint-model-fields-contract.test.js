import { afterEach, describe, expect, it, vi } from 'vitest';
import { Linter } from 'eslint';
import mongoose from 'mongoose';
import {
  GraphQLEnumType, GraphQLID, GraphQLInterfaceType, GraphQLList, GraphQLNonNull,
  GraphQLObjectType, GraphQLScalarType, GraphQLString, GraphQLUnionType,
} from 'graphql';
import { createRuntime, describeModels } from '../packages/core/src/index.js';
import { createMongoAdapter } from '../packages/mongodb/src/mongo/adapter.js';
import { createMongoModel } from '../packages/mongodb/src/mongo/models.js';
import { createPostgres } from '../packages/postgres/src/index.js';
import { createOptimisticMemoryAdapter } from './helpers/optimistic-memory-adapter.js';
import fieldRule from '../tools/eslint-plugin-simfinity/src/rules/valid-model-fields.js';
import { inspect, messages } from '../tools/eslint-plugin-simfinity/src/model-fields.js';
import { makeModelRule } from '../tools/eslint-plugin-simfinity/src/model-rule.js';

const adviceRule = makeModelRule('modeling-advice', 'Modeling advice', messages, inspect, 'warnings');
const imports = `import {
  GraphQLEnumType, GraphQLID, GraphQLInterfaceType, GraphQLList, GraphQLNonNull,
  GraphQLObjectType, GraphQLScalarType, GraphQLString, GraphQLUnionType,
} from 'graphql';`;
const runtimeSource = {
  core: 'import { createRuntime } from \'@simtlix/simfinity-core\'; const sf = createRuntime(adapter);',
  mongo: 'import * as sf from \'@simtlix/simfinity-js\';',
  transactional: 'import { createRuntime, createMongoAdapter } from \'@simtlix/simfinity-js\'; const sf = createRuntime(createMongoAdapter({ referentialIntegrity: \'transactional\' }));',
  postgres: 'import { createPostgres } from \'@simtlix/simfinity-postgres\'; const sf = createPostgres();',
};
// Syntax and runtime values below are hand-paired, never evaluated from source.
const source = (field, { engine = 'core', setup = '', name = 'value', machine } = {}) => `${imports}
${runtimeSource[engine]}
const Child = new GraphQLObjectType({ name: 'Child', fields: { label: { type: GraphQLString } } });
${setup}
const Owner = new GraphQLObjectType({ name: 'Owner', fields: { id: { type: GraphQLID }, label: { type: GraphQLString }, ${name}: ${field} } });
sf.addNoEndpointType(Child);
sf.connect(null, Owner, 'owner', 'owners'${machine ? `, null, null, ${machine}` : ''});`;
const lint = (code, advice = false) => new Linter().verify(code, [{
  plugins: { simfinity: { rules: { fields: advice ? adviceRule : fieldRule } } },
  rules: { 'simfinity/fields': advice ? 'warn' : 'error' },
}]).map(message => message.messageId);
const create = (engine) => {
  if (engine === 'core') return createRuntime(createOptimisticMemoryAdapter());
  if (engine === 'postgres') {
    return createPostgres({ pool: { query: () => { throw new Error('Unexpected database access'); }, connect: () => { throw new Error('Unexpected database access'); } } });
  }
  const runtime = createRuntime(createMongoAdapter({ referentialIntegrity: engine === 'transactional' ? 'transactional' : 'off' }));
  runtime.preventCreatingCollection(true);
  return runtime;
};
let sequence = 0;
const mongoModels = [];
const register = (runtime, fieldOf, { machine, name = 'value' } = {}) => {
  const prefix = `LintFields${sequence += 1}`;
  const Child = new GraphQLObjectType({ name: `${prefix}Child`, fields: { label: { type: GraphQLString } } });
  const Owner = new GraphQLObjectType({ name: `${prefix}Owner`, fields: {
    id: { type: GraphQLID }, label: { type: GraphQLString }, [name]: fieldOf(Child, prefix),
  } });
  runtime.addNoEndpointType(Child);
  runtime.connect(null, Owner, 'owner', 'owners', null, null, machine);
  return Owner;
};
afterEach(() => {
  vi.restoreAllMocks();
  while (mongoModels.length) mongoose.deleteModel(mongoModels.pop());
});

describe.each(['postgres', 'transactional'])('model field errors match %s preparation', (engine) => {
  const cases = [
    ['relation omitted on a readOnly resolved object', '{ type: Child, extensions: { readOnly: true }, resolve: () => null }', child => ({ type: child, extensions: { readOnly: true }, resolve: () => null }), 'fieldMissingRelation', /requires extensions.relation/],
    ['readOnly nested lists', '{ type: new GraphQLList(new GraphQLList(GraphQLString)), extensions: { readOnly: true } }', () => ({ type: new GraphQLList(new GraphQLList(GraphQLString)), extensions: { readOnly: true } }), 'fieldNestedStorage', /Nested scalar\/object lists/],
    ['readOnly abstract output', '{ type: Preview, extensions: { readOnly: true }, resolve: () => null }', (child, prefix) => ({ type: new GraphQLUnionType({ name: `${prefix}Preview`, types: [child] }), extensions: { readOnly: true }, resolve: () => null }), 'fieldAbstractStorage', /Unsupported field type/,
      'const Preview = new GraphQLUnionType({ name: \'Preview\', types: [Child] });'],
    ['unsupported scalar', '{ type: Money }', (child, prefix) => ({ type: new GraphQLScalarType({ name: `${prefix}Money` }) }), 'fieldScalarStorage', /Unsupported scalar/,
      'const Money = new GraphQLScalarType({ name: \'Money\' });'],
    ['enum text collision', '{ type: State }', (child, prefix) => ({ type: new GraphQLEnumType({ name: `${prefix}State`, values: { A: { value: 1 }, B: { value: '1' } } }) }), 'fieldEnumCollision', /Enum storage collision/,
      'const State = new GraphQLEnumType({ name: \'State\', values: { A: { value: 1 }, B: { value: \'1\' } } });'],
  ];
  for (const [label, syntax, field, messageId, error, setup] of cases) {
    it(`diagnoses ${label}`, () => {
      const runtime = create(engine);
      register(runtime, field);
      expect(() => runtime.createSchema()).toThrow(error);
      expect(lint(source(syntax, { engine, setup }))).toEqual([messageId]);
    });
  }
  it('allows a valid virtual object without a relation', () => {
    const runtime = create(engine);
    register(runtime, child => ({ type: child, extensions: { virtual: { mcp: false } }, resolve: () => ({ label: 'virtual' }) }));
    expect(() => runtime.createSchema()).not.toThrow();
    expect(lint(source('{ type: Child, extensions: { virtual: { mcp: false } }, resolve: () => ({ label: "virtual" }) }', { engine }))).toEqual([]);
    if (engine === 'transactional') {
      // Endpoint:false value types need no generated model in this fixture.
      for (const registration of runtime.getRegistrations()) {
        if (mongoose.models[registration.gqltype.name]) mongoModels.push(registration.gqltype.name);
      }
    }
  });
});

describe('input errors and accepted outputs match the core runtime', () => {
  it('rejects writable nested scalar input despite an own resolver', () => {
    const runtime = create('core');
    register(runtime, () => ({ type: new GraphQLNonNull(new GraphQLList(new GraphQLList(GraphQLString))), resolve: () => [] }));
    expect(() => runtime.createSchema()).toThrow(expect.objectContaining({ extensions: expect.objectContaining({ code: 'INPUT_TYPE_UNRESOLVED' }) }));
    expect(lint(source('{ type: new GraphQLNonNull(new GraphQLList(new GraphQLList(GraphQLString))), resolve: () => [] }'))).toEqual(['fieldNestedInput']);
  });
  it('preserves readOnly nested output', () => {
    const runtime = create('core');
    const owner = register(runtime, () => ({ type: new GraphQLList(new GraphQLList(GraphQLString)), extensions: { readOnly: true } }));
    const schema = runtime.createSchema();
    expect(schema.getType(`${owner.name}Input`).getFields()).not.toHaveProperty('value');
    expect(lint(source('{ type: new GraphQLList(new GraphQLList(GraphQLString)), extensions: { readOnly: true } }'))).toEqual([]);
  });
  it.each(['union', 'interface'])('keeps nested %s lists as omitted output, with advice only', (kind) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = create('core');
    const owner = register(runtime, (child, prefix) => {
      const named = kind === 'union'
        ? new GraphQLUnionType({ name: `${prefix}Preview`, types: [child] })
        : new GraphQLInterfaceType({ name: `${prefix}Preview`, fields: { label: { type: GraphQLString } } });
      return { type: new GraphQLList(new GraphQLList(named)), resolve: () => [] };
    });
    const schema = runtime.createSchema();
    expect(schema.getType(`${owner.name}Input`).getFields()).not.toHaveProperty('value');
    const setup = kind === 'union'
      ? 'const Preview = new GraphQLUnionType({ name: \'Preview\', types: [Child] });'
      : 'const Preview = new GraphQLInterfaceType({ name: \'Preview\', fields: { label: { type: GraphQLString } } });';
    const code = source('{ type: new GraphQLList(new GraphQLList(Preview)), resolve: () => [] }', { setup });
    expect(lint(code)).toEqual([]);
    expect(lint(code, true)).toEqual(['fieldAbstractInputAdvice']);
  });
  it('does not claim a relation-less object list is omitted from generated inputs', () => {
    const runtime = create('core');
    const owner = register(runtime, child => ({ type: new GraphQLList(child) }));
    const schema = runtime.createSchema();
    expect(schema.getType(`${owner.name}Input`).getFields()).toHaveProperty('value');
    expect(lint(source('{ type: new GraphQLList(Child) }'), true)).toEqual([]);
  });
  it('advises about the singular object field that core actually omits', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = create('core');
    const owner = register(runtime, child => ({ type: child }));
    const schema = runtime.createSchema();
    expect(schema.getType(`${owner.name}Input`).getFields()).not.toHaveProperty('value');
    expect(lint(source('{ type: Child }'), true)).toEqual(['fieldRelationAdvice']);
  });
});

describe('scalar and enum storage diagnostics preserve backend semantics', () => {
  it.each(['nested lists', 'abstract output'])('describes generated Mongo omission of readOnly %s', (shape) => {
    const child = new GraphQLObjectType({ name: `LintFieldsOutputChild${sequence += 1}`, fields: { label: { type: GraphQLString } } });
    const value = shape === 'nested lists' ? new GraphQLList(new GraphQLList(GraphQLString))
      : new GraphQLUnionType({ name: `LintFieldsOutputUnion${sequence}`, types: [child] });
    const type = new GraphQLObjectType({ name: `LintFieldsOutput${sequence}`, fields: { value: { type: value, extensions: { readOnly: true }, resolve: () => null } } });
    const model = createMongoModel(type, null, { createCollection: false });
    mongoModels.push(type.name);
    expect(model.schema.path('value')).toBeUndefined();
    const syntax = shape === 'nested lists' ? 'new GraphQLList(new GraphQLList(GraphQLString))' : 'Preview';
    const setup = shape === 'nested lists' ? '' : 'const Preview = new GraphQLUnionType({ name: \'Preview\', types: [Child] });';
    const code = source(`{ type: ${syntax}, extensions: { readOnly: true }, resolve: () => null }`, { engine: 'mongo', setup });
    expect(lint(code)).toEqual([]);
    expect(lint(code, true)).toEqual(['fieldOutputMappingAdvice']);
  });
  it('rejects a DateTime hint cycle in metadata but keeps Mongo date fallback', () => {
    const DateTime = new GraphQLScalarType({ name: 'DateTime' });
    DateTime.baseScalarType = DateTime;
    const type = new GraphQLObjectType({ name: `LintFieldsCycle${sequence += 1}`, fields: { date: { type: DateTime } } });
    expect(() => describeModels([{ gqltype: type }])).toThrow(/Cyclic base scalar/);
    const model = createMongoModel(type, null, { createCollection: false });
    mongoModels.push(type.name);
    expect(model.schema.path('date').instance).toBe('Date');
    const setup = 'const DateTime = new GraphQLScalarType({ name: \'DateTime\' }); DateTime.baseScalarType = DateTime;';
    expect(lint(source('{ type: DateTime }', { engine: 'postgres', setup }))).toEqual(['fieldScalarStorage']);
    expect(lint(source('{ type: DateTime }', { engine: 'mongo', setup }), true)).toEqual([]);
  });
  it('distinguishes supported scalar names from Mongo singleton identity', () => {
    const Value = new GraphQLScalarType({ name: 'String' });
    const type = new GraphQLObjectType({ name: `LintFieldsIdentity${sequence += 1}`, fields: { value: { type: Value } } });
    expect(describeModels([{ gqltype: type }]).entities[0].fields[0].scalar).toBe('String');
    const model = createMongoModel(type, null, { createCollection: false });
    mongoModels.push(type.name);
    expect(model.schema.path('value')).toBeUndefined();
    const setup = 'const Value = new GraphQLScalarType({ name: \'String\' });';
    expect(lint(source('{ type: Value }', { engine: 'postgres', setup }))).toEqual([]);
    expect(lint(source('{ type: Value }', { engine: 'mongo', setup }), true)).toEqual(['fieldScalarMappingAdvice']);
  });
  for (const [label, syntax, values, collision] of [
    ['signed zero', 'A: { value: 0 }, B: { value: -0 }', { A: { value: 0 }, B: { value: -0 } }, true],
    ['null and text', 'A: { value: null }, B: { value: \'null\' }', { A: { value: null }, B: { value: 'null' } }, true],
    ['NaN aliases', 'A: { value: NaN }, B: { value: NaN }', { A: { value: NaN }, B: { value: NaN } }, false],
    ['undefined defaults', 'A: { value: undefined }, B: { value: \'A\' }', { A: { value: undefined }, B: { value: 'A' } }, false],
  ]) {
    it(`preserves enum ${label} semantics`, () => {
      const State = new GraphQLEnumType({ name: `LintFieldsEnum${sequence += 1}`, values });
      const type = new GraphQLObjectType({ name: `LintFieldsEnumOwner${sequence}`, fields: { state: { type: State } } });
      if (collision) expect(() => describeModels([{ gqltype: type }])).toThrow(/Enum storage collision/);
      else expect(() => describeModels([{ gqltype: type }])).not.toThrow();
      expect(lint(source('{ type: State }', {
        engine: 'postgres', setup: `const State = new GraphQLEnumType({ name: 'State', values: { ${syntax} } });`,
      }))).toEqual(collision ? ['fieldEnumCollision'] : []);
    });
  }
});

describe('metadata advice describes accepted behavior without changing ownership', () => {
  it('direct readOnly metadata does not remove generated input', () => {
    const runtime = create('core');
    const owner = register(runtime, () => ({ type: GraphQLString, readOnly: true }));
    const schema = runtime.createSchema();
    expect(schema.getType(`${owner.name}Input`).getFields()).toHaveProperty('value');
    const code = source('{ type: GraphQLString, readOnly: true }');
    expect(lint(code)).toEqual([]);
    expect(lint(code, true)).toEqual(['fieldMisplacedMetadata']);
  });
  it('nonboolean readOnly uses input truthiness and exact metadata equality', () => {
    const runtime = create('core');
    const owner = register(runtime, () => ({ type: GraphQLString, extensions: { readOnly: 'false' } }));
    const schema = runtime.createSchema();
    expect(schema.getType(`${owner.name}Input`).getFields()).not.toHaveProperty('value');
    expect(describeModels([{ gqltype: owner }]).entities[0].fields.find(field => field.name === 'value').readOnly).toBe(false);
    const code = source('{ type: GraphQLString, extensions: { readOnly: \'false\' } }');
    expect(lint(code)).toEqual([]);
    expect(lint(code, true)).toEqual(['fieldNonBooleanFlag']);
  });
  it('nonboolean unique is honored by generated Mongo but absent from SQL metadata', () => {
    const type = new GraphQLObjectType({ name: `LintFieldsUnique${sequence += 1}`, fields: { value: { type: GraphQLString, extensions: { unique: 'true' } } } });
    const model = createMongoModel(type, null, { createCollection: false });
    mongoModels.push(type.name);
    expect(model.schema.path('value').options.unique).toBe(true);
    expect(describeModels([{ gqltype: type }]).entities[0].fields[0].unique).toBe(false);
    expect(lint(source('{ type: GraphQLString, extensions: { unique: \'true\' } }'), true)).toEqual(['fieldNonBooleanFlag']);
  });
  it.each(['extensions', 'direct'])('a manual %s state flag leaves state writable without a registered machine', (placement) => {
    const runtime = create('core');
    const metadata = placement === 'extensions' ? { extensions: { stateMachine: true } } : { stateMachine: true };
    const owner = register(runtime, () => ({ type: GraphQLString, ...metadata }), { name: 'state' });
    const schema = runtime.createSchema();
    expect(schema.getType(`${owner.name}Input`).getFields()).toHaveProperty('state');
    const syntax = placement === 'extensions' ? '{ type: GraphQLString, extensions: { stateMachine: true } }' : '{ type: GraphQLString, stateMachine: true }';
    const code = source(syntax, { name: 'state' });
    expect(lint(code)).toEqual([]);
    expect(lint(code, true)).toEqual(['fieldManualStateFlag']);
  });
});

describe('SQL machine state requires enum storage without extra shape restrictions', () => {
  const machine = { initialState: { name: 'OPEN', value: 1 }, actions: {} };
  const machineSyntax = '{ initialState: { name: \'OPEN\', value: 1 }, actions: {} }';
  it('rejects String state on SQL with an actual machine', () => {
    const runtime = create('postgres');
    register(runtime, () => ({ type: GraphQLString }), { name: 'state', machine });
    expect(() => runtime.createSchema()).toThrow(/must be a GraphQL enum on SQL backends/);
    expect(lint(source('{ type: GraphQLString }', { engine: 'postgres', name: 'state', machine: machineSyntax }))).toEqual(['fieldSQLStateType']);
  });
  it('accepts numeric enum lists and leaves managed state out of input', () => {
    const runtime = create('postgres');
    const owner = register(runtime, (child, prefix) => ({ type: new GraphQLList(new GraphQLEnumType({ name: `${prefix}State`, values: { OPEN: { value: 1 } } })) }), { name: 'state', machine });
    const schema = runtime.createSchema();
    expect(schema.getType(`${owner.name}Input`).getFields()).not.toHaveProperty('state');
    expect(lint(source('{ type: new GraphQLList(State) }', { engine: 'postgres', name: 'state', machine: machineSyntax, setup: 'const State = new GraphQLEnumType({ name: \'State\', values: { OPEN: { value: 1 } } });' }))).toEqual([]);
  });
  it('does not invent a missing-state rejection', () => {
    const runtime = create('postgres');
    register(runtime, () => ({ type: GraphQLString }), { machine });
    expect(() => runtime.createSchema()).not.toThrow();
    expect(lint(source('{ type: GraphQLString }', { engine: 'postgres', machine: machineSyntax }))).toEqual([]);
  });
});
