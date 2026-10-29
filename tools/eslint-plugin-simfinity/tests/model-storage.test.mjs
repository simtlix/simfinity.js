import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Linter } from 'eslint';
import { makeModelRule } from '../src/model-rule.js';
import { inspect, messages } from '../src/model-storage.js';
import rule from '../src/rules/valid-model-storage.js';

const advice = makeModelRule('storage-advice', 'Storage advice fixtures', messages, inspect, 'warnings');
const gql = "import { GraphQLObjectType as O, GraphQLList as L, GraphQLNonNull as N, GraphQLString as S, GraphQLID as ID, GraphQLInt as I, GraphQLBoolean as B, GraphQLScalarType as Scalar, GraphQLEnumType as Enum } from 'graphql';";
const sql = "import { createPostgres } from '@simtlix/simfinity-postgres'; const sf = createPostgres();";
const mongo = "import * as sf from '@simtlix/simfinity-js';";
const core = "import { createRuntime } from '@simtlix/simfinity-core'; const sf = createRuntime(adapter);";
const strict = "import { createRuntime } from '@simtlix/simfinity-core'; import { createMongoAdapter } from '@simtlix/simfinity-js'; const sf = createRuntime(createMongoAdapter({ referentialIntegrity: 'transactional' }));";
const root = (fields, extensions = '') => `const Root = new O({ name: 'Root', fields: () => ({ label: { type: S }, ${fields} }), ${extensions} });`;
const child = (fields = 'label: { type: S }') => `const Child = new O({ name: 'Child', fields: () => ({ ${fields} }) });`;
const ref = (target, link = 'ownerId', extra = '') => `{ type: ${target}, extensions: { relation: { connectionField: '${link}' }, ${extra} } }`;
const emb = (target, extra = '') => `{ type: ${target}, extensions: { relation: { embedded: true }, ${extra} } }`;
const register = "sf.connect(null, Root, 'root', 'roots');";
const source = (body, runtime = sql, end = register) => `${gql}${runtime}${body}${end}`;
const lint = (code, selected = rule) => new Linter().verify(code, [{
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: { contract: { rules: { storage: selected } } }, rules: { 'contract/storage': 'error' },
}]);
const check = (name, code, expected, selected) => it(name, () => {
  const findings = lint(code, selected);
  assert.deepEqual(findings.map(item => item.messageId), expected, JSON.stringify(findings));
});

describe('metadata relation storage', () => {
  for (const [mode, runtime] of [['sql', sql], ['transactional mongo', strict]]) {
    check(`${mode}: rejects a scalar String inverse`, source(child('ownerId: { type: S }') + root(`children: ${ref('new L(Child)')}`), runtime), ['storageInverse']);
    check(`${mode}: rejects an ID-list inverse`, source(child('ownerId: { type: new L(ID) }') + root(`children: ${ref('new L(Child)')}`), runtime), ['storageInverse']);
    check(`${mode}: accepts an inferred singular ID inverse`, source(child('ownerId: { type: new N(ID) }') + root(`children: ${ref('new L(Child)')}`), runtime), []);
    check(`${mode}: synthesizes a private inverse`, source(child() + root(`children: ${ref('new L(Child)')}`), runtime), []);
    check(`${mode}: accepts a named inverse reference alias`, source(child(`owner: ${ref('Root')}`) + root(`children: ${ref('new L(Child)', 'owner')}`), runtime), []);
    check(`${mode}: rejects collection-to-collection without reciprocity`, source(child(`ownerId: ${ref('new L(Root)', 'otherId')}`) + root(`children: ${ref('new L(Child)')}`), runtime), ['storageManyToMany']);
    check(`${mode}: rejects two parents claiming one private inverse`, source(child() + root(`children: ${ref('new L(Child)')}`) + `const Other = new O({ name: 'Other', fields: { children: ${ref('new L(Child)')} } });`, runtime, `${register}sf.connect(null, Other, 'other', 'others');`), ['storageInverse']);
    check(`${mode}: rejects a reference to another parent`, source(child(`owner: ${ref('Other')}`) + "const Other = new O({ name: 'Other', fields: { label: { type: S } } });" + root(`children: ${ref('new L(Child)')}`), runtime), ['storageInverse']);
    check(`${mode}: separates GraphQL-name and storage-name conflicts`, source(child(`ownerId: ${ref('Root', 'firstId')}, owner: ${ref('Root')}`) + root(`children: ${ref('new L(Child)')}`), runtime), ['storageInverseAlias']);
    check(`${mode}: rejects same-level storage collisions`, source(child() + root(`ownerId: { type: S }, owner: ${ref('Child')}`), runtime), ['storageCollision']);
    check(`${mode}: keeps separate embedded storage levels`, source(child('ownerId: { type: S }') + root(`ownerId: { type: S }, child: ${emb('Child')}`), runtime), []);
    check(`${mode}: rejects a collection inside an embedded value`, source(child(`children: ${ref('new L(Root)')}`) + root(`value: ${emb('Child')}`), runtime), ['storageEmbeddedCollection']);
    check(`${mode}: permits embedded singular references`, source(child(`owner: ${ref('Root')}`) + root(`value: ${emb('new L(Child)')}`), runtime), []);
  }
  check('Mongo off accepts conflicting metadata inverse shape', source(child('ownerId: { type: S }') + root(`children: ${ref('new L(Child)')}`), mongo), []);
  check('Mongo off accepts reused collection names', source(child(`ownerId: ${ref('new L(Root)', 'otherId')}`) + root(`children: ${ref('new L(Child)')}`), mongo), []);
  check('unknown child fields do not prove an inverse is absent', source("const Child = new O({ name: 'Child', fields: fields });" + root(`children: ${ref('new L(Child)', 'constructor')}`), mongo), []);
  check('unknown relation mode does not prove a collision', source(child() + root('ownerId: { type: S }, owner: { type: Child, extensions: { relation: { embedded: mode, connectionField: "ownerId" } } }')), []);
  check('unknown scalar base can still be a valid ID inverse', source("const Key = new Scalar({ name: 'Key' }); Key.baseScalarType = configuredBase;" + child('ownerId: { type: Key }') + root(`children: ${ref('new L(Child)')}`)), []);
  check('unknown reference target name does not prove an inverse mismatch', source("const Other = new O({ name: configuredName, fields: { label: { type: S } } });" + child(`owner: ${ref('Other')}`) + root(`children: ${ref('new L(Child)')}`)), []);
  check('mutated type containers stay unknown', source(child() + root(`ownerId: { type: S }, owner: ${ref('Child')}`), sql, `patch(Root);${register}`), []);
  check('independent GraphQL types are not stored', source(child() + root(`ownerId: { type: S }, owner: ${ref('Child')}`), sql, ''), []);
  check('virtual references do not enter storage', source(child() + root('ownerId: { type: S }, owner: { type: Child, extensions: { virtual: true }, resolve: () => null }')), []);
  check('recognizes a named registration alias', source(root('id: { type: I }'), "import { connect as registerType } from '@simtlix/simfinity-postgres';", "registerType(null, Root, 'root', 'roots');"), ['storageIdentity']);
  check('a shadowed runtime does not acquire backend identity', source(root('id: { type: I }'), sql, "function registerTypes(sf) { sf.connect(null, Root, 'root', 'roots'); }"), []);
  check('an imported dynamic target does not prove inverse storage', source("import Child from './child.js';" + root(`children: ${ref('new L(Child)')}`)), []);
  check('field getters are never executed for storage evidence', source("const Root = new O({ name: 'Root', fields: { get id() { throw Error('must not run'); } } });"), []);
});

describe('storage and input embedded cycles', () => {
  const cycle = (extra = '') => child(`label: { type: S }, back: ${emb('Root', extra)}`) + root(`child: ${emb('Child')}`);
  check('SQL storage includes readOnly cycle edges', source(cycle('readOnly: true')), ['storageCycle']);
  check('generated Mongo storage includes readOnly cycle edges', source(cycle('readOnly: true'), mongo), ['storageCycle']);
  check('core writable input cycle fails', source(cycle(), core, `${register}sf.addNoEndpointType(Child);sf.createSchema();`), ['storageInputCycle']);
  check('core readOnly edge breaks input cycle', source(cycle('readOnly: true'), core, `${register}sf.addNoEndpointType(Child);sf.createSchema();`), []);
  check('all supplied Mongo models and readOnly edge are allowed', source(cycle('readOnly: true'), mongo, "sf.connect(modelA, Root, 'root', 'roots');sf.connect(modelB, Child, 'child', 'children');sf.createSchema();"), []);
  check('supplying only root still generates the relational child', source(cycle('readOnly: true'), mongo, "sf.connect(modelA, Root, 'root', 'roots');sf.addNoEndpointType(Child);sf.createSchema();"), ['storageCycle']);
  check('sibling type reuse is not a cycle', source(child() + root(`home: ${emb('Child')}, work: ${emb('new L(Child)')}`)), []);
  check('readOnly alone cannot exempt a direct self cycle', source(root(`self: ${emb('Root', 'readOnly: true')}`)), ['storageCycle']);
  check('unknown embedded mode is not a cycle edge', source(child('back: { type: Root, extensions: { relation: { embedded: flag } } }') + root(`child: ${emb('Child')}`)), []);
});

describe('SQL index and physical storage boundaries', () => {
  for (const fields of ['[]', "['label', 'label']", '42']) {
    check(`rejects invalid index fields ${fields}`, source(root('', `extensions: { indexes: [{ fields: ${fields} }] }`)), ['storageIndexFields']);
  }
  for (const fields of ["['absent']", "['value.label']", "['tags']", "['value']"]) {
    check(`rejects unmapped SQL index ${fields}`, source(child() + root(`tags: { type: new L(S) }, value: ${emb('Child')}`, `extensions: { indexes: [{ fields: ${fields} }] }`)), ['storageIndexTarget']);
  }
  check('accepts reference storage alias index', source(child() + root(`owner: ${ref('Child')}`, "extensions: { indexes: [{ fields: ['ownerId', 'label'], unique: true }] }")), []);
  check('keeps unknown index members unknown', source(root('', 'extensions: { indexes: [{ fields: [field] }] }')), []);
  check('Mongo index targets are not SQL columns', source(root('', "extensions: { indexes: [{ fields: ['absent'] }] }"), mongo), []);
  check('transactional Mongo validates only index fields shape', source(root('', "extensions: { indexes: [{ fields: ['absent'] }] }"), strict), []);
  check('rejects non-ID/String root identity', source(root('id: { type: I }')), ['storageIdentity']);
  check('rejects root identity lists', source(root('_id: { type: new L(ID) }')), ['storageIdentity']);
  check('accepts missing identity and embedded Int id', source(child('id: { type: I }') + root(`value: ${emb('Child')}`)), []);
  check('accepts owned embedded Int id', source(child(`id: { type: I }, owner: ${ref('Root')}`) + root(`value: ${emb('Child')}`)), []);
  check('rejects private reference column', source(child() + root(`owner: ${ref('Child', '__owner')}`)), ['storagePrivateColumn']);
  check('rejects inferred private SQL link', source(child() + root(`children: ${ref('new L(Child)', '__owner')}`)), ['storagePrivateColumn']);
  check('SQL rejects promoting a declared identity into an inverse reference', source(child('id: { type: ID }, label: { type: S }') + root(`children: ${ref('new L(Child)', 'id')}`)), ['storageIdentity']);
  check('SQL rejects a private inverse taking the identity field', source(child() + root(`children: ${ref('new L(Child)', '_id')}`)), ['storageIdentity']);
  check('SQL reference aliases cannot overwrite the generated root identity column', source(child() + root(`owner: ${ref('Child', 'id')}`)), ['storageCollision']);
  check('owned embedded reference aliases may use an ordinary id column', source(child(`owner: ${ref('Root', 'id')}`) + root(`value: ${emb('Child')}`)), []);
  check('keeps private-looking value-only JSON keys out of SQL column analysis', source(child('__note: { type: S }') + root(`value: ${emb('Child')}`)), []);
  check('rejects private-looking physical owned fields', source(child(`__note: { type: S }, owner: ${ref('Root')}`) + root(`value: ${emb('Child')}`)), ['storagePrivateColumn']);
  check('rejects whole embedded uniqueness', source(child() + root(`value: ${emb('new L(Child)', 'unique: true')}`)), ['storageEmbeddedUnique']);
  check('accepts scalar list and embedded leaf uniqueness', source(child('key: { type: S, extensions: { unique: true } }') + root(`tags: { type: new L(S), extensions: { unique: true } }, value: ${emb('Child')}`)), []);
});

describe('Mongo mapping and opt-in modeling advice', () => {
  for (const type of ['S', 'new L(S)', 'Child']) {
    check(`rejects generated stored constructor (${type})`, source(child() + root(`constructor: { type: ${type}, ${type === 'Child' ? 'extensions: { relation: {} }' : ''} }`), mongo), ['storageMongoName']);
  }
  check('rejects embedded prototype member', source(child() + root(`toString: ${emb('Child')}`), mongo), ['storageMongoName']);
  check('accepts prototype scalars and aliased constructor references', source(child() + root(`toString: { type: S }, hasOwnProperty: { type: new L(S) }, constructor: ${ref('Child', 'makerId')}`), mongo), []);
  check('accepts embedded type name', source(child() + root(`type: ${emb('Child')}`), mongo), []);
  check('supplied Mongo models skip generator-only name errors', source(root('constructor: { type: S }'), mongo, "sf.connect(model, Root, 'root', 'roots');"), []);
  check('private constructor link fails even with supplied models', source(child() + root(`children: ${ref('new L(Child)', 'constructor')}`), mongo, "sf.connect(modelA, Root, 'root', 'roots');sf.connect(modelB, Child, 'child', 'children');"), ['storageMongoName']);
  check('unknown custom scalar does not prove stored constructor', source("const Custom = new Scalar({ name: 'Custom' });" + root('constructor: { type: Custom }'), mongo), []);
  check('an unannotated object has no generated Mongo constructor path', source(child() + root('constructor: { type: Child }'), mongo), []);
  check('transactional Mongo still uses generated Mongo naming rules', source(root('constructor: { type: S }'), strict), ['storageMongoName']);
  check('ignored Mongo unique is advice only', source(root('key: { type: ID, extensions: { unique: true } }'), mongo), []);
  for (const type of ['ID', 'B', 'new L(S)']) {
    check(`warns on ignored unique for ${type}`, source(root(`key: { type: ${type}, extensions: { unique: true } }`), mongo), ['storageIgnoredUnique'], advice);
  }
  check('warns on generated overwrite', source(child() + root(`ownerId: { type: S }, owner: ${ref('Child')}`), mongo), ['storageOverwrite'], advice);
  check('honored Mongo singular scalar uniqueness stays silent', source(root('key: { type: S, extensions: { unique: true } }, count: { type: I, extensions: { unique: true } }'), mongo), [], advice);
  check('supplied model unique is unknown', source(root('key: { type: ID, extensions: { unique: true } }'), mongo, "sf.connect(model, Root, 'root', 'roots');"), [], advice);
  check('unlinked collection with only readOnly is advice', source(child() + root('children: { type: new L(Child), extensions: { relation: {}, readOnly: true } }'), mongo), ['storageUnlinkedCollection'], advice);
  check('unlinked collection with only own resolver is advice', source(child() + root('children: { type: new L(Child), extensions: { relation: {} }, resolve: () => [] }'), core), ['storageUnlinkedCollection'], advice);
  check('both readOnly and resolver need no unlinked advice', source(child() + root('children: { type: new L(Child), extensions: { relation: {}, readOnly: true }, resolve: () => [] }'), mongo), [], advice);
  check('collection uniqueness is not generated by Mongo', source(child() + root(`children: ${ref('new L(Child)', 'ownerId', 'unique: true')}`), mongo), ['storageIgnoredUnique'], advice);
  const shared = child('id: { type: ID }, label: { type: S }') + root(`value: ${emb('Child')}`);
  check('warns on entity identity shared with embedded values after a build', source(shared, core, `${register}sf.connect(null, Child, 'child', 'children');sf.createSchema();`), ['storageEmbeddedIdentity'], advice);
  check('embedded-only id stays untouched', source(shared, core, `${register}sf.addNoEndpointType(Child);sf.createSchema();`), [], advice);
  check('own id resolver keeps shared identity deliberate', source(child('id: { type: ID, resolve: row => row.id }, label: { type: S }') + root(`value: ${emb('Child')}`), core, `${register}sf.connect(null, Child, 'child', 'children');sf.createSchema();`), [], advice);
  check('unannotated output does not establish entity identity', source(shared.replace('label: { type: S }, value:', 'label: { type: S }, output: { type: Child, extensions: { readOnly: true }, resolve: () => null }, value:'), core, `${register}sf.addNoEndpointType(Child);sf.createSchema();`), [], advice);
  check('singleton facade still proves explicitly registered shared identity', source(shared, mongo, `${register}sf.connect(null, Child, 'child', 'children');sf.createSchema();`), ['storageEmbeddedIdentity'], advice);
  check('an earlier entity build changes later embedded identity in another runtime', source(shared, core, `sf.connect(null, Child, 'child', 'children');sf.createSchema(); const other = createRuntime(otherAdapter);other.connect(null, Root, 'root', 'roots');other.addNoEndpointType(Child);other.createSchema();`), ['storageEmbeddedIdentity'], advice);
  check('a later entity build also changes an already built embedded schema', source(shared, core, `${register}sf.addNoEndpointType(Child);sf.createSchema(); const other = createRuntime(otherAdapter);other.connect(null, Child, 'child', 'children');other.createSchema();`), ['storageEmbeddedIdentity'], advice);
  check('conditional entity registration does not prove an installed shared resolver', source(shared, core, `${register}if (flag) sf.connect(null, Child, 'child', 'children');sf.createSchema();`), [], advice);
});
