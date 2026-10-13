import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GraphQLList, GraphQLObjectType, GraphQLString } from 'graphql';
import pg from 'pg';
import { compileDatabaseSchema, createPostgres, describeDatabase, initializeDatabase } from '../../packages/postgres/src/index.js';

const uri = process.env.SIMFINITY_POSTGRES_URI;
const embedded = { relation: { embedded: true } };
const unique = { unique: true };
const q = (name) => `"${name.replaceAll('"', '""')}"`;
const fixture = () => {
  const Code = new GraphQLObjectType({ name: 'RefreshCode', fields: { code: { type: GraphQLString, extensions: unique } } });
  const Leaf = new GraphQLObjectType({ name: 'RefreshLeaf', fields: { tag: { type: GraphQLString, extensions: unique } } });
  const Branch = new GraphQLObjectType({ name: 'RefreshBranch', fields: { leaves: { type: new GraphQLList(Leaf), extensions: embedded } } });
  const Target = new GraphQLObjectType({ name: 'RefreshTarget', fields: { name: { type: GraphQLString } } });
  const Linked = new GraphQLObjectType({ name: 'BlendCode', fields: { code: { type: GraphQLString, extensions: unique }, ref: { type: Target, extensions: { relation: { embedded: false } } } } });
  return {
    items: [Code, Leaf, Branch, Linked],
    types: {
      Owner: new GraphQLObjectType({ name: 'RefreshOwner', fields: { entries: { type: new GraphQLList(Code), extensions: embedded } } }),
      Nested: new GraphQLObjectType({ name: 'RefreshNested', fields: { branches: { type: new GraphQLList(Branch), extensions: embedded } } }),
      Native: new GraphQLObjectType({ name: 'RefreshNative', fields: { codes: { type: new GraphQLList(GraphQLString), extensions: unique } } }),
      // Its owned table sorts before PostgreSQL's RI_ConstraintTrigger_* names.
      Blend: new GraphQLObjectType({ name: 'BlendOwner', fields: { entries: { type: new GraphQLList(Linked), extensions: embedded } } }),
      Target,
    },
  };
};

// Both layouts give the same results; only the work done for each transaction differs.
describe.skipIf(!uri).each([['perRow', undefined], ['perRoot', 'perRoot']])('PostgreSQL %s refresh triggers', (layout, refreshTriggers) => {
  let pool; let api; let db; let types;
  const namespace = `refresh_${layout.toLowerCase()}_${randomUUID().replaceAll('-', '')}`;
  const t = (name) => `${q(namespace)}.${q(name)}`;
  const keysOf = (root) => db.tables.find((table) => table.uniqueKeys?.rootTable === root).name;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: uri, max: 6 });
    const built = fixture();
    types = built.types;
    api = createPostgres({ pool, schema: namespace, ...(refreshTriggers ? { refreshTriggers } : {}) });
    for (const [name, gqltype] of Object.entries(types)) api.connect(null, gqltype, name.toLowerCase(), `${name.toLowerCase()}s`);
    for (const gqltype of built.items) api.addNoEndpointType(gqltype);
    api.createSchema();
    db = api.describeDatabase();
    await api.initializeDatabase();
  });
  afterAll(async () => { await pool.query(`DROP SCHEMA IF EXISTS ${q(namespace)} CASCADE`); await pool.end(); });

  it('describes and validates the refresh triggers of its layout', async () => {
    const deferred = db.triggers.filter((trigger) => trigger.constraint);
    if (layout === 'perRow') {
      expect(deferred.map((trigger) => trigger.table)).toEqual(db.triggers.filter((trigger) => !trigger.constraint).map((trigger) => trigger.table));
      expect(deferred.every((trigger) => !trigger.events && !trigger.when)).toBe(true);
      expect(describeDatabase(api.getRegistrations(), { schema: namespace })).toEqual(db);
    } else {
      expect(deferred.map((trigger) => trigger.table)).toEqual(db.maintenance.map((item) => item.guardTable));
      expect(deferred.map(({ name, events, when }) => ({ name, events, when }))).toEqual(db.maintenance.map((item) => ({ name: `${item.guardTable}__deferred`, events: ['INSERT', 'UPDATE'], when: 'new.version < 0' })));
      const stored = await pool.query(`SELECT c.relname AS table, t.tgtype FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND t.tgconstraint <> 0 AND NOT t.tgisinternal ORDER BY 1`, [namespace]);
      expect(stored.rows).toEqual(db.maintenance.map((item) => ({ table: item.guardTable, tgtype: 21 })).sort((a, b) => a.table.localeCompare(b.table)));
    }
    expect(await initializeDatabase(pool, db, { mode: 'validate' })).toEqual({ mode: 'validate', created: [] });
    expect(await initializeDatabase(pool, db)).toEqual({ mode: 'create', created: [] });
  });

  // Key rows inserted plus deleted, read as a difference inside the writing transaction.
  const keyRowsWritten = (root, work) => api.withTransaction(null, async (session) => {
    const read = async () => Number((await session.query('SELECT n_tup_ins + n_tup_del AS n FROM pg_stat_xact_user_tables WHERE schemaname = $1 AND relname = $2', [namespace, keysOf(root)])).rows[0]?.n || 0);
    const before = await read();
    const result = await work(session);
    await session.query('SET CONSTRAINTS ALL IMMEDIATE');
    return { result, rows: (await read()) - before };
  });

  it('rebuilds the keys of each changed root once per transaction with perRoot, and once per changed row with perRow', async () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({ code: `${layout}-k-${i}` }));
    const created = await keyRowsWritten('RefreshOwner', (session) => api.getModel(types.Owner).create({ entries }, { session }));
    const replaced = await keyRowsWritten('RefreshOwner', (session) => api.getModel(types.Owner).update(created.result.id, { entries: entries.map((entry) => ({ code: `${entry.code}-r` })) }, { session }));
    const branches = Array.from({ length: 5 }, (_, b) => ({ leaves: Array.from({ length: 10 }, (__, l) => ({ tag: `${layout}-${b}-${l}` })) }));
    const nested = await keyRowsWritten('RefreshNested', (session) => api.getModel(types.Nested).create({ branches }, { session }));
    // Each refresh deletes the root's keys and inserts them again. perRow refreshes once per changed row:
    // 51 times on create (the root and 50 entries), 101 on replace (the root, 50 deleted and 50 inserted
    // entries) and 56 on the nested create (the root, 5 branches and 50 leaves).
    expect({ create: created.rows, replace: replaced.rows, nested: nested.rows }).toEqual(layout === 'perRoot'
      ? { create: 50, replace: 50 + 50, nested: 50 }
      : { create: 51 * 50 + 50 * 50, replace: 101 * 50 + 101 * 50, nested: 56 * 50 + 55 * 50 });
    expect((await api.getModel(types.Owner).findById(created.result.id)).entries).toHaveLength(50);
    await expect(api.getModel(types.Owner).create({ entries: [{ code: `${layout}-k-0-r` }] })).rejects.toMatchObject({ extensions: { code: 'DUPLICATE_KEY' } });
    await api.getModel(types.Owner).create({ entries: [{ code: `${layout}-k-0` }] });
    await expect(api.getModel(types.Nested).create({ branches: [{ leaves: [{ tag: `${layout}-4-9` }] }] })).rejects.toMatchObject({ extensions: { code: 'DUPLICATE_KEY' } });
  });

  it('detects a duplicate written after SET CONSTRAINTS ALL IMMEDIATE flushed earlier events', async () => {
    await api.getModel(types.Owner).create({ entries: [{ code: `${layout}-taken` }] });
    const client = await pool.connect();
    let outcome;
    try {
      await client.query('BEGIN');
      const id = randomUUID();
      await client.query(`INSERT INTO ${t('RefreshOwner')} (id, __entries_state) VALUES ($1, 'present')`, [id]);
      await client.query(`INSERT INTO ${t('RefreshOwner__entries')} (__owner_id, __position, code) VALUES ($1, 0, $2)`, [id, `${layout}-free`]);
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      outcome = await client.query(`UPDATE ${t('RefreshOwner__entries')} SET code = $2 WHERE __owner_id = $1`, [id, `${layout}-taken`])
        .then(() => client.query('COMMIT')).then(() => 'committed', (error) => error.code);
    } finally { await client.query('ROLLBACK').catch(() => {}); client.release(); }
    expect(outcome).toBe('23505');
    expect((await pool.query(`SELECT 1 FROM ${t('RefreshOwner__entries')} WHERE code = $1`, [`${layout}-taken`])).rowCount).toBe(1);
  });

  it('keeps the outcomes of IMMEDIATE, savepoint, delete-and-reinsert and re-parenting transactions', async () => {
    const owner = await api.getModel(types.Owner).create({ entries: [{ code: `${layout}-a` }] });
    const results = {};
    const run = async (name, statements) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const [text, values] of statements) await client.query(text, values);
        await client.query('COMMIT');
        results[name] = 'committed';
      } catch (error) { results[name] = error.code; } finally { await client.query('ROLLBACK').catch(() => {}); client.release(); }
    };
    const root = t('RefreshOwner'); const entries = t('RefreshOwner__entries');
    const id = randomUUID(); const id2 = randomUUID();
    await run('immediate multi-statement duplicate', [['SET CONSTRAINTS ALL IMMEDIATE'], [`INSERT INTO ${root} (id, __entries_state) VALUES ($1, 'present')`, [id]],
      [`INSERT INTO ${entries} (__owner_id, __position, code) VALUES ($1, 0, $2)`, [id, `${layout}-x1`]],
      [`INSERT INTO ${entries} (__owner_id, __position, code) VALUES ($1, 1, $2)`, [id, `${layout}-a`]]]);
    await run('savepoint rollback then valid commit', [[`INSERT INTO ${root} (id, __entries_state) VALUES ($1, 'present')`, [id]],
      ['SAVEPOINT s'], [`INSERT INTO ${entries} (__owner_id, __position, code) VALUES ($1, 0, $2)`, [id, `${layout}-a`]], ['ROLLBACK TO SAVEPOINT s'],
      [`INSERT INTO ${entries} (__owner_id, __position, code) VALUES ($1, 0, $2)`, [id, `${layout}-sp`]]]);
    await run('delete and re-insert a root with a duplicate', [[`DELETE FROM ${root} WHERE id = $1`, [id]],
      [`INSERT INTO ${root} (id, __entries_state) VALUES ($1, 'present')`, [id]],
      [`INSERT INTO ${entries} (__owner_id, __position, code) VALUES ($1, 0, $2)`, [id, `${layout}-a`]]]);
    await run('re-parent a row to another root, leaving a gap', [[`INSERT INTO ${root} (id, __entries_state) VALUES ($1, 'present')`, [id2]],
      [`INSERT INTO ${entries} (__owner_id, __position, code) VALUES ($1, 0, $2)`, [id2, `${layout}-mv0`]],
      [`UPDATE ${entries} SET __owner_id = $2, __position = 5 WHERE __owner_id = $1`, [id, id2]]]);
    // A limitation earlier versions have too: the receiving root is refreshed before the old one.
    await run('re-parent a row to another root that is refreshed first', [[`INSERT INTO ${root} (id, __entries_state) VALUES ($1, 'present')`, [id2]],
      [`INSERT INTO ${entries} (__owner_id, __position, code) VALUES ($1, 0, $2)`, [id2, `${layout}-mv0`]],
      [`UPDATE ${entries} SET __owner_id = $2, __position = 1 WHERE __owner_id = $1`, [id, id2]]]);
    await run('re-parent a row to another root', [[`UPDATE ${root} SET __entries_state = 'present' WHERE id = $1`, [id]], [`INSERT INTO ${root} (id, __entries_state) VALUES ($1, 'present')`, [id2]],
      [`INSERT INTO ${entries} (__owner_id, __position, code) VALUES ($1, 0, $2)`, [id2, `${layout}-mv0`]],
      [`UPDATE ${entries} SET __owner_id = $2, __position = 1 WHERE __owner_id = $1`, [id, id2]]]);
    await run('a moved key belongs to the new root', [[`INSERT INTO ${root} (id, __entries_state) VALUES ($1, 'present')`, [randomUUID()]],
      [`INSERT INTO ${entries} (__owner_id, __position, code) SELECT id, 0, $1 FROM ${root} WHERE id NOT IN ($2, $3) AND __entries_state = 'present'
        AND NOT EXISTS (SELECT 1 FROM ${entries} e WHERE e.__owner_id = ${root}.id)`, [`${layout}-sp`, id, id2]]]);
    await run('an owned shape gap at commit', [[`INSERT INTO ${entries} (__owner_id, __position, code) VALUES ($1, 7, $2)`, [owner.id, `${layout}-gap`]]]);
    expect(results).toEqual({
      'immediate multi-statement duplicate': '23505',
      'savepoint rollback then valid commit': 'committed',
      'delete and re-insert a root with a duplicate': '23505',
      're-parent a row to another root, leaving a gap': '23514',
      're-parent a row to another root that is refreshed first': '23505',
      're-parent a row to another root': 'committed',
      'a moved key belongs to the new root': '23505',
      'an owned shape gap at commit': '23514',
    });
  });

  it('reports one of two deferred violations of one transaction, which can differ by layout', async () => {
    await api.getModel(types.Blend).create({ entries: [{ code: `${layout}-blend-taken` }] });
    const victim = await api.getModel(types.Blend).create({ entries: [{ code: `${layout}-blend-free` }] });
    const client = await pool.connect();
    let outcome;
    try {
      await client.query('BEGIN');
      // Simfinity's own writes check references immediately; application SQL can defer them.
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      await client.query(`UPDATE ${t('BlendOwner__entries')} SET code = $2, ref = $3 WHERE __owner_id = $1`, [victim.id, `${layout}-blend-taken`, randomUUID()]);
      outcome = await client.query('COMMIT').then(() => 'committed', (error) => error.code);
    } finally { await client.query('ROLLBACK').catch(() => {}); client.release(); }
    // perRow refreshes from BlendOwner__entries__deferred, which sorts before the RI trigger; perRoot's
    // guard event is queued by the touch trigger at statement end, after the row's RI event.
    expect(outcome).toBe(layout === 'perRow' ? '23505' : '23503');
    expect((await api.getModel(types.Blend).findById(victim.id)).entries.map((entry) => entry.code)).toEqual([`${layout}-blend-free`]);
  });
});

describe.skipIf(!uri)('PostgreSQL perRoot refresh triggers', () => {
  let pool; let api; let db; let types;
  const namespace = `refresh_guard_${randomUUID().replaceAll('-', '')}`;
  const t = (name) => `${q(namespace)}.${q(name)}`;
  const guardOf = (root) => db.maintenance.find((item) => item.rootTable === root).guardTable;
  const keysOf = (root) => db.tables.find((table) => table.uniqueKeys?.rootTable === root).name;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: uri, max: 4 });
    const built = fixture();
    types = built.types;
    api = createPostgres({ pool, schema: namespace, refreshTriggers: 'perRoot' });
    for (const [name, gqltype] of Object.entries(types)) api.connect(null, gqltype, name.toLowerCase(), `${name.toLowerCase()}s`);
    for (const gqltype of built.items) api.addNoEndpointType(gqltype);
    api.createSchema();
    db = api.describeDatabase();
    await api.initializeDatabase();
  });
  afterAll(async () => { await pool.query(`DROP SCHEMA IF EXISTS ${q(namespace)} CASCADE`); await pool.end(); });

  it('self-heals guard rows left dirty while the guard trigger was disabled', async () => {
    const owner = await api.getModel(types.Owner).create({ entries: [{ code: 'heal-1' }] });
    const guard = guardOf('RefreshOwner');
    await pool.query(`ALTER TABLE ${t(guard)} DISABLE TRIGGER ${q(`${guard}__deferred`)}`);
    try {
      await pool.query(`UPDATE ${t('RefreshOwner__entries')} SET code = 'heal-2' WHERE __owner_id = $1`, [owner.id]);
      expect(Number((await pool.query(`SELECT version FROM ${t(guard)} WHERE __owner_id = $1`, [owner.id])).rows[0].version)).toBeLessThan(0);
    } finally { await pool.query(`ALTER TABLE ${t(guard)} ENABLE TRIGGER ${q(`${guard}__deferred`)}`); }
    await api.getModel(types.Owner).create({ entries: [{ code: 'heal-3' }] });
    await expect(pool.query(`UPDATE ${t('RefreshOwner__entries')} SET code = 'heal-3' WHERE __owner_id = $1`, [owner.id])).rejects.toMatchObject({ code: '23505' });
    await pool.query(`UPDATE ${t('RefreshOwner__entries')} SET code = 'heal-4' WHERE __owner_id = $1`, [owner.id]);
    expect((await pool.query(`SELECT value FROM ${t(keysOf('RefreshOwner'))} WHERE __owner_id = $1`, [owner.id])).rows).toEqual([{ value: 'heal-4' }]);
    expect(Number((await pool.query(`SELECT version FROM ${t(guard)} WHERE __owner_id = $1`, [owner.id])).rows[0].version)).toBeGreaterThan(0);
  });

  it('rebuilds stale keys after the guard trigger is recreated', async () => {
    const a = await api.getModel(types.Native).create({ codes: ['swap-a'] });
    const b = await api.getModel(types.Native).create({ codes: ['swap-b'] });
    const other = (await pool.query(`SELECT xmin::text, * FROM ${t(keysOf('RefreshOwner'))} ORDER BY __owner_id, value`)).rows;
    const guard = guardOf('RefreshNative');
    await pool.query(`DROP TRIGGER ${q(`${guard}__deferred`)} ON ${t(guard)}`);
    await pool.query(`UPDATE ${t('RefreshNative')} SET codes = CASE WHEN id = $1 THEN ARRAY['swap-b'] ELSE ARRAY['swap-a'] END WHERE id IN ($1, $2)`, [a.id, b.id]);
    await expect(initializeDatabase(pool, db, { mode: 'validate' })).rejects.toMatchObject({ extensions: { code: 'SCHEMA_MISMATCH' } });
    expect(await initializeDatabase(pool, db)).toEqual({ mode: 'create', created: [`trigger:${namespace}.${guard}.${guard}__deferred`] });
    const keys = await pool.query(`SELECT __owner_id AS owner, value FROM ${t(keysOf('RefreshNative'))} WHERE value LIKE 'swap-%' ORDER BY value`);
    expect(keys.rows).toEqual([{ owner: b.id, value: 'swap-a' }, { owner: a.id, value: 'swap-b' }]);
    expect((await pool.query(`SELECT xmin::text, * FROM ${t(keysOf('RefreshOwner'))} ORDER BY __owner_id, value`)).rows).toEqual(other);
    await expect(api.getModel(types.Native).create({ codes: ['swap-a'] })).rejects.toMatchObject({ extensions: { code: 'DUPLICATE_KEY' } });
  });

  it('rejects a guard trigger whose events or condition differ', async () => {
    const guard = guardOf('RefreshNative');
    const name = `${guard}__deferred`;
    const ddl = compileDatabaseSchema(db).find((statement) => statement.startsWith(`CREATE CONSTRAINT TRIGGER ${q(name)}`));
    expect(ddl).toBe(`CREATE CONSTRAINT TRIGGER ${q(name)} AFTER INSERT OR UPDATE ON ${t(guard)} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (new.version < 0) EXECUTE FUNCTION ${t(name)}()`);
    try {
      for (const drifted of [
        ddl.replace(' WHEN (new.version < 0)', ''),
        ddl.replace('INSERT OR UPDATE', 'UPDATE'),
        ddl.replace('new.version < 0', 'new.version <= 0'),
        ddl.replace('new.version < 0', 'NEW.version < 0 AND true'),
      ]) {
        await pool.query(`DROP TRIGGER ${q(name)} ON ${t(guard)}`);
        await pool.query(drifted);
        for (const options of [{ mode: 'validate' }, {}]) {
          await expect(initializeDatabase(pool, db, options), drifted).rejects.toMatchObject({ message: expect.stringContaining('trigger definition or enforcement differs'), extensions: { code: 'SCHEMA_MISMATCH' } });
        }
      }
      // The condition is compared as an expression, not as text.
      await pool.query(`DROP TRIGGER ${q(name)} ON ${t(guard)}`);
      await pool.query(ddl.replace('(new.version < 0)', '(NEW."version"<0)'));
      expect(await initializeDatabase(pool, db, { mode: 'validate' })).toEqual({ mode: 'validate', created: [] });
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${q(name)} ON ${t(guard)}`);
      await pool.query(ddl);
    }
  });
});

// The layout of a root follows its database; the option decides only for roots that have neither.
describe.skipIf(!uri)('PostgreSQL refresh-trigger layouts of existing databases', () => {
  let pool;
  const namespace = `refresh_mixed_${randomUUID().replaceAll('-', '')}`;
  const t = (name) => `${q(namespace)}.${q(name)}`;
  beforeAll(() => { pool = new pg.Pool({ connectionString: uri, max: 4 }); });
  afterAll(async () => { await pool.query(`DROP SCHEMA IF EXISTS ${q(namespace)} CASCADE`); await pool.end(); });

  it('keeps each root on its layout, gives new roots the configured one, and rejects a root with both', async () => {
    const { types } = fixture();
    const owner = [{ gqltype: types.Owner }];
    const both = [{ gqltype: types.Owner }, { gqltype: types.Native }];
    // A database created with the default layout, as 3.5.9 creates it.
    await initializeDatabase(pool, describeDatabase(owner, { schema: namespace }));
    const perRoot = (registrations) => describeDatabase(registrations, { schema: namespace, refreshTriggers: 'perRoot' });
    expect(await initializeDatabase(pool, perRoot(owner), { mode: 'validate' })).toEqual({ mode: 'validate', created: [] });
    expect(await initializeDatabase(pool, perRoot(owner))).toEqual({ mode: 'create', created: [] });
    // A missing trigger of an existing perRow root is recreated in that layout.
    await pool.query(`DROP TRIGGER "RefreshOwner__entries__deferred" ON ${t('RefreshOwner__entries')}`);
    expect(await initializeDatabase(pool, perRoot(owner))).toEqual({ mode: 'create', created: [`trigger:${namespace}.RefreshOwner__entries.RefreshOwner__entries__deferred`] });
    // A new root gets the configured layout; the existing root keeps its own.
    const { created } = await initializeDatabase(pool, perRoot(both));
    expect(created.filter((item) => /^(function|trigger):.*(touch|deferred)$/.test(item))).toEqual([
      `function:${namespace}.RefreshNative__touch`, `function:${namespace}.RefreshNative__guard__deferred`,
      `trigger:${namespace}.RefreshNative.RefreshNative__touch`, `trigger:${namespace}.RefreshNative__guard.RefreshNative__guard__deferred`,
    ]);
    expect(created.some((item) => item.includes('RefreshOwner'))).toBe(false);
    // Either description validates the mixed database.
    for (const description of [perRoot(both), describeDatabase(both, { schema: namespace })]) {
      expect(await initializeDatabase(pool, description, { mode: 'validate' })).toEqual({ mode: 'validate', created: [] });
      expect(await initializeDatabase(pool, description)).toEqual({ mode: 'create', created: [] });
    }
    await pool.query(`INSERT INTO ${t('RefreshNative')} (codes) VALUES (ARRAY['x'])`);
    await expect(pool.query(`INSERT INTO ${t('RefreshNative')} (codes) VALUES (ARRAY['x'])`)).rejects.toMatchObject({ code: '23505' });
    const id = randomUUID();
    await pool.query(`INSERT INTO ${t('RefreshOwner')} (id, __entries_state) VALUES ($1, 'present')`, [id]);
    await pool.query(`INSERT INTO ${t('RefreshOwner__entries')} (__owner_id, __position, code) VALUES ($1, 0, 'y')`, [id]);
    await expect(pool.query(`INSERT INTO ${t('RefreshOwner__entries')} (__owner_id, __position, code) VALUES ($1, 1, 'y')`, [randomUUID()])).rejects.toMatchObject({ code: '23503' });
    // An object of the other layout in a root is drift, whichever layout is configured.
    const guardFunction = compileDatabaseSchema(perRoot(both)).find((statement) => statement.startsWith(`CREATE FUNCTION ${t('RefreshOwner__guard__deferred')}(`));
    await pool.query(guardFunction);
    for (const description of [perRoot(both), describeDatabase(both, { schema: namespace })]) {
      for (const options of [{ mode: 'validate' }, {}]) {
        await expect(initializeDatabase(pool, description, options)).rejects.toMatchObject({ message: expect.stringContaining(`${namespace}.RefreshOwner: refresh triggers of two layouts are present`), extensions: { code: 'SCHEMA_MISMATCH' } });
      }
    }
  });
});
