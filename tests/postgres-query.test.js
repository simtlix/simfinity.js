import { GraphQLObjectType, GraphQLString, GraphQLList } from 'graphql';
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
  it('projects embedded-list group keys with presence and stable child order', () => {
    const result = compile({ aggregation: { groupId: 'credits.role', facts: [{ path: 'id', operation: 'COUNT', factName: 'count' }] } }, { mode: 'aggregate' });
    expect(result.text).toContain('jsonb_agg');
    expect(result.text).toContain('__field__role__present');
    expect(result.text).toContain('__position');
    expect(result.text).toContain('__simfinity_sort_key');
  });
  it('parameterizes nested list values and rejects malformed sort paths before SQL compilation', () => {
    const Leaf = new GraphQLObjectType({ name: 'CompileLeaf', fields: { texts: { type: new GraphQLList(GraphQLString) } } });
    const Root = new GraphQLObjectType({ name: 'CompileRoot', fields: { entries: { type: new GraphQLList(Leaf), extensions: { relation: { embedded: true } } } } });
    const registrations = [{ gqltype: Root }];
    const models = describeModels(registrations);
    const database = describeDatabase(registrations);
    const injected = '\'; DROP TABLE private_data; --';
    const result = compileQuery(models, database, createQueryPlan(models, 'CompileRoot', { entries: { terms: [{ path: 'texts', operator: 'LIKE', value: injected }] } }));
    expect(result.values).toContain(injected);
    expect(result.text).not.toContain(injected);
    for (const field of ['entries..texts', 'entries.texts;DROP', 'entries.missing']) expect(() => createQueryPlan(models, 'CompileRoot', { sort: { terms: [{ field, order: 'ASC' }] } })).toThrow();
    expect(() => createQueryPlan(models, 'CompileRoot', { sort: { terms: [{ field: 'entries.texts', order: 'BAD' }] } })).toThrow();
    expect(() => compileQuery(models, database, createQueryPlan(models, 'CompileRoot', { aggregation: { groupId: 'entries', facts: [{ path: 'entries.texts', operation: 'COUNT', factName: 'n' }] } }, { mode: 'aggregate' }))).toThrow('Whole embedded objects');
  });

});
