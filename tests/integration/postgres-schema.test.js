import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { GraphQLObjectType, GraphQLNonNull } from 'graphql';
import { createContractModelFixtures } from '../contracts/model-fixtures.js';
import { schemaFixture } from '../contracts/postgres-fixtures.js';
import { describeDatabase, compileDatabaseSchema, initializeDatabase } from '../../packages/postgres/src/index.js';

const uri = process.env.SIMFINITY_POSTGRES_URI;
describe.skipIf(!uri)('generated PostgreSQL schema on a real server', () => {
  let pool;
  const schema = `simfinity_${randomUUID().replaceAll('-', '')}`;
  const driftSchema = `${schema}_drift`;
  const cyclicSchema = `${schema}_cycle`;
  const contractSchema = `${schema}_contract`;
  const concurrentSchema = `${schema}_concurrent`;
  const orphanSchema = `${schema}_orphan`;
  const db = describeDatabase(schemaFixture(), { schema });
  const table = (name) => `"${schema}"."${name}"`;
  beforeAll(async () => { pool = new pg.Pool({ connectionString: uri }); });
  afterAll(async () => {
    for (const name of [schema, driftSchema, cyclicSchema, contractSchema, concurrentSchema, orphanSchema]) await pool.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
    await pool.end();
  });

  it('creates and validates idempotently, with all declared foreign keys', async () => {
    const result = await initializeDatabase(pool, db);
    expect(result.created).toContain(`table:${schema}.Child`);
    expect(await initializeDatabase(pool, db)).toEqual({ mode: 'create', created: [] });
    expect(await initializeDatabase(pool, db, { mode: 'validate' })).toEqual({ mode: 'validate', created: [] });
    const { rows } = await pool.query('SELECT conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = $1 AND contype = $2', [schema, 'f']);
    expect(rows).toHaveLength(db.tables.reduce((sum, item) => sum + item.foreignKeys.length, 0));
  });

  it('rejects missing references and parent deletion, and enforces association uniqueness', async () => {
    const parent = randomUUID();
    const tag = randomUUID();
    await pool.query(`INSERT INTO ${table('Parent')} (id, name) VALUES ($1, $2)`, [parent, 'Parent']);
    await pool.query(`INSERT INTO ${table('Tag')} (id, label) VALUES ($1, $2)`, [tag, 'Tag']);
    await expect(pool.query(`INSERT INTO ${table('Child')} (parent_id, tag) VALUES ($1, $2)`, [randomUUID(), tag])).rejects.toMatchObject({ code: '23503' });
    await pool.query(`INSERT INTO ${table('Child')} (parent_id, tag) VALUES ($1, $2)`, [parent, tag]);
    await expect(pool.query(`INSERT INTO ${table('Child')} (parent_id, tag) VALUES ($1, $2)`, [parent, tag])).rejects.toMatchObject({ code: '23505' });
    await expect(pool.query(`UPDATE ${table('Child')} SET tag = $1 WHERE parent_id = $2`, [randomUUID(), parent])).rejects.toMatchObject({ code: '23503' });
    await expect(pool.query(`DELETE FROM ${table('Parent')} WHERE id = $1`, [parent])).rejects.toMatchObject({ code: '23503' });
    await expect(pool.query(`INSERT INTO ${table('Child')} (tag) VALUES ($1)`, [tag])).rejects.toMatchObject({ code: '23502' });
  });

  it('enforces embedded reference FKs and ordered ownership without cascading external entities', async () => {
    const parent = randomUUID();
    const tag = randomUUID();
    await pool.query(`INSERT INTO ${table('Parent')} (id, name, __contacts_state) VALUES ($1, $2, $3)`, [parent, 'With contacts', 'present']);
    await pool.query(`INSERT INTO ${table('Tag')} (id, label) VALUES ($1, $2)`, [tag, 'Contact tag']);
    const insert = `INSERT INTO ${table('Parent__contacts')} (__owner_id, __position, label, tag_id) VALUES ($1, $2, $3, $4)`;
    await expect(pool.query(insert, [parent, 0, 'Bad', randomUUID()])).rejects.toMatchObject({ code: '23503' });
    await pool.query(insert, [parent, 0, 'First', tag]);
    await pool.query(insert, [parent, 1, 'Duplicate allowed', tag]);
    await expect(pool.query(insert, [parent, 0, 'Position reused', tag])).rejects.toMatchObject({ code: '23505' });
    await expect(pool.query(insert, [parent, -1, 'Bad position', tag])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`DELETE FROM ${table('Tag')} WHERE id = $1`, [tag])).rejects.toMatchObject({ code: '23503' });
    await pool.query(`DELETE FROM ${table('Parent')} WHERE id = $1`, [parent]);
    expect((await pool.query(`SELECT * FROM ${table('Parent__contacts')} WHERE __owner_id = $1`, [parent])).rows).toHaveLength(0);
    expect((await pool.query(`SELECT * FROM ${table('Tag')} WHERE id = $1`, [tag])).rows).toHaveLength(1);
  });

  it('enforces enum, list-item and nullable unique constraints', async () => {
    await expect(pool.query(`INSERT INTO ${table('Parent')} (name, state) VALUES ($1, $2)`, ['Bad', 'UNKNOWN'])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`INSERT INTO ${table('Parent')} (name, ranks) VALUES ($1, $2)`, ['Bad', [1, null]])).rejects.toMatchObject({ code: '23514' });
    await pool.query(`INSERT INTO ${table('Tag')} DEFAULT VALUES`);
    await expect(pool.query(`INSERT INTO ${table('Tag')} DEFAULT VALUES`)).rejects.toMatchObject({ code: '23505' });
    await pool.query(`INSERT INTO ${table('Parent')} (name, states) VALUES ($1, $2)`, ['Nullable enum elements', ['OPEN', null]]);
    await expect(pool.query(`INSERT INTO ${table('Parent')} (name, states) VALUES ($1, $2)`, ['Bad enum element', ['UNKNOWN', null]])).rejects.toMatchObject({ code: '23514' });
  });

  it('detects disabled FK enforcement on both sides', async () => {
    for (const name of ['Child', 'Parent']) {
      await pool.query(`ALTER TABLE ${table(name)} DISABLE TRIGGER ALL`);
      try {
        await expect(initializeDatabase(pool, db, { mode: 'validate' })).rejects.toMatchObject({ extensions: { code: 'SCHEMA_MISMATCH' } });
      } finally { await pool.query(`ALTER TABLE ${table(name)} ENABLE TRIGGER ALL`); }
    }
  });

  it('rejects column, FK, check and index drift without silently repairing it', async () => {
    const description = describeDatabase(schemaFixture(), { schema: driftSchema });
    await initializeDatabase(pool, description);
    await pool.query(`ALTER TABLE "${driftSchema}"."Parent" ALTER COLUMN name DROP NOT NULL`);
    await expect(initializeDatabase(pool, description)).rejects.toMatchObject({ extensions: { code: 'SCHEMA_MISMATCH' } });
    await pool.query(`ALTER TABLE "${driftSchema}"."Parent" ALTER COLUMN name SET NOT NULL`);
    const child = description.tables.find((item) => item.name === 'Child');
    const fk = child.foreignKeys[0];
    await pool.query(`ALTER TABLE "${driftSchema}"."Child" DROP CONSTRAINT "${fk.name}"`);
    await pool.query(`ALTER TABLE "${driftSchema}"."Child" ADD CONSTRAINT "${fk.name}" FOREIGN KEY (parent_id) REFERENCES "${driftSchema}"."Parent"(id) ON DELETE CASCADE`);
    await expect(initializeDatabase(pool, description, { mode: 'validate' })).rejects.toMatchObject({ extensions: { code: 'SCHEMA_MISMATCH' } });
    await pool.query(`ALTER TABLE "${driftSchema}"."Child" DROP CONSTRAINT "${fk.name}"`);
    await pool.query(compileDatabaseSchema(description).find((sql) => sql.includes(`ADD CONSTRAINT "${fk.name}"`)));
    const check = description.tables.find((item) => item.name === 'Parent').checks.find((item) => item.name === 'Parent__state__enum');
    await pool.query(`ALTER TABLE "${driftSchema}"."Parent" DROP CONSTRAINT "${check.name}"`);
    await pool.query(`ALTER TABLE "${driftSchema}"."Parent" ADD CONSTRAINT "${check.name}" CHECK (state = 'OPEN')`);
    await expect(initializeDatabase(pool, description)).rejects.toMatchObject({ extensions: { code: 'SCHEMA_MISMATCH' } });
    await pool.query(`ALTER TABLE "${driftSchema}"."Parent" DROP CONSTRAINT "${check.name}"`);
    const version = (await pool.query('SELECT current_setting(\'server_version_num\')::integer AS version')).rows[0].version;
    if (version >= 180000) {
      await pool.query(`ALTER TABLE "${driftSchema}"."Parent" ADD CONSTRAINT "${check.name}" CHECK (${check.expression}) NOT ENFORCED`);
      await expect(initializeDatabase(pool, description)).rejects.toMatchObject({ extensions: { code: 'SCHEMA_MISMATCH' } });
      await pool.query(`ALTER TABLE "${driftSchema}"."Parent" DROP CONSTRAINT "${check.name}"`);
    }
    await pool.query(`ALTER TABLE "${driftSchema}"."Parent" ADD CONSTRAINT "${check.name}" CHECK (${check.expression})`);
    const index = child.indexes.find((item) => item.unique);
    await pool.query(`DROP INDEX "${driftSchema}"."${index.name}"`);
    await pool.query(`CREATE INDEX "${index.name}" ON "${driftSchema}"."Child" (parent_id, tag)`);
    await expect(initializeDatabase(pool, description)).rejects.toMatchObject({ extensions: { code: 'SCHEMA_MISMATCH' } });
  });

  it('serializes concurrent initializations of the same schema', async () => {
    const description = describeDatabase(schemaFixture(), { schema: concurrentSchema });
    const results = await Promise.all([initializeDatabase(pool, description), initializeDatabase(pool, description)]);
    expect(results.filter((result) => result.created.length > 0)).toHaveLength(1);
    expect(results.filter((result) => result.created.length === 0)).toHaveLength(1);
  });

  it('rejects existing orphan data and rolls back newly created tables', async () => {
    const description = describeDatabase(schemaFixture(), { schema: orphanSchema });
    const statements = compileDatabaseSchema(description);
    await pool.query(statements[0]);
    await pool.query(statements.find((sql) => sql.startsWith(`CREATE TABLE "${orphanSchema}"."Child"`)));
    await pool.query(`INSERT INTO "${orphanSchema}"."Child" (parent_id, tag) VALUES ($1, $2)`, [randomUUID(), randomUUID()]);
    await expect(initializeDatabase(pool, description)).rejects.toMatchObject({ code: '23503' });
    const tables = await pool.query('SELECT tablename FROM pg_tables WHERE schemaname = $1', [orphanSchema]);
    expect(tables.rows.map((row) => row.tablename)).toEqual(['Child']);
  });

  it('creates cyclic references in two phases and supports explicit deferral', async () => {
    const A = new GraphQLObjectType({ name: 'A', fields: () => ({ b: { type: new GraphQLNonNull(B), extensions: { relation: {} } } }) });
    const B = new GraphQLObjectType({ name: 'B', fields: () => ({ a: { type: new GraphQLNonNull(A), extensions: { relation: {} } } }) });
    const description = describeDatabase([{ gqltype: A }], { schema: cyclicSchema });
    await initializeDatabase(pool, description);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      const a = randomUUID(); const b = randomUUID();
      await client.query(`INSERT INTO "${cyclicSchema}"."A" (id, b) VALUES ($1, $2)`, [a, b]);
      await client.query(`INSERT INTO "${cyclicSchema}"."B" (id, a) VALUES ($1, $2)`, [b, a]);
      await client.query('COMMIT');
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

  it('executes exported DDL for the shared Mongo contract graph and validates nullable embedded rows', async () => {
    const { registrations } = createContractModelFixtures();
    const description = describeDatabase(registrations, { schema: contractSchema });
    for (const sql of compileDatabaseSchema(description)) await pool.query(sql);
    await initializeDatabase(pool, description, { mode: 'validate' });
    const owner = randomUUID();
    const contact = `"${contractSchema}"."ContractSerie__credits"`;
    await pool.query(`INSERT INTO "${contractSchema}"."ContractSerie" (id, tenant, title) VALUES ($1, $2, $3)`, [owner, 'T', 'Series']);
    await pool.query(`INSERT INTO ${contact} (__owner_id, __position, __item_present) VALUES ($1, 0, false)`, [owner]);
    await expect(pool.query(`INSERT INTO ${contact} (__owner_id, __position) VALUES ($1, 1)`, [owner])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`INSERT INTO ${contact} (__owner_id, __position, role, star) VALUES ($1, 2, $2, $3)`, [owner, 'Role', randomUUID()])).rejects.toMatchObject({ code: '23503' });
  });

  it('validate mode creates nothing, and failed initialization rolls back all DDL', async () => {
    const missing = `${schema}_missing`;
    await expect(initializeDatabase(pool, { ...db, schema: missing }, { mode: 'validate' })).rejects.toMatchObject({ extensions: { code: 'SCHEMA_MISMATCH' } });
    const broken = structuredClone(db);
    broken.schema = missing;
    broken.tables.find((item) => item.name === 'Child').foreignKeys[0].targetTable = 'Missing';
    await expect(initializeDatabase(pool, broken)).rejects.toThrow();
    expect((await pool.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [missing])).rowCount).toBe(0);
  });
});
