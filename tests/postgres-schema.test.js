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
