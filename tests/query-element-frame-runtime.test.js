import { describe, expect, it } from 'vitest';
import { GraphQLID, GraphQLInt, GraphQLList, GraphQLObjectType, GraphQLString, graphql } from 'graphql';
import { createRuntime, createQueryPlan, describeModels, QLOperator } from '../packages/core/src/index.js';
import { collectQueryPathEntries } from '../packages/core/src/query-plan.js';
import { resolveQueryFeatures } from '../packages/core/src/query-operators.js';
import * as auth from '../packages/core/src/auth/index.js';

let ordinal = 0;
const features = { operators: QLOperator.getValues().map(({ value }) => value), referenceEmptiness: true, quantifiers: true, valuePath: true, elementFrames: true };
const build = ({ capability = true, permissions, middleware } = {}) => {
  const prefix = `ElementRuntime${++ordinal}`;
  const calls = [];
  const adapter = {
    queryFeatures: { ...features, elementFrames: capability },
    bind() {}, prepare() {}, castId: String,
    createModel: (gqltype) => ({ name: gqltype.name }),
    getById: async (_, id) => ({ id, _id: id }),
    withTransaction: async (session, body) => body(session || {}),
    find: async (_, type, args) => {
      const plan = createQueryPlan(models, type.name, args);
      calls.push({ args: structuredClone(args), plan });
      return [];
    },
  };
  const runtime = createRuntime(adapter);
  const Provider = new GraphQLObjectType({ name: `${prefix}Provider`,
    extensions: { scope: { find: ({ args }) => { args.tenant = { value: 'A' }; } } },
    fields: () => ({ id: { type: GraphQLID }, limit: { type: GraphQLInt }, tenant: { type: GraphQLString },
      shipping: { type: Shipping, extensions: { relation: { embedded: true } } },
    }) });
  const Line = new GraphQLObjectType({ name: `${prefix}Line`, fields: {
    quantity: { type: GraphQLInt }, limit: { type: GraphQLInt }, provider: { type: Provider, extensions: { relation: { embedded: false } } },
  } });
  const Shipping = new GraphQLObjectType({ name: `${prefix}Shipping`, fields: {
    limit: { type: GraphQLInt }, lines: { type: new GraphQLList(Line), extensions: { relation: { embedded: true } } },
  } });
  const Order = new GraphQLObjectType({ name: `${prefix}Order`, fields: {
    id: { type: GraphQLID }, limit: { type: GraphQLInt },
    secret: { type: GraphQLInt, extensions: { queryable: false } },
    provider: { type: Provider, extensions: { relation: { embedded: false } } },
    shipping: { type: Shipping, extensions: { relation: { embedded: true } } },
    lines: { type: new GraphQLList(Line), extensions: { relation: { embedded: true } } },
  } });
  runtime.addNoEndpointType(Line);
  runtime.addNoEndpointType(Shipping);
  runtime.connect(null, Provider, 'provider', 'providers');
  runtime.connect(null, Order, 'order', 'orders');
  const models = describeModels([Order, Provider].map((gqltype) => ({ gqltype })));
  if (middleware) runtime.use(middleware);
  const schema = runtime.createSchema();
  if (permissions) auth.createAuthPlugin(permissions({ Order, Provider, Line }), { defaultPolicy: 'ALLOW' }).onSchemaChange({ schema });
  const run = (valuePath, path = 'lines', field = 'quantity') => graphql({ schema,
    source: `{ orders(AND: [{ ALL: [{ path: "${path}", conditions: [{ field: "${field}", operator: LTE, valuePath: "${valuePath}" }] }] }]) { id } }` });
  return { run, calls, Order, Provider, schema, runtime };
};
const code = (result, value) => expect(result.errors?.[0]?.extensions?.code).toBe(value);

describe('embedded query runtime', () => {
  it('requires an explicit complete capability declaration', () => {
    expect(resolveQueryFeatures().elementFrames).toBe(false);
    expect(resolveQueryFeatures(features).elementFrames).toBe(true);
    for (const extra of [{ elementFrames: 'yes' }, { quantifiers: false }, { valuePath: false }, { referenceEmptiness: false }]) {
      expect(() => resolveQueryFeatures({ ...features, ...extra }))
        .toThrow(expect.objectContaining({ extensions: expect.objectContaining({ code: 'INVALID_QUERY_FEATURES' }) }));
    }
  });

  it('admits parent comparisons only when the adapter declares support', async () => {
    const f = build();
    expect((await f.run('$parent.limit')).errors).toBeUndefined();
    expect(f.calls[0].plan.where.where.operand.container).toEqual({ up: 1, path: [] });
    const legacy = build({ capability: false });
    code(await legacy.run('$parent.limit'), 'UNSUPPORTED_QUERY');
    expect(legacy.calls).toEqual([]);
  });

  it('checks queryability and read rules on unselected parent fields', async () => {
    const f = build();
    code(await f.run('$parent.secret'), 'FORBIDDEN_FILTER_PATH');
    expect(f.calls).toEqual([]);
    const denied = build({ permissions: ({ Order }) => ({ [Order.name]: { limit: auth.deny() } }) });
    code(await denied.run('$parent.limit'), 'FORBIDDEN');
    expect(denied.calls).toEqual([]);
  });

  it('collects the actual parent path for authorization', () => {
    const f = build();
    const args = { AND: [{ ALL: [{ path: 'shipping.lines', conditions: [{ field: 'quantity', valuePath: '$parent.$parent.provider.limit' }] }] }] };
    const right = collectQueryPathEntries(args, 'find', { gqltype: f.Order }).find((entry) => entry.role === 'right');
    expect(right.segments).toEqual(['provider', 'limit']);
  });

  it('applies a parent-only target scope to the bound parent operand', async () => {
    const f = build();
    expect((await f.run('$parent.provider.limit')).errors).toBeUndefined();
    expect(f.calls[0].plan.where.where.operand).toMatchObject({
      container: { up: 1, path: [] }, path: ['provider', 'limit'], joins: { provider: { path: ['tenant'], value: 'A' } },
    });
  });

  it('keeps local and parent reference scopes distinct', async () => {
    const f = build();
    expect((await f.run('$parent.provider.limit', 'lines', 'provider.limit')).errors).toBeUndefined();
    const predicate = f.calls[0].plan.where.where;
    expect(predicate.joins.provider).toMatchObject({ path: ['tenant'], value: 'A' });
    expect(predicate.operand.joins.provider).toMatchObject({ path: ['tenant'], value: 'A' });
  });

  it('preserves parent scope provenance when middleware copies a filter', async () => {
    const f = build({ middleware: async ({ args }, next) => { args.AND = structuredClone(args.AND); await next(); } });
    expect((await f.run('$parent.provider.limit')).errors).toBeUndefined();
    expect(f.calls[0].plan.where.where.operand.joins.provider).toMatchObject({ value: 'A' });
  });

  it('rejects parent restrictions detached by middleware', async () => {
    const f = build({ middleware: async ({ args }, next) => {
      args.AND[0].ALL[0].conditions = [{ field: 'quantity', operator: 'LTE', valuePath: '$parent.provider.limit' }];
      await next();
    } });
    code(await f.run('$parent.provider.limit'), 'DETACHED_CLIENT_FILTER');
    expect(f.calls).toEqual([]);
  });

  it('does not let a target scope capture the caller', async () => {
    const f = build();
    f.Provider.extensions.scope.find = ({ args }) => { args.limit = { valuePath: '$parent.limit' }; };
    code(await f.run('provider.limit'), 'INVALID_FILTER_PATH');
    expect(f.calls).toEqual([]);
  });

  it('binds and scopes a parent operand from single embedded terms', async () => {
    const f = build();
    const result = await graphql({ schema: f.schema,
      source: '{ orders(shipping: {terms: [{path: "limit", valuePath: "$parent.provider.limit"}]}) { id } }' });
    expect(result.errors).toBeUndefined();
    expect(f.calls[0].plan.where).toMatchObject({ path: ['shipping', 'limit'], operand: { path: ['provider', 'limit'] }, joins: { provider: { value: 'A' } } });
  });

  it('admits a scoped reference in a dotted element comparison', async () => {
    const f = build();
    const result = await graphql({ schema: f.schema,
      source: '{ orders(AND: [{conditions: [{field: "lines.quantity", valuePath: "lines.provider.limit"}]}]) { id } }' });
    expect(result.errors).toBeUndefined();
    expect(f.calls[0].plan.where.where.joins.provider).toMatchObject({ value: 'A' });
  });

  it('retains the existing joined-scope behavior of legacy vector filters', async () => {
    const source = '{ orders(lines: {terms: [{path: "provider.limit", value: 1}]}) { id } }';
    const legacy = build({ capability: false });
    expect((await graphql({ schema: legacy.schema, source })).errors).toBeUndefined();
    const current = build();
    expect((await graphql({ schema: current.schema, source })).errors).toBeUndefined();
    expect(current.calls[0].plan.where).toEqual(legacy.calls[0].plan.where);
  });

  it('resolves an aliased group at each containment depth', async () => {
    const f = build();
    const filter = { conditions: [{ field: 'quantity', valuePath: '$parent.limit' }] };
    f.runtime.use(async ({ args }, next) => {
      args.AND = [{ ANY: [{ ...filter, path: 'lines' }, { ...filter, path: 'shipping.lines' }] }];
      await next();
    });
    const result = await graphql({ schema: f.schema, source: '{ orders { id } }' });
    expect(result.errors).toBeUndefined();
    expect(f.calls[0].plan.where.terms.map((node) => node.where.operand.container.path)).toEqual([[], ['shipping']]);
  });

  it('prefixes a target scope with its own single embedded parent', async () => {
    const f = build();
    f.Provider.extensions.scope.find = ({ args }) => { args.shipping = { terms: [{ path: 'limit', valuePath: '$parent.limit' }] }; };
    const result = await graphql({ schema: f.schema, source: '{ orders(provider: {terms: [{path: "limit", value: 1}]}) {id} }' });
    expect(result.errors).toBeUndefined();
    expect(f.calls[0].plan.where.terms[1]).toMatchObject({ path: ['provider', 'shipping', 'limit'], operand: { path: ['provider', 'limit'] } });
  });

  it('allows a target scope to enter its own embedded lists and parents', async () => {
    const f = build();
    f.Provider.extensions.scope.find = ({ args }) => {
      args.AND = [{ ALL: [{ path: 'shipping.lines', conditions: [{ field: 'quantity', valuePath: '$parent.limit' }] }] }];
    };
    expect((await f.run('provider.limit')).errors).toBeUndefined();
    expect(f.calls[0].plan.where.where.joins.provider.where.operand.container).toEqual({ up: 1, path: ['shipping'] });
  });
});
