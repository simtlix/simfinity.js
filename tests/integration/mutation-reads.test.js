// Reads by ID that generated mutations issue on real databases (#77): a delete without onDelete and
// an update that merges no embedded value skip the read when the adapter reports it as inert, and
// state actions and nested children read their record once unless they merge a singular embedded
// object or write a non-empty embedded list. `adapter.getById` calls are the primary
// signal; MongoDB commands and PostgreSQL statements inside the mutation's own transaction show
// that no other read replaces them. Results, stored data, hook arguments and errors are pinned with
// explicit values on every backend and mode.
import { randomUUID } from 'node:crypto';
import {
  afterAll, beforeAll, describe, expect, test, vi,
} from 'vitest';
import {
  GraphQLEnumType, GraphQLID, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';
import mongoose from 'mongoose';
import pg from 'pg';

import { createRuntime } from '../../packages/core/src/index.js';
import { createMongoAdapter } from '../../packages/mongodb/src/mongo/adapter.js';
import { createSQLAdapter } from '../../packages/sql/src/adapter.js';
import { postgresPlugin } from '../../packages/postgres/src/index.js';

const mongoUri = process.env.SIMFINITY_MONGODB_URI;
const postgresUri = process.env.SIMFINITY_POSTGRES_URI;
const namespace = `mutation_reads_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

const createFixture = (prefix, adapter) => {
  const runtime = createRuntime(adapter);
  const controllers = { Parent: {}, Child: {} };
  const t = {};
  t.State = new GraphQLEnumType({
    name: `${prefix}State`,
    values: { DRAFT: { value: 'DRAFT' }, DONE: { value: 'DONE' }, MOVED: { value: 'MOVED' } },
  });
  t.Tag = new GraphQLObjectType({
    name: `${prefix}Tag`, fields: { id: { type: GraphQLID }, name: { type: GraphQLString } },
  });
  t.Address = new GraphQLObjectType({
    name: `${prefix}Address`, fields: { street: { type: GraphQLString }, city: { type: GraphQLString } },
  });
  t.Part = new GraphQLObjectType({
    name: `${prefix}Part`, fields: { label: { type: new GraphQLNonNull(GraphQLString) }, note: { type: GraphQLString } },
  });
  t.Info = new GraphQLObjectType({ name: `${prefix}Info`, fields: { note: { type: GraphQLString } } });
  // Embedded items that hold a reference: PostgreSQL stores them in an owned table.
  const tagged = (name) => new GraphQLObjectType({
    name,
    fields: () => ({
      label: { type: GraphQLString },
      tag: { type: t.Tag, extensions: { relation: { connectionField: 'tag_id' } } },
    }),
  });
  t.Ref = tagged(`${prefix}Ref`);
  t.Mark = tagged(`${prefix}Mark`);
  t.Child = new GraphQLObjectType({
    name: `${prefix}Child`,
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      info: { type: t.Info, extensions: { relation: { embedded: true } } },
      marks: { type: new GraphQLList(t.Mark), extensions: { relation: { embedded: true } } },
      parent: { type: t.Parent, extensions: { relation: { connectionField: 'parent' } } },
    }),
  });
  t.Parent = new GraphQLObjectType({
    name: `${prefix}Parent`,
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      state: { type: t.State },
      address: { type: t.Address, extensions: { relation: { embedded: true } } },
      parts: { type: new GraphQLList(t.Part), extensions: { relation: { embedded: true } } },
      refs: { type: new GraphQLList(t.Ref), extensions: { relation: { embedded: true } } },
      children: { type: new GraphQLList(t.Child), extensions: { relation: { connectionField: 'parent' } } },
    }),
  });
  const state = (name) => ({ name, value: name });
  for (const type of [t.Address, t.Part, t.Info, t.Ref, t.Mark]) runtime.addNoEndpointType(type);
  runtime.connect(null, t.Tag, `${prefix}tag`.toLowerCase(), `${prefix}tags`.toLowerCase());
  runtime.connect(null, t.Child, `${prefix}child`.toLowerCase(), `${prefix}childs`.toLowerCase(), controllers.Child);
  runtime.connect(null, t.Parent, `${prefix}parent`.toLowerCase(), `${prefix}parents`.toLowerCase(), controllers.Parent, null, {
    initialState: state('DRAFT'),
    actions: {
      finish: { from: state('DRAFT'), to: state('DONE') },
      // Moves the stored address in the transaction, before the generated update merges into it.
      move: {
        from: state('DRAFT'),
        to: state('MOVED'),
        action: async (args, session) => {
          await adapter.update(runtime.getModel(t.Parent), args.id,
            adapter.prepareUpdate({ address: { street: 'Moved', city: 'Moved' } }, {}), session);
        },
      },
    },
  });
  return { runtime, types: t, controllers };
};

// Command and statement logs, shared by the backends of each kind.
const mongoLog = [];
const sqlLog = [];

const backends = [
  {
    name: 'mongo',
    prefix: 'MrMongo',
    enabled: !!mongoUri,
    adapter: () => createMongoAdapter(),
  },
  {
    name: 'mongo-integrity',
    prefix: 'MrIntegrity',
    enabled: !!mongoUri,
    adapter: () => createMongoAdapter({ referentialIntegrity: 'transactional' }),
  },
  {
    name: 'postgres',
    prefix: 'MrPg',
    enabled: !!postgresUri,
    adapter: () => createSQLAdapter(postgresPlugin({ pool: postgresPool, schema: namespace })),
  },
];
let postgresPool;

beforeAll(async () => {
  if (mongoUri) {
    await mongoose.connect(mongoUri, { dbName: namespace, monitorCommands: true });
    mongoose.connection.getClient().on('commandStarted', (event) => mongoLog.push(event));
  }
  if (postgresUri) {
    postgresPool = new pg.Pool({ connectionString: postgresUri });
    postgresPool.on('connect', (client) => {
      const query = client.query.bind(client);
      client.query = (...args) => {
        sqlLog.push(typeof args[0] === 'string' ? args[0] : args[0]?.text);
        return query(...args);
      };
    });
  }
}, 30000);

afterAll(async () => {
  if (mongoose.connection.readyState) {
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
  }
  mongoose.deleteModel(/^Mr(Mongo|Integrity|Guarded|Written|Static|Setter)/);
  if (postgresPool) {
    await postgresPool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await postgresPool.end();
  }
});

const PARENT = 'Parent {"projection":{"address":1,"parts":1,"refs":1},"plain":true,"lock":true}';
const PARENT_LOCK = 'Parent {"lock":true}';
const PARENT_PLAIN = 'Parent {"plain":true}';
const CHILD_LOCK = 'Child {"plain":true,"lock":true}';
const CHILD = 'Child {"projection":{"info":1,"marks":1},"plain":true,"lock":true}';

const PARENT_FIELDS = `name state address { street city } parts { label note } refs { label tag { name } }
  children { name info { note } marks { label tag { name } } }`;
const children = (names) => names.map((name) => ({
  name, info: { note: `i-${name}` }, marks: [{ label: `m-${name}`, tag: { name: 'T' } }],
}));
const SEEDED = {
  name: 'P',
  state: 'DRAFT',
  address: { street: 'S1', city: 'C1' },
  parts: [{ label: 'a', note: 'n' }],
  refs: [{ label: 'r1', tag: { name: 'T' } }, { label: 'r2', tag: null }],
  children: children(['c1', 'c2', 'c3']),
};
const parent = (changes) => ({ ...SEEDED, ...changes });
const updated = (names) => names.map((name) => ({
  name: 'u', info: { note: `i-${name}` }, marks: [{ label: `m-${name}`, tag: { name: 'T' } }],
}));

// Each scenario runs on a parent seeded as SEEDED, with three children c1, c2 and c3.
// `reads` lists the adapter.getById calls; `mongo` the commands inside the mutation's transaction in
// the default mode; `integrity` the runtime's reads among them in transactional mode, whose own
// integrity reads come and go with its implementation; `postgres` the statements inside the
// mutation's transaction. In those, `Parent` and `Child` name the record tables and collections,
// and `Parent.refs` and `Child.marks` the owned tables.
const MONGO_PARENT = 'find Parent {"address":1,"parts":1,"refs":1}';
const MONGO_CHILD = 'find Child {"info":1,"marks":1}';
const INTEGRITY_LOCK_READ = (name) => `find ${name} {"_simfinityReferenceLock":0}`;
const PG_LOCKED_PARENT = ['select Parent for update', 'owned Parent.refs'];
const PG_UPDATE_PARENT = ['update Parent', 'owned Parent.refs'];
// The parent keeps its locked read before nested items; its empty update then reads it unlocked.
const nestedMongo = (perChild) => [MONGO_PARENT, 'findAndModify Parent', ...Array(3).fill(perChild).flat(), 'commitTransaction'];
const nestedIntegrity = (perChild) => [MONGO_PARENT, ...Array(3).fill(perChild).flat()];
const nestedPostgres = (perChild) => [
  'BEGIN', ...PG_LOCKED_PARENT, 'select Parent', 'owned Parent.refs', ...Array(3).fill(perChild).flat(), 'COMMIT',
];
const NESTED_DELETED = {
  reads: [PARENT, CHILD_LOCK, CHILD_LOCK, CHILD_LOCK],
  mongo: nestedMongo(['find Child', 'findAndModify Child']),
  integrity: nestedIntegrity([INTEGRITY_LOCK_READ('Child')]),
  // The child's locked read, then the delete's own read of the record it returns.
  postgres: nestedPostgres(['select Child for update', 'owned Child.marks', 'select Child', 'owned Child.marks', 'delete Child']),
};
const NESTED_UPDATED = {
  reads: [PARENT, CHILD_LOCK, CHILD_LOCK, CHILD_LOCK],
  mongo: nestedMongo(['find Child', 'findAndModify Child']),
  integrity: nestedIntegrity([INTEGRITY_LOCK_READ('Child')]),
  postgres: nestedPostgres(['select Child for update', 'owned Child.marks', 'update Child', 'owned Child.marks']),
};
const nestedDeleted = (ids, p) => `mutation { update${p}parent(input: { id: "${ids.id}",
  children: { deleted: ${JSON.stringify(ids.children)} } }) { ${PARENT_FIELDS} } }`;
const nestedUpdated = (ids, p, change) => `mutation { update${p}parent(input: { id: "${ids.id}",
  children: { updated: [${ids.children.map((id) => `{ id: "${id}", ${change} }`).join(', ')}] } }) { ${PARENT_FIELDS} } }`;
const DELETED_FIELDS = 'name address { street } parts { label } refs { label }';
const DELETED_DATA = { name: 'P', address: { street: 'S1' }, parts: [{ label: 'a' }], refs: [{ label: 'r1' }, { label: 'r2' }] };

const scenarios = [
  {
    name: 'an update without hooks that merges no embedded value',
    mutation: (ids, p) => `mutation { update${p}parent(input: { id: "${ids.id}", name: "renamed" }) { ${PARENT_FIELDS} } }`,
    data: parent({ name: 'renamed' }),
    reads: [],
    mongo: ['findAndModify Parent', 'commitTransaction'],
    integrity: [],
    postgres: ['BEGIN', ...PG_UPDATE_PARENT, 'COMMIT'],
  },
  {
    name: 'an update that clears the embedded object and empties an embedded list',
    mutation: (ids, p) => `mutation { update${p}parent(input: { id: "${ids.id}", parts: [], address: null }) { ${PARENT_FIELDS} } }`,
    // Generated Mongoose models declare embedded members as nested paths, which by-ID reads and
    // update responses render as an object.
    data: {
      mongo: parent({ address: { street: null, city: null }, parts: [] }),
      postgres: parent({ address: null, parts: [] }),
    },
    reads: [],
    mongo: ['findAndModify Parent', 'commitTransaction'],
    integrity: [],
    postgres: ['BEGIN', ...PG_UPDATE_PARENT, 'COMMIT'],
  },
  {
    name: 'an update with onUpdating',
    hooks: { Parent: ['onUpdating'] },
    mutation: (ids, p) => `mutation { update${p}parent(input: { id: "${ids.id}", name: "renamed" }) { ${PARENT_FIELDS} } }`,
    data: parent({ name: 'renamed' }),
    hookCalls: [['Parent', 'onUpdating', '<id>', { name: 'renamed' }]],
    reads: [PARENT],
    mongo: [MONGO_PARENT, 'findAndModify Parent', 'commitTransaction'],
    integrity: [MONGO_PARENT],
    postgres: ['BEGIN', ...PG_LOCKED_PARENT, ...PG_UPDATE_PARENT, 'COMMIT'],
  },
  {
    name: 'an update that merges the embedded object',
    mutation: (ids, p) => `mutation { update${p}parent(input: { id: "${ids.id}", address: { city: "C2" } }) { ${PARENT_FIELDS} } }`,
    data: parent({ address: { street: 'S1', city: 'C2' } }),
    reads: [PARENT],
    mongo: [MONGO_PARENT, 'findAndModify Parent', 'commitTransaction'],
    integrity: [MONGO_PARENT],
    postgres: ['BEGIN', ...PG_LOCKED_PARENT, ...PG_UPDATE_PARENT, 'COMMIT'],
  },
  {
    name: 'an update that replaces an embedded list',
    mutation: (ids, p) => `mutation { update${p}parent(input: { id: "${ids.id}", parts: [{ label: "b" }] }) { ${PARENT_FIELDS} } }`,
    data: parent({ parts: [{ label: 'b', note: null }] }),
    reads: [PARENT],
    mongo: [MONGO_PARENT, 'findAndModify Parent', 'commitTransaction'],
    integrity: [MONGO_PARENT],
    postgres: ['BEGIN', ...PG_LOCKED_PARENT, ...PG_UPDATE_PARENT, 'COMMIT'],
  },
  {
    name: 'a state action',
    mutation: (ids, p) => `mutation { finish_${p}parent(input: { id: "${ids.id}", name: "done" }) { ${PARENT_FIELDS} } }`,
    data: parent({ name: 'done', state: 'DONE' }),
    reads: [PARENT_LOCK],
    mongo: ['find Parent', 'findAndModify Parent', 'commitTransaction'],
    integrity: [INTEGRITY_LOCK_READ('Parent')],
    postgres: ['BEGIN', ...PG_LOCKED_PARENT, ...PG_UPDATE_PARENT, 'COMMIT'],
  },
  {
    name: 'a state action with onUpdating',
    hooks: { Parent: ['onUpdating'] },
    mutation: (ids, p) => `mutation { finish_${p}parent(input: { id: "${ids.id}" }) { ${PARENT_FIELDS} } }`,
    data: parent({ state: 'DONE' }),
    hookCalls: [['Parent', 'onUpdating', '<id>', { state: 'DONE' }]],
    reads: [PARENT_LOCK],
    mongo: ['find Parent', 'findAndModify Parent', 'commitTransaction'],
    integrity: [INTEGRITY_LOCK_READ('Parent')],
    postgres: ['BEGIN', ...PG_LOCKED_PARENT, ...PG_UPDATE_PARENT, 'COMMIT'],
  },
  {
    // The merge base is read after the action's write, not taken from the state check's read.
    name: 'a state action whose action changes the embedded object it then merges into',
    mutation: (ids, p) => `mutation { move_${p}parent(input: { id: "${ids.id}", address: { city: "C2" } }) { ${PARENT_FIELDS} } }`,
    data: parent({ state: 'MOVED', address: { street: 'Moved', city: 'C2' } }),
    reads: [PARENT_LOCK, PARENT],
    mongo: ['find Parent', 'findAndModify Parent', MONGO_PARENT, 'findAndModify Parent', 'commitTransaction'],
    integrity: [INTEGRITY_LOCK_READ('Parent'), MONGO_PARENT],
    postgres: ['BEGIN', ...PG_LOCKED_PARENT, ...PG_UPDATE_PARENT, ...PG_LOCKED_PARENT, ...PG_UPDATE_PARENT, 'COMMIT'],
  },
  {
    name: 'a delete without onDelete',
    seedChildren: false,
    mutation: (ids, p) => `mutation { delete${p}parent(id: "${ids.id}") { ${DELETED_FIELDS} } }`,
    data: DELETED_DATA,
    stored: null,
    reads: [],
    mongo: ['findAndModify Parent', 'commitTransaction'],
    integrity: [],
    // The delete's own read of the record it returns.
    postgres: ['BEGIN', 'select Parent', 'owned Parent.refs', 'delete Parent', 'COMMIT'],
  },
  {
    name: 'a delete with onDelete',
    seedChildren: false,
    hooks: { Parent: ['onDelete'] },
    mutation: (ids, p) => `mutation { delete${p}parent(id: "${ids.id}") { ${DELETED_FIELDS} } }`,
    data: DELETED_DATA,
    stored: null,
    hookCalls: [['Parent', 'onDelete', {
      name: 'P', state: 'DRAFT', address: { street: 'S1', city: 'C1' }, parts: [{ label: 'a', note: 'n' }], refs: ['r1', 'r2'],
    }]],
    reads: [PARENT_PLAIN],
    mongo: ['find Parent', 'findAndModify Parent', 'commitTransaction'],
    integrity: [INTEGRITY_LOCK_READ('Parent')],
    postgres: ['BEGIN', 'select Parent', 'owned Parent.refs', 'select Parent', 'owned Parent.refs', 'delete Parent', 'COMMIT'],
  },
  {
    name: 'nested deleted children',
    mutation: nestedDeleted,
    data: parent({ children: [] }),
    ...NESTED_DELETED,
  },
  {
    name: 'nested deleted children with onDelete',
    hooks: { Child: ['onDelete'] },
    mutation: nestedDeleted,
    data: parent({ children: [] }),
    // onDelete receives the child the ownership check read, owned rows included.
    hookCalls: ['c1', 'c2', 'c3'].map((name) => ['Child', 'onDelete', {
      name, info: { note: `i-${name}` }, marks: [`m-${name}`],
    }]),
    ...NESTED_DELETED,
  },
  {
    name: 'nested updated children',
    mutation: (ids, p) => nestedUpdated(ids, p, 'name: "u"'),
    data: parent({ children: updated(['c1', 'c2', 'c3']) }),
    ...NESTED_UPDATED,
  },
  {
    name: 'nested updated children with onUpdating',
    hooks: { Child: ['onUpdating'] },
    mutation: (ids, p) => nestedUpdated(ids, p, 'name: "u"'),
    data: parent({ children: updated(['c1', 'c2', 'c3']) }),
    hookCalls: Array(3).fill(['Child', 'onUpdating', '<id>', { name: 'u' }]),
    ...NESTED_UPDATED,
  },
  {
    name: 'nested updated children that merge an embedded object',
    mutation: (ids, p) => nestedUpdated(ids, p, 'info: { note: "z" }'),
    data: parent({
      children: ['c1', 'c2', 'c3'].map((name) => ({
        name, info: { note: 'z' }, marks: [{ label: `m-${name}`, tag: { name: 'T' } }],
      })),
    }),
    reads: [PARENT, ...Array(3).fill([CHILD_LOCK, CHILD]).flat()],
    mongo: nestedMongo(['find Child', MONGO_CHILD, 'findAndModify Child']),
    integrity: nestedIntegrity([INTEGRITY_LOCK_READ('Child'), MONGO_CHILD]),
    postgres: nestedPostgres(['select Child for update', 'owned Child.marks', 'select Child for update', 'owned Child.marks',
      'update Child', 'owned Child.marks']),
  },
];

const BAD_IDS = {
  mongo: { malformed: 'not-an-id', missing: () => new mongoose.Types.ObjectId().toHexString() },
  postgres: { malformed: 'not-an-id', missing: () => randomUUID() },
};
const INVALID_ID = { mongo: 'Invalid identifier', postgres: 'Expected a UUID identifier' };

// Errors are unchanged, with or without hooks; the read stays wherever it decides the error.
const errorScenarios = [
  {
    name: 'an update of a malformed ID', kind: 'malformed', status: 400, reads: [],
    mutation: (id, p) => `mutation { update${p}parent(input: { id: "${id}", name: "x" }) { name } }`,
  },
  {
    name: 'an update with onUpdating of a malformed ID', kind: 'malformed', status: 400, reads: [PARENT],
    hooks: { Parent: ['onUpdating'] },
    mutation: (id, p) => `mutation { update${p}parent(input: { id: "${id}", name: "x" }) { name } }`,
  },
  {
    name: 'an update of a missing ID', kind: 'missing', status: 404, reads: [],
    mutation: (id, p) => `mutation { update${p}parent(input: { id: "${id}", name: "x" }) { name } }`,
  },
  {
    name: 'an update with onUpdating of a missing ID', kind: 'missing', status: 404, reads: [PARENT],
    hooks: { Parent: ['onUpdating'] },
    hookCalls: [['Parent', 'onUpdating', '<id>', { name: 'x' }]],
    mutation: (id, p) => `mutation { update${p}parent(input: { id: "${id}", name: "x" }) { name } }`,
  },
  {
    // MongoDB completes the list only for an existing record; PostgreSQL also checks it when it
    // encodes the column.
    name: 'an update of a missing ID with an invalid embedded list', kind: 'missing', status: 404, reads: [PARENT],
    error: { postgres: { code: 'REQUIRED_VALUE', status: 400, message: 'Required value label is missing' } },
    mutation: (id, p) => `mutation { update${p}parent(input: { id: "${id}", parts: [{ note: "x" }] }) { name } }`,
  },
  {
    name: 'a delete of a malformed ID', kind: 'malformed', status: 400, reads: [],
    mutation: (id, p) => `mutation { delete${p}parent(id: "${id}") { name } }`,
  },
  {
    name: 'a delete of a missing ID', kind: 'missing', reads: [],
    mutation: (id, p) => `mutation { delete${p}parent(id: "${id}") { name } }`,
  },
  {
    name: 'a delete with onDelete of a missing ID', kind: 'missing', reads: [PARENT_PLAIN],
    hooks: { Parent: ['onDelete'] },
    hookCalls: [['Parent', 'onDelete', null]],
    mutation: (id, p) => `mutation { delete${p}parent(id: "${id}") { name } }`,
  },
  {
    name: 'a state action of a malformed ID', kind: 'malformed', status: 400, reads: [PARENT_LOCK],
    mutation: (id, p) => `mutation { finish_${p}parent(input: { id: "${id}" }) { name } }`,
  },
];

// Hook arguments without generated keys: an ID as '<id>', embedded items with owned rows by label.
const withoutKeys = (value) => {
  if (Array.isArray(value)) return value.map(withoutKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== '_id')
    .map(([key, item]) => [key, withoutKeys(item)]));
};
const hookValue = (value) => {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return '<id>';
  const result = {};
  for (const [key, item] of Object.entries(withoutKeys(JSON.parse(JSON.stringify(value))))) {
    if (['id', '__v', 'parent', '$set', '$unset'].includes(key)) continue;
    result[key] = ['refs', 'marks'].includes(key) && Array.isArray(item) ? item.map(({ label }) => label) : item;
  }
  return result;
};
const sortChildren = (record) => (record?.children
  ? { ...record, children: [...record.children].sort((a, b) => a.name.localeCompare(b.name)) } : record);

describe.each(backends)('generated mutation reads on $name', (backend) => {
  const kind = backend.name.startsWith('mongo') ? 'mongo' : 'postgres';
  const p = backend.prefix.toLowerCase();
  let fixture;
  let adapter;
  let schema;
  let getById;
  let tagId;
  const hookCalls = [];
  const names = new Map();

  beforeAll(async () => {
    if (!backend.enabled) return;
    adapter = backend.adapter();
    fixture = createFixture(backend.prefix, adapter);
    if (kind === 'mongo') fixture.runtime.preventCreatingCollection(true);
    schema = fixture.runtime.createSchema();
    for (const name of ['Parent', 'Child', 'Tag']) names.set(fixture.runtime.getModel(fixture.types[name]), name);
    if (kind === 'mongo') {
      const models = fixture.runtime.getRegistrations().map(({ model }) => model).filter(Boolean);
      for (const model of models) await model.createCollection();
      // Compiling a model starts its index builds in the background. Finish them before the first
      // scenario: a build that commits during a mutation's transaction aborts it, and the retry
      // adds commands and reads to the pinned logs.
      for (const model of models) await model.init();
    }
    if (adapter.initialize) await adapter.initialize();
    getById = vi.spyOn(adapter, 'getById');
  }, 30000);

  const run = async (source) => graphql({ schema, source, contextValue: {} });
  const ok = async (source) => {
    const result = await run(source);
    expect(result.errors).toBeUndefined();
    return result.data;
  };
  const seed = async (withChildren = true) => {
    tagId ??= (await ok(`mutation { add${p}tag(input: { name: "T" }) { id } }`))[`add${p}tag`].id;
    const added = withChildren ? `children: { added: [${['c1', 'c2', 'c3'].map((name) => `{ name: "${name}",
      info: { note: "i-${name}" }, marks: [{ label: "m-${name}", tag: { id: "${tagId}" } }] }`).join(', ')}] }` : '';
    const data = await ok(`mutation { add${p}parent(input: { name: "P", address: { street: "S1", city: "C1" },
      parts: [{ label: "a", note: "n" }], refs: [{ label: "r1", tag: { id: "${tagId}" } }, { label: "r2" }], ${added} }) {
      id children { id name } } }`);
    const record = data[`add${p}parent`];
    const childIds = [...record.children].sort((a, b) => a.name.localeCompare(b.name)).map(({ id }) => id);
    return { id: record.id, children: childIds };
  };
  const installHooks = (hooks = {}) => {
    hookCalls.length = 0;
    for (const [type, controller] of Object.entries(fixture.controllers)) {
      for (const key of Object.keys(controller)) delete controller[key];
      for (const hook of hooks[type] || []) {
        controller[hook] = async (...args) => {
          hookCalls.push(hook === 'onUpdating' ? [type, hook, hookValue(args[0]), hookValue(args[1])] : [type, hook, hookValue(args[0])]);
        };
      }
    }
  };
  const reads = () => getById.mock.calls.map(([model, , , options]) => `${names.get(model)} ${JSON.stringify(options)}`);

  // The mutation's transaction: the commands sent in a transaction, or the statements from its BEGIN
  // to its COMMIT. Reads that resolve the response run after it.
  const collections = () => new Map(['Parent', 'Child', 'Tag'].map((name) => [
    fixture.runtime.getModel(fixture.types[name]).collection.collectionName, name,
  ]));
  const mongoCommands = (from) => {
    const byCollection = collections();
    return mongoLog.slice(from).filter((event) => event.command.autocommit === false).map((event) => {
      const { commandName, command } = event;
      const target = byCollection.get(command[commandName]) ?? command[commandName];
      if (commandName === 'commitTransaction' || commandName === 'abortTransaction') return commandName;
      if (commandName !== 'find' || !command.projection) return `${commandName} ${target}`;
      return `find ${target} ${JSON.stringify(command.projection)}`;
    });
  };
  // The runtime's reads in transactional mode: Mongoose by-ID queries, which carry the embedded
  // inclusion or exclude the reference lock. Integrity's own reads use other projections.
  const runtimeFinds = (commands) => commands.filter((label) => /^find \w+ \{"(_simfinityReferenceLock":0|address":1|info":1)/.test(label));
  const sqlStatements = (from) => {
    const statements = sqlLog.slice(from).map((text) => text.replace(/\s+/g, ' ').trim());
    const begin = statements.findIndex((text) => text.startsWith('BEGIN'));
    const end = statements.findIndex((text, index) => index > begin && /^(COMMIT|ROLLBACK)/.test(text));
    const table = (name) => name.replace(backend.prefix, '').replace('__', '.');
    return statements.slice(begin, end + 1).map((text) => {
      let match;
      if (text.startsWith('BEGIN')) return 'BEGIN';
      if ((match = /^SELECT \* FROM "[^"]+"\."([^"]+)" WHERE id = \$1::uuid( FOR UPDATE)?$/.exec(text))) {
        return `select ${table(match[1])}${match[2] ? ' for update' : ''}`;
      }
      if ((match = /^SELECT \* FROM "[^"]+"\."([^"]+)" WHERE "__owner_id" = ANY/.exec(text))) return `owned ${table(match[1])}`;
      if ((match = /^(UPDATE|DELETE FROM|INSERT INTO) "[^"]+"\."([^"]+)"/.exec(text))) {
        return `${match[1].split(' ')[0].toLowerCase()} ${table(match[2])}`;
      }
      return text;
    });
  };

  describe.skipIf(!backend.enabled)('reads by ID', () => {
    test('the adapter reports reads of generated models as inert', () => {
      for (const name of ['Parent', 'Child', 'Tag']) {
        expect(adapter.readByIdIsInert(fixture.runtime.getModel(fixture.types[name]))).toBe(true);
      }
    });

    test.each(scenarios)('$name', async (scenario) => {
      installHooks();
      const ids = await seed(scenario.seedChildren !== false);
      installHooks(scenario.hooks);
      getById.mockClear();
      const mongoFrom = mongoLog.length;
      const sqlFrom = sqlLog.length;
      const result = await run(scenario.mutation(ids, p));
      const mutationReads = reads();
      const commands = kind === 'mongo' ? mongoCommands(mongoFrom) : [];
      const statements = kind === 'postgres' ? sqlStatements(sqlFrom) : [];
      const operation = Object.keys(result.data ?? {})[0];
      const stored = (await ok(`{ ${p}parent(id: "${ids.id}") { ${PARENT_FIELDS} } }`))[`${p}parent`];

      expect(result.errors).toBeUndefined();
      const data = scenario.data[kind] ?? scenario.data;
      expect(sortChildren(result.data[operation])).toEqual(data);
      expect(sortChildren(stored)).toEqual(scenario.stored === undefined ? data : scenario.stored);
      expect(hookCalls).toEqual(scenario.hookCalls ?? []);
      expect(mutationReads).toEqual(scenario.reads);
      if (backend.name === 'mongo') expect(commands).toEqual(scenario.mongo);
      if (backend.name === 'mongo-integrity') expect(runtimeFinds(commands)).toEqual(scenario.integrity);
      if (backend.name === 'postgres') expect(statements).toEqual(scenario.postgres);
    });

    test.each(errorScenarios)('$name', async (scenario) => {
      installHooks(scenario.hooks);
      getById.mockClear();
      const id = scenario.kind === 'malformed' ? BAD_IDS[kind].malformed : BAD_IDS[kind].missing();
      const result = await run(scenario.mutation(id, p));
      const operation = Object.keys(result.data)[0];
      expect(result.data[operation]).toBeNull();
      if (scenario.status) {
        const error = scenario.error?.[kind] ?? {
          code: 'NOT_VALID_ID',
          status: scenario.status,
          message: scenario.status === 400 ? INVALID_ID[kind] : `${backend.prefix}Parent ${id} is not valid`,
        };
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].extensions).toMatchObject({ code: error.code, status: error.status });
        expect(result.errors[0].message).toBe(error.message);
      } else {
        expect(result.errors).toBeUndefined();
      }
      expect(hookCalls).toEqual(scenario.hookCalls ?? []);
      expect(reads()).toEqual(scenario.reads);
    });

    test.skipIf(kind !== 'postgres')('updates that keep the read lock the parent first', async () => {
      for (const [hooks, mutation] of [
        [{ Parent: ['onUpdating'] }, (ids) => `update${p}parent(input: { id: "${ids.id}", name: "x" })`],
        [{}, (ids) => `update${p}parent(input: { id: "${ids.id}", children: { added: [{ name: "c4" }] } })`],
        [{}, (ids) => `update${p}parent(input: { id: "${ids.id}", children: { updated: [{ id: "${ids.children[0]}", name: "u" }] } })`],
        [{}, (ids) => `update${p}parent(input: { id: "${ids.id}", children: { deleted: ["${ids.children[0]}"] } })`],
        [{}, (ids) => `finish_${p}parent(input: { id: "${ids.id}" })`],
      ]) {
        installHooks();
        const ids = await seed();
        installHooks(hooks);
        const from = sqlLog.length;
        expect((await run(`mutation { ${mutation(ids)} { name } }`)).errors).toBeUndefined();
        expect(sqlStatements(from).slice(0, 2)).toEqual(['BEGIN', 'select Parent for update']);
      }
    });
  });
});

describe.skipIf(!mongoUri)('a supplied Mongoose model with a findOne guard', () => {
  let schema;
  let Model;
  const guarded = [];

  beforeAll(async () => {
    const runtime = createRuntime(createMongoAdapter());
    runtime.preventCreatingCollection(true);
    const Info = new GraphQLObjectType({ name: 'MrGuardedInfo', fields: { note: { type: GraphQLString } } });
    const Item = new GraphQLObjectType({
      name: 'MrGuardedItem',
      fields: () => ({
        id: { type: GraphQLID },
        title: { type: GraphQLString },
        info: { type: Info, extensions: { relation: { embedded: true } } },
      }),
    });
    const itemSchema = new mongoose.Schema({ title: String, info: { note: String }, locked: Boolean });
    // An application guard on reads: refuses to read a locked record.
    itemSchema.pre('findOne', async function guard() {
      const id = String(this.getFilter()._id);
      guarded.push(id);
      const stored = await this.model.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });
      if (stored?.locked) throw new Error('record is locked');
    });
    Model = mongoose.model('MrGuardedItem', itemSchema);
    runtime.addNoEndpointType(Info);
    runtime.connect(Model, Item, 'mrguardeditem', 'mrguardeditems');
    schema = runtime.createSchema();
    await Model.createCollection();
    await Model.init();
  });

  test('still rejects a delete without onDelete and an update that merges no embedded value', async () => {
    const _id = new mongoose.Types.ObjectId();
    const record = { _id, title: 't', info: { note: 'n' }, locked: true };
    await Model.collection.insertOne(record);

    const update = await graphql({ schema, source: `mutation { updatemrguardeditem(input: { id: "${_id}", title: "changed" }) { title } }` });
    expect(update.errors.map(({ message }) => message)).toEqual(['record is locked']);
    expect(update.data).toEqual({ updatemrguardeditem: null });
    const deleted = await graphql({ schema, source: `mutation { deletemrguardeditem(id: "${_id}") { title } }` });
    expect(deleted.errors.map(({ message }) => message)).toEqual(['record is locked']);
    expect(deleted.data).toEqual({ deletemrguardeditem: null });

    expect(guarded).toEqual([String(_id), String(_id)]);
    expect(await Model.collection.findOne({ _id })).toEqual(record);
  });
});

describe.skipIf(!mongoUri)('a supplied Mongoose model with write middleware', () => {
  let schema;
  let Model;
  const hooked = [];

  beforeAll(async () => {
    const runtime = createRuntime(createMongoAdapter());
    runtime.preventCreatingCollection(true);
    const Info = new GraphQLObjectType({ name: 'MrWrittenInfo', fields: { note: { type: GraphQLString } } });
    const Item = new GraphQLObjectType({
      name: 'MrWrittenItem',
      fields: () => ({
        id: { type: GraphQLID },
        title: { type: GraphQLString },
        info: { type: Info, extensions: { relation: { embedded: true } } },
      }),
    });
    const itemSchema = new mongoose.Schema({ title: String, info: { note: String } });
    // Application write middleware that rewrites the filter before Mongoose casts it. Its read hooks
    // are empty, so only the write hooks tell that the generated read must run first. The embedded
    // field makes 3.5.9 read before a plain update, as it did before every delete.
    for (const operation of ['findOneAndUpdate', 'findOneAndDelete']) {
      itemSchema.pre(operation, function redirect() {
        hooked.push(`${operation} ${String(this.getFilter()._id)}`);
        this.setQuery({ _id: target });
      });
    }
    Model = mongoose.model('MrWrittenItem', itemSchema);
    runtime.addNoEndpointType(Info);
    runtime.connect(Model, Item, 'mrwrittenitem', 'mrwrittenitems');
    schema = runtime.createSchema();
    await Model.createCollection();
    await Model.init();
  });
  const target = new mongoose.Types.ObjectId();

  test('rejects an invalid ID before the write middleware runs', async () => {
    const record = { _id: target, title: 'kept', info: { note: 'n' } };
    await Model.collection.insertOne(record);
    const run = async (source) => {
      const { data, errors } = await graphql({ schema, source: `mutation { ${source} { title } }` });
      return { data, errors: errors?.map(({ message, extensions }) => ({ message, code: extensions.code, status: extensions.status })) };
    };

    const invalidId = { message: 'Invalid identifier', code: 'NOT_VALID_ID', status: 400 };
    expect(await run('deletemrwrittenitem(id: "invalid")')).toEqual({ data: { deletemrwrittenitem: null }, errors: [invalidId] });
    expect(await run('updatemrwrittenitem(input: { id: "invalid", title: "changed" })')).toEqual({ data: { updatemrwrittenitem: null }, errors: [invalidId] });

    expect(hooked).toEqual([]);
    expect(await Model.collection.findOne({ _id: target })).toEqual(record);
  });
});

describe.skipIf(!mongoUri)('a supplied Mongoose model that overrides the by-ID statics', () => {
  let schema;
  let Model;
  const calls = [];
  const locked = new Set();

  beforeAll(async () => {
    const runtime = createRuntime(createMongoAdapter());
    runtime.preventCreatingCollection(true);
    const Info = new GraphQLObjectType({ name: 'MrStaticInfo', fields: { note: { type: GraphQLString } } });
    const Item = new GraphQLObjectType({
      name: 'MrStaticItem',
      fields: () => ({
        id: { type: GraphQLID },
        title: { type: GraphQLString },
        info: { type: Info, extensions: { relation: { embedded: true } } },
      }),
    });
    const itemSchema = new mongoose.Schema({ title: String, info: { note: String }, slug: String });
    // A read guard on findById, and writes that look a record up by slug when the ID is not an
    // ObjectId. The embedded field makes 3.5.9 read before a plain update, as before every delete.
    itemSchema.static('findById', function findById(id, ...rest) {
      calls.push(`findById ${id}`);
      if (locked.has(String(id))) throw new Error('record is locked');
      return mongoose.Model.findById.call(this, id, ...rest);
    });
    for (const [byId, bySlug] of [['findByIdAndUpdate', 'findOneAndUpdate'], ['findByIdAndDelete', 'findOneAndDelete']]) {
      itemSchema.static(byId, function write(id, ...rest) {
        calls.push(`${byId} ${id}`);
        return mongoose.isObjectIdOrHexString(id) ? mongoose.Model[byId].call(this, id, ...rest)
          : mongoose.Model[bySlug].call(this, { slug: id }, ...rest);
      });
    }
    Model = mongoose.model('MrStaticItem', itemSchema);
    runtime.addNoEndpointType(Info);
    runtime.connect(Model, Item, 'mrstaticitem', 'mrstaticitems');
    schema = runtime.createSchema();
    await Model.createCollection();
    await Model.init();
  });

  const run = async (source) => {
    const { data, errors } = await graphql({ schema, source: `mutation { ${source} { title } }` });
    return { data, errors: errors?.map(({ message, extensions }) => ({ message, code: extensions.code, status: extensions.status })) };
  };

  test('runs the overridden read before a delete without onDelete and a plain update', async () => {
    const _id = new mongoose.Types.ObjectId();
    const record = { _id, title: 't', info: { note: 'n' } };
    await Model.collection.insertOne(record);
    locked.add(String(_id));
    calls.length = 0;

    const lockedError = { message: 'record is locked', code: undefined, status: undefined };
    expect(await run(`updatemrstaticitem(input: { id: "${_id}", title: "changed" })`)).toEqual({ data: { updatemrstaticitem: null }, errors: [lockedError] });
    expect(await run(`deletemrstaticitem(id: "${_id}")`)).toEqual({ data: { deletemrstaticitem: null }, errors: [lockedError] });
    expect(calls).toEqual([`findById ${_id}`, `findById ${_id}`]);
    expect(await Model.collection.findOne({ _id })).toEqual(record);
  });

  test('rejects an ID that is not an ObjectId before the overridden writes run', async () => {
    const _id = new mongoose.Types.ObjectId();
    const record = { _id, title: 'kept', info: { note: 'n' }, slug: 'my-slug' };
    await Model.collection.insertOne(record);
    calls.length = 0;

    const invalidId = { message: 'Invalid identifier', code: 'NOT_VALID_ID', status: 400 };
    expect(await run('updatemrstaticitem(input: { id: "my-slug", title: "changed" })')).toEqual({ data: { updatemrstaticitem: null }, errors: [invalidId] });
    expect(await run('deletemrstaticitem(id: "my-slug")')).toEqual({ data: { deletemrstaticitem: null }, errors: [invalidId] });
    expect(calls).toEqual(['findById my-slug', 'findById my-slug']);
    expect(await Model.collection.findOne({ _id })).toEqual(record);
  });
});

describe.skipIf(!mongoUri)('a supplied Mongoose model with an operation-specific ID setter', () => {
  let schema;
  let Model;
  let target;
  const writes = [];

  beforeAll(async () => {
    const runtime = createRuntime(createMongoAdapter());
    runtime.preventCreatingCollection(true);
    const Info = new GraphQLObjectType({ name: 'MrSetterInfo', fields: { note: { type: GraphQLString } } });
    const Item = new GraphQLObjectType({
      name: 'MrSetterItem',
      fields: {
        id: { type: GraphQLID },
        title: { type: GraphQLString },
        info: { type: Info, extensions: { relation: { embedded: true } } },
      },
    });
    const itemSchema = new mongoose.Schema({ title: String, info: { note: String } });
    // Setters run before casting too, without query hooks or overridden statics. Reads must reject
    // the malformed ID before a write-specific setter can redirect it to another record.
    itemSchema.path('_id').set(function redirect(value) {
      if (['findOneAndUpdate', 'findOneAndDelete'].includes(this.op)) {
        writes.push(this.op);
        return target;
      }
      return value;
    });
    Model = mongoose.model('MrSetterItem', itemSchema);
    runtime.addNoEndpointType(Info);
    runtime.connect(Model, Item, 'mrsetteritem', 'mrsetteritems');
    schema = runtime.createSchema();
    await Model.createCollection();
    await Model.init();
  });

  test.each(['delete', 'update'])('rejects an invalid ID before the %s setter can redirect the write', async (operation) => {
    target = new mongoose.Types.ObjectId();
    const record = { _id: target, title: 'kept', info: { note: 'n' } };
    await Model.collection.insertOne(record);
    writes.length = 0;
    const input = operation === 'delete' ? 'id: "invalid"' : 'input: { id: "invalid", title: "changed" }';
    const field = `${operation}mrsetteritem`;
    const result = await graphql({ schema, source: `mutation { ${field}(${input}) { title } }` });

    expect(result.errors?.map(({ extensions }) => ({ code: extensions.code, status: extensions.status })))
      .toEqual([{ code: 'NOT_VALID_ID', status: 400 }]);
    expect(result.data).toEqual({ [field]: null });
    expect(writes).toEqual([]);
    expect(await Model.collection.findOne({ _id: target })).toEqual(record);
  });
});
