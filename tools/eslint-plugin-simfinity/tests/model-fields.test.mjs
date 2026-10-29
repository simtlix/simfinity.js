import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Linter } from 'eslint';
import parser from '@typescript-eslint/parser';
import rule from '../src/rules/valid-model-fields.js';
import { inspect, messages } from '../src/model-fields.js';
import { makeModelRule } from '../src/model-rule.js';

const advice = makeModelRule('modeling-advice', 'Describe accepted modeling choices', messages, inspect, 'warnings');
const imports = `import {
  GraphQLObjectType as ObjectType, GraphQLScalarType as Scalar, GraphQLEnumType as Enum,
  GraphQLInterfaceType as Interface, GraphQLUnionType as Union, GraphQLList as List,
  GraphQLNonNull as NonNull, GraphQLString, GraphQLID, GraphQLInt, GraphQLBoolean,
} from 'graphql';
import { createValidatedScalar, scalars } from '@simtlix/simfinity-core';
`;
const runtimes = {
  core: "import { createRuntime } from '@simtlix/simfinity-core'; const sf = createRuntime(adapter);",
  mongo: "import * as sf from '@simtlix/simfinity-js';",
  transactional: "import { createRuntime, createMongoAdapter } from '@simtlix/simfinity-js'; const sf = createRuntime(createMongoAdapter({ referentialIntegrity: 'transactional' }));",
  sql: "import { createSQL } from '@simtlix/simfinity-sql'; const sf = createSQL({ plugin });",
  postgres: "import { createPostgres } from '@simtlix/simfinity-postgres'; const sf = createPostgres();",
};
const child = "const Child = new ObjectType({ name: 'Child', fields: { label: { type: GraphQLString } } });";
const fixture = (field, { engine = 'core', setup = '', name = 'value', register, machine, extra = '', tail = '' } = {}) => `${imports}
${runtimes[engine]}
${child}
${setup}
const Owner = new ObjectType({ name: 'Owner', fields: () => ({ id: { type: GraphQLID }, label: { type: GraphQLString }, ${name}: ${field}, ${extra} }) });
${register ?? `sf.connect(null, Owner, 'owner', 'owners'${machine ? `, null, null, ${machine}` : ''});`}
${tail}`;
const lint = (code, mode = 'errors', typescript = false) => new Linter().verify(code, [{
  languageOptions: { ecmaVersion: 2022, sourceType: 'module', ...(typescript ? { parser } : {}) },
  plugins: { simfinity: { rules: { fields: mode === 'errors' ? rule : advice } } },
  rules: { 'simfinity/fields': mode === 'errors' ? 'error' : 'warn' },
}]);
const expectIds = (code, expected, mode = 'errors', typescript = false) => {
  const result = lint(code, mode, typescript);
  assert.deepEqual(result.map(message => message.messageId), expected);
  assert.ok(result.every(message => !message.fatal && !message.fix && !message.suggestions));
};

describe('stored object and abstract field contracts', () => {
  for (const engine of ['sql', 'postgres', 'transactional']) {
    for (const type of ['Child', 'new NonNull(Child)', 'new List(new NonNull(Child))']) {
      it(`${engine} rejects a stored ${type} without relation metadata`, () => {
        expectIds(fixture(`{ type: ${type}, extensions: { readOnly: true }, resolve: () => null }`, { engine }), ['fieldMissingRelation']);
      });
    }
    for (const relation of ['null', 'undefined', 'false', '0', "''"]) {
      it(`${engine} rejects a known absent relation ${relation}`, () => {
        expectIds(fixture(`{ type: Child, extensions: { relation: ${relation} } }`, { engine }), ['fieldMissingRelation']);
      });
    }
    for (const kind of ['Union', 'Interface']) {
      const setup = kind === 'Union'
        ? "const Preview = new Union({ name: 'Preview', types: [Child] });"
        : "const Preview = new Interface({ name: 'Preview', fields: { label: { type: GraphQLString } } });";
      it(`${engine} rejects stored ${kind} output even readOnly with a resolver`, () => {
        expectIds(fixture('{ type: new NonNull(new List(Preview)), extensions: { readOnly: true }, resolve: () => [] }', { engine, setup }), ['fieldAbstractStorage']);
      });
    }
    it(`${engine} leaves unused no-endpoint storage alone`, () => {
      expectIds(fixture('{ type: Child }', { engine, register: 'sf.addNoEndpointType(Owner);' }), []);
    });
    it(`${engine} checks a stored embedded type even without its own registration`, () => {
      expectIds(fixture('{ type: Inner, extensions: { relation: { embedded: true } } }', {
        engine, setup: "const Inner = new ObjectType({ name: 'Inner', fields: { child: { type: Child } } });",
      }), ['fieldMissingRelation']);
    });
    it(`${engine} does not impose storage on virtual object or abstract outputs`, () => {
      expectIds(fixture('{ type: Preview, extensions: { virtual: true }, resolve: () => null }', {
        engine, setup: "const Preview = new Union({ name: 'Preview', types: [Child] });",
      }), []);
      expectIds(fixture('{ type: Child, extensions: { virtual: { mcp: false } }, resolve: () => null }', { engine }), []);
    });
  }
  for (const engine of ['core', 'mongo']) {
    it(`${engine} keeps missing relation and abstract fields outside the error rule`, () => {
      expectIds(fixture('{ type: Child }', { engine }), []);
      expectIds(fixture('{ type: new List(Child) }', { engine }), []);
      expectIds(fixture('{ type: Preview }', { engine, setup: "const Preview = new Union({ name: 'Preview', types: [Child] });" }), []);
    });
  }
  it('advises about the actual missing singular input mapping', () => {
    expectIds(fixture('{ type: Child }'), ['fieldRelationAdvice'], 'warnings');
    expectIds(fixture('{ type: new List(Child) }'), [], 'warnings');
    expectIds(fixture('{ type: Child, extensions: { readOnly: true } }'), [], 'warnings');
    expectIds(fixture('{ type: Child }', { engine: 'mongo' }), ['fieldRelationAdvice'], 'warnings');
  });
  it('does not claim supplied or hooked Mongo mappings are missing', () => {
    expectIds(fixture('{ type: Child, extensions: { readOnly: true } }', { engine: 'mongo', register: 'sf.connect(model, Owner);' }), [], 'warnings');
    expectIds(fixture('{ type: Child, extensions: { readOnly: true } }', { engine: 'mongo', register: 'sf.connect(null, Owner, "owner", "owners", null, customize);' }), [], 'warnings');
  });
});

describe('nested lists distinguish input shape from abstract output shape', () => {
  for (const engine of Object.keys(runtimes)) {
    it(`${engine} rejects writable nested scalar input even with its own resolver`, () => {
      expectIds(fixture('{ type: new NonNull(new List(new NonNull(new List(GraphQLString)))), resolve: () => [] }', { engine }), [
        ['sql', 'postgres', 'transactional'].includes(engine) ? 'fieldNestedStorage' : 'fieldNestedInput',
      ]);
    });
    it(`${engine} accepts supported scalar lists and virtual nested lists`, () => {
      expectIds(fixture('{ type: new NonNull(new List(new NonNull(GraphQLString))) }', { engine }), []);
      expectIds(fixture('{ type: new List(new List(GraphQLString)), extensions: { virtual: true }, resolve: () => [] }', { engine }), []);
    });
  }
  for (const engine of ['core', 'mongo']) {
    it(`${engine} permits readOnly nested lists`, () => {
      expectIds(fixture('{ type: new List(new List(GraphQLString)), extensions: { readOnly: true } }', { engine }), []);
    });
  }
  it('reports a readOnly nested storage list on metadata backends', () => {
    expectIds(fixture('{ type: new List(new List(GraphQLString)), extensions: { readOnly: true } }', { engine: 'postgres' }), ['fieldNestedStorage']);
  });
  it('describes generated Mongo omission of readOnly nested output without calling it invalid', () => {
    const code = fixture('{ type: new List(new List(GraphQLString)), extensions: { readOnly: true }, resolve: () => [] }', { engine: 'mongo' });
    expectIds(code, []);
    expectIds(code, ['fieldOutputMappingAdvice'], 'warnings');
    expectIds(fixture('{ type: new List(new List(GraphQLString)), extensions: { readOnly: true } }', { engine: 'mongo', register: 'sf.connect(model, Owner);' }), [], 'warnings');
    expectIds(fixture('{ type: new List(new List(GraphQLString)), extensions: { readOnly: true } }'), [], 'warnings');
  });
  it('describes generated Mongo omission of an intentional readOnly abstract output', () => {
    expectIds(fixture('{ type: Preview, extensions: { readOnly: true }, resolve: () => null }', {
      engine: 'mongo', setup: "const Preview = new Union({ name: 'Preview', types: [Child] });",
    }), ['fieldOutputMappingAdvice'], 'warnings');
  });
  it('treats nested abstract lists as accepted omitted outputs on core', () => {
    const code = fixture('{ type: new List(new List(Preview)) }', { setup: "const Preview = new Union({ name: 'Preview', types: [Child] });" });
    expectIds(code, []);
    expectIds(code, ['fieldAbstractInputAdvice'], 'warnings');
  });
  it('does not invent a generated input for a state-machine-managed state', () => {
    expectIds(fixture('{ type: new List(new List(GraphQLString)) }', { name: 'state', machine: '{}' }), []);
  });
});

describe('scalar storage identity and base chains', () => {
  for (const engine of ['sql', 'postgres', 'transactional']) {
    it(`${engine} rejects an unmapped custom scalar`, () => {
      expectIds(fixture('{ type: new List(new NonNull(Money)) }', { engine, setup: "const Money = new Scalar({ name: 'Money', serialize: value => value });" }), ['fieldScalarStorage']);
    });
    it(`${engine} rejects cycles rather than accepting the repeated scalar name`, () => {
      expectIds(fixture('{ type: DateTime }', { engine, setup: "const DateTime = new Scalar({ name: 'DateTime' }); DateTime.baseScalarType = DateTime;" }), ['fieldScalarStorage']);
    });
    for (const name of ['String', 'ID', 'Int', 'Float', 'Boolean', 'Date', 'Time', 'DateTime']) {
      it(`${engine} accepts the supported storage name ${name}`, () => {
        expectIds(fixture('{ type: Value }', { engine, setup: `const Value = new Scalar({ name: '${name}' });` }), []);
      });
    }
    it(`${engine} follows a declared hint and validated factory chain`, () => {
      expectIds(fixture('{ type: Value }', {
        engine, setup: "const Money = new Scalar({ name: 'Money' }); Money.baseScalarType = GraphQLString; const Value = createValidatedScalar('Positive', '', Money, check);",
      }), []);
    });
    it(`${engine} rejects a factory whose known root lacks storage`, () => {
      expectIds(fixture('{ type: Value }', {
        engine, setup: "const Money = new Scalar({ name: 'Money' }); const Value = createValidatedScalar('Positive', '', Money, check);",
      }), ['fieldScalarStorage']);
    });
    it(`${engine} does not mistake a scalar config hint for a scalar property`, () => {
      expectIds(fixture('{ type: Value }', { engine, setup: "const Value = new Scalar({ name: 'Money', baseScalarType: GraphQLString });" }), ['fieldScalarStorage']);
    });
    for (const value of ['null', 'undefined', 'false', '0', "''"]) {
      it(`${engine} treats a falsy base hint ${value} as no mapping`, () => {
        expectIds(fixture('{ type: Value }', { engine, setup: `const Value = new Scalar({ name: 'Money' }); Value.baseScalarType = ${value};` }), ['fieldScalarStorage']);
      });
    }
  }
  it('does not confuse a custom String scalar with Mongo GraphQLString identity', () => {
    const code = fixture('{ type: Value }', { engine: 'mongo', setup: "const Value = new Scalar({ name: 'String' });" });
    expectIds(code, []);
    expectIds(code, ['fieldScalarMappingAdvice'], 'warnings');
  });
  it('describes an unmapped generated Mongo cycle without rejecting the schema', () => {
    const code = fixture('{ type: Value }', { engine: 'mongo', setup: "const Value = new Scalar({ name: 'Opaque' }); Value.baseScalarType = Value;" });
    expectIds(code, []);
    expectIds(code, ['fieldScalarMappingAdvice'], 'warnings');
  });
  it('preserves Mongo date-name fallback even for a cycle', () => {
    expectIds(fixture('{ type: DateTime }', { engine: 'mongo', setup: "const DateTime = new Scalar({ name: 'DateTime' }); DateTime.baseScalarType = DateTime;" }), [], 'warnings');
  });
  it('recognizes factory and builtin aliases without executing validators', () => {
    expectIds(fixture('{ type: Value }', { engine: 'postgres', setup: "const factory = createValidatedScalar; const Root = GraphQLString; const Value = factory('Label', '', Root, () => { throw new Error('never run'); });" }), []);
    expectIds(fixture('{ type: scalars.EmailScalar }', { engine: 'mongo' }), [], 'warnings');
  });
  for (const setup of [
    "import { Value } from './types.js';",
    'const Value = makeScalar();',
    "const Value = new Scalar({ name: 'Money' }); Value.baseScalarType = chooseBase();",
    "const Value = new Scalar({ name: 'Money' }); mutate(Value);",
    "const Value = new Scalar({ name: 'Money' }); const Alias = Value; Alias.name = 'String';",
  ]) {
    it(`preserves unknown scalar mapping: ${setup}`, () => {
      expectIds(fixture('{ type: Value }', { engine: 'postgres', setup }), []);
    });
  }
});

describe('enum text collisions preserve primitive identity', () => {
  for (const values of [
    "A: { value: 1 }, B: { value: '1' }",
    "A: { value: false }, B: { value: 'false' }",
    "A: { value: null }, B: { value: 'null' }",
    'A: { value: 0 }, B: { value: -0 }',
    "A: { value: 1n }, B: { value: '1' }",
    "A: {}, B: { value: 'A' }, C: { value: { toString() { throw new Error('never'); } } }, D: { value: 1 }, E: { value: '1' }",
  ]) {
    it(`rejects a proven text collision: ${values}`, () => {
      expectIds(fixture('{ type: Value }', { engine: 'postgres', setup: `const Value = new Enum({ name: 'Value', values: { ${values} } });` }), ['fieldEnumCollision']);
    });
  }
  for (const values of [
    'A: {}, B: {}',
    'A: { value: 1 }, B: { value: 1 }',
    'A: { value: NaN }, B: { value: NaN }',
    "A: { value: undefined }, B: { value: 'A' }",
    "A: { value: unknown }, B: { value: '1' }",
    "A: { value: { toString() { throw new Error('never'); } } }, B: { value: '[object Object]' }",
    '...values',
  ]) {
    it(`preserves aliases and unknown enum values: ${values}`, () => {
      expectIds(fixture('{ type: Value }', { engine: 'transactional', setup: `const Value = new Enum({ name: 'Value', values: { ${values} } });` }), []);
    });
  }
  it('does not impose shared text storage on Mongo integrity-off models', () => {
    expectIds(fixture('{ type: Value }', { engine: 'mongo', setup: "const Value = new Enum({ name: 'Value', values: { A: { value: 1 }, B: { value: '1' } } });" }), []);
  });
});

describe('metadata and workflow advice are optional and actionable', () => {
  for (const key of ['readOnly', 'relation', 'queryable', 'unique', 'validations']) {
    it(`explains ignored direct field metadata ${key}`, () => {
      const code = fixture(`{ type: GraphQLString, ${key}: true }`);
      expectIds(code, []);
      expectIds(code, ['fieldMisplacedMetadata'], 'warnings');
    });
  }
  it('explains the misplaced connectionField without assuming intended storage', () => {
    expectIds(fixture("{ type: GraphQLString, extensions: { connectionField: 'owner' } }"), ['fieldMisplacedMetadata'], 'warnings');
  });
  for (const key of ['readOnly', 'unique', 'queryable']) {
    for (const value of ["'false'", '0', '1', '{}', '[]']) {
      it(`advises about nonboolean ${key}: ${value}`, () => {
        const code = fixture(`{ type: GraphQLString, extensions: { ${key}: ${value} } }`);
        expectIds(code, []);
        expectIds(code, ['fieldNonBooleanFlag'], 'warnings');
      });
    }
    for (const value of ['true', 'false', 'null', 'undefined', 'dynamic']) {
      it(`preserves ${key}: ${value}`, () => {
        expectIds(fixture(`{ type: GraphQLString, extensions: { ${key}: ${value} } }`), [], 'warnings');
      });
    }
  }
  it('advises about relation.embedded truthiness without choosing a storage mode', () => {
    expectIds(fixture("{ type: Child, extensions: { relation: { embedded: 'false' } } }"), ['fieldNonBooleanFlag'], 'warnings');
  });
  it('preserves unrelated custom metadata and shadowed GraphQL constructors', () => {
    expectIds(fixture('{ type: GraphQLString, extensions: { presentation: true } }'), [], 'warnings');
    expectIds(`${runtimes.core} function define(ObjectType) { const Owner = new ObjectType({ name: 'Owner', fields: { value: { type: 1, readOnly: true } } }); sf.connect(null, Owner); }`, [], 'warnings');
  });
  it('explains that a manual state flag does not remove state from inputs', () => {
    const code = fixture('{ type: GraphQLString, extensions: { stateMachine: true } }', { name: 'state' });
    expectIds(code, []);
    expectIds(code, ['fieldManualStateFlag'], 'warnings');
  });
  it('does not mistake a direct field stateMachine flag for a workflow', () => {
    expectIds(fixture('{ type: GraphQLString, stateMachine: true }', { name: 'state' }), ['fieldManualStateFlag'], 'warnings');
  });
  it('keeps redundant managed state metadata and unknown machines quiet', () => {
    expectIds(fixture('{ type: GraphQLString, extensions: { stateMachine: true } }', { name: 'state', machine: '{}' }), [], 'warnings');
    expectIds(fixture('{ type: GraphQLString, extensions: { stateMachine: true } }', { name: 'state', machine: 'machine' }), [], 'warnings');
  });
  it('requires an enum for SQL machine state, but not a singular enum or any state field', () => {
    expectIds(fixture('{ type: GraphQLString }', { engine: 'postgres', name: 'state', machine: '{}' }), ['fieldSQLStateType']);
    expectIds(fixture('{ type: new List(Value) }', { engine: 'postgres', name: 'state', machine: '{}', setup: "const Value = new Enum({ name: 'State', values: { OPEN: { value: 1 } } });" }), []);
    expectIds(fixture('{ type: GraphQLString }', { engine: 'postgres', machine: '{}' }), []);
    expectIds(fixture('{ type: GraphQLString }', { engine: 'transactional', name: 'state', machine: '{}' }), []);
  });
});

describe('field analysis retains uncertainty and diagnostic evidence', () => {
  for (const field of [
    '{ type: Child, extensions: options }',
    '{ type: Child, extensions: { relation: dynamic } }',
    '{ type: Child, extensions: { virtual: dynamic } }',
    '{ type: Child, ...options }',
    '{ type: Child, extensions: { ...options } }',
    '{ get type() { throw new Error("never"); } }',
  ]) {
    it(`does not guess dynamic fields: ${field}`, () => expectIds(fixture(field, { engine: 'postgres' }), []));
  }
  it('does not inspect independent output types or mutated containers', () => {
    expectIds(fixture('{ type: Child }', { engine: 'postgres', register: '' }), []);
    expectIds(fixture('{ type: Child }', { engine: 'postgres', register: 'const alias = Owner; patch(alias); sf.connect(null, Owner);' }), []);
    expectIds(fixture('{ type: Child }', { engine: 'postgres', register: 'const Wrapped = new List(Owner); patch(Wrapped); sf.connect(null, Owner);' }), []);
  });
  it('supports TypeScript wrappers without treating aliases as mutable configs', () => {
    expectIds(fixture('{ type: (Child as Output), extensions: ({ readOnly: true } satisfies Extensions) }', { engine: 'postgres', register: 'const Alias = Owner as Output; sf.connect(null, Alias);' }), ['fieldMissingRelation'], 'errors', true);
  });
  it('reports the field declaration and preserves source severity', () => {
    const source = fixture('{ type: Child, readOnly: true }', { engine: 'postgres' });
    const [error] = lint(source);
    const [warning] = lint(source, 'warnings');
    assert.equal(error.messageId, 'fieldMissingRelation');
    assert.equal(warning.messageId, 'fieldMisplacedMetadata');
    assert.equal(error.severity, 2);
    assert.equal(warning.severity, 1);
    assert.ok(error.message.includes('Owner.value'));
    assert.ok(warning.message.includes('extensions.readOnly'));
    assert.ok(error.line > 1 && warning.column > 1);
  });
  it('does not duplicate one field reached through repeated registrations', () => {
    expectIds(fixture('{ type: Child }', { engine: 'postgres', tail: 'sf.connect(null, Owner, "other", "others");' }), ['fieldMissingRelation']);
  });
  it('keeps transactional metadata checks for supplied Mongo models and hooks', () => {
    expectIds(fixture('{ type: Child }', { engine: 'transactional', register: 'sf.connect(model, Owner, "owner", "owners", null, customize);' }), ['fieldMissingRelation']);
  });
  it('reaches entity storage through a reference inside an embedded value', () => {
    const setup = `const Money = new Scalar({ name: 'Money' });
const Target = new ObjectType({ name: 'Target', fields: { value: { type: Money } } });
const Inner = new ObjectType({ name: 'Inner', fields: { target: { type: Target, extensions: { relation: {} } } } });`;
    expectIds(fixture('{ type: Inner, extensions: { relation: { embedded: true } } }', { engine: 'postgres', setup }), ['fieldScalarStorage']);
  });
  it('uses the final registration by name at each schema build', () => {
    const setup = "const Replacement = new ObjectType({ name: 'Owner', fields: { label: { type: GraphQLString } } });";
    expectIds(fixture('{ type: Child }', { engine: 'postgres', setup, tail: 'sf.connect(null, Replacement); sf.createSchema();' }), []);
    expectIds(fixture('{ type: Child }', { engine: 'postgres', setup, tail: 'sf.createSchema(); sf.connect(null, Replacement); sf.createSchema();' }), ['fieldMissingRelation']);
  });
});
