// The emptiness operators IS_EMPTY and IS_NOT_EMPTY (#108, part 2a) on both backends. The cases of
// tests/helpers/query-emptiness.js, written by the same generated mutations, return on MongoDB and on PostgreSQL the
// rows the cases expect, for every path of every root and both operators, as field filters, terms and group
// conditions; so do counted pages, aggregates, collection fields read one parent at a time and batched, and conditions
// on the record's own fields that scopes and middleware add. The roots include an inferred inverse reference, which
// takes the null rule. Every rejection gets the same code on both backends, and the same message wherever the runtime
// gate writes it.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GraphQLID, graphql } from 'graphql';
import mongoose from 'mongoose';
import pg from 'pg';
import { createRuntime, describeModels } from '../../packages/core/src/index.js';
import { createMongoAdapter } from '../../packages/mongodb/src/mongo/adapter.js';
import { createPostgres, postgresPlugin } from '../../packages/postgres/src/index.js';
import { createSQL } from '../../packages/sql/src/index.js';
import {
  EMPTINESS_CASES, EMPTINESS_INVERSE_CASES, createEmptinessTypes, emptinessArgs, emptinessArgumentType,
  expectedEmptinessKeys, registerEmptinessTypes, seedEmptiness,
} from '../helpers/query-emptiness.js';

const mongoUri = process.env.SIMFINITY_MONGODB_URI;
const postgresUri = process.env.SIMFINITY_POSTGRES_URI;
const OPERATORS = ['IS_EMPTY', 'IS_NOT_EMPTY'];
const IS_EMPTY = { operator: 'IS_EMPTY' };
const LATER = 'emptiness through references and collections arrives with reference emptiness (#108)';
const IN_LIST = 'emptiness of a value inside a list is not defined';
const ITEM_CASES = EMPTINESS_CASES.filter((item) => item.root === 'item');
// Every case, with those of the inferred inverse reference Card.ownerId.
const CASES = [...EMPTINESS_CASES, ...EMPTINESS_INVERSE_CASES];
const ROOTS = ['item', 'sid', 'card', ...EMPTINESS_CASES.filter((item) => item.root === 'owned').map((item) => `owned:${item.name}`)];
const SHOPS = ['S1', 'S2', 'S3'];
// Each item case belongs to S1 or S2, in turn; S3 has no items.
const shopOf = (index) => SHOPS[index % 2];
const BY_KEY = 'sort:{terms:[{field:"key",order:ASC}]}';
const COUNT_BY_KEY = 'aggregation:{groupId:"key",facts:[{operation:COUNT,factName:"n",path:"id"}]}';
const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
const lowerFirst = (value) => value.charAt(0).toLowerCase() + value.slice(1);
const intersection = (lists) => lists.reduce((kept, keys) => kept.filter((key) => keys.includes(key)));
const isItem = (params, operation) => params.type.gqltype.name.endsWith('Item') && params.operation === operation;
const condition = (field, path, extra = {}) => ({ AND: [{ conditions: [{ field, ...(path === undefined ? {} : { path }), ...IS_EMPTY, ...extra }] }] });
const nested = (item, depth) => {
  let group = { conditions: [item] };
  for (let level = 0; level < depth; level += 1) group = { AND: [group] };
  return { AND: [group] };
};

// Middleware and scopes do what the request context asks: `context.middleware(params)` on every operation, and
// `context.scopes[name](args)` in Item's find, aggregate and get_by_id scopes and in Shop's find scope ('shop').
const scopeOf = (name) => ({ args, context }) => { context?.scopes?.[name]?.(args); };
const SCOPES = {
  item: { find: scopeOf('find'), aggregate: scopeOf('aggregate'), get_by_id: scopeOf('get_by_id') },
  shop: { find: scopeOf('shop') },
};

// A query whose field `field` receives each argument of `args` as a variable typed for the root, plus `extra`;
// `wrap` places that field in the query, as a collection field for instance.
const operation = (types, rootKey, args, { field = types.roots[rootKey].plural, extra = [BY_KEY], selection = 'key', wrap = (inner) => inner } = {}) => {
  const names = Object.keys(args);
  const declared = names.map((name) => `$${name}:${emptinessArgumentType(types, rootKey, name)}`).join(',');
  const passed = [...names.map((name) => `${name}:$${name}`), ...extra].join(',');
  return { source: `query${declared ? `(${declared})` : ''}{${wrap(`${field}${passed ? `(${passed})` : ''}{${selection}}`)}}`, variables: args };
};
const aggregateOperation = (types, rootKey, args) => operation(types, rootKey, args, {
  field: `${types.roots[rootKey].plural}_aggregate`, extra: [COUNT_BY_KEY], selection: 'groupId facts',
});
// The items of each shop, filtered by `args`.
const shopsOperation = (types, args) => operation(types, 'item', args, {
  field: 'items', wrap: (inner) => `${lowerFirst(types.Shop.name)}s(${BY_KEY}){key ${inner}}`,
});
// The rows of `items(<path> <operator>)` under each shop, as the cases expect, keeping only the items `keep` accepts.
const shopRows = (path, operator, keep = () => true) => SHOPS.map((shop) => ({
  key: shop,
  items: ITEM_CASES.filter((item, index) => shopOf(index) === shop && item.expectEmpty[path] === (operator === 'IS_EMPTY') && keep(item.name))
    .map((item) => ({ key: item.name })).sort(byKey),
}));
const expected = (rootKey, path, operator) => expectedEmptinessKeys(rootKey, path, operator, CASES);
// The first error of a failed operation.
class Failure {
  constructor({ message, extensions = {} }) {
    this.code = extensions.code;
    this.status = extensions.status;
    this.message = message;
  }
}

// What clients can send, by the rule of the order of checks that rejects it: [args, code, status, wording?], where
// `wording` is part of the message the spec gives.
const CLIENT_REJECTIONS = [
  // Rule 0: a client path through a virtual field.
  [{ ghost: { terms: [{ path: 'label', ...IS_EMPTY }] } }, 'FORBIDDEN_FILTER_PATH', 403],
  [condition('ghost', 'label'), 'FORBIDDEN_FILTER_PATH', 403],
  // Rule 1: form, syntax, fields and depth.
  [condition('outer.inner', 'z'), 'AMBIGUOUS_FILTER_FIELD', 400],
  [condition('nope'), 'INVALID_FILTER_FIELD', 400], [{ dims: { terms: [{ path: 'nope', ...IS_EMPTY }] } }, 'INVALID_FILTER_FIELD', 400],
  [condition('note', 'x'), 'INVALID_FILTER_PATH', 400], [{ shop: { terms: [{ path: 'name.x', ...IS_EMPTY }] } }, 'INVALID_FILTER_PATH', 400],
  [{ dims: { terms: [{ path: 'w-x', ...IS_EMPTY }] } }, 'INVALID_FILTER_PATH', 400], [condition('dims.'), 'INVALID_FILTER_PATH', 400],
  [nested({ field: 'shop', path: 'name', ...IS_EMPTY }, 6), 'FILTER_DEPTH_EXCEEDED', 400],
  [nested({ field: 'lines', path: 'qty', ...IS_EMPTY }, 6), 'FILTER_DEPTH_EXCEEDED', 400],
  // Rule 3: a value inside a list or a collection.
  [{ lines: { terms: [{ path: 'qty', ...IS_EMPTY }] } }, 'INVALID_FILTER_PATH', 400, IN_LIST],
  [{ olines: { terms: [{ path: 'qty', operator: 'IS_NOT_EMPTY' }] } }, 'INVALID_FILTER_PATH', 400, IN_LIST],
  [condition('reviews', 'text'), 'INVALID_FILTER_PATH', 400, IN_LIST],
  [condition('lines.qty', undefined, { value: 1 }), 'INVALID_FILTER_PATH', 400, IN_LIST],
  // Rule 5: a value, before rule 6.
  [{ note: { ...IS_EMPTY, value: '' } }, 'INVALID_FILTER_VALUE', 400], [{ tags: { operator: 'IS_NOT_EMPTY', value: [] } }, 'INVALID_FILTER_VALUE', 400],
  [{ dims: { terms: [{ ...IS_EMPTY, value: {} }] } }, 'INVALID_FILTER_VALUE', 400], [condition('count', undefined, { value: 0 }), 'INVALID_FILTER_VALUE', 400],
  [condition('plain', 'a', { value: false }), 'INVALID_FILTER_VALUE', 400], [{ odim: { terms: [{ ...IS_EMPTY, value: 'x' }] } }, 'INVALID_FILTER_VALUE', 400],
  // Rule 6: references and collections, crossed, reached, or members.
  [{ shop: { terms: [IS_EMPTY] } }, 'UNSUPPORTED_QUERY', 400, LATER], [condition('shop', 'name'), 'UNSUPPORTED_QUERY', 400, LATER],
  [{ reviews: { terms: [{ operator: 'IS_NOT_EMPTY' }] } }, 'UNSUPPORTED_QUERY', 400, LATER], [{ odim: { terms: [IS_EMPTY] } }, 'UNSUPPORTED_QUERY', 400, LATER],
  [{ odim: { terms: [{ path: 'shop', ...IS_EMPTY }] } }, 'UNSUPPORTED_QUERY', 400, LATER], [condition('odim.shop.name'), 'UNSUPPORTED_QUERY', 400, LATER],
  [nested({ field: 'shop', path: 'name', ...IS_EMPTY }, 5), 'UNSUPPORTED_QUERY', 400, LATER],
];
// What only middleware and scopes can write, and what they add that 2a cannot answer.
const TRUSTED_REJECTIONS = [
  // An emptiness operator on an object filter without terms, or beside its terms, with a message that points to the
  // term without a path.
  [{ dims: IS_EMPTY }, 'MISSING_FILTER_PATH', 400, 'Filter on dims takes IS_EMPTY only in a term; to test the field itself, use a term without a path: dims: { terms: [{ operator: IS_EMPTY }] }'],
  [{ odim: { operator: 'IS_NOT_EMPTY', terms: [{ path: 'w', operator: 'EQ', value: 1 }] } }, 'MISSING_FILTER_PATH', 400, 'use a term without a path: odim: { terms: [{ operator: IS_NOT_EMPTY }] }'],
  [{ lines: { operator: 'IS_EMPTY', terms: [] } }, 'MISSING_FILTER_PATH', 400],
  [{ reviews: IS_EMPTY }, 'MISSING_FILTER_PATH', 400],
  // A path through a virtual field that trusted code adds is a broken model.
  [condition('ghost', 'label'), 'INVALID_MODEL', 500],
  [condition('shop', 'name'), 'UNSUPPORTED_QUERY', 400, LATER],
  [{ lines: { terms: [{ path: 'qty', ...IS_EMPTY }] } }, 'INVALID_FILTER_PATH', 400, IN_LIST],
  [{ note: { operator: 'IS_NOT_EMPTY', value: 'x' } }, 'INVALID_FILTER_VALUE', 400],
];
// The arguments of a collection field leave out its connection field, Shop.items that of `shop`.
const throughShop = ([args]) => Object.hasOwn(args, 'shop');

describe.skipIf(!mongoUri || !postgresUri)('MongoDB/PostgreSQL emptiness parity', () => {
  const namespace = `qy_parity_${randomUUID().replaceAll('-', '')}`;
  const statements = [];
  const commands = [];
  let pool;
  // By backend name: `plain` reads collection fields one parent at a time, `batched` in batches, and `legacy`
  // declares no operator beyond those of 3.7.0.
  let backends;

  const execute = (runtime, source, variableValues, contextValue = {}) => graphql({ schema: runtime.schema, source, variableValues, contextValue });
  // The data of an operation, or a Failure with its first error.
  const outcome = async (runtime, { source, variables }, contextValue) => {
    const result = await execute(runtime, source, variables, contextValue);
    return result.errors ? new Failure(result.errors[0]) : Object.values(result.data)[0];
  };
  // The same operation on every backend's `kind` runtime, by backend name. `build` receives that runtime's types, and
  // `context` the backend name, so that each request gets a fresh context.
  const both = async (kind, build, context = () => ({})) => Object.fromEntries(await Promise.all(Object.entries(backends)
    .map(async ([name, runtimes]) => [name, await outcome(runtimes[kind], build(runtimes[kind].types), context(name))])));
  const alike = (value) => Object.fromEntries(Object.keys(backends).map((name) => [name, value]));
  // Maps each backend's data, and keeps its Failure.
  const each = (found, map) => Object.fromEntries(Object.entries(found).map(([name, data]) => [name, data instanceof Failure ? data : map(data)]));
  // The keys a list operation returns, by backend name.
  const keys = async (rootKey, args, context, kind = 'plain') => each(await both(kind, (types) => operation(types, rootKey, args), context), (rows) => rows.map((row) => row.key));
  // The paths both backends accept on a root: MongoDB alone stores `meta`.
  const pathsOf = (rootKey) => Object.values(backends).map((runtimes) => runtimes.plain.types.roots[rootKey].paths)
    .reduce((kept, paths) => kept.filter((path) => paths.includes(path)));
  const argsOf = (rootKey, path, operator, form) => emptinessArgs(backends.postgres.plain.types, rootKey, path, operator, form);
  const expectRejection = (found, [, code, status, wording], label) => {
    expect(each(found, () => 'no error').mongodb, label).toEqual(each(found, () => 'no error').postgres);
    expect([found.mongodb.code, found.mongodb.status], label).toEqual([code, status]);
    if (wording) expect(found.mongodb.message, label).toContain(wording);
  };

  // One runtime with the emptiness types, the context-driven middleware and scopes, its schema and its storage.
  const runtimeOf = async (name, api, prefix, { initialize = true } = {}) => {
    const types = createEmptinessTypes(prefix, { backend: name, scopes: SCOPES, inverse: true });
    api.use((params, next) => { params.context?.middleware?.(params); return next(); });
    if (!api.initializeDatabase) api.preventCreatingCollection(true);
    registerEmptinessTypes(api, types);
    const runtime = { name, api, types, schema: api.createSchema() };
    if (!initialize) return runtime;
    if (api.initializeDatabase) await api.initializeDatabase();
    else for (const { model } of api.getRegistrations()) if (model) await model.createCollection();
    return runtime;
  };
  // Seeds the cases through the generated mutations, adds the shops, and gives each item case its shop through the
  // generated update mutation, which changes nothing else.
  const seed = async (runtime, cases) => {
    const run = async (source, input) => {
      const result = await execute(runtime, source, { input });
      if (result.errors) throw new Error(`${runtime.name} ${source}: ${JSON.stringify(result.errors)}`);
      return Object.values(result.data)[0];
    };
    runtime.records = await seedEmptiness((source, variables) => execute(runtime, source, variables), runtime.types, cases);
    const shop = runtime.types.Shop.name;
    const { single, type } = runtime.types.roots.item;
    const shops = {};
    for (const key of SHOPS) shops[key] = (await run(`mutation($input:${shop}Input!){add${lowerFirst(shop)}(input:$input){id}}`, { key })).id;
    for (const [index, item] of ITEM_CASES.entries()) {
      await run(`mutation($input:${type.name}InputForUpdate!){update${single}(input:$input){id}}`, { id: runtime.records[item.name].id, shop: { id: shops[shopOf(index)] } });
    }
  };

  beforeAll(async () => {
    await mongoose.connect(mongoUri, { dbName: namespace, monitorCommands: true });
    mongoose.connection.getClient().on('commandStarted', (event) => {
      if (event.commandName === 'aggregate') commands.push(event.command);
    });
    pool = new pg.Pool({ connectionString: postgresUri });
    // Records the text of every statement the batched PostgreSQL runtime runs.
    const recording = {
      query: (text, values) => { statements.push(text); return pool.query(text, values); },
      connect: async () => {
        const client = await pool.connect();
        return { query: (text, values) => { statements.push(text); return client.query(text, values); }, release: (error) => client.release(error) };
      },
    };
    backends = {
      mongodb: {
        plain: await runtimeOf('mongodb', createRuntime(createMongoAdapter()), 'Qy'),
        batched: await runtimeOf('mongodb', createRuntime(createMongoAdapter({ batchedCollections: true, collectionBatchSize: 2 })), 'Qyb'),
        legacy: await runtimeOf('mongodb', createRuntime({ ...createMongoAdapter(), queryFeatures: undefined }), 'Qyl', { initialize: false }),
      },
      postgres: {
        plain: await runtimeOf('postgres', createPostgres({ pool, schema: namespace }), 'Qy'),
        batched: await runtimeOf('postgres', createPostgres({ pool: recording, schema: `${namespace}_b`, batchedCollections: true }), 'Qyb'),
        legacy: await runtimeOf('postgres', createSQL({ plugin: { ...postgresPlugin({ pool, schema: `${namespace}_l` }), queryFeatures: undefined } }), 'Qyl', { initialize: false }),
      },
    };
    for (const runtimes of Object.values(backends)) {
      await seed(runtimes.plain, CASES);
      await seed(runtimes.batched, [...ITEM_CASES, ...EMPTINESS_INVERSE_CASES]);
    }
  }, 120000);
  afterAll(async () => {
    if (mongoose.connection.readyState) {
      // Generated models build their indexes in the background; let them finish, so that none recreates a collection.
      await Promise.allSettled(mongoose.modelNames().map((name) => mongoose.model(name).init()));
      await mongoose.connection.db.dropDatabase();
      await mongoose.disconnect();
    }
    if (pool) {
      for (const schema of [namespace, `${namespace}_b`, `${namespace}_l`]) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });

  it.each(ROOTS)('returns the rows every case expects on both backends, for every path of %s, as field filters, terms and group conditions', async (rootKey) => {
    const all = await keys(rootKey, {});
    expect(all.mongodb.length).toBeGreaterThan(0);
    for (const path of pathsOf(rootKey)) {
      for (const operator of OPERATORS) {
        const rows = alike(expected(rootKey, path, operator));
        expect(await keys(rootKey, argsOf(rootKey, path, operator)), `${path} ${operator}`).toEqual(rows);
        expect(await keys(rootKey, argsOf(rootKey, path, operator, 'condition')), `${path} ${operator} condition`).toEqual(rows);
        // A group condition with the dotted path as its field.
        expect(await keys(rootKey, { OR: [{ conditions: [{ field: path, operator }] }] }), `${path} ${operator} dotted`).toEqual(rows);
      }
      // Every record matches exactly one of the two operators.
      expect(alike([...expected(rootKey, path, 'IS_EMPTY'), ...expected(rootKey, path, 'IS_NOT_EMPTY')].sort()), path).toEqual(all);
    }
  }, 60000);

  it('counts the records of every path before paging, alike', async () => {
    for (const rootKey of ROOTS) {
      for (const path of pathsOf(rootKey)) {
        for (const operator of OPERATORS) {
          const contexts = {};
          const found = await both('plain', (types) => operation(types, rootKey, emptinessArgs(types, rootKey, path, operator), {
            extra: [BY_KEY, 'pagination:{page:1,size:2,count:true}'],
          }), (name) => { contexts[name] = {}; return contexts[name]; });
          const rows = expected(rootKey, path, operator);
          expect(each(found, (data) => ({ rows: data.map((row) => row.key) })), `${rootKey} ${path} ${operator}`).toEqual(alike({ rows: rows.slice(0, 2) }));
          expect(each(contexts, (context) => context.count), `${rootKey} ${path} ${operator}`).toEqual(alike(rows.length));
        }
      }
    }
  }, 60000);

  it('groups the records of every path in aggregates, alike', async () => {
    for (const rootKey of ROOTS) {
      for (const path of pathsOf(rootKey)) {
        for (const operator of OPERATORS) {
          for (const form of ['field', 'condition']) {
            const found = await both('plain', (types) => aggregateOperation(types, rootKey, emptinessArgs(types, rootKey, path, operator, form)));
            expect(each(found, (groups) => [...groups].sort((a, b) => (a.groupId < b.groupId ? -1 : 1))), `${rootKey} ${path} ${operator} ${form}`)
              .toEqual(alike(expected(rootKey, path, operator).map((key) => ({ groupId: key, facts: { n: 1 } }))));
          }
        }
      }
    }
  }, 60000);

  it.each(['plain', 'batched'])('filters collection fields by every path alike, %s', async (kind) => {
    for (const path of pathsOf('item')) {
      for (const operator of OPERATORS) {
        for (const form of ['field', 'condition']) {
          const found = await both(kind, (types) => shopsOperation(types, emptinessArgs(types, 'item', path, operator, form)));
          expect(found, `${path} ${operator} ${form}`).toEqual(alike(shopRows(path, operator)));
        }
      }
    }
  }, 60000);

  it('reads the collection fields of the batched runtimes in batches, and those of the others one parent at a time', async () => {
    const read = async (kind) => {
      statements.length = 0;
      commands.length = 0;
      expect(await both(kind, (types) => shopsOperation(types, { note: IS_EMPTY })), kind).toEqual(alike(shopRows('note', 'IS_EMPTY')));
      const runtime = backends.mongodb[kind];
      const collection = runtime.api.getModel(runtime.types.Item).collection.collectionName;
      return {
        mongodb: commands.filter((command) => command.aggregate === collection).map((command) => command.pipeline.some((stage) => stage.$unionWith)),
        postgres: statements.filter((text) => text.includes(' UNION ALL ') && text.includes('"__simfinity_parent"')).length,
      };
    };
    // Three shops in batches of two on MongoDB: one command with a $unionWith stage and one without. One UNION ALL
    // statement on PostgreSQL, whose plain runtime does not record its statements.
    expect(await read('batched')).toEqual({ mongodb: [true, false], postgres: 1 });
    expect(await read('plain')).toEqual({ mongodb: [false, false, false], postgres: 0 });
  });

  it('applies the conditions on the record\'s own fields that middleware and scopes add to lists, counts, aggregates and reads by id, alike', async () => {
    // Middleware adds a field filter; the find scope adds a group condition.
    const noteDims = intersection([expected('item', 'note', 'IS_EMPTY'), expected('item', 'dims', 'IS_NOT_EMPTY')]);
    const outerTags = intersection([expected('item', 'outer', 'IS_EMPTY'), expected('item', 'tags', 'IS_NOT_EMPTY')]);
    for (const rows of [noteDims, outerTags]) expect(rows.length).toBeGreaterThan(1);
    const addNote = (params) => { if (isItem(params, 'find')) params.args.note = IS_EMPTY; };
    expect(await keys('item', { dims: { terms: [{ operator: 'IS_NOT_EMPTY' }] } }, () => ({ middleware: addNote }))).toEqual(alike(noteDims));
    const addOuter = (args) => { args.AND = [...(args.AND ?? []), { conditions: [{ field: 'outer', ...IS_EMPTY }] }]; };
    expect(await keys('item', { tags: { operator: 'IS_NOT_EMPTY' } }, () => ({ scopes: { find: addOuter } }))).toEqual(alike(outerTags));
    // A term without a path that middleware adds, on a counted page.
    const kindOlines = intersection([expected('item', 'kind', 'IS_NOT_EMPTY'), expected('item', 'olines', 'IS_NOT_EMPTY')]);
    expect(kindOlines.length).toBeGreaterThan(1);
    const contexts = {};
    const page = await both('plain', (types) => operation(types, 'item', { kind: { operator: 'IS_NOT_EMPTY' } }, { extra: [BY_KEY, 'pagination:{page:1,size:1,count:true}'] }), (name) => {
      contexts[name] = { middleware: (params) => { if (isItem(params, 'find')) params.args.olines = { terms: [{ operator: 'IS_NOT_EMPTY' }] }; } };
      return contexts[name];
    });
    expect(page).toEqual(alike([{ key: kindOlines[0] }]));
    expect(each(contexts, (context) => context.count)).toEqual(alike(kindOlines.length));
    // The aggregate scope.
    const notePlain = intersection([expected('item', 'note', 'IS_NOT_EMPTY'), expected('item', 'plain', 'IS_NOT_EMPTY')]);
    expect(notePlain.length).toBeGreaterThan(1);
    const grouped = await both('plain', (types) => aggregateOperation(types, 'item', { plain: { terms: [{ operator: 'IS_NOT_EMPTY' }] } }), () => ({
      scopes: { aggregate: (args) => { args.note = { operator: 'IS_NOT_EMPTY' }; } },
    }));
    expect(each(grouped, (groups) => groups.map((group) => group.groupId).sort())).toEqual(alike(notePlain));
    // The get_by_id scope: each record is read only when its condition holds.
    const byId = {};
    for (const [name, { plain }] of Object.entries(backends)) {
      byId[name] = {};
      for (const item of ITEM_CASES) {
        const found = await outcome(plain, { source: `query($id:ID!){${plain.types.roots.item.single}(id:$id){key}}`, variables: { id: plain.records[item.name].id } }, {
          scopes: { get_by_id: (args) => { args.dims = { terms: [IS_EMPTY] }; } },
        });
        byId[name][item.name] = found?.key ?? found;
      }
    }
    expect(byId).toEqual(alike(Object.fromEntries(ITEM_CASES.map((item) => [item.name, item.expectEmpty.dims ? item.name : null]))));
  });

  it.each(['plain', 'batched'])('applies the conditions that the find scope and middleware add to collection fields alike, %s', async (kind) => {
    const noteEmpty = expected('item', 'note', 'IS_EMPTY');
    const scoped = await both(kind, (types) => shopsOperation(types, { dims: { terms: [{ operator: 'IS_NOT_EMPTY' }] } }), () => ({
      scopes: { find: (args) => { args.note = IS_EMPTY; } },
    }));
    expect(scoped).toEqual(alike(shopRows('dims', 'IS_NOT_EMPTY', (key) => noteEmpty.includes(key))));
    const linesNotEmpty = expected('item', 'lines', 'IS_NOT_EMPTY');
    const added = await both(kind, (types) => shopsOperation(types, { tags: IS_EMPTY }), () => ({
      middleware: (params) => { if (isItem(params, 'find')) params.args.AND = [{ conditions: [{ field: 'lines', operator: 'IS_NOT_EMPTY' }] }]; },
    }));
    expect(added).toEqual(alike(shopRows('tags', 'IS_EMPTY', (key) => linesNotEmpty.includes(key))));
    // Both restrict the rows.
    for (const [path, operator, rows] of [['dims', 'IS_NOT_EMPTY', scoped], ['tags', 'IS_EMPTY', added]]) {
      expect(rows.mongodb.flatMap((shop) => shop.items).length).toBeLessThan(shopRows(path, operator).flatMap((shop) => shop.items).length);
    }
  });

  it('never finds a record identity declared String empty, and finds every record with IS_NOT_EMPTY, with no error', async () => {
    const all = EMPTINESS_CASES.filter((item) => item.root === 'sid').map((item) => item.name).sort();
    expect(all.length).toBeGreaterThan(1);
    expect(backends.postgres.plain.types.Sid.getFields().id.type.toString()).toBe('String');
    for (const form of ['field', 'condition']) {
      expect(await keys('sid', argsOf('sid', 'id', 'IS_EMPTY', form)), form).toEqual(alike([]));
      expect(await keys('sid', argsOf('sid', 'id', 'IS_NOT_EMPTY', form)), form).toEqual(alike(all));
    }
    expect(await both('plain', (types) => aggregateOperation(types, 'sid', argsOf('sid', 'id', 'IS_EMPTY')))).toEqual(alike([]));
  });

  it('reads the inferred inverse reference Card.ownerId as an ID with the null rule, and compiles it to a null test, on both backends', async () => {
    // Owner.cards names Card's plain ID as its connectionField, which describeModels infers as a reference to Owner;
    // rule 6 rejects declared references only.
    const { types, api } = backends.postgres.plain;
    expect(types.Card.getFields().ownerId.type).toBe(GraphQLID);
    const card = describeModels(api.getRegistrations()).entities.find((entity) => entity.name === types.Card.name);
    expect(card.fields.find((field) => field.name === 'ownerId')).toMatchObject({ kind: 'reference', inferred: true, target: types.Owner.name, scalar: 'ID' });
    const withOwner = ['card create owner', 'card update owner'];
    expect(expected('card', 'ownerId', 'IS_EMPTY')).toEqual(['card create null', 'card create omitted', 'card update null']);
    expect(expected('card', 'ownerId', 'IS_NOT_EMPTY')).toEqual(withOwner);
    // The owner's cards are those whose ownerId holds it.
    const owners = await both('plain', (own) => ({ source: `{${lowerFirst(own.Owner.name)}s(${BY_KEY}){key cards(${BY_KEY}){key}}}`, variables: {} }));
    expect(owners).toEqual(alike([{ key: 'owner', cards: withOwner.map((key) => ({ key })) }]));
    // The forms, as a field filter and as a group condition: the null rule on the reference column on PostgreSQL.
    const collection = backends.mongodb.batched.api.getModel(backends.mongodb.batched.types.Card).collection.collectionName;
    const table = `"${namespace}_b"."${backends.postgres.batched.types.Card.name}"`;
    for (const [operator, match, where] of [
      ['IS_EMPTY', { ownerId: null }, 't0."ownerId" IS NULL'],
      ['IS_NOT_EMPTY', { ownerId: { $ne: null } }, 't0."ownerId" IS NOT NULL'],
    ]) {
      for (const form of ['field', 'condition']) {
        statements.length = 0;
        commands.length = 0;
        expect(await keys('card', argsOf('card', 'ownerId', operator, form), undefined, 'batched'), `${operator} ${form}`).toEqual(alike(expected('card', 'ownerId', operator)));
        expect({
          mongodb: commands.filter((command) => command.aggregate === collection).map((command) => command.pipeline),
          postgres: statements.filter((text) => text.includes(table)),
        }, `${operator} ${form}`).toEqual({
          mongodb: [[{ $match: match }, { $sort: { key: 1 } }, { $skip: 0 }, { $limit: 100 }]],
          postgres: [`SELECT t0.* FROM ${table} t0  WHERE (${where}) ORDER BY (t0."key") COLLATE "pg_catalog"."C" ASC LIMIT $1::bigint OFFSET $2::bigint`],
        });
      }
    }
  });

  it('finds { id: X } in an embedded type with an id member not empty, and an id member declared String empty only when it is ""', async () => {
    for (const [path, empty, notEmpty] of [
      ['ident', [], ['item update embedded id']], ['ident.id', [], ['item update embedded id']],
      ['sident', ['item update embedded id'], ['item update embedded String id']], ['sident.id', ['item update embedded id'], ['item update embedded String id']],
    ]) {
      const found = { IS_EMPTY: await keys('item', argsOf('item', path, 'IS_EMPTY')), IS_NOT_EMPTY: await keys('item', argsOf('item', path, 'IS_NOT_EMPTY')) };
      // The operators that return the record, on each backend.
      const on = (key) => Object.fromEntries(Object.keys(backends).map((name) => [name, OPERATORS.filter((operator) => Array.isArray(found[operator][name]) && found[operator][name].includes(key))]));
      for (const key of notEmpty) expect(on(key), `${path} ${key}`).toEqual(alike(['IS_NOT_EMPTY']));
      for (const key of empty) expect(on(key), `${path} ${key}`).toEqual(alike(['IS_EMPTY']));
    }
  });

  it('rejects what clients send with the same code and message on both backends, on lists, aggregates and collection fields read either way', async () => {
    for (const rejection of CLIENT_REJECTIONS) {
      const [args] = rejection;
      const label = JSON.stringify(args);
      expectRejection(await both('plain', (types) => operation(types, 'item', args)), rejection, label);
      expectRejection(await both('plain', (types) => aggregateOperation(types, 'item', args)), rejection, `aggregate ${label}`);
      if (throughShop(rejection)) continue;
      for (const kind of ['plain', 'batched']) expectRejection(await both(kind, (types) => shopsOperation(types, args)), rejection, `${kind} items ${label}`);
    }
  });

  it('rejects the forms only middleware and scopes write, and what they add that 2a cannot answer, with the same code and message on both backends', async () => {
    const middleware = (args) => () => ({ middleware: (params) => { if (isItem(params, 'find')) Object.assign(params.args, args); } });
    const scope = (args) => () => ({ scopes: { find: (scopeArgs) => { Object.assign(scopeArgs, args); } } });
    for (const rejection of TRUSTED_REJECTIONS) {
      const [args] = rejection;
      const label = JSON.stringify(args);
      for (const [writer, context] of [['middleware', middleware(args)], ['scope', scope(args)]]) {
        expectRejection(await both('plain', (types) => operation(types, 'item', {}), context), rejection, `${writer} ${label}`);
        for (const kind of ['plain', 'batched']) expectRejection(await both(kind, (types) => shopsOperation(types, {}), context), rejection, `${writer} ${kind} items ${label}`);
      }
    }
  });

  it('rejects a joined target find scope that uses an emptiness operator with the same message on both backends, naming the scope', async () => {
    const found = await both('plain', (types) => operation(types, 'item', { shop: { terms: [{ path: 'name', operator: 'EQ', value: 'S1' }] } }), () => ({
      scopes: { shop: (args) => { args.name = IS_EMPTY; } },
    }));
    expectRejection(found, [null, 'UNSUPPORTED_QUERY', 400], 'joined scope');
    expect(found.mongodb.message).toBe(`Query path shop enters QyShop, whose find scope tests shop.name with IS_EMPTY: ${LATER}; until then, use EQ null in the QyShop find scope`);
  });

  it('rejects the emptiness operators for an adapter or SQL plugin that does not declare them, alike', async () => {
    for (const path of ['note', 'tags', 'dims', 'dims.w', 'lines', 'olines', 'ghost', 'id']) {
      for (const operator of OPERATORS) {
        for (const form of ['field', 'condition']) {
          expectRejection(await both('legacy', (types) => operation(types, 'item', emptinessArgs(types, 'item', path, operator, form))), [null, 'UNSUPPORTED_QUERY', 400], `${path} ${operator} ${form}`);
        }
      }
    }
  });

  // #108 2.6: a filter path of another operator with more than one segment that ends at an object. These reach each
  // backend's compiler, which words its own message; the code is the contract.
  it('fails filter paths of more than one segment that end at an object with INVALID_FILTER_PATH on both backends', async () => {
    for (const args of [
      { AND: [{ conditions: [{ field: 'outer', path: 'inner', operator: 'EQ', value: 'x' }] }] },
      { outer: { terms: [{ path: 'inner', operator: 'EQ', value: 'x' }] } },
      { odim: { terms: [{ path: 'shop', operator: 'EQ', value: 'x' }] } },
      { shop: { terms: [{ path: 'items', operator: 'EQ', value: 'x' }] } },
    ]) {
      expect(each(await both('plain', (types) => operation(types, 'item', args)), () => 'no error'), JSON.stringify(args))
        .toEqual(alike(expect.objectContaining({ code: 'INVALID_FILTER_PATH', status: 400 })));
    }
  });

  it('fails a bare object field in a group condition with MISSING_FILTER_PATH on both backends (regression pin, passes on 3.9.0)', async () => {
    for (const field of ['dims', 'outer', 'odim', 'lines']) {
      expect(each(await both('plain', (types) => operation(types, 'item', { AND: [{ conditions: [{ field, operator: 'EQ', value: 'x' }] }] })), () => 'no error'), field)
        .toEqual(alike(expect.objectContaining({ code: 'MISSING_FILTER_PATH', status: 400 })));
    }
  });
});
