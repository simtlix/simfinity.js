// Reference and collection emptiness (#108, part 2b) on both backends, through GraphQL. The reference fixture of
// tests/helpers/query-emptiness.js, written by the same generated mutations, returns on MongoDB and on PostgreSQL the
// rows of every case for an admin and every scope shape: client constructs, as terms and group conditions, read a
// record that the target's find scope hides exactly like a missing one, and the same constructs from middleware and the
// root's own scope read stored data. So do the cases beside legacy branches, legacy conditions in the same group, sorts
// and trusted conditions, counted pages, aggregates (whose client constructs read the target's find scope, never its
// aggregate scope), and the collection field Shop.products read one parent at a time and batched. The String identity
// after a reference reads like the reference; the hop after a scoped crossing correlates to that scoped join; MongoDB's
// dangling reference and a collection member inside an embedded type of supplied models read as the definitions say;
// spread copies of both bundled adapters keep the declaration and receive filled markers; a nested group and a term
// shared by several query fields, _aggregate fields among them, and collection-field calls are marked and filled in
// each call; DETACHED_CLIENT_FILTER
// and UNSUPPORTED_QUERY come with the same code and message on both backends; and legacy conditions keep their 3.10.0
// rows.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GraphQLID, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, getNamedType, graphql, isObjectType,
} from 'graphql';
import mongoose from 'mongoose';
import pg from 'pg';
import { createRuntime } from '../../packages/core/src/index.js';
import { createMongoAdapter } from '../../packages/mongodb/src/mongo/adapter.js';
import { createPostgres, postgresPlugin } from '../../packages/postgres/src/index.js';
import { createSQLAdapter } from '../../packages/sql/src/adapter.js';
import { createSQL } from '../../packages/sql/src/index.js';
import {
  REFERENCE_CASES, REFERENCE_DATA, REFERENCE_SHAPES, createReferenceEmptinessTypes, emptinessArgumentType,
  expectedReferenceRows, referenceCaseArgs, registerReferenceEmptinessTypes, seedReferenceEmptiness,
  writeMongoDanglingReference,
} from '../helpers/query-emptiness.js';

const mongoUri = process.env.SIMFINITY_MONGODB_URI;
const postgresUri = process.env.SIMFINITY_POSTGRES_URI;
const OPERATORS = ['IS_EMPTY', 'IS_NOT_EMPTY'];
const NOT_SUPPORTED = 'the database adapter does not support emptiness through references and collections';
const TYPE_KEYS = ['shop', 'pro', 'product', 'review'];
const BY_KEY = 'sort:{terms:[{field:"key",order:ASC}]}';
const COUNT_BY_KEY = 'aggregation:{groupId:"key",facts:[{operation:COUNT,factName:"n",path:"id"}]}';
const PAGE_COUNT = 'pagination:{page:1,size:2,count:true}';
// A client construct comes as a term or a group condition; the same construct from trusted code comes from middleware
// (a term) or from the root's own find and aggregate scopes (a group condition).
const CLIENT_FORMS = ['field', 'condition'];
const TRUSTED_FORMS = ['middleware', 'scope'];
const ARGS_CASES = REFERENCE_CASES.filter((item) => item.args);
// The construct cases that read a reference or a collection: the path crosses or ends at one, or ends at an embedded
// object with one among its members. The others (odim.w) read the record's own fields, as they did on 3.10.0. The
// GraphQL types decide, so that every version collects the same tests.
const isRelation = (field) => field.extensions?.relation?.embedded === false;
const hasRelationMember = (type) => Object.values(type.getFields())
  .some((field) => isRelation(field) || (isObjectType(getNamedType(field.type)) && hasRelationMember(getNamedType(field.type))));
const readsRelations = (type, [head, ...rest]) => {
  const field = type.getFields()[head];
  const named = getNamedType(field.type);
  if (isRelation(field)) return true;
  return rest.length ? readsRelations(named, rest) : isObjectType(named) && hasRelationMember(named);
};
const CASE_TYPES = createReferenceEmptinessTypes('Qp');
const readsReferences = (item) => readsRelations(CASE_TYPES.roots[item.root].type, item.path.split('.'));
const RELATION_CASES = REFERENCE_CASES.filter((item) => item.path && readsReferences(item));
const OWN_FIELD_CASES = REFERENCE_CASES.filter((item) => item.path && !readsReferences(item));
// The cases that Shop.products can take: those that leave out its connection field, `shop`, as an argument and as a
// group condition's field.
const childCases = (cases) => cases.filter((item) => item.root === 'product' && (item.path
  ? item.path.split('.')[0] !== 'shop' : !Object.hasOwn(item.args, 'shop') && !JSON.stringify(item.args).includes('"field":"shop"')));
const byName = (name) => {
  const found = REFERENCE_CASES.find((item) => item.name === name);
  if (!found) throw new Error(`No reference emptiness case ${name}`);
  return found;
};
// Each product's stored shop, and the shops each shape's Shop scope lets the Shop root read: S2 is hidden under name NE
// "S2", S2 and S3 under state EQ "OPEN".
const SHOP_OF = Object.fromEntries(REFERENCE_DATA.product.map((product) => [product.key, product.shop ?? null]));
const SHOPS_READ = {
  admin: ['S1', 'S2', 'S3'], NE: ['S1', 'S3'], EQ: ['S1'], proOnly: ['S1', 'S2', 'S3'], shopNE: ['S1', 'S3'], shopEQ: ['S1'],
};
const byShop = (rows, shape) => SHOPS_READ[shape].map((shop) => ({ key: shop, products: rows.filter((key) => SHOP_OF[key] === shop).map((key) => ({ key })) }));
const byGroupId = (a, b) => (a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0);
const groupsOf = (rows) => rows.map((key) => ({ groupId: key, facts: { n: 1 } }));
// Appends trusted arguments to a scope's arguments: AND and OR groups after the others, any other argument as given.
const append = (args, extra) => {
  for (const [name, value] of Object.entries(extra)) {
    args[name] = ['AND', 'OR'].includes(name) ? [...(Array.isArray(args[name]) ? args[name] : []), ...value] : value;
  }
};

// Every entity's find and aggregate scopes call, after the shape's restriction, what the request context's `extra`
// holds for that type key and operation: `context.extra[typeKey][operation](params)`.
const HOOKS = Object.fromEntries(TYPE_KEYS.map((typeKey) => [typeKey, Object.fromEntries(['find', 'aggregate'].map((operation) => [
  operation, (params) => params.context?.extra?.[typeKey]?.[operation]?.(params),
]))]));

// The GraphQL type of a variable named `name` on a root.
const typeOf = (types, rootKey, name) => ({ sort: 'QLSortExpression', pagination: 'QLPagination' })[name] ?? emptinessArgumentType(types, rootKey, name);
// A query whose field receives each argument of `args` as a variable typed for the root, plus the literal arguments of
// `extra`; `wrap` places the field in the query, inside a collection field for instance.
const operationOf = (types, rootKey, args, {
  field = types.roots[rootKey].plural, extra = [], selection = 'key', wrap = (inner) => inner,
} = {}) => {
  const names = Object.keys(args);
  const declared = names.map((name) => `$${name}:${typeOf(types, rootKey, name)}`).join(',');
  const passed = [...names.map((name) => `${name}:$${name}`), ...extra].join(',');
  return { source: `query${declared ? `(${declared})` : ''}{${wrap(`${field}${passed ? `(${passed})` : ''}{${selection}}`)}}`, variables: args };
};
// A list sorted by key, unless the arguments sort; an aggregate grouped by key; the products of each shop.
const listOf = (types, rootKey, args, extra = []) => operationOf(types, rootKey, args, { extra: [...(Object.hasOwn(args, 'sort') ? [] : [BY_KEY]), ...extra] });
const aggregateOf = (types, rootKey, args) => operationOf(types, rootKey, args, {
  field: `${types.roots[rootKey].plural}_aggregate`, extra: [COUNT_BY_KEY], selection: 'groupId facts',
});
const productsOf = (types, args) => operationOf(types, 'product', args, {
  field: 'products', extra: [BY_KEY], wrap: (inner) => `${types.roots.shop.plural}(${BY_KEY}){key ${inner}}`,
});

// The first error of a failed operation.
class Failure {
  constructor({ message, extensions = {} }) {
    this.code = extensions.code;
    this.status = extensions.status;
    this.message = message;
  }
}

describe.skipIf(!mongoUri || !postgresUri)('MongoDB/PostgreSQL reference emptiness parity', () => {
  const namespace = `qp_parity_${randomUUID().replaceAll('-', '')}`;
  const statements = [];
  const commands = [];
  // The arguments that the spread copies of the bundled adapters receive, by backend name.
  const reads = [];
  let pool;
  // By backend name: `plain` reads collection fields one parent at a time and `batched` in batches; `copy` is a spread
  // copy of the bundled adapter whose reads record their arguments (on PostgreSQL, over plain's storage);
  // `undeclared` declares the operators without referenceEmptiness, and has no storage.
  let backends;
  // MongoDB alone: the fixture with the dangling product.
  let dangling;

  const outcome = async (runtime, { source, variables }, contextValue = {}) => {
    const result = await graphql({ schema: runtime.schema, source, variableValues: variables, contextValue });
    return result.errors ? new Failure(result.errors[0]) : Object.values(result.data)[0];
  };
  // The same request on every backend's `kind` runtime, by backend name: `build(runtime)` gives `{ operation, context }`.
  const both = async (kind, build) => Object.fromEntries(await Promise.all(Object.entries(backends).map(async ([name, runtimes]) => {
    const { operation, context } = build(runtimes[kind]);
    return [name, await outcome(runtimes[kind], operation, context)];
  })));
  const alike = (value) => Object.fromEntries(Object.keys(backends).map((name) => [name, value]));
  // Maps each backend's data, and keeps its Failure.
  const each = (found, map) => Object.fromEntries(Object.entries(found).map(([name, data]) => [name, data instanceof Failure ? data : map(data, name)]));
  const sortedKeys = (rows) => rows.map((row) => row.key).sort();
  // The data of a request with several fields on every backend's `kind` runtime, or its Failure, by backend name.
  const full = async (kind, build) => Object.fromEntries(await Promise.all(Object.entries(backends).map(async ([name, runtimes]) => {
    const runtime = runtimes[kind];
    const { source, variables, context } = build(runtime);
    const result = await graphql({ schema: runtime.schema, source, variableValues: variables, contextValue: context });
    return [name, result.errors ? new Failure(result.errors[0]) : result.data];
  })));

  // The request of a case on a runtime, as { client, context }. For a construct case, `form` 'field' sends a term and
  // 'condition' a group condition; 'middleware' sends nothing and middleware adds the term to the root's arguments, and
  // 'scope' has the root's own find and aggregate scopes add the group condition, both trusted. An args case ('args')
  // sends its own arguments, and the root's own scopes add its scopeArgs.
  const requestOf = (runtime, item, shape, form) => {
    const rootType = runtime.types.roots[item.root].type;
    const context = { shape };
    const client = item.args || CLIENT_FORMS.includes(form) ? referenceCaseArgs(item, runtime.ids, form) : {};
    const trusted = item.args ? item.scopeArgs : form === 'scope' && referenceCaseArgs(item, runtime.ids, 'condition');
    if (trusted) {
      const add = ({ args }) => append(args, structuredClone(trusted));
      context.extra = { [item.root]: { find: add, aggregate: add } };
    }
    if (form === 'middleware') {
      const added = referenceCaseArgs(item, runtime.ids, 'field');
      context.middleware = (params) => { if (params.type.gqltype === rootType) Object.assign(params.args, structuredClone(added)); };
    }
    return { client, context };
  };
  const keys = async (item, shape, form, kind = 'plain') => each(await both(kind, (runtime) => {
    const { client, context } = requestOf(runtime, item, shape, form);
    return { operation: listOf(runtime.types, item.root, client), context };
  }), sortedKeys);
  // The first page of two rows, and the count the runtime reports in the context.
  const counted = async (item, shape, form) => {
    const contexts = {};
    const found = await both('plain', (runtime) => {
      const { client, context } = requestOf(runtime, item, shape, form);
      contexts[runtime.name] = context;
      return { operation: listOf(runtime.types, item.root, client, [PAGE_COUNT]), context };
    });
    return each(found, (rows, name) => ({ page: sortedKeys(rows), count: contexts[name].count }));
  };
  const grouped = async (item, shape, form) => each(await both('plain', (runtime) => {
    const { client, context } = requestOf(runtime, item, shape, form);
    return { operation: aggregateOf(runtime.types, item.root, client), context };
  }), (groups) => [...groups].sort(byGroupId));
  const productsByShop = (item, shape, form, kind) => both(kind, (runtime) => {
    const { client, context } = requestOf(runtime, item, shape, form);
    return { operation: productsOf(runtime.types, client), context };
  });

  // One runtime with the reference fixture, the context-driven middleware and scopes, and its schema; `initialize`
  // prepares its storage, after which it is seeded unless `seed` is false.
  const runtimeOf = async (name, api, prefix, { initialize, seed = !!initialize, adapter } = {}) => {
    const types = createReferenceEmptinessTypes(prefix, { backend: name, scopes: HOOKS });
    api.use((params, next) => { params.context?.middleware?.(params); return next(); });
    if (name === 'mongodb') api.preventCreatingCollection(true);
    registerReferenceEmptinessTypes(api, types);
    const runtime = {
      name, api, adapter, types, schema: api.createSchema(), ids: {},
    };
    if (initialize) await initialize(api);
    if (seed) runtime.ids = await seedReferenceEmptiness(runtime.schema, types);
    return runtime;
  };
  const mongoCollections = async (api) => { for (const { model } of api.getRegistrations()) if (model) await model.createCollection(); };
  // A spread copy of a bundled adapter whose find, count and aggregate record the arguments they receive.
  const recordingCopy = (name, adapter) => {
    const record = (method) => (model, type, args, ...rest) => {
      reads.push({ backend: name, method, args: JSON.parse(JSON.stringify(args)) });
      return adapter[method](model, type, args, ...rest);
    };
    return {
      ...adapter, find: record('find'), count: record('count'), aggregate: record('aggregate'),
    };
  };

  beforeAll(async () => {
    await mongoose.connect(mongoUri, { dbName: namespace, monitorCommands: true });
    mongoose.connection.getClient().on('commandStarted', (event) => {
      if (event.commandName === 'aggregate') commands.push(event.command);
    });
    pool = new pg.Pool({ connectionString: postgresUri });
    // Records the text of every statement the plain and batched PostgreSQL runtimes run.
    const recording = {
      query: (text, values) => { statements.push(text); return pool.query(text, values); },
      connect: async () => {
        const client = await pool.connect();
        return { query: (text, values) => { statements.push(text); return client.query(text, values); }, release: (error) => client.release(error) };
      },
    };
    const { operators: mongoOperators } = createMongoAdapter().queryFeatures;
    const { operators: postgresOperators } = postgresPlugin().queryFeatures;
    const mongoCopy = recordingCopy('mongodb', createMongoAdapter());
    const postgresCopy = recordingCopy('postgres', createSQLAdapter(postgresPlugin({ pool, schema: namespace })));
    backends = {
      mongodb: {
        plain: await runtimeOf('mongodb', createRuntime(createMongoAdapter()), 'Qp', { initialize: mongoCollections }),
        batched: await runtimeOf('mongodb', createRuntime(createMongoAdapter({ batchedCollections: true, collectionBatchSize: 2 })), 'Qpb', { initialize: mongoCollections }),
        copy: await runtimeOf('mongodb', createRuntime(mongoCopy), 'Qpc', { initialize: mongoCollections, adapter: mongoCopy }),
        undeclared: await runtimeOf('mongodb', createRuntime({ ...createMongoAdapter(), queryFeatures: { operators: mongoOperators } }), 'Qpu'),
      },
      postgres: {
        plain: await runtimeOf('postgres', createPostgres({ pool: recording, schema: namespace }), 'Qp', { initialize: (api) => api.initializeDatabase() }),
        batched: await runtimeOf('postgres', createPostgres({ pool: recording, schema: `${namespace}_b`, batchedCollections: true }), 'Qpb', { initialize: (api) => api.initializeDatabase() }),
        undeclared: await runtimeOf('postgres', createSQL({ plugin: { ...postgresPlugin({ pool, schema: `${namespace}_u` }), queryFeatures: { operators: postgresOperators } } }), 'Qpu'),
      },
    };
    // The PostgreSQL copy reads the plain runtime's tables and records.
    backends.postgres.copy = await runtimeOf('postgres', createRuntime(postgresCopy), 'Qp', {
      initialize: () => postgresCopy.initialize({ mode: 'validate' }), seed: false, adapter: postgresCopy,
    });
    backends.postgres.copy.ids = backends.postgres.plain.ids;
    dangling = await runtimeOf('mongodb', createRuntime(createMongoAdapter()), 'Qpd', { initialize: mongoCollections });
    await writeMongoDanglingReference(dangling.api, dangling.types);
  }, 120000);
  afterAll(async () => {
    if (mongoose.connection.readyState) {
      // Generated models build their indexes in the background; let them finish, so that none recreates a collection.
      await Promise.allSettled(mongoose.modelNames().map((name) => mongoose.model(name).init()));
      await mongoose.connection.db.dropDatabase();
      await mongoose.disconnect();
    }
    if (pool) {
      for (const schema of [namespace, `${namespace}_b`, `${namespace}_u`]) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });

  // The rows of a construct case in every shape, from the client as a term and a group condition and from middleware
  // and the root's own scope, in lists, counted pages and aggregates; `marked` is whether the adapter receives the
  // client's term with a marker, which the recording copies show.
  const expectCaseRows = async (item, marked) => {
    reads.length = 0;
    expect(await keys(item, 'NE', 'field', 'copy'), 'NE copy').toEqual(alike(expectedReferenceRows(item, 'NE')));
    expect(reads.map(({ backend, args }) => [backend, JSON.stringify(args).includes('"__scope"')]).sort(([a], [b]) => (a < b ? -1 : 1)), 'marked')
      .toEqual([['mongodb', marked], ['postgres', marked]]);
    for (const shape of REFERENCE_SHAPES) {
      for (const form of [...CLIENT_FORMS, ...TRUSTED_FORMS]) {
        expect(await keys(item, shape, form), `${shape} ${form}`).toEqual(alike(expectedReferenceRows(item, shape, { trusted: TRUSTED_FORMS.includes(form) })));
      }
      const rows = expectedReferenceRows(item, shape);
      expect(await counted(item, shape, 'field'), `${shape} counted`).toEqual(alike({ page: rows.slice(0, 2), count: rows.length }));
      expect(await grouped(item, shape, 'condition'), `${shape} aggregate`).toEqual(alike(groupsOf(rows)));
      expect(await grouped(item, shape, 'scope'), `${shape} aggregate trusted`).toEqual(alike(groupsOf(expectedReferenceRows(item, shape, { trusted: true }))));
    }
  };
  it.each(RELATION_CASES.map((item) => [item.name, item]))('returns the rows of %s on both backends for every shape, from the client and from trusted code, in lists, counted pages and aggregates', async (name, item) => {
    await expectCaseRows(item, true);
  }, 60000);
  it.each(OWN_FIELD_CASES.map((item) => [item.name, item]))('returns the rows of %s, which reads no reference and no collection, on both backends for every shape, from the client and from trusted code (regression pin, passes on 3.10.0 by design)', async (name, item) => {
    await expectCaseRows(item, false);
  }, 60000);

  it.each(ARGS_CASES.map((item) => [item.name, item]))('returns the rows of %s on both backends for every shape, in lists, counted pages and aggregates', async (name, item) => {
    for (const shape of REFERENCE_SHAPES) {
      const rows = expectedReferenceRows(item, shape);
      expect(await keys(item, shape, 'args'), shape).toEqual(alike(rows));
      // The sort case's rows hold at most one record, so its first page is the same whatever the order.
      expect(await counted(item, shape, 'args'), `${shape} counted`).toEqual(alike({ page: rows.slice(0, 2), count: rows.length }));
      // An aggregate has no sort, and so no joined scope from one.
      if (!Object.hasOwn(item.args, 'sort')) expect(await grouped(item, shape, 'args'), `${shape} aggregate`).toEqual(alike(groupsOf(rows)));
    }
  }, 60000);

  it('returns the documented rows of a legacy branch, a legacy condition in the same group and a sort beside a marked construct on the same reference, under scopes that accept and reject null', async () => {
    const documented = [
      // c, whose shop S2 the restricted caller cannot read, never appears for that caller.
      ['OR [legacy shop.name EQ "S2", shop IS_NOT_EMPTY]', { admin: ['D', 'E', 'Ka', 'c'], NE: ['D', 'E', 'Ka'], EQ: ['E', 'Ka'] }],
      ['one group [legacy shop.name EQ "S2", shop IS_NOT_EMPTY]', { admin: ['c'], NE: [], EQ: [] }],
      ['one group [legacy shop.name EQ "S2", shop IS_EMPTY]', { admin: [], NE: [], EQ: [] }],
      // The sort's joined scope restricts the whole query: under EQ it removes the products without a shop and those
      // with a hidden one, under NE only those with a hidden one.
      ['sort shop.name beside shop IS_EMPTY', { admin: ['C'], NE: ['C'], EQ: [] }],
    ];
    for (const [name, rows] of documented) {
      for (const [shape, expected] of Object.entries(rows)) expect(await keys(byName(name), shape, 'args'), `${name} ${shape}`).toEqual(alike(expected));
    }
    // Without the sort, the same construct returns the products without a shop and those with a hidden one.
    expect(await keys(byName('shop IS_EMPTY'), 'NE', 'field')).toEqual(alike(['C', 'c']));
    expect(await keys(byName('shop IS_EMPTY'), 'EQ', 'field')).toEqual(alike(['C', 'D', 'c']));
  });

  it('reads the String identity right after a reference exactly as the reference, client and trusted, on both backends', async () => {
    expect(backends.postgres.plain.types.Shop.getFields().id.type.toString()).toBe('String');
    for (const [identity, reference] of [['shop.id', 'shop'], ['pro.shop.id', 'pro.shop'], ['odim.shop.id', 'odim.shop']]) {
      for (const operator of OPERATORS) {
        for (const shape of REFERENCE_SHAPES) {
          for (const form of ['field', 'middleware']) {
            const label = `${identity} ${operator} ${shape} ${form}`;
            const found = await keys(byName(`${identity} ${operator}`), shape, form);
            expect(found, label).toEqual(await keys(byName(`${reference} ${operator}`), shape, form));
            expect(found, label).toEqual(alike(expectedReferenceRows(byName(`${reference} ${operator}`), shape, { trusted: form === 'middleware' })));
          }
        }
      }
    }
  }, 60000);

  it('correlates the hop after a scoped crossing to that scoped join on both backends, also when its own scope adds nothing, and keeps trusted constructs on plain joins', async () => {
    const { types } = backends.mongodb.plain;
    const collection = (type) => backends.mongodb.plain.api.getModel(type).collection.collectionName;
    const product = `"${namespace}"."QpProduct"`;
    // The pipeline and the statement of one list request on the plain runtimes.
    const formsOf = async (path, shape, form) => {
      commands.length = 0;
      statements.length = 0;
      const item = byName(`${path} IS_EMPTY`);
      const found = await keys(item, shape, form);
      expect(found, `${path} ${shape} ${form}`).toEqual(alike(expectedReferenceRows(item, shape, { trusted: TRUSTED_FORMS.includes(form) })));
      const [pipeline] = commands.filter((command) => command.aggregate === collection(types.Product)).map((command) => command.pipeline);
      const [statement] = statements.filter((text) => text.includes(`FROM ${product} t0`));
      return { lookups: pipeline.filter((stage) => stage.$lookup).map((stage) => stage.$lookup), statement };
    };
    // The scoped join on Pro, and the alias the PostgreSQL statement gives it.
    const scopedPro = ({ lookups, statement }) => {
      const join = lookups.find((lookup) => lookup.from === collection(types.Pro));
      expect(join.as).toMatch(/^__sf_j\d+$/);
      expect(join.localField).toBe('pro');
      expect(join.pipeline.at(-1)).toEqual({ $limit: 1 });
      const lateral = new RegExp(`LEFT JOIN LATERAL \\(SELECT (t\\d+)\\.\\* FROM "${namespace}"\\."QpPro" \\1 .*?LIMIT 1\\) (t\\d+) ON TRUE`).exec(statement);
      expect(lateral, statement).not.toBeNull();
      return { join, alias: lateral[2] };
    };
    // Pro and Shop both scoped: the Shop frame reads the Pro join's shop, with the Shop scope.
    for (const shape of ['NE', 'EQ']) {
      const forms = await formsOf('pro.shop', shape, 'field');
      const { join, alias } = scopedPro(forms);
      const frame = forms.lookups.find((lookup) => lookup.from === collection(types.Shop));
      expect(frame).toMatchObject({ localField: `${join.as}.shop`, foreignField: '_id', as: expect.stringMatching(/^__sf_q\d+$/) });
      expect(frame.pipeline.length, shape).toBe(3);
      expect(forms.statement).toMatch(new RegExp(`NOT EXISTS \\(SELECT 1 FROM "${namespace}"\\."QpShop" (t\\d+) WHERE \\1\\."id" = ${alias}\\."shop" AND `));
    }
    // Pro scoped and Shop unscoped: the end and the second hop still read through the Pro join.
    const end = await formsOf('pro.shop', 'proOnly', 'field');
    const endPro = scopedPro(end);
    expect(end.lookups.find((lookup) => lookup.from === collection(types.Shop))).toEqual({
      from: collection(types.Shop), localField: `${endPro.join.as}.shop`, foreignField: '_id', pipeline: [{ $limit: 1 }, { $project: { _id: 1 } }], as: expect.stringMatching(/^__sf_q\d+$/),
    });
    expect(end.statement).toContain(`${endPro.alias}."shop" IS NULL`);
    const hop = await formsOf('pro.shop.state', 'proOnly', 'field');
    const hopPro = scopedPro(hop);
    expect(hop.lookups.find((lookup) => lookup.from === collection(types.Shop))).toEqual({
      from: collection(types.Shop), localField: `${hopPro.join.as}.shop`, foreignField: '_id', pipeline: [{ $limit: 1 }], as: expect.stringMatching(/^__sf_j\d+$/),
    });
    expect(hop.statement).toMatch(new RegExp(`LEFT JOIN LATERAL \\(SELECT (t\\d+)\\.\\* FROM "${namespace}"\\."QpShop" \\1 WHERE \\1\\."id" = ${hopPro.alias}\\."shop" LIMIT 1\\) t\\d+ ON TRUE`));
    // The same constructs from middleware read the stored shops through plain joins.
    for (const path of ['pro.shop', 'pro.shop.state']) {
      const trusted = await formsOf(path, 'proOnly', 'middleware');
      expect(trusted.lookups.map((lookup) => lookup.as).filter((as) => /^__sf_j/.test(as)), path).toEqual([]);
      expect(trusted.lookups.find((lookup) => lookup.from === collection(types.Pro)).as, path).toMatch(/^__sf_l\d+$/);
      expect(trusted.statement, path).not.toContain('LATERAL');
    }
  });

  const expectChildRows = async (item, kind) => {
    for (const shape of REFERENCE_SHAPES) {
      for (const form of item.args ? ['args'] : CLIENT_FORMS) {
        expect(await productsByShop(item, shape, form, kind), `${shape} ${form}`).toEqual(alike(byShop(expectedReferenceRows(item, shape), shape)));
      }
    }
  };
  it.each(['plain', 'batched'].flatMap((kind) => childCases([...RELATION_CASES, ...ARGS_CASES]).map((item) => [kind, item.name, item])))('filters the collection field Shop.products, read %s, by %s alike for every shape', async (kind, name, item) => {
    await expectChildRows(item, kind);
  }, 60000);
  it.each(['plain', 'batched'].flatMap((kind) => childCases(OWN_FIELD_CASES).map((item) => [kind, item.name, item])))('filters the collection field Shop.products, read %s, by %s, which reads no reference and no collection, alike for every shape (regression pin, passes on 3.10.0 by design)', async (kind, name, item) => {
    await expectChildRows(item, kind);
  }, 60000);

  it('reads Shop.products in batches on the batched runtimes, with the scoped joins and frames in every branch, and one parent at a time on the others', async () => {
    const item = byName('pro.shop IS_EMPTY');
    const read = async (kind, shape) => {
      commands.length = 0;
      statements.length = 0;
      expect(await productsByShop(item, shape, 'field', kind), `${kind} ${shape}`).toEqual(alike(byShop(expectedReferenceRows(item, shape), shape)));
      const runtime = backends.mongodb[kind];
      const collection = runtime.api.getModel(runtime.types.Product).collection.collectionName;
      return {
        mongodb: commands.filter((command) => command.aggregate === collection)
          .map(({ pipeline }) => ({ batch: pipeline.some((stage) => stage.$unionWith), scoped: JSON.stringify(pipeline).includes('"__sf_j') })),
        postgres: statements.filter((text) => text.includes(' UNION ALL ') && text.includes('"__simfinity_parent"')).map((text) => ({ batch: true, scoped: text.includes('LEFT JOIN LATERAL') })),
      };
    };
    // Under NE the Pro and Shop scopes add conditions, so the client construct reads through a scoped join; the Shop
    // root reads S1 and S3, one batch of two on MongoDB. An admin's scopes add nothing, so the construct compiles as a
    // trusted one; three shops make a batch of two and one of one on MongoDB.
    expect(await read('batched', 'NE')).toEqual({ mongodb: [{ batch: true, scoped: true }], postgres: [{ batch: true, scoped: true }] });
    expect(await read('batched', 'admin')).toEqual({ mongodb: [{ batch: true, scoped: false }, { batch: false, scoped: false }], postgres: [{ batch: true, scoped: false }] });
    expect(await read('plain', 'NE')).toEqual({ mongodb: [{ batch: false, scoped: true }, { batch: false, scoped: true }], postgres: [] });
  });

  it.each(['plain', 'batched'])('marks and fills its own copy, in each query field, _aggregate field and collection-field call, of a nested group and a term that they share, alike (%s)', async (kind) => {
    // `pro.shop IS_EMPTY` in a nested AND, a nested OR and two levels deep, which together read like the condition
    // alone; and a term without a path, used under two fields of one query field and under a third in a collection
    // field. _aggregate fields read both before and after the lists, so each order of an _aggregate and a list call is
    // covered, and so are two _aggregate calls.
    const condition = { field: 'pro', path: 'shop', operator: 'IS_EMPTY' };
    const variables = {
      g: [{ AND: [{ conditions: [condition] }], OR: [{ conditions: [condition] }, { AND: [{ conditions: [condition] }] }] }],
      t: { terms: [{ operator: 'IS_EMPTY' }] },
    };
    const aggregate = (product, args) => `${product.plural}_aggregate(${args},${COUNT_BY_KEY}){groupId facts}`;
    const sourceOf = ({ roots: { product, shop } }) => `query($g:[QLFilterGroup],$t:QLTypeFilterExpression){
      ga:${aggregate(product, 'AND:$g')} ta:${aggregate(product, 'shop:$t,pro:$t')}
      a:${product.plural}(AND:$g,${BY_KEY}){key} b:${product.plural}(OR:$g,${BY_KEY}){key} c:${product.plural}(shop:$t,pro:$t,${BY_KEY}){key}
      shops:${shop.plural}(${BY_KEY}){key g:products(AND:$g,${BY_KEY}){key} t:products(pro:$t,${BY_KEY}){key}}
      gb:${aggregate(product, 'OR:$g')} tb:${aggregate(product, 'shop:$t,pro:$t')}
    }`;
    const groups = (found) => [...found].sort(byGroupId);
    for (const shape of REFERENCE_SHAPES) {
      const found = await full(kind, (runtime) => ({ source: sourceOf(runtime.types), variables: structuredClone(variables), context: { shape } }));
      const chain = expectedReferenceRows(byName('pro.shop IS_EMPTY'), shape);
      const pro = expectedReferenceRows(byName('pro IS_EMPTY'), shape);
      const shop = expectedReferenceRows(byName('shop IS_EMPTY'), shape);
      const shopAndPro = shop.filter((key) => pro.includes(key));
      expect(each(found, ({
        ga, ta, a, b, c, shops, gb, tb,
      }) => ({
        ga: groups(ga), ta: groups(ta), a: sortedKeys(a), b: sortedKeys(b), c: sortedKeys(c), shops, gb: groups(gb), tb: groups(tb),
      })), shape).toEqual(alike({
        ga: groupsOf(chain),
        ta: groupsOf(shopAndPro),
        a: chain,
        b: chain,
        c: shopAndPro,
        shops: byShop(chain, shape).map(({ key, products }, index) => ({ key, g: products, t: byShop(pro, shape)[index].products })),
        gb: groupsOf(chain),
        tb: groupsOf(shopAndPro),
      }));
    }
  });

  it('keeps referenceEmptiness in spread copies of both bundled adapters, whose find receives the filled marker and returns the bundled rows', async () => {
    expect(each(backends, ({ copy }) => copy.adapter.queryFeatures.referenceEmptiness)).toEqual(alike(true));
    const item = byName('shop IS_EMPTY');
    const scope = (condition) => ({ AND: [{ conditions: [condition] }] });
    for (const [shape, shopScope] of [
      ['NE', scope({ field: 'name', operator: 'NE', value: 'S2' })],
      ['EQ', scope({ field: 'state', operator: 'EQ', value: 'OPEN' })],
      // An admin's Shop scope adds nothing.
      ['admin', null],
    ]) {
      reads.length = 0;
      expect(await keys(item, shape, 'field', 'copy'), shape).toEqual(alike(expectedReferenceRows(item, shape)));
      expect(reads.map(({ backend, method, args }) => [backend, method, args.shop]).sort(([a], [b]) => (a < b ? -1 : 1)), shape).toEqual(['mongodb', 'postgres'].map((backend) => [
        backend, 'find', { terms: [{ operator: 'IS_EMPTY', __scope: { id: 0, scopes: { shop: shopScope } } }] },
      ]));
    }
  });

  it('fills the client markers of an _aggregate call from each target\'s find scope, not from its aggregate scope, on both backends', async () => {
    // Under NE, Shop's and Review's aggregate scopes also hide every record, while their find scopes hide S2 and the
    // reviews by "hidden" only. Read through the aggregate scopes, every product would have no shop and no reviews.
    const hideAll = ({ args }) => append(args, { AND: [{ conditions: [{ field: 'key', operator: 'EQ', value: 'none' }] }] });
    const extra = { shop: { aggregate: hideAll }, review: { aggregate: hideAll } };
    const scope = (condition) => ({ AND: [{ conditions: [condition] }] });
    // The aggregate scopes do differ: the Shop and Review roots' own aggregates read nothing.
    for (const root of ['shop', 'review']) {
      expect(await both('plain', (runtime) => ({ operation: aggregateOf(runtime.types, root, {}), context: { shape: 'NE', extra } })), root).toEqual(alike([]));
    }
    for (const [name, target] of [
      ['shop IS_EMPTY', scope({ field: 'name', operator: 'NE', value: 'S2' })],
      ['reviews IS_EMPTY', scope({ field: 'author', operator: 'NE', value: 'hidden' })],
    ]) {
      const item = byName(name);
      const rows = expectedReferenceRows(item, 'NE');
      expect(rows, name).toEqual(['C', 'c']);
      reads.length = 0;
      for (const kind of ['plain', 'copy']) {
        const found = await both(kind, (runtime) => {
          const { client, context } = requestOf(runtime, item, 'NE', 'condition');
          return { operation: aggregateOf(runtime.types, item.root, client), context: { ...context, extra } };
        });
        expect(each(found, (groups) => [...groups].sort(byGroupId)), `${name} ${kind}`).toEqual(alike(groupsOf(rows)));
      }
      // The copies' aggregate receives the find scope's arguments in the marker.
      expect(reads.map(({ backend, method, args }) => [backend, method, args.AND]).sort(([a], [b]) => (a < b ? -1 : 1)), name).toEqual(['mongodb', 'postgres'].map((backend) => [
        backend, 'aggregate', [{ conditions: [{ field: item.path, operator: 'IS_EMPTY', __scope: { id: 0, scopes: { [item.path]: target } } }] }],
      ]));
    }
  });

  it('runs a spread copy of a marked term placed where it reads no reference as a trusted condition, and fails the same object placed there with DETACHED_CLIENT_FILTER, alike', async () => {
    const item = byName('shop IS_EMPTY');
    const placed = (spread) => (runtime) => {
      const rootType = runtime.types.Product;
      const { client } = requestOf(runtime, item, 'EQ', 'field');
      const middleware = (params) => {
        if (params.type.gqltype !== rootType) return;
        const [term] = params.args.shop.terms;
        params.args.olines = { terms: [spread ? { ...term } : term] };
      };
      return { operation: listOf(runtime.types, 'product', client), context: { shape: 'EQ', middleware } };
    };
    reads.length = 0;
    // shop IS_EMPTY under EQ gives C, D and c, and only D has no order lines.
    expect(each(await both('copy', placed(true)), sortedKeys)).toEqual(alike(['D']));
    const shopScope = { AND: [{ conditions: [{ field: 'state', operator: 'EQ', value: 'OPEN' }] }] };
    expect(reads.map(({ args }) => ({ olines: args.olines, shop: args.shop }))).toEqual([0, 1].map(() => ({
      olines: { terms: [{ operator: 'IS_EMPTY' }] },
      shop: { terms: [{ operator: 'IS_EMPTY', __scope: { id: 0, scopes: { shop: shopScope } } }] },
    })));
    reads.length = 0;
    const found = await both('copy', placed(false));
    expect(found).toEqual(alike(expect.objectContaining({
      code: 'DETACHED_CLIENT_FILTER', status: 500, message: expect.stringContaining('is used where it reads references or collections and where it reads none'),
    })));
    expect(found.mongodb.message).toBe(found.postgres.message);
    expect(reads).toEqual([]);
  });

  it('fails a rebuilt marked construct with DETACHED_CLIENT_FILTER (500) and the same message on both backends before the adapter runs, in counted lists and aggregates', async () => {
    const item = byName('shop IS_EMPTY');
    for (const build of [(types, args) => listOf(types, 'product', args, [PAGE_COUNT]), (types, args) => aggregateOf(types, 'product', args)]) {
      reads.length = 0;
      const found = await both('copy', (runtime) => {
        const rootType = runtime.types.Product;
        const { client } = requestOf(runtime, item, 'NE', 'field');
        const middleware = (params) => { if (params.type.gqltype === rootType) params.args.shop = { terms: [{ operator: 'IS_EMPTY' }] }; };
        return { operation: build(runtime.types, client), context: { shape: 'NE', middleware } };
      });
      expect(found).toEqual(alike(expect.objectContaining({
        code: 'DETACHED_CLIENT_FILTER', status: 500, message: expect.stringContaining('The client\'s IS_EMPTY condition on shop is no longer in the arguments after middleware and scopes'),
      })));
      expect(found.mongodb.message).toBe(found.postgres.message);
      expect(reads).toEqual([]);
    }
  });

  it('rejects emptiness through references and collections with UNSUPPORTED_QUERY and the same message on both backends when the adapter or plugin declares the operators without referenceEmptiness', async () => {
    for (const [root, path, reading] of [
      ['product', 'shop', 'ends at the reference shop'], ['product', 'shop.name', 'crosses the reference shop'],
      ['product', 'pro.shop.id', 'crosses the reference pro'], ['product', 'reviews', 'ends at the collection reviews'],
      ['product', 'odim', 'reads the reference member odim.shop'], ['review', 'product', 'ends at the reference product'],
      ['shop', 'products', 'ends at the collection products'],
    ]) {
      for (const operator of OPERATORS) {
        for (const form of CLIENT_FORMS) {
          const args = referenceCaseArgs({ path, operator }, {}, form);
          for (const build of [listOf, aggregateOf]) {
            expect(await both('undeclared', (runtime) => ({ operation: build(runtime.types, root, args) })), `${root} ${path} ${operator} ${form}`).toEqual(alike({
              code: 'UNSUPPORTED_QUERY', status: 400, message: `${operator} on ${path} ${reading}: ${NOT_SUPPORTED}`,
            }));
          }
        }
      }
    }
  });

  it('reads MongoDB\'s dangling product as empty wherever the cases say, client and trusted, for every case and shape', async () => {
    for (const item of REFERENCE_CASES) {
      for (const shape of REFERENCE_SHAPES) {
        for (const form of item.args ? ['args'] : [...CLIENT_FORMS, ...TRUSTED_FORMS]) {
          const { client, context } = requestOf(dangling, item, shape, form);
          const found = await outcome(dangling, listOf(dangling.types, item.root, client), context);
          expect(found instanceof Failure ? found : sortedKeys(found), `${item.name} ${shape} ${form}`)
            .toEqual(expectedReferenceRows(item, shape, { trusted: TRUSTED_FORMS.includes(form), dangling: true }));
        }
      }
    }
  }, 120000);

  it('reads a collection member inside an embedded type of supplied MongoDB models through the child\'s find scope for a client, and the stored children for trusted code', async () => {
    // Box.inner.kids, whose children point to the subdocument _id of inner; describeModels rejects it, so PostgreSQL
    // never has one. The Kid find scope hides the kids with n 1 when the context asks.
    const hideOne = ({ args, context }) => { if (context?.hide) append(args, { AND: [{ conditions: [{ field: 'n', operator: 'GT', value: 1 }] }] }); };
    const Kid = new GraphQLObjectType({
      name: 'QpsKid', extensions: { scope: { find: hideOne } }, fields: { id: { type: GraphQLID }, key: { type: GraphQLString }, n: { type: GraphQLInt } },
    });
    const Inner = new GraphQLObjectType({
      name: 'QpsInner',
      fields: { label: { type: GraphQLString }, kids: { type: new GraphQLList(Kid), extensions: { relation: { embedded: false, connectionField: 'box' } } } },
    });
    const Box = new GraphQLObjectType({
      name: 'QpsBox',
      fields: { id: { type: GraphQLID }, key: { type: new GraphQLNonNull(GraphQLString) }, inner: { type: Inner, extensions: { relation: { embedded: true } } } },
    });
    const { ObjectId } = mongoose.Schema.Types;
    const BoxModel = mongoose.model('QpsBox', new mongoose.Schema({ key: String, inner: new mongoose.Schema({ label: String }) }), 'QpsBox');
    const KidModel = mongoose.model('QpsKid', new mongoose.Schema({ key: String, n: Number, box: ObjectId }), 'QpsKid');
    const api = createRuntime(createMongoAdapter());
    api.use((params, next) => { params.context?.middleware?.(params); return next(); });
    api.addNoEndpointType(Inner);
    api.connect(BoxModel, Box, 'qpsBox', 'qpsBoxes');
    api.connect(KidModel, Kid, 'qpsKid', 'qpsKids');
    const schema = api.createSchema();
    const ids = [0, 1, 2, 3, 4].map(() => new mongoose.Types.ObjectId());
    // a has a label and the kid k1, which the scope hides; b an inner with nothing; c no inner; d the kid k3; e a label
    // and no kid; f only the kid k4, which the scope hides. The orphans k0 and k2, with a null or missing box, would
    // match a missing local key without the null guard.
    await BoxModel.collection.insertMany([
      { key: 'a', inner: { _id: ids[0], label: 'a' } }, { key: 'b', inner: { _id: ids[1] } }, { key: 'c' },
      { key: 'd', inner: { _id: ids[2], label: null } }, { key: 'e', inner: { _id: ids[3], label: 'e' } }, { key: 'f', inner: { _id: ids[4] } },
    ]);
    await KidModel.collection.insertMany([
      { key: 'k1', n: 1, box: ids[0] }, { key: 'k3', n: 5, box: ids[2] }, { key: 'k4', n: 1, box: ids[4] }, { key: 'k0', n: 9, box: null }, { key: 'k2', n: 9 },
    ]);
    const rows = async (form, path, operator, context) => {
      const condition = { field: 'inner', ...(path ? { path } : {}), operator };
      const [name, type, value] = form === 'condition' ? ['AND', '[QLFilterGroup]', [{ conditions: [condition] }]] : ['inner', 'QLTypeFilterExpression', { terms: [{ ...(path ? { path } : {}), operator }] }];
      const client = form === 'middleware' ? {} : { [name]: value };
      const middleware = form === 'middleware' ? (params) => { if (params.type.gqltype === Box) params.args.inner = { terms: [{ ...(path ? { path } : {}), operator }] }; } : undefined;
      const source = `query${form === 'middleware' ? '' : `($v:${type})`}{qpsBoxes(${form === 'middleware' ? '' : `${name}:$v,`}${BY_KEY}){key}}`;
      const result = await graphql({ schema, source, variableValues: client[name] === undefined ? {} : { v: client[name] }, contextValue: { ...context, middleware } });
      expect(result.errors, `${form} ${path} ${operator}`).toBeUndefined();
      return result.data.qpsBoxes.map((box) => box.key);
    };
    for (const [path, operator, stored, hidden] of [
      ['kids', 'IS_EMPTY', 'b c e', 'a b c e f'],
      ['kids', 'IS_NOT_EMPTY', 'a d f', 'd'],
      [null, 'IS_EMPTY', 'b c', 'b c f'],
      [null, 'IS_NOT_EMPTY', 'a d e f', 'a d e'],
    ]) {
      for (const form of CLIENT_FORMS) {
        expect(await rows(form, path, operator, {}), `${form} ${path} ${operator}`).toEqual(stored.split(' '));
        expect(await rows(form, path, operator, { hide: true }), `${form} ${path} ${operator} hidden`).toEqual(hidden.split(' '));
      }
      expect(await rows('middleware', path, operator, { hide: true }), `middleware ${path} ${operator}`).toEqual(stored.split(' '));
    }
  });

  it('keeps the 3.10.0 result of a value that holds __scope when no construct is marked: MongoDB rejects it as an _id, PostgreSQL reads its id (regression pin, passes on 3.10.0 by design)', async () => {
    const found = await both('plain', (runtime) => ({
      operation: listOf(runtime.types, 'product', { id: { operator: 'EQ', value: { id: runtime.ids.Ka, __scope: { id: 0 } } } }), context: { shape: 'NE' },
    }));
    expect(found.mongodb).toEqual(expect.objectContaining({ code: 'INVALID_FILTER_VALUE', status: 400, message: 'Expected a scalar value for _id' }));
    expect(found.postgres).toEqual([{ key: 'Ka' }]);
  });

  it('keeps the rows of legacy EQ null and of a text operator through a reference, with their joined scopes, on both backends (regression pin, passes on 3.10.0 by design)', async () => {
    for (const [args, rows] of [
      [{ AND: [{ conditions: [{ field: 'shop', path: 'id', operator: 'EQ', value: null }] }] }, { admin: ['C'], NE: ['C'], EQ: [] }],
      [{ shop: { terms: [{ path: 'state', operator: 'EQ', value: null }] } }, { admin: ['C', 'D'], NE: ['C', 'D'], EQ: [] }],
      [{ shop: { terms: [{ path: 'name', operator: 'ILIKE', value: 's' }] } }, { admin: ['D', 'E', 'Ka', 'c'], NE: ['D', 'E', 'Ka'], EQ: ['E', 'Ka'] }],
    ]) {
      for (const [shape, expected] of Object.entries(rows)) {
        const found = await both('plain', (runtime) => ({ operation: listOf(runtime.types, 'product', structuredClone(args)), context: { shape } }));
        expect(each(found, sortedKeys), `${JSON.stringify(args)} ${shape}`).toEqual(alike(expected));
      }
    }
  });

  it('restricts a marked construct with the joined scope of a text operator in its group, not in another, and reads more rows than legacy EQ null under a scope that accepts null', async () => {
    const name = (operator, value) => ({ field: 'shop', path: 'name', operator, value });
    const stateEmpty = { field: 'shop', path: 'state', operator: 'IS_EMPTY' };
    for (const [args, rows] of [
      // In the same group, the text condition's joined scope removes D under EQ: S3 has no state.
      [{ AND: [{ conditions: [name('ILIKE', 's'), stateEmpty] }] }, { admin: ['D'], NE: ['D'], EQ: [] }],
      // In another OR branch, it restricts its own branch only.
      [{ OR: [{ conditions: [name('ILIKE', 'zz')] }, { conditions: [stateEmpty] }] }, { admin: ['C', 'D'], NE: ['C', 'D', 'c'], EQ: ['C', 'D', 'c'] }],
    ]) {
      for (const [shape, expected] of Object.entries(rows)) {
        const found = await both('plain', (runtime) => ({ operation: listOf(runtime.types, 'product', structuredClone(args)), context: { shape } }));
        expect(each(found, sortedKeys), `${JSON.stringify(args)} ${shape}`).toEqual(alike(expected));
      }
    }
    // Under name NE "S2", a hidden shop reads as missing, so c joins C and D; legacy EQ null keeps C and D.
    expect(await keys(byName('shop.state IS_EMPTY'), 'NE', 'field')).toEqual(alike(['C', 'D', 'c']));
    const legacy = await both('plain', (runtime) => ({ operation: listOf(runtime.types, 'product', { shop: { terms: [{ path: 'state', operator: 'EQ', value: null }] } }), context: { shape: 'NE' } }));
    expect(each(legacy, sortedKeys)).toEqual(alike(['C', 'D']));
  });
});
