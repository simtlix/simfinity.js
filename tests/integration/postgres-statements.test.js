import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GraphQLID, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, graphql } from 'graphql';
import pg from 'pg';
import { createPostgres } from '../../packages/postgres/src/index.js';

const uri = process.env.SIMFINITY_POSTGRES_URI;
const fixture = () => {
  const reference = (connectionField) => ({ relation: { embedded: false, ...(connectionField ? { connectionField } : {}) } });
  const Author = new GraphQLObjectType({ name: 'StmtAuthor', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
  const Book = new GraphQLObjectType({ name: 'StmtBook', fields: () => ({
    id: { type: GraphQLID }, title: { type: new GraphQLNonNull(GraphQLString) }, author: { type: Author, extensions: reference() },
    chapters: { type: new GraphQLList(Chapter), extensions: reference('book') },
  }) });
  const Chapter = new GraphQLObjectType({ name: 'StmtChapter', fields: () => ({
    id: { type: GraphQLID }, title: { type: GraphQLString }, position: { type: GraphQLInt }, book: { type: new GraphQLNonNull(Book), extensions: reference('book') },
  }) });
  // The references store lines and their parts in owned tables.
  const Part = new GraphQLObjectType({ name: 'StmtPart', fields: { name: { type: GraphQLString }, author: { type: Author, extensions: reference() } } });
  const Line = new GraphQLObjectType({ name: 'StmtLine', fields: {
    label: { type: GraphQLString }, quantity: { type: GraphQLInt }, author: { type: Author, extensions: reference() },
    parts: { type: new GraphQLList(Part), extensions: { relation: { embedded: true } } },
  } });
  const Order = new GraphQLObjectType({ name: 'StmtOrder', fields: {
    id: { type: GraphQLID }, code: { type: new GraphQLNonNull(GraphQLString) }, lines: { type: new GraphQLList(Line), extensions: { relation: { embedded: true } } },
  } });
  return { Author, Book, Chapter, Part, Line, Order };
};

describe.skipIf(!uri)('PostgreSQL statements per operation', () => {
  const namespace = `statements_${randomUUID().replaceAll('-', '')}`;
  let pool; let log; let connects; let recording; let runtimes;
  // A pool wrapper that records every statement its connections and the pool itself run.
  const record = (client) => ({
    query: (text, values) => { log.push(typeof text === 'string' ? text : text.text); return client.query(text, values); },
    release: (error) => client.release(error),
  });
  const reset = () => { log.length = 0; connects = 0; };
  const inserts = (table) => log.filter((text) => text.startsWith(`INSERT INTO "${namespace}"."${table}" `));
  const transactions = () => log.filter((text) => /^(BEGIN|COMMIT|ROLLBACK)\b/.test(text));
  const start = async (api, mode) => {
    const types = fixture();
    api.connect(null, types.Author, 'stmtauthor', 'stmtauthors');
    api.connect(null, types.Book, 'stmtbook', 'stmtbooks');
    api.connect(null, types.Chapter, 'stmtchapter', 'stmtchapters');
    api.addNoEndpointType(types.Part);
    api.addNoEndpointType(types.Line);
    api.connect(null, types.Order, 'stmtorder', 'stmtorders');
    const schema = api.createSchema();
    await api.initializeDatabase(mode ? { mode } : undefined);
    const execute = async (source, variableValues, contextValue = {}) => graphql({ schema, source, variableValues, contextValue });
    return { api, types, execute };
  };
  const ok = async (runtime, source, variableValues, contextValue) => {
    const result = await runtime.execute(source, variableValues, contextValue);
    expect(result.errors, source).toBeUndefined();
    return result.data;
  };
  const addOrder = 'mutation($input:StmtOrderInput!){addstmtorder(input:$input){id code lines{label quantity author{id} parts{name}}}}';
  const updateOrder = 'mutation($input:StmtOrderInputForUpdate!){updatestmtorder(input:$input){id lines{label quantity}}}';

  beforeAll(async () => {
    log = [];
    connects = 0;
    pool = new pg.Pool({ connectionString: uri });
    recording = {
      connect: async () => { connects += 1; return record(await pool.connect()); },
      query: (text, values) => { log.push(text); return pool.query(text, values); },
    };
    const defaults = await start(createPostgres({ pool: recording, schema: namespace }));
    // The opt-out, through the factory options and through configure(), on the same storage.
    const perRow = await start(createPostgres({ pool: recording, schema: namespace, multiRowInserts: false }), 'validate');
    const configured = createPostgres();
    configured.configure({ pool: recording, schema: namespace, multiRowInserts: false, explicitNullsOrder: true });
    const legacy = await start(configured, 'validate');
    const explicit = await start(createPostgres({ pool: recording, schema: namespace, explicitNullsOrder: true }), 'validate');
    runtimes = { defaults, perRow, legacy, explicit };
  }, 30000);
  beforeEach(async () => {
    const tables = runtimes.defaults.api.describeDatabase().tables.map((table) => `"${namespace}"."${table.name}"`);
    await pool.query(`TRUNCATE ${tables.join(', ')} CASCADE`);
    reset();
  });
  afterAll(async () => {
    if (pool) { await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); await pool.end(); }
  });

  it('runs sessionless reads of types without owned tables as single statements', async () => {
    const { defaults } = runtimes;
    const author = await defaults.api.getModel(defaults.types.Author).create({ name: 'Ada' });
    for (let index = 0; index < 20; index++) {
      const book = await defaults.api.getModel(defaults.types.Book).create({ title: `Book ${String(index).padStart(2, '0')}`, author: author.id });
      await defaults.api.getModel(defaults.types.Chapter).create({ title: `Chapter ${index}`, position: 1, book: book.id });
    }
    reset();
    expect(await ok(defaults, 'query($id:ID){stmtauthor(id:$id){id name}}', { id: author.id })).toEqual({ stmtauthor: { id: author.id, name: 'Ada' } });
    expect(log).toEqual([expect.stringMatching(/^SELECT /)]);
    expect(connects).toBe(1);

    reset();
    const context = {};
    await ok(defaults, '{stmtbooks(pagination:{page:1,size:5,count:true}){id}}', undefined, context);
    expect(context.count).toBe(20);
    expect(log).toHaveLength(2);
    expect(transactions()).toEqual([]);

    // One list statement, one batched author read and one statement per collection field.
    reset();
    const data = await ok(defaults, '{stmtbooks(sort:{terms:[{field:"title",order:ASC}]}){title author{name} chapters(sort:{terms:[{field:"position",order:ASC}]}){title}}}');
    expect(data.stmtbooks).toHaveLength(20);
    expect(data.stmtbooks[3]).toEqual({ title: 'Book 03', author: { name: 'Ada' }, chapters: [{ title: 'Chapter 3' }] });
    expect(log).toHaveLength(22);
    expect(transactions()).toEqual([]);
    expect(connects).toBe(22);
  });

  it('keeps one repeatable-read transaction for a read that loads owned rows', async () => {
    const { defaults } = runtimes;
    const { addstmtorder: order } = await ok(defaults, addOrder, { input: { code: 'owned', lines: [{ label: 'a', parts: [{ name: 'p' }] }] } });
    reset();
    expect(await ok(defaults, 'query($id:ID){stmtorder(id:$id){code lines{label parts{name}}}}', { id: order.id }))
      .toEqual({ stmtorder: { code: 'owned', lines: [{ label: 'a', parts: [{ name: 'p' }] }] } });
    expect(log).toEqual([
      'BEGIN ISOLATION LEVEL REPEATABLE READ',
      expect.stringMatching(new RegExp(`^SELECT \\* FROM "${namespace}"\\."StmtOrder" WHERE`)),
      expect.stringMatching(new RegExp(`^SELECT \\* FROM "${namespace}"\\."StmtOrder__lines" WHERE`)),
      expect.stringMatching(new RegExp(`^SELECT \\* FROM "${namespace}"\\."StmtOrder__lines__parts" WHERE`)),
      'COMMIT',
    ]);
  });

  it('inserts the owned rows of a list with one multi-row INSERT and replaces them with one DELETE and one INSERT', async () => {
    const { defaults } = runtimes;
    const author = await defaults.api.getModel(defaults.types.Author).create({ name: 'Ada' });
    const lines = Array.from({ length: 50 }, (_, index) => (index % 10 === 7 ? null : { label: `line-${index}`, quantity: index, ...(index % 2 ? { author: { id: author.id } } : {}) }));
    reset();
    const { addstmtorder: order } = await ok(defaults, addOrder, { input: { code: 'bulk', lines } });
    expect(inserts('StmtOrder')).toHaveLength(1);
    expect(inserts('StmtOrder__lines')).toHaveLength(1);
    expect(inserts('StmtOrder__lines')[0].match(/\), \(/g)).toHaveLength(49);
    expect(order.lines).toEqual(lines.map((line) => line && { label: line.label, quantity: line.quantity, author: line.author ?? null, parts: [] }));

    const replacement = Array.from({ length: 50 }, (_, index) => ({ label: `new-${index}`, quantity: 100 - index }));
    reset();
    expect((await ok(defaults, updateOrder, { input: { id: order.id, lines: replacement } })).updatestmtorder.lines).toEqual(replacement);
    expect(log.filter((text) => text.startsWith(`DELETE FROM "${namespace}"."StmtOrder__lines" `))).toHaveLength(1);
    expect(inserts('StmtOrder__lines')).toHaveLength(1);
    const stored = await pool.query(`SELECT label, quantity, __position FROM "${namespace}"."StmtOrder__lines" WHERE __owner_id = $1 ORDER BY __position`, [order.id]);
    expect(stored.rows).toEqual(replacement.map((line, index) => ({ ...line, __position: index })));
  });

  it('inserts each owner row before the rows it owns', async () => {
    const { defaults } = runtimes;
    const input = { code: 'nested', lines: [{ label: 'a', parts: [{ name: 'a1' }, { name: 'a2' }] }, { label: 'b', parts: [{ name: 'b1' }] }, { label: 'c' }, { label: 'd' }] };
    reset();
    const { addstmtorder: order } = await ok(defaults, addOrder, { input });
    const tables = log.filter((text) => text.startsWith('INSERT')).map((text) => text.match(/^INSERT INTO "[^"]+"\."([^"]+)"/)[1].replace('StmtOrder', '') || 'root');
    expect(tables).toEqual(['root', '__lines', '__lines__parts', '__lines', '__lines__parts', '__lines']);
    expect(order.lines.map((line) => [line.label, line.parts.map((part) => part.name)])).toEqual([['a', ['a1', 'a2']], ['b', ['b1']], ['c', []], ['d', []]]);
  });

  it('inserts one owned row per statement with multiRowInserts: false, from the factory options or configure()', async () => {
    const lines = Array.from({ length: 5 }, (_, index) => ({ label: `line-${index}`, quantity: index }));
    for (const runtime of [runtimes.perRow, runtimes.legacy]) {
      reset();
      const { addstmtorder: order } = await ok(runtime, addOrder, { input: { code: 'per-row', lines } });
      expect(inserts('StmtOrder__lines')).toHaveLength(5);
      expect(order.lines.map((line) => line.label)).toEqual(lines.map((line) => line.label));
    }
  });

  it('keeps the NULLS clause on required sorts with explicitNullsOrder, from the factory options or configure()', async () => {
    const source = '{stmtbooks(sort:{terms:[{field:"title",order:ASC},{field:"id",order:DESC}]}){id}}';
    const order = (runtime) => async () => {
      reset();
      await ok(runtime, source);
      return log.find((text) => text.startsWith('SELECT ')).match(/ ORDER BY (.*) LIMIT /)?.[1] ?? null;
    };
    expect(await order(runtimes.defaults)()).toBe('(t0."title") COLLATE "pg_catalog"."C" ASC, t0."id" DESC');
    for (const runtime of [runtimes.explicit, runtimes.legacy]) {
      expect(await order(runtime)()).toBe('(t0."title") COLLATE "pg_catalog"."C" ASC NULLS FIRST, t0."id" DESC NULLS LAST');
    }
  });

  describe('error precedence of a write with several rejected items', () => {
    const missing = randomUUID();
    const orders = async () => Number((await pool.query(`SELECT count(*) AS n FROM "${namespace}"."StmtOrder"`)).rows[0].n);
    const expectRejected = async (runtime, lines, code) => {
      const result = await runtime.execute(addOrder, { input: { code: 'rejected', lines } });
      expect(result.errors?.[0].extensions.code).toBe(code);
      expect(await orders()).toBe(0);
      expect(Number((await pool.query(`SELECT count(*) AS n FROM "${namespace}"."StmtOrder__lines"`)).rows[0].n)).toBe(0);
    };

    // One multi-row INSERT fails on the later item's value before the end-of-statement reference check.
    it('reports the later item of one INSERT that the database cannot store (bind error)', async () => {
      const lines = [{ label: 'ok' }, { label: 'missing author', author: { id: missing } }, { label: 'a\u0000b' }];
      await expectRejected(runtimes.defaults, lines, 'INVALID_VALUE');
      await expectRejected(runtimes.perRow, lines, 'REFERENCE_CONSTRAINT_VIOLATION');
      // Alone, each item reports its own error on both.
      for (const runtime of [runtimes.defaults, runtimes.perRow]) {
        await expectRejected(runtime, lines.slice(0, 2), 'REFERENCE_CONSTRAINT_VIOLATION');
        await expectRejected(runtime, [lines[0], lines[2]], 'INVALID_VALUE');
      }
    });

    it('reports the later item of one INSERT that a CHECK constraint rejects', async () => {
      const table = `"${namespace}"."StmtOrder__lines"`;
      await pool.query(`ALTER TABLE ${table} ADD CONSTRAINT stmt_line_quantity CHECK (quantity IS DISTINCT FROM -1)`);
      try {
        const lines = [{ label: 'ok' }, { label: 'missing author', author: { id: missing } }, { label: 'checked', quantity: -1 }];
        await expectRejected(runtimes.defaults, lines, 'INVALID_VALUE');
        await expectRejected(runtimes.perRow, lines, 'REFERENCE_CONSTRAINT_VIOLATION');
      } finally {
        await pool.query(`ALTER TABLE ${table} DROP CONSTRAINT stmt_line_quantity`);
      }
    });
  });
});
