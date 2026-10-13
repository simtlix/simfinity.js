import { describe, it, expect, vi } from 'vitest';
import { GraphQLObjectType, GraphQLString, GraphQLID, GraphQLList } from 'graphql';
import { schemaFixture } from './contracts/postgres-fixtures.js';
import {
  describeDatabase, compileDatabaseSchema, configure, connect, createPostgres, createSchema, getRegistrations,
} from '../packages/postgres/src/index.js';
import { normalizeExpression } from '../packages/postgres/src/schema/initialize.js';

describe('PostgreSQL schema compiler', () => {
  it('generates real deduplicated FKs, typed values and association uniqueness', () => {
    const db = describeDatabase(schemaFixture(), { schema: 'app' });
    const child = db.tables.find((table) => table.name === 'Child');
    expect(child.foreignKeys).toHaveLength(2);
    expect(child.foreignKeys).toContainEqual(expect.objectContaining({ columns: ['parent_id'], targetTable: 'Parent', targetColumns: ['id'], onDelete: 'NO ACTION', deferrable: true }));
    expect(child.columns.find((column) => column.name === 'parent_id')).toMatchObject({ type: 'uuid', nullable: false });
    expect(child.indexes).toContainEqual(expect.objectContaining({ columns: ['parent_id', 'tag'], unique: true }));
    const parent = db.tables.find((table) => table.name === 'Parent');
    expect(parent.columns.find((column) => column.name === 'name')).toMatchObject({ type: 'text', collation: 'C' });
    expect(parent.columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'profile', type: 'jsonb' }),
      expect.objectContaining({ name: 'ranks', type: 'integer[]' }),
      expect.objectContaining({ name: 'active', type: 'boolean' }),
    ]));
    const sql = compileDatabaseSchema(db).join('\n');
    expect(sql).toContain('FOREIGN KEY ("parent_id") REFERENCES "app"."Parent" ("id")');
    expect(sql).toContain('DEFERRABLE INITIALLY IMMEDIATE');
    expect(sql).toContain('NULLS NOT DISTINCT');
    expect(JSON.parse(JSON.stringify(db))).toEqual(db);
    expect(compileDatabaseSchema(describeDatabase(schemaFixture(), { schema: 'app' }))).toEqual(compileDatabaseSchema(db));
  });

  it('uses owned tables for embedded references, including array ordering and FK indexes', () => {
    const db = describeDatabase(schemaFixture());
    const owned = db.tables.find((table) => table.ownership);
    expect(owned.ownership).toMatchObject({ ownerTable: 'Parent', field: 'contacts', list: true });
    expect(owned.foreignKeys).toEqual(expect.arrayContaining([
      expect.objectContaining({ columns: ['__owner_id'], targetTable: 'Parent', onDelete: 'CASCADE' }),
      expect.objectContaining({ columns: ['tag_id'], targetTable: 'Tag', onDelete: 'NO ACTION' }),
    ]));
    expect(owned.indexes).toContainEqual(expect.objectContaining({ columns: ['__owner_id', '__position'], unique: true }));
    expect(owned.indexes).toContainEqual(expect.objectContaining({ columns: ['tag_id'], unique: false }));
  });

  it('quotes identifiers, shortens generated names and supports native unique lists', () => {
    const type = new GraphQLObjectType({ name: 'A'.repeat(60), fields: { select: { type: GraphQLID } } });
    const db = describeDatabase([{ gqltype: type }], { schema: 'an"odd schema' });
    expect(compileDatabaseSchema(db)[0]).toBe('CREATE SCHEMA IF NOT EXISTS "an""odd schema"');
    expect(db.tables[0].indexes.every((index) => Buffer.byteLength(index.name) <= 63)).toBe(true);
    const list = new GraphQLObjectType({ name: 'UniqueList', fields: { names: { type: new GraphQLList(GraphQLString), extensions: { unique: true } } } });
    expect(describeDatabase([{ gqltype: list }]).tables.some((table) => table.uniqueKeys)).toBe(true);
  });

  it.each(['item', 'f'.repeat(60)])('keeps presence markers separate from item markers and shortens long names: %s', (name) => {
    const Leaf = new GraphQLObjectType({ name: 'PresenceLeaf', fields: { [name]: { type: GraphQLString, extensions: { unique: true } } } });
    const Root = new GraphQLObjectType({ name: 'PresenceRoot', fields: { entries: { type: new GraphQLList(Leaf), extensions: { relation: { embedded: true } } } } });
    const db = describeDatabase([{ gqltype: Root }]);
    const owned = db.tables.find((table) => table.ownership);
    const marker = owned.columns.find((column) => column.name === name).presenceColumn;
    expect(marker).not.toBe('__item_present');
    expect(Buffer.byteLength(marker)).toBeLessThanOrEqual(63);
    expect(owned.columns.find((column) => column.name === marker)).toMatchObject({ type: 'boolean', nullable: false, default: 'false' });
    expect(() => compileDatabaseSchema(db)).not.toThrow();
  });

  it('materializes embedded unique keys with native values and owner FKs', () => {
    const Detail = new GraphQLObjectType({ name: 'Detail', fields: { code: { type: GraphQLString, extensions: { unique: true } } } });
    const Owner = new GraphQLObjectType({ name: 'Owner', fields: { detail: { type: Detail, extensions: { relation: { embedded: true } } } } });
    const db = describeDatabase([{ gqltype: Owner }]);
    const keys = db.tables.find((table) => table.uniqueKeys);
    expect(keys.columns).toContainEqual(expect.objectContaining({ name: 'value', type: 'text' }));
    expect(keys.foreignKeys).toContainEqual(expect.objectContaining({ targetTable: 'Owner', onDelete: 'CASCADE' }));
    expect(db.triggers.some((trigger) => trigger.deferrable && trigger.initiallyDeferred)).toBe(true);
  });
  it('orders generated functions before CHECKs and triggers after indexes', () => {
    const db = describeDatabase(schemaFixture());
    const ddl = compileDatabaseSchema(db);
    const firstTable = ddl.findIndex((sql) => sql.startsWith('CREATE TABLE'));
    expect(ddl.slice(1, firstTable).every((sql) => sql.startsWith('CREATE FUNCTION'))).toBe(true);
    const firstTrigger = ddl.findIndex((sql) => /CREATE (CONSTRAINT )?TRIGGER/.test(sql));
    expect(firstTrigger).toBeGreaterThan(ddl.findLastIndex((sql) => sql.startsWith('CREATE INDEX') || sql.startsWith('CREATE UNIQUE INDEX')));
    expect(db.functions.every((fn) => fn.configuration.includes('search_path=pg_catalog'))).toBe(true);
  });

  it('rejects whole embedded-object uniqueness and generated private relation collisions', () => {
    const Detail = new GraphQLObjectType({ name: 'UniqueDetail', fields: { code: { type: GraphQLString } } });
    const Owner = new GraphQLObjectType({ name: 'UniqueOwner', fields: { detail: { type: Detail, extensions: { unique: true, relation: { embedded: true } } } } });
    expect(() => describeDatabase([{ gqltype: Owner }])).toThrow(/whole embedded-object uniqueness/i);
    const Root = new GraphQLObjectType({ name: 'Root', fields: { codes: { type: new GraphQLList(GraphQLString), extensions: { unique: true } } } });
    const Collision = new GraphQLObjectType({ name: 'Root__guard', fields: { value: { type: GraphQLString } } });
    expect(() => describeDatabase([{ gqltype: Root }, { gqltype: Collision }])).toThrow(/collision/i);
  });

  it('compares generated escape-string literals with catalog-rendered standard strings by value', () => {
    // literal() writes E'' with doubled backslashes; pg_get_expr renders standard strings, without E.
    const same = (generated, catalog) => expect(normalizeExpression(generated)).toBe(normalizeExpression(catalog));
    same(String.raw`"kind" = ANY (ARRAY[E'C:\\dir'::text, 'plain'::text])`, String.raw`(kind = ANY (ARRAY['C:\dir'::text, 'plain'::text]))`);
    same(String.raw`"kind" = ANY (ARRAY[E'it''s\\y'::text, E'end\\'::text])`, String.raw`(kind = ANY (ARRAY['it''s\y'::text, 'end\'::text]))`);
    same(String.raw`array_remove("kinds", NULL::text) <@ ARRAY[E'C:\\dir'::text]`, String.raw`(array_remove(kinds, NULL::text) <@ ARRAY['C:\dir'::text])`);
    same(String.raw`"kind" = ANY (ARRAY[e'a\\b'::text])`, String.raw`(kind = ANY (ARRAY['a\b'::text]))`);
    // A different stored value is still drift: a catalog 'C:\\dir' holds two backslashes.
    expect(normalizeExpression(String.raw`"kind" = ANY (ARRAY[E'C:\\dir'::text])`)).not.toBe(normalizeExpression(String.raw`(kind = ANY (ARRAY['C:\\dir'::text]))`));
    expect(normalizeExpression(String.raw`"kind" = ANY (ARRAY[E'C:\\dir'::text])`)).not.toBe(normalizeExpression(String.raw`(kind = ANY (ARRAY['C:dir'::text]))`));
    // Expressions without escape strings normalize exactly as before.
    expect(normalizeExpression(String.raw`"kind" = ANY (ARRAY['plain'::text, 'it''s'::text])`)).toBe(String.raw`kind=ANY(ARRAY['plain'::text,'it''s'::text])`);
    same(String.raw`"kind" = E'it''s'`, String.raw`(kind = 'it''s')`);
    expect(normalizeExpression(String.raw`"kind" = 'E'`)).toBe(String.raw`kind='E'`);
    // An E that ends an identifier does not start an escape string.
    expect(normalizeExpression(String.raw`typE'x\\'`)).toBe(String.raw`typE'x\\'`);
    expect(normalizeExpression(null)).toBeNull();
  });
});

describe('PostgreSQL DDL export for configured runtimes', () => {
  const library = (prefix) => {
    const Author = new GraphQLObjectType({ name: `${prefix}Author`, fields: { id: { type: GraphQLID }, name: { type: GraphQLString, extensions: { unique: true } } } });
    const Book = new GraphQLObjectType({ name: `${prefix}Book`, fields: {
      id: { type: GraphQLID }, title: { type: GraphQLString },
      author: { type: Author, extensions: { relation: { embedded: false, connectionField: 'author' } } },
    } });
    return { Author, Book };
  };

  it('compiles an instance description in the instance schema', () => {
    const pool = { connect: vi.fn(), query: vi.fn() };
    const api = createPostgres({ pool, schema: 'app' });
    expect(() => api.compileDatabaseSchema()).toThrow(expect.objectContaining({ extensions: expect.objectContaining({ code: 'SCHEMA_NOT_CREATED' }) }));
    const { Author, Book } = library('Exported');
    api.connect(null, Author, 'author', 'authors');
    api.connect(null, Book, 'book', 'books');
    api.createSchema();
    const ddl = api.compileDatabaseSchema();
    expect(ddl[0]).toBe('CREATE SCHEMA IF NOT EXISTS "app"');
    expect(ddl).toEqual(compileDatabaseSchema(describeDatabase(api.getRegistrations(), { schema: 'app' })));
    expect(ddl).toEqual(compileDatabaseSchema(api.describeDatabase()));
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('resolves the module-level no-argument calls to the configured default instance', () => {
    expect(() => describeDatabase()).toThrow(expect.objectContaining({ extensions: expect.objectContaining({ code: 'SCHEMA_NOT_CREATED' }) }));
    expect(() => compileDatabaseSchema()).toThrow(expect.objectContaining({ extensions: expect.objectContaining({ code: 'SCHEMA_NOT_CREATED' }) }));
    const pool = { connect: vi.fn(), query: vi.fn() };
    configure({ pool, schema: 'barber' });
    const { Author, Book } = library('Namespace');
    connect(null, Author, 'author', 'authors');
    connect(null, Book, 'book', 'books');
    createSchema();
    expect(describeDatabase().schema).toBe('barber');
    expect(compileDatabaseSchema()[0]).toBe('CREATE SCHEMA IF NOT EXISTS "barber"');
    expect(compileDatabaseSchema()).toEqual(compileDatabaseSchema(describeDatabase()));
    // The low-level describer keeps its own default schema; pass the configured one explicitly.
    expect(describeDatabase(getRegistrations()).schema).toBe('public');
    expect(describeDatabase(getRegistrations(), { schema: 'barber' })).toEqual(describeDatabase());
    expect(() => describeDatabase(undefined, { schema: 'barber' })).toThrow(expect.objectContaining({ extensions: expect.objectContaining({ code: 'INVALID_MODEL' }) }));
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

describe('PostgreSQL opt-in refresh triggers and owner indexes', () => {
  const registrations = () => {
    const Code = new GraphQLObjectType({ name: 'LayoutCode', fields: { code: { type: GraphQLString, extensions: { unique: true } } } });
    const Owner = new GraphQLObjectType({ name: 'LayoutOwner', fields: {
      id: { type: GraphQLID },
      entries: { type: new GraphQLList(Code), extensions: { relation: { embedded: true } } },
      main: { type: Code, extensions: { relation: { embedded: true } } },
    } });
    const Native = new GraphQLObjectType({ name: 'LayoutNative', fields: { codes: { type: new GraphQLList(GraphQLString), extensions: { unique: true } } } });
    const Plain = new GraphQLObjectType({ name: 'LayoutPlain', fields: { name: { type: GraphQLString } } });
    return [{ gqltype: Owner }, { gqltype: Native }, { gqltype: Plain }];
  };
  const connected = (api) => {
    const list = registrations();
    for (const [index, { gqltype }] of list.entries()) api.connect(null, gqltype, `layout${index}`, `layouts${index}`);
    api.addNoEndpointType(list[0].gqltype.getFields().main.type);
    return api;
  };
  const code = (error) => ({ code: error?.extensions?.code, status: error?.extensions?.status, message: error?.message });
  const caught = (action) => { try { action(); } catch (error) { return code(error); } return null; };
  const ownerIndex = (table) => table.indexes.some((index) => !index.unique && same(index.columns, ['__owner_id']));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  it.each([
    ['refreshTriggers', 'perTransaction'], ['refreshTriggers', null], ['refreshTriggers', 'PERROOT'],
    ['ownerIndexes', 'none'], ['ownerIndexes', false], ['ownerIndexes', 'Minimal'],
  ])('rejects %s %s with INVALID_DATABASE_SCHEMA (400) in describeDatabase, createPostgres and configure', (name, value) => {
    const expected = { code: 'INVALID_DATABASE_SCHEMA', status: 400, message: expect.stringContaining(`Unknown PostgreSQL ${name} option: ${String(value)}`) };
    expect(caught(() => describeDatabase(registrations(), { schema: 'app', [name]: value }))).toEqual(expected);
    const pool = { connect: vi.fn(), query: vi.fn() };
    const fromOptions = connected(createPostgres({ pool, schema: 'app', [name]: value }));
    expect(caught(() => fromOptions.createSchema())).toEqual(expected);
    const fromConfigure = createPostgres();
    fromConfigure.configure({ pool, schema: 'app', [name]: value });
    expect(caught(() => connected(fromConfigure).createSchema())).toEqual(expected);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('describes one deferred refresh trigger per maintained root, on its guard table, with perRoot', () => {
    const perRow = describeDatabase(registrations(), { schema: 'app' });
    const perRoot = describeDatabase(registrations(), { schema: 'app', refreshTriggers: 'perRoot' });
    expect(perRow.maintenance.map((item) => item.rootTable)).toEqual(['LayoutNative', 'LayoutOwner']);
    expect(perRoot.maintenance).toEqual(perRow.maintenance);
    expect(perRoot.tables).toEqual(perRow.tables);
    expect(perRow.triggers.filter((trigger) => trigger.constraint).map((trigger) => trigger.table)).toEqual(['LayoutNative', 'LayoutOwner', 'LayoutOwner__entries', 'LayoutOwner__main']);
    expect(perRoot.triggers.filter((trigger) => trigger.constraint)).toEqual(perRow.maintenance.map(({ guardTable }) => ({
      name: `${guardTable}__deferred`, table: guardTable, function: `${guardTable}__deferred`, constraint: true, deferrable: true, initiallyDeferred: true, events: ['INSERT', 'UPDATE'], when: 'new.version < 0',
    })));
    // The same touch triggers, with bodies that mark the guard row dirty once per transaction.
    expect(perRoot.triggers.filter((trigger) => !trigger.constraint)).toEqual(perRow.triggers.filter((trigger) => !trigger.constraint));
    const touch = (description) => description.functions.find((fn) => fn.name === 'LayoutOwner__entries__touch').body;
    expect(touch(perRow)).toContain('DO UPDATE SET version = "LayoutOwner__guard".version + 1;');
    expect(touch(perRoot)).toContain('(__owner_id, version) SELECT __root_id, -1 WHERE');
    expect(touch(perRoot)).toContain('DO UPDATE SET version = -(abs("LayoutOwner__guard".version) + 1) WHERE "LayoutOwner__guard".version >= 0 OR age("LayoutOwner__guard".xmin) <> 0;');
    expect(perRoot.functions.map((fn) => fn.name).filter((name) => name.endsWith('__deferred'))).toEqual(['LayoutNative__guard__deferred', 'LayoutOwner__guard__deferred']);
    expect(compileDatabaseSchema(perRoot)).toContain('CREATE CONSTRAINT TRIGGER "LayoutNative__guard__deferred" AFTER INSERT OR UPDATE ON "app"."LayoutNative__guard" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (new.version < 0) EXECUTE FUNCTION "app"."LayoutNative__guard__deferred"()');
    expect(compileDatabaseSchema(perRow).filter((sql) => sql.includes('TRIGGER')).every((sql) => sql.includes(' AFTER INSERT OR UPDATE OR DELETE ON ') && !sql.includes(' WHEN '))).toBe(true);
  });

  it('omits owner indexes that a primary key or unique index covers with ownerIndexes minimal', () => {
    const all = describeDatabase(registrations(), { schema: 'app' });
    const minimal = describeDatabase(registrations(), { schema: 'app', ownerIndexes: 'minimal' });
    const covered = (description) => description.tables.filter((table) => (table.ownership || table.auxiliary?.kind === 'guard') && ownerIndex(table)).map((table) => table.name);
    expect(covered(all)).toEqual(['LayoutNative__guard', 'LayoutOwner__entries', 'LayoutOwner__guard', 'LayoutOwner__main']);
    expect(covered(minimal)).toEqual([]);
    // Each of those tables still finds rows by owner through its primary key or a unique index.
    for (const table of minimal.tables.filter((item) => item.ownership || item.auxiliary?.kind === 'guard')) {
      expect(table.primaryKey.columns[0] === '__owner_id' || table.indexes.some((index) => index.unique && index.columns[0] === '__owner_id'), table.name).toBe(true);
    }
    // Keys tables keep theirs: their primary key and unique index start with other columns.
    const keys = (description) => description.tables.filter((table) => table.uniqueKeys).map((table) => [table.name, ownerIndex(table)]);
    expect(keys(minimal)).toEqual(keys(all));
    expect(keys(minimal).every(([, indexed]) => indexed)).toBe(true);
    expect(minimal.tables.map((table) => ({ ...table, indexes: undefined }))).toEqual(all.tables.map((table) => ({ ...table, indexes: undefined })));
    expect(minimal.triggers).toEqual(all.triggers);
  });

  it('describes a runtime with the options given to createPostgres or configure', () => {
    const options = { schema: 'app', refreshTriggers: 'perRoot', ownerIndexes: 'minimal' };
    const pool = { connect: vi.fn(), query: vi.fn() };
    const fromOptions = createPostgres({ pool, ...options });
    const fromConfigure = createPostgres();
    fromConfigure.configure({ pool, ...options });
    for (const api of [fromOptions, fromConfigure]) {
      connected(api).createSchema();
      expect(api.describeDatabase()).toEqual(describeDatabase(api.getRegistrations(), options));
      expect(api.compileDatabaseSchema()).toEqual(compileDatabaseSchema(describeDatabase(api.getRegistrations(), options)));
      expect(api.describeDatabase().triggers.filter((trigger) => trigger.constraint).map((trigger) => trigger.table)).toEqual(['LayoutNative__guard', 'LayoutOwner__guard']);
    }
    expect(describeDatabase(registrations(), options)).not.toEqual(describeDatabase(registrations(), { schema: 'app' }));
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
