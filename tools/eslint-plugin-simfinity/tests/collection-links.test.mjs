import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RuleTester, Linter } from 'eslint';
import parser from '@typescript-eslint/parser';
import plugin from '../src/index.js';

RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } });
const mongo = "import * as sf from '@simtlix/simfinity-js';\n";
const postgres = "import { createPostgres } from '@simtlix/simfinity-postgres'; const sf = createPostgres();\n";
const core = "import { createRuntime } from '@simtlix/simfinity-core'; const sf = createRuntime(adapter);\n";
const gql = "import { GraphQLObjectType as ObjectType, GraphQLList as List, GraphQLNonNull as NonNull, GraphQLString } from 'graphql';\n";
const child = "const Child = new ObjectType({ name: 'Child', fields: { name: { type: GraphQLString } } });\n";
const field = (relation = '{}', config = '', type = 'new List(Child)', extensions = '') =>
  `{ type: ${type}, extensions: { relation: ${relation}, ${extensions} }, ${config} }`;
const owner = value => `const Owner = new ObjectType({ name: 'Owner', fields: () => ({ children: ${value} }) });\n`;
const code = (value, runtime = mongo, end = 'sf.connect(null, Owner, "owner", "owners");') => runtime + gql + child + owner(value) + end;
const missing = source => ({ code: source, errors: [{ messageId: 'missing' }] });

tester.run('required collection connectionField', plugin.rules['valid-connection-field'], {
  valid: [
    ...["{ connectionField: 'owner' }", "{ connectionField: ' ' }", '{ connectionField: configured }', '{ ...options }', '{ [key]: null }', '{ get connectionField() { return null; } }'].map(relation => code(field(relation))),
    ...['true', '1', '"false"', 'flag', '{}', '[]'].map(readOnly => code(field('{}', '', 'new List(Child)', `readOnly: ${readOnly}`))),
    ...['() => []', 'async () => []', 'resolver', 'makeResolver()'].map(resolve => code(field('{}', `resolve: ${resolve}`))),
    code(field('{}', 'resolve() { return []; }')),
    code(field('{}', 'resolve: () => []', 'new List(Child)', 'readOnly: true')),
    ...['true', '{}', 'virtualOptions', 'false', 'null'].map(virtual => code(field('{}', '', 'new List(Child)', `virtual: ${virtual}`))),
    ...['true', 'flag', '"true"'].map(embedded => code(field(`{ embedded: ${embedded} }`))),
    ...['Child', 'new NonNull(Child)', 'new List(GraphQLString)', 'new List(new List(Child))', 'new List(Unknown)', 'new List(sf.getType("child"))'].map(type => code(field('{}', '', type))),
    code('{ type: new List(Child) }'),
    code('{ type: new List(Child), extensions: options }'),
    code('{ type: new List(Child), ...options, extensions: { relation: {} } }'),
    code(field(), mongo, ''),
    code(field(), mongo, 'function register(sf) { sf.connect(null, Owner); }'),
    code(field(), mongo, 'patch(Owner); sf.connect(null, Owner);'),
    code(field(), mongo, 'patch(Child); sf.connect(null, Owner);'),
    code(field(), mongo, 'const Alias = Owner; Alias.getFields().children.resolve = resolver; sf.connect(null, Owner);'),
    code(field(), mongo, 'const Wrapped = new List(Owner); Wrapped.ofType.getFields().children.resolve = () => []; sf.connect(null, Owner);'),
    code(field(), mongo, 'const Wrapped = new NonNull(new List(Owner)); const Alias = Wrapped; patch(Alias); sf.connect(null, Owner);'),
    code(field(), mongo, 'patch(new List(Owner)); sf.connect(null, Owner);'),
    code(field(), mongo, 'const Container = new ObjectType({ name: "Container", fields: { owner: { type: Owner } } }); Container.getFields().owner.type.getFields().children.resolve = () => []; sf.connect(null, Owner);'),
    code(field(), mongo, 'const Container = new ObjectType({ name: "Container", fields: { owner: { type: new List(Owner) } } }); patch(Container); sf.connect(null, Owner);'),
    { code: code(field(), mongo, 'const Wrapped = new List(Owner) as OutputType; patch(Wrapped); sf.connect(null, Owner);'), languageOptions: { parser } },
    code(field(), mongo, 'sf.connect(...args, Owner);'),
    mongo + gql + 'function register(List) { ' + child + owner(field()) + 'sf.connect(null, Owner); }',
    mongo + gql + child + owner(field()) + 'const Root = new ObjectType({ name: "Root", fields: { details: { type: Owner, extensions: { relation: { embedded: true } } } } }); sf.connect(null, Root);',
    mongo + gql + child + 'const Owner = new ObjectType({ name: "Owner", fields: () => { customize(); return { children: ' + field() + ' }; } }); sf.connect(null, Owner);',
  ],
  invalid: [
    ...[mongo, postgres, core].flatMap(runtime => [
      '{}', '{ connectionField: null }', '{ connectionField: undefined }', '{ connectionField: "" }', '{ embedded: false }',
    ].map(relation => missing(code(field(relation), runtime)))),
    ...['false', '0', 'null', 'undefined', '""'].map(readOnly => missing(code(field('{}', '', 'new List(Child)', `readOnly: ${readOnly}`)))),
    ...['null', 'undefined'].map(resolve => missing(code(field('{}', `resolve: ${resolve}`)))),
    ...['new NonNull(new List(Child))', 'new List(new NonNull(Child))', 'new NonNull(new List(new NonNull(Child)))'].map(type => missing(code(field('{}', '', type)))),
    missing(code(field(), mongo, 'sf.addNoEndpointType(Owner);')),
    missing(code(field(), mongo, 'const Alias = Owner; const register = sf.connect; register(null, Alias); sf.addNoEndpointType(Owner);')),
    missing(code(field(), mongo, 'const Wrapped = new NonNull(new List(Owner)); const Container = new ObjectType({ name: "Container", fields: { owner: { type: Wrapped } } }); sf.connect(null, Container); sf.connect(null, Owner);')),
    missing(mongo + gql + child + 'const empty = "";\n' + owner(field('{ connectionField: empty }')) + 'sf.connect(null, Owner);'),
    missing(mongo + gql + owner(field('{}', '', 'new List(Owner)')) + 'sf.connect(null, Owner);'),
    missing(mongo + gql + child + owner(field()) + 'const Root = new ObjectType({ name: "Root", fields: { details: { type: Owner, extensions: { relation: { embedded: true } } } } }); sf.connect(null, Root); sf.addNoEndpointType(Owner);'),
    { ...missing(code(field('({ connectionField: null } as const)', 'resolve: undefined', '(new NonNull(new List(Child)) as OutputType)', 'readOnly: false as const'))), languageOptions: { parser } },
    {
      code: code(field('{ connectionField: 42 }')),
      errors: [{ messageId: 'invalid' }],
    },
    {
      code: mongo + gql + child + owner(field('{ connectionField: "owner.id" }')) + 'const Root = new ObjectType({ name: "Root", fields: { details: { type: Owner, extensions: { relation: { embedded: true } } } } }); sf.connect(null, Root); sf.addNoEndpointType(Owner);',
      errors: [{ messageId: 'invalid' }],
    },
  ],
});

describe('missing-link diagnostic locations', () => {
  it('bounds checks on directly registered types', () => {
    const types = Array.from({ length: 205 }, (_, index) =>
      `const Owner${index} = new ObjectType({ name: 'Owner${index}', fields: { children: ${field()} } }); sf.connect(null, Owner${index});`).join('\n');
    const messages = new Linter().verify(mongo + gql + child + types, [plugin.configs['recommended-3.8']]);
    assert.equal(messages.length, 200);
    assert.ok(messages.every(message => message.messageId === 'missing'));
  });
  it('points to the absent-link relation and the explicit invalid value', () => {
    const source = mongo + gql + child + `const Owner = new ObjectType({ name: 'Owner', fields: {
  absent: { type: new List(Child), extensions: { relation: {} } },
  empty: { type: new List(Child), extensions: { relation: { connectionField: '' } } },
} });
sf.connect(null, Owner);`;
    const messages = new Linter().verify(source, [plugin.configs['recommended-3.8']]);
    assert.deepEqual(messages.map(message => [message.ruleId, message.messageId, message.line, message.column]), [
      ['simfinity/valid-connection-field', 'missing', 5, 60],
      ['simfinity/valid-connection-field', 'missing', 6, 78],
    ]);
    assert.ok(messages.every(message => !message.fix && !message.suggestions));
  });
});
