import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GraphQLObjectType, GraphQLString, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLEnumType, GraphQLScalarType, graphql } from 'graphql';
import pg from 'pg';
import mongoose from 'mongoose';
import { createMongoModel } from '../../packages/mongodb/src/mongo/models.js';
import { createPostgres, describeDatabase, initializeDatabase, compileDatabaseSchema } from '../../packages/postgres/src/index.js';

const uri = process.env.SIMFINITY_POSTGRES_URI;
const embedded = { relation: { embedded: true } };
const unique = { unique: true };
const Code = new GraphQLObjectType({ name: 'ConstraintCode', fields: { code: { type: GraphQLString, extensions: unique } } });
const Codes = new GraphQLObjectType({ name: 'ConstraintCodes', fields: { codes: { type: new GraphQLList(GraphQLString), extensions: unique } } });
const Branch = new GraphQLObjectType({ name: 'ConstraintBranch', fields: { leaves: { type: new GraphQLList(Code), extensions: embedded } } });
const DateTime = new GraphQLScalarType({ name: 'DateTime', serialize: (value) => value });
const State = new GraphQLEnumType({ name: 'ConstraintState', values: { OPEN: {}, CLOSED: {} } });
const Value = new GraphQLObjectType({ name: 'ConstraintValue', fields: { required: { type: new GraphQLNonNull(GraphQLString) }, count: { type: GraphQLInt }, time: { type: DateTime }, state: { type: State }, names: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) } } });
const StrictValue = new GraphQLObjectType({ name: 'ConstraintStrictValue', fields: {
  text: { type: new GraphQLNonNull(GraphQLString) },
  data: { type: new GraphQLNonNull(Value), extensions: embedded },
  leaves: { type: new GraphQLNonNull(new GraphQLList(Code)), extensions: embedded },
} });
const types = {
  Strict: new GraphQLObjectType({ name: 'ConstraintStrict', fields: { entries: { type: new GraphQLNonNull(new GraphQLList(StrictValue)), extensions: embedded } } }),
  Owner: new GraphQLObjectType({ name: 'ConstraintOwner', fields: { entries: { type: new GraphQLList(Code), extensions: embedded } } }),
  Nested: new GraphQLObjectType({ name: 'ConstraintNested', fields: { branches: { type: new GraphQLList(Branch), extensions: embedded } } }),
  Arrays: new GraphQLObjectType({ name: 'ConstraintArrays', fields: { entries: { type: new GraphQLList(Codes), extensions: embedded } } }),
  Native: new GraphQLObjectType({ name: 'ConstraintNative', fields: { codes: { type: new GraphQLList(GraphQLString), extensions: unique } } }),
  Shape: new GraphQLObjectType({ name: 'ConstraintShape', fields: { nativeTime: { type: DateTime }, value: { type: Value, extensions: embedded }, values: { type: new GraphQLList(Value), extensions: embedded } } }),
  Singular: new GraphQLObjectType({ name: 'ConstraintSingular', fields: { entry: { type: Code, extensions: embedded } } }),
};

describe.skipIf(!uri)('database-enforced embedded constraints', () => {
  let pool; let api; let schema; let db;
  const namespace = `constraints_${randomUUID().replaceAll('-', '')}`;
  const sqlTable = (name) => `"${namespace}"."${name}"`;
  const model = (name) => api.getModel(types[name]);
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: uri });
    api = createPostgres({ pool, schema: namespace });
    for (const [name, gqltype] of Object.entries(types)) api.connect(null, gqltype, name.toLowerCase(), `${name.toLowerCase()}s`);
    for (const gqltype of [Code, Codes, Branch, Value, StrictValue]) api.addNoEndpointType(gqltype);
    schema = api.createSchema();
    db = api.describeDatabase();
    await api.initializeDatabase();
  });
  beforeEach(async () => { await pool.query(`TRUNCATE ${db.tables.map((t) => sqlTable(t.name)).join(', ')} CASCADE`); });
  afterAll(async () => { await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); await pool.end(); });

  it('allows repeated owner keys, rejects another owner, and frees replaced/deleted keys', async () => {
    const a = await model('Owner').create({ entries: [{ code: 'x' }, { code: 'x' }] });
    await expect(model('Owner').create({ entries: [{ code: 'x' }] })).rejects.toMatchObject({ extensions: { code: 'DUPLICATE_KEY' } });
    await model('Owner').update(a.id, { entries: [{ code: 'y' }] });
    await model('Owner').create({ entries: [{ code: 'x' }] });
    await model('Owner').delete(a.id);
    await model('Owner').create({ entries: [{ code: 'y' }] });
    expect(await model('Owner').find()).toHaveLength(2);
  });

  it('enforces native scalar-list multikey uniqueness', async () => {
    await model('Native').create({ codes: ['x', 'x'] });
    await expect(model('Native').create({ codes: ['x'] })).rejects.toMatchObject({ extensions: { code: 'DUPLICATE_KEY' } });
  });

  it('validates JSONB nested scalar, enum, required and list shapes in SQL', async () => {
    for (const value of [{}, { required: null }, { required: 7 }, { required: 'x', count: 1.2 }, { required: 'x', time: 'today' }, { required: 'x', state: 'BAD' }, { required: 'x', names: 'bad' }, { required: 'x', names: [null] }, []]) {
      await expect(pool.query(`INSERT INTO ${sqlTable('ConstraintShape')} (value) VALUES ($1::jsonb)`, [JSON.stringify(value)])).rejects.toMatchObject({ code: '23514' });
    }
    for (const value of [null, { required: 'x' }, { required: 'x', count: null, names: [], time: '2026-09-12T10:00:00.000Z' }]) await pool.query(`INSERT INTO ${sqlTable('ConstraintShape')} (value, values) VALUES ($1::jsonb, '[null]')`, [JSON.stringify(value)]);
  });

  it.each(['0000-01-01T00:00:00.000Z', '+010000-01-01T00:00:00.000Z', '-000001-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'])('accepts the same runtime DateTime in native and JSONB storage: %s', async (iso) => {
    const time = new Date(iso);
    const native = await model('Shape').create({ nativeTime: time, value: null });
    expect(native.nativeTime.toISOString()).toBe(iso);
    const json = await model('Shape').create({ value: { required: 'date', time } });
    expect(json.value.time.toISOString()).toBe(iso);
    expect((await model('Shape').findById(json.id)).value.time.toISOString()).toBe(iso);
  });

  it('enforces required descendants when inline array defaults materialize an optional parent', async () => {
    await expect(model('Shape').create({})).rejects.toMatchObject({ extensions: { code: 'REQUIRED_VALUE' } });
    for (const input of ['{}', '{value:null}']) {
      const result = await graphql({ schema, source: `mutation{addshape(input:${input}){nativeTime}}` });
      expect(result.errors?.[0].extensions.code).toBe('REQUIRED_VALUE');
    }
    const valid = await graphql({ schema, source: 'mutation{addshape(input:{value:{required:"provided"}}){value{required names}}}' });
    expect(valid.errors).toBeUndefined();
    expect(valid.data.addshape.value).toEqual({ required: 'provided', names: [] });
  });

  it('validates ISO calendar components and the full finite JavaScript Date range in SQL', async () => {
    for (const iso of ['0000-02-29T00:00:00.000Z', '+010000-02-29T23:59:59.999Z', '-271821-04-20T00:00:00.000Z', '+275760-09-13T00:00:00.000Z']) {
      const value = { required: 'date', time: iso };
      expect(Number.isFinite(new Date(iso).getTime())).toBe(true);
      await pool.query(`INSERT INTO ${sqlTable('ConstraintShape')} (value) VALUES ($1::jsonb)`, [JSON.stringify(value)]);
    }
    for (const iso of ['today', '0000-02-30T00:00:00.000Z', '+010001-02-29T00:00:00.000Z', '2026-01-01T24:00:00.000Z', '2026-01-01T00:60:00.000Z', '2026-01-01T00:00:60.000Z', '-271821-04-19T23:59:59.999Z', '+275760-09-13T00:00:00.001Z', '-000000-01-01T00:00:00.000Z']) {
      await expect(pool.query(`INSERT INTO ${sqlTable('ConstraintShape')} (value) VALUES ($1::jsonb)`, [JSON.stringify({ required: 'date', time: iso })])).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('rejects incomplete singular values at transaction end', async () => {
    await expect(pool.query(`INSERT INTO ${sqlTable('ConstraintSingular')} (__entry_state) VALUES ('present')`)).rejects.toMatchObject({ code: '23514' });
  });

  it('maintains nested-tree keys and rolls back failed generated mutations', async () => {
    const input = { branches: [{ leaves: [{ code: 'deep' }, { code: 'deep' }] }] };
    const a = await model('Nested').create(input);
    await expect(model('Nested').create(input)).rejects.toMatchObject({ extensions: { code: 'DUPLICATE_KEY' } });
    await model('Nested').update(a.id, { branches: [{ leaves: [{ code: 'other' }] }] });
    await model('Nested').create(input);
    const result = await graphql({ schema, source: 'mutation { addowner(input:{entries:[{code:"g"},{code:"g"}]}) { entries { code } } }' });
    expect(result.errors).toBeUndefined();
    const rejected = await graphql({ schema, source: 'mutation { addowner(input:{entries:[{code:"g"},{code:"new"}]}) { entries { code } } }' });
    expect(rejected.errors?.[0].extensions.code).toBe('DUPLICATE_KEY');
    expect(await model('Owner').find()).toHaveLength(1);
    await model('Owner').create({ entries: [{ code: 'new' }] });
  });

  it('distinguishes terminal empty arrays from null/missing/empty ancestors', async () => {
    const nullCases = [{}, { entries: null }, { entries: [] }, { entries: [null] }, { entries: [{}] }, { entries: [{ codes: null }] }, { entries: [{ codes: [null] }] }];
    // Native model writes materialize omitted scalar lists as [], as Mongoose does.
    const directCases = nullCases.filter((value) => JSON.stringify(value) !== '{"entries":[{}]}');
    for (const value of directCases) {
      const first = await model('Arrays').create(value);
      await expect(model('Arrays').create({ entries: [{ codes: null }] })).rejects.toMatchObject({ extensions: { code: 'DUPLICATE_KEY' } });
      const empty = await model('Arrays').create({ entries: [{ codes: [] }] });
      await expect(model('Arrays').create({ entries: [{}] })).rejects.toMatchObject({ extensions: { code: 'DUPLICATE_KEY' } });
      await model('Arrays').delete(first.id); await model('Arrays').delete(empty.id);
    }
    const scalarCases = [{}, { entries: null }, { entries: [] }, { entries: [null] }, { entries: [{}] }, { entries: [{ code: null }] }];
    for (const value of scalarCases) {
      const owner = await model('Owner').create(value);
      await expect(model('Owner').create({ entries: [{ code: null }] })).rejects.toMatchObject({ extensions: { code: 'DUPLICATE_KEY' } });
      await model('Owner').delete(owner.id);
    }
    await model('Native').create({ codes: [null, null] });
    await model('Native').create({ codes: [] });
    await expect(model('Native').create({ codes: null })).rejects.toMatchObject({ extensions: { code: 'DUPLICATE_KEY' } });
  });

  it('enforces unique keys and owned shapes for direct SQL updates, inserts and deletes', async () => {
    const a = await model('Owner').create({ entries: [{ code: 'a' }, { code: 'b' }] });
    const b = await model('Owner').create({ entries: [{ code: 'c' }] });
    const entries = sqlTable('ConstraintOwner__entries');
    await expect(pool.query(`UPDATE ${entries} SET code = 'a' WHERE __owner_id = $1`, [b.id])).rejects.toMatchObject({ code: '23505' });
    await expect(pool.query(`INSERT INTO ${entries} (__owner_id, __position, code) VALUES ($1, 2, 'gap')`, [b.id])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`DELETE FROM ${entries} WHERE __owner_id = $1 AND __position = 0`, [a.id])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`UPDATE ${sqlTable('ConstraintOwner')} SET __entries_state = 'null' WHERE id = $1`, [a.id])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`UPDATE ${entries} SET __item_present = false WHERE __owner_id = $1`, [b.id])).rejects.toMatchObject({ code: '23514' });
    await pool.query(`UPDATE ${entries} SET code = 'freed' WHERE __owner_id = $1`, [b.id]);
    await model('Owner').create({ entries: [{ code: 'c' }] });
    const singular = await model('Singular').create({ entry: { code: 's' } });
    await expect(pool.query(`DELETE FROM ${sqlTable('ConstraintSingular__entry')} WHERE __owner_id = $1`, [singular.id])).rejects.toMatchObject({ code: '23514' });
  });

  it('prevents concurrent owners from committing the same key', async () => {
    const clients = await Promise.all([pool.connect(), pool.connect()]);
    try {
      await Promise.all(clients.map((client) => client.query('BEGIN')));
      await Promise.all(clients.map((client) => client.query(`INSERT INTO ${sqlTable('ConstraintNative')} (codes) VALUES (ARRAY['race'])`)));
      const commits = await Promise.allSettled(clients.map((client) => client.query('COMMIT')));
      expect(commits.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(commits.find((result) => result.status === 'rejected').reason.code).toBe('23505');
    } finally { for (const client of clients) { await client.query('ROLLBACK'); client.release(); } }
  });

  it.each(['READ COMMITTED', 'REPEATABLE READ'])('serializes independent same-owner child writes under %s', async (isolation) => {
    const owner = await model('Owner').create({ entries: [{ code: 'a' }, { code: 'b' }] });
    const [a, b] = await Promise.all([pool.connect(), pool.connect()]);
    try {
      await a.query(`BEGIN ISOLATION LEVEL ${isolation}`); await b.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      await b.query(`SELECT * FROM ${sqlTable('ConstraintOwner__entries')}`);
      await a.query(`UPDATE ${sqlTable('ConstraintOwner__entries')} SET code = 'new-a' WHERE __owner_id = $1 AND __position = 0`, [owner.id]);
      const waiting = b.query(`UPDATE ${sqlTable('ConstraintOwner__entries')} SET code = 'new-b' WHERE __owner_id = $1 AND __position = 1`, [owner.id]).then(() => ({ ok: true }), (error) => ({ error }));
      await a.query('COMMIT');
      const result = await waiting;
      if (isolation === 'REPEATABLE READ') expect(result.error?.code).toBe('40001');
      else { expect(result.ok).toBe(true); await b.query('COMMIT'); }
      await expect(model('Owner').create({ entries: [{ code: 'new-a' }] })).rejects.toMatchObject({ extensions: { code: 'DUPLICATE_KEY' } });
      if (isolation === 'READ COMMITTED') await expect(model('Owner').create({ entries: [{ code: 'new-b' }] })).rejects.toMatchObject({ extensions: { code: 'DUPLICATE_KEY' } });
    } finally { await a.query('ROLLBACK'); await b.query('ROLLBACK'); a.release(); b.release(); }
  });

  it('detects missing, disabled and replaced triggers and function drift without repairing it', async () => {
    const trigger = db.triggers.find((item) => item.constraint);
    const relation = sqlTable(trigger.table);
    await pool.query(`ALTER TABLE ${relation} DISABLE TRIGGER "${trigger.name}"`);
    await expect(initializeDatabase(pool, db)).rejects.toMatchObject({ extensions: { code: 'SCHEMA_MISMATCH' } });
    await pool.query(`ALTER TABLE ${relation} ENABLE TRIGGER "${trigger.name}"`);
    await pool.query(`DROP TRIGGER "${trigger.name}" ON ${relation}`);
    await expect(initializeDatabase(pool, db, { mode: 'validate' })).rejects.toMatchObject({ extensions: { code: 'SCHEMA_MISMATCH' } });
    await initializeDatabase(pool, db);
    const fn = db.functions.find((item) => item.name === trigger.function);
    await pool.query(`ALTER FUNCTION ${sqlTable(fn.name)}() SECURITY DEFINER`);
    await expect(initializeDatabase(pool, db)).rejects.toMatchObject({ extensions: { code: 'SCHEMA_MISMATCH' } });
    await pool.query(`ALTER FUNCTION ${sqlTable(fn.name)}() SECURITY INVOKER`);
    const original = compileDatabaseSchema(db).find((statement) => statement.startsWith(`CREATE FUNCTION ${sqlTable(fn.name)}(`));
    await pool.query(original.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION').replace(fn.body.replaceAll('\'', '\'\''), 'BEGIN RETURN NULL; END'));
    await expect(initializeDatabase(pool, db)).rejects.toMatchObject({ extensions: { code: 'SCHEMA_MISMATCH' } });
    await pool.query(original.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'));
  });

  it('rebuilds stale keys from swapped sources and restores old keys on actual duplicate recovery failure', async () => {
    const a = await model('Native').create({ codes: ['a'] });
    const b = await model('Native').create({ codes: ['b'] });
    const trigger = db.triggers.find((item) => item.table === 'ConstraintNative' && item.constraint);
    const keys = sqlTable(db.tables.find((item) => item.uniqueKeys?.rootTable === 'ConstraintNative').name);
    const keyRows = async () => (await pool.query(`SELECT * FROM ${keys} ORDER BY __owner_id, kind, value`)).rows;
    const initialKeys = await keyRows();
    await pool.query(`DROP TRIGGER "${trigger.name}" ON ${sqlTable('ConstraintNative')}`);
    await pool.query(`UPDATE ${sqlTable('ConstraintNative')} SET codes = CASE WHEN id = $1 THEN ARRAY['b'] ELSE ARRAY['a'] END`, [a.id]);
    await expect(initializeDatabase(pool, db, { mode: 'validate' })).rejects.toMatchObject({ extensions: { code: 'SCHEMA_MISMATCH' } });
    expect(await keyRows()).toEqual(initialKeys);
    await initializeDatabase(pool, db);
    expect((await keyRows()).map(({ __owner_id: owner, value }) => ({ owner, value }))).toEqual([
      { owner: a.id, value: 'b' }, { owner: b.id, value: 'a' },
    ].sort((left, right) => left.owner.localeCompare(right.owner)));
    const rebuiltKeys = await keyRows();
    await pool.query(`DROP TRIGGER "${trigger.name}" ON ${sqlTable('ConstraintNative')}`);
    await pool.query(`UPDATE ${sqlTable('ConstraintNative')} SET codes = ARRAY['duplicate']`);
    await expect(initializeDatabase(pool, db)).rejects.toMatchObject({ code: '23505' });
    expect(await keyRows()).toEqual(rebuiltKeys);
    expect((await pool.query('SELECT 1 FROM pg_trigger WHERE tgrelid = $1::regclass AND tgname = $2', [sqlTable('ConstraintNative'), trigger.name])).rowCount).toBe(0);
    await pool.query(`UPDATE ${sqlTable('ConstraintNative')} SET codes = CASE WHEN id = $1 THEN ARRAY['b'] ELSE ARRAY['a'] END`, [a.id]);
    await initializeDatabase(pool, db);
    expect(await initializeDatabase(pool, db, { mode: 'validate' })).toEqual({ mode: 'validate', created: [] });
  });

  it('rolls back generated objects and unique-key backfill on preexisting duplicate owners', async () => {
    const name = `${namespace}_backfill`;
    const description = describeDatabase([{ gqltype: types.Native }], { schema: name });
    const ddl = compileDatabaseSchema(description);
    await pool.query(ddl[0]);
    await pool.query(ddl.find((statement) => statement.startsWith(`CREATE TABLE "${name}"."ConstraintNative" (`)));
    try {
      await pool.query(`INSERT INTO "${name}"."ConstraintNative" (codes) VALUES (ARRAY['x']), (ARRAY['x'])`);
      await expect(initializeDatabase(pool, description)).rejects.toMatchObject({ code: '23505' });
      expect((await pool.query('SELECT tablename FROM pg_tables WHERE schemaname = $1', [name])).rows).toEqual([{ tablename: 'ConstraintNative' }]);
      expect((await pool.query('SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1', [name])).rowCount).toBe(0);
      await pool.query(`DELETE FROM "${name}"."ConstraintNative" WHERE id = (SELECT id FROM "${name}"."ConstraintNative" LIMIT 1)`);
      await initializeDatabase(pool, description);
      await expect(pool.query(`INSERT INTO "${name}"."ConstraintNative" (codes) VALUES (ARRAY['x'])`)).rejects.toMatchObject({ code: '23505' });
    } finally { await pool.query(`DROP SCHEMA "${name}" CASCADE`); }
  });

  it('allows required empty owned lists and nullable items but checks required payload when present', async () => {
    const empty = await model('Strict').create({ entries: [] });
    await model('Strict').update(empty.id, { entries: [null] });
    await model('Strict').update(empty.id, { entries: [{ text: 'x', data: { required: 'yes' }, leaves: [] }] });
    const entries = sqlTable('ConstraintStrict__entries');
    await expect(pool.query(`UPDATE ${entries} SET __leaves_state = 'missing' WHERE __owner_id = $1`, [empty.id])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`UPDATE ${entries} SET data = '{"required":5}'::jsonb WHERE __owner_id = $1`, [empty.id])).rejects.toMatchObject({ code: '23514' });
    await model('Strict').update(empty.id, { entries: [null] });
    const row = (await pool.query(`SELECT __id FROM ${entries} WHERE __owner_id = $1`, [empty.id])).rows[0];
    await expect(pool.query(`INSERT INTO ${sqlTable('ConstraintStrict__entries__leaves')} (__owner_id, __position, code) VALUES ($1, 0, 'hidden')`, [row.__id])).rejects.toMatchObject({ code: '23514' });
  });

  it('recreates missing functions only in create mode and rejects wrong signatures and trigger deferral', async () => {
    const validator = db.functions.find((item) => item.returns === 'boolean' && item.name.includes('required'));
    await pool.query(`DROP FUNCTION ${sqlTable(validator.name)}(jsonb)`);
    await expect(initializeDatabase(pool, db, { mode: 'validate' })).rejects.toMatchObject({ extensions: { code: 'SCHEMA_MISMATCH' } });
    await initializeDatabase(pool, db);
    await pool.query(`CREATE FUNCTION ${sqlTable(validator.name)}(text) RETURNS boolean LANGUAGE sql AS 'SELECT true'`);
    await expect(initializeDatabase(pool, db)).rejects.toMatchObject({ extensions: { code: 'SCHEMA_MISMATCH' } });
    await pool.query(`DROP FUNCTION ${sqlTable(validator.name)}(text)`);
    const trigger = db.triggers.find((item) => item.constraint);
    const ddl = compileDatabaseSchema(db).find((statement) => statement.startsWith(`CREATE CONSTRAINT TRIGGER "${trigger.name}"`));
    await pool.query(`DROP TRIGGER "${trigger.name}" ON ${sqlTable(trigger.table)}`);
    await pool.query(ddl.replace('INITIALLY DEFERRED', 'INITIALLY IMMEDIATE'));
    await expect(initializeDatabase(pool, db)).rejects.toMatchObject({ extensions: { code: 'SCHEMA_MISMATCH' } });
    await pool.query(`DROP TRIGGER "${trigger.name}" ON ${sqlTable(trigger.table)}`);
    await pool.query(ddl);
    const touch = db.triggers.find((item) => !item.constraint);
    await pool.query(`ALTER TABLE ${sqlTable(touch.table)} DISABLE TRIGGER "${touch.name}"`);
    await expect(initializeDatabase(pool, db)).rejects.toMatchObject({ extensions: { code: 'SCHEMA_MISMATCH' } });
    await pool.query(`ALTER TABLE ${sqlTable(touch.table)} ENABLE TRIGGER "${touch.name}"`);
  });

  it('handles user columns named owner_id and quoted schemas without trigger variable capture', async () => {
    const name = `${namespace}_'"`;
    const Names = new GraphQLObjectType({ name: 'ConstraintNames', fields: { owner_id: { type: GraphQLString }, keys: { type: new GraphQLList(GraphQLString), extensions: unique } } });
    const description = describeDatabase([{ gqltype: Names }], { schema: name });
    const quoted = `"${name.replaceAll('"', '""')}"`;
    try {
      await initializeDatabase(pool, description);
      await pool.query(`INSERT INTO ${quoted}."ConstraintNames" (owner_id, keys) VALUES ('text', ARRAY['x'])`);
      await expect(pool.query(`INSERT INTO ${quoted}."ConstraintNames" (owner_id, keys) VALUES ('other', ARRAY['x'])`)).rejects.toMatchObject({ code: '23505' });
      await initializeDatabase(pool, description, { mode: 'validate' });
    } finally { await pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`); }
  });

  it('rolls back missing constraint infrastructure when existing owned values are incomplete', async () => {
    const name = `${namespace}_incomplete`;
    const description = describeDatabase([{ gqltype: types.Singular }], { schema: name });
    const ddl = compileDatabaseSchema(description);
    await pool.query(ddl[0]);
    const sourceTables = description.tables.filter((table) => !table.auxiliary);
    for (const table of sourceTables) await pool.query(ddl.find((statement) => statement.startsWith(`CREATE TABLE "${name}"."${table.name}" (`)));
    try {
      await pool.query(`INSERT INTO "${name}"."ConstraintSingular" (__entry_state) VALUES ('present')`);
      await expect(initializeDatabase(pool, description)).rejects.toMatchObject({ code: '23514' });
      expect((await pool.query('SELECT tablename FROM pg_tables WHERE schemaname = $1', [name])).rowCount).toBe(sourceTables.length);
      expect((await pool.query('SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1', [name])).rowCount).toBe(0);
    } finally { await pool.query(`DROP SCHEMA "${name}" CASCADE`); }
  });

  it('exports safe function literals even when the caller disables standard-conforming strings', async () => {
    const name = `${namespace}_\\'`;
    const description = describeDatabase([{ gqltype: types.Native }], { schema: name });
    const quoted = `"${name.replaceAll('"', '""')}"`;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL standard_conforming_strings = \'off\'');
      for (const statement of compileDatabaseSchema(description)) await client.query(statement);
      await client.query('COMMIT');
      await pool.query(`INSERT INTO ${quoted}."ConstraintNative" (codes) VALUES ($1)`, [['x']]);
      await initializeDatabase(pool, description, { mode: 'validate' });
    } finally { await client.query('ROLLBACK'); client.release(); await pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`); }
  });

  it.each(['READ COMMITTED', 'REPEATABLE READ'])('prevents shape-only write skew without any unique leaf under %s', async (isolation) => {
    const name = `${namespace}_skew`;
    const Target = new GraphQLObjectType({ name: 'ShapeTarget', fields: { value: { type: GraphQLString } } });
    const Item = new GraphQLObjectType({ name: 'ShapeItem', fields: { target: { type: Target, extensions: { relation: {} } } } });
    const Owner = new GraphQLObjectType({ name: 'ShapeOwner', fields: { items: { type: new GraphQLList(Item), extensions: embedded } } });
    const description = describeDatabase([{ gqltype: Owner }], { schema: name });
    expect(description.tables.some((table) => table.uniqueKeys)).toBe(false);
    const entries = `"${name}"."ShapeOwner__items"`;
    const [a, b] = await Promise.all([pool.connect(), pool.connect()]);
    try {
      await initializeDatabase(pool, description);
      const owner = (await pool.query(`INSERT INTO "${name}"."ShapeOwner" (__items_state) VALUES ('present') RETURNING id`)).rows[0].id;
      await pool.query(`INSERT INTO ${entries} (__owner_id, __position) VALUES ($1, 0), ($1, 1)`, [owner]);
      await a.query(`BEGIN ISOLATION LEVEL ${isolation}`); await b.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      await b.query(`SELECT * FROM ${entries}`);
      await a.query(`INSERT INTO ${entries} (__owner_id, __position) VALUES ($1, 2)`, [owner]);
      // Each change alone has consecutive positions; their union would leave [0, 2].
      const waiting = b.query(`DELETE FROM ${entries} WHERE __owner_id = $1 AND __position = 1`, [owner]).then(() => ({ ok: true }), (error) => ({ error }));
      await a.query('COMMIT');
      const result = await waiting;
      if (isolation === 'REPEATABLE READ') expect(result.error?.code).toBe('40001');
      else { expect(result.ok).toBe(true); await expect(b.query('COMMIT')).rejects.toMatchObject({ code: '23514' }); }
      expect((await pool.query(`SELECT __position FROM ${entries} ORDER BY __position`)).rows.map((row) => row.__position)).toEqual([0, 1, 2]);
    } finally { await a.query('ROLLBACK'); await b.query('ROLLBACK'); a.release(); b.release(); await pool.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`); }
  });

  it('describes generated functions and triggers deterministically and validates them', async () => {
    expect(db.functions.length).toBeGreaterThan(0);
    expect(db.triggers.length).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(db))).toEqual(db);
    expect(await initializeDatabase(pool, db, { mode: 'validate' })).toEqual({ mode: 'validate', created: [] });
    expect(await initializeDatabase(pool, db)).toEqual({ mode: 'create', created: [] });
  });
});

const mongoUri = process.env.SIMFINITY_MONGODB_URI;
describe.skipIf(!uri || !mongoUri)('Mongo/PostgreSQL multikey differential', () => {
  let pool; let api; let mongoOwner; let mongoArrays; let mongoNested;
  const name = `multikey_${randomUUID().replaceAll('-', '')}`;
  beforeAll(async () => {
    await mongoose.connect(mongoUri, { dbName: name });
    mongoOwner = createMongoModel(types.Owner, null, { createCollection: false });
    mongoArrays = createMongoModel(types.Arrays, null, { createCollection: false });
    mongoNested = createMongoModel(types.Nested, null, { createCollection: false });
    await Promise.all([mongoOwner.init(), mongoArrays.init(), mongoNested.init()]);
    expect(mongoOwner.schema.indexes()).toEqual(expect.arrayContaining([[{ 'entries.code': 1 }, expect.objectContaining({ unique: true })]]));
    expect(mongoNested.schema.indexes()).toEqual(expect.arrayContaining([[{ 'branches.leaves.code': 1 }, expect.objectContaining({ unique: true })]]));
    expect(mongoArrays.schema.indexes()).toEqual([]);
    await mongoArrays.collection.createIndex({ 'entries.codes': 1 }, { unique: true });
    pool = new pg.Pool({ connectionString: uri });
    api = createPostgres({ pool, schema: name });
    for (const key of ['Owner', 'Arrays', 'Nested']) api.connect(null, types[key], key.toLowerCase(), `${key.toLowerCase()}s`);
    for (const gqltype of [Code, Codes, Branch]) api.addNoEndpointType(gqltype);
    api.createSchema(); await api.initializeDatabase();
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase(); await mongoose.disconnect();
    for (const type of [types.Owner, types.Arrays, types.Nested]) mongoose.deleteModel(type.name);
    if (pool) { await pool.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`); await pool.end(); }
  });
  const clear = async () => {
    await Promise.all([mongoOwner.deleteMany({}), mongoArrays.deleteMany({}), mongoNested.deleteMany({})]);
    await pool.query(`TRUNCATE ${api.describeDatabase().tables.map((table) => `"${name}"."${table.name}"`).join(', ')} CASCADE`);
  };
  const attempt = async (action) => { try { await action(); return true; } catch (error) { if (error.code === 11000 || error.extensions?.code === 'DUPLICATE_KEY') return false; throw error; } };

  it('matches generated Mongoose indexes and defaults for scalar keys inside embedded lists and nested trees', async () => {
    const cases = [{}, { entries: null }, { entries: [] }, { entries: [null] }, { entries: [{}] }, { entries: [{ code: null }] }, { entries: [{ code: 'x' }, { code: 'x' }] }];
    for (const value of cases) {
      await clear();
      await mongoOwner.create(value); await api.getModel(types.Owner).create(value);
      for (const other of cases) {
        const mongo = await attempt(() => mongoOwner.create(other));
        const postgres = await attempt(() => api.getModel(types.Owner).create(other));
        expect(postgres, JSON.stringify({ value, other })).toBe(mongo);
      }
    }
    await clear();
    const nested = { branches: [{ leaves: [{ code: 'x' }, { code: 'x' }] }, { leaves: [] }] };
    await mongoNested.create(nested); await api.getModel(types.Nested).create(nested);
    for (const other of [{}, { branches: [{ leaves: [{ code: 'x' }] }] }, { branches: [{ leaves: [{ code: 'y' }] }] }]) {
      expect(await attempt(() => api.getModel(types.Nested).create(other))).toBe(await attempt(() => mongoNested.create(other)));
    }
  });

  it('matches explicit Mongo array indexes including default [] and terminal-empty versus ancestor-null keys', async () => {
    const cases = [{}, { entries: null }, { entries: [] }, { entries: [null] }, { entries: [{}] }, { entries: [{ codes: [] }] }, { entries: [{ codes: null }] }, { entries: [{ codes: [null] }] }, { entries: [{ codes: ['x', 'x'] }] }];
    expect(new mongoArrays({ entries: [{}] }).toObject().entries[0].codes).toEqual([]);
    for (const value of cases) {
      await clear();
      await mongoArrays.create(value); await api.getModel(types.Arrays).create(value);
      for (const other of cases) {
        expect(await attempt(() => api.getModel(types.Arrays).create(other)), JSON.stringify({ value, other })).toBe(await attempt(() => mongoArrays.create(other)));
      }
    }
  });
});
