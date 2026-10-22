import {
  afterEach, describe, expect, it,
} from 'vitest';
import {
  GraphQLID, GraphQLInt, GraphQLList, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';
import mongoose from 'mongoose';

import {
  QLOperator, configureQueryLimits, createQueryPlan, createRuntime, describeModels,
} from '../packages/core/src/index.js';
import * as auth from '../packages/core/src/auth/index.js';
import {
  REFERENCE_CASES, REFERENCE_DATA, REFERENCE_SHAPES, createReferenceEmptinessTypes, expectedReferenceRows, referenceCaseArgs,
  referenceQuery, registerReferenceEmptinessTypes,
} from './helpers/query-emptiness.js';

// #108 part 2b: the runtime half of reference and collection emptiness. For an adapter that declares
// queryFeatures.referenceEmptiness, the runtime copies each call's filter arguments, marks the client's emptiness
// constructs that read references or collections, counts their scoped joins and frames, and after middleware and
// scopes checks the markers, gates the arguments and fills each marker with the target find scopes. Database-free: the
// adapter plans every read with createQueryPlan, as the SQL adapter does, and answers it from REFERENCE_DATA with an
// evaluator of the plan, so rows show that a record a client's scope hides reads as missing. The plan and the shapes
// are in reference-emptiness.test.js, and each backend's forms with that backend.

const OPERATORS = QLOperator.getValues().map((entry) => entry.value);
const LEGACY = ['EQ', 'NE', 'LT', 'LTE', 'GT', 'GTE', 'BTW', 'IN', 'NIN', 'LIKE'];
const DECLARED = { operators: OPERATORS, referenceEmptiness: true };
const UNDECLARED = { operators: OPERATORS };
const NOT_SUPPORTED = 'the database adapter does not support emptiness through references and collections';
const ADVICE = 'middleware and scopes must keep the client\'s filter objects: copy them instead of rebuilding them, and append '
  + 'restrictions instead of assigning over them (docs/guide/middleware.md)';
const embedded = { relation: { embedded: true } };
const reference = (connectionField) => ({ relation: { embedded: false, ...(connectionField ? { connectionField } : {}) } });

const failures = (result) => (result.errors ?? []).map((error) => ({
  code: error.extensions?.code, status: error.extensions?.status, message: error.message,
}));
const failure = (result) => failures(result)[0] ?? null;
const detached = (message) => ({ code: 'DETACHED_CLIENT_FILTER', status: 500, message: `${message}; ${ADVICE}` });
const predicate = (path, operator, value = null) => ({
  kind: 'predicate', path: path.split('.'), operator, value,
});
const scoped = (path, operator, scopes) => ({ ...predicate(path, operator), scopes });
const predicatesOf = (node) => {
  if (!node) return [];
  return node.kind === 'predicate' ? [node] : node.terms.flatMap(predicatesOf);
};
const safeClone = (value) => {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
};

// The records of REFERENCE_DATA as the backends store them: each identity is the record's key, and each reference
// holds the target's key under its storage name (Review.product as productId). `dangling` adds MongoDB's dangling
// product Dg, whose references point to no record.
const storedRecord = (fields, value) => Object.fromEntries(fields.filter((field) => Object.hasOwn(value, field.name)).map((field) => {
  const item = value[field.name];
  if (field.kind !== 'embedded' || item == null) return [field.storageName, item];
  return [field.storageName, field.list ? item.map((entry) => storedRecord(field.fields, entry)) : storedRecord(field.fields, item)];
}));
const referenceStore = (prefix, { dangling = false } = {}) => (models) => {
  const store = {};
  for (const [typeKey, records] of Object.entries(REFERENCE_DATA)) {
    const entity = models.entities.find((item) => item.name === `${prefix}${typeKey.charAt(0).toUpperCase()}${typeKey.slice(1)}`);
    store[entity.name] = records.map((record) => ({ ...storedRecord(entity.fields, record), _id: record.key }));
  }
  if (dangling) {
    store[`${prefix}Product`].push({
      _id: 'Dg', key: 'Dg', name: 'Dg', stock: 1, shop: 'ghost', pro: 'ghost', odim: { shop: 'ghost' }, olines: [{ qty: 1, shop: 'ghost' }],
    });
  }
  return store;
};

// An evaluator of query plans over a store, written from the definitions. A predicate without `scopes` is trusted and
// reads stored records through plain joins; an emptiness predicate with `scopes` admits a target only when its scope
// (a plan of the target type) holds for it, so a hidden record reads as missing. Plain joins give one value per list
// item or child, and undefined where a hop is missing; a condition holds when one of its values matches.
const createEvaluator = (models, store) => {
  const fieldsOf = (name) => models.entities.find((item) => item.name === name).fields;
  const fieldOf = (fields, name) => {
    const field = fields.find((item) => item.name === name);
    if (!field) throw new Error(`The evaluator has no field ${name}`);
    return field;
  };
  const deref = (target, key) => (key == null ? undefined : store[target]?.find((record) => record._id === key));
  const children = (field, holder) => (store[field.target] ?? []).filter((child) => child[field.connectionField] === holder._id);
  const isIdentity = (entityLevel, name) => entityLevel && (name === 'id' || name === '_id');
  const values = (fields, record, segments, entityLevel) => {
    if (record == null) return [undefined];
    const [name, ...rest] = segments;
    if (isIdentity(entityLevel, name) && !rest.length) return [record._id];
    const field = fieldOf(fields, name);
    const value = record[field.storageName];
    if (!rest.length) return [value];
    if (field.kind === 'reference') return values(fieldsOf(field.target), deref(field.target, value), rest, true);
    if (field.kind === 'collection') {
      const found = children(field, record);
      return found.length ? found.flatMap((child) => values(fieldsOf(field.target), child, rest, true)) : [undefined];
    }
    if (field.list) return value?.length ? value.flatMap((item) => values(field.fields, item, rest, false)) : [undefined];
    return values(field.fields, value, rest, false);
  };
  const compare = (actual, operator, expected) => {
    switch (operator) {
      case 'EQ': return expected === null ? actual == null : actual === expected;
      case 'NE': return expected === null ? actual != null : actual !== expected;
      case 'IN': return expected.includes(actual);
      case 'NIN': return !expected.includes(actual);
      default: throw new Error(`The evaluator has no operator ${operator}`);
    }
  };
  // `holds`, defined below, is only called once both exist.
  const empty = (fields, record, segments, entityLevel, base, scopes) => {
    const [name, ...rest] = segments;
    if (isIdentity(entityLevel, name) && !rest.length) return false;
    const field = fieldOf(fields, name);
    const path = [...base, name];
    const value = record[field.storageName];
    const admits = (target, candidate) => {
      if (scopes == null) return true;
      const key = path.join('.');
      if (!Object.hasOwn(scopes, key)) throw new Error(`The plan has no scope for ${key}`);
      return scopes[key] === null || holds(target, candidate, scopes[key]);
    };
    if (field.kind === 'reference') {
      const target = deref(field.target, value);
      const seen = target && admits(field.target, target) ? target : undefined;
      if (!rest.length || !seen) return !seen;
      return empty(fieldsOf(field.target), seen, rest, true, path, scopes);
    }
    if (field.kind === 'collection') return !children(field, record).some((child) => admits(field.target, child));
    if (field.kind === 'embedded' && !field.list) {
      if (value == null) return true;
      if (rest.length) return empty(field.fields, value, rest, false, path, scopes);
      return field.fields.every((member) => empty(field.fields, value, [member.name], false, path, scopes));
    }
    if (field.list) return value == null || value.length === 0;
    return value == null || (field.scalar === 'String' && value === '');
  };
  const holds = (entity, record, node) => {
    if (!node) return true;
    if (node.kind === 'and') return node.terms.every((term) => holds(entity, record, term));
    if (node.kind === 'or') return node.terms.some((term) => holds(entity, record, term));
    if (node.operator === 'IS_EMPTY' || node.operator === 'IS_NOT_EMPTY') {
      return empty(fieldsOf(entity), record, node.path, true, [], node.scopes) === (node.operator === 'IS_EMPTY');
    }
    return values(fieldsOf(entity), record, node.path, true).some((value) => compare(value, node.operator, node.value));
  };
  return holds;
};

// A database-free adapter that plans every read with createQueryPlan, with its declared operators and reference
// emptiness, and answers it from the store. Each call keeps a copy of its arguments, its plan and the keys it matched.
// `batch` adds findChildrenBatch.
const createMemoryAdapter = ({
  queryFeatures, calls, batch = false, data = () => ({}),
}) => {
  let models;
  let store;
  let holds;
  const copy = (record) => ({ ...structuredClone(record), id: record._id });
  const all = (Model) => store[Model.name] ?? [];
  const read = (method, Model, args, mode, records) => {
    const call = { method, type: Model.name, args: safeClone(args) };
    calls.push(call);
    call.plan = createQueryPlan(models, Model.name, args, {
      mode, operators: queryFeatures?.operators ?? LEGACY, referenceEmptiness: queryFeatures?.referenceEmptiness === true,
    });
    const found = records.filter((record) => holds(Model.name, record, call.plan.where));
    call.rows = found.map((record) => record._id).sort();
    return found.map(copy);
  };
  return {
    ...(queryFeatures === undefined ? {} : { queryFeatures }),
    bind() {},
    prepare(registrations) {
      models = describeModels(registrations);
      store = data(models);
      holds = createEvaluator(models, store);
    },
    createModel: (gqltype) => ({ name: gqltype.name }),
    castId: String,
    withTransaction: async (session, body) => body(session || {}),
    async getById(Model, id) {
      const record = all(Model).find((item) => item._id === String(id));
      return record ? copy(record) : null;
    },
    async find(Model, gqltype, args) { return read('find', Model, args, 'find', all(Model)); },
    async count(Model, gqltype, args) { return read('count', Model, args, 'count', all(Model)).length; },
    async aggregate(Model, gqltype, args) {
      read('aggregate', Model, args, 'aggregate', all(Model));
      return [];
    },
    async findChildren(Model, gqltype, connectionField, parentId, args) {
      return read('findChildren', Model, args, 'find', all(Model).filter((record) => record[connectionField] === String(parentId)));
    },
    ...(batch ? {
      async findChildrenBatch(Model, gqltype, connectionField, parentIds, args) {
        const keys = parentIds.map(String);
        const found = read('findChildrenBatch', Model, args, 'find', all(Model).filter((record) => keys.includes(record[connectionField])));
        calls.at(-1).parents = keys;
        return keys.map((key) => found.filter((record) => record[connectionField] === key));
      },
    } : {}),
  };
};

// The reference fixture, served by the memory adapter. The scope shape is the request context's `shape` ('admin' by
// default). Middleware and the extra scopes do what the context asks: `context.middleware(params)` and
// `context.scopes[typeKey][operation](params)`; `context.ran` lists, in order, every middleware and scope call.
const TYPE_KEYS = ['shop', 'pro', 'product', 'review'];
const contextScopes = Object.fromEntries(TYPE_KEYS.map((typeKey) => [typeKey, Object.fromEntries(['find', 'aggregate', 'get_by_id'].map(
  (operation) => [operation, (params) => {
    params.context?.ran?.push(`scope ${typeKey} ${operation}`);
    params.context?.scopes?.[typeKey]?.[operation]?.(params);
  }],
))]));
const build = ({
  queryFeatures = DECLARED, batch = false, permissions, defaultPolicy = 'DENY', dangling = false,
} = {}) => {
  const calls = [];
  const runtime = createRuntime(createMemoryAdapter({
    queryFeatures, calls, batch, data: referenceStore('Qk', { dangling }),
  }));
  const types = createReferenceEmptinessTypes('Qk', { scopes: contextScopes });
  runtime.use(async (params, next) => {
    params.context?.ran?.push(`middleware ${params.type.gqltype.name} ${params.operation}`);
    await params.context?.middleware?.(params);
    await next();
  });
  registerReferenceEmptinessTypes(runtime, types);
  const schema = runtime.createSchema();
  if (permissions) auth.createAuthPlugin(permissions, { defaultPolicy }).onSchemaChange({ schema });
  const run = (source, context = {}, variables = undefined) => graphql({
    schema, source, variableValues: variables, contextValue: { shape: 'admin', ...context },
  });
  const keysOf = (result, field) => result.data?.[field]?.map((record) => record.key).sort() ?? null;
  return {
    schema, calls, run, types, runtime, keysOf,
  };
};
const onProduct = (body) => (params) => { if (params.type.gqltype.name === 'QkProduct') body(params); };
const appendAnd = (args, groups) => { args.AND = [...(Array.isArray(args.AND) ? args.AND : []), ...groups]; };
// The find scope plans of the fixture's scopes, as createQueryPlan lifts them.
const SHOP_NE = predicate('name', 'NE', 'S2');
const PRO_NE = predicate('name', 'NE', 'P2');

describe('the reference emptiness cases through the runtime', () => {
  const ids = Object.fromEntries(Object.values(REFERENCE_DATA).flat().map((record) => [record.key, record.key]));
  // Each case's own arguments for the root's scope: copies, since cases are frozen.
  const rootScope = (item) => (item.scopeArgs ? {
    [item.root]: {
      find: ({ args }) => { for (const [name, value] of Object.entries(structuredClone(item.scopeArgs))) args[name] = name === 'AND' ? [...(args.AND ?? []), ...value] : value; },
    },
  } : {});
  const rowsOf = async ({ run, types, keysOf }, item, shape, form) => {
    const plural = types.roots[item.root].plural;
    const trusted = form === 'trusted';
    const args = referenceCaseArgs(item, ids, trusted ? 'field' : form);
    const { source, variables } = referenceQuery(types, item.root, trusted ? {} : args);
    // Trusted code writes the same construct: middleware on the root's own call.
    const middleware = trusted ? (params) => { if (params.type.gqltype === types.roots[item.root].type) Object.assign(params.args, args); } : undefined;
    const result = await run(source, { shape, scopes: rootScope(item), middleware }, variables);
    expect(result.errors, `${item.name} ${shape} ${form}`).toBeUndefined();
    return keysOf(result, plural);
  };

  it.each([[false], [true]])('gives every case its rows for every shape, as a term, a group condition and trusted code (dangling %s)', async (dangling) => {
    const fixture = build({ dangling });
    for (const item of REFERENCE_CASES) {
      const forms = item.path ? ['field', 'condition', ...(item.trusted ? ['trusted'] : [])] : ['field'];
      for (const shape of REFERENCE_SHAPES) {
        for (const form of forms) {
          const expected = expectedReferenceRows(item, shape, { trusted: form === 'trusted', dangling });
          expect(await rowsOf(fixture, item, shape, form), `${item.name} ${shape} ${form}`).toEqual(expected);
        }
      }
    }
  });
});

describe('the deep copy of filter arguments', () => {
  const source = 'query($f: QLFilter, $g: [QLFilterGroup]) { qkProducts(name: $f, AND: $g) { key } qkShops(name: $f, AND: $g) { key } }';
  const notNone = () => ({ conditions: [{ field: 'name', operator: 'NE', value: 'none' }] });
  const variables = () => ({ f: { operator: 'NIN', value: ['none'] }, g: [{ ...notNone(), AND: [notNone()], OR: [notNone()] }] });

  it.each([['declares', DECLARED], ['does not declare', UNDECLARED]])('keeps a middleware edit of a shared variable within its call when the adapter %s reference emptiness', async (_label, queryFeatures) => {
    for (const [what, edit] of [
      ['a field filter', ({ args }) => { args.name.operator = 'IN'; }],
      ['a group condition', ({ args }) => { args.AND[0].conditions[0].value = 'S1'; }],
      ['a value array, in place', ({ args }) => { args.name.value.push('S1'); }],
      ['a group, in place', ({ args }) => { args.AND[0].conditions.push({ field: 'name', operator: 'EQ', value: 'none' }); }],
      ['a nested AND group\'s condition', ({ args }) => { args.AND[0].AND[0].conditions[0].value = 'S1'; }],
      ['a nested OR group\'s condition', ({ args }) => { args.AND[0].OR[0].conditions[0].value = 'S1'; }],
    ]) {
      const { run, calls, keysOf } = build({ queryFeatures });
      const result = await run(source, { middleware: onProduct(edit) }, variables());
      expect(result.errors, what).toBeUndefined();
      // The shops field reads the variables as the client sent them.
      expect(keysOf(result, 'qkShops'), what).toEqual(['S1', 'S2', 'S3']);
      const shops = calls.find((call) => call.type === 'QkShop');
      expect({ name: shops.args.name, AND: shops.args.AND.slice(0, 1) }, what).toEqual({ name: variables().f, AND: variables().g });
    }
  });

  it('copies every place an inline literal or a variable sits, with its prototype, so middleware edits one place only', async () => {
    const seen = [];
    const { run } = build({
      queryFeatures: UNDECLARED,
      dangling: false,
    });
    const middleware = onProduct(({ args }) => {
      seen.push(args);
      args.AND[0].conditions[0].value = 'edited';
    });
    const result = await run('query($c: QLFilterCondition) { qkProducts(AND: [{conditions: [$c, $c]}, {conditions: [{field: "name", operator: NE, value: "x"}]}]) { key } }', { middleware }, {
      c: { field: 'name', operator: 'NE', value: 'none' },
    });
    expect(result.errors).toBeUndefined();
    const [args] = seen;
    const [first, second] = args.AND[0].conditions;
    expect(first).not.toBe(second);
    expect(second.value).toBe('none');
    expect(Object.getPrototypeOf(first)).toBe(Object.prototype);
    // An inline literal keeps its null prototype.
    expect(Object.getPrototypeOf(args.AND[1].conditions[0])).toBeNull();
    expect(Object.getPrototypeOf(args.AND[1])).toBeNull();
  });
});

describe('client scope markers', () => {
  it('marks only the client\'s constructs that read references or collections, with ordinal ids middleware sees, for a declaring adapter only', async () => {
    for (const [queryFeatures, expected] of [
      [DECLARED, [{ id: 0 }, undefined, { id: 1 }, { id: 2 }]],
      [UNDECLARED, null],
    ]) {
      const seen = [];
      const { run } = build({ queryFeatures });
      const middleware = onProduct(({ args }) => {
        seen.push([args.shop.terms[0].__scope, args.odim.terms[0].__scope, args.AND[0].conditions[0].__scope, args.AND[0].conditions[1].__scope]);
      });
      const result = await run(`{ qkProducts(
        shop: {terms: [{operator: IS_EMPTY}]},
        odim: {terms: [{path: "w", operator: IS_EMPTY}]},
        AND: [{conditions: [{field: "pro", path: "shop.state", operator: IS_NOT_EMPTY}, {field: "reviews", operator: IS_EMPTY}]}]
      ) { key } }`, { middleware });
      if (expected) {
        expect(result.errors).toBeUndefined();
        expect(seen).toEqual([expected]);
        expect(Object.keys(seen[0][0])).toEqual(['id']);
      } else expect(failure(result)).toEqual({ code: 'UNSUPPORTED_QUERY', status: 400, message: `IS_EMPTY on shop ends at the reference shop: ${NOT_SUPPORTED}` });
    }
  });

  it('fills every use of one condition, group or term variable used twice in a call, with no DETACHED_CLIENT_FILTER', async () => {
    const { run, calls, keysOf } = build();
    const condition = { field: 'shop', operator: 'IS_EMPTY' };
    const shop = scoped('shop', 'IS_EMPTY', { shop: SHOP_NE });
    const conditions = await run('query($c: QLFilterCondition) { qkProducts(AND: [{conditions: [$c, $c]}], OR: [{conditions: [$c]}]) { key } }', { shape: 'NE' }, { c: condition });
    expect(conditions.errors).toBeUndefined();
    expect(keysOf(conditions, 'qkProducts')).toEqual(['C', 'c']);
    expect(predicatesOf(calls.at(-1).plan.where)).toEqual([shop, shop, shop]);
    const groups = await run('query($g: QLFilterGroup) { qkProducts(AND: [$g, $g]) { key } }', { shape: 'NE' }, { g: { conditions: [condition] } });
    expect(keysOf(groups, 'qkProducts')).toEqual(['C', 'c']);
    expect(predicatesOf(calls.at(-1).plan.where)).toEqual([shop, shop]);
    // One term variable under two references: each place reads its own target's scope.
    for (const [shape, rows, scopes] of [
      ['NE', ['c'], { shop: SHOP_NE, pro: PRO_NE }],
      ['EQ', ['C', 'D', 'c'], { shop: predicate('state', 'EQ', 'OPEN'), pro: predicate('name', 'EQ', 'P1') }],
      ['admin', [], { shop: null, pro: null }],
    ]) {
      const terms = await run('query($t: QLTypeFilterExpression) { qkProducts(shop: $t, pro: $t) { key } }', { shape }, { t: { terms: [{ operator: 'IS_EMPTY' }] } });
      expect(terms.errors, shape).toBeUndefined();
      expect(keysOf(terms, 'qkProducts'), shape).toEqual(rows);
      expect(calls.at(-1).plan.where, shape).toEqual({
        kind: 'and', terms: [scoped('shop', 'IS_EMPTY', { shop: scopes.shop }), scoped('pro', 'IS_EMPTY', { pro: scopes.pro })],
      });
    }
  });

  it.each([[false], [true]])('marks and fills its own copy, in each call, of a nested group or a term variable that two query fields and sibling collection-field calls share (batch %s)', async (batch) => {
    const { run, calls, keysOf } = build({ batch });
    const send = async (source, variables) => {
      calls.length = 0;
      const result = await run(source, { shape: 'NE' }, variables);
      expect(result.errors).toBeUndefined();
      const reads = calls.filter((call) => call.type === 'QkProduct');
      return {
        rows: [keysOf(result, 'a'), keysOf(result, 'b'), Object.fromEntries(result.data.qkShops.map(({ key, products }) => [key, products.map((item) => item.key)]))],
        roots: reads.filter((call) => call.method === 'find').map((call) => call.plan.where),
        children: reads.filter((call) => call.method !== 'find').map((call) => [call.method, call.parents, call.plan.where]),
      };
    };
    // Under NE the shops list reads S1 and S3, and each collection-field call reads one of them.
    const children = (where) => (batch ? [['findChildrenBatch', ['S1', 'S3'], where]] : [['findChildren', undefined, where], ['findChildren', undefined, where]]);
    const condition = { field: 'pro', path: 'shop', operator: 'IS_EMPTY' };
    const proShop = scoped('pro.shop', 'IS_EMPTY', { pro: PRO_NE, 'pro.shop': SHOP_NE });
    const groups = 'query($g: [QLFilterGroup]) { a: qkProducts(AND: $g) { key } b: qkProducts(AND: $g) { key } qkShops { key products(AND: $g) { key } } }';
    for (const g of [
      [{ AND: [{ conditions: [condition] }] }],
      [{ OR: [{ conditions: [condition] }] }],
      [{ AND: [{ OR: [{ conditions: [condition] }] }] }],
    ]) {
      const { rows, roots, children: reads } = await send(groups, { g });
      expect(rows, JSON.stringify(g)).toEqual([['C', 'D', 'E', 'c'], ['C', 'D', 'E', 'c'], { S1: ['E'], S3: ['D'] }]);
      expect(roots.map(predicatesOf), JSON.stringify(g)).toEqual([[proShop], [proShop]]);
      expect(reads.map(([method, parents, where]) => [method, parents, predicatesOf(where)]), JSON.stringify(g)).toEqual(children([proShop]));
    }
    // One term variable under shop in both query fields and under pro in the collection field.
    const terms = await send(
      'query($t: QLTypeFilterExpression) { a: qkProducts(shop: $t) { key } b: qkProducts(shop: $t) { key } qkShops { key products(pro: $t) { key } } }',
      { t: { terms: [{ operator: 'IS_EMPTY' }] } },
    );
    expect(terms.rows).toEqual([['C', 'c'], ['C', 'c'], { S1: ['E'], S3: [] }]);
    expect(terms.roots).toEqual([0, 1].map(() => scoped('shop', 'IS_EMPTY', { shop: SHOP_NE })));
    expect(terms.children).toEqual(children(scoped('pro', 'IS_EMPTY', { pro: PRO_NE })));
  });

  describe('middleware changes to a marked construct', () => {
    // A client's term and group condition, both marked: `pro.shop IS_EMPTY` and `shop.state IS_EMPTY`. Under NE they
    // return C, D, c together.
    const CLIENT = {
      pro: { terms: [{ path: 'shop', operator: 'IS_EMPTY' }] },
      AND: [{ conditions: [{ field: 'shop', path: 'state', operator: 'IS_EMPTY' }] }],
    };
    const term = (args) => args.pro.terms[0];
    const condition = (args) => args.AND[0].conditions[0];
    const send = async (fixture, {
      middleware, scopes, client = CLIENT, ran,
    } = {}) => {
      fixture.calls.length = 0;
      const { source, variables } = referenceQuery(fixture.types, 'product', structuredClone(client));
      const result = await fixture.run(source, {
        shape: 'NE', middleware: middleware && onProduct(middleware), scopes, ran,
      }, variables);
      return { result, rows: fixture.keysOf(result, 'qkProducts'), where: fixture.calls.at(-1)?.plan.where };
    };
    const proShop = scoped('pro.shop', 'IS_EMPTY', { pro: PRO_NE, 'pro.shop': SHOP_NE });
    const shopState = scoped('shop.state', 'IS_EMPTY', { shop: SHOP_NE });

    it('accepts spreading, cloning or duplicating it, reading the hidden target as missing at every place', async () => {
      const fixture = build();
      expect(await send(fixture)).toMatchObject({ rows: ['C', 'D', 'c'], where: { kind: 'and', terms: [proShop, shopState] } });
      for (const [what, middleware, terms] of [
        ['spread', ({ args }) => {
          args.pro = { ...args.pro, terms: args.pro.terms.map((item) => ({ ...item })) };
          args.AND = args.AND.map((group) => ({ ...group, conditions: group.conditions.map((item) => ({ ...item })) }));
        }, [proShop, shopState]],
        ['structuredClone', (params) => { params.args = structuredClone(params.args); }, [proShop, shopState]],
        ['duplicated', ({ args }) => { args.AND.push({ conditions: [condition(args)] }); }, [proShop, shopState, shopState]],
        ['spread and duplicated', ({ args }) => { args.AND.push({ conditions: [{ ...condition(args) }] }); }, [proShop, shopState, shopState]],
        // A spread copy on another path, beside the original, is filled for its own path.
        ['spread onto another path', ({ args }) => { args.AND.push({ conditions: [{ ...condition(args), field: 'pro', path: 'shop.state' }] }); },
          [proShop, shopState, scoped('pro.shop.state', 'IS_EMPTY', { pro: PRO_NE, 'pro.shop': SHOP_NE })]],
      ]) {
        const { result, rows, where } = await send(fixture, { middleware });
        expect(result.errors, what).toBeUndefined();
        expect(rows, what).toEqual(['C', 'D', 'c']);
        expect(predicatesOf(where), what).toEqual(terms);
      }
    });

    it('fills one marked term placed under a second key with the union of both places\' scopes, unless one place reads no reference', async () => {
      const fixture = build();
      const { result, rows, where } = await send(fixture, {
        client: { shop: { terms: [{ operator: 'IS_EMPTY' }] } },
        middleware: ({ args }) => { args.pro = { terms: [args.shop.terms[0]] }; },
      });
      expect(result.errors).toBeUndefined();
      expect(rows).toEqual(['c']);
      expect(where).toEqual({ kind: 'and', terms: [scoped('shop', 'IS_EMPTY', { shop: SHOP_NE }), scoped('pro', 'IS_EMPTY', { pro: PRO_NE })] });
      const [marked] = fixture.calls.at(-1).args.shop.terms;
      expect(marked.__scope).toEqual({ id: 0, scopes: { shop: { AND: [{ conditions: [{ field: 'name', operator: 'NE', value: 'S2' }] }] }, pro: { AND: [{ conditions: [{ field: 'name', operator: 'NE', value: 'P2' }] }] } } });
      // One marker cannot serve a place that reads a reference and one that reads none, such as an embedded list.
      fixture.calls.length = 0;
      const mixed = await send(fixture, {
        client: { shop: { terms: [{ operator: 'IS_EMPTY' }] } },
        middleware: ({ args }) => { args.olines = { terms: [args.shop.terms[0]] }; },
      });
      expect(failure(mixed.result)).toEqual(detached('The client\'s IS_EMPTY condition on shop is used where it reads references or collections and where it reads none (olines)'));
      expect(fixture.calls).toEqual([]);
    });

    it('reads the final path: an edited path keeps the client\'s scopes, and one narrowed to an own field reads as 2a with no marker', async () => {
      const fixture = build();
      const edited = await send(fixture, { middleware: ({ args }) => { delete condition(args).path; } });
      expect(edited.result.errors).toBeUndefined();
      expect(edited.rows).toEqual(['C', 'c']);
      expect(predicatesOf(edited.where)).toEqual([proShop, scoped('shop', 'IS_EMPTY', { shop: SHOP_NE })]);
      const narrowed = await send(fixture, { middleware: ({ args }) => { Object.assign(condition(args), { field: 'odim', path: 'w' }); } });
      expect(narrowed.result.errors).toBeUndefined();
      expect(narrowed.rows).toEqual(['C', 'D', 'E', 'c']);
      expect(predicatesOf(narrowed.where)).toEqual([proShop, predicate('odim.w', 'IS_EMPTY')]);
      expect(Object.hasOwn(fixture.calls.at(-1).args.AND[0].conditions[0], '__scope')).toBe(false);
      // Another operator on an own field loses the marker too.
      const own = await send(fixture, { middleware: ({ args }) => { Object.assign(condition(args), { field: 'name', path: undefined, operator: 'NE', value: 'c' }); } });
      expect(own.result.errors).toBeUndefined();
      expect(own.rows).toEqual(['C', 'D', 'E']);
      expect(Object.hasOwn(fixture.calls.at(-1).args.AND[0].conditions[0], '__scope')).toBe(false);
    });

    // [what, middleware, product scope, message]: each one gives DETACHED_CLIENT_FILTER before the adapter is called.
    const DETACHING = [
      ['rebuilds a group condition', ({ args }) => {
        args.AND = args.AND.map((group) => ({ conditions: group.conditions.map(({ field, path, operator }) => ({ field, path, operator })) }));
      }, null, 'The client\'s IS_EMPTY condition on shop.state is no longer in the arguments after middleware and scopes'],
      ['drops a term', ({ args }) => { delete args.pro; }, null, 'The client\'s IS_EMPTY condition on pro.shop is no longer in the arguments after middleware and scopes'],
      ['assigns over it in a scope', null, ({ args }) => { args.pro = { terms: [{ path: 'name', operator: 'NE', value: 'x' }] }; },
        'The client\'s IS_EMPTY condition on pro.shop is no longer in the arguments after middleware and scopes'],
      ['pre-fills its marker', ({ args }) => { term(args).__scope.scopes = {}; }, null,
        'The IS_EMPTY condition on pro.shop, the client\'s IS_EMPTY condition on pro.shop, carries a malformed client scope marker'],
      ['nulls its marker', ({ args }) => { term(args).__scope = null; }, null, 'The IS_EMPTY condition on pro.shop carries a malformed client scope marker'],
      ['forges an id', ({ args }) => { term(args).__scope = { id: 7 }; }, null,
        'The IS_EMPTY condition on pro.shop carries a client scope marker that this query field did not issue'],
      ['changes its operator to EQ null', ({ args }) => { Object.assign(condition(args), { operator: 'EQ', value: null }); }, null,
        'The client\'s IS_EMPTY condition on shop.state now uses EQ on shop.state, which reads through shop without its scope'],
    ];
    const aggregation = 'aggregation:{groupId:"name",facts:[{operation:COUNT,factName:"n",path:"stock"}]}';
    // Under NE the shops list reads S1 and S3, so a collection field fails once for each.
    const SURFACES = [
      ['a list with a count', '{qkProducts(pro:$pro,AND:$AND,pagination:{page:1,size:5,count:true}){key}}', 1, false],
      ['an aggregate', `{qkProducts_aggregate(pro:$pro,AND:$AND,${aggregation}){groupId}}`, 1, false],
      ['a collection field', '{qkShops{key products(pro:$pro,AND:$AND){key}}}', 2, false],
      ['a batched collection field', '{qkShops{key products(pro:$pro,AND:$AND){key}}}', 2, true],
    ];

    it('checks every marked construct before any target scope runs, so a later construct\'s DETACHED_CLIENT_FILTER comes first', async () => {
      const fixture = build();
      const ran = [];
      // The term pro.shop is checked first, and its fill would run the Pro and Shop scopes; the condition after it detaches.
      const { result } = await send(fixture, { ran, middleware: ({ args }) => { Object.assign(condition(args), { operator: 'EQ', value: null }); } });
      expect(failure(result)).toEqual(detached('The client\'s IS_EMPTY condition on shop.state now uses EQ on shop.state, which reads through shop without its scope'));
      expect(ran).toEqual(['middleware QkProduct find', 'scope product find']);
      expect(fixture.calls).toEqual([]);
    });

    it.each(SURFACES)('gives DETACHED_CLIENT_FILTER on %s when middleware or a scope detaches it, before the adapter runs', async (_surface, selection, count, batch) => {
      const fixture = build({ batch });
      const source = `query($pro:QLTypeFilterExpression,$AND:[QLFilterGroup])${selection}`;
      for (const [what, middleware, scope, message] of DETACHING) {
        fixture.calls.length = 0;
        const scopes = scope ? { product: { find: scope, aggregate: scope } } : undefined;
        const result = await fixture.run(source, { shape: 'NE', middleware: middleware && onProduct(middleware), scopes }, structuredClone(CLIENT));
        expect(failures(result), what).toEqual(Array(count).fill(detached(message)));
        expect(fixture.calls.filter((call) => call.type === 'QkProduct'), what).toEqual([]);
      }
    });
  });

  it('never reads a marker planted inside a value, so a rebuilt construct still gives DETACHED_CLIENT_FILTER', async () => {
    const { run, calls } = build();
    const rebuild = onProduct(({ args }) => { args.shop = { terms: args.shop.terms.map(({ operator }) => ({ operator })) }; });
    const source = 'query($shop: QLTypeFilterExpression, $name: QLFilter) { qkProducts(shop: $shop, name: $name) { key } }';
    const variables = { shop: { terms: [{ operator: 'IS_EMPTY' }] }, name: { operator: 'EQ', value: { __scope: { id: 0 } } } };
    expect(failure(await run(source, { middleware: rebuild }, variables)))
      .toEqual(detached('The client\'s IS_EMPTY condition on shop is no longer in the arguments after middleware and scopes'));
    expect(calls).toEqual([]);
    // Without a marked construct, a value holding `__scope` keeps its 3.10 result: it is a value like any other.
    const planted = { id: 'Ka', __scope: { id: 0 } };
    const result = await run('query($id: QLFilter) { qkProducts(id: $id) { key } }', {}, { id: { operator: 'EQ', value: planted } });
    expect(result.errors).toBeUndefined();
    expect(result.data.qkProducts).toEqual([]);
    expect(calls.at(-1).plan.where).toEqual(predicate('id', 'EQ', planted));
  });

  it('keeps one batch for sibling parents, and reads each parent alone when a filled scope is not plain data', async () => {
    const source = '{ qkShops { key products(pro: {terms: [{path: "shop", operator: IS_EMPTY}]}) { key } } }';
    const rowsByShop = (result) => Object.fromEntries(result.data.qkShops.map(({ key, products }) => [key, products.map((item) => item.key)]));
    const { run, calls } = build({ batch: true });
    const batched = await run(source, { shape: 'NE' });
    expect(batched.errors).toBeUndefined();
    // Shop's own scope hides S2 from the list; S1's E has no pro, and S3's D has P4, which has no shop.
    expect(rowsByShop(batched)).toEqual({ S1: ['E'], S3: ['D'] });
    const reads = calls.filter((call) => call.type === 'QkProduct');
    expect(reads.map((call) => [call.method, call.parents])).toEqual([['findChildrenBatch', ['S1', 'S3']]]);
    expect(reads[0].plan.where).toEqual(scoped('pro.shop', 'IS_EMPTY', { pro: PRO_NE, 'pro.shop': SHOP_NE }));
    // A Shop scope that holds an ObjectId: childArgsKey refuses the arguments, so each parent reads alone.
    calls.length = 0;
    const objectId = new mongoose.Types.ObjectId();
    const alone = await run(source, {
      shape: 'NE',
      scopes: { shop: { find: ({ args }) => appendAnd(args, [{ conditions: [{ field: 'id', operator: 'NE', value: objectId }] }]) } },
    });
    expect(alone.errors).toBeUndefined();
    expect(rowsByShop(alone)).toEqual({ S1: ['E'], S3: ['D'] });
    expect(calls.filter((call) => call.type === 'QkProduct').map((call) => call.method)).toEqual(['findChildren', 'findChildren']);
    // The same marker without a scope that is not plain data batches again, with every shop under admin, where c's P2
    // reads its shop.
    calls.length = 0;
    const admin = await run(source);
    expect(rowsByShop(admin)).toEqual({ S1: ['E'], S2: [], S3: ['D'] });
    expect(calls.filter((call) => call.type === 'QkProduct').map((call) => [call.method, call.parents])).toEqual([['findChildrenBatch', ['S1', 'S2', 'S3']]]);
  });

  it('applies a get_by_id scope\'s emptiness as a trusted condition, which reads stored data', async () => {
    const { run, calls } = build();
    const scopes = { product: { get_by_id: ({ args }) => { args.shop = { terms: [{ operator: 'IS_NOT_EMPTY' }] }; } } };
    // c's shop S2 is hidden by Shop's find scope under NE, but stored.
    const byId = await run('{ c: qkProduct(id: "c") { key } C: qkProduct(id: "C") { key } }', { shape: 'NE', scopes });
    expect(byId.errors).toBeUndefined();
    expect(byId.data).toEqual({ c: { key: 'c' }, C: null });
    expect(calls.map((call) => call.plan.where)).toEqual(['c', 'C'].map((id) => ({
      kind: 'and', terms: [predicate('id', 'EQ', id), predicate('shop', 'IS_NOT_EMPTY')],
    })));
  });
});

// Types for the fill, the 403 rules and the limits: Item references Shop twice (shop, backup) and holds a reference
// member (odim.shop) and a collection (reviews); Shop has a virtual field, a reference to Owner, which declares no find
// scope, an embedded list with a reference member, and a collection. Find scopes read `context.scopes[name](args,
// context)`; `context.ran` lists every middleware and scope call.
const contextScope = (name) => ({ args, context }) => {
  context?.ran?.push(`scope ${name}`);
  context?.scopes?.[name]?.(args, context);
};
const buildLocal = ({ queryFeatures = DECLARED, permissions } = {}) => {
  const calls = [];
  const runtime = createRuntime(createMemoryAdapter({ queryFeatures, calls }));
  const Owner = new GraphQLObjectType({ name: 'QfOwner', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
  const Line = new GraphQLObjectType({ name: 'QfLine', fields: { qty: { type: GraphQLInt }, owner: { type: Owner, extensions: reference() } } });
  const Shop = new GraphQLObjectType({
    name: 'QfShop',
    extensions: { scope: { find: contextScope('shop') } },
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      slug: { type: GraphQLString, resolve: () => 's', extensions: { virtual: true } },
      owner: { type: Owner, extensions: reference('owner') },
      lines: { type: new GraphQLList(Line), extensions: embedded },
      items: { type: new GraphQLList(Item), extensions: reference('shop') },
    }),
  });
  const ODim = new GraphQLObjectType({ name: 'QfODim', fields: () => ({ w: { type: GraphQLInt }, shop: { type: Shop, extensions: reference() } }) });
  const Review = new GraphQLObjectType({
    name: 'QfReview',
    extensions: { scope: { find: contextScope('review') } },
    fields: () => ({ id: { type: GraphQLID }, text: { type: GraphQLString }, item: { type: Item, extensions: reference('item') } }),
  });
  const Item = new GraphQLObjectType({
    name: 'QfItem',
    extensions: { scope: { find: contextScope('item') } },
    fields: () => ({
      id: { type: GraphQLID },
      note: { type: GraphQLString },
      shop: { type: Shop, extensions: reference('shop') },
      backup: { type: Shop, extensions: reference('backup') },
      odim: { type: ODim, extensions: embedded },
      reviews: { type: new GraphQLList(Review), extensions: reference('item') },
    }),
  });
  runtime.use(async (params, next) => {
    params.context?.ran?.push(`middleware ${params.type.gqltype.name} ${params.operation}`);
    await params.context?.middleware?.(params);
    await next();
  });
  runtime.addNoEndpointType(Line);
  runtime.addNoEndpointType(ODim);
  runtime.connect(null, Owner, 'qfOwner', 'qfOwners');
  runtime.connect(null, Shop, 'qfShop', 'qfShops');
  runtime.connect(null, Review, 'qfReview', 'qfReviews');
  runtime.connect(null, Item, 'qfItem', 'qfItems');
  const schema = runtime.createSchema();
  if (permissions) auth.createAuthPlugin(permissions, { defaultPolicy: 'DENY' }).onSchemaChange({ schema });
  const run = (source, context = {}) => graphql({ schema, source, contextValue: context });
  return { calls, run, runtime };
};

describe('the fill', () => {
  const SHOP_EMPTY = '{ qfItems(shop: {terms: [{operator: IS_EMPTY}]}) { id } }';
  const withShopScope = (scope, extra = {}) => ({ scopes: { shop: scope }, ...extra });

  it('rejects a target find scope through a virtual field with INVALID_MODEL, and an undeclared operator with UNSUPPORTED_QUERY', async () => {
    const { run, calls } = buildLocal();
    expect(failure(await run(SHOP_EMPTY, withShopScope((args) => { args.slug = { operator: 'EQ', value: 's' }; })))).toEqual({
      code: 'INVALID_MODEL', status: 500, message: 'Query path slug, added by middleware or a scope, uses the virtual field QfShop.slug, which is not stored',
    });
    const narrow = buildLocal({ queryFeatures: { operators: OPERATORS.filter((operator) => operator !== 'NE'), referenceEmptiness: true } });
    expect(failure(await narrow.run(SHOP_EMPTY, withShopScope((args) => { args.name = { operator: 'NE', value: 'x' }; })))).toEqual({
      code: 'UNSUPPORTED_QUERY', status: 400, message: 'The database adapter does not support the NE filter operator, used on QfShop.name',
    });
    expect([...calls, ...narrow.calls]).toEqual([]);
  });

  it('checks a target scope\'s sort and pagination for shape, then strips them', async () => {
    const { run, calls } = buildLocal();
    for (const [scope, code, message] of [
      [(args) => { args.sort = { terms: [] }; }, 'INVALID_SORT', 'Sort requires non-empty terms'],
      [(args) => { args.sort = { terms: [{ field: 'name' }] }; }, 'INVALID_SORT', 'Sort terms require a field and an ASC or DESC order'],
      [(args) => { args.pagination = { page: 0, size: 5 }; }, 'INVALID_PAGINATION', 'Pagination requires positive safe integers and size <= 1000'],
    ]) expect(failure(await run(SHOP_EMPTY, withShopScope(scope))), message).toEqual({ code, status: 400, message });
    expect(calls).toEqual([]);
    const valid = await run(SHOP_EMPTY, withShopScope((args) => {
      args.name = { operator: 'NE', value: 'x' };
      args.sort = { terms: [{ field: 'name', order: 'ASC' }] };
      args.pagination = { page: 2, size: 5 };
    }));
    expect(valid.errors).toBeUndefined();
    expect(calls[0].args.shop.terms[0].__scope).toEqual({ id: 0, scopes: { shop: { name: { operator: 'NE', value: 'x' } } } });
    // A scope with nothing but sort and pagination added nothing.
    const sortOnly = await run(SHOP_EMPTY, withShopScope((args) => { args.sort = { terms: [{ field: 'name', order: 'ASC' }] }; args.AND = []; }));
    expect(sortOnly.errors).toBeUndefined();
    expect(calls[1].args.shop.terms[0].__scope).toEqual({ id: 0, scopes: { shop: null } });
  });

  it('runs the detach check, then the final gate, then the fill, so no target scope runs before a DETACHED_CLIENT_FILTER or a 2a code', async () => {
    const { run, calls } = buildLocal();
    const note = { operator: 'IS_EMPTY', value: 'x' };
    // Middleware's condition fails the final gate before the Shop scope, whose sort would fail the fill, runs.
    const gated = { ran: [], middleware: (params) => { params.args.note = { ...note }; }, scopes: { shop: (args) => { args.sort = { terms: [] }; } } };
    expect(failure(await run(SHOP_EMPTY, gated))).toEqual({
      code: 'INVALID_FILTER_VALUE', status: 400, message: 'IS_EMPTY takes no value on note: omit it or pass null',
    });
    expect(gated.ran).toEqual(['middleware QfItem find', 'scope item']);
    // A dropped marked construct fails the detach check before the gate reads that condition.
    const dropped = { ran: [], middleware: (params) => { delete params.args.shop; params.args.note = { ...note }; } };
    expect(failure(await run(SHOP_EMPTY, dropped)))
      .toEqual(detached('The client\'s IS_EMPTY condition on shop is no longer in the arguments after middleware and scopes'));
    expect(dropped.ran).toEqual(['middleware QfItem find', 'scope item']);
    expect(calls).toEqual([]);
  });

  it('runs each target type\'s scope once per call, after middleware and the query\'s own scope, so it sees what middleware set', async () => {
    const { run, calls } = buildLocal();
    const context = {
      ran: [],
      middleware: (params) => { params.context.tenant = 'T1'; },
      scopes: { shop: (args, ctx) => { args.name = { operator: 'EQ', value: ctx.tenant }; } },
    };
    const result = await run(`{ qfItems(
      shop: {terms: [{operator: IS_EMPTY}]},
      backup: {terms: [{path: "name", operator: IS_NOT_EMPTY}]},
      odim: {terms: [{operator: IS_EMPTY}]},
      AND: [{conditions: [{field: "shop", path: "owner", operator: IS_NOT_EMPTY}]}]
    ) { id } }`, context);
    expect(result.errors).toBeUndefined();
    expect(context.ran).toEqual(['middleware QfItem find', 'scope item', 'scope shop']);
    const shop = predicate('name', 'EQ', 'T1');
    expect(predicatesOf(calls[0].plan.where)).toEqual([
      scoped('shop', 'IS_EMPTY', { shop }),
      scoped('backup.name', 'IS_NOT_EMPTY', { backup: shop }),
      scoped('odim', 'IS_EMPTY', { 'odim.shop': shop }),
      // Owner declares no find scope.
      scoped('shop.owner', 'IS_NOT_EMPTY', { shop, 'shop.owner': null }),
    ]);
  });
});

describe('authorization of reference and collection emptiness', () => {
  it('authorizes a reference or member end by its own path only, so Shop needs no rule under DENY', async () => {
    const permissions = {
      RootQueryType: { '*': auth.allow() }, QkProduct: { '*': auth.allow() }, QkODim: { '*': auth.allow() },
    };
    const { run, keysOf } = build({ permissions });
    for (const [source, rows] of [
      ['{ qkProducts(shop: {terms: [{operator: IS_EMPTY}]}) { key } }', ['C']],
      ['{ qkProducts(shop: {terms: [{operator: IS_NOT_EMPTY}]}) { key } }', ['D', 'E', 'Ka', 'c']],
      ['{ qkProducts(AND: [{conditions: [{field: "odim", operator: IS_EMPTY}]}]) { key } }', ['E']],
    ]) {
      const result = await run(source);
      expect(result.errors, source).toBeUndefined();
      expect(keysOf(result, 'qkProducts'), source).toEqual(rows);
    }
  });

  it('denies a leaf through a reference whose field has no rule (regression pin, passes on 3.10.0 by design)', async () => {
    const { run, calls } = build({ permissions: { RootQueryType: { '*': auth.allow() }, QkProduct: { '*': auth.allow() } } });
    expect(failure(await run('{ qkProducts(shop: {terms: [{path: "state", operator: IS_EMPTY}]}) { key } }')))
      .toEqual({ code: 'FORBIDDEN', status: 403, message: 'Access denied to QkShop.state' });
    expect(calls).toEqual([]);
  });

  it('answers a restricted caller\'s reference end with no 403 when its target scope crosses a collection or a reference inside a list, which a legacy path keeps', async () => {
    const { run, calls } = buildLocal();
    for (const [scope, message, where] of [
      [(args) => { args.items = { terms: [{ path: 'note', value: 'x' }] }; }, 'Query path shop enters QfShop, whose find scope filters through the collection QfShop.items',
        predicate('items.note', 'EQ', 'x')],
      [(args) => { args.lines = { terms: [{ path: 'owner.name', value: 'x' }] }; }, 'Query path shop enters QfShop, whose find scope filters through the relation QfLine.owner inside a list',
        predicate('lines.owner.name', 'EQ', 'x')],
    ]) {
      calls.length = 0;
      const result = await run('{ qfItems(shop: {terms: [{operator: IS_EMPTY}]}) { id } }', { scopes: { shop: scope } });
      expect(result.errors, message).toBeUndefined();
      expect(calls.map((call) => call.plan.where), message).toEqual([scoped('shop', 'IS_EMPTY', { shop: where })]);
      expect(failure(await run('{ qfItems(shop: {terms: [{path: "name", value: "x"}]}) { id } }', { scopes: { shop: scope } })), message)
        .toEqual({ code: 'FORBIDDEN_FILTER_PATH', status: 403, message });
      expect(calls, message).toHaveLength(1);
    }
  });
});

describe('maxReferenceFrames', () => {
  afterEach(() => configureQueryLimits({}));
  // Ten distinct (kind, path) pairs: frames shop, backup, reviews, odim.shop, shop.owner and shop.items, and scoped joins
  // shop, backup, odim.shop and shop.owner, into Owner, which declares no find scope. The eleventh is the frame
  // backup.items.
  const TEN = [
    'shop: {terms: [{operator: IS_EMPTY}, {path: "name", operator: IS_EMPTY}, {path: "owner", operator: IS_EMPTY}, {path: "owner.name", operator: IS_EMPTY}, {path: "items", operator: IS_EMPTY}]}',
    'backup: {terms: [{operator: IS_NOT_EMPTY}, {path: "name", operator: IS_EMPTY}]}',
    'reviews: {terms: [{operator: IS_EMPTY}]}',
    'odim: {terms: [{operator: IS_EMPTY}, {path: "shop.name", operator: IS_EMPTY}]}',
  ];
  const ELEVENTH = 'AND: [{conditions: [{field: "backup", path: "items", operator: IS_EMPTY}]}]';
  const query = (...args) => `{ qfItems(${args.join(', ')}) { id } }`;
  const over = (count, limit = 10) => ({
    code: 'FILTER_DEPTH_EXCEEDED',
    status: 400,
    message: `Emptiness conditions through references and collections need ${count} scoped joins and frames in one set of conditions (the client's arguments of a query field, or a view's where), more than the limit of ${limit} (maxReferenceFrames)`,
  });
  const RESTRICTED = { scopes: { shop: (args) => { args.name = { operator: 'NE', value: 'x' }; }, review: (args) => { args.text = { operator: 'NE', value: 'y' }; } } };

  it('passes 10 distinct scoped joins and frames and rejects 11, for an admin and a restricted caller alike, before middleware', async () => {
    const { run, calls } = buildLocal();
    for (const context of [{}, RESTRICTED]) {
      calls.length = 0;
      expect((await run(query(...TEN), context)).errors).toBeUndefined();
      // Repeating a pair counts it once.
      expect((await run(query(...TEN, 'AND: [{conditions: [{field: "shop", path: "name", operator: IS_NOT_EMPTY}]}]'), context)).errors).toBeUndefined();
      expect(calls).toHaveLength(2);
      const ran = [];
      expect(failure(await run(query(...TEN, ELEVENTH), { ...context, ran }))).toEqual(over(11));
      expect(ran).toEqual([]);
    }
  });

  it('comes after every 2a code of any client condition, counts each query field apart, and leaves trusted constructs out', async () => {
    const { run, calls } = buildLocal();
    expect(failure(await run(query(...TEN, ELEVENTH, 'note: {operator: IS_EMPTY, value: "x"}'))).code).toBe('INVALID_FILTER_VALUE');
    expect(failure(await run(query(...TEN, ELEVENTH, 'OR: [{conditions: [{field: "shop", path: "slug", operator: IS_EMPTY}]}]'))).code).toBe('FORBIDDEN_FILTER_PATH');
    // Six pairs in each of two root fields, and twelve in the request, since the fields share none: frames shop,
    // shop.owner, backup, reviews and odim.shop and the scoped join shop; then scoped joins backup, backup.owner and
    // odim.shop and frames backup.owner, backup.items and odim.shop.items.
    const first = [
      'shop: {terms: [{operator: IS_EMPTY}, {path: "owner", operator: IS_EMPTY}]}', 'backup: {terms: [{operator: IS_EMPTY}]}',
      'reviews: {terms: [{operator: IS_EMPTY}]}', 'odim: {terms: [{operator: IS_EMPTY}]}',
    ];
    const second = [
      'backup: {terms: [{path: "owner.name", operator: IS_EMPTY}, {path: "owner", operator: IS_NOT_EMPTY}, {path: "items", operator: IS_EMPTY}]}',
      'odim: {terms: [{path: "shop.items", operator: IS_EMPTY}]}',
    ];
    const twice = `{ a: qfItems(${first.join(', ')}) { id } b: qfItems(${second.join(', ')}) { id } }`;
    expect((await run(twice)).errors).toBeUndefined();
    expect(calls).toHaveLength(2);
    configureQueryLimits({ maxReferenceFrames: 5 });
    expect(failures(await run(twice))).toEqual([over(6, 5), over(6, 5)]);
    expect(calls).toHaveLength(2);
    configureQueryLimits({});
    // Middleware's conditions are trusted and not counted.
    const trusted = await run(query(...TEN), {
      middleware: (params) => { params.args.AND = [{ conditions: [{ field: 'backup', path: 'items', operator: 'IS_EMPTY' }, { field: 'backup', path: 'owner', operator: 'IS_EMPTY' }] }]; },
    });
    expect(trusted.errors).toBeUndefined();
  });

  it('comes before the field and value checks of other conditions and the joined-scope 403s, and after the 403s of client paths, undeclared operators and the 2a codes', async () => {
    const error = (code, status, message) => ({ code, status, message });
    const reviewsText = 'OR: [{conditions: [{field: "reviews", path: "text", operator: EQ, value: "x"}]}]';
    // Checks that run after middleware: each gives its code beside TEN, and the limit's beside the eleventh pair, before
    // middleware, scopes or the adapter run.
    const later = [
      ['note: {operator: BTW, value: ["a"]}', {}, error('INVALID_FILTER_VALUE', 400, 'BTW requires two values')],
      ['note: {operator: ILIKE, value: 5}', {}, error('INVALID_FILTER_VALUE', 400, 'ILIKE requires a non-null string value on note')],
      ['OR: [{conditions: [{field: "nosuch", operator: EQ, value: "x"}]}]', {}, error('INVALID_FILTER_FIELD', 400, 'Unknown field nosuch')],
      [reviewsText, RESTRICTED, error('FORBIDDEN_FILTER_PATH', 403, 'Query path reviews enters the scoped collection QfItem.reviews')],
    ];
    const local = buildLocal();
    for (const [condition, context, expected] of later) {
      const under = [];
      expect(failure(await local.run(query(...TEN, condition), { ...context, ran: under })), condition).toEqual(expected);
      expect(under, condition).toContain('middleware QfItem find');
      const ran = [];
      local.calls.length = 0;
      expect(failure(await local.run(query(...TEN, ELEVENTH, condition), { ...context, ran })), condition).toEqual(over(11));
      expect(ran, condition).toEqual([]);
      expect(local.calls, condition).toEqual([]);
    }
    // Checks that run before the limit: each keeps its code beside the eleventh pair, and nothing runs.
    const permissions = Object.fromEntries(['RootQueryType', 'QfItem', 'QfShop', 'QfOwner', 'QfODim'].map((name) => [name, { '*': auth.allow() }]));
    const withoutLike = { operators: OPERATORS.filter((operator) => operator !== 'LIKE'), referenceEmptiness: true };
    const first = [
      [{ permissions }, reviewsText, error('FORBIDDEN', 403, 'Access denied to QfReview.text')],
      [{}, 'OR: [{conditions: [{field: "shop", path: "slug", operator: EQ, value: "x"}]}]',
        error('FORBIDDEN_FILTER_PATH', 403, 'Query path shop.slug uses the virtual field QfShop.slug, which is not stored')],
      [{ queryFeatures: withoutLike }, 'note: {operator: LIKE, value: "x"}',
        error('UNSUPPORTED_QUERY', 400, 'The database adapter does not support the LIKE filter operator, used on QfItem.note')],
      [{}, 'OR: [{conditions: [{field: "shop", path: "nosuch", operator: IS_EMPTY}]}]', error('INVALID_FILTER_FIELD', 400, 'Unknown field shop.nosuch')],
      [{}, 'OR: [{conditions: [{field: "shop", path: "items.note", operator: IS_EMPTY}]}]',
        error('INVALID_FILTER_PATH', 400, 'IS_EMPTY cannot test shop.items.note: emptiness of a value inside a list is not defined, and shop.items is a collection')],
      [{}, 'OR: [{conditions: [{field: "shop", path: "name", operator: IS_NOT_EMPTY, value: "x"}]}]',
        error('INVALID_FILTER_VALUE', 400, 'IS_NOT_EMPTY takes no value on shop.name: omit it or pass null')],
    ];
    for (const [options, condition, expected] of first) {
      const { run, calls } = buildLocal(options);
      expect((await run(query(...TEN))).errors, condition).toBeUndefined();
      for (const args of [[...TEN, condition], [...TEN, ELEVENTH, condition]]) {
        const ran = [];
        expect(failure(await run(query(...args), { ran })), condition).toEqual(expected);
        expect(ran, condition).toEqual([]);
      }
      expect(calls, condition).toHaveLength(1);
    }
  });

  it('takes configureQueryLimits({ maxReferenceFrames }), keeps it on an invalid call and restores the default when omitted', async () => {
    const { run, runtime } = buildLocal();
    const three = query('shop: {terms: [{operator: IS_EMPTY}, {path: "name", operator: IS_EMPTY}]}', 'reviews: {terms: [{operator: IS_EMPTY}]}');
    runtime.configureQueryLimits({ maxReferenceFrames: 2 });
    expect(failure(await run(three))).toEqual(over(3, 2));
    expect(() => runtime.configureQueryLimits({ maxReferenceFrames: 0 })).toThrow('maxReferenceFrames must be a positive safe integer');
    expect(failure(await run(three))).toEqual(over(3, 2));
    configureQueryLimits({ maxReferenceFrames: 3 });
    expect((await run(three)).errors).toBeUndefined();
    runtime.configureQueryLimits({});
    expect((await run(query(...TEN))).errors).toBeUndefined();
  });

  it('counts nothing for an adapter that does not declare reference emptiness, which rejects the constructs instead', async () => {
    const { run } = buildLocal({ queryFeatures: UNDECLARED });
    expect(failure(await run(query(...TEN, ELEVENTH)))).toEqual({
      code: 'UNSUPPORTED_QUERY', status: 400, message: `IS_EMPTY on shop ends at the reference shop: ${NOT_SUPPORTED}`,
    });
  });
});

// `_aggregate` calls take the same copy, marker and fill as lists, and a marked construct that middleware turns into
// another operator on an embedded object's own field is trusted, on the reference fixture.
describe('_aggregate calls and embedded own fields', () => {
  const AGGREGATION = 'aggregation: {groupId: "key", facts: [{operation: COUNT, factName: "n", path: "id"}]}';
  const byMethod = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  // The raw find scope arguments of the fixture's scopes under NE, as a filled marker holds them.
  const raw = (field, value) => ({ AND: [{ conditions: [{ field, operator: 'NE', value }] }] });
  const SHOP_SCOPE = raw('name', 'S2');
  const PRO_SCOPE = raw('name', 'P2');

  it.each([['declares', DECLARED], ['does not declare', UNDECLARED]])('keeps a middleware edit of a shared variable within an _aggregate call, beside another _aggregate or a list field, when the adapter %s reference emptiness', async (_label, queryFeatures) => {
    const notNone = () => ({ conditions: [{ field: 'name', operator: 'NE', value: 'none' }] });
    const variables = () => ({ f: { operator: 'NIN', value: ['none'] }, g: [{ ...notNone(), AND: [notNone()], OR: [notNone()] }] });
    const client = () => ({ name: variables().f, AND: variables().g });
    const filtersOf = (call) => ({ name: call.args.name, AND: call.args.AND.slice(0, 1) });
    const productAggregate = `qkProducts_aggregate(name: $f, AND: $g, ${AGGREGATION}) { groupId }`;
    const shopAggregate = `qkShops_aggregate(name: $f, AND: $g, ${AGGREGATION}) { groupId }`;
    // [what, query fields]: middleware edits the Product call's arguments, and the Shop call must read the client's.
    for (const [layout, fields] of [
      ['two _aggregate fields', [productAggregate, shopAggregate]],
      ['an _aggregate field, then a list field', [productAggregate, 'qkShops(name: $f, AND: $g) { key }']],
      ['a list field, then an _aggregate field', ['qkProducts(name: $f, AND: $g) { key }', shopAggregate]],
    ]) {
      for (const [what, edit] of [
        ['a field filter', ({ args }) => { args.name.operator = 'IN'; }],
        ['a value array, in place', ({ args }) => { args.name.value.push('S1'); }],
        ['a group condition', ({ args }) => { args.AND[0].conditions[0].value = 'S1'; }],
        ['a group, in place', ({ args }) => { args.AND[0].conditions.push({ field: 'name', operator: 'EQ', value: 'none' }); }],
        ['a nested AND group\'s condition', ({ args }) => { args.AND[0].AND[0].conditions[0].value = 'S1'; }],
        ['a nested OR group\'s condition', ({ args }) => { args.AND[0].OR[0].conditions[0].value = 'S1'; }],
      ]) {
        const { run, calls } = build({ queryFeatures });
        const result = await run(`query($f: QLFilter, $g: [QLFilterGroup]) { ${fields.join(' ')} }`, { middleware: onProduct(edit) }, variables());
        const label = `${layout}: ${what}`;
        expect(result.errors, label).toBeUndefined();
        const products = calls.find((call) => call.type === 'QkProduct');
        const shops = calls.find((call) => call.type === 'QkShop');
        // The edit reached the Product call, and the Shop call reads the variables as the client sent them.
        expect(filtersOf(products), label).not.toEqual(client());
        expect(filtersOf(shops), label).toEqual(client());
        expect(shops.rows, label).toEqual(['S1', 'S2', 'S3']);
      }
    }
  });

  it('marks and fills its own copy, in each call, of a term or condition variable that two _aggregate fields, or an _aggregate and a list field in either order, share', async () => {
    const { run, calls } = build();
    const shop = scoped('shop', 'IS_EMPTY', { shop: SHOP_NE });
    const proShop = scoped('pro.shop', 'IS_EMPTY', { pro: PRO_NE, 'pro.shop': SHOP_NE });
    const aggregate = (alias, args) => [`${alias}: qkProducts_aggregate(${args}, ${AGGREGATION}) { groupId }`, 'aggregate'];
    const list = (alias, args) => [`${alias}: qkProducts(${args}) { key }`, 'find'];
    for (const [variable, declared, args, variables, rows, where] of [
      ['a term variable', '$t: QLTypeFilterExpression', 'shop: $t', { t: { terms: [{ operator: 'IS_EMPTY' }] } }, ['C', 'c'], shop],
      ['a condition variable', '$c: QLFilterCondition', 'AND: [{conditions: [$c]}]', { c: { field: 'pro', path: 'shop', operator: 'IS_EMPTY' } }, ['C', 'D', 'E', 'c'], proShop],
    ]) {
      for (const [layout, fields] of [
        ['two _aggregate fields', [aggregate('a', args), aggregate('b', args)]],
        ['an _aggregate field, then a list field', [aggregate('a', args), list('b', args)]],
        ['a list field, then an _aggregate field', [list('a', args), aggregate('b', args)]],
      ]) {
        const label = `${variable}, ${layout}`;
        calls.length = 0;
        const result = await run(`query(${declared}) { ${fields.map(([field]) => field).join(' ')} }`, { shape: 'NE' }, structuredClone(variables));
        expect(result.errors, label).toBeUndefined();
        // Under NE, Shop's scope hides S2 and Pro's hides P2: each call reads them as missing.
        expect(calls.map((call) => [call.method, call.rows, call.plan.where]).sort(byMethod), label)
          .toEqual(fields.map(([, method]) => [method, rows, where]).sort(byMethod));
      }
    }
    // One term variable under two references of one _aggregate field: each place gets its own marker, filled with its
    // own target's scope.
    calls.length = 0;
    const twice = await run(`query($t: QLTypeFilterExpression) { qkProducts_aggregate(shop: $t, pro: $t, ${AGGREGATION}) { groupId } }`, { shape: 'NE' }, {
      t: { terms: [{ operator: 'IS_EMPTY' }] },
    });
    expect(twice.errors).toBeUndefined();
    const [call] = calls;
    expect(call.rows).toEqual(['c']);
    expect([call.args.shop.terms[0].__scope, call.args.pro.terms[0].__scope]).toEqual([{ id: 0, scopes: { shop: SHOP_SCOPE } }, { id: 1, scopes: { pro: PRO_SCOPE } }]);
  });

  it('fills an _aggregate call\'s markers from each target\'s find scope, never its aggregate scope, with the rows and scopes of the list call', async () => {
    const { run, calls } = build();
    // Under NE, Shop's and Review's aggregate scopes also hide every record, while their find scopes hide S2 and the
    // reviews by "hidden" only. Read through the aggregate scopes, every product would have no shop and no reviews.
    const hideAll = ({ args }) => appendAnd(args, [{ conditions: [{ field: 'key', operator: 'EQ', value: 'none' }] }]);
    const scopes = { shop: { aggregate: hideAll }, review: { aggregate: hideAll } };
    // The two scopes do differ: the Shop and Review roots' own _aggregate calls read nothing, and their lists read what
    // the find scopes admit.
    const roots = await run(`{ qkShops_aggregate(${AGGREGATION}) { groupId } qkReviews_aggregate(${AGGREGATION}) { groupId } qkShops { key } qkReviews { key } }`, { shape: 'NE', scopes });
    expect(roots.errors).toBeUndefined();
    expect(calls.map((call) => `${call.type} ${call.method} ${call.rows.join(',')}`).sort()).toEqual([
      'QkReview aggregate ', 'QkReview find D:1:x,E:5:x,Ka:5:x', 'QkShop aggregate ', 'QkShop find S1,S3',
    ]);
    for (const [path, typeKey, target, targetScope] of [
      ['shop', 'shop', SHOP_NE, SHOP_SCOPE],
      ['reviews', 'review', predicate('author', 'NE', 'hidden'), raw('author', 'hidden')],
    ]) {
      const item = REFERENCE_CASES.find((entry) => entry.name === `${path} IS_EMPTY`);
      const rows = expectedReferenceRows(item, 'NE');
      expect(rows, path).toEqual(['C', 'c']);
      for (const [form, args, markerOf] of [
        ['a term', `${path}: {terms: [{operator: IS_EMPTY}]}`, (callArgs) => callArgs[path].terms[0].__scope],
        ['a group condition', `AND: [{conditions: [{field: "${path}", operator: IS_EMPTY}]}]`, (callArgs) => callArgs.AND[0].conditions[0].__scope],
      ]) {
        const label = `${path} IS_EMPTY as ${form}`;
        const read = async (field, operation) => {
          calls.length = 0;
          const ran = [];
          const result = await run(`{ ${field} }`, { shape: 'NE', scopes, ran }, undefined);
          expect(result.errors, `${label} ${operation}`).toBeUndefined();
          expect(ran, `${label} ${operation}`).toEqual([`middleware QkProduct ${operation}`, `scope product ${operation}`, `scope ${typeKey} find`]);
          const [call] = calls;
          return { rows: call.rows, marker: markerOf(call.args), where: call.plan.where };
        };
        const listed = await read(`qkProducts(${args}) { key }`, 'find');
        const aggregated = await read(`qkProducts_aggregate(${args}, ${AGGREGATION}) { groupId }`, 'aggregate');
        expect(listed, label).toEqual({ rows, marker: { id: 0, scopes: { [path]: targetScope } }, where: scoped(path, 'IS_EMPTY', { [path]: target }) });
        expect(aggregated, label).toEqual(listed);
      }
    }
  });

  it('trusts another operator that middleware puts on a marked construct when its path reads an embedded object\'s own field, and fails one through an embedded object\'s reference with DETACHED_CLIENT_FILTER', async () => {
    const { run, calls, keysOf } = build();
    // The client's `shop.state IS_EMPTY` is marked; middleware turns it into another condition.
    const source = '{ qkProducts(AND: [{conditions: [{field: "shop", path: "state", operator: IS_EMPTY}]}]) { key } }';
    const turn = (edit) => onProduct(({ args }) => { Object.assign(args.AND[0].conditions[0], edit); });
    for (const [edit, rows] of [
      [{ field: 'odim', path: 'w', operator: 'EQ', value: 1 }, ['Ka']],
      [{ field: 'olines', path: 'qty', operator: 'EQ', value: 9 }, ['Ka']],
    ]) {
      const label = `${edit.field}.${edit.path}`;
      calls.length = 0;
      const result = await run(source, { shape: 'NE', middleware: turn(edit) });
      expect(result.errors, label).toBeUndefined();
      expect(keysOf(result, 'qkProducts'), label).toEqual(rows);
      const [call] = calls;
      expect(call.plan.where, label).toEqual(predicate(label, 'EQ', edit.value));
      expect(Object.hasOwn(call.args.AND[0].conditions[0], '__scope'), label).toBe(false);
    }
    calls.length = 0;
    const through = await run(source, { shape: 'NE', middleware: turn({ field: 'odim', path: 'shop.name', operator: 'EQ', value: 'S1' }) });
    expect(failure(through)).toEqual(detached('The client\'s IS_EMPTY condition on shop.state now uses EQ on odim.shop.name, which reads through odim.shop without its scope'));
    expect(calls).toEqual([]);
  });
});
