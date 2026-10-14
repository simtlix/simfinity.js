import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { GraphQLID, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { describeModels } from '@simtlix/simfinity-core';
import { sqlSchemaFixtures, sqlSchemaOptInFixtures } from './contracts/sql-schema-fixtures.js';
import * as postgres from '../packages/postgres/src/schema/describe.js';
import { compileDatabaseSchema } from '../packages/postgres/src/schema/ddl.js';
import { identifier, generatedName } from '../packages/postgres/src/schema/sql.js';
import { withLayouts } from '../packages/postgres/src/schema/constraints.js';

const naming = { validateIdentifier: identifier, generatedName };
const baseline = JSON.parse(readFileSync(new URL('./fixtures/postgres-3.2-schema.json', import.meta.url), 'utf8'));
const optIns = JSON.parse(readFileSync(new URL('./fixtures/postgres-opt-in-schema.json', import.meta.url), 'utf8'));
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const allFixtures = () => [...sqlSchemaFixtures(), ...sqlSchemaOptInFixtures()];
// The saved default description of a fixture: the 3.2 snapshot, or the opt-in file's baseline for newer fixtures.
const defaultOf = (name) => baseline.snapshots.find((item) => item.name === name) ?? optIns.baselines.find((item) => item.name === name);
const optInChoices = [{ refreshTriggers: 'perRoot' }, { ownerIndexes: 'minimal' }];

describe('SQL relational planning', () => {
  it('separates logical columns, references and ownership from physical PostgreSQL storage', async () => {
    expect(postgres.describeRelationalSchema).toBeTypeOf('function');
    const { planRelationalSchema } = await import('../packages/sql/src/schema/plan.js');
    const fixture = sqlSchemaFixtures()[0];
    const plan = planRelationalSchema(describeModels(fixture.registrations), { ...fixture.options, naming });
    const parent = plan.tables.find((table) => table.name === 'Parent');
    expect(parent.columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'id', scalar: 'ID', list: false, nullable: false }),
      expect.objectContaining({ name: 'profile', scalar: 'Embedded' }),
      expect.objectContaining({ name: 'ranks', scalar: 'Int', list: true }),
    ]));
    const child = plan.tables.find((table) => table.name === 'Child');
    expect(child.foreignKeys).toContainEqual(expect.objectContaining({ columns: ['parent_id'], targetTable: 'Parent', deferrable: true }));
    const owned = plan.tables.find((table) => table.ownership?.field === 'contacts');
    expect(owned.ownership).toMatchObject({ ownerTable: 'Parent', list: true, nullableItems: false });
    expect(owned.foreignKeys).toContainEqual(expect.objectContaining({ columns: ['__owner_id'], onDelete: 'CASCADE' }));
    expect(plan.requirements).toEqual(expect.arrayContaining(['transactions', 'foreignKeys', 'deferredForeignKeys', 'embeddedValues', 'ownedRecords', 'scalarLists', 'uniqueValues', 'nullableUnique']));
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
    expect(JSON.stringify(plan)).not.toMatch(/jsonb|plpgsql|::uuid|gen_random_uuid|pg_catalog/);
    expect(postgres.describeRelationalSchema(plan)).toEqual(postgres.describeDatabase(fixture.registrations, fixture.options));
  });

  it.each(sqlSchemaFixtures())('preserves 3.2 physical description and DDL: $name', ({ name, registrations, options }) => {
    const saved = baseline.snapshots.find((item) => item.name === name);
    const description = postgres.describeDatabase(registrations, options);
    expect(hash(description)).toBe(saved.description);
    expect(hash(compileDatabaseSchema(description))).toBe(saved.ddl);
  });

  it.each(sqlSchemaFixtures())('keeps the 3.2 description with the explicit default options: $name', ({ name, registrations, options }) => {
    const saved = baseline.snapshots.find((item) => item.name === name);
    const description = postgres.describeDatabase(registrations, { ...options, refreshTriggers: 'perRow', ownerIndexes: 'all' });
    expect(hash(description)).toBe(saved.description);
    expect(hash(compileDatabaseSchema(description))).toBe(saved.ddl);
  });

  it.each(sqlSchemaOptInFixtures())('keeps the 3.5.9 default description of opt-in-only fixtures: $name', ({ name, registrations, options }) => {
    const saved = optIns.baselines.find((item) => item.name === name);
    for (const defaults of [{}, { refreshTriggers: 'perRow', ownerIndexes: 'all' }]) {
      const description = postgres.describeDatabase(registrations, { ...options, ...defaults });
      expect(hash(description)).toBe(saved.description);
      expect(hash(compileDatabaseSchema(description))).toBe(saved.ddl);
    }
  });

  it.each(optIns.snapshots.map((item) => ({ ...item, label: JSON.stringify(item.options) })))('pins the opt-in physical description and DDL: $name $label', ({ name, options, description, ddl }) => {
    const fixture = allFixtures().find((item) => item.name === name);
    const described = postgres.describeDatabase(fixture.registrations, { ...fixture.options, ...options });
    expect(hash(described)).toBe(description);
    expect(hash(compileDatabaseSchema(described))).toBe(ddl);
    // A snapshot equal to the default pins nothing about the option.
    const saved = defaultOf(name);
    expect(description).not.toBe(saved.description);
    expect(ddl).not.toBe(saved.ddl);
  });

  it.each(allFixtures())('pins each opt-in that changes the description: $name', ({ name, registrations, options }) => {
    const plain = hash(postgres.describeDatabase(registrations, options));
    for (const choice of optInChoices) {
      const changed = hash(postgres.describeDatabase(registrations, { ...options, ...choice })) !== plain;
      const pinned = optIns.snapshots.some((item) => item.name === name && JSON.stringify(item.options) === JSON.stringify(choice));
      expect({ choice, pinned }).toEqual({ choice, pinned: changed });
    }
  });

  it.each(allFixtures())('swaps refresh-trigger layouts in place, reproducing each layout exactly: $name', ({ registrations, options }) => {
    const perRow = postgres.describeDatabase(registrations, options);
    const perRoot = postgres.describeDatabase(registrations, { ...options, refreshTriggers: 'perRoot' });
    const all = (layout) => new Map(perRow.maintenance.map((item) => [item.rootTable, layout]));
    expect(withLayouts(perRoot, all('perRow'))).toEqual(perRow);
    expect(withLayouts(perRow, all('perRoot'))).toEqual(perRoot);
    expect(withLayouts(perRow, all('perRow'))).toEqual(perRow);
    expect({ ...perRoot, functions: undefined, triggers: undefined }).toEqual({ ...perRow, functions: undefined, triggers: undefined });
  });

  it('indexes single ID columns but not [ID] list columns, at the root or in owned tables', async () => {
    const { planRelationalSchema } = await import('../packages/sql/src/schema/plan.js');
    const registrations = () => {
      const Author = new GraphQLObjectType({ name: 'IdListAuthor', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
      const Link = new GraphQLObjectType({ name: 'IdListLink', fields: {
        author: { type: Author, extensions: { relation: { embedded: false } } },
        refIds: { type: new GraphQLList(GraphQLID) },
        refId: { type: GraphQLID },
      } });
      const Post = new GraphQLObjectType({ name: 'IdListPost', fields: {
        id: { type: GraphQLID }, externalId: { type: GraphQLID },
        relatedIds: { type: new GraphQLList(GraphQLID) },
        requiredIds: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLID))) },
        uniqueIds: { type: new GraphQLList(GraphQLID), extensions: { unique: true } },
        links: { type: new GraphQLList(Link), extensions: { relation: { embedded: true } } },
      } });
      return [{ gqltype: Author }, { gqltype: Post }];
    };
    const plan = planRelationalSchema(describeModels(registrations()), { schema: 'app', naming });
    const indexed = (name) => plan.tables.find((table) => table.name === name).indexes.filter((index) => !index.unique).map((index) => index.columns.join());
    expect(indexed('IdListPost')).toEqual(['externalId']);
    expect(indexed('IdListPost__links')).toEqual(['__owner_id', 'author', 'refId']);
    const listColumns = plan.tables.flatMap((table) => table.columns.filter((column) => column.scalar === 'ID' && column.list).map((column) => [table.name, column.name]));
    expect(listColumns).toEqual([['IdListPost', 'relatedIds'], ['IdListPost', 'requiredIds'], ['IdListPost', 'uniqueIds'], ['IdListPost__links', 'refIds']]);
    for (const [name, column] of listColumns) {
      expect(plan.tables.find((table) => table.name === name).indexes.some((index) => index.columns.includes(column))).toBe(false);
    }
    // Declared list uniqueness still uses the private key table, whose key column is a single uuid.
    const description = postgres.describeDatabase(registrations(), { schema: 'app' });
    expect(description.tables.find((table) => table.uniqueKeys).columns.find((column) => column.name === 'value').type).toBe('uuid');
    const ddl = compileDatabaseSchema(description).join('\n');
    expect(ddl).not.toMatch(/INDEX "[^"]*" ON "app"\."IdListPost(__links)?" \("(relatedIds|requiredIds|uniqueIds|refIds)"\)/);
    expect(ddl).toContain('CREATE INDEX "IdListPost__externalId__idx" ON "app"."IdListPost" ("externalId")');
    expect(ddl).toContain('CREATE INDEX "IdListPost__links__refId__idx" ON "app"."IdListPost__links" ("refId")');
  });
});
