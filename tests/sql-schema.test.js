import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { describeModels } from '@simtlix/simfinity-core';
import { sqlSchemaFixtures } from './contracts/sql-schema-fixtures.js';
import * as postgres from '../packages/postgres/src/schema/describe.js';
import { compileDatabaseSchema } from '../packages/postgres/src/schema/ddl.js';
import { identifier, generatedName } from '../packages/postgres/src/schema/sql.js';

const naming = { validateIdentifier: identifier, generatedName };
const baseline = JSON.parse(readFileSync(new URL('./fixtures/postgres-3.2-schema.json', import.meta.url), 'utf8'));
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

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
});
