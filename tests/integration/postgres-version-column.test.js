import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GraphQLID, GraphQLObjectType, GraphQLString } from 'graphql';
import pg from 'pg';
import { createPostgres, describeDatabase, initializeDatabase } from '../../packages/postgres/src/index.js';

const uri = process.env.SIMFINITY_POSTGRES_URI;
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const mismatch = (schema, object = 'Producto', reason = 'column set differs') => `Schema mismatch at ${schema}.${object}: ${reason}. Apply an explicit migration before startup.`;
const missing = (schema, name = 'Producto') => `${name} declares optimistic concurrency (extensions.concurrency), so its table needs the version column. Migrate it: ALTER TABLE ${quote(schema)}.${quote(name)} ADD COLUMN "version" bigint NOT NULL DEFAULT 1;`;
const different = 'Producto declares optimistic concurrency (extensions.concurrency), so its table needs the version column defined as bigint NOT NULL DEFAULT 1.';
const leftover = (schema, name = 'Producto') => `${name} does not declare optimistic concurrency, but its table has the version column. If other instances of this application declare it, deploy the declaration here: while the column exists, instances without it cannot start. Otherwise, once no instance declares it: ALTER TABLE ${quote(schema)}.${quote(name)} DROP COLUMN "version";`;
const error = (message) => ({ message, extensions: { code: 'SCHEMA_MISMATCH', status: 409 } });
const product = (name = 'Producto') => new GraphQLObjectType({ name, fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });

describe.skipIf(!uri)('PostgreSQL version column initialization explanations', () => {
  let pool;
  const schemas = [];
  beforeAll(() => { pool = new pg.Pool({ connectionString: uri }); });
  afterAll(async () => {
    for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
    await pool.end();
  });
  const setup = async ({ quoted = false, names = ['Producto'] } = {}) => {
    const schema = `oc_version_${randomUUID().replaceAll('-', '')}${quoted ? '"odd' : ''}`;
    schemas.push(schema);
    const db = describeDatabase(names.map((name) => ({ gqltype: product(name) })), { schema });
    await initializeDatabase(pool, db);
    // Exercise the physical initializer independently of the planner, which Task 6 covers.
    const protectedDB = structuredClone(db);
    for (const table of protectedDB.tables) table.columns.push({ name: 'version', type: 'bigint', nullable: false, default: '1' });
    return { schema, db, protectedDB, target: `${quote(schema)}."Producto"` };
  };

  it.each(['create', 'validate'])('explains a missing column and validates after only the stated ALTER (%s)', async (mode) => {
    const { schema, protectedDB, target } = await setup({ quoted: true });
    const id = randomUUID();
    await pool.query(`INSERT INTO ${target} (id, name) VALUES ($1, $2)`, [id, 'existing']);
    await expect(initializeDatabase(pool, protectedDB, { mode })).rejects.toMatchObject(error(`${mismatch(schema)} ${missing(schema)}`));
    expect((await pool.query('SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3', [schema, 'Producto', 'version'])).rowCount).toBe(0);
    await pool.query(missing(schema).split('Migrate it: ')[1]);
    expect(await initializeDatabase(pool, protectedDB, { mode: 'validate' })).toEqual({ mode: 'validate', created: [] });
    const Type = new GraphQLObjectType({ ...product().toConfig(), extensions: { concurrency: { mode: 'optimistic' } } });
    const api = createPostgres({ pool, schema });
    api.connect(null, Type, 'product', 'products');
    api.createSchema();
    await api.initializeDatabase({ mode: 'validate' });
    expect(await api.getModel(Type).findById(id)).toMatchObject({ name: 'existing', version: 1 });
  });

  it.each([
    'ADD COLUMN version integer NOT NULL DEFAULT 1',
    'ADD COLUMN version bigint DEFAULT 1',
    'ADD COLUMN version bigint NOT NULL DEFAULT 2',
    'ADD COLUMN version bigint GENERATED ALWAYS AS IDENTITY',
  ])('states the expected definition for a different stored definition: %s', async (alter) => {
    const { schema, protectedDB, target } = await setup();
    await pool.query(`ALTER TABLE ${target} ${alter}`);
    const message = `${mismatch(schema, 'Producto.version', 'column type, collation, nullability or default differs')} ${different}`;
    await expect(initializeDatabase(pool, protectedDB, { mode: 'validate' })).rejects.toMatchObject(error(message));
    expect(message).not.toContain('ADD COLUMN');
    expect(message).not.toContain('DROP COLUMN');
  });

  it.each(['create', 'validate'])('explains a leftover column without changing it (%s)', async (mode) => {
    const { schema, db, target } = await setup();
    await pool.query(`ALTER TABLE ${target} ADD COLUMN version bigint NOT NULL DEFAULT 1`);
    await expect(initializeDatabase(pool, db, { mode })).rejects.toMatchObject(error(`${mismatch(schema)} ${leftover(schema)}`));
    expect((await pool.query(`SELECT version FROM ${target}`)).fields.map((field) => field.name)).toEqual(['version']);
  });

  it('explains a missing version even when another extra column keeps the column count equal', async () => {
    const { schema, protectedDB, target } = await setup();
    await pool.query(`ALTER TABLE ${target} ADD COLUMN extra text`);
    await expect(initializeDatabase(pool, protectedDB, { mode: 'validate' })).rejects.toMatchObject(error(`${mismatch(schema, 'Producto.version', 'column type, collation, nullability or default differs')} ${missing(schema)}`));
  });

  it('explains a leftover version even when a missing field keeps the column count equal', async () => {
    const { schema, db, target } = await setup();
    await pool.query(`ALTER TABLE ${target} DROP COLUMN name, ADD COLUMN version bigint NOT NULL DEFAULT 1`);
    await expect(initializeDatabase(pool, db, { mode: 'validate' })).rejects.toMatchObject(error(`${mismatch(schema, 'Producto.name', 'column type, collation, nullability or default differs')} ${leftover(schema)}`));
  });

  it('collects version explanations across every entity table', async () => {
    const { schema, protectedDB } = await setup({ names: ['Producto', 'Warehouse'] });
    await expect(initializeDatabase(pool, protectedDB, { mode: 'validate' })).rejects.toMatchObject(error(`${mismatch(schema)} ${missing(schema)} ${missing(schema, 'Warehouse')}`));
  });

  it('joins the version and virtual-field leftover explanations', async () => {
    const { initializeDatabase: initializeSchema } = await import('../../packages/postgres/src/schema/initialize.js');
    const { schema, protectedDB, target } = await setup();
    await pool.query(`ALTER TABLE ${target} ADD COLUMN score text`);
    const context = { virtualFields: [{ table: 'Producto', name: 'score', field: 'Producto.score', path: [] }] };
    const virtual = `Producto.score is virtual (extensions.virtual), so it is never stored, but this database still holds its earlier storage. Once nothing reads that storage, migrate it: ALTER TABLE ${target} DROP COLUMN "score"; See the upgrade notes at https://simtlix.github.io/simfinity.js/resources/compatibility.html`;
    await expect(initializeSchema(pool, protectedDB, { mode: 'validate' }, context)).rejects.toMatchObject(error(`${mismatch(schema, 'Producto.version', 'column type, collation, nullability or default differs')} ${missing(schema)} ${virtual}`));
  });

  it('pin: a matching version adds nothing to an unrelated mismatch', async () => {
    const { schema, protectedDB, target } = await setup();
    await pool.query(`ALTER TABLE ${target} ADD COLUMN version bigint NOT NULL DEFAULT 1, ALTER COLUMN name TYPE varchar(20)`);
    await expect(initializeDatabase(pool, protectedDB, { mode: 'validate' })).rejects.toMatchObject(error(mismatch(schema, 'Producto.name', 'column type, collation, nullability or default differs')));
  });

  it('pin: a non-bigint application version column adds no concurrency explanation', async () => {
    const { schema, db, target } = await setup();
    await pool.query(`ALTER TABLE ${target} ADD COLUMN version text`);
    await expect(initializeDatabase(pool, db, { mode: 'validate' })).rejects.toMatchObject(error(mismatch(schema)));
  });

  it.each(['create', 'validate'])('pin: a described business version with bigint storage drift keeps its generic mismatch (%s)', async (mode) => {
    const { schema, db, target } = await setup();
    db.tables[0].columns.push({ name: 'version', type: 'text', nullable: true, collation: 'C' });
    await pool.query(`ALTER TABLE ${target} ADD COLUMN version bigint`);
    await expect(initializeDatabase(pool, db, { mode })).rejects.toMatchObject(error(mismatch(schema, 'Producto.version', 'column type, collation, nullability or default differs')));
  });

  it.each(['ownership', 'auxiliary'])('pin: private %s tables add no concurrency explanation', async (kind) => {
    const { schema, db, target } = await setup();
    db.tables[0][kind] = kind === 'ownership' ? { ownerTable: 'Other' } : { rootTable: 'Other' };
    await pool.query(`ALTER TABLE ${target} ADD COLUMN version bigint NOT NULL DEFAULT 1`);
    await expect(initializeDatabase(pool, db, { mode: 'validate' })).rejects.toMatchObject(error(mismatch(schema)));
  });
});
