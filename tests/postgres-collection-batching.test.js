import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  GraphQLID, GraphQLList, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';
import { describeModels } from '../packages/core/src/metadata.js';
import { createQueryPlan } from '../packages/core/src/query-plan.js';
import { describeDatabase } from '../packages/postgres/src/schema/describe.js';
import { compileChildrenQuery, compileQuery } from '../packages/postgres/src/query/compiler.js';
import { postgresPlugin } from '../packages/postgres/src/index.js';
import { createSQLAdapter } from '../packages/sql/src/adapter.js';
import { bindPlugin } from '../packages/sql/src/plugin.js';
import { createRuntime } from '../packages/core/src/index.js';
import { createContractModelFixtures } from './contracts/model-fixtures.js';

// Batched collection reads on PostgreSQL (#165), without a database: the UNION ALL statement compileChildrenQuery
// builds from compileQuery's per-parent statement, its pairing with compileQuery, and the SQL adapter's
// findChildrenBatch and batchesChildren over a recording pool. Batching is opt-in: only `batchedCollections: true`
// defines the adapter members, and each batched statement then runs in a transaction right after its setup,
// `SET LOCAL jit = off`.

const code = (value) => expect.objectContaining({ extensions: expect.objectContaining({ code: value }) });
const setup = () => {
  const { registrations } = createContractModelFixtures();
  const models = describeModels(registrations);
  return { models, database: describeDatabase(registrations, { schema: 'app' }) };
};
// Inlines each bound value, so statements whose parameters are numbered differently can be compared.
const render = ({ text, values }) => text.replace(/\$(\d+)::([a-z]+(?: [a-z]+)*(?:\[\])?)/g, (_, index, type) => `${JSON.stringify(values[index - 1])}::${type}`);
// One branch per parent, each the per-parent statement wrapped with its position and row numbers.
const branch = (position, statement) => `SELECT ${position}::integer AS "__simfinity_parent", row_number() OVER () AS "__simfinity_ordinal", simfinity_children.* FROM (${statement}) simfinity_children`;
const ORDER = ' ORDER BY "__simfinity_parent", "__simfinity_ordinal"';
const BATCHED = /^SELECT 1::integer AS "__simfinity_parent", row_number\(\) OVER \(\) AS "__simfinity_ordinal", simfinity_children\.\* FROM \(SELECT t0\.\* FROM /;
const BEGIN = 'BEGIN ISOLATION LEVEL REPEATABLE READ';
const JIT_OFF = 'SET LOCAL jit = off';
const BATCHING = { batchedCollections: true };
// The branches of a batched statement, whose per-parent statements can hold UNION ALL subqueries of their own.
const branches = (text) => text.split(/ UNION ALL (?=SELECT \d+::integer AS "__simfinity_parent", )/);
// The parent parameter of each branch, in branch order.
const parentParameters = (text) => branches(text).map((part) => Number([...part.matchAll(/ AND t0\."[a-z]+" = \$(\d+)::uuid/g)].at(-1)[1]));

describe('compileChildrenQuery', () => {
  // The argument shapes a generated collection field receives: filters, logical groups, relationship terms and
  // sorts that join, embedded paths and owned lists, sorts with ties, a total order, and pagination.
  const shapes = {
    unsorted: {},
    paginated: { pagination: { page: 3, size: 7 } },
    sortedWithTies: { sort: { terms: [{ field: 'year', order: 'DESC' }] } },
    totalOrder: { sort: { terms: [{ field: 'year', order: 'DESC' }, { field: 'id', order: 'ASC' }] }, pagination: { page: 2, size: 5 } },
    filtered: { number: { operator: 'GTE', value: 2 }, year: { operator: 'IN', value: [2001, 2003] } },
    groups: { OR: [{ conditions: [{ field: 'year', operator: 'EQ', value: 2000 }] }, { AND: [{ conditions: [{ field: 'number', operator: 'LT', value: 3 }] }] }] },
    relation: { serie: { terms: [{ path: 'title', operator: 'LIKE', value: 'Bad' }, { path: 'director.name', operator: 'EQ', value: 'Vince' }, { path: 'credits.role', operator: 'EQ', value: 'Lead' }] }, sort: { terms: [{ field: 'serie.title', order: 'ASC' }] } },
    collectionPath: { episodes: { terms: [{ path: 'duration', operator: 'GT', value: 40 }] }, pagination: { page: 1, size: 3 } },
  };

  it('runs, for each parent, the statement compileQuery returns for it, as a UNION ALL branch with its own parent parameter', () => {
    const { models, database } = setup();
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const [name, args] of Object.entries(shapes)) {
      for (const configuration of [null, { explicitNullsOrder: true }]) {
        const plan = createQueryPlan(models, 'ContractSeason', structuredClone(args));
        const singles = ids.map((id) => compileQuery(models, database, plan, { column: 'serie', id }, configuration));
        const batch = compileChildrenQuery(models, database, plan, { column: 'serie', ids }, configuration);
        expect(batch.parentColumn, name).toBe('__simfinity_parent');
        // JIT is off for the transaction the adapter runs each batched statement in.
        expect(batch.setup, name).toEqual([{ text: JIT_OFF, values: [] }]);
        // Branch k is exactly the per-parent statement of the k-th ID, in order, and the rows are ordered by
        // position and then by their row number in their branch.
        expect(render(batch), name).toBe(`${singles.map((single, index) => branch(index + 1, render(single))).join(' UNION ALL ')}${ORDER}`);
        // Each parent has a uuid parameter of its own, after the parameters every branch shares: the per-parent
        // statement's other values, such as filter values and the page.
        const shared = singles[0].values.filter((value) => value !== ids[0]);
        expect(batch.values, name).toEqual([...shared, ...ids]);
        expect(parentParameters(batch.text), name).toEqual(ids.map((id, index) => shared.length + index + 1));
        expect(new Set(branches(batch.text).map((part) => part.replace(/^SELECT \d+::integer/, '').replace(/ AND t0\."serie" = \$\d+::uuid/, '').replace(ORDER, ''))).size, name).toBe(1);
      }
    }
  });

  it('repeats the per-parent statement once per parent, so a chunk of 100 parents has 100 branches', () => {
    const { models, database } = setup();
    const ids = Array.from({ length: 100 }, () => randomUUID());
    const plan = createQueryPlan(models, 'ContractSeason', shapes.relation);
    const single = compileQuery(models, database, plan, { column: 'serie', id: ids[0] });
    const batch = compileChildrenQuery(models, database, plan, { column: 'serie', ids });
    expect(branches(batch.text)).toHaveLength(100);
    expect(batch.values).toHaveLength(single.values.length - 1 + 100);
    expect(batch.values.slice(-100)).toEqual(ids);
    expect(parentParameters(batch.text)).toEqual(ids.map((id, index) => single.values.length + index));
  });

  it('leaves compileQuery\'s per-parent statement as it was', () => {
    const { models, database } = setup();
    const id = randomUUID();
    const plan = createQueryPlan(models, 'ContractSeason', { sort: { terms: [{ field: 'year', order: 'DESC' }, { field: 'id', order: 'ASC' }] } });
    expect(compileQuery(models, database, plan, { column: 'serie', id })).toEqual({
      text: 'SELECT t0.* FROM "app"."ContractSeason" t0  WHERE TRUE AND t0."serie" = $1::uuid ORDER BY t0."year" DESC NULLS LAST, t0."id" ASC LIMIT $2::bigint OFFSET $3::bigint',
      values: [id, 100, 0],
    });
  });

  it('asks for JIT to be off before every batched statement, with a fresh setup list each time', () => {
    const { models, database } = setup();
    const plan = createQueryPlan(models, 'ContractSeason', {});
    const first = compileChildrenQuery(models, database, plan, { column: 'serie', ids: [randomUUID()] });
    first.setup.push({ text: 'SET LOCAL work_mem = 64' });
    first.setup[0].text = 'changed';
    expect(compileChildrenQuery(models, database, plan, { column: 'serie', ids: [randomUUID(), randomUUID()] }).setup).toEqual([{ text: JIT_OFF, values: [] }]);
    // compileQuery's per-parent statements, which run as 3.6.0 ran them, have no setup.
    expect(compileQuery(models, database, plan, { column: 'serie', id: randomUUID() })).not.toHaveProperty('setup');
  });

  it('compiles only paginated find plans for a nonempty list of parents of a uuid column', () => {
    const { models, database } = setup();
    const ids = [randomUUID()];
    const find = createQueryPlan(models, 'ContractSeason', {});
    expect(() => compileChildrenQuery(models, database, createQueryPlan(models, 'ContractSeason', {}, { mode: 'count' }), { column: 'serie', ids })).toThrow(code('UNSUPPORTED_QUERY'));
    expect(() => compileChildrenQuery(models, database, createQueryPlan(models, 'ContractSeason', { aggregation: { groupId: 'year', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }] } }, { mode: 'aggregate' }), { column: 'serie', ids })).toThrow(code('UNSUPPORTED_QUERY'));
    expect(() => compileChildrenQuery(models, database, { ...find, pagination: null }, { column: 'serie', ids })).toThrow(code('UNSUPPORTED_QUERY'));
    for (const extra of [{ column: 'serie', ids: [] }, { column: 'serie', ids: ids[0] }, { column: 'serie' }, null]) {
      expect(() => compileChildrenQuery(models, database, find, extra), JSON.stringify(extra)).toThrow(code('UNSUPPORTED_QUERY'));
    }
    expect(() => compileChildrenQuery(models, database, find, { column: 'year', ids })).toThrow(code('UNSUPPORTED_QUERY'));
  });

  it('names parent and row number columns that no column of the child table has', () => {
    const { models, database } = setup();
    const table = database.tables.find((item) => item.name === 'ContractSeason');
    const plan = createQueryPlan(models, 'ContractSeason', {});
    const ids = [randomUUID(), randomUUID()];
    table.columns.push({ name: '__simfinity_parent', type: 'integer' }, { name: '___simfinity_parent', type: 'integer' }, { name: '__simfinity_ordinal', type: 'bigint' });
    const batch = compileChildrenQuery(models, database, plan, { column: 'serie', ids });
    expect(batch.parentColumn).toBe('____simfinity_parent');
    expect(batch.text).toMatch(/^SELECT 1::integer AS "____simfinity_parent", row_number\(\) OVER \(\) AS "___simfinity_ordinal", /);
    expect(batch.text).toMatch(/ UNION ALL SELECT 2::integer AS "____simfinity_parent", row_number\(\) OVER \(\) AS "___simfinity_ordinal", /);
    expect(batch.text.endsWith(' ORDER BY "____simfinity_parent", "___simfinity_ordinal"')).toBe(true);
  });

  it('rejects a description whose names would hide the parent parameter', () => {
    const { models, database } = setup();
    // Identifiers reject NUL characters, so only a hand-built description can put one in a literal.
    const name = models.entities.find((item) => item.name === 'ContractSerie').fields.find((item) => item.name === 'director').fields.find((item) => item.name === 'name');
    name.storageName = 'na\u0000me';
    const plan = createQueryPlan(models, 'ContractSeason', { serie: { terms: [{ path: 'director.name', operator: 'EQ', value: 'Vince' }] } });
    expect(compileQuery(models, database, plan, { column: 'serie', id: randomUUID() }).text).toContain('\u0000');
    expect(() => compileChildrenQuery(models, database, plan, { column: 'serie', ids: [randomUUID()] })).toThrow(code('UNSUPPORTED_QUERY'));
  });

  it('carries the compileQuery it reproduces, which postgresPlugin exposes beside it', () => {
    expect(compileChildrenQuery.compileQuery).toBe(compileQuery);
    expect(Object.getOwnPropertyDescriptor(compileChildrenQuery, 'compileQuery')).toMatchObject({ writable: false, enumerable: false, configurable: false });
    const plugin = postgresPlugin();
    expect([plugin.compileQuery, plugin.compileChildrenQuery]).toEqual([compileQuery, compileChildrenQuery]);
  });
});

describe('PostgreSQL plugin pairing', () => {
  const filtering = (...args) => compileQuery(...args);

  it('binds compileChildrenQuery with the compileQuery it reproduces, also in a copy that changes other members', () => {
    expect(typeof compileChildrenQuery).toBe('function');
    expect(bindPlugin(postgresPlugin()).compileChildrenQuery).toBe(compileChildrenQuery);
    expect(bindPlugin({ ...postgresPlugin(), capabilities: ['transactions'] }).compileChildrenQuery).toBe(compileChildrenQuery);
    expect(bindPlugin({ ...postgresPlugin(), compileQuery }).compileChildrenQuery).toBe(compileChildrenQuery);
  });

  it('drops compileChildrenQuery from a copy whose compileQuery is another function, or that removes it', () => {
    expect(bindPlugin({ ...postgresPlugin(), compileQuery: filtering }).compileChildrenQuery).toBeUndefined();
    expect(bindPlugin({ ...postgresPlugin(), compileChildrenQuery: undefined }).compileChildrenQuery).toBeUndefined();
    // A wrapper that names the overriding compileQuery is paired with it.
    const wrapper = Object.assign((...args) => compileChildrenQuery(...args), { compileQuery: filtering });
    expect(bindPlugin({ ...postgresPlugin(), compileQuery: filtering, compileChildrenQuery: wrapper }).compileChildrenQuery).toBe(wrapper);
  });

  it('rejects a compileChildrenQuery that is not a function', () => {
    for (const value of [null, 'SELECT', {}, 1]) {
      expect(() => bindPlugin({ ...postgresPlugin(), compileChildrenQuery: value }), String(value)).toThrow(code('INVALID_SQL_PLUGIN'));
    }
  });
});

const reference = (connectionField) => ({ relation: { embedded: false, ...(connectionField ? { connectionField } : {}) } });
const fixture = () => {
  // A reference inside the embedded items makes PostgreSQL store the lines of an order in an owned table.
  const Line = new GraphQLObjectType({ name: 'UnitBatchLine', fields: () => ({ label: { type: GraphQLString }, buyer: { type: Author, extensions: reference() } }) });
  const Author = new GraphQLObjectType({
    name: 'UnitBatchAuthor',
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      books: { type: new GraphQLList(Book), extensions: reference('author') },
      orders: { type: new GraphQLList(Order), extensions: reference('customer') },
    }),
  });
  const Book = new GraphQLObjectType({
    name: 'UnitBatchBook',
    fields: () => ({ id: { type: GraphQLID }, title: { type: GraphQLString }, author: { type: Author, extensions: reference() } }),
  });
  const Order = new GraphQLObjectType({
    name: 'UnitBatchOrder',
    fields: () => ({
      id: { type: GraphQLID },
      code: { type: GraphQLString },
      customer: { type: Author, extensions: reference() },
      lines: { type: new GraphQLList(Line), extensions: { relation: { embedded: true } } },
    }),
  });
  return { Line, Author, Book, Order };
};

// A pool that records statements, with the connection that ran each, and answers batched children statements,
// settings, owned-row reads and list reads from in-memory rows, as PostgreSQL would for these fixtures.
const recordingPool = () => {
  const state = { log: [], connects: 0, rows: { UnitBatchAuthor: [], UnitBatchBook: [], UnitBatchOrder: [], UnitBatchOrder__lines: [] }, corrupt: null };
  // `client` is 0 for the pool and otherwise the connection's number since the last reset.
  const respond = async (text, values = [], client = 0) => {
    state.log.push({ text, values, client });
    const table = text.match(/"app"\."([A-Za-z_]+)"/)?.[1];
    if (BATCHED.test(text)) {
      // Each branch returns the rows of its parent parameter with its position.
      const rows = branches(text).flatMap((part) => {
        const position = Number(part.match(/^SELECT (\d+)::integer/)[1]);
        const [, column, index] = [...part.matchAll(/ AND t0\."([a-z]+)" = \$(\d+)::uuid/g)].at(-1);
        return state.rows[table].filter((row) => row[column] === values[index - 1]).map((row, ordinal) => ({ __simfinity_parent: position, __simfinity_ordinal: ordinal + 1, ...row }));
      });
      if (state.corrupt) rows.push({ ...rows[0], __simfinity_parent: state.corrupt.position });
      return { rows };
    }
    if (text.includes('"__owner_id" = ANY')) return { rows: state.rows[table].filter((row) => values[0].includes(row.__owner_id)) };
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text)) return { rows: [], command: text.split(' ')[0] };
    if (text.startsWith('SET LOCAL ')) return { rows: [], command: 'SET' };
    if (text.startsWith('SELECT t0.* FROM')) {
      const parent = text.match(/t0\."([a-z]+)" = \$(\d+)::uuid/);
      return { rows: parent ? state.rows[table].filter((row) => row[parent[1]] === values[parent[2] - 1]) : state.rows[table] };
    }
    throw new Error(`Unexpected statement ${text}`);
  };
  state.pool = {
    connect: async () => {
      state.connects += 1;
      const client = state.connects;
      return { query: (text, values) => respond(text, values, client), release() {} };
    },
    query: (text, values) => respond(text, values),
  };
  state.reset = () => { state.log.length = 0; state.connects = 0; };
  state.texts = () => state.log.map(({ text }) => text);
  state.clients = () => [...new Set(state.log.map(({ client }) => client))];
  return state;
};

const start = async (options = {}, override = (plugin) => plugin, { configure = false } = {}) => {
  const state = recordingPool();
  const configuration = { pool: state.pool, schema: 'app', ...options };
  // Only initialization is replaced, so compileQuery and compileChildrenQuery stay paired.
  const plugin = override({ ...postgresPlugin(configure ? undefined : configuration), initialize: async () => ({ mode: 'validate', created: [] }) });
  const adapter = createSQLAdapter(plugin);
  if (configure) adapter.configure(configuration);
  const api = createRuntime(adapter);
  const types = fixture();
  api.addNoEndpointType(types.Line);
  api.connect(null, types.Author, 'unitbatchauthor', 'unitbatchauthors');
  api.connect(null, types.Book, 'unitbatchbook', 'unitbatchbooks');
  api.connect(null, types.Order, 'unitbatchorder', 'unitbatchorders');
  const before = { findChildrenBatch: adapter.findChildrenBatch, batchesChildren: adapter.batchesChildren };
  const schema = api.createSchema();
  await adapter.initialize();
  const authors = Array.from({ length: 4 }, (_, index) => ({ id: randomUUID(), name: `A${index}` }));
  state.rows.UnitBatchAuthor.push(...authors);
  authors.forEach((author, index) => {
    for (let book = 0; book < index; book += 1) state.rows.UnitBatchBook.push({ id: randomUUID(), title: `B${index}-${book}`, author: author.id });
  });
  const stateColumn = adapter.describeDatabase().tables.find((table) => table.name === 'UnitBatchOrder__lines').ownership.stateColumn;
  for (const author of authors.slice(1)) {
    const order = { id: randomUUID(), code: `O-${author.name}`, customer: author.id, [stateColumn]: 'present' };
    state.rows.UnitBatchOrder.push(order);
    state.rows.UnitBatchOrder__lines.push({ __id: randomUUID(), __owner_id: order.id, __position: 0, __item_present: true, label: `L-${author.name}`, buyer: null });
  }
  state.reset();
  const model = (type) => api.getModel(types[type]);
  return { state, adapter, api, types, schema, before, authors, model };
};

// A children compiler paired with the plugin's compileQuery that returns the given setup instead of its own.
const withSetup = (setup) => (plugin) => ({ ...plugin, compileChildrenQuery: Object.assign((...args) => ({ ...compileChildrenQuery(...args), setup }), { compileQuery }) });
const authorsWithBooks = '{ unitbatchauthors { name books { title } } }';

describe('SQL adapter batched children reads', () => {
  it('defines neither member by default, nor for any batchedCollections value other than true', async () => {
    for (const options of [{}, { batchedCollections: undefined }, { batchedCollections: false }, { batchedCollections: 'true' }, { batchedCollections: 1 }]) {
      for (const configure of [false, true]) {
        const label = `${JSON.stringify(options)}, configure: ${configure}`;
        const { adapter, before } = await start(options, undefined, { configure });
        expect(before, label).toEqual({ findChildrenBatch: undefined, batchesChildren: undefined });
        expect([adapter.findChildrenBatch, adapter.batchesChildren], label).toEqual([undefined, undefined]);
        expect(Object.keys(adapter), label).not.toContain('findChildrenBatch');
        expect(Object.keys(adapter), label).not.toContain('batchesChildren');
      }
    }
  });

  it('defines findChildrenBatch and batchesChildren when the schema is prepared with batchedCollections: true, from the plugin options or configure()', async () => {
    for (const configure of [false, true]) {
      const { adapter, before } = await start(BATCHING, undefined, { configure });
      expect(before).toEqual({ findChildrenBatch: undefined, batchesChildren: undefined });
      expect([typeof adapter.findChildrenBatch, typeof adapter.batchesChildren], `configure: ${configure}`).toEqual(['function', 'function']);
      expect(Object.keys(adapter)).toEqual(expect.arrayContaining(['findChildren', 'findChildrenBatch', 'batchesChildren']));
    }
  });

  it('defines neither member for a plugin whose compileQuery is not the one its compileChildrenQuery reproduces', async () => {
    const same = await start(BATCHING, (plugin) => ({ ...plugin, compileQuery }));
    expect(typeof same.adapter.findChildrenBatch).toBe('function');
    const copy = await start(BATCHING, (plugin) => ({ ...plugin, compileQuery: (...args) => compileQuery(...args) }));
    expect([copy.adapter.findChildrenBatch, copy.adapter.batchesChildren]).toEqual([undefined, undefined]);
    const without = await start(BATCHING, (plugin) => ({ ...plugin, compileChildrenQuery: undefined }));
    expect([without.adapter.findChildrenBatch, without.adapter.batchesChildren]).toEqual([undefined, undefined]);
  });

  it('batches children only while findChildren is the adapter\'s own', async () => {
    const { adapter, model, types } = await start(BATCHING);
    const args = [model('Book'), types.Book, 'author'];
    expect(adapter.batchesChildren(...args)).toBe(true);
    // A copy keeps the adapter's findChildren and reads the same storage.
    const copy = { ...adapter };
    expect(copy.batchesChildren(...args)).toBe(true);
    const override = { ...adapter, findChildren: (...rest) => adapter.findChildren(...rest) };
    expect(override.batchesChildren(...args)).toBe(false);
    const { batchesChildren } = adapter;
    expect(batchesChildren(...args)).toBe(false);
    const findChildren = adapter.findChildren;
    Object.assign(adapter, { findChildren: (...rest) => findChildren(...rest) });
    expect(adapter.batchesChildren(...args)).toBe(false);
    adapter.findChildren = findChildren;
    expect(adapter.batchesChildren(...args)).toBe(true);
  });

  it('reads the children of many parents with one statement, right after SET LOCAL jit = off in one transaction, and returns one fresh list per ID', async () => {
    const { adapter, state, authors, model, types } = await start(BATCHING);
    const ids = [authors[3].id, authors[1].id, authors[3].id.toUpperCase(), authors[0].id, authors[2].id];
    const perParent = [];
    for (const id of ids) perParent.push(await adapter.findChildren(model('Book'), types.Book, 'author', id, {}, null));
    // findChildren still reads each parent with one statement, without a transaction, as 3.6.0 did.
    expect(state.texts()).toEqual(Array(5).fill(expect.stringMatching(/^SELECT t0\.\* FROM "app"\."UnitBatchBook" t0 /)));
    state.reset();
    const lists = await adapter.findChildrenBatch(model('Book'), types.Book, 'author', ids, {}, { context: {} });
    expect(lists).toEqual(perParent);
    expect(lists.map((list) => list.length)).toEqual([3, 1, 3, 0, 2]);
    // Duplicate IDs share their records but not their lists, and no record shows the parent position.
    expect(lists[2]).not.toBe(lists[0]);
    expect(lists[2][0]).toBe(lists[0][0]);
    expect(lists.flat().some((record) => '__simfinity_parent' in record || '__simfinity_ordinal' in record)).toBe(false);
    expect(lists[0][0]).toEqual({ _id: expect.any(String), id: expect.any(String), title: 'B3-0', author: authors[3].id });
    expect(state.texts()).toEqual([BEGIN, JIT_OFF, expect.stringMatching(BATCHED), 'COMMIT']);
    expect(state.log[1].values).toEqual([]);
    // The page, then one parameter per distinct parent.
    expect(state.log[2].values).toEqual([100, 0, authors[3].id, authors[1].id, authors[0].id, authors[2].id]);
    expect([state.connects, state.clients()]).toEqual([1, [1]]);
  });

  it('splits more than 100 distinct parents into statements of 100 in one transaction, each after its setup', async () => {
    const { adapter, state, authors, model, types } = await start(BATCHING);
    // The parents with children come after the first chunk: positions 101, 199, 246 and 250.
    const ids = Array.from({ length: 246 }, () => randomUUID());
    ids.splice(100, 0, authors[1].id);
    ids.splice(198, 0, authors[2].id);
    ids.splice(245, 0, authors[3].id);
    ids.push(authors[0].id);
    const perParent = [];
    for (const id of ids) perParent.push(await adapter.findChildren(model('Book'), types.Book, 'author', id, {}, null));
    state.reset();
    const lists = await adapter.findChildrenBatch(model('Book'), types.Book, 'author', [...ids, ids[100]], {});
    expect(lists).toHaveLength(251);
    expect(lists.slice(0, -1)).toEqual(perParent);
    expect([100, 198, 245, 249].map((index) => lists[index].map((book) => book.author))).toEqual([[authors[1].id], Array(2).fill(authors[2].id), Array(3).fill(authors[3].id), []]);
    expect(lists.at(-1)).toEqual(lists[100]);
    const batched = expect.stringMatching(BATCHED);
    expect(state.texts()).toEqual([BEGIN, JIT_OFF, batched, JIT_OFF, batched, JIT_OFF, batched, 'COMMIT']);
    const statements = state.log.filter(({ text }) => BATCHED.test(text));
    expect(statements.map(({ values }) => values.length - 2)).toEqual([100, 100, 50]);
    expect(statements.flatMap(({ values }) => values.slice(2))).toEqual(ids);
    expect([state.connects, state.clients()]).toEqual([1, [1]]);
  });

  it('hydrates the owned rows of every child with one statement per owned table, in the same transaction', async () => {
    const { adapter, state, authors, model, types } = await start(BATCHING);
    const lists = await adapter.findChildrenBatch(model('Order'), types.Order, 'customer', authors.map((author) => author.id), {});
    expect(lists.map((list) => list.map((order) => [order.code, order.lines.map((line) => line.label)]))).toEqual([
      [], [['O-A1', ['L-A1']]], [['O-A2', ['L-A2']]], [['O-A3', ['L-A3']]],
    ]);
    expect(state.texts()).toEqual([
      BEGIN,
      JIT_OFF,
      expect.stringMatching(BATCHED),
      expect.stringMatching(/^SELECT \* FROM "app"\."UnitBatchOrder__lines" WHERE "__owner_id" = ANY/),
      'COMMIT',
    ]);
    expect(state.log[3].values[0]).toHaveLength(3);
    expect([state.connects, state.clients()]).toEqual([1, [1]]);
  });

  it('runs a plugin\'s setup statements in order before its statement, and a batch without setup as findChildren runs', async () => {
    const custom = await start(BATCHING, withSetup([{ text: 'SET LOCAL a = 1' }, { text: 'SET LOCAL b = 2', values: [] }]));
    const ids = custom.authors.map((author) => author.id);
    expect((await custom.adapter.findChildrenBatch(custom.model('Book'), custom.types.Book, 'author', ids, {})).map((list) => list.length)).toEqual([0, 1, 2, 3]);
    expect(custom.state.texts()).toEqual([BEGIN, 'SET LOCAL a = 1', 'SET LOCAL b = 2', expect.stringMatching(BATCHED), 'COMMIT']);
    expect(custom.state.clients()).toEqual([1]);
    // Without setup, a type without owned tables reads on one connection without a transaction, and one with owned
    // tables in one transaction, as findChildren reads them.
    for (const setup of [undefined, null, []]) {
      const plain = await start(BATCHING, withSetup(setup));
      const parents = plain.authors.map((author) => author.id);
      expect((await plain.adapter.findChildrenBatch(plain.model('Book'), plain.types.Book, 'author', parents, {})).map((list) => list.length), String(setup)).toEqual([0, 1, 2, 3]);
      expect(plain.state.texts(), String(setup)).toEqual([expect.stringMatching(BATCHED)]);
      plain.state.reset();
      await plain.adapter.findChildrenBatch(plain.model('Order'), plain.types.Order, 'customer', parents, {});
      expect(plain.state.texts(), String(setup)).toEqual([BEGIN, expect.stringMatching(BATCHED), expect.stringMatching(/"UnitBatchOrder__lines" WHERE "__owner_id" = ANY/), 'COMMIT']);
    }
  });

  it('fails with a TypeError before taking a connection when setup is not a list of statements', async () => {
    for (const setup of [JIT_OFF, {}, [JIT_OFF], [{ sql: JIT_OFF }], [null]]) {
      const { adapter, state, authors, model, types } = await start(BATCHING, withSetup(setup));
      await expect(adapter.findChildrenBatch(model('Book'), types.Book, 'author', authors.map((author) => author.id), {}), JSON.stringify(setup)).rejects.toThrow(TypeError);
      expect([state.log.length, state.connects]).toEqual([0, 0]);
    }
  });

  it('rejects invalid IDs, models, fields and arguments before taking a connection', async () => {
    const { adapter, state, authors, model, types } = await start(BATCHING);
    const id = authors[1].id;
    const cases = [
      [[model('Book'), types.Book, 'author', [id, 'not-a-uuid'], {}], 'NOT_VALID_ID'],
      [[model('Book'), types.Book, 'author', [id, null], {}], 'NOT_VALID_ID'],
      [[{ name: 'UnitBatchBook' }, types.Book, 'author', [id], {}], 'INVALID_MODEL'],
      [[model('Book'), types.Book, 'title', [id], {}], 'INVALID_MODEL'],
      [[model('Book'), types.Book, 'author', [id, authors[2].id], { pagination: { page: 0, size: 1 } }], 'INVALID_PAGINATION'],
    ];
    for (const [args, expected] of cases) {
      await expect(adapter.findChildrenBatch(...args), expected).rejects.toThrow(code(expected));
    }
    expect(await adapter.findChildrenBatch(model('Book'), types.Book, 'author', [], {})).toEqual([]);
    expect([state.log.length, state.connects]).toEqual([0, 0]);
  });

  it('fails with DATABASE_ERROR, and rolls the transaction back, when a row names no parent of its statement', async () => {
    const { adapter, state, authors, model, types } = await start(BATCHING);
    for (const position of [0, 5, 1.5, null]) {
      state.reset();
      state.corrupt = { position };
      await expect(adapter.findChildrenBatch(model('Book'), types.Book, 'author', authors.map((author) => author.id), {}), String(position))
        .rejects.toThrow(code('DATABASE_ERROR'));
      expect(state.texts()).toEqual([BEGIN, JIT_OFF, expect.stringMatching(BATCHED), 'ROLLBACK']);
    }
  });

  it('reads a generated collection field of every parent with one statement through the runtime', async () => {
    const { state, schema } = await start(BATCHING);
    const result = await graphql({ schema, source: authorsWithBooks, contextValue: {} });
    expect(result.errors).toBeUndefined();
    expect(result.data.unitbatchauthors.map((author) => author.books.length)).toEqual([0, 1, 2, 3]);
    expect(state.texts()).toEqual([expect.stringMatching(/^SELECT t0\.\* FROM "app"\."UnitBatchAuthor" /), BEGIN, JIT_OFF, expect.stringMatching(BATCHED), 'COMMIT']);
    expect(state.connects).toBe(2);
  });

  it('reads each parent alone, and reports it once, when a plugin returns setup that is not a list of statements', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { state, schema } = await start(BATCHING, withSetup(JIT_OFF));
      const result = await graphql({ schema, source: authorsWithBooks, contextValue: {} });
      expect(result.errors).toBeUndefined();
      expect(result.data.unitbatchauthors.map((author) => author.books.length)).toEqual([0, 1, 2, 3]);
      expect(state.texts()).toEqual([expect.stringMatching(/^SELECT t0\.\* FROM "app"\."UnitBatchAuthor" /), ...Array(4).fill(expect.stringMatching(/^SELECT t0\.\* FROM "app"\."UnitBatchBook" t0 /))]);
      expect(warn.mock.calls.map(([message]) => message)).toEqual([expect.stringContaining('setup that is not a list of statements')]);
    } finally {
      warn.mockRestore();
    }
  });

  it('sends 3.6.0\'s statements by default and with batchedCollections: false: one per field, each on its own connection', async () => {
    // compileQuery's per-parent statement for a field without arguments, unchanged since 3.6.0.
    const perParent = 'SELECT t0.* FROM "app"."UnitBatchBook" t0  WHERE TRUE AND t0."author" = $1::uuid LIMIT $2::bigint OFFSET $3::bigint';
    for (const options of [{}, { batchedCollections: false }]) {
      const { state, schema, authors } = await start(options);
      const result = await graphql({ schema, source: authorsWithBooks, contextValue: {} });
      expect(result.errors).toBeUndefined();
      expect(result.data.unitbatchauthors.map((author) => author.books.length)).toEqual([0, 1, 2, 3]);
      expect(state.texts()[0]).toMatch(/^SELECT t0\.\* FROM "app"\."UnitBatchAuthor" /);
      const byParent = (a, b) => String(a.values[0]).localeCompare(String(b.values[0]));
      expect(state.log.slice(1).map(({ text, values }) => ({ text, values })).sort(byParent))
        .toEqual(authors.map((author) => ({ text: perParent, values: [author.id, 100, 0] })).sort(byParent));
      expect([state.connects, state.clients().length]).toEqual([5, 5]);
      expect(state.texts().filter((text) => /^(BEGIN|SET|COMMIT)\b/.test(text))).toEqual([]);
    }
  });
});
