import { randomUUID } from 'node:crypto';
import {
  afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi,
} from 'vitest';
import {
  GraphQLID, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';
import pg from 'pg';
import { configureQueryLimits, createRuntime } from '../../packages/core/src/index.js';
import { createSQLAdapter } from '../../packages/sql/src/adapter.js';
import { postgresPlugin } from '../../packages/postgres/src/index.js';
import { compileQuery } from '../../packages/postgres/src/query/compiler.js';
import { generateMCPTools } from '../../packages/mcp/src/index.js';

// Batched collection reads on PostgreSQL (#165), which are opt-in. Four runtimes share one schema and one recording
// pool:
// - batched: `batchedCollections: true`, which reads the collection fields of many parents with one statement, a
//   UNION ALL of each parent's own statement with its own parent parameter, in a transaction that first runs
//   `SET LOCAL jit = off`;
// - defaults: no option, which sends 3.6.0's statement per field;
// - perParent: `batchedCollections: false`, the same as the default;
// - hiding: a plugin copy whose compileQuery hides secret books, so batching is off and its filter applies.
// Each parent must get exactly its per-parent rows. PostgreSQL plans each branch for its own parent's ID, as it plans
// that parent's own statement, so on these fixtures even unsorted rows and rows with equal sort keys come in the same
// order, including on a table where one parent holds most rows after HOT updates, which a statement planned once for
// every parent returned in another order. PostgreSQL does not promise that order, so the documentation still
// recommends sorts that end in a unique field.

const uri = process.env.SIMFINITY_POSTGRES_URI;
const reference = (connectionField) => ({ relation: { embedded: false, ...(connectionField ? { connectionField } : {}) } });
const BATCHED = /^SELECT 1::integer AS "__simfinity_parent", row_number\(\) OVER \(\) AS "__simfinity_ordinal", simfinity_children\.\* FROM \(SELECT t0\.\* FROM /;
const BEGIN = 'BEGIN ISOLATION LEVEL REPEATABLE READ';
const JIT_OFF = 'SET LOCAL jit = off';
// Plan nodes, depth first.
const nodes = (node) => [node, ...(node.Plans || []).flatMap(nodes)];
const explain = async (pool, { text, values }) => (await pool.query(`EXPLAIN (FORMAT JSON) ${text}`, values)).rows[0]['QUERY PLAN'][0].Plan;
const access = (node) => `${node['Node Type']}${node['Index Name'] ? ` using ${node['Index Name']}` : ''}`;

const fixture = () => {
  // A find scope on the publisher becomes a joined scope of book filters through `publisher`.
  const Publisher = new GraphQLObjectType({
    name: 'PgcbPublisher',
    extensions: { scope: { find: async ({ args, context }) => { if (context?.hidePublisher) args.name = { operator: 'NE', value: context.hidePublisher }; } } },
    fields: { id: { type: GraphQLID }, name: { type: GraphQLString } },
  });
  // A reference inside the embedded items makes PostgreSQL store the lines of an order in an owned table.
  const Line = new GraphQLObjectType({ name: 'PgcbLine', fields: () => ({ label: { type: GraphQLString }, publisher: { type: Publisher, extensions: reference() } }) });
  const Author = new GraphQLObjectType({
    name: 'PgcbAuthor',
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      books: { type: new GraphQLList(Book), extensions: reference('author') },
      orders: { type: new GraphQLList(Order), extensions: reference('customer') },
    }),
  });
  const Book = new GraphQLObjectType({
    name: 'PgcbBook',
    extensions: { scope: { find: async ({ args, context }) => { if (context?.tenant) args.tenant = { operator: 'EQ', value: context.tenant }; } } },
    fields: () => ({
      id: { type: GraphQLID },
      title: { type: GraphQLString },
      year: { type: GraphQLInt },
      tag: { type: GraphQLString },
      tenant: { type: GraphQLString },
      secret: { type: GraphQLString, extensions: { queryable: false } },
      author: { type: Author, extensions: reference() },
      publisher: { type: Publisher, extensions: reference() },
      chapters: { type: new GraphQLList(Chapter), extensions: reference('book') },
    }),
  });
  const Chapter = new GraphQLObjectType({ name: 'PgcbChapter', fields: () => ({ id: { type: GraphQLID }, title: { type: GraphQLString }, book: { type: Book, extensions: reference() } }) });
  const Order = new GraphQLObjectType({
    name: 'PgcbOrder',
    fields: () => ({
      id: { type: GraphQLID },
      code: { type: GraphQLString },
      customer: { type: Author, extensions: reference() },
      lines: { type: new GraphQLList(Line), extensions: { relation: { embedded: true } } },
    }),
  });
  // The skewed fixture: one parent holds most rows, and `category`, a required scalar ID, has a generated index
  // whose sort omits the NULLS clause, so a parent's own plan can walk it.
  const HotAuthor = new GraphQLObjectType({
    name: 'PgcbHotAuthor',
    fields: () => ({ id: { type: GraphQLID }, name: { type: GraphQLString }, books: { type: new GraphQLList(HotBook), extensions: reference('author') } }),
  });
  const HotBook = new GraphQLObjectType({
    name: 'PgcbHotBook',
    fields: () => ({
      id: { type: GraphQLID },
      title: { type: GraphQLString },
      n: { type: GraphQLInt },
      category: { type: new GraphQLNonNull(GraphQLID) },
      author: { type: HotAuthor, extensions: reference() },
    }),
  });
  // Skewed connection statistics: a few parents hold almost every row.
  const SkewAuthor = new GraphQLObjectType({
    name: 'PgcbSkewAuthor',
    fields: () => ({ id: { type: GraphQLID }, name: { type: GraphQLString }, books: { type: new GraphQLList(SkewBook), extensions: reference('author') } }),
  });
  const SkewBook = new GraphQLObjectType({
    name: 'PgcbSkewBook',
    fields: () => ({ id: { type: GraphQLID }, title: { type: GraphQLString }, author: { type: SkewAuthor, extensions: reference() } }),
  });
  // Many parents with many children each: the batch's plan costs more than jit_above_cost, no parent's own plan does.
  const JitAuthor = new GraphQLObjectType({
    name: 'PgcbJitAuthor',
    fields: () => ({ id: { type: GraphQLID }, name: { type: GraphQLString }, books: { type: new GraphQLList(JitBook), extensions: reference('author') } }),
  });
  const JitBook = new GraphQLObjectType({
    name: 'PgcbJitBook',
    fields: () => ({ id: { type: GraphQLID }, title: { type: GraphQLString }, author: { type: JitAuthor, extensions: reference() } }),
  });
  return { Publisher, Line, Author, Book, Chapter, Order, HotAuthor, HotBook, SkewAuthor, SkewBook, JitAuthor, JitBook };
};

describe.skipIf(!uri)('PostgreSQL batched collection reads (#165)', () => {
  const namespace = `pgcb_${randomUUID().replaceAll('-', '')}`;
  const t = (name) => `"${namespace}"."${name}"`;
  let pool; let log; let connects; let poison; let runtimes; let authors; let probes;
  // Records every statement with the connection that ran it, numbered since the last reset (0 for the pool); a
  // statement on the book table whose values hold the poisoned parent ID fails. With `probes`, it also records each
  // connection's jit setting right after a batched statement and when it goes back to the pool.
  const showJit = async (client) => (await client.query('SHOW jit')).rows[0].jit;
  const run = async (target, text, values, client = 0) => {
    const statement = typeof text === 'string' ? text : text.text;
    log.push({ text: statement, values, client });
    if (poison && statement.includes(`${t('PgcbBook')} t0`) && (values || []).flat().includes(poison)) {
      throw Object.assign(new Error('injected failure'), { code: 'XX000', severity: 'ERROR' });
    }
    const result = await target.query(text, values);
    if (probes && client && BATCHED.test(statement)) probes.push({ client, after: 'batch', jit: await showJit(target) });
    return result;
  };
  const wrapped = {
    connect: async () => {
      connects += 1;
      const id = connects;
      const client = await pool.connect();
      return {
        query: (text, values) => run(client, text, values, id),
        release: async (error) => {
          if (probes && !error) probes.push({ client: id, after: 'release', jit: await showJit(client) });
          client.release(error);
        },
      };
    },
    query: (text, values) => run(pool, text, values),
  };
  const reset = () => { log.length = 0; connects = 0; };
  const texts = () => log.map((entry) => entry.text);
  const batchedStatements = () => texts().filter((text) => BATCHED.test(text));
  // Per-parent reads of a collection, which carry the parent as a uuid parameter.
  const perParentStatements = (table, column) => texts().filter((text) => text.startsWith(`SELECT t0.* FROM ${t(table)} t0 `) && text.includes(` AND t0."${column}" = $`));
  const transactions = () => texts().filter((text) => /^(BEGIN|COMMIT|ROLLBACK)\b/.test(text));

  const start = async (name, options = {}, override = (plugin) => plugin) => {
    const types = fixture();
    const adapter = createSQLAdapter(override(postgresPlugin({ pool: wrapped, schema: namespace, ...options })));
    const api = createRuntime(adapter);
    api.addNoEndpointType(types.Line);
    api.connect(null, types.Publisher, 'pgcbpublisher', 'pgcbpublishers');
    api.connect(null, types.Author, 'pgcbauthor', 'pgcbauthors');
    api.connect(null, types.Book, 'pgcbbook', 'pgcbbooks');
    api.connect(null, types.Chapter, 'pgcbchapter', 'pgcbchapters');
    api.connect(null, types.Order, 'pgcborder', 'pgcborders');
    api.connect(null, types.HotAuthor, 'pgcbhotauthor', 'pgcbhotauthors');
    api.connect(null, types.HotBook, 'pgcbhotbook', 'pgcbhotbooks');
    api.connect(null, types.SkewAuthor, 'pgcbskewauthor', 'pgcbskewauthors');
    api.connect(null, types.SkewBook, 'pgcbskewbook', 'pgcbskewbooks');
    api.connect(null, types.JitAuthor, 'pgcbjitauthor', 'pgcbjitauthors');
    api.connect(null, types.JitBook, 'pgcbjitbook', 'pgcbjitbooks');
    const runtime = { name, adapter, api, types, middleware: 0 };
    api.use(async (params, next) => {
      if (params.operation === 'find' && /^Pgcb(Hot)?Book$/.test(params.type?.gqltype?.name)) runtime.middleware += 1;
      await next();
    });
    runtime.schema = api.createSchema();
    await adapter.initialize(name === 'batched' ? undefined : { mode: 'validate' });
    // Spying on findChildrenBatch keeps batching; findChildren is counted from the statements, because replacing
    // it turns batching off.
    if (adapter.findChildrenBatch) runtime.findChildrenBatch = vi.spyOn(adapter, 'findChildrenBatch');
    return runtime;
  };
  const execute = async (runtime, source, contextValue = {}) => {
    reset();
    runtime.middleware = 0;
    const result = await graphql({ schema: runtime.schema, source, contextValue });
    // Error timestamps have one-second resolution, so two runs can straddle a second.
    const stable = JSON.parse(JSON.stringify(result, (key, value) => (key === 'timestamp' ? undefined : value)));
    return { result: stable, statements: texts(), connects, middleware: runtime.middleware };
  };
  // The same request with per-parent reads (3.6.0) and with batched reads.
  const compare = async (source, contextValue = {}) => {
    const expected = await execute(runtimes.perParent, source, { ...contextValue });
    const actual = await execute(runtimes.batched, source, { ...contextValue });
    expect(actual.middleware, source).toBe(expected.middleware);
    return { expected, actual };
  };
  // Each parent's rows, in the same order, parent by parent.
  const expectSameChildren = (expected, actual, { root, field }) => {
    expect(actual.result.errors).toEqual(expected.result.errors);
    const before = expected.result.data[root];
    const after = actual.result.data[root];
    expect(after.map((parent) => parent.name)).toEqual(before.map((parent) => parent.name));
    before.forEach((parent, index) => expect(after[index][field], parent.name).toEqual(parent[field]));
    expect(actual.result).toEqual(expected.result);
  };

  beforeAll(async () => {
    log = [];
    connects = 0;
    pool = new pg.Pool({ connectionString: uri });
    runtimes = {};
    runtimes.batched = await start('batched', { batchedCollections: true });
    runtimes.defaults = await start('defaults');
    runtimes.perParent = await start('perParent', { batchedCollections: false });
    runtimes.hiding = await start('hiding', { batchedCollections: true }, (plugin) => ({
      ...plugin,
      // Hides the secret books of every find, as a tenant or soft-delete filter would.
      compileQuery: (models, description, plan, extra, configuration) => compileQuery(models, description, plan.entity === 'PgcbBook'
        ? { ...plan, where: { kind: 'and', terms: [plan.where, { kind: 'predicate', path: ['tenant'], operator: 'NE', value: 'secret' }].filter(Boolean) } }
        : plan, extra, configuration),
    }));
    await pool.query(`INSERT INTO ${t('PgcbPublisher')} (name) SELECT 'P' || g FROM generate_series(0, 2) g`);
    await pool.query(`INSERT INTO ${t('PgcbAuthor')} (name) SELECT 'A' || lpad(g::text, 2, '0') FROM generate_series(0, 11) g`);
    // A00 has 105 books, above the default page size, A01..A10 have 6 each and A11 none; titles and years tie.
    await pool.query(`WITH a AS (SELECT id, row_number() OVER (ORDER BY name) - 1 AS n FROM ${t('PgcbAuthor')}), p AS (SELECT id, row_number() OVER (ORDER BY name) - 1 AS n FROM ${t('PgcbPublisher')})
      INSERT INTO ${t('PgcbBook')} (title, year, tag, tenant, secret, author, publisher)
      SELECT 'T' || (g % 4), 2000 + g % 3, CASE WHEN g % 2 = 1 THEN 'odd' ELSE 'even' END, CASE WHEN g % 5 = 0 THEN 'secret' WHEN g % 5 < 3 THEN 't1' ELSE 't2' END, 's', a.id, p.id
      FROM generate_series(0, 164) g JOIN a ON a.n = CASE WHEN g < 60 THEN 1 + g % 10 ELSE 0 END JOIN p ON p.n = g % 3`);
    await pool.query(`INSERT INTO ${t('PgcbChapter')} (title, book) SELECT 'C' || n, b.id FROM ${t('PgcbBook')} b CROSS JOIN generate_series(1, 2) n`);
    await pool.query(`ANALYZE ${t('PgcbBook')}`);
    authors = (await pool.query(`SELECT id, name FROM ${t('PgcbAuthor')} ORDER BY name`)).rows;
    const publishers = (await pool.query(`SELECT id FROM ${t('PgcbPublisher')} ORDER BY name`)).rows.map((row) => row.id);
    const orders = runtimes.batched.api.getModel(runtimes.batched.types.Order);
    for (const [index, author] of authors.slice(0, 10).entries()) {
      await orders.create({ code: `O${index}a`, customer: author.id, lines: [{ label: 'x', publisher: { id: publishers[index % 3] } }, { label: 'y' }] });
      await orders.create({ code: `O${index}b`, customer: author.id, lines: [] });
    }
  }, 60000);
  beforeEach(() => { poison = null; probes = null; });
  afterEach(() => {
    configureQueryLimits();
    for (const runtime of Object.values(runtimes || {})) runtime.findChildrenBatch?.mockClear();
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await pool.end();
    }
  });

  const authorsQuery = (field) => `{ pgcbauthors(sort: { terms: [{ field: "name", order: ASC }] }) { name ${field} } }`;

  it('reads a referenced collection of every parent with one statement, in one transaction after SET LOCAL jit = off', async () => {
    const { batched, perParent } = runtimes;
    expect([typeof batched.adapter.findChildrenBatch, typeof batched.adapter.batchesChildren]).toEqual(['function', 'function']);
    const { expected, actual } = await compare(authorsQuery('books(sort: { terms: [{ field: "title", order: ASC }, { field: "id", order: ASC }] }) { id title year }'));
    expect(actual.result).toEqual(expected.result);
    expect(actual.result.data.pgcbauthors.map((author) => author.books.length)).toEqual([100, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 0]);
    // 3.6.0: the list and one statement per author, each on its own connection; middleware runs per field.
    expect(perParent.adapter.findChildrenBatch).toBeUndefined();
    expect(expected.statements).toHaveLength(13);
    expect(expected.connects).toBe(13);
    // Batched: the list, then one statement for the 12 authors in a transaction on one connection, right after
    // SET LOCAL jit = off; middleware still runs per field.
    expect(actual.statements).toEqual([expect.stringMatching(new RegExp(`^SELECT t0\\.\\* FROM ${t('PgcbAuthor').replace(/[.$"]/g, '\\$&')} `)), BEGIN, JIT_OFF, expect.stringMatching(BATCHED), 'COMMIT']);
    expect(actual.connects).toBe(2);
    expect(log.map((entry) => entry.client)).toEqual([1, 2, 2, 2, 2]);
    expect(actual.middleware).toBe(12);
    expect(batched.findChildrenBatch.mock.calls.map((call) => [call[2], call[3].length])).toEqual([['author', 12]]);
    // The page every branch shares, then one parameter per author.
    expect(log[3].values).toEqual([100, 0, ...authors.map((author) => author.id)]);
  });

  it('sends exactly the statements of batchedCollections: false, 3.6.0\'s, by default', async () => {
    const { defaults, perParent } = runtimes;
    expect([defaults.adapter.findChildrenBatch, defaults.adapter.batchesChildren]).toEqual([undefined, undefined]);
    // Concurrent fields can take their connections in another order, so the statements are compared as sets.
    const sent = () => log.map(({ text, values }) => JSON.stringify([text, values])).sort();
    for (const field of [
      'books(sort: { terms: [{ field: "title", order: ASC }, { field: "id", order: ASC }] }) { id title }',
      'orders(sort: { terms: [{ field: "code", order: ASC }] }) { code lines { label } }',
      'books(sort: { terms: [{ field: "id", order: ASC }] }) { id chapters(sort: { terms: [{ field: "id", order: ASC }] }) { title } }',
    ]) {
      const source = authorsQuery(field);
      const expected = await execute(perParent, source);
      const statements = sent();
      const actual = await execute(defaults, source);
      expect(actual.result, field).toEqual(expected.result);
      expect(sent(), field).toEqual(statements);
      expect(actual.connects, field).toBe(expected.connects);
      expect(actual.statements.filter((text) => BATCHED.test(text) || text.startsWith('SET ')), field).toEqual([]);
    }
    // One statement per author's books field, with the list: 3.6.0's 13.
    expect((await execute(defaults, authorsQuery('books { id }'))).statements).toHaveLength(13);
  });

  it('returns the rows of each parent together, in parent position order, each in its statement\'s order', async () => {
    await execute(runtimes.batched, authorsQuery('books { id }'));
    const [statement] = log.filter((entry) => BATCHED.test(entry.text));
    const { rows } = await pool.query(statement.text, statement.values);
    const positions = rows.map((row) => row.__simfinity_parent);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(new Set(positions)).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]));
    // Row numbers count each parent's rows in the order its own statement returns them.
    for (const position of new Set(positions)) {
      const ordinals = rows.filter((row) => row.__simfinity_parent === position).map((row) => Number(row.__simfinity_ordinal));
      expect(ordinals).toEqual(ordinals.map((value, index) => index + 1));
    }
  });

  it('hydrates the owned rows of every child in the batch\'s repeatable-read transaction', async () => {
    const { expected, actual } = await compare(authorsQuery('orders(sort: { terms: [{ field: "code", order: ASC }] }) { code lines { label publisher { name } } }'));
    expect(actual.result).toEqual(expected.result);
    expect(actual.result.data.pgcbauthors[0].orders).toEqual([
      { code: 'O0a', lines: [{ label: 'x', publisher: { name: 'P0' } }, { label: 'y', publisher: null }] },
      { code: 'O0b', lines: [] },
    ]);
    // 3.6.0: BEGIN, SELECT, owned lines and COMMIT for each author.
    expect(expected.statements.filter((text) => text.startsWith('BEGIN'))).toHaveLength(12);
    expect(actual.statements).toEqual([
      expect.stringMatching(/^SELECT /),
      BEGIN,
      JIT_OFF,
      expect.stringMatching(BATCHED),
      expect.stringMatching(new RegExp(`^SELECT \\* FROM "${namespace}"\\."PgcbOrder__lines" WHERE "__owner_id" = ANY`)),
      'COMMIT',
      expect.stringMatching(new RegExp(`^SELECT t0\\.\\* FROM "${namespace}"\\."PgcbPublisher" t0 `)),
    ]);
    // One connection runs the whole transaction.
    expect(new Set(log.slice(1, 6).map((entry) => entry.client)).size).toBe(1);
  });

  const books = (result) => result.data.pgcbauthors.flatMap((author) => author.books);
  it.each([
    ['unsorted rows', 'books { id title }', {}, (result) => expect(books(result)).toHaveLength(160)],
    ['a sort with ties', 'books(sort: { terms: [{ field: "title", order: DESC }] }) { id title }', {},
      (result) => expect(result.data.pgcbauthors[1].books.map((book) => book.title)).toEqual(['T2', 'T2', 'T2', 'T0', 'T0', 'T0'])],
    ['a page of a total order', 'books(sort: { terms: [{ field: "year", order: ASC }, { field: "id", order: DESC }] }, pagination: { page: 2, size: 3 }) { id year }', {},
      (result) => expect(result.data.pgcbauthors.map((author) => author.books.length)).toEqual([3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 0])],
    ['scalar filters', 'books(year: { operator: IN, value: [2001, 2002] }, title: { operator: LIKE, value: "1" }) { id title year }', {},
      (result) => expect(books(result).every((book) => book.title === 'T1' && book.year > 2000)).toBe(true)],
    ['AND/OR groups', 'books(OR: [{ conditions: [{ field: "tag", operator: EQ, value: "odd" }] }, { AND: [{ conditions: [{ field: "year", operator: LT, value: 2001 }] }] }]) { id tag year }', {},
      (result) => expect(books(result).every((book) => book.tag === 'odd' || book.year === 2000)).toBe(true)],
    ['a relationship filter', 'books(publisher: { terms: [{ path: "name", operator: IN, value: ["P0", "P2"] }] }) { id publisher { name } }', {},
      (result) => expect(new Set(books(result).map((book) => book.publisher.name))).toEqual(new Set(['P0', 'P2']))],
    ['a relationship sort ending in id', 'books(sort: { terms: [{ field: "publisher.name", order: DESC }, { field: "id", order: ASC }] }, pagination: { page: 2, size: 4 }) { id publisher { name } }', {},
      (result) => expect(result.data.pgcbauthors[0].books.map((book) => book.publisher.name)).toEqual(['P2', 'P2', 'P2', 'P2'])],
    ['a filter through the children\'s own collection', 'books(chapters: { terms: [{ path: "title", operator: IN, value: ["C1", "C2"] }] }, sort: { terms: [{ field: "id", order: ASC }] }) { id }', {},
      (result) => expect(result.data.pgcbauthors[1].books).toHaveLength(12)],
    ['a find scope', 'books(sort: { terms: [{ field: "id", order: ASC }] }) { id tenant }', { tenant: 't1' },
      (result) => expect(new Set(books(result).map((book) => book.tenant))).toEqual(new Set(['t1']))],
    ['a joined scope', 'books(publisher: { terms: [{ path: "name", operator: NE, value: "P1" }] }) { id publisher { name } }', { hidePublisher: 'P0' },
      (result) => expect(new Set(books(result).map((book) => book.publisher.name))).toEqual(new Set(['P2']))],
  ])('returns each parent\'s per-parent rows for %s', async (label, field, contextValue, check) => {
    const { expected, actual } = await compare(authorsQuery(field), contextValue);
    expect(actual.result.errors).toBeUndefined();
    check(actual.result);
    expectSameChildren(expected, actual, { root: 'pgcbauthors', field: 'books' });
    expect(perParentStatements('PgcbBook', 'author')).toEqual([]);
    expect(batchedStatements()).toHaveLength(1);
    expect(runtimes.batched.findChildrenBatch).toHaveBeenCalledTimes(1);
  });

  it('fails every field alike for arguments that fail per parent, without a batch', async () => {
    // A path check fails in the resolver, before middleware and any read.
    const forbidden = await compare(authorsQuery('books(secret: { operator: EQ, value: "s" }) { id }'));
    expect(forbidden.actual.result).toEqual(forbidden.expected.result);
    expect(forbidden.actual.result.errors.map((error) => error.extensions.code)).toEqual(Array(12).fill('FORBIDDEN_FILTER_PATH'));
    // Invalid pagination reads each field alone, which reports it before any statement, as before.
    const invalid = await compare(authorsQuery('books(pagination: { page: 0, size: 2 }) { id }'));
    expect(invalid.actual.result).toEqual(invalid.expected.result);
    expect(invalid.actual.result.errors.map((error) => error.extensions.code)).toEqual(Array(12).fill('INVALID_PAGINATION'));
    expect(invalid.actual.statements).toHaveLength(1);
    expect(runtimes.batched.findChildrenBatch).not.toHaveBeenCalled();
  });

  it('applies the configured maximum page size to each parent and reads each level with one statement', async () => {
    configureQueryLimits({ maxPageSize: 5 });
    const source = authorsQuery('books(sort: { terms: [{ field: "id", order: ASC }] }) { id chapters(sort: { terms: [{ field: "id", order: ASC }] }) { title } }');
    const { expected, actual } = await compare(source);
    expect(actual.result).toEqual(expected.result);
    expect(actual.result.data.pgcbauthors.map((author) => author.books.length)).toEqual([5, 5, 5, 5, 5]);
    // 5 authors, then 25 books: 31 statements per parent; batched, the list and two transactions of BEGIN, SET LOCAL,
    // one statement and COMMIT (the chunk size does not follow maxPageSize).
    expect(runtimes.batched.findChildrenBatch.mock.calls.map((call) => call[3].length)).toEqual([5, 25]);
    expect([expected.statements.length, actual.statements.length]).toEqual([31, 9]);
    expect(batchedStatements()).toHaveLength(2);
    const rejected = await compare(authorsQuery('books(pagination: { page: 1, size: 6 }) { id }'));
    expect(rejected.actual.result).toEqual(rejected.expected.result);
    expect(rejected.actual.result.errors.map((error) => error.extensions.code)).toEqual(Array(5).fill('INVALID_PAGINATION'));
  });

  it('reads each parent alone after a failed batch, so an error fails only the fields it fails per parent', async () => {
    const warn = vi.spyOn(console, 'warn');
    try {
      poison = authors[3].id;
      const { expected, actual } = await compare(authorsQuery('books(sort: { terms: [{ field: "id", order: ASC }] }) { id }'));
      expect(actual.result).toEqual(expected.result);
      expect(actual.result.errors.map((error) => [error.path.join('.'), error.extensions.code])).toEqual([['pgcbauthors.3.books', 'DATABASE_ERROR']]);
      expect(actual.result.data.pgcbauthors[2].books).toHaveLength(6);
      expect(runtimes.batched.findChildrenBatch).toHaveBeenCalledTimes(1);
      expect(batchedStatements()).toHaveLength(1);
      // The failed batch's transaction rolls back on its connection. Each parent is then read alone without a
      // transaction, and the failed read of the poisoned parent probes its connection with ROLLBACK, as 3.6.0's does.
      expect(transactions()).toEqual([BEGIN, 'ROLLBACK', 'ROLLBACK']);
      const [begin, rollback] = log.filter((entry) => /^(BEGIN|ROLLBACK)\b/.test(entry.text));
      expect(rollback.client).toBe(begin.client);
      expect(expected.statements.filter((text) => /^(BEGIN|COMMIT|ROLLBACK)\b/.test(text))).toEqual(['ROLLBACK']);
      expect(perParentStatements('PgcbBook', 'author')).toHaveLength(12);
      // A database error is a SimfinityError, so the fallback is not reported as a configuration issue.
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('reads a parent shared by several fields once, and with batchedCollections: false once per field, as 3.6.0', async () => {
    // The six books of A01 share one author record, whose books field resolves six times with the same arguments.
    const source = '{ pgcbbooks(author: { terms: [{ path: "name", operator: EQ, value: "A01" }] }, sort: { terms: [{ field: "id", order: ASC }] }) { id author { name books(sort: { terms: [{ field: "id", order: ASC }] }) { id } } } }';
    const { expected, actual } = await compare(source);
    expect(actual.result).toEqual(expected.result);
    const lists = actual.result.data.pgcbbooks.map((book) => book.author.books);
    expect(lists).toHaveLength(6);
    expect(new Set(lists.map((list) => JSON.stringify(list))).size).toBe(1);
    // Batched: the list, the author read and one per-parent read of the single distinct parent, shared by six fields.
    expect(runtimes.batched.findChildrenBatch).not.toHaveBeenCalled();
    expect(actual.statements).toHaveLength(3);
    expect(perParentStatements('PgcbBook', 'author')).toHaveLength(1);
    // The opt-out sends 3.6.0's statements: one per field.
    expect(expected.statements).toHaveLength(8);
    reset();
    const aliases = await compare(authorsQuery('odd: books(tag: { operator: EQ, value: "odd" }) { id } even: books(tag: { operator: EQ, value: "even" }) { id } again: books(tag: { operator: EQ, value: "odd" }) { id }'));
    expect(aliases.actual.result.data.pgcbauthors.map((author) => author.again)).toEqual(aliases.actual.result.data.pgcbauthors.map((author) => author.odd));
    expectSameChildren(aliases.expected, aliases.actual, { root: 'pgcbauthors', field: 'odd' });
    expectSameChildren(aliases.expected, aliases.actual, { root: 'pgcbauthors', field: 'even' });
    // Fields with equal arguments share a batch; each other argument set has its own transaction.
    expect([aliases.expected.statements.length, aliases.actual.statements.length]).toEqual([37, 9]);
    expect(batchedStatements()).toHaveLength(2);
    expect(runtimes.batched.findChildrenBatch).toHaveBeenCalledTimes(2);
  });

  it('returns per-parent results from the adapter for duplicate, empty, missing and uppercase parent IDs', async () => {
    const { batched } = runtimes;
    const model = batched.api.getModel(batched.types.Book);
    const ids = [authors[1].id, authors[1].id, authors[11].id, randomUUID(), authors[0].id.toUpperCase(), authors[2].id];
    const args = { sort: { terms: [{ field: 'id', order: 'DESC' }] }, pagination: { page: 1, size: 50 } };
    const perParent = [];
    for (const id of ids) perParent.push(await batched.adapter.findChildren(model, batched.types.Book, 'author', id, structuredClone(args), null));
    reset();
    const lists = await batched.adapter.findChildrenBatch(model, batched.types.Book, 'author', ids, structuredClone(args));
    expect(lists).toEqual(perParent);
    expect(lists.map((list) => list.length)).toEqual([6, 6, 0, 0, 50, 6]);
    expect(texts()).toEqual([BEGIN, JIT_OFF, expect.stringMatching(BATCHED), 'COMMIT']);
    expect(log[2].values).toEqual([50, 0, authors[1].id, authors[11].id, ids[3], authors[0].id, authors[2].id]);
    // A malformed or null parent ID rejects the batch before any statement; findChildren reports the same error.
    for (const bad of ['not-a-uuid', null]) {
      reset();
      await expect(batched.adapter.findChildrenBatch(model, batched.types.Book, 'author', [authors[1].id, bad], {})).rejects.toMatchObject({ extensions: { code: 'NOT_VALID_ID' } });
      expect([log.length, connects]).toEqual([0, 0]);
      await expect(batched.adapter.findChildren(model, batched.types.Book, 'author', bad, {}, null)).rejects.toMatchObject({ extensions: { code: 'NOT_VALID_ID' } });
    }
  });

  it('sends at most 100 parents per statement', async () => {
    const { batched } = runtimes;
    const model = batched.api.getModel(batched.types.Book);
    // The authors sit at positions 96, 109, ..., 239, so most of them, with their books, are in the second and third
    // statements, and each row must find its parent through its statement's offset.
    const ids = Array.from({ length: 238 }, () => randomUUID());
    authors.forEach((author, index) => ids.splice(95 + index * 13, 0, author.id));
    const args = { sort: { terms: [{ field: 'id', order: 'ASC' }] } };
    const perParent = await Promise.all(ids.map((id) => batched.adapter.findChildren(model, batched.types.Book, 'author', id, structuredClone(args), null)));
    expect(perParent.filter((list) => list.length).length).toBe(11);
    reset();
    expect(await batched.adapter.findChildrenBatch(model, batched.types.Book, 'author', ids, structuredClone(args))).toEqual(perParent);
    // One transaction; each statement runs right after its setup and has the page, then one parameter per parent.
    expect(texts()).toEqual([BEGIN, ...Array(3).fill([JIT_OFF, expect.stringMatching(BATCHED)]).flat(), 'COMMIT']);
    const statements = log.filter((entry) => BATCHED.test(entry.text));
    expect(statements.map((entry) => entry.values.length - 2)).toEqual([100, 100, 50]);
    expect(statements.flatMap((entry) => entry.values.slice(2))).toEqual(ids);
    expect(connects).toBe(1);
    batched.findChildrenBatch.mockClear();
    // Through the runtime: 205 hot authors are read in batches of 100, 100 and 5 parents.
    await pool.query(`INSERT INTO ${t('PgcbHotAuthor')} (name) SELECT 'X' || lpad(g::text, 3, '0') FROM generate_series(0, 204) g`);
    try {
      const { expected, actual } = await compare('{ pgcbhotauthors(pagination: { page: 1, size: 300 }, sort: { terms: [{ field: "name", order: ASC }] }) { name books { id } } }');
      expect(actual.result).toEqual(expected.result);
      expect(batched.findChildrenBatch.mock.calls.map((call) => call[3].length)).toEqual([100, 100, 5]);
      // The list, then a transaction for each call of at most 100 parents: BEGIN, SET LOCAL, its statement and COMMIT.
      expect([expected.statements.length, actual.statements.length]).toEqual([206, 1 + 3 * 4]);
    } finally {
      await pool.query(`DELETE FROM ${t('PgcbHotAuthor')}`);
    }
  });

  it('turns batching off for a plugin copy whose compileQuery hides rows, so its filter applies to every parent', async () => {
    const { hiding, perParent } = runtimes;
    expect(hiding.adapter.findChildrenBatch).toBeUndefined();
    const source = authorsQuery('books(sort: { terms: [{ field: "id", order: ASC }] }) { id tenant }');
    const hidden = await execute(hiding, source);
    expect(hidden.result.errors).toBeUndefined();
    expect(hidden.statements).toHaveLength(13);
    const { rows } = await pool.query(`SELECT b.id, b.tenant, a.name FROM ${t('PgcbBook')} b JOIN ${t('PgcbAuthor')} a ON a.id = b.author WHERE b.tenant <> 'secret' ORDER BY b.id`);
    expect(hidden.result.data.pgcbauthors).toEqual(authors.map(({ name }) => ({ name, books: rows.filter((row) => row.name === name).map(({ id, tenant }) => ({ id, tenant })) })));
    expect(books(hidden.result)).toHaveLength(132);
    // Without the copy's filter, the secret books are read.
    const visible = await execute(perParent, source);
    expect(books(visible.result).filter((book) => book.tenant === 'secret')).not.toEqual([]);
  });

  it('turns batching off while findChildren is not the adapter\'s own, so an override applies to every parent', async () => {
    const { batched } = runtimes;
    const own = batched.adapter.findChildren;
    // An override that hides secret books, installed on the adapter object the runtime uses.
    batched.adapter.findChildren = async (...args) => (await own(...args)).filter((record) => record.tenant !== 'secret');
    try {
      const { result, statements } = await execute(batched, authorsQuery('books { id tenant }'));
      expect(result.errors).toBeUndefined();
      expect(books(result).some((book) => book.tenant === 'secret')).toBe(false);
      expect(books(result).length).toBeGreaterThan(100);
      expect(statements).toHaveLength(13);
      expect(batched.findChildrenBatch).not.toHaveBeenCalled();
    } finally {
      batched.adapter.findChildren = own;
    }
    await execute(batched, authorsQuery('books { id tenant }'));
    expect(batched.findChildrenBatch).toHaveBeenCalledTimes(1);
  });

  it('reads each nested collection of an MCP list tool with one statement', async () => {
    const listArgs = { sort: { terms: [{ field: 'name', order: 'ASC' }] } };
    const results = [];
    for (const runtime of [runtimes.perParent, runtimes.batched]) {
      reset();
      const listed = await generateMCPTools(runtime.schema).callTool('pgcbauthors', listArgs);
      expect(listed.isError).toBe(false);
      results.push({ data: listed.structuredContent, statements: texts() });
    }
    const [expected, actual] = results;
    expect(actual.data.pgcbauthors.map((author) => [author.name, author.books.length, author.orders.length]))
      .toEqual(expected.data.pgcbauthors.map((author) => [author.name, author.books.length, author.orders.length]));
    // Per parent: the list and, for each of 12 authors, one books statement and an orders transaction (BEGIN,
    // SELECT, owned lines when it found orders, COMMIT). Batched: the list, then a books transaction (BEGIN,
    // SET LOCAL, the batch, COMMIT) and an orders transaction that also reads the owned lines, which run concurrently.
    expect(expected.statements).toHaveLength(1 + 12 + 10 * 4 + 2 * 3);
    expect(actual.statements).toHaveLength(1 + 4 + 5);
    expect(actual.statements.filter((text) => BATCHED.test(text))).toHaveLength(2);
    expect(actual.statements.filter((text) => text === JIT_OFF)).toHaveLength(2);
    expect(actual.statements.filter((text) => text.includes('"PgcbOrder__lines" WHERE "__owner_id" = ANY'))).toHaveLength(1);
    expect(actual.statements.filter((text) => /^(BEGIN|COMMIT)\b/.test(text)).sort()).toEqual([BEGIN, BEGIN, 'COMMIT', 'COMMIT']);
  });

  describe('skewed parents after HOT updates', () => {
    const hot = (field, page = 1) => `{ pgcbhotauthors(pagination: { page: 1, size: 50 }, sort: { terms: [{ field: "name", order: ASC }] }) { name books${field.replace('PAGE', String(page))} { id title category } } }`;

    beforeAll(async () => {
      // 40 authors; H00 owns three of every four books and the others share the rest. Then routine maintenance:
      // deletes, VACUUM, and updates of a column without an index, which PostgreSQL performs as HOT updates in the
      // freed space. A statement planned once for every parent then scans H00's rows otherwise than H00's own
      // statement, and returns its unsorted and tied rows in another order; each branch planned for its own parent
      // scans them as H00's own statement does.
      await pool.query(`INSERT INTO ${t('PgcbHotAuthor')} (name) SELECT 'H' || lpad(g::text, 2, '0') FROM generate_series(0, 39) g`);
      await pool.query(`WITH a AS (SELECT id, row_number() OVER (ORDER BY name) - 1 AS k FROM ${t('PgcbHotAuthor')})
        INSERT INTO ${t('PgcbHotBook')} (title, n, category, author)
        SELECT 'T' || (g % 5), g, ('00000000-0000-4000-8000-00000000000' || (g % 4))::uuid, a.id
        FROM generate_series(0, 3999) g JOIN a ON a.k = CASE WHEN g % 4 <> 0 THEN 0 ELSE 1 + (g / 4) % 39 END`);
      await pool.query(`DELETE FROM ${t('PgcbHotBook')} WHERE n % 7 = 0`);
      await pool.query(`VACUUM ${t('PgcbHotBook')}`);
      await pool.query(`UPDATE ${t('PgcbHotBook')} SET title = title || 'x' WHERE n % 5 = 0`);
      await pool.query(`ANALYZE ${t('PgcbHotBook')}`);
    }, 60000);

    it('plans each parent\'s statement for that parent\'s ID, as its own statement is planned', async () => {
      const { batched, perParent } = runtimes;
      const parents = (await pool.query(`SELECT id FROM ${t('PgcbHotAuthor')} ORDER BY name`)).rows.map((row) => row.id);
      const args = { sort: { terms: [{ field: 'title', order: 'ASC' }] }, pagination: { page: 1, size: 2 } };
      reset();
      await batched.adapter.findChildrenBatch(batched.api.getModel(batched.types.HotBook), batched.types.HotBook, 'author', parents, structuredClone(args));
      // Default planner settings.
      const plan = await explain(pool, log.find((entry) => BATCHED.test(entry.text)));
      const scans = nodes(plan).filter((node) => node['Relation Name'] === 'PgcbHotBook');
      // One branch and one scan per parent, then one sort of every row by parent position and row number.
      expect([plan['Node Type'], plan['Sort Key']?.length, plan.Plans[0]['Node Type'], plan.Plans[0].Plans?.length]).toEqual(['Sort', 2, 'Append', 40]);
      expect(scans).toHaveLength(40);
      // The statements of each parent alone, as 3.6.0 sends them.
      reset();
      for (const id of parents) await perParent.adapter.findChildren(perParent.api.getModel(perParent.types.HotBook), perParent.types.HotBook, 'author', id, structuredClone(args), null);
      const single = await Promise.all(log.map((entry) => explain(pool, entry)));
      const expected = single.flatMap((item) => nodes(item).filter((node) => node['Relation Name'] === 'PgcbHotBook'));
      expect(scans.map(access).sort()).toEqual(expected.map(access).sort());
      // The connection index serves at least the 39 parents with few rows.
      const index = batched.adapter.describeDatabase().tables.find((table) => table.name === 'PgcbHotBook').indexes.find((item) => item.columns.join() === 'author').name;
      expect(scans.filter((scan) => [scan, ...nodes(scan)].some((node) => node['Index Name'] === index && /\(author = /.test(node['Index Cond'] || ''))).length).toBeGreaterThanOrEqual(39);
    });

    it.each([
      ['a sort ending in id, page 1', '(sort: { terms: [{ field: "title", order: ASC }, { field: "id", order: ASC }] })'],
      ['a sort ending in id, page 2', '(sort: { terms: [{ field: "title", order: DESC }, { field: "id", order: ASC }] }, pagination: { page: PAGE, size: 100 })', 2],
      ['a sort on an indexed required ID ending in id, page 3', '(sort: { terms: [{ field: "category", order: ASC }, { field: "id", order: DESC }] }, pagination: { page: PAGE, size: 100 })', 3],
      ['id alone, page 4', '(sort: { terms: [{ field: "id", order: ASC }] }, pagination: { page: PAGE, size: 100 })', 4],
      ['unsorted rows, page 1', ''],
      ['unsorted rows, page 2', '(pagination: { page: PAGE, size: 100 })', 2],
      ['ties on an indexed required ID, page 2', '(sort: { terms: [{ field: "category", order: ASC }] }, pagination: { page: PAGE, size: 100 })', 2],
      ['ties on a title, page 1', '(sort: { terms: [{ field: "title", order: DESC }] })'],
    ])('keeps each parent\'s rows for %s', async (label, field, page = 1) => {
      const { expected, actual } = await compare(hot(field, page));
      expect(actual.result.errors).toBeUndefined();
      const [skewed, ...others] = expected.result.data.pgcbhotauthors;
      expect(skewed.name).toBe('H00');
      // H00 fills every page asked for; every other parent's rows fit on the first page.
      expect(skewed.books).toHaveLength(100);
      expect(others.every((author) => (page === 1 ? author.books.length > 0 && author.books.length < 100 : author.books.length === 0))).toBe(true);
      expectSameChildren(expected, actual, { root: 'pgcbhotauthors', field: 'books' });
      expect(batchedStatements()).toHaveLength(1);
    });
  });

  describe('skewed connection statistics', () => {
    // 10 large parents hold 40,000 books each and 100 small parents 3 each. ANALYZE samples 30,000 rows, so it sees few
    // of the small parents and estimates far fewer distinct parents than there are (about 30 instead of 110). A plan
    // made once for every parent then expects thousands of rows per parent, and for a page of them walks the table,
    // unsorted, or its primary key, sorted by id, with a filter instead of reading the connection index: once per
    // parent, over the whole table for a small parent. A statement planned for each parent's own ID finds a small
    // parent outside the most common values and reads the index, as 3.6.0's per-parent statement does.
    let index;
    const walks = (plan) => nodes(plan).filter((node) => /\(author = /.test(node.Filter || '') && (node['Node Type'] === 'Seq Scan' || /__pk$/.test(node['Index Name'] || '')));
    const indexed = (scan) => [scan, ...nodes(scan)].some((node) => node['Index Name'] === index && /\(author = /.test(node['Index Cond'] || ''));
    const skewed = (order, size, field) => `{ pgcbskewauthors(sort: { terms: [{ field: "name", order: ${order} }] }, pagination: { page: 1, size: ${size} }) { name books${field} { id } } }`;
    const shapes = [['a sort ending in id', '(sort: { terms: [{ field: "title", order: ASC }, { field: "id", order: ASC }] })'], ['id alone', '(sort: { terms: [{ field: "id", order: ASC }] })'], ['unsorted rows', '']];

    beforeAll(async () => {
      await pool.query(`INSERT INTO ${t('PgcbSkewAuthor')} (name) SELECT CASE WHEN g <= 100 THEN 'S' ELSE 'L' END || lpad(g::text, 3, '0') FROM generate_series(1, 110) g`);
      await pool.query(`INSERT INTO ${t('PgcbSkewBook')} (title, author) SELECT 'T' || (g % 7), a.id FROM ${t('PgcbSkewAuthor')} a CROSS JOIN LATERAL generate_series(1, CASE WHEN a.name LIKE 'L%' THEN 40000 ELSE 3 END) g`);
      await pool.query(`VACUUM ANALYZE ${t('PgcbSkewBook')}`);
      index = runtimes.batched.adapter.describeDatabase().tables.find((table) => table.name === 'PgcbSkewBook').indexes.find((item) => item.columns.join() === 'author').name;
    }, 120000);

    it('estimates far fewer distinct parents than there are', async () => {
      const { rows: [stats] } = await pool.query('SELECT s.n_distinct, c.reltuples FROM pg_stats s JOIN pg_class c ON c.relname = s.tablename JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = s.schemaname WHERE s.schemaname = $1 AND s.tablename = $2 AND s.attname = $3', [namespace, 'PgcbSkewBook', 'author']);
      const estimate = stats.n_distinct > 0 ? stats.n_distinct : -stats.n_distinct * stats.reltuples;
      expect(estimate).toBeLessThan(110 * 0.6);
    });

    it.each(shapes)('reads every small parent of %s through the connection index', async (label, field) => {
      // The names sort the 100 small parents first.
      const { expected, actual } = await compare(skewed('DESC', 100, field));
      expect(actual.result.errors).toBeUndefined();
      expect(actual.result.data.pgcbskewauthors.map((author) => author.books.length)).toEqual(Array(100).fill(3));
      expect(actual.result).toEqual(expected.result);
      const [statement] = log.filter((entry) => BATCHED.test(entry.text));
      const plan = await explain(pool, statement);
      // No parent's rows are found by filtering the table or the primary key on the connection column.
      expect(walks(plan).map(access)).toEqual([]);
      const scans = nodes(plan).filter((node) => node['Relation Name'] === 'PgcbSkewBook');
      expect(scans.filter((scan) => !indexed(scan)).map(access)).toEqual([]);
      // One plan per parent.
      expect(scans).toHaveLength(100);
    }, 60000);

    it.each(shapes)('plans each parent of a mixed batch as its own statement for %s', async (label, field) => {
      // 10 large and 10 small parents; a large parent's statement can walk the table, as it does alone.
      const source = skewed('ASC', 20, field);
      reset();
      const expected = await graphql({ schema: runtimes.perParent.schema, source, contextValue: {} });
      const single = await Promise.all(log.filter((entry) => entry.text.includes(`${t('PgcbSkewBook')} t0`)).map((entry) => explain(pool, entry)));
      expect(single).toHaveLength(20);
      const { result } = await execute(runtimes.batched, source);
      expect(result).toEqual(JSON.parse(JSON.stringify(expected)));
      const [statement] = log.filter((entry) => BATCHED.test(entry.text));
      const scans = nodes(await explain(pool, statement)).filter((node) => node['Relation Name'] === 'PgcbSkewBook');
      expect(scans.map(access).sort()).toEqual(single.flatMap((plan) => nodes(plan).filter((node) => node['Relation Name'] === 'PgcbSkewBook')).map(access).sort());
      expect(scans.filter(indexed).length).toBeGreaterThanOrEqual(10);
    }, 60000);
  });

  describe('JIT', () => {
    // 100 authors with 2,000 books each. Each author's own statement costs far less than jit_above_cost, but the batch
    // of 100 costs about as much as their statements together, so with JIT on PostgreSQL would compile the expressions
    // of every branch, which can take longer than running the statement. The adapter runs each batch in a transaction
    // that first turns JIT off for that transaction only. Plans and statements are asserted, never time.
    const source = '{ pgcbjitauthors(sort: { terms: [{ field: "name", order: ASC }] }, pagination: { page: 1, size: 100 }) { name books(sort: { terms: [{ field: "title", order: ASC }, { field: "id", order: ASC }] }) { id } } }';
    let settings;
    // EXPLAIN of a statement in a transaction, rolled back, with the given JIT setting and the server's others.
    const explainWith = async (jit, { text, values }) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL jit = ${jit}`);
        return (await client.query(`EXPLAIN (FORMAT JSON) ${text}`, values)).rows[0]['QUERY PLAN'][0];
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    };

    beforeAll(async () => {
      // pg_jit_available() is also false while jit is off, so the provider is checked with jit on. reset_val is the
      // setting a connection has without SET: the server's, database's or role's.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL jit = on');
        settings = (await client.query('SELECT pg_jit_available() AS available, current_setting($1)::float8 AS above, (SELECT reset_val FROM pg_settings WHERE name = $2) AS jit', ['jit_above_cost', 'jit'])).rows[0];
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
      await pool.query(`INSERT INTO ${t('PgcbJitAuthor')} (name) SELECT 'J' || lpad(g::text, 3, '0') FROM generate_series(1, 100) g`);
      await pool.query(`INSERT INTO ${t('PgcbJitBook')} (title, author) SELECT 'T' || (g % 7), a.id FROM ${t('PgcbJitAuthor')} a CROSS JOIN generate_series(1, 2000) g`);
      await pool.query(`VACUUM ANALYZE ${t('PgcbJitBook')}`);
    }, 120000);

    it('runs the batch right after SET LOCAL jit = off, in one transaction, so a plan above jit_above_cost is not compiled', async (context) => {
      context.skip(!settings.available, 'the server has no JIT provider: pg_jit_available() is false');
      const { batched, perParent } = runtimes;
      const expected = await execute(perParent, source);
      const single = log.filter((entry) => entry.text.includes(`${t('PgcbJitBook')} t0`));
      probes = [];
      const actual = await execute(batched, source);
      expect(actual.result.errors).toBeUndefined();
      expect(actual.result).toEqual(expected.result);
      expect(actual.result.data.pgcbjitauthors.map((author) => author.books.length)).toEqual(Array(100).fill(100));
      // 3.6.0's statements: the list, then one per author.
      expect(expected.statements).toHaveLength(101);
      expect(single).toHaveLength(100);
      // The statements the adapter sends: the list, then BEGIN, SET LOCAL jit = off, the batch and COMMIT, on one
      // connection.
      expect(actual.statements).toEqual([expect.stringMatching(new RegExp(`^SELECT t0\\.\\* FROM ${t('PgcbJitAuthor').replace(/[.$"]/g, '\\$&')} `)), BEGIN, JIT_OFF, expect.stringMatching(BATCHED), 'COMMIT']);
      const [, ...transaction] = log;
      const [{ client }] = transaction;
      expect(transaction.map((entry) => entry.client)).toEqual(Array(4).fill(client));
      // JIT was off when the batch ran, and the connection goes back to the pool with the setting it had before.
      expect(probes.filter((probe) => probe.client === client)).toEqual([{ client, after: 'batch', jit: 'off' }, { client, after: 'release', jit: settings.jit }]);
      const statement = transaction[2];
      // Precondition: with JIT on, the batch's plan costs more than jit_above_cost, so PostgreSQL would compile it.
      const on = await explainWith('on', statement);
      expect(on.Plan['Total Cost']).toBeGreaterThan(settings.above);
      expect(on.JIT).toEqual(expect.objectContaining({ Functions: expect.any(Number) }));
      expect(on.JIT.Functions).toBeGreaterThan(0);
      // Under SET LOCAL jit = off, as the adapter runs it, the same plan is not compiled.
      const off = await explainWith('off', statement);
      expect(off).not.toHaveProperty('JIT');
      expect(off.Plan['Total Cost']).toBe(on.Plan['Total Cost']);
      // No author's own statement reaches jit_above_cost, so 3.6.0 never compiled one.
      for (const entry of single) {
        const plan = await explainWith('on', entry);
        expect(plan).not.toHaveProperty('JIT');
        expect(plan.Plan['Total Cost']).toBeLessThan(settings.above);
      }
    }, 120000);
  });
});
