import { describe, it, expect } from 'vitest';
import {
  GraphQLID, GraphQLInt, GraphQLObjectType, GraphQLString,
} from 'graphql';
import { describeModels } from '../packages/core/src/metadata.js';
import { collectQueryPaths, createQueryPlan } from '../packages/core/src/query-plan.js';
import { createContractModelFixtures } from './contracts/model-fixtures.js';
import { createReferenceEmptinessTypes } from './helpers/query-emptiness.js';

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
    expect(plan.where.terms.map((term) => term.kind)).toEqual(['predicate', 'quantified', 'or']);
    expect(plan.where.terms[1].path).toEqual(['seasons']);
    expect(plan.where.terms[1].where.terms.map((term) => term.path)).toEqual([['year'], ['year']]);
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


describe('phase2 fix1 planner compatibility', () => {
  const fixture = () => {
    const types = createReferenceEmptinessTypes('FixPlan');
    return describeModels([types.Shop, types.Pro, types.Product, types.Review].map((gqltype) => ({ gqltype }))
      .concat(types.embedded.map((gqltype) => ({ gqltype, endpoint: false }))));
  };
  const failure = (input, options) => {
    try { createQueryPlan(fixture(), 'FixPlanProduct', input, options); } catch (error) { return error; }
    return null;
  };
  it.each([true, false].flatMap((quantifiers) => ['shop.name', 'odim.w', 'odim.shop.name'].flatMap((field) => [false, true].map((empty) => [quantifiers, field, empty]))))(
    'pin: dotted default scalar carrier quantifiers=%s field=%s empty=%s', (quantifiers, field, empty) => {
      const value = field === 'odim.w' ? 1 : 'S1';
      const terms = empty ? [] : [{ path: 'ignored', operator: 'EQ', value: 'x' }];
      const options = { operators: ['EQ'], referenceEmptiness: true, quantifiers };
      for (const filter of [{ value, terms }, { operator: 'EQ', value, terms }, { value }]) {
        expect(createQueryPlan(fixture(), 'FixPlanProduct', { [field]: filter }, options).where)
          .toEqual({ kind: 'predicate', path: field.split('.'), operator: 'EQ', value });
      }
      expect(failure({ [field]: { terms } }, options)?.message).toBe('Expected a scalar filter value');
    },
  );
  it.each([true, false].flatMap((quantifiers) => ['find', 'count', 'aggregate'].map((mode) => [quantifiers, mode])))(
    'pin: ordinary list diagnostics quantifiers=%s mode=%s', (quantifiers, mode) => {
      const options = { quantifiers, referenceEmptiness: true, mode };
      const aggregation = { groupId: 'name', facts: [{ operation: 'COUNT', path: 'id', factName: 'n' }] };
      for (const operator of ['IN', 'NIN', 'BTW']) {
        for (const [value, message] of [['x', `${operator} requires an array value`], [[null], 'Filter lists require non-null scalar elements'], [[['x']], 'Filter lists require non-null scalar elements'], [null, 'Expected a scalar filter value']]) {
          const error = failure({ name: { operator, value }, ...(mode === 'aggregate' ? { aggregation } : {}) }, options);
          expect(error?.message).toBe(message);
          expect(error?.extensions).toMatchObject({ code: 'INVALID_FILTER_VALUE', status: 400 });
        }
      }
      expect(failure({ name: { operator: 'BTW', value: ['x'] } }, { ...options, mode: 'find' })?.message).toBe('BTW requires two values');
      expect(createQueryPlan(fixture(), 'FixPlanProduct', { name: { operator: 'IN', value: ['x'] } }, { ...options, mode: 'find' }).where.value).toEqual(['x']);
    },
  );
  it.each([true, false].flatMap((quantifiers) => ['find', 'aggregate'].map((mode) => [quantifiers, mode])))(
    'pin: ordinary sort diagnostics quantifiers=%s mode=%s', (quantifiers, mode) => {
      const options = { quantifiers, referenceEmptiness: true, mode };
      const aggregation = { groupId: 'name', facts: [{ operation: 'COUNT', path: 'id', factName: 'n' }] };
      for (const [sort, message] of [[{}, 'Sort requires non-empty terms'], [{ terms: [] }, 'Sort requires non-empty terms'], [{ terms: 'x' }, 'Sort requires non-empty terms'], [{ terms: [null] }, 'Invalid sort order'], [{ terms: [{ field: 'name', order: 'BAD' }] }, 'Invalid sort order']]) {
        const error = failure({ sort, ...(mode === 'aggregate' ? { aggregation } : {}) }, options);
        expect(error?.message).toBe(message);
        expect(error?.extensions).toMatchObject({ code: 'INVALID_SORT', status: 400 });
      }
      expect(createQueryPlan(fixture(), 'FixPlanProduct', { sort: { terms: [{ field: 'name', order: 'ASC' }] }, ...(mode === 'aggregate' ? { aggregation } : {}) }, options).sort)
        .toEqual([{ path: ['name'], order: 'ASC' }]);
    },
  );
  it.each([true, false])('validates count sort terms with established messages quantifiers=%s', (quantifiers) => {
    for (const term of [null, { field: 'name', order: 'BAD' }]) {
      const error = failure({ sort: { terms: [term] } }, { mode: 'count', quantifiers, referenceEmptiness: true });
      expect(error?.message).toBe('Invalid sort order');
      expect(error?.extensions).toMatchObject({ code: 'INVALID_SORT', status: 400 });
    }
  });
});


describe('phase5 L3-1 direct scalar planner', () => {
  const own = createReferenceEmptinessTypes('L3');
  const schema = describeModels([own.Shop, own.Pro, own.Product, own.Review, ...own.embedded].map((gqltype) => ({ gqltype })));
  const predicate = (path, operator, value) => ({ kind: 'predicate', path: path.split('.'), operator, value });
  const any = (path, where, extra = {}) => ({ kind: 'quantified', quantifier: 'ANY', path: path.split('.'), where, scope: null, ...extra });
  const make = (input, options) => createQueryPlan(schema, 'L3Product', input, options);
  it.each([{ operator: 'GTE', value: 4 }, { value: 4, terms: [] }, { value: 4, terms: [{ path: 'invalid..ignored', operator: 'FUTURE' }] }])(
    'uses a frame for the actual direct scalar carrier %j', (filter) => {
      const expected = any('reviews', predicate('rating', filter.operator ?? 'EQ', 4));
      const direct = make({ 'reviews.rating': filter });
      const grouped = make({ AND: [{ conditions: [{ field: 'reviews.rating', operator: filter.operator, value: 4 }] }] });
      expect(direct.where).toEqual(expected);
      expect(direct.where).toEqual(grouped.where);
    },
  );
  it('gives each direct scalar entry a frame separate from adjacent relation and logical groups', () => {
    expect(make({
      'reviews.rating': { operator: 'GTE', value: 4 }, 'reviews.author': { value: 'hidden' },
      reviews: { terms: [{ path: 'author', value: 'x' }] }, AND: [{ conditions: [{ field: 'reviews.rating', operator: 'LT', value: 2 }] }],
    }).where).toEqual({ kind: 'and', terms: [
      any('reviews', predicate('rating', 'LT', 2)), any('reviews', predicate('rating', 'GTE', 4)),
      any('reviews', predicate('author', 'EQ', 'hidden')), any('reviews', predicate('author', 'EQ', 'x')),
    ] });
  });
  it('anchors a direct scalar frame after J and intervening references', () => {
    const input = { 'reviews.product.reviews.rating': { operator: 'GTE', value: 1 }, aggregation: { groupId: 'reviews.author', facts: [{ operation: 'COUNT', path: 'id', factName: 'n' }] } };
    expect(make(input, { mode: 'aggregate' }).where).toEqual(any('reviews', predicate('rating', 'GTE', 1), { anchor: ['reviews', 'product'] }));
  });
  it('pin: preserves reference-only, disabled collection and all-J scalar predicates', () => {
    expect(make({ 'shop.name': { value: 'S1', terms: [{ path: 'ignored' }] } }).where).toEqual(predicate('shop.name', 'EQ', 'S1'));
    expect(make({ 'reviews.rating': { operator: 'GTE', value: 4 } }, { quantifiers: false }).where).toEqual(predicate('reviews.rating', 'GTE', 4));
    const aggregation = { groupId: 'reviews.author', facts: [{ operation: 'COUNT', path: 'id', factName: 'n' }] };
    expect(make({ 'reviews.rating': { operator: 'GTE', value: 4 }, aggregation }, { mode: 'aggregate' }).where).toEqual(predicate('reviews.rating', 'GTE', 4));
  });
});
