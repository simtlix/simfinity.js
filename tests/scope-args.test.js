import { describe, expect, test } from 'vitest';
import {
  GraphQLID, GraphQLList, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';

import { createRuntime } from '../packages/core/src/index.js';

const rows = {
  ScopeArgsSerie: [
    { _id: 's1', id: 's1', name: 'A serie', tenantId: 'A' },
    { _id: 's2', id: 's2', name: 'B serie', tenantId: 'B' },
  ],
  ScopeArgsSeason: [
    { _id: 'c1', id: 'c1', number: '1', tenantId: 'A', serieKey: 's1' },
    { _id: 'c2', id: 'c2', number: '2', tenantId: 'B', serieKey: 's1' },
  ],
};

const tenantOf = (args) => (args.AND || [])
  .flatMap((group) => group.conditions || [])
  .filter((condition) => condition.field === 'tenantId' && condition.operator === 'EQ')
  .map((condition) => condition.value);

const applyTenant = (records, args) => {
  const tenants = tenantOf(args);
  return records.filter((record) => tenants.every((tenant) => record.tenantId === tenant));
};

const createAdapter = (calls) => ({
  bind() {},
  prepare() {},
  createModel: (gqltype) => ({ name: gqltype.name }),
  castId: String,
  withTransaction: async (session, body) => body(session || {}),
  async getById(Model, id) {
    return rows[Model.name].find((record) => record._id === id) || null;
  },
  async find(Model, gqltype, args) {
    calls.push({ method: 'find', args });
    return applyTenant(rows[Model.name], args);
  },
  async count(Model, gqltype, args) {
    calls.push({ method: 'count', args });
    return applyTenant(rows[Model.name], args).length;
  },
  async aggregate(Model, gqltype, args) {
    calls.push({ method: 'aggregate', args });
    const groups = {};
    for (const record of applyTenant(rows[Model.name], args)) {
      groups[record.tenantId] = (groups[record.tenantId] || 0) + 1;
    }
    return Object.entries(groups).map(([groupId, count]) => ({ groupId, facts: { count } }));
  },
  async findChildren(Model, gqltype, connectionField, parentId, args) {
    calls.push({ method: 'findChildren', args });
    return applyTenant(rows[Model.name].filter((record) => record[connectionField] === parentId), args);
  },
});

const buildSchema = (calls) => {
  const runtime = createRuntime(createAdapter(calls));
  const tenantScope = async ({ args, context }) => {
    args.AND = [
      ...(args.AND || []),
      { conditions: [{ field: 'tenantId', operator: 'EQ', value: context.user.tenantId }] },
    ];
  };
  const scope = { find: tenantScope, get_by_id: tenantScope, aggregate: tenantScope };
  const SeasonType = new GraphQLObjectType({
    name: 'ScopeArgsSeason',
    extensions: { scope },
    fields: () => ({
      id: { type: GraphQLID },
      number: { type: GraphQLString },
      tenantId: { type: GraphQLString, extensions: { readOnly: true } },
      serieKey: { type: GraphQLID, extensions: { readOnly: true } },
    }),
  });
  const SerieType = new GraphQLObjectType({
    name: 'ScopeArgsSerie',
    extensions: { scope },
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      tenantId: { type: GraphQLString, extensions: { readOnly: true } },
      seasons: {
        type: new GraphQLList(SeasonType),
        extensions: { relation: { embedded: false, connectionField: 'serieKey' } },
      },
    }),
  });
  runtime.connect(null, SeasonType, 'scopeArgsSeason', 'scopeArgsSeasons');
  runtime.connect(null, SerieType, 'scopeArgsSerie', 'scopeArgsSeries');
  // Normalizes arguments immutably by replacing params.args.
  runtime.use(async (params, next) => {
    if (params.operation === 'find' || params.operation === 'aggregate') {
      params.args = { ...params.args, pagination: params.args.pagination || { page: 1, size: 25 } };
    }
    await next();
  });
  return runtime.createSchema();
};

describe('query scope after middleware replaces params.args', () => {
  const run = async (source) => {
    const calls = [];
    const context = { user: { tenantId: 'A' } };
    const result = await graphql({ schema: buildSchema(calls), source, contextValue: context });
    expect(result.errors).toBeUndefined();
    return { data: result.data, calls, context };
  };

  test('list queries send the scoped replacement arguments to the adapter', async () => {
    const { data, calls } = await run('{ scopeArgsSeries { id tenantId } }');

    expect(data.scopeArgsSeries).toEqual([{ id: 's1', tenantId: 'A' }]);
    expect(calls).toHaveLength(1);
    expect(tenantOf(calls[0].args)).toEqual(['A']);
    expect(calls[0].args.pagination).toEqual({ page: 1, size: 25 });
  });

  test('count uses the scoped replacement arguments', async () => {
    const { data, calls, context } = await run(
      '{ scopeArgsSeries(pagination: { page: 1, size: 10, count: true }) { id } }',
    );

    expect(data.scopeArgsSeries).toEqual([{ id: 's1' }]);
    expect(context.count).toBe(1);
    expect(calls.map((call) => call.method).sort()).toEqual(['count', 'find']);
    for (const call of calls) expect(tenantOf(call.args)).toEqual(['A']);
  });

  test('aggregations use the scoped replacement arguments', async () => {
    const { data, calls } = await run(`{
      scopeArgsSeries_aggregate(aggregation: {
        groupId: "tenantId", facts: [{ operation: COUNT, factName: "count", path: "id" }]
      }) { groupId facts }
    }`);

    expect(data.scopeArgsSeries_aggregate).toEqual([{ groupId: 'A', facts: { count: 1 } }]);
    expect(calls).toHaveLength(1);
    expect(tenantOf(calls[0].args)).toEqual(['A']);
  });

  test('generated collection relations use the scoped replacement arguments', async () => {
    const { data, calls } = await run('{ scopeArgsSeries { id seasons { id tenantId } } }');

    expect(data.scopeArgsSeries).toEqual([{ id: 's1', seasons: [{ id: 'c1', tenantId: 'A' }] }]);
    const children = calls.filter((call) => call.method === 'findChildren');
    expect(children).toHaveLength(1);
    expect(tenantOf(children[0].args)).toEqual(['A']);
    expect(children[0].args.pagination).toEqual({ page: 1, size: 25 });
  });
});
