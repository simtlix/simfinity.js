import { describe, it } from 'node:test';
import { RuleTester } from 'eslint';
import parser from '@typescript-eslint/parser';
import rule from '../src/rules/valid-model-schema.js';
import { makeModelRule } from '../src/model-rule.js';
import { messages, inspect } from '../src/model-schema.js';

RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } });
const imports = `import { createRuntime } from '@simtlix/simfinity-core';
import { GraphQLObjectType as Type, GraphQLInterfaceType as Interface, GraphQLUnionType as Union,
  GraphQLList as List, GraphQLNonNull as NonNull, GraphQLString as StringType, GraphQLID as ID } from 'graphql';
`;
const runtime = 'const api = createRuntime(adapter);\n';
const valueType = "const Value = new Type({ name: 'Value', fields: { label: { type: StringType } } });\n";
const owner = (field, extra = '') => `const Owner = new Type({ name: 'Owner', fields: () => ({ id: { type: ID }, field: ${field}, ${extra} }) });\n`;
const connect = (type, api = 'api') => `${api}.connect(null, ${type}, '${type.toLowerCase()}', '${type.toLowerCase()}s');\n`;
const ref = (type = 'Value', config = '', extensions = '') => `{ type: ${type}, extensions: { relation: { connectionField: 'owner' }, ${extensions} }, ${config} }`;
const embedded = (type = 'Value', config = '', extensions = '') => `{ type: ${type}, extensions: { relation: { embedded: true }, ${extensions} }, ${config} }`;
const code = (field, prefix = '', suffix = 'api.createSchema();') => imports + runtime + valueType + prefix + owner(field) + connect('Owner') + suffix;
const invalid = (code, messageId, count = 1) => ({ code, errors: Array.from({ length: count }, () => ({ messageId })) });

tester.run('model schema registrations', rule, {
  valid: [
    code(ref()),
    code(ref('new List(Value)', 'resolve: () => []', 'readOnly: true')),
    code(embedded('Value', '', 'readOnly: true')),
    code(embedded('new List(Value)', '', 'readOnly: true')),
    code('{ type: Value, resolve: () => ({}), extensions: { virtual: true } }'),
    code(embedded(), '', connect('Value') + 'api.createSchema();'),
    code(embedded(), 'api.addNoEndpointType(Value);'),
    code(embedded(), '', 'api.addNoEndpointType(new Type({ name: "Value", fields: { other: { type: StringType } } })); api.createSchema();'),
    code(embedded(), '', ''),
    code(embedded(), '', 'if (condition) api.addNoEndpointType(Value); api.createSchema();'),
    code(embedded(), '', 'api.addNoEndpointType(dynamicType); api.createSchema();'),
    code(embedded(), '', 'bootstrap(api); api.createSchema();'),
    code(embedded(), '', 'function bootstrap() { api.addNoEndpointType(Value); } bootstrap(); api.createSchema();'),
    code(embedded(), '', 'function later() { api.createSchema(); }'),
    code(embedded(), '', 'api.createSchema = custom; api.createSchema();'),
    code(embedded(), '', 'const Alias = Value; mutate(Alias); api.createSchema();'),
    code(embedded()).replace(runtime, "import * as api from '@simtlix/simfinity-js';\n"),
    code(embedded()).replace(runtime, "import * as api from '@simtlix/simfinity-postgres';\n"),
    imports + runtime + valueType + 'api.registerMutation("pick", "pick", null, Value, () => ({})); api.createSchema();',
    imports + runtime + 'function f(createRuntime) { const api = createRuntime(adapter); ' + valueType + owner(embedded()) + connect('Owner') + 'api.createSchema(); }',
  ],
  invalid: [
    ...['Value', 'new NonNull(Value)', 'new List(Value)', 'new NonNull(new List(new NonNull(Value)))']
      .map(type => invalid(code(embedded(type)), 'schemaUnregisteredTarget')),
    invalid(code(ref('new List(Value)')), 'schemaUnregisteredTarget'),
    invalid(code(ref('new List(Value)', 'resolve: () => []')), 'schemaUnregisteredTarget'),
    invalid(code(ref('new List(Value)', '', 'readOnly: true')), 'schemaUnregisteredTarget'),
    invalid(code(embedded(), '', 'api.createSchema(undefined, []);'), 'schemaUnregisteredTarget'),
    invalid(code(embedded(), '', 'api.createSchema(); api.addNoEndpointType(Value);'), 'schemaUnregisteredTarget'),
    invalid(code(embedded(), 'const other = createRuntime(adapter); other.addNoEndpointType(Value);'), 'schemaUnregisteredTarget'),
    invalid(code(embedded(), '', 'const same = api; const build = same.createSchema; build();'), 'schemaUnregisteredTarget'),
    { ...invalid(code(embedded('Value as OutputType')), 'schemaUnregisteredTarget'), languageOptions: { parser } },
  ],
});

const empty = "const Empty = new Type({ name: 'Empty', fields: { stamp: { type: StringType, extensions: { readOnly: true } } } }); api.addNoEndpointType(Empty);\n";
const required = (type = 'new NonNull(Empty)') => embedded(type);
const emptyCode = (field, ending = 'api.createSchema();', prefix = empty) => imports + runtime + prefix + owner(field) + connect('Owner') + ending;
const machine = "{ initialState: { value: 'ready' }, actions: {} }";
const stateCode = (field, stateMachine = machine, registerTarget = true) => imports + runtime
  + (registerTarget ? empty : empty.replace(' api.addNoEndpointType(Empty);', ''))
  + `const Owner = new Type({ name: 'Owner', fields: { label: { type: StringType }, state: ${field} } });
api.connect(null, Owner, 'owner', 'owners', null, null, ${stateMachine}); api.createSchema();`;
tester.run('model schema empty generated inputs', rule, {
  valid: [
    stateCode(required()),
    stateCode(required(), machine, false),
    stateCode(required(), 'unknownMachine'),
    stateCode(required(), 'unknownMachine', false),
    stateCode(ref('new List(Empty)', 'resolve: () => []'), machine, false),
    stateCode(required(), 'null').replace('api.createSchema();', `api.connect(null, Owner, 'owner', 'owners', null, null, ${machine}); api.createSchema();`),
    emptyCode(embedded('Empty')),
    emptyCode(embedded('new List(new NonNull(Empty))')),
    emptyCode(required(), 'api.createSchema(undefined, []);'),
    emptyCode(required(), 'api.createSchema(undefined, [Other]);', empty + "const Other = new Type({ name: 'Other', fields: { name: { type: StringType } } });" + connect('Other')),
    emptyCode(required(), 'api.createSchema(undefined, selection);'),
    emptyCode(embedded('new NonNull(Empty)', '', 'readOnly: true')),
    emptyCode(embedded('new NonNull(Empty)'), 'api.createSchema();', "const Empty = new Type({ name: 'Empty', fields: fields }); api.addNoEndpointType(Empty);\n"),
    emptyCode(embedded('new NonNull(Empty)'), 'api.createSchema();', "const Empty = new Type({ name: 'Empty', fields: { name: { type: StringType, resolve: () => 'value' } } }); api.addNoEndpointType(Empty);\n"),
    emptyCode(embedded('new NonNull(Empty)'), 'api.createSchema();', "const Empty = new Type({ name: 'Empty', fields: { name: { type: StringType, extensions: { readOnly: setting } } } }); api.addNoEndpointType(Empty);\n"),
    emptyCode(required(), 'api.createSchema(undefined, []); api.createSchema(undefined, []);'),
    emptyCode(embedded('Empty'), 'api.createSchema();', "const Empty = new Type({ name: 'Empty', fields: { id: { type: ID } } }); api.addNoEndpointType(Empty);\n"),
  ],
  invalid: [
    invalid(stateCode(required()).replace('api.createSchema();', "api.connect(null, Owner, 'owner', 'owners'); api.createSchema();"), 'schemaRequiredEmpty'),
    invalid(stateCode(required(), 'null'), 'schemaRequiredEmpty'),
    invalid(stateCode(required(), 'false'), 'schemaRequiredEmpty'),
    invalid(stateCode(ref('new List(Empty)'), machine, false), 'schemaUnregisteredTarget'),
    invalid(stateCode(ref('new List(Empty)'), 'unknownMachine', false), 'schemaUnregisteredTarget'),
    invalid(imports + runtime + empty
      + `const Child = new Type({ name: 'Child', fields: { required: ${required()} } });
const Owner = new Type({ name: 'Owner', fields: { label: { type: StringType }, state: ${embedded('Child')} } });
api.addNoEndpointType(Child); api.connect(null, Owner, 'owner', 'owners', null, null, ${machine});
api.createSchema(undefined, [Owner]);`, 'schemaRequiredEmpty'),
    invalid(emptyCode(required()), 'schemaRequiredEmpty'),
    invalid(emptyCode(required('new NonNull(new List(Empty))')), 'schemaRequiredEmpty'),
    invalid(emptyCode(required(), 'api.createSchema(undefined, []); api.createSchema();'), 'schemaRequiredEmpty'),
    invalid(emptyCode(required(), 'api.createSchema(undefined, [Parent]);', empty + "const Parent = new Type({ name: 'Parent', fields: () => ({ children: " + ref('new List(Owner)') + ' }) });' + connect('Parent')), 'schemaRequiredEmpty'),
    invalid(emptyCode(required(), 'api.createSchema();', "const Empty = new Type({ name: 'Empty', fields: { id: { type: ID } } }); api.addNoEndpointType(Empty);\n"), 'schemaRequiredEmpty'),
    invalid(emptyCode(required(), 'api.createSchema();', "const Empty = new Type({ name: 'Empty', fields: { state: { type: StringType } } }); api.connect(null, Empty, 'empty', 'empties', null, null, { initialState: initial, actions: {} });\n"), 'schemaRequiredEmpty'),
  ],
});

const boundSetup = imports + valueType + owner(ref()) + 'const first = createRuntime(adapter); const second = createRuntime(adapter);\n'
  + connect('Value', 'first') + connect('Owner', 'first') + connect('Value', 'second');
const bind = 'first.createSchema();\n';
const clone = fields => `const Copy = new Type({ name: 'Copy', fields: ${fields} });\n`;
tester.run('model schema runtime-bound identity and field copies', rule, {
  valid: [
    boundSetup + bind + 'second.registerMutation("pick", "pick", null, Owner, () => null); second.registerMutation("pick", "pick", null, Value, () => null); second.createSchema();',
    boundSetup.replace(connect('Owner', 'first'), 'first.registerMutation("pick", "pick", null, Owner, () => null); first.registerMutation("pick", "pick", null, Value, () => null);') + bind + connect('Owner', 'second') + 'second.createSchema();',
    boundSetup + bind + 'second.registerMutation("pick", "pick", null, Owner, () => null); second.registerMutation(unknownName, "pick", null, Value, () => null); second.createSchema();',
    boundSetup.replace(connect('Owner', 'first'), 'first.registerMutation("pick", "pick", null, Owner, () => null); first.registerMutation(unknownName, "pick", null, Value, () => null);') + bind + connect('Owner', 'second') + 'second.createSchema();',
    boundSetup + connect('Owner', 'second'),
    boundSetup + bind + 'first.createSchema();',
    boundSetup.replace(owner(ref()), owner(ref('Value', 'resolve: () => null'))) + bind + connect('Owner', 'second') + 'second.createSchema();',
    boundSetup + clone('Owner.toConfig().fields') + bind + connect('Copy', 'second') + 'second.createSchema();',
    boundSetup + bind + clone('() => ({ field: { ...Owner.toConfig().fields.field, resolve: undefined } })') + connect('Copy', 'second') + 'second.createSchema();',
    boundSetup + bind + clone('() => ({ field: { ...Owner.toConfig().fields.field, resolve: null } })') + connect('Copy', 'second') + 'second.createSchema();',
    boundSetup + bind + clone('() => ({ field: { ...Owner.toConfig().fields.field, resolve: () => null, extensions: { ...Owner.toConfig().fields.field.extensions } } })') + connect('Copy', 'second') + 'second.createSchema();',
    boundSetup + bind + clone('() => ({ field: { ...Owner.getFields().field, args: {}, resolve: undefined } })') + connect('Copy', 'second') + 'second.createSchema();',
    boundSetup + clone('() => ({ ...Owner.toConfig().fields })') + 'Copy.getFields();' + bind + connect('Copy', 'second') + 'second.createSchema();',
    boundSetup + clone('() => ({ ...Owner.toConfig().fields })') + 'second.addNoEndpointType(Copy);' + bind + 'second.createSchema();',
    boundSetup + bind + 'const I = new Interface({ name: "I", fields: () => ({ field: Owner.toConfig().fields.field }) }); const Copy = new Type({ name: "Copy", interfaces: [I], fields: { field: { type: Value, resolve: () => null } } });' + connect('Copy', 'second') + 'second.createSchema();',
    boundSetup + 'if (flag) first.createSchema();' + connect('Owner', 'second') + 'second.createSchema();',
    boundSetup + 'function a() { first.createSchema(); } function b() { ' + connect('Owner', 'second') + ' second.createSchema(); }',
    boundSetup + bind + clone('() => customCopy(Owner)') + connect('Copy', 'second') + 'second.createSchema();',
    boundSetup + bind + clone('() => ({ field: { ...Owner.toConfig().fields.field, resolve: undefined, extensions: {} } })') + connect('Copy', 'second') + 'second.createSchema(); const third = createRuntime(adapter);' + connect('Copy', 'third') + 'third.createSchema();',
    boundSetup + bind + clone('() => ({ field: { ...Owner.toConfig().fields.field, resolve: undefined } })') + connect('Copy', 'first') + 'first.createSchema();',
    boundSetup + 'if (flag) first.connect(null, dynamic, "dynamic", "dynamics");' + bind + connect('Owner', 'second'),
    boundSetup + 'registerLater(() => first.connect(null, Owner, "other", "others"));' + bind + connect('Owner', 'second'),
    boundSetup + bind + 'const Copy = new Type({ name: "Copy", fields: Owner.getFields() });' + connect('Copy', 'second') + 'second.createSchema();',
    boundSetup + bind + 'const Copy = new Type({ name: "Copy", fields: () => ({ ...Owner.getFields() }) });' + connect('Copy', 'second') + 'second.createSchema();',
    boundSetup + 'const fields = Owner.getFields();' + clone('({ field: { ...fields.field, args: {} } })') + bind + connect('Copy', 'second') + 'second.createSchema();',
    boundSetup + 'const fields = Owner.toConfig().fields;' + bind + clone('({ field: { ...fields.field } })') + connect('Copy', 'second') + 'second.createSchema();',
    boundSetup + 'const fields = Owner.getFields();' + bind + clone('({ field: { ...fields.field, args: {}, resolve: undefined } })') + connect('Copy', 'second') + 'second.createSchema();',
    boundSetup + 'const fields = Owner.toConfig().fields;' + clone('fields') + bind + connect('Copy', 'second') + 'second.createSchema(); const third = createRuntime(adapter); const Another = new Type({ name: "Another", fields });' + connect('Value', 'third') + connect('Another', 'third') + 'third.createSchema();',
    boundSetup + 'const fields = Owner.getFields(); const earlyResolver = fields.field.resolve;' + bind + clone('({ field: { ...fields.field, args: {}, resolve: earlyResolver, extensions: { relation: { connectionField: "owner" } } } })') + connect('Copy', 'second') + 'second.createSchema();',
    boundSetup + 'const fields = Owner.getFields(); const earlyExtensions = fields.field.extensions;' + bind + clone('({ field: { ...fields.field, args: {}, resolve: () => null, extensions: earlyExtensions } })') + connect('Copy', 'second') + 'second.createSchema();',
  ],
  invalid: [
    invalid(boundSetup + bind + connect('Owner', 'second'), 'schemaBoundType'),
    invalid(boundSetup + connect('Owner', 'second') + bind + 'second.createSchema();', 'schemaBoundType'),
    invalid(boundSetup + bind + 'second.addNoEndpointType(Owner);', 'schemaBoundType'),
    invalid(boundSetup + bind + clone('Owner.toConfig().fields') + connect('Copy', 'second') + 'second.createSchema();', 'schemaBoundField'),
    invalid(boundSetup + clone('() => ({ ...Owner.toConfig().fields })') + bind + connect('Copy', 'second') + 'second.createSchema();', 'schemaBoundField'),
    invalid(boundSetup + bind + 'const Copy = new Type(Owner.toConfig());' + connect('Copy', 'second') + 'second.createSchema();', 'schemaBoundField'),
    invalid(boundSetup + bind + clone('() => ({ field: { ...Owner.toConfig().fields.field, resolve: () => null } })') + connect('Copy', 'second') + 'second.createSchema();', 'schemaBoundField'),
    invalid(boundSetup + bind + clone('() => ({ field: { ...Owner.toConfig().fields.field, extensions: { ...Owner.toConfig().fields.field.extensions } } })') + connect('Copy', 'second') + 'second.createSchema();', 'schemaBoundField'),
    invalid(boundSetup + bind + clone('() => ({ field: { ...Owner.getFields().field, args: {} } })') + connect('Copy', 'second') + 'second.createSchema();', 'schemaBoundField'),
    invalid(boundSetup + bind + 'second.registerMutation("pick", "pick", null, Owner, () => null); second.createSchema();', 'schemaBoundType'),
    invalid(boundSetup.replace(connect('Owner', 'first'), 'first.registerMutation("pick", "pick", null, Owner, () => null);') + bind + connect('Owner', 'second'), 'schemaBoundType'),
    invalid(boundSetup + bind + 'const Copy = new Type({ ...Owner.toConfig(), name: "Copy" });' + connect('Copy', 'second') + 'second.createSchema();', 'schemaBoundField'),
    invalid(boundSetup + bind + 'const Copy = new Type({ name: "Copy", fields: () => ({ nested: { type: Owner, resolve: () => null } }) });' + connect('Copy', 'second') + 'second.createSchema();', 'schemaBoundType'),
    invalid(boundSetup.replace(owner(ref()), owner(ref('Value', '', 'readOnly: true'))) + bind + connect('Owner', 'second'), 'schemaBoundType'),
    invalid(boundSetup.replace(owner(ref()), owner(ref('new List(Value)'))).replace(connect('Value', 'first'), '') + bind + connect('Owner', 'second'), 'schemaUnregisteredTarget'),
    invalid(boundSetup + bind + 'const U = new Union({ name: "U", types: [Owner] }); second.registerMutation("pick", "pick", null, U, () => null); second.createSchema();', 'schemaBoundType'),
    invalid(boundSetup + bind + clone('() => ({ ...Owner.toConfig().fields, extra: { type: StringType } })') + connect('Copy', 'second') + 'second.createSchema();', 'schemaBoundField'),
    invalid(boundSetup + bind + clone('() => ({ ...Owner.toConfig().fields, extra: { type: Value, resolve: () => null } })') + connect('Copy', 'second') + 'second.createSchema();', 'schemaBoundField'),
    invalid(boundSetup + 'const fields = Owner.getFields();' + bind + clone('({ field: { ...fields.field, args: {} } })') + connect('Copy', 'second') + 'second.createSchema();', 'schemaBoundField'),
    invalid(boundSetup + 'const fields = Owner.getFields(); const alias = fields;' + bind + clone('() => ({ field: { ...alias.field, args: {} } })') + connect('Copy', 'second') + 'second.createSchema();', 'schemaBoundField'),
    invalid(boundSetup + 'const fields = Owner.getFields(); const field = fields.field;' + bind + clone('() => ({ field: { ...field, args: {} } })') + connect('Copy', 'second') + 'second.createSchema();', 'schemaBoundField'),
    invalid(boundSetup + 'const fields = Owner.getFields();' + bind + 'const lateResolver = fields.field.resolve;' + clone('({ field: { ...fields.field, args: {}, resolve: lateResolver, extensions: {} } })') + connect('Copy', 'second') + 'second.createSchema();', 'schemaBoundField'),
    invalid(boundSetup + 'const fields = Owner.getFields();' + bind + 'const lateExtensions = fields.field.extensions;' + clone('({ field: { ...fields.field, args: {}, resolve: () => null, extensions: lateExtensions } })') + connect('Copy', 'second') + 'second.createSchema();', 'schemaBoundField'),
    invalid(boundSetup.replace(owner(ref()), owner(ref()).replace('field: ', `state: ${required()}, field: `))
      .replace(connect('Owner', 'first'), `first.connect(null, Owner, 'owner', 'owners', null, null, ${machine});`)
      .replace(valueType, valueType + empty.replace(' api.addNoEndpointType(Empty);', ''))
      + bind + connect('Owner', 'second'), 'schemaBoundType'),
  ],
});

const advice = makeModelRule('schema-advice-test', 'Test contextual schema advice', messages, inspect, 'warnings');
tester.run('model schema accepted input omissions are opt-in advice', advice, {
  valid: [
    imports + runtime + valueType + connect('Value') + 'api.createSchema();',
    emptyCode(required(), 'api.createSchema(undefined, []);'),
    code(ref('Value', 'resolve: () => null')),
    stateCode(required()),
    stateCode(required(), 'unknownMachine'),
  ],
  invalid: [
    invalid(stateCode(ref('Empty'), machine, false), 'schemaUnregisteredReference'),
    invalid(stateCode(ref('Empty'), 'unknownMachine', false), 'schemaUnregisteredReference'),
    invalid(imports + runtime + "const OnlyId = new Type({ name: 'OnlyId', fields: { id: { type: ID } } });" + connect('OnlyId') + 'api.createSchema();', 'schemaEmptyCreate'),
    invalid(code(ref()), 'schemaUnregisteredReference'),
    {
      code: imports + runtime + "const Log = new Type({ name: 'Log', fields: { value: { type: StringType, extensions: { readOnly: true } } } });" + connect('Log') + 'api.createSchema();',
      errors: [{ messageId: 'schemaEmptyCreate' }, { messageId: 'schemaEmptyUpdate' }],
    },
    { code: emptyCode(embedded('Empty')), errors: [{ messageId: 'schemaEmptyEmbedded' }, { messageId: 'schemaEmptyCreate' }] },
    invalid(imports + runtime + "const Child = new Type({ name: 'Child', fields: { id: { type: ID }, parent: { type: ID } } }); const Parent = new Type({ name: 'Parent', fields: { label: { type: StringType }, children: { type: new List(Child), extensions: { relation: { connectionField: 'parent' } } } } });" + connect('Child') + connect('Parent') + 'api.createSchema();', 'schemaEmptyAdded'),
    {
      code: imports + runtime + "const Child = new Type({ name: 'Child', fields: { label: { type: StringType, extensions: { readOnly: true } } } }); const Parent = new Type({ name: 'Parent', fields: { label: { type: StringType }, children: { type: new List(Child), extensions: { relation: { connectionField: 'parent' } } } } }); api.addNoEndpointType(Child);" + connect('Parent') + 'api.createSchema();',
      errors: [{ messageId: 'schemaEmptyAdded' }, { messageId: 'schemaEmptyUpdated' }],
    },
    invalid(imports + runtime + "const Child = new Type({ name: 'Child', fields: () => ({ id: { type: ID }, parent: { type: Parent, extensions: { relation: { connectionField: 'parentId' } } } }) }); const Parent = new Type({ name: 'Parent', fields: { label: { type: StringType }, children: { type: new List(Child), extensions: { relation: { connectionField: 'parentId' } } } } });" + connect('Child') + connect('Parent') + 'api.createSchema();', 'schemaEmptyAdded'),
  ],
});
