import { describe, expect, it } from 'vitest';
import { GraphQLID, GraphQLObjectType, GraphQLString } from 'graphql';
import { describeModels } from '../packages/core/src/index.js';
import { planRelationalSchema } from '../packages/sql/src/schema/plan.js';
import { createRecordStore } from '../packages/sql/src/records.js';
import { assertCapabilities } from '../packages/sql/src/plugin.js';
import { postgresPlugin } from '../packages/postgres/src/plugin.js';
import { describeRelationalSchema } from '../packages/postgres/src/schema/describe.js';
import { compileRecord } from '../packages/postgres/src/record-statements.js';
import { decodeScalar, encodeScalar, storageTypes } from '../packages/postgres/src/codecs.js';

const id = '11111111-1111-4111-8111-111111111111';
const maximum = Number.MAX_SAFE_INTEGER;
const version = { name: 'version', storageName: 'version', kind: 'scalar', scalar: 'Version', required: true, list: false, version: true };
const name = { name: 'name', storageName: 'name', kind: 'scalar', scalar: 'String', list: false };
const table = { name: 'Producto', columns: [{ name: 'id', type: 'uuid' }, { name: 'name', type: 'text' }, { name: 'version', type: 'bigint' }], primaryKey: { columns: ['id'] } };
const database = { schema: 'app', tables: [table] };
const type = (protectedType = true) => new GraphQLObjectType({ name: 'Producto', extensions: protectedType ? { concurrency: { mode: 'optimistic' } } : {}, fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
const store = (results, compiler = compileRecord) => {
  const statements = [];
  const plugin = { ...postgresPlugin(), compileRecord: compiler };
  const records = createRecordStore({ entities: [{ name: 'Producto', fields: [name, version], gqltype: type(false) }] }, database, async (statement, session) => {
    statements.push({ ...statement, session });
    return { rows: results.shift() || [] };
  }, plugin);
  return { records, statements };
};

describe('PostgreSQL optimistic concurrency statements', () => {
  it('increments a version under the same condition as the field update', () => {
    expect(compileRecord(database, { kind: 'update', table, id, data: { name: 'changed' }, version: { column: 'version', expected: 7 } })).toEqual({
      text: 'UPDATE "app"."Producto" SET "name" = $2::text, "version" = "version" + 1 WHERE id = $1::uuid AND "version" = $3::bigint RETURNING *', values: [id, 'changed', 7],
    });
  });
  it('issues a real UPDATE for empty data', () => {
    expect(compileRecord(database, { kind: 'update', table, id, data: {}, version: { column: 'version', expected: 7 } })).toEqual({
      text: 'UPDATE "app"."Producto" SET "version" = "version" + 1 WHERE id = $1::uuid AND "version" = $2::bigint RETURNING *', values: [id, 7],
    });
  });
  it('returns the ID from the conditional delete', () => {
    expect(compileRecord(database, { kind: 'deleteById', table, id, version: { column: 'version', expected: maximum } })).toEqual({
      text: 'DELETE FROM "app"."Producto" WHERE id = $1::uuid AND "version" = $2::bigint RETURNING id', values: [id, maximum],
    });
  });
  it('pin: preserves the exact unversioned update and delete', () => {
    expect(compileRecord(database, { kind: 'update', table, id, data: { name: 'changed' } })).toEqual({ text: 'UPDATE "app"."Producto" SET "name" = $2::text WHERE id = $1::uuid RETURNING *', values: [id, 'changed'] });
    expect(compileRecord(database, { kind: 'deleteById', table, id })).toEqual({ text: 'DELETE FROM "app"."Producto" WHERE id = $1::uuid', values: [id] });
  });
});

describe('PostgreSQL optimistic concurrency storage', () => {
  it('plans a required Version column with default 1 and the capability', () => {
    const plan = planRelationalSchema(describeModels([{ gqltype: type() }]));
    expect(plan.tables[0].columns.find((column) => column.name === 'version')).toMatchObject({ scalar: 'Version', nullable: false, default: { kind: 'value', value: 1 } });
    expect(plan.requirements).toContain('optimisticConcurrency');
    expect(describeRelationalSchema(plan).tables[0].columns.find((column) => column.name === 'version')).toEqual({ name: 'version', type: 'bigint', nullable: false, default: '1' });
    expect(storageTypes.Version).toBe('bigint');
  });
  it('requires a declaring plugin and PostgreSQL declares support', () => {
    const plugin = postgresPlugin();
    expect(plugin.capabilities).toContain('optimisticConcurrency');
    const plan = { requirements: ['optimisticConcurrency'] };
    expect(() => assertCapabilities(plugin, plan)).not.toThrow();
    expect(() => assertCapabilities({ ...plugin, capabilities: ['transactions'] }, plan)).toThrow(expect.objectContaining({ extensions: expect.objectContaining({ code: 'UNSUPPORTED_SQL_CAPABILITY', status: 400 }) }));
  });
  it.each([1, 17, maximum])('encodes the safe version %s', (value) => { expect(encodeScalar(version, value)).toBe(value); });
  it.each([0, -1, 1.5, maximum + 1, '1', 1n, NaN, Infinity])('rejects invalid version input %s', (value) => {
    expect(() => encodeScalar(version, value)).toThrow();
  });
  it.each(['1', '9007199254740991', 17, 17n])('decodes a safe stored version %s to a number', (value) => { expect(decodeScalar(version, value)).toBe(Number(value)); });
  it.each(['9007199254740992', 9007199254740992n, maximum + 1, '0', 0, -1n, 'not-a-version', {}, true])('retains invalid stored value %s for the core diagnostic', (value) => { expect(decodeScalar(version, value)).toBe(value); });
});

describe('SQL record-store conditional writes', () => {
  it('executes an empty conditional update and hydrates the returned version', async () => {
    const { records, statements } = store([[{ id, name: 'original', version: '8' }]]);
    const session = {};
    expect(await records.update('Producto', id, {}, session, { expectedVersion: 7 })).toMatchObject({ version: 8 });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({ values: [id, 7], session });
    expect(statements[0].text).toMatch(/^UPDATE /);
  });
  it.each([
    ['missing', [], null],
    ['stale', [{ id, version: '8' }], 'VERSION_CONFLICT'],
    ['unchanged', [{ id, version: '7' }], null],
    ['corrupt', [{ id, version: '9007199254740992' }], 'DATABASE_ERROR'],
  ])('disambiguates an update with no matching row: %s', async (_label, rows, code) => {
    const { records, statements } = store([[], rows]);
    const promise = records.update('Producto', id, { name: 'change' }, {}, { expectedVersion: 7 });
    if (code) await expect(promise).rejects.toMatchObject({ extensions: { code } });
    else expect(await promise).toBeNull();
    expect(statements[1].text).toMatch(/^SELECT /);
    expect(statements[1].session).toBe(statements[0].session);
  });
  it.each([['exhausted', String(maximum), 'VERSION_EXHAUSTED'], ['stale', '7', 'VERSION_CONFLICT'], ['missing', undefined, null]])('skips an exhausted update and reads existence: %s', async (_label, value, code) => {
    const { records, statements } = store([value === undefined ? [] : [{ id, version: value }]]);
    const promise = records.update('Producto', id, {}, {}, { expectedVersion: maximum });
    if (code) await expect(promise).rejects.toMatchObject({ extensions: { code } });
    else expect(await promise).toBeNull();
    expect(statements).toHaveLength(1);
    expect(statements[0].text).toMatch(/^SELECT /);
  });
  it('rejects a plugin copy that strips operation.version', async () => {
    const { records } = store([[{ id, name: 'changed', version: '7' }]], (db, operation) => { const copy = { ...operation }; delete copy.version; return compileRecord(db, copy); });
    await expect(records.update('Producto', id, { name: 'changed' }, {}, { expectedVersion: 7 })).rejects.toMatchObject({ extensions: { code: 'DATABASE_ERROR' } });
  });
  it('locks before deleting and returns the matching record at the maximum version', async () => {
    const { records, statements } = store([[{ id, version: String(maximum) }], [{ id }]]);
    expect(await records.remove('Producto', id, {}, { expectedVersion: maximum })).toMatchObject({ id, version: maximum });
    expect(statements[0].text).toMatch(/FOR UPDATE$/);
    expect(statements[1].values).toEqual([id, maximum]);
  });
  it('rejects a delete without RETURNING after its locked read', async () => {
    const { records } = store([[{ id, version: '7' }], []], (db, operation) => {
      const statement = compileRecord(db, operation);
      return { ...statement, text: statement.text.replace(' RETURNING id', '') };
    });
    await expect(records.remove('Producto', id, {}, { expectedVersion: 7 })).rejects.toMatchObject({ extensions: { code: 'DATABASE_ERROR' } });
  });
  it('does not delete a stale version', async () => {
    const { records, statements } = store([[{ id, version: '8' }]]);
    await expect(records.remove('Producto', id, {}, { expectedVersion: 7 })).rejects.toMatchObject({ extensions: { code: 'VERSION_CONFLICT' } });
    expect(statements).toHaveLength(1);
  });
  it('pin: an empty unversioned update remains a read, and delete reads without a lock', async () => {
    const { records, statements } = store([[{ id, version: 7 }], [{ id, version: 7 }], []]);
    await records.update('Producto', id, {}, {});
    await records.remove('Producto', id, {});
    expect(statements.map(({ text }) => text)).toEqual(['SELECT * FROM "app"."Producto" WHERE id = $1::uuid', 'SELECT * FROM "app"."Producto" WHERE id = $1::uuid', 'DELETE FROM "app"."Producto" WHERE id = $1::uuid']);
  });
});
