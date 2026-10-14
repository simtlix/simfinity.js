import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GraphQLEnumType, GraphQLInt, GraphQLList, GraphQLObjectType, GraphQLString } from 'graphql';
import pg from 'pg';
import { createPostgres, describeDatabase, initializeDatabase } from '../../packages/postgres/src/index.js';

const uri = process.env.SIMFINITY_POSTGRES_URI;
const embedded = { relation: { embedded: true } };
const unique = { unique: true };
const State = new GraphQLEnumType({ name: 'InitState', values: { OPEN: {}, CLOSED: {} } });
const Code = new GraphQLObjectType({ name: 'InitCode', fields: { code: { type: GraphQLString, extensions: unique }, n: { type: GraphQLInt } } });
const types = {
  Owner: new GraphQLObjectType({ name: 'InitOwner', fields: { title: { type: GraphQLString }, entries: { type: new GraphQLList(Code), extensions: embedded } } }),
  Native: new GraphQLObjectType({ name: 'InitNative', fields: { codes: { type: new GraphQLList(GraphQLString), extensions: unique } } }),
  Plain: new GraphQLObjectType({ name: 'InitPlain', fields: { name: { type: GraphQLString }, state: { type: State } } }),
};
const q = (name) => `"${name.replaceAll('"', '""')}"`;

// A pool whose clients record every statement and, just before COMMIT, the relation locks they hold in
// the schema. `lockTimeout` makes a lock wait fail instead of hanging.
const recording = (pool, schema, { lockTimeout } = {}) => {
  const log = { statements: [], locks: [] };
  return {
    log,
    reset() { log.statements = []; log.locks = []; },
    async connect() {
      const client = await pool.connect();
      return {
        async query(text, values) {
          if (text === 'COMMIT') {
            log.locks = (await client.query(`SELECT c.relname AS table, l.mode FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
              JOIN pg_namespace n ON n.oid = c.relnamespace WHERE l.pid = pg_backend_pid() AND l.locktype = 'relation' AND c.relkind = 'r' AND n.nspname = $1 ORDER BY 1, 2`, [schema])).rows;
          }
          log.statements.push(text);
          const result = await client.query(text, values);
          if (lockTimeout && text.startsWith('BEGIN')) await client.query(`SET LOCAL lock_timeout = '${lockTimeout}'`);
          return result;
        },
        release: (error) => client.release(error),
      };
    },
  };
};
const locks = (statements) => statements.filter((text) => text.startsWith('LOCK TABLE'));
// What 3.5.9 ran after creating anything: a scan per check, then every root's keys rebuilt.
const backfills = (statements) => statements.filter((text) => /^SELECT 1 FROM .* WHERE NOT \(/s.test(text) || text.startsWith('DELETE FROM') || /^INSERT INTO .*__guard/s.test(text) || /__refresh"\(id\)/.test(text));
const exclusive = (held) => held.filter((lock) => lock.mode === 'ShareRowExclusiveLock').map((lock) => lock.table);

describe.skipIf(!uri)('PostgreSQL create-mode initialization of an existing schema', () => {
  let pool; let api; let db; let wrapper;
  const namespace = `init_${randomUUID().replaceAll('-', '')}`;
  const t = (name) => `${q(namespace)}.${q(name)}`;
  const keysOf = (root) => db.tables.find((table) => table.uniqueKeys?.rootTable === root).name;
  const keyRows = async (root) => (await pool.query(`SELECT xmin::text AS xmin, __owner_id AS owner, kind, value FROM ${t(keysOf(root))} ORDER BY __owner_id, kind, value`)).rows;
  const withoutXmin = (rows) => rows.map(({ owner, kind, value }) => ({ owner, kind, value }));
  const native = (codes) => api.getModel(types.Native).create({ codes });

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: uri, max: 6 });
    api = createPostgres({ pool, schema: namespace });
    for (const [name, gqltype] of Object.entries(types)) api.connect(null, gqltype, name.toLowerCase(), `${name.toLowerCase()}s`);
    api.addNoEndpointType(Code);
    api.createSchema();
    db = api.describeDatabase();
    await api.initializeDatabase();
    wrapper = recording(pool, namespace);
  });
  beforeEach(async () => {
    // Restore every generated object a test removed, then start from the same rows.
    await initializeDatabase(pool, db);
    await pool.query(`TRUNCATE ${db.tables.map((table) => t(table.name)).join(', ')} CASCADE`);
    for (let i = 0; i < 3; i += 1) await api.getModel(types.Owner).create({ title: `owner ${i}`, entries: [{ code: `a${i}` }, { code: `b${i}` }] });
    await native(['x', 'y']);
    await native(['z']);
    await api.getModel(types.Plain).create({ name: 'plain', state: 'OPEN' });
    wrapper.reset();
  });
  afterAll(async () => { await pool.query(`DROP SCHEMA IF EXISTS ${q(namespace)} CASCADE`); await pool.end(); });

  it('takes no table locks and runs no backfill when nothing is missing', async () => {
    expect(await initializeDatabase(wrapper, db)).toEqual({ mode: 'create', created: [] });
    expect(locks(wrapper.log.statements)).toEqual([]);
    expect(exclusive(wrapper.log.locks)).toEqual([]);
    expect(backfills(wrapper.log.statements)).toEqual([]);
  });

  it('reads the catalog in a constant number of statements', async () => {
    const small = describeDatabase([{ gqltype: types.Plain }], { schema: `${namespace}_small` });
    try {
      await initializeDatabase(pool, small);
      const counts = {};
      for (const [name, description] of [['small', small], ['large', db]]) {
        for (const mode of ['create', 'validate']) {
          wrapper.reset();
          expect(await initializeDatabase(wrapper, description, { mode })).toEqual({ mode, created: [] });
          counts[`${name} ${mode}`] = wrapper.log.statements.length;
        }
      }
      expect(db.tables.length).toBeGreaterThan(5 * small.tables.length);
      // BEGIN, two settings, the version, the advisory lock, six catalog reads, the schema and COMMIT.
      expect(counts).toEqual({ 'small create': 13, 'small validate': 13, 'large create': 13, 'large validate': 13 });
    } finally { await pool.query(`DROP SCHEMA IF EXISTS ${q(`${namespace}_small`)} CASCADE`); }
  });

  it('does not wait for writers on managed tables when nothing is missing', async () => {
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(`INSERT INTO ${t('InitPlain')} (name) VALUES ('writer')`);
      await writer.query(`INSERT INTO ${t('InitNative')} (codes) VALUES (ARRAY['writer'])`);
      const timed = recording(pool, namespace, { lockTimeout: '200ms' });
      expect(await initializeDatabase(timed, db)).toEqual({ mode: 'create', created: [] });
      expect(await initializeDatabase(timed, db, { mode: 'validate' })).toEqual({ mode: 'validate', created: [] });
    } finally { await writer.query('ROLLBACK'); writer.release(); }
  });

  it('adding an index does not wait for writers on other managed tables, rebuilds no keys and scans no checks', async () => {
    const extended = structuredClone(db);
    const index = { name: 'InitPlain__name__idx', columns: ['name'], unique: false, nullsNotDistinct: false };
    extended.tables.find((table) => table.name === 'InitPlain').indexes.push(index);
    const before = await keyRows('InitOwner');
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(`INSERT INTO ${t('InitOwner')} (title) VALUES ('writer')`);
      await writer.query(`UPDATE ${t('InitNative')} SET codes = ARRAY['w'] WHERE codes = ARRAY['z']`);
      const timed = recording(pool, namespace, { lockTimeout: '200ms' });
      expect(await initializeDatabase(timed, extended)).toEqual({ mode: 'create', created: [`index:${namespace}.${index.name}`] });
      expect(locks(timed.log.statements)).toEqual([]);
      expect(backfills(timed.log.statements)).toEqual([]);
      expect(exclusive(timed.log.locks)).toEqual([]);
    } finally { await writer.query('ROLLBACK'); writer.release(); await pool.query(`DROP INDEX IF EXISTS ${t(index.name)}`); }
    expect(await keyRows('InitOwner')).toEqual(before);
  });

  it('locks only the tables of the root whose keys it rebuilds, in one statement', async () => {
    const owner = await keyRows('InitOwner');
    const nativeKeys = withoutXmin(await keyRows('InitNative'));
    await pool.query(`DROP TRIGGER "InitNative__deferred" ON ${t('InitNative')}`);
    await pool.query(`DELETE FROM ${t(keysOf('InitNative'))}`);
    expect(await initializeDatabase(wrapper, db)).toEqual({ mode: 'create', created: [`trigger:${namespace}.InitNative.InitNative__deferred`] });
    const nativeTables = ['InitNative', keysOf('InitNative'), 'InitNative__guard'].sort();
    expect(locks(wrapper.log.statements)).toEqual([`LOCK TABLE ${nativeTables.map(t).join(', ')} IN SHARE ROW EXCLUSIVE MODE`]);
    expect(exclusive(wrapper.log.locks)).toEqual(nativeTables);
    expect(wrapper.log.statements.filter((text) => /__refresh"\(id\)/.test(text))).toEqual([expect.stringContaining('"InitNative__refresh"(id)')]);
    expect(wrapper.log.statements.filter((text) => text.startsWith('DELETE FROM'))).toEqual([`DELETE FROM ${t(keysOf('InitNative'))}`]);
    expect(withoutXmin(await keyRows('InitNative'))).toEqual(nativeKeys);
    expect(await keyRows('InitOwner')).toEqual(owner);
  });

  // Each branch of the stale-root mapping. Keys are rebuilt for the root whose maintenance object was
  // recreated, and only for it: the other root's key rows keep their xmin.
  it('rebuilds keys when a dropped keys table is recreated', async () => {
    const owner = await keyRows('InitOwner');
    const nativeKeys = withoutXmin(await keyRows('InitNative'));
    await pool.query(`DROP TABLE ${t(keysOf('InitNative'))}`);
    const { created } = await initializeDatabase(pool, db);
    expect(created).toContain(`table:${namespace}.${keysOf('InitNative')}`);
    expect(withoutXmin(await keyRows('InitNative'))).toEqual(nativeKeys);
    expect(await keyRows('InitOwner')).toEqual(owner);
    await expect(native(['x'])).rejects.toMatchObject({ extensions: { code: 'DUPLICATE_KEY' } });
  });

  it('rebuilds keys when the refresh function is recreated', async () => {
    const owner = await keyRows('InitOwner');
    const nativeKeys = withoutXmin(await keyRows('InitNative'));
    await pool.query(`DROP FUNCTION ${t('InitNative__refresh')}(uuid)`);
    await pool.query(`DELETE FROM ${t(keysOf('InitNative'))}`);
    expect(await initializeDatabase(pool, db)).toEqual({ mode: 'create', created: [`function:${namespace}.InitNative__refresh`] });
    expect(withoutXmin(await keyRows('InitNative'))).toEqual(nativeKeys);
    expect(await keyRows('InitOwner')).toEqual(owner);
  });

  it('refreshes the root whose touch function was dropped with CASCADE', async () => {
    const owner = await keyRows('InitOwner');
    const nativeKeys = withoutXmin(await keyRows('InitNative'));
    await pool.query(`DROP FUNCTION ${t('InitNative__touch')}() CASCADE`);
    await pool.query(`DELETE FROM ${t(keysOf('InitNative'))}`);
    expect((await initializeDatabase(pool, db)).created).toEqual([`function:${namespace}.InitNative__touch`, `trigger:${namespace}.InitNative.InitNative__touch`]);
    expect(withoutXmin(await keyRows('InitNative'))).toEqual(nativeKeys);
    expect(await keyRows('InitOwner')).toEqual(owner);
  });

  it('inserts guard rows when the guard table is recreated', async () => {
    const owner = await keyRows('InitOwner');
    const nativeKeys = withoutXmin(await keyRows('InitNative'));
    await pool.query(`DROP TABLE ${t('InitNative__guard')}`);
    await pool.query(`DELETE FROM ${t(keysOf('InitNative'))}`);
    const { created } = await initializeDatabase(pool, db);
    expect(created).toContain(`table:${namespace}.InitNative__guard`);
    const guarded = await pool.query(`SELECT r.id FROM ${t('InitNative')} r JOIN ${t('InitNative__guard')} g ON g.__owner_id = r.id`);
    expect(guarded.rowCount).toBe(2);
    expect(withoutXmin(await keyRows('InitNative'))).toEqual(nativeKeys);
    expect(await keyRows('InitOwner')).toEqual(owner);
  });

  // Error precedence: drift found by the lock-free inspection is reported exactly as before.
  it('reports drift after a missing function exactly as before', async () => {
    const check = db.tables.find((table) => table.name === 'InitPlain').checks.find((item) => item.name.endsWith('__state__enum'));
    await pool.query(`DROP FUNCTION ${t('InitOwner__owned_valid')}(uuid)`);
    await pool.query(`ALTER TABLE ${t('InitPlain')} DROP CONSTRAINT ${q(check.name)}`);
    await pool.query(`ALTER TABLE ${t('InitPlain')} ADD CONSTRAINT ${q(check.name)} CHECK (state = 'OPEN')`);
    try {
      await expect(initializeDatabase(pool, db)).rejects.toMatchObject({ message: expect.stringContaining(`${namespace}.InitPlain.${check.name}: check constraint differs`), extensions: { code: 'SCHEMA_MISMATCH' } });
      expect((await pool.query('SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = $2', [namespace, 'InitOwner__owned_valid'])).rowCount).toBe(0);
    } finally {
      await pool.query(`ALTER TABLE ${t('InitPlain')} DROP CONSTRAINT ${q(check.name)}`);
      await pool.query(`ALTER TABLE ${t('InitPlain')} ADD CONSTRAINT ${q(check.name)} CHECK (${check.expression})`);
    }
  });

  it('reports a foreign key that existing rows violate before later trigger drift, exactly as before', async () => {
    const key = db.tables.find((table) => table.name === 'InitOwner__entries').foreignKeys.find((item) => item.columns[0] === '__owner_id');
    await pool.query(`ALTER TABLE ${t('InitOwner__entries')} DROP CONSTRAINT ${q(key.name)}`);
    await pool.query(`INSERT INTO ${t('InitOwner__entries')} (__owner_id, __position, code) VALUES ($1, 0, 'orphan')`, [randomUUID()]);
    await pool.query(`ALTER TABLE ${t('InitNative')} DISABLE TRIGGER "InitNative__touch"`);
    try {
      await expect(initializeDatabase(pool, db)).rejects.toMatchObject({ code: '23503' });
      await expect(initializeDatabase(pool, db, { mode: 'validate' })).rejects.toMatchObject({ message: expect.stringContaining('foreign key is missing'), extensions: { code: 'SCHEMA_MISMATCH' } });
    } finally {
      await pool.query(`ALTER TABLE ${t('InitNative')} ENABLE TRIGGER "InitNative__touch"`);
      await pool.query(`DELETE FROM ${t('InitOwner__entries')} WHERE code = 'orphan'`);
    }
  });
});
