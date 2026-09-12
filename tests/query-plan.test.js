import { describe, it, expect } from 'vitest';
import { describeModels } from '../packages/core/src/metadata.js';
import { createQueryPlan } from '../packages/core/src/query-plan.js';
import { createContractModelFixtures } from './contracts/model-fixtures.js';

const models = () => describeModels(createContractModelFixtures().registrations);
describe('database-independent query plans', () => {
  it('keeps scope predicates conjoined with caller OR and repeated relation paths', () => {
    const plan = createQueryPlan(models(), 'ContractSerie', {
      tenant: { value: 'a' }, seasons: { terms: [{ path: 'year', operator: 'GT', value: 2000 }, { path: 'year', operator: 'LT', value: 2030 }] },
      OR: [{ conditions: [{ field: 'title', value: 'Alpha' }] }, { conditions: [{ field: 'title', value: 'Beta' }] }],
      sort: { terms: [{ field: 'title', order: 'ASC' }] }, pagination: { page: 2, size: 10, count: true },
    });
    expect(plan.where.kind).toBe('and');
    expect(plan.where.terms.map((term) => term.kind)).toEqual(['predicate', 'predicate', 'predicate', 'or']);
    expect(plan.where.terms[1].path).toEqual(['seasons', 'year']);
    expect(plan.where.terms[2].path).toEqual(['seasons', 'year']);
    expect(plan.pagination).toEqual({ limit: 10, offset: 10 });
    expect(JSON.stringify(plan)).not.toMatch(/\$match|SELECT/);
  });
  it('validates paths, depth, operators, pagination and ambiguous syntax', () => {
    expect(() => createQueryPlan(models(), 'ContractSerie', { OR: [{ conditions: [{ field: 'title;DROP TABLE' }] }] })).toThrow(/path/i);
    expect(() => createQueryPlan(models(), 'ContractSerie', { title: { operator: 'BAD' } })).toThrow(/operator/i);
    expect(() => createQueryPlan(models(), 'ContractSerie', { OR: [{ conditions: [{ field: 'seasons.year', path: 'id' }] }] })).toThrow(/both/i);
    expect(() => createQueryPlan(models(), 'ContractSerie', { sort: { terms: [{ field: 'missing', order: 'ASC' }] } })).toThrow(/field/i);
    expect(() => createQueryPlan(models(), 'ContractSerie', { pagination: { page: -1, size: 10 } })).toThrow(/pagination/i);
    let group = { conditions: [{ field: 'title', value: 'x' }] };
    for (let i = 0; i < 7; i++) group = { AND: [group] };
    expect(() => createQueryPlan(models(), 'ContractSerie', { AND: [group] })).toThrow(/deep/i);
  });
});
