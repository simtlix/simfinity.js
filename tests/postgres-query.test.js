import { describe, it, expect } from 'vitest';
import { describeModels } from '../packages/core/src/metadata.js';
import { createQueryPlan } from '../packages/core/src/query-plan.js';
import { describeDatabase } from '../packages/postgres/src/schema/describe.js';
import { compileQuery } from '../packages/postgres/src/query/compiler.js';
import { createContractModelFixtures } from './contracts/model-fixtures.js';

const compile = (args, options) => {
  const { registrations } = createContractModelFixtures();
  const models = describeModels(registrations);
  return compileQuery(models, describeDatabase(registrations, { schema: 'app' }), createQueryPlan(models, 'ContractSerie', args, options));
};
describe('PostgreSQL query compilation', () => {
  it('binds every value and reuses correlated relation joins without distinct', () => {
    const result = compile({ tenant: { value: '\'; DROP TABLE test; --' }, seasons: { terms: [
      { path: 'year', operator: 'GTE', value: 2000 }, { path: 'year', operator: 'LTE', value: 2030 },
    ] } });
    expect(result.text).not.toContain('DROP TABLE');
    expect(result.values).toContain('\'; DROP TABLE test; --');
    expect(result.text.match(/LEFT JOIN "app"\."ContractSeason"/g)).toHaveLength(1);
    expect(result.text).not.toContain('SELECT DISTINCT');
  });
  it('expresses Mongo null/array/LIKE semantics explicitly', () => {
    expect(compile({ title: { operator: 'NE', value: 'a' } }).text).toContain('IS DISTINCT FROM');
    expect(compile({ categories: { value: 'Drama' } }).text).toContain('array_position');
    expect(compile({ title: { operator: 'LIKE', value: '%_.*' } }).text).toContain('strpos');
    expect(compile({ title: { operator: 'IN', value: [] } }).text).toContain('FALSE');
    expect(compile({ title: { operator: 'NIN', value: [] } }).text).toContain('TRUE');
  });
  it('rejects embedded-list grouping whose missing-value projection cannot be preserved', () => {
    expect(() => compile({ aggregation: { groupId: 'credits.role', facts: [{ path: 'id', operation: 'COUNT', factName: 'count' }] } }, { mode: 'aggregate' })).toThrow('Grouping by a scalar path inside an embedded list');
  });
});
