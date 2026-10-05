import { describe, it, expect } from 'vitest';
import {
  GraphQLID, GraphQLInt, GraphQLObjectType, GraphQLString,
} from 'graphql';
import { describeModels } from '../packages/core/src/metadata.js';
import { collectQueryPaths, createQueryPlan } from '../packages/core/src/query-plan.js';
import { createContractModelFixtures } from './contracts/model-fixtures.js';

const models = () => describeModels(createContractModelFixtures().registrations);
// Fields named like generated query arguments, next to a type without them.
const collisionModels = () => {
  const Owner = new GraphQLObjectType({ name: 'PlanOwner', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
  const Collision = new GraphQLObjectType({
    name: 'PlanCollision',
    fields: {
      id: { type: GraphQLID },
      key: { type: GraphQLString },
      conditions: { type: GraphQLString },
      aggregation: { type: GraphQLInt },
      sort: { type: GraphQLString },
      owner: { type: Owner, extensions: { relation: { connectionField: 'owner' } } },
    },
  });
  const Plain = new GraphQLObjectType({ name: 'PlanPlain', fields: { id: { type: GraphQLID }, key: { type: GraphQLString } } });
  return describeModels([{ gqltype: Owner }, { gqltype: Collision }, { gqltype: Plain }]);
};
const codeOf = (body) => {
  try {
    body();
  } catch (error) {
    return [error.message, error.extensions?.code];
  }
  return null;
};
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
  it.each([
    { seasons: { terms: [null] } },
    { seasons: { terms: [42] } },
    { seasons: { terms: [{}] } },
  ])('rejects malformed relationship terms with a domain error: %j', (input) => {
    expect(() => createQueryPlan(models(), 'ContractSerie', input)).toThrowError(expect.objectContaining({ extensions: expect.objectContaining({ code: expect.stringMatching(/^INVALID_FILTER/) }) }));
  });

  it('plans a top-level filter on a field named conditions', () => {
    expect(createQueryPlan(collisionModels(), 'PlanCollision', { conditions: { value: 'c1' } }).where)
      .toEqual({ kind: 'predicate', path: ['conditions'], operator: 'EQ', value: 'c1' });
    expect(codeOf(() => createQueryPlan(collisionModels(), 'PlanCollision', { conditions: 'x' })))
      .toEqual(['Expected a filter object', 'INVALID_FILTER_VALUE']);
    // Only AND/OR are group lists at the top level; elsewhere `conditions` is an unknown field.
    expect(codeOf(() => createQueryPlan(collisionModels(), 'PlanPlain', { conditions: 'x' })))
      .toEqual(['Unknown field conditions', 'INVALID_FILTER_FIELD']);
    expect(codeOf(() => createQueryPlan(collisionModels(), 'PlanPlain', { conditions: [] })))
      .toEqual(['Unknown field conditions', 'INVALID_FILTER_FIELD']);
    expect(codeOf(() => createQueryPlan(collisionModels(), 'PlanCollision', { AND: {} })))
      .toEqual(['AND requires an array', 'INVALID_FILTER_VALUE']);
    expect(codeOf(() => createQueryPlan(collisionModels(), 'PlanCollision', { OR: 'x' })))
      .toEqual(['OR requires an array', 'INVALID_FILTER_VALUE']);
    expect(codeOf(() => createQueryPlan(collisionModels(), 'PlanCollision', { AND: [{ conditions: {} }] })))
      .toEqual(['conditions requires an array', 'INVALID_FILTER_VALUE']);
  });

  it('treats aggregation as a field filter on find and count and as the expression on aggregate', () => {
    const filter = { aggregation: { operator: 'GT', value: 5 } };
    const predicate = { kind: 'predicate', path: ['aggregation'], operator: 'GT', value: 5 };
    expect(createQueryPlan(collisionModels(), 'PlanCollision', filter).where).toEqual(predicate);
    expect(createQueryPlan(collisionModels(), 'PlanCollision', filter, { mode: 'count' }).where).toEqual(predicate);

    const expression = { groupId: 'conditions', facts: [{ operation: 'SUM', factName: 'total', path: 'aggregation' }] };
    const aggregate = createQueryPlan(collisionModels(), 'PlanCollision', {
      aggregation: expression,
      AND: [{ conditions: [{ field: 'aggregation', operator: 'GT', value: 5 }] }],
    }, { mode: 'aggregate' });
    expect(aggregate.where).toEqual(predicate);
    expect(aggregate.aggregation).toEqual({
      groupId: ['conditions'], facts: [{ operation: 'SUM', factName: 'total', path: ['aggregation'] }],
    });
    // An aggregation expression in find arguments is a malformed filter, never silently dropped.
    expect(codeOf(() => createQueryPlan(collisionModels(), 'PlanCollision', { aggregation: expression })))
      .toEqual(['Expected a scalar filter value', 'INVALID_FILTER_VALUE']);
    expect(codeOf(() => createQueryPlan(collisionModels(), 'PlanPlain', { aggregation: expression })))
      .toEqual(['Unknown field aggregation', 'INVALID_FILTER_FIELD']);
  });

  it('keeps sort and pagination as controls and sorts by a field named sort', () => {
    const plan = createQueryPlan(collisionModels(), 'PlanCollision', {
      sort: { terms: [{ field: 'sort', order: 'DESC' }] },
      pagination: { page: 1, size: 5 },
      AND: [{ conditions: [{ field: 'sort', value: 's1' }] }],
    });
    expect(plan.where).toEqual({ kind: 'predicate', path: ['sort'], operator: 'EQ', value: 's1' });
    expect(plan.sort).toEqual([{ path: ['sort'], order: 'DESC' }]);
    expect(plan.pagination).toEqual({ limit: 5, offset: 0 });
  });

  it('collects an aggregation filter path only outside aggregate mode', () => {
    expect(collectQueryPaths({ aggregation: { operator: 'GT', value: 5 } })).toEqual([['aggregation']]);
    expect(collectQueryPaths({ aggregation: { terms: [{ path: 'name', value: 'x' }] } }, 'find'))
      .toEqual([['aggregation', 'name']]);
    expect(collectQueryPaths({
      aggregation: { groupId: 'owner.name', facts: [{ operation: 'SUM', factName: 'total', path: 'aggregation' }] },
      sort: { terms: [{ field: 'total', order: 'ASC' }] },
    }, 'aggregate')).toEqual([['owner', 'name'], ['aggregation']]);
    expect(collectQueryPaths({ sort: { terms: [{ field: 'sort', order: 'ASC' }] }, pagination: { page: 1, size: 1 } }))
      .toEqual([['sort']]);
  });
});
