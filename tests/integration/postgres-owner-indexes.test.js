import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GraphQLList, GraphQLObjectType, GraphQLString } from 'graphql';
import pg from 'pg';
import { createPostgres, describeDatabase, initializeDatabase } from '../../packages/postgres/src/index.js';
import { compileRecord } from '../../packages/postgres/src/record-statements.js';

const uri = process.env.SIMFINITY_POSTGRES_URI;
const embedded = { relation: { embedded: true } };
const q = (name) => `"${name.replaceAll('"', '""')}"`;
const fixture = () => {
  const Code = new GraphQLObjectType({ name: 'OwnerIndexCode', fields: { code: { type: GraphQLString, extensions: { unique: true } }, note: { type: GraphQLString } } });
  const Owner = new GraphQLObjectType({ name: 'OwnerIndexOwner', fields: {
    entries: { type: new GraphQLList(Code), extensions: embedded },
    main: { type: Code, extensions: embedded },
  } });
  return { Code, Owner };
};
// The generated (__owner_id) indexes, by table.
const ownerIndexes = async (pool, schema) => (await pool.query(`SELECT tablename AS table, indexname AS index FROM pg_indexes
  WHERE schemaname = $1 AND indexname LIKE '%\\_\\_\\_\\_owner\\_id\\_\\_idx' ORDER BY 1`, [schema])).rows;

describe.skipIf(!uri)('PostgreSQL ownerIndexes', () => {
  let pool;
  const schemas = [];
  const schemaName = () => {
    const name = `owner_index_${randomUUID().replaceAll('-', '')}`;
    schemas.push(name);
    return name;
  };
  beforeAll(() => { pool = new pg.Pool({ connectionString: uri, max: 4 }); });
  afterAll(async () => {
    for (const name of schemas) await pool.query(`DROP SCHEMA IF EXISTS ${q(name)} CASCADE`);
    await pool.end();
  });

  it('accepts and keeps the owner indexes of a database created with them', async () => {
    const schema = schemaName();
    const { Owner } = fixture();
    const all = describeDatabase([{ gqltype: Owner }], { schema });
    await initializeDatabase(pool, all);
    const before = await ownerIndexes(pool, schema);
    expect(before.map((row) => row.table)).toEqual(['OwnerIndexOwner__entries', 'OwnerIndexOwner__entries__code__keys', 'OwnerIndexOwner__guard', 'OwnerIndexOwner__main', 'OwnerIndexOwner__main__code__keys']);
    const minimal = describeDatabase([{ gqltype: Owner }], { schema, ownerIndexes: 'minimal' });
    expect(await initializeDatabase(pool, minimal, { mode: 'validate' })).toEqual({ mode: 'validate', created: [] });
    expect(await initializeDatabase(pool, minimal)).toEqual({ mode: 'create', created: [] });
    expect(await ownerIndexes(pool, schema)).toEqual(before);
  });

  it('creates owner indexes only on keys tables, which the default description then reports and adds', async () => {
    const schema = schemaName();
    const { Owner, Code } = fixture();
    const api = createPostgres({ pool, schema, ownerIndexes: 'minimal' });
    api.connect(null, Owner, 'owner', 'owners');
    api.addNoEndpointType(Code);
    api.createSchema();
    await api.initializeDatabase();
    expect((await ownerIndexes(pool, schema)).map((row) => row.table)).toEqual(['OwnerIndexOwner__entries__code__keys', 'OwnerIndexOwner__main__code__keys']);
    const owner = await api.getModel(Owner).create({ entries: [{ code: 'a' }, { code: 'b' }], main: { code: 'c' } });
    await expect(api.getModel(Owner).create({ entries: [{ code: 'b' }] })).rejects.toMatchObject({ extensions: { code: 'DUPLICATE_KEY' } });
    await expect(api.getModel(Owner).create({ main: { code: 'c' } })).rejects.toMatchObject({ extensions: { code: 'DUPLICATE_KEY' } });
    await api.getModel(Owner).update(owner.id, { entries: [{ code: 'd' }] });
    expect(await api.getModel(Owner).findById(owner.id)).toMatchObject({ entries: [{ code: 'd' }], main: { code: 'c' } });
    const keys = async () => (await pool.query(`SELECT xmin::text, value FROM ${q(schema)}."OwnerIndexOwner__entries__code__keys" ORDER BY value`)).rows;
    const stored = await keys();

    // An earlier version's validation reports the index missing; its create mode adds it. So does the default description.
    const all = describeDatabase(api.getRegistrations(), { schema });
    await expect(initializeDatabase(pool, all, { mode: 'validate' })).rejects.toMatchObject({ message: expect.stringContaining('index is missing'), extensions: { code: 'SCHEMA_MISMATCH' } });
    expect(await initializeDatabase(pool, all)).toEqual({ mode: 'create', created: ['OwnerIndexOwner__entries', 'OwnerIndexOwner__guard', 'OwnerIndexOwner__main'].map((table) => `index:${schema}.${table}____owner_id__idx`) });
    expect(await keys()).toEqual(stored);
    expect(await api.initializeDatabase({ mode: 'validate' })).toEqual({ mode: 'validate', created: [] });
  });

  it('finds owned and guard rows by owner through a unique index or the primary key', async () => {
    const schema = schemaName();
    const { Owner } = fixture();
    const db = describeDatabase([{ gqltype: Owner }], { schema, ownerIndexes: 'minimal' });
    await initializeDatabase(pool, db);
    const owner = (await pool.query(`INSERT INTO ${q(schema)}."OwnerIndexOwner" DEFAULT VALUES RETURNING id`)).rows[0].id;
    const table = (name) => db.tables.find((item) => item.name === name);
    const statements = [
      ['OwnerIndexOwner__entries____owner_id____position__uq', compileRecord(db, { kind: 'selectOwned', table: table('OwnerIndexOwner__entries'), ids: [owner, randomUUID()], ordered: true })],
      ['OwnerIndexOwner__entries____owner_id____position__uq', compileRecord(db, { kind: 'deleteOwned', table: table('OwnerIndexOwner__entries'), ownerId: owner })],
      ['OwnerIndexOwner__main____owner_id__uq', compileRecord(db, { kind: 'selectOwned', table: table('OwnerIndexOwner__main'), ids: [owner] })],
      ['OwnerIndexOwner__main____owner_id__uq', compileRecord(db, { kind: 'deleteOwned', table: table('OwnerIndexOwner__main'), ownerId: owner })],
      ['OwnerIndexOwner__guard__pk', { text: `SELECT version FROM ${q(schema)}."OwnerIndexOwner__guard" WHERE __owner_id = $1::uuid`, values: [owner] }],
    ];
    const indexes = (node) => [node['Index Name'], ...(node.Plans || []).flatMap(indexes)].filter(Boolean);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      for (const [index, statement] of statements) {
        const [{ Plan: plan }] = (await client.query(`EXPLAIN (FORMAT JSON) ${statement.text}`, statement.values)).rows[0]['QUERY PLAN'];
        expect(indexes(plan), statement.text).toEqual([index]);
      }
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
});
