import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createPostgres } from '../../packages/postgres/src/index.js';
import { sqlSchemaOptInFixtures } from '../contracts/sql-schema-fixtures.js';

const uri = process.env.SIMFINITY_POSTGRES_URI;
const q = (name) => `"${name.replaceAll('"', '""')}"`;

// The opt-in golden fixture whose generated names reach the 63-byte limit, on a real database.
describe.skipIf(!uri)('PostgreSQL long names with the opt-in layouts', () => {
  let pool;
  const schema = `long_names_${randomUUID().replaceAll('-', '')}`;
  beforeAll(() => { pool = new pg.Pool({ connectionString: uri, max: 4 }); });
  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${q(schema)} CASCADE`);
    await pool.end();
  });

  it('creates and validates a long-named root with perRoot refresh triggers and minimal owner indexes', async () => {
    const [{ registrations: [{ gqltype: Root }] }] = sqlSchemaOptInFixtures();
    const api = createPostgres({ pool, schema, refreshTriggers: 'perRoot', ownerIndexes: 'minimal' });
    api.connect(null, Root, 'longRoot', 'longRoots');
    api.addNoEndpointType(Root.getFields().entries.type.ofType);
    api.createSchema();
    const db = api.describeDatabase();
    const [item] = db.maintenance;
    const owned = db.tables.find((table) => table.ownership).name;
    const keys = db.tables.find((table) => table.uniqueKeys).name;
    expect(item.guardTable).toHaveLength(63);
    expect([owned, keys].map((name) => name.length)).toEqual([63, 63]);

    const { created } = await api.initializeDatabase();
    expect(created).toEqual(expect.arrayContaining([`trigger:${schema}.${item.guardTable}.${db.triggers.find((trigger) => trigger.constraint).name}`]));
    expect(await api.initializeDatabase({ mode: 'validate' })).toEqual({ mode: 'validate', created: [] });
    expect(await api.initializeDatabase()).toEqual({ mode: 'create', created: [] });

    // The stored triggers carry the described names: only the guard table's is a constraint trigger.
    const byTable = (a, b) => a.table.localeCompare(b.table);
    const triggers = await pool.query(`SELECT c.relname AS table, t.tgname AS name, t.tgconstraint <> 0 AS constraint FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT t.tgisinternal`, [schema]);
    expect(triggers.rows.sort(byTable)).toEqual([
      { table: item.rootTable, name: `${item.rootTable}__touch`, constraint: false },
      { table: item.guardTable, name: db.triggers.find((trigger) => trigger.constraint).name, constraint: true },
      { table: owned, name: db.triggers.find((trigger) => trigger.table === owned).name, constraint: false },
    ].sort(byTable));
    // Only the keys table keeps its (__owner_id) index.
    // Scope the catalog before deparsing/filtering definitions: other suites drop their own tables.
    const ownerIndexes = await pool.query(`WITH scoped_indexes AS MATERIALIZED (
      SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = $1
    ) SELECT tablename AS table FROM scoped_indexes WHERE indexdef LIKE 'CREATE INDEX % USING btree (__owner_id)'`, [schema]);
    expect(ownerIndexes.rows).toEqual([{ table: keys }]);

    const model = api.getModel(Root);
    const record = await model.create({ entries: [{ code: 'a' }, { code: 'b' }] });
    await expect(model.create({ entries: [{ code: 'b' }] })).rejects.toMatchObject({ extensions: { code: 'DUPLICATE_KEY' } });
    await model.update(record.id, { entries: [{ code: 'c' }] });
    expect(await model.findById(record.id)).toMatchObject({ entries: [{ code: 'c' }] });
    expect((await pool.query(`SELECT value FROM ${q(schema)}.${q(keys)} ORDER BY value`)).rows).toEqual([{ value: 'c' }]);
    expect((await pool.query(`SELECT version >= 0 AS clean FROM ${q(schema)}.${q(item.guardTable)}`)).rows).toEqual([{ clean: true }]);
  });
});
