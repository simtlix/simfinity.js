import { describe, expect, it } from 'vitest';
import {
  GraphQLBoolean, GraphQLEnumType, GraphQLFloat, GraphQLID, GraphQLInt, GraphQLList, GraphQLObjectType, GraphQLString,
  graphql, printSchema,
} from 'graphql';

import {
  QLOperator, createQueryPlan, createRuntime, createValidatedScalar, describeModels,
} from '../packages/core/src/index.js';

// #108 part 1: the literal text operators, the shared value validation both backends rely on, and the
// adapter queryFeatures contract. Backend compilation is tested with each backend.

const LEGACY = ['EQ', 'NE', 'LT', 'LTE', 'GT', 'GTE', 'BTW', 'IN', 'NIN', 'LIKE'];
const TEXT = ['ILIKE', 'STARTS_WITH', 'ISTARTS_WITH', 'ENDS_WITH', 'IENDS_WITH', 'IEQ'];
const ALL = [...LEGACY, ...TEXT];
// The emptiness operators (#108, part 2a) follow the text operators; tests/query-emptiness.test.js covers them.
const EMPTINESS = ['IS_EMPTY', 'IS_NOT_EMPTY'];
// The list operators (#108, part 4) follow the emptiness operators; tests/list-operators.test.js covers them.
const LIST = ['CONTAINS_ALL', 'IIN'];

// Loaded on use, so that only the tests of the shared module need it.
const OPERATORS_MODULE = '@simtlix/simfinity-core/internal/query-operators';
const loadOperators = () => import(/* @vite-ignore */ OPERATORS_MODULE);

const codeOf = (body) => {
  try {
    body();
  } catch (error) {
    return error.extensions?.code ?? error.message;
  }
  return null;
};

const Status = new GraphQLEnumType({ name: 'QtStatus', values: { OPEN: { value: 'open' }, CLOSED: { value: 'closed' } } });
const Code = createValidatedScalar('QtCode', 'An upper-case code', GraphQLString, (value) => {
  if (!/^[A-Z]{2}-\d+$/.test(value)) throw new Error('Invalid code');
});
// Relation fields bind their types to one runtime, so each runtime gets its own types.
const createTypes = () => {
  const Dims = new GraphQLObjectType({
    name: 'QtDims',
    fields: () => ({ label: { type: GraphQLString }, size: { type: GraphQLInt } }),
  });
  const Line = new GraphQLObjectType({
    name: 'QtLine',
    fields: () => ({ sku: { type: GraphQLString }, notes: { type: new GraphQLList(GraphQLString) }, qty: { type: GraphQLInt } }),
  });
  // Scopes and middleware come from the request context, so each test sets only what it needs.
  const contextScope = (key) => async ({ args, context }) => context[key]?.(args);
  const Shop = new GraphQLObjectType({
    name: 'QtShop',
    extensions: { scope: { find: contextScope('shopScope') } },
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      items: { type: new GraphQLList(Item), extensions: { relation: { embedded: false, connectionField: 'shop' } } },
    }),
  });
  const Item = new GraphQLObjectType({
    name: 'QtItem',
    extensions: {
      scope: { find: contextScope('itemScope'), get_by_id: contextScope('itemByIdScope'), aggregate: contextScope('itemAggregateScope') },
    },
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      secret: { type: GraphQLString, extensions: { queryable: false } },
      code: { type: Code },
      tags: { type: new GraphQLList(GraphQLString) },
      stock: { type: GraphQLInt },
      price: { type: GraphQLFloat },
      active: { type: GraphQLBoolean },
      status: { type: Status },
      dims: { type: Dims, extensions: { relation: { embedded: true } } },
      lines: { type: new GraphQLList(Line), extensions: { relation: { embedded: true } } },
      shop: { type: Shop, extensions: { relation: { embedded: false, connectionField: 'shop' } } },
    }),
  });
  return { Dims, Line, Shop, Item };
};

const planTypes = createTypes();
const models = () => describeModels([{ gqltype: planTypes.Item }, { gqltype: planTypes.Shop }]);
const plan = (input, options) => createQueryPlan(models(), 'QtItem', input, options);
const predicate = (path, operator, value) => ({ kind: 'predicate', path: path.split('.'), operator, value });

const rows = {
  QtShop: [{ _id: 's1', id: 's1', name: 'Palermo' }],
  QtItem: [{ _id: 'i1', id: 'i1', name: 'Alpha', shop: 's1' }],
};

// A database-free adapter that plans every read with createQueryPlan, as the SQL adapter does, and
// records the arguments and the plan it received.
const createMemoryAdapter = ({ queryFeatures, calls }) => {
  let described = null;
  const record = (method, Model, args, mode) => {
    calls.push({ method, type: Model.name, args: structuredClone(args) });
    calls.at(-1).plan = createQueryPlan(described, Model.name, args, { mode });
  };
  const adapter = {
    bind() {},
    prepare(registrations) { described = describeModels(registrations); },
    createModel: (gqltype) => ({ name: gqltype.name }),
    castId: String,
    withTransaction: async (session, body) => body(session || {}),
    async getById(Model, id) { return rows[Model.name].find((row) => row.id === id) ?? null; },
    async find(Model, gqltype, args) { record('find', Model, args, 'find'); return rows[Model.name]; },
    async count(Model, gqltype, args) { record('count', Model, args, 'count'); return rows[Model.name].length; },
    async aggregate(Model, gqltype, args) { record('aggregate', Model, args, 'aggregate'); return []; },
    async findChildren(Model, gqltype, connectionField, parentId, args) {
      record('findChildren', Model, args, 'find');
      return rows[Model.name].filter((row) => row[connectionField] === parentId);
    },
  };
  if (queryFeatures !== undefined) adapter.queryFeatures = queryFeatures;
  return adapter;
};

const build = (queryFeatures) => {
  const calls = [];
  const middleware = [];
  const runtime = createRuntime(createMemoryAdapter({ queryFeatures, calls }));
  const {
    Dims, Line, Shop, Item,
  } = createTypes();
  runtime.use(async (params, next) => {
    middleware.push(params.operation);
    await params.context?.middleware?.(params);
    await next();
  });
  runtime.addNoEndpointType(Dims);
  runtime.addNoEndpointType(Line);
  runtime.connect(null, Shop, 'qtShop', 'qtShops');
  runtime.connect(null, Item, 'qtItem', 'qtItems');
  const schema = runtime.createSchema();
  const run = async (source, { variables, ...context } = {}) => {
    const result = await graphql({ schema, source, variableValues: variables, contextValue: context });
    return { ...result, codes: (result.errors || []).map((error) => error.extensions?.code ?? error.message) };
  };
  return { schema, calls, middleware, run };
};

// Every predicate of a plan, in order.
const predicatesOf = (node) => {
  if (!node) return [];
  return node.kind === 'predicate' ? [node] : node.terms.flatMap(predicatesOf);
};

describe('QLOperator', () => {
  it('adds the six text operators after the operators of 3.7.0', () => {
    expect(QLOperator.getValues().map((entry) => entry.value)).toEqual(
      ['EQ', 'LT', 'GT', 'LTE', 'GTE', 'BTW', 'NE', 'IN', 'NIN', 'LIKE', ...TEXT, ...EMPTINESS, ...LIST],
    );
    expect(QLOperator.getValues().map((entry) => entry.name)).toEqual(QLOperator.getValues().map((entry) => entry.value));
  });

  it('publishes them in the generated SDL and in introspection', async () => {
    const { schema } = build(null);
    expect(printSchema(schema)).toContain(`enum QLOperator {\n${['EQ', 'LT', 'GT', 'LTE', 'GTE', 'BTW', 'NE', 'IN', 'NIN', 'LIKE', ...TEXT, ...EMPTINESS, ...LIST].map((name) => `  ${name}`).join('\n')}\n}`);
    const result = await graphql({ schema, source: '{ __type(name: "QLOperator") { enumValues { name } } }' });
    expect(result.data.__type.enumValues.map((value) => value.name).slice(-10, -4)).toEqual(TEXT);
  });
});

describe('shared operator module', () => {
  it('derives the operator set from QLOperator and keeps the 3.7.0 set apart', async () => {
    const operators = await loadOperators();
    expect(operators.QUERY_OPERATORS).toEqual(QLOperator.getValues().map((entry) => entry.value));
    expect(operators.LEGACY_QUERY_OPERATORS).toEqual(LEGACY);
    expect(Object.isFrozen(operators.QUERY_OPERATORS) && Object.isFrozen(operators.LEGACY_QUERY_OPERATORS)).toBe(true);
    expect(ALL.every(operators.isQueryOperator)).toBe(true);
    expect(['BAD', 'eq', '', null, undefined, 'toString'].some(operators.isQueryOperator)).toBe(false);
  });

  it('describes what each text operator matches, and leaves LIKE out', async () => {
    const { TEXT_QUERY_OPERATORS, textQueryOperator } = await loadOperators();
    expect(TEXT_QUERY_OPERATORS).toEqual({
      ILIKE: { match: 'contains', ignoreCase: true },
      STARTS_WITH: { match: 'prefix', ignoreCase: false },
      ISTARTS_WITH: { match: 'prefix', ignoreCase: true },
      ENDS_WITH: { match: 'suffix', ignoreCase: false },
      IENDS_WITH: { match: 'suffix', ignoreCase: true },
      IEQ: { match: 'exact', ignoreCase: true },
    });
    expect(Object.isFrozen(TEXT_QUERY_OPERATORS) && Object.values(TEXT_QUERY_OPERATORS).every(Object.isFrozen)).toBe(true);
    for (const operator of TEXT) expect(textQueryOperator(operator)).toBe(TEXT_QUERY_OPERATORS[operator]);
    for (const operator of [...LEGACY, 'BAD', 'toString', '__proto__', null, 5]) expect(textQueryOperator(operator)).toBeNull();
  });

  it.each(TEXT)('validates %s values: strings without U+0000 on String fields', async (operator) => {
    const { validateTextFilterValue } = await loadOperators();
    for (const value of ['', 'a', '%', '_', 'a%b_c', '.*\\^$(', ' x ', 'Ünïß', '\n']) {
      expect(validateTextFilterValue(operator, value, 'String', 'name')).toBe(value);
    }
    for (const value of [null, undefined, 0, 5, true, ['a'], {}, new Date(0), 'a\u0000b', '\u0000']) {
      expect(codeOf(() => validateTextFilterValue(operator, value, 'String', 'name')), String(value)).toBe('INVALID_FILTER_VALUE');
    }
    for (const scalar of ['ID', 'Int', 'Float', 'Boolean', 'DateTime', 'Enum', 'QtStatus', undefined]) {
      expect(codeOf(() => validateTextFilterValue(operator, 'a', scalar, 'name')), scalar).toBe('INVALID_FILTER_VALUE');
    }
    expect(() => validateTextFilterValue(operator, null, 'String', ['shop', 'name'])).toThrow(`${operator} requires a non-null string value on shop.name`);
  });

  it('reads queryFeatures declarations', async () => {
    const { resolveQueryFeatures } = await loadOperators();
    expect([...resolveQueryFeatures(undefined).operators]).toEqual(LEGACY);
    expect([...resolveQueryFeatures(null).operators]).toEqual(LEGACY);
    expect([...resolveQueryFeatures({ operators: ALL }).operators]).toEqual(ALL);
    expect([...resolveQueryFeatures({ operators: ['IEQ', 'SOUNDS_LIKE', 'eq'], valuePath: true }).operators]).toEqual(['IEQ']);
    expect([...resolveQueryFeatures({ operators: [] }).operators]).toEqual([]);
    for (const invalid of ['all', true, 1, [], ['EQ'], {}, { operators: 'EQ' }, { operators: [1] }, { operators: ['EQ', null] }]) {
      expect(codeOf(() => resolveQueryFeatures(invalid)), JSON.stringify(invalid)).toBe('INVALID_QUERY_FEATURES');
    }
  });
});

describe('query plans with text operators', () => {
  it.each(TEXT)('plans %s on String leaves, lists, validated scalars, embedded values and references', (operator) => {
    const result = plan({
      name: { operator, value: 'Al' },
      tags: { operator, value: 'a%' },
      code: { operator, value: 'ab-' },
      dims: { terms: [{ path: 'label', operator, value: '' }] },
      lines: { terms: [{ path: 'sku', operator, value: '_' }, { path: 'notes', operator, value: '.*' }] },
      shop: { terms: [{ path: 'name', operator, value: 'pal' }] },
      AND: [{ conditions: [{ field: 'shop', path: 'name', operator, value: '^x$' }, { field: 'dims.label', operator, value: '(' }] }],
      OR: [{ conditions: [{ field: 'name', operator, value: '\\' }] }, { conditions: [{ field: 'lines.sku', operator, value: 'Ü' }] }],
    });
    expect(predicatesOf(result.where)).toEqual([
      predicate('name', operator, 'Al'),
      predicate('tags', operator, 'a%'),
      predicate('code', operator, 'ab-'),
      predicate('dims.label', operator, ''),
      predicate('lines.sku', operator, '_'),
      predicate('lines.notes', operator, '.*'),
      predicate('shop.name', operator, 'pal'),
      predicate('shop.name', operator, '^x$'),
      predicate('dims.label', operator, '('),
      predicate('name', operator, '\\'),
      predicate('lines.sku', operator, 'Ü'),
    ]);
  });

  it.each(TEXT)('plans %s in count and aggregate plans', (operator) => {
    expect(plan({ name: { operator, value: 'a' } }, { mode: 'count' }).where).toEqual(predicate('name', operator, 'a'));
    const aggregate = plan({
      name: { operator, value: 'a' },
      aggregation: { groupId: 'status', facts: [{ operation: 'COUNT', factName: 'count', path: 'id' }] },
    }, { mode: 'aggregate' });
    expect(aggregate.where).toEqual(predicate('name', operator, 'a'));
  });

  it.each(TEXT)('rejects %s without a non-null string value, with INVALID_FILTER_VALUE', (operator) => {
    for (const value of [null, undefined, 5, 0, true, ['a'], [], {}, 'a\u0000', '\u0000z']) {
      for (const input of [
        { name: { operator, value } },
        { tags: { operator, value } },
        { shop: { terms: [{ path: 'name', operator, value }] } },
        { AND: [{ conditions: [{ field: 'lines.sku', operator, value }] }] },
      ]) {
        expect(codeOf(() => plan(input)), JSON.stringify(input)).toBe('INVALID_FILTER_VALUE');
      }
    }
    // An omitted value is missing, not null.
    expect(codeOf(() => plan({ name: { operator } }))).toBe('INVALID_FILTER_VALUE');
  });

  it.each(TEXT)('rejects %s on fields that are not String fields or lists, with INVALID_FILTER_VALUE', (operator) => {
    for (const input of [
      { stock: { operator, value: '1' } },
      { price: { operator, value: '1' } },
      { active: { operator, value: 'true' } },
      { status: { operator, value: 'OPEN' } },
      { id: { operator, value: 'i1' } },
      { shop: { terms: [{ path: 'id', operator, value: 's1' }] } },
      { lines: { terms: [{ path: 'qty', operator, value: '1' }] } },
      { AND: [{ conditions: [{ field: 'dims', path: 'size', operator, value: '1' }] }] },
    ]) {
      expect(codeOf(() => plan(input)), JSON.stringify(input)).toBe('INVALID_FILTER_VALUE');
    }
  });

  it('keeps path errors ahead of value errors', () => {
    expect(codeOf(() => plan({ dims: { operator: 'ILIKE', value: 'a' } }))).toBe('MISSING_FILTER_PATH');
    expect(codeOf(() => plan({ AND: [{ conditions: [{ field: 'missing', operator: 'IEQ', value: null }] }] }))).toBe('INVALID_FILTER_FIELD');
    expect(codeOf(() => plan({ AND: [{ conditions: [{ field: 'dims', operator: 'STARTS_WITH', value: 5 }] }] }))).toBe('MISSING_FILTER_PATH');
  });

  it('rejects operators outside the compiler set with UNSUPPORTED_QUERY, and unknown ones as before', () => {
    expect(codeOf(() => plan({ name: { operator: 'ILIKE', value: 'a' } }, { operators: LEGACY }))).toBe('UNSUPPORTED_QUERY');
    expect(codeOf(() => plan({ AND: [{ conditions: [{ field: 'name', operator: 'IEQ', value: 'a' }] }] }, { operators: new Set(LEGACY) }))).toBe('UNSUPPORTED_QUERY');
    expect(codeOf(() => plan({ name: { operator: 'BAD', value: 'a' } }, { operators: LEGACY }))).toBe('INVALID_FILTER_OPERATOR');
    expect(codeOf(() => plan({ name: { value: 'a' } }, { operators: ['LIKE'] }))).toBe('UNSUPPORTED_QUERY');
    expect(plan({ name: { operator: 'LIKE', value: 'a' } }, { operators: LEGACY }).where).toEqual(predicate('name', 'LIKE', 'a'));
    expect(plan({ name: { operator: 'STARTS_WITH', value: 'a' } }, { operators: ['STARTS_WITH'] }).where).toEqual(predicate('name', 'STARTS_WITH', 'a'));
    expect(plan({ name: { operator: 'ENDS_WITH', value: 'a' } }).where).toEqual(predicate('name', 'ENDS_WITH', 'a'));
  });

  it('plans the operators of 3.7.0 as before', () => {
    const result = plan({
      name: { value: 'a' },
      tags: { operator: 'NE', value: null },
      stock: { operator: 'BTW', value: [1, 5] },
      price: { operator: 'GT', value: 1.5 },
      status: { operator: 'IN', value: ['OPEN'] },
      code: { operator: 'LIKE', value: 'A%' },
      shop: { terms: [{ path: 'name', operator: 'NIN', value: [] }, { path: 'id', value: null }] },
      AND: [{ conditions: [{ field: 'lines.qty', operator: 'LTE', value: 3 }, { field: 'dims', path: 'size', operator: 'GTE', value: 0 }] }],
      OR: [{ conditions: [{ field: 'stock', operator: 'LT', value: 9 }] }, { conditions: [{ field: 'name', operator: 'EQ', value: null }] }],
    });
    expect(result.where).toEqual({
      kind: 'and',
      terms: [
        predicate('name', 'EQ', 'a'),
        predicate('tags', 'NE', null),
        predicate('stock', 'BTW', [1, 5]),
        predicate('price', 'GT', 1.5),
        predicate('status', 'IN', ['OPEN']),
        predicate('code', 'LIKE', 'A%'),
        predicate('shop.name', 'NIN', []),
        predicate('shop.id', 'EQ', null),
        { kind: 'and', terms: [predicate('lines.qty', 'LTE', 3), predicate('dims.size', 'GTE', 0)] },
        { kind: 'or', terms: [predicate('stock', 'LT', 9), predicate('name', 'EQ', null)] },
      ],
    });
    // LIKE keeps its own rules: the backends reject a non-String field and U+0000, not the plan.
    expect(plan({ stock: { operator: 'LIKE', value: 'x' } }).where).toEqual(predicate('stock', 'LIKE', 'x'));
    expect(plan({ name: { operator: 'LIKE', value: 'a\u0000' } }).where).toEqual(predicate('name', 'LIKE', 'a\u0000'));
    expect(codeOf(() => plan({ name: { operator: 'LIKE', value: null } }))).toBe('INVALID_FILTER_VALUE');
    expect(codeOf(() => plan({ name: { operator: 'BAD', value: 'a' } }))).toBe('INVALID_FILTER_OPERATOR');
    expect(codeOf(() => plan({ stock: { operator: 'BTW', value: [1] } }))).toBe('INVALID_FILTER_VALUE');
  });
});

describe('runtime with an adapter that declares every operator', () => {
  const features = { operators: ALL };

  it.each(TEXT)('sends %s through list filters, terms, groups and counts', async (operator) => {
    const { run, calls } = build(features);
    const result = await run(`{ qtItems(
      name: { operator: ${operator}, value: "Al" }
      shop: { terms: [{ path: "name", operator: ${operator}, value: "pal" }] }
      AND: [{ conditions: [{ field: "tags", operator: ${operator}, value: "%" }] }]
      OR: [{ conditions: [{ field: "dims.label", operator: ${operator}, value: "" }] }]
      pagination: { page: 1, size: 5, count: true }
    ) { id } }`);
    expect(result.errors).toBeUndefined();
    expect(calls.map((call) => call.method).sort()).toEqual(['count', 'find']);
    for (const call of calls) {
      expect(predicatesOf(call.plan.where)).toEqual([
        predicate('name', operator, 'Al'),
        predicate('shop.name', operator, 'pal'),
        predicate('tags', operator, '%'),
        predicate('dims.label', operator, ''),
      ]);
    }
  });

  it.each(TEXT)('sends %s through aggregate filters and collection field arguments', async (operator) => {
    const { run, calls } = build(features);
    const aggregate = await run(`{ qtItems_aggregate(
      code: { operator: ${operator}, value: "ab" }
      aggregation: { groupId: "status", facts: [{ operation: COUNT, factName: "n", path: "id" }] }
    ) { groupId } }`);
    expect(aggregate.errors).toBeUndefined();
    const children = await run(`{ qtShops { items(lines: { terms: [{ path: "sku", operator: ${operator}, value: "x" }] }) { id } } }`);
    expect(children.errors).toBeUndefined();
    expect(calls.map((call) => [call.method, call.plan.where])).toEqual([
      ['aggregate', predicate('code', operator, 'ab')],
      ['find', null],
      ['findChildren', predicate('lines.sku', operator, 'x')],
    ]);
  });

  it('rejects invalid text values with INVALID_FILTER_VALUE', async () => {
    const { run } = build(features);
    expect((await run('{ qtItems(name: { operator: ILIKE, value: null }) { id } }')).codes).toEqual(['INVALID_FILTER_VALUE']);
    expect((await run('{ qtItems(name: { operator: IEQ }) { id } }')).codes).toEqual(['INVALID_FILTER_VALUE']);
    expect((await run('{ qtItems(stock: { operator: STARTS_WITH, value: "1" }) { id } }')).codes).toEqual(['INVALID_FILTER_VALUE']);
    expect((await run('{ qtItems(status: { operator: IENDS_WITH, value: "N" }) { id } }')).codes).toEqual(['INVALID_FILTER_VALUE']);
    expect((await run('{ qtItems(name: { operator: ENDS_WITH, value: 5 }) { id } }')).codes).toEqual(['INVALID_FILTER_VALUE']);
    expect((await run('{ qtItems(tags: { operator: ISTARTS_WITH, value: ["a"] }) { id } }')).codes).toEqual(['INVALID_FILTER_VALUE']);
    expect((await run('query ($v: QLValue) { qtItems(name: { operator: IEQ, value: $v }) { id } }', { variables: { v: 'a\u0000' } })).codes)
      .toEqual(['INVALID_FILTER_VALUE']);
  });

  it('prefixes a text operator of a joined scope under the client path', async () => {
    const { run, calls } = build(features);
    const result = await run('{ qtItems(shop: { terms: [{ path: "name", operator: IEQ, value: "PALERMO" }] }) { id } }', {
      shopScope: (args) => { args.name = { operator: 'ISTARTS_WITH', value: 'pal' }; },
    });
    expect(result.errors).toBeUndefined();
    expect(calls[0].args.AND).toEqual([{ conditions: [{ field: 'shop.name', operator: 'ISTARTS_WITH', value: 'pal' }] }]);
    expect(predicatesOf(calls[0].plan.where)).toEqual([
      predicate('shop.name', 'IEQ', 'PALERMO'),
      predicate('shop.name', 'ISTARTS_WITH', 'pal'),
    ]);
  });

  it('places a joined scope inside the client group whose text condition uses the path', async () => {
    const { run, calls } = build(features);
    const result = await run(`{ qtItems(OR: [
      { conditions: [{ field: "shop.name", operator: IEQ, value: "x" }] }
      { conditions: [{ field: "name", operator: ILIKE, value: "a" }] }
    ]) { id } }`, { shopScope: (args) => { args.name = { operator: 'ISTARTS_WITH', value: 'pal' }; } });
    expect(result.errors).toBeUndefined();
    expect(calls[0].args.OR).toEqual([
      {
        conditions: [{ field: 'shop.name', operator: 'IEQ', value: 'x' }],
        AND: [{ conditions: [{ field: 'shop.name', operator: 'ISTARTS_WITH', value: 'pal' }] }],
      },
      { conditions: [{ field: 'name', operator: 'ILIKE', value: 'a' }] },
    ]);
  });

  it('applies path restrictions to text conditions', async () => {
    const { run, calls } = build(features);
    expect((await run('{ qtItems(secret: { operator: ILIKE, value: "a" }) { id } }')).codes).toEqual(['FORBIDDEN_FILTER_PATH']);
    expect((await run('{ qtItems(AND: [{ conditions: [{ field: "secret", operator: IEQ, value: "a" }] }]) { id } }')).codes)
      .toEqual(['FORBIDDEN_FILTER_PATH']);
    expect(calls).toEqual([]);
  });

  it('accepts text operators that middleware and scopes add', async () => {
    const { run, calls } = build(features);
    const list = await run('{ qtItems { id } }', {
      middleware: (params) => { params.args = { ...params.args, name: { operator: 'ILIKE', value: 'l' } }; },
      itemScope: (args) => { args.AND = [...(args.AND || []), { conditions: [{ field: 'tags', operator: 'IEQ', value: 'X' }] }]; },
    });
    expect(list.errors).toBeUndefined();
    const byId = await run('{ qtItem(id: "i1") { id } }', { itemByIdScope: (args) => { args.code = { operator: 'IENDS_WITH', value: '-1' }; } });
    expect(byId.errors).toBeUndefined();
    expect(calls.map((call) => predicatesOf(call.plan.where))).toEqual([
      [predicate('name', 'ILIKE', 'l'), predicate('tags', 'IEQ', 'X')],
      [predicate('id', 'EQ', 'i1'), predicate('code', 'IENDS_WITH', '-1')],
    ]);
  });
});

describe('runtime with an adapter that declares no queryFeatures', () => {
  it('sends the operators of 3.7.0 unchanged', async () => {
    const { run, calls, middleware } = build(undefined);
    const result = await run(`{ qtItems(
      name: { operator: LIKE, value: "%" }
      stock: { operator: BTW, value: [1, 5] }
      status: { operator: IN, value: [OPEN] }
      shop: { terms: [{ path: "name", operator: NE, value: null }, { path: "id", operator: NIN, value: [] }] }
      AND: [{ conditions: [{ field: "price", operator: GT, value: 1 }, { field: "lines.qty", operator: LTE, value: 2 }] }]
      OR: [{ conditions: [{ field: "price", operator: LT, value: 9 }] }, { conditions: [{ field: "tags", operator: GTE, value: "a" }, { field: "code", value: "AB-1" }] }]
      pagination: { page: 1, size: 5, count: true }
    ) { id } }`);
    expect(result.errors).toBeUndefined();
    expect(middleware).toEqual(['find']);
    expect(calls.map((call) => call.method).sort()).toEqual(['count', 'find']);
    expect(calls[0].args).toEqual({
      name: { operator: 'LIKE', value: '%' },
      stock: { operator: 'BTW', value: [1, 5] },
      status: { operator: 'IN', value: ['OPEN'] },
      shop: { terms: [{ path: 'name', operator: 'NE', value: null }, { path: 'id', operator: 'NIN', value: [] }] },
      AND: [{ conditions: [{ field: 'price', operator: 'GT', value: 1 }, { field: 'lines.qty', operator: 'LTE', value: 2 }] }],
      OR: [{ conditions: [{ field: 'price', operator: 'LT', value: 9 }] }, { conditions: [{ field: 'tags', operator: 'GTE', value: 'a' }, { field: 'code', value: 'AB-1' }] }],
      pagination: { page: 1, size: 5, count: true },
    });
    expect(calls[1].args).toEqual(calls[0].args);
  });

  it.each(TEXT)('rejects a client %s with UNSUPPORTED_QUERY before middleware runs', async (operator) => {
    const { run, calls, middleware } = build(undefined);
    for (const source of [
      `{ qtItems(name: { operator: ${operator}, value: "a" }) { id } }`,
      `{ qtItems(shop: { terms: [{ path: "name", operator: ${operator}, value: "a" }] }) { id } }`,
      `{ qtItems(OR: [{ AND: [{ conditions: [{ field: "tags", operator: ${operator}, value: "a" }] }] }]) { id } }`,
      `{ qtItems(name: { operator: ${operator}, value: "a" }, pagination: { page: 1, size: 2, count: true }) { id } }`,
      `{ qtItems_aggregate(name: { operator: ${operator}, value: "a" }, aggregation: { groupId: "status", facts: [{ operation: COUNT, factName: "n", path: "id" }] }) { groupId } }`,
    ]) {
      expect((await run(source)).codes, source).toEqual(['UNSUPPORTED_QUERY']);
    }
    const children = await run(`{ qtShops { id items(name: { operator: ${operator}, value: "a" }) { id } } }`);
    expect(children.codes).toEqual(['UNSUPPORTED_QUERY']);
    expect(children.data.qtShops).toEqual([{ id: 's1', items: null }]);
    // Only the qtShops list itself reached middleware and the adapter.
    expect(middleware).toEqual(['find']);
    expect(calls.map((call) => call.type)).toEqual(['QtShop']);
  });

  it('checks paths before operators', async () => {
    const { run } = build(undefined);
    expect((await run('{ qtItems(secret: { operator: STARTS_WITH, value: "a" }) { id } }')).codes).toEqual(['FORBIDDEN_FILTER_PATH']);
  });

  it('names the operator and the path in the error', async () => {
    const { run } = build(undefined);
    const result = await run('{ qtItems(shop: { terms: [{ path: "name", operator: ISTARTS_WITH, value: "a" }] }) { id } }');
    expect(result.errors[0].message).toBe('The database adapter does not support the ISTARTS_WITH filter operator, used on QtItem.shop.name');
    expect(result.errors[0].extensions).toMatchObject({ code: 'UNSUPPORTED_QUERY', status: 400 });
  });

  it.each([
    ['middleware', { middleware: (params) => { params.args.AND = [{ conditions: [{ field: 'name', operator: 'ILIKE', value: 'a' }] }]; } }],
    ['a middleware replacement', { middleware: (params) => { params.args = { name: { operator: 'STARTS_WITH', value: 'a' } }; } }],
    ['a find scope', { itemScope: (args) => { args.tags = { operator: 'IEQ', value: 'a' }; } }],
    ['a joined scope', { shopScope: (args) => { args.name = { operator: 'ENDS_WITH', value: 'o' }; } }],
  ])('rejects a text operator that %s adds, before the adapter call', async (label, context) => {
    const { run, calls, middleware } = build(undefined);
    const result = await run('{ qtItems(shop: { terms: [{ path: "id", value: "s1" }] }) { id } }', context);
    expect(result.codes).toEqual(['UNSUPPORTED_QUERY']);
    expect(middleware).toEqual(['find']);
    expect(calls).toEqual([]);
  });

  it('rejects text operators that get_by_id, aggregate and collection scopes add', async () => {
    const { run, calls } = build(undefined);
    const byId = await run('{ qtItem(id: "i1") { id } }', { itemByIdScope: (args) => { args.name = { operator: 'IENDS_WITH', value: 'a' }; } });
    expect(byId.codes).toEqual(['UNSUPPORTED_QUERY']);
    const aggregate = await run('{ qtItems_aggregate(aggregation: { groupId: "status", facts: [{ operation: COUNT, factName: "n", path: "id" }] }) { groupId } }', {
      itemAggregateScope: (args) => { args.OR = [{ conditions: [{ field: 'shop.name', operator: 'ILIKE', value: 'a' }] }]; },
    });
    expect(aggregate.codes).toEqual(['UNSUPPORTED_QUERY']);
    const children = await run('{ qtShops { items { id } } }', { itemScope: (args) => { args.code = { operator: 'STARTS_WITH', value: 'AB' }; } });
    expect(children.codes).toEqual(['UNSUPPORTED_QUERY']);
    expect(calls.map((call) => call.method)).toEqual(['find']);
  });

  it.each([undefined, { operators: ALL, referenceEmptiness: true, quantifiers: true }])('rejects an unknown actual predicate before the adapter (%j)', async (features) => {
    const { run, calls } = build(features);
    const result = await run('{ qtItems { id } }', { middleware: (params) => { params.args.name = { operator: 'SOUNDS_LIKE', value: 'a' }; } });
    expect(result.codes).toEqual(['INVALID_FILTER_OPERATOR']);
    // The mandatory shared gate checks trusted actual predicates as well as client input.
    expect(calls).toEqual([]);
  });
});

describe('queryFeatures declarations', () => {
  it('supports exactly the declared operators', async () => {
    const { run } = build({ operators: [...LEGACY, 'STARTS_WITH'] });
    expect((await run('{ qtItems(name: { operator: STARTS_WITH, value: "A" }) { id } }')).errors).toBeUndefined();
    expect((await run('{ qtItems(name: { operator: ISTARTS_WITH, value: "A" }) { id } }')).codes).toEqual(['UNSUPPORTED_QUERY']);
    expect((await run('{ qtItems(name: { operator: LIKE, value: "A" }) { id } }')).errors).toBeUndefined();
  });

  it('checks the operators of 3.7.0 too once an adapter declares its own, reading an omitted operator as EQ', async () => {
    const { run, calls } = build({ operators: ['LIKE', 'IEQ'] });
    expect((await run('{ qtItems(name: { value: "A" }) { id } }')).codes).toEqual(['UNSUPPORTED_QUERY']);
    expect((await run('{ qtItems(stock: { operator: GT, value: 1 }) { id } }')).codes).toEqual(['UNSUPPORTED_QUERY']);
    expect((await run('{ qtItems(name: { operator: IEQ, value: "A" }, AND: [{ conditions: [{ field: "tags", operator: LIKE, value: "b" }] }]) { id } }')).errors).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('pin: ignores operator names and future feature fields this version does not know', async () => {
    const { run } = build({ operators: [...ALL, 'SOUNDS_LIKE'], futureCollectionFeature: true });
    expect((await run('{ qtItems(name: { operator: IEQ, value: "alpha" }) { id } }')).data.qtItems).toEqual([{ id: 'i1' }]);
  });

  it('treats a null declaration as no declaration', async () => {
    const { run } = build(null);
    expect((await run('{ qtItems(name: { operator: LIKE, value: "A" }) { id } }')).errors).toBeUndefined();
    expect((await run('{ qtItems(name: { operator: ILIKE, value: "A" }) { id } }')).codes).toEqual(['UNSUPPORTED_QUERY']);
  });

  it.each([
    ['a string', 'all'],
    ['a boolean', true],
    ['an array', ALL],
    ['an object without operators', {}],
    ['operators that are not an array', { operators: 'EQ' }],
    ['operators that are not strings', { operators: ['EQ', 1] }],
  ])('rejects %s with INVALID_QUERY_FEATURES when the runtime is created', (label, queryFeatures) => {
    let error;
    try {
      createRuntime(createMemoryAdapter({ queryFeatures, calls: [] }));
    } catch (caught) {
      error = caught;
    }
    expect(error?.extensions).toMatchObject({ code: 'INVALID_QUERY_FEATURES', status: 500 });
  });
});
