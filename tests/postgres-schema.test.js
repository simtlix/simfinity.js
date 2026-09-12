import { describe, it, expect } from 'vitest';
import { GraphQLObjectType, GraphQLString, GraphQLID, GraphQLList } from 'graphql';
import { schemaFixture } from './contracts/postgres-fixtures.js';
import { describeDatabase, compileDatabaseSchema } from '../packages/postgres/src/index.js';

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

  it('quotes identifiers, shortens generated names and rejects unsupported unique lists', () => {
    const type = new GraphQLObjectType({ name: 'A'.repeat(60), fields: { select: { type: GraphQLID } } });
    const db = describeDatabase([{ gqltype: type }], { schema: 'an"odd schema' });
    expect(compileDatabaseSchema(db)[0]).toBe('CREATE SCHEMA IF NOT EXISTS "an""odd schema"');
    expect(db.tables[0].indexes.every((index) => Buffer.byteLength(index.name) <= 63)).toBe(true);
    const bad = new GraphQLObjectType({ name: 'Bad', fields: { names: { type: new GraphQLList(GraphQLString), extensions: { unique: true } } } });
    expect(() => describeDatabase([{ gqltype: bad }])).toThrow(/multikey/i);
  });

  it('rejects embedded uniqueness until absent owners participate in the unique contract', () => {
    const Detail = new GraphQLObjectType({ name: 'Detail', fields: { code: { type: GraphQLString, extensions: { unique: true } } } });
    const Owner = new GraphQLObjectType({ name: 'Owner', fields: { detail: { type: Detail, extensions: { relation: { embedded: true } } } } });
    expect(() => describeDatabase([{ gqltype: Owner }])).toThrow(/embedded uniqueness/i);
  });
});
