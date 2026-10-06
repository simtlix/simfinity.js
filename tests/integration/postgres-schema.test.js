import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { GraphQLID, GraphQLList, GraphQLObjectType, GraphQLNonNull, GraphQLString } from 'graphql';
import { createContractModelFixtures } from '../contracts/model-fixtures.js';
import { schemaFixture } from '../contracts/postgres-fixtures.js';
import {
  addNoEndpointType, compileDatabaseSchema, configure, connect, createPostgres, createSchema, describeDatabase,
  getModel, getRegistrations, initializeDatabase, postgresPlugin,
} from '../../packages/postgres/src/index.js';

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
    await pool.query(`INSERT INTO "${contractSchema}"."ContractSerie" (id, tenant, title, __credits_state) VALUES ($1, $2, $3, 'present')`, [owner, 'T', 'Series']);
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

const uuids = (count) => Array.from({ length: count }, () => randomUUID());
describe.skipIf(!uri)('PostgreSQL [ID] list columns', () => {
  const schema = `simfinity_${randomUUID().replaceAll('-', '')}_ids`;
  const legacySchema = `${schema}_legacy`;
  const long = 'aVeryLongFieldNameForRelatedIdentifiersThatHashesTheIndexName';
  let pool; let api; let types; let warn;
  const listIndexes = async (name) => (await pool.query(`SELECT i.indexname FROM pg_indexes i WHERE i.schemaname = $1
    AND EXISTS (SELECT 1 FROM pg_index x JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = ANY (x.indkey)
      WHERE x.indexrelid = format('%I.%I', i.schemaname, i.indexname)::regclass AND a.atttypid = 'uuid[]'::regtype) ORDER BY 1`, [name])).rows.map((row) => row.indexname);
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: uri });
    const Author = new GraphQLObjectType({ name: 'IdListAuthor', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
    const Link = new GraphQLObjectType({ name: 'IdListLink', fields: {
      author: { type: Author, extensions: { relation: { embedded: false, connectionField: 'author' } } },
      refIds: { type: new GraphQLList(GraphQLID) }, refId: { type: GraphQLID },
    } });
    const Post = new GraphQLObjectType({ name: 'IdListPost', fields: {
      id: { type: GraphQLID }, title: { type: GraphQLString }, externalId: { type: GraphQLID },
      relatedIds: { type: new GraphQLList(GraphQLID) },
      requiredIds: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLID))) },
      [long]: { type: new GraphQLList(GraphQLID) },
      links: { type: new GraphQLList(Link), extensions: { relation: { embedded: true } } },
    } });
    types = { Author, Link, Post };
    api = createPostgres({ pool, schema });
    api.connect(null, Author, 'idListAuthor', 'idListAuthors');
    api.connect(null, Post, 'idListPost', 'idListPosts');
    api.addNoEndpointType(Link);
    api.createSchema();
  });
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });
  afterAll(async () => {
    for (const name of [schema, legacySchema]) await pool.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
    await pool.end();
  });

  it('stores and updates [ID] lists beyond the btree row size limit, at the root and in owned tables', async () => {
    await api.initializeDatabase();
    expect(await listIndexes(schema)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    const author = await api.getModel(types.Author).create({ name: 'Author' });
    const values = { relatedIds: uuids(1000), requiredIds: uuids(168), [long]: uuids(300), links: [{ author: author.id, refIds: uuids(500), refId: randomUUID() }] };
    const post = await api.getModel(types.Post).create({ title: 'Long lists', externalId: randomUUID(), ...values });
    const stored = await api.getModel(types.Post).findById(post.id);
    expect(stored).toMatchObject({ relatedIds: values.relatedIds, requiredIds: values.requiredIds, [long]: values[long] });
    expect(stored.links[0].refIds).toEqual(values.links[0].refIds);
    const replaced = uuids(400);
    await api.getModel(types.Post).update(post.id, { relatedIds: replaced });
    expect((await api.getModel(types.Post).findById(post.id)).relatedIds).toEqual(replaced);
    expect((await api.getModel(types.Post).find({ relatedIds: { operator: 'EQ', value: replaced[399] } })).map((item) => item.id)).toEqual([post.id]);
    // Single ID columns, references included, keep their generated index.
    expect((await pool.query('SELECT indexname FROM pg_indexes WHERE schemaname = $1', [schema])).rows.map((row) => row.indexname))
      .toEqual(expect.arrayContaining(['IdListPost__externalId__idx', 'IdListPost__links__refId__idx', 'IdListPost__links__author__idx']));
  });

  it('keeps and reports the btree indexes earlier versions generated on [ID] list columns', async () => {
    const description = describeDatabase(api.getRegistrations(), { schema: legacySchema });
    // A database created by an earlier version: the same description plus one index per [ID] list column.
    const legacy = structuredClone(description);
    const { generatedName } = postgresPlugin().naming;
    const names = [];
    for (const table of legacy.tables) {
      for (const column of table.columns.filter((item) => item.type === 'uuid[]')) {
        const name = generatedName(table.name, column.name, 'idx');
        if (!table.indexes.some((index) => index.name === name)) table.indexes.push({ name, columns: [column.name], unique: false, nullsNotDistinct: false });
        names.push(name);
      }
    }
    expect(names).toEqual(expect.arrayContaining(['IdListPost__relatedIds__idx', 'IdListPost__requiredIds__idx', 'IdListPost__links__refIds__idx']));
    expect(names.some((name) => /^IdListPost__aVeryLong.*_[0-9a-f]{12}$/.test(name))).toBe(true);
    await initializeDatabase(pool, legacy);
    expect(await listIndexes(legacySchema)).toEqual([...names].sort());
    await expect(pool.query(`INSERT INTO "${legacySchema}"."IdListPost" ("relatedIds", "requiredIds") VALUES ($1, $2)`, [uuids(168), []])).rejects.toMatchObject({ code: '54000' });
    // Indexes a DBA created on the same column are neither reported nor dropped.
    await pool.query(`CREATE INDEX dba_related_btree ON "${legacySchema}"."IdListPost" ("relatedIds")`);
    await pool.query(`CREATE INDEX dba_related_partial ON "${legacySchema}"."IdListPost" ("relatedIds") WHERE "relatedIds" IS NOT NULL`);
    warn.mockClear();

    expect(await initializeDatabase(pool, description, { mode: 'validate' })).toEqual({ mode: 'validate', created: [] });
    expect(await initializeDatabase(pool, description)).toEqual({ mode: 'create', created: [] });
    expect(warn).toHaveBeenCalledTimes(2);
    for (const [message] of warn.mock.calls) {
      for (const name of names) expect(message).toContain(`DROP INDEX CONCURRENTLY IF EXISTS "${legacySchema}"."${name}";`);
      expect(message).toContain('167');
      expect(message).not.toContain('dba_related');
    }
    expect(await listIndexes(legacySchema)).toEqual([...names, 'dba_related_btree', 'dba_related_partial'].sort());

    // The documented migration drops them (CONCURRENTLY in production); nothing is reported or re-created afterwards.
    for (const name of names) await pool.query(`DROP INDEX "${legacySchema}"."${name}"`);
    warn.mockClear();
    expect(await initializeDatabase(pool, description, { mode: 'validate' })).toEqual({ mode: 'validate', created: [] });
    expect(await initializeDatabase(pool, description)).toEqual({ mode: 'create', created: [] });
    expect(warn).not.toHaveBeenCalled();
    expect(await listIndexes(legacySchema)).toEqual(['dba_related_btree', 'dba_related_partial']);
    await pool.query(`INSERT INTO "${legacySchema}"."IdListPost" ("requiredIds") VALUES ($1)`, [uuids(1000)]);

    // The generated name alone does not make an index legacy: a DBA's index of another shape under the
    // freed name is kept and never reported.
    const reused = 'IdListPost__relatedIds__idx';
    const exists = async () => (await pool.query('SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = $2', [legacySchema, reused])).rowCount === 1;
    for (const shape of [
      'USING gin ("relatedIds")',
      '("relatedIds") WHERE "relatedIds" IS NOT NULL',
      '((array_length("relatedIds", 1)))',
      '("relatedIds", title)',
    ]) {
      await pool.query(`CREATE INDEX "${reused}" ON "${legacySchema}"."IdListPost" ${shape}`);
      expect(await initializeDatabase(pool, description, { mode: 'validate' })).toEqual({ mode: 'validate', created: [] });
      expect(await initializeDatabase(pool, description)).toEqual({ mode: 'create', created: [] });
      expect(warn, shape).not.toHaveBeenCalled();
      expect(await exists()).toBe(true);
      await pool.query(`DROP INDEX "${legacySchema}"."${reused}"`);
    }
    // A unique index is never a generated list index; initialization rejects it as for any other name.
    await pool.query(`CREATE UNIQUE INDEX "${reused}" ON "${legacySchema}"."IdListPost" ("relatedIds")`);
    for (const options of [{ mode: 'validate' }, {}]) {
      await expect(initializeDatabase(pool, description, options)).rejects.toMatchObject({ message: expect.stringContaining('unexpected unique index'), extensions: { code: 'SCHEMA_MISMATCH' } });
    }
    expect(warn).not.toHaveBeenCalled();
    expect(await exists()).toBe(true);
  });
});

// The no-argument module calls use the default instance and the schema given to configure().
describe.skipIf(!uri)('PostgreSQL DDL exported by the configured default instance', () => {
  const schema = `simfinity_${randomUUID().replaceAll('-', '')}_export`;
  let pool;
  beforeAll(() => { pool = new pg.Pool({ connectionString: uri }); });
  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it('creates an empty non-public schema that validation accepts', async () => {
    const Tag = new GraphQLObjectType({ name: 'ExportTag', fields: { id: { type: GraphQLID }, label: { type: new GraphQLNonNull(GraphQLString), extensions: { unique: true } } } });
    const Contact = new GraphQLObjectType({ name: 'ExportContact', fields: {
      label: { type: GraphQLString, extensions: { unique: true } },
      tag: { type: Tag, extensions: { relation: { embedded: false } } },
    } });
    const Owner = new GraphQLObjectType({ name: 'ExportOwner', fields: {
      id: { type: GraphQLID }, name: { type: GraphQLString },
      tag: { type: Tag, extensions: { relation: { embedded: false } } },
      contacts: { type: new GraphQLList(Contact), extensions: { relation: { embedded: true } } },
    } });
    configure({ pool, schema });
    connect(null, Tag, 'exportTag', 'exportTags');
    connect(null, Owner, 'exportOwner', 'exportOwners');
    addNoEndpointType(Contact);
    createSchema();
    const description = describeDatabase();
    expect(description.schema).toBe(schema);
    expect(description.tables.some((table) => table.ownership)).toBe(true);
    expect(description.tables.some((table) => table.foreignKeys.length)).toBe(true);
    expect(description.tables.some((table) => table.indexes.some((index) => index.unique))).toBe(true);
    expect(description.functions.length).toBeGreaterThan(0);
    expect(description.triggers.length).toBeGreaterThan(0);
    // The low-level describer keeps defaulting to public.
    expect(describeDatabase(getRegistrations()).schema).toBe('public');

    const ddl = compileDatabaseSchema();
    expect(ddl[0]).toBe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    expect(ddl.join('\n')).not.toContain('"public"');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const statement of ddl) await client.query(statement);
      await client.query('COMMIT');
    } finally { client.release(); }
    expect(await initializeDatabase({ mode: 'validate' })).toEqual({ mode: 'validate', created: [] });
    const tag = await getModel(Tag).create({ label: 'Exported' });
    const owner = await getModel(Owner).create({ name: 'Owner', tag: tag.id, contacts: [{ label: 'a', tag: tag.id }] });
    expect((await getModel(Owner).findById(owner.id)).contacts).toEqual([{ label: 'a', tag: tag.id }]);
    await expect(getModel(Owner).create({ contacts: [{ label: 'a' }] })).rejects.toMatchObject({ extensions: { code: 'DUPLICATE_KEY' } });
  });
});
