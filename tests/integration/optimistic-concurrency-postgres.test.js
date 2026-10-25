import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GraphQLID, GraphQLList, GraphQLObjectType, GraphQLString } from 'graphql';
import pg from 'pg';
import { createSQL } from '../../packages/sql/src/index.js';
import { postgresPlugin } from '../../packages/postgres/src/plugin.js';
import { createControlledRace } from '../helpers/controlled-race.js';

const uri = process.env.SIMFINITY_POSTGRES_URI;
const maximum = Number.MAX_SAFE_INTEGER;
const errorCode = (code) => ({ extensions: { code } });
const missingMessage = 'Producto is protected by optimistic concurrency: pass changes.version, or { version: false } for a write that must not advance it, such as a value a hook keeps up to date';

describe.skipIf(!uri)('PostgreSQL optimistic concurrency handles', () => {
  let pool;
  const schemas = [];
  beforeAll(() => { pool = new pg.Pool({ connectionString: uri, max: 6 }); });
  afterAll(async () => {
    for (const namespace of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await pool.end();
  });
  const setup = async ({ protectedType = true, wrap = (plugin) => plugin, maintained = false, refreshTriggers } = {}) => {
    const namespace = `oc_${randomUUID().replaceAll('-', '')}`;
    schemas.push(namespace);
    const Code = new GraphQLObjectType({ name: 'ProductCode', fields: { code: { type: GraphQLString, extensions: { unique: true } } } });
    const Product = new GraphQLObjectType({ name: 'Producto', extensions: protectedType ? { concurrency: { mode: 'optimistic' } } : {}, fields: {
      id: { type: GraphQLID }, name: { type: GraphQLString },
      ...(maintained ? { codes: { type: new GraphQLList(Code), extensions: { relation: { embedded: true } } } } : {}),
    } });
    const plugin = wrap(postgresPlugin({ pool, schema: namespace, ...(refreshTriggers ? { refreshTriggers } : {}) }));
    const api = createSQL({ plugin });
    api.connect(null, Product, 'product', 'products');
    if (maintained) api.addNoEndpointType(Code);
    api.createSchema();
    await api.initializeDatabase();
    return { api, model: api.getModel(Product), namespace, target: `"${namespace}"."Producto"` };
  };

  it('creates at 1 without mutating input, advances updates and deletes at the requested version', async () => {
    const { model } = await setup();
    const data = Object.freeze({ name: 'original', version: 40 });
    const created = await model.create(data);
    expect(created).toMatchObject({ name: 'original', version: 1 });
    expect(data.version).toBe(40);
    const changes = Object.freeze({ name: 'changed', version: 1 });
    expect(await model.update(created.id, changes)).toMatchObject({ name: 'changed', version: 2 });
    expect(changes.version).toBe(1);
    await expect(model.update(created.id, { name: 'stale', version: 1 })).rejects.toMatchObject(errorCode('VERSION_CONFLICT'));
    await expect(model.delete(created.id, { version: 1 })).rejects.toMatchObject(errorCode('VERSION_CONFLICT'));
    expect(await model.delete(created.id, { version: 2 })).toMatchObject({ name: 'changed', version: 2 });
    expect(await model.findById(created.id)).toBeNull();
  });
  it('supports version:false for derived updates and deletion, ignoring changes.version', async () => {
    const { model } = await setup();
    const record = await model.create({ name: 'original' });
    expect(await model.update(record.id, { name: 'derived', version: 300 }, { version: false })).toMatchObject({ name: 'derived', version: 1 });
    expect(await model.update(record.id, { version: 600 }, { version: false })).toMatchObject({ version: 1 });
    expect(await model.delete(record.id, { version: false })).toMatchObject({ name: 'derived', version: 1 });
  });
  it('gives its own REQUIRED_VALUE message before opening a transaction', async () => {
    let acquisitions = 0;
    const { model } = await setup({ wrap: (plugin) => ({ ...plugin, driver: { ...plugin.driver, acquire: (...args) => { acquisitions++; return plugin.driver.acquire(...args); } } }) });
    const record = await model.create({ name: 'original' });
    const before = acquisitions;
    for (const value of [undefined, null]) {
      await expect(model.update(record.id, { version: value })).rejects.toMatchObject({ message: missingMessage, ...errorCode('REQUIRED_VALUE') });
      await expect(model.delete(record.id, { version: value })).rejects.toMatchObject({ message: missingMessage, ...errorCode('REQUIRED_VALUE') });
    }
    expect(acquisitions).toBe(before);
  });
  it.each([0, -1, 1.5, '1', 1n, maximum + 1])('rejects invalid handle versions %s', async (version) => {
    const { model } = await setup();
    const record = await model.create({ name: 'original' });
    await expect(model.update(record.id, { version })).rejects.toMatchObject(errorCode('INVALID_VERSION'));
    await expect(model.delete(record.id, { version })).rejects.toMatchObject(errorCode('INVALID_VERSION'));
    expect(await model.findById(record.id)).toMatchObject({ version: 1 });
  });
  it('returns null for missing IDs, including maximum-version updates', async () => {
    const { model } = await setup();
    const id = randomUUID();
    expect(await model.update(id, { version: 1 })).toBeNull();
    expect(await model.update(id, { version: maximum })).toBeNull();
    expect(await model.delete(id, { version: 1 })).toBeNull();
  });
  it('rejects exhaustion but allows deletion at the maximum version', async () => {
    const { model, target } = await setup();
    const record = await model.create({ name: 'original' });
    await pool.query(`UPDATE ${target} SET version = $1 WHERE id = $2`, [maximum, record.id]);
    await expect(model.update(record.id, { version: maximum })).rejects.toMatchObject(errorCode('VERSION_EXHAUSTED'));
    await expect(model.update(record.id, { version: 1 })).rejects.toMatchObject(errorCode('VERSION_CONFLICT'));
    expect(await model.delete(record.id, { version: maximum })).toMatchObject({ version: maximum });
  });
  it('captures changes.version once across a real 40001 abort and retry', async () => {
    let attempts = 0; let accesses = 0;
    const expected = [];
    const { model } = await setup({ wrap: (plugin) => ({ ...plugin, compileRecord(db, operation) {
      if (operation.kind === 'update') expected.push(operation.version?.expected);
      return plugin.compileRecord(db, operation);
    }, driver: { ...plugin.driver, async query(config, statement, client) {
      if (statement.text.startsWith('UPDATE ') && attempts++ === 0) {
        await client.query('DO $$ BEGIN RAISE EXCEPTION \'retry\' USING ERRCODE = \'40001\'; END $$');
      }
      return plugin.driver.query(config, statement, client);
    } } }) });
    const record = await model.create({ name: 'original' });
    const changes = Object.freeze({ name: 'changed', get version() { accesses++; return accesses === 1 ? 1 : 99; } });
    expect(await model.update(record.id, changes)).toMatchObject({ name: 'changed', version: 2 });
    expect(accesses).toBe(1);
    expect(attempts).toBe(2);
    expect(expected).toEqual([1, 1]);
  });
  it('rolls back earlier writes when a supplied-session conflict propagates', async () => {
    const { api, model } = await setup();
    const record = await model.create({ name: 'original' });
    let supplied;
    await expect(api.withTransaction(null, async (session) => {
      supplied = session;
      await model.update(record.id, { name: 'earlier', version: 1 }, { session });
      await model.update(record.id, { name: 'stale', version: 1 }, { session });
    })).rejects.toMatchObject(errorCode('VERSION_CONFLICT'));
    expect(supplied.inTransaction()).toBe(false);
    expect(await model.findById(record.id)).toMatchObject({ name: 'original', version: 1 });
  });
  it('permits one winner in a synchronized handle race', async () => {
    let arrivals = 0;
    const race = createControlledRace();
    const both = race.gate('both handle UPDATE statements');
    try {
      const { model } = await setup({ wrap: (plugin) => ({ ...plugin, driver: { ...plugin.driver, async query(config, statement, client) {
        if (statement.text.startsWith('UPDATE ') && arrivals < 2) {
          arrivals++;
          if (arrivals === 2) both.resolve();
          await both.wait();
        }
        return plugin.driver.query(config, statement, client);
      } } }) });
      const record = await model.create({ name: 'original' });
      const results = await race.wait(Promise.allSettled(['first', 'second'].map((name) => race.start(() => model.update(record.id, { name, version: 1 })))));
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((result) => result.status === 'rejected').reason).toMatchObject(errorCode('VERSION_CONFLICT'));
      expect(await model.findById(record.id)).toMatchObject({ version: 2, name: results.find((result) => result.status === 'fulfilled').value.name });
    } finally { await race.finish(); }
  }, 20000);
  it.each(['strip update version', 'omit delete RETURNING'])('rolls back a plugin diagnostic: %s', async (mode) => {
    const { model } = await setup({ wrap: (plugin) => ({ ...plugin, compileRecord(db, operation) {
      if (mode === 'strip update version' && operation.kind === 'update') {
        const rest = { ...operation };
        delete rest.version;
        return plugin.compileRecord(db, rest);
      }
      const statement = plugin.compileRecord(db, operation);
      return mode === 'omit delete RETURNING' && operation.kind === 'deleteById' ? { ...statement, text: statement.text.replace(' RETURNING id', '') } : statement;
    } }) });
    const record = await model.create({ name: 'original' });
    const action = mode === 'strip update version' ? model.update(record.id, { name: 'changed', version: 1 }) : model.delete(record.id, { version: 1 });
    await expect(action).rejects.toMatchObject(errorCode('DATABASE_ERROR'));
    expect(await model.findById(record.id)).toMatchObject({ name: 'original', version: 1 });
  });
  it.each(['perRow', 'perRoot'])('refreshes maintained keys on version-only updates with %s triggers', async (refreshTriggers) => {
    const { api, model, namespace } = await setup({ maintained: true, refreshTriggers });
    const record = await model.create({ name: 'original', codes: [{ code: 'unique' }] });
    const keyTable = api.describeDatabase().tables.find((table) => table.uniqueKeys?.rootTable === 'Producto').name;
    const result = await api.withTransaction(null, async (session) => {
      const read = async () => Number((await session.query('SELECT n_tup_ins + n_tup_del AS n FROM pg_stat_xact_user_tables WHERE schemaname = $1 AND relname = $2', [namespace, keyTable])).rows[0]?.n || 0);
      const before = await read();
      const updated = await model.update(record.id, { id: record.id, version: 1 }, { session });
      await session.query('SET CONSTRAINTS ALL IMMEDIATE');
      return { updated, writes: (await read()) - before };
    });
    expect(result.updated).toMatchObject({ version: 2, codes: [{ code: 'unique' }] });
    expect(result.writes).toBeGreaterThan(0);
    expect(await model.findById(record.id)).toMatchObject({ version: 2, codes: [{ code: 'unique' }] });
    await expect(model.create({ name: 'duplicate', codes: [{ code: 'unique' }] })).rejects.toMatchObject(errorCode('DUPLICATE_KEY'));
    expect(await api.initializeDatabase({ mode: 'validate' })).toEqual({ mode: 'validate', created: [] });
  });
  it('pin: unprotected handles ignore version options and preserve their records', async () => {
    const { model } = await setup({ protectedType: false });
    const record = await model.create({ name: 'original', version: 12 });
    expect(record).not.toHaveProperty('version');
    expect(await model.update(record.id, { name: 'changed' }, { version: false })).toMatchObject({ name: 'changed' });
    expect(await model.update(record.id, { name: 'again' })).toMatchObject({ name: 'again' });
    const ignoredOption = { get version() { throw new Error('Unprotected handles must not read version'); } };
    expect(await model.update(record.id, { name: 'final' }, ignoredOption)).toMatchObject({ name: 'final' });
    expect(await model.delete(record.id, ignoredOption)).toMatchObject({ name: 'final' });
  });
});
