// The list operators CONTAINS_ALL and IIN (#108, part 4) on both backends. The list operator fixture and the text
// fixture, written by the same generated mutations, return on MongoDB and on PostgreSQL the rows the spec's parity
// section (9.3) derives from the data, in key order and with the duplicates of the multiplying join through parts.shop:
// as field filters, AND conditions and OR branches beside a condition that matches nothing, listed and counted, in the
// admin shape and in each named scope shape, and through the Shop.items collection field, batched and one parent at a
// time; so do the aggregates, the get_by_id scopes and the named views. Every rejection gets the same code and message
// on both backends, except the divergences inherited from IN and IEQ, which the rows name. A request that names either
// operator fails on the release before part 4 with GraphQL's enum rejection; the rows that pass there by design are
// named `guard:` or `pin:`.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { graphql, GraphQLList, GraphQLString } from 'graphql';
import mongoose from 'mongoose';
import pg from 'pg';
import { createRuntime } from '../../packages/core/src/index.js';
import { createMongoAdapter } from '../../packages/mongodb/src/mongo/adapter.js';
import { postgresPlugin } from '../../packages/postgres/src/index.js';
import { createSQLAdapter } from '../../packages/sql/src/adapter.js';
import {
  createListOperatorTypes, IIN_FOLDING_CASES, IIN_ITEM_CASES, LIST_OPERATOR_CASES, listOperatorArgs, registerListOperatorTypes, seedListOperators,
} from '../helpers/list-operators.js';
import {
  ACCEPTED_FOLDING_DIFFERENCES, createTextOperatorFixture, registerTextOperatorFixture, seedTextOperatorFixture, WORDS,
} from '../helpers/query-text-operators.js';

const mongoUri = process.env.SIMFINITY_MONGODB_URI;
const postgresUri = process.env.SIMFINITY_POSTGRES_URI;
const BY_KEY = 'sort:{terms:[{field:"key",order:ASC}]}';
const COUNTED = `${BY_KEY},pagination:{page:1,size:100,count:true}`;
const aggregation = (groupId) => `aggregation:{groupId:"${groupId}",facts:[{operation:COUNT,factName:"n",path:"id"}]}`;
// The OR branch beside each condition: it matches nothing, so the rows are the condition's own.
const NOTHING = { field: 'name', operator: 'EQ', value: 'zzz' };
const SHORTHAND = 'INVALID_FILTER_PATH 400: The shorthand excludes them; use an explicit group';
const notList = (path) => `INVALID_FILTER_OPERATOR 400: CONTAINS_ALL requires a list field, or a field reached through an embedded list; ${path} is not one`;
const crossing = (path) => `INVALID_FILTER_PATH 400: CONTAINS_ALL cannot cross the reference ${path} inside an embedded list, which joins one referenced record per row; combine EQ conditions on the path instead`;
const notString = (path) => `INVALID_FILTER_VALUE 400: IIN requires a String field on ${path}`;
const invalidValue = (message) => `INVALID_FILTER_VALUE 400: ${message}`;
// The runtime's 403 for a scoped reference inside an embedded list inside a frame, with each backend's type names.
const forbidden = (prefix) => `FORBIDDEN_FILTER_PATH 403: Query path reviews.item.parts.shop enters ${prefix}Shop, whose find scope restricts the relation ${prefix}Part.shop inside a list`;
// The shop of each item that has one, by fixture, and the shops each scope shape leaves visible (9.2).
const SHOP_OF = { list: { I1: 'S1', I2: 'S2', I3: 'S3', I5: 'S4' }, text: { A: 'S1', B: 'S2', C: 'S3' } };
const VISIBLE_SHOPS = {
  admin: ['S1', 'S2', 'S3', 'S4'], shopNE: ['S1', 'S3', 'S4'], shopEQ: ['S1'], shopTags: ['S1', 'S2'], reviewNE: ['S1', 'S2', 'S3', 'S4'], reviewEQ: ['S1', 'S2', 'S3', 'S4'],
};
// The adapter methods that read records, counted where a request must reach no adapter.
const READS = ['find', 'count', 'aggregate', 'getById', 'getByIds', 'findChildren', 'findChildrenBatch'];

const field = (path, operator, value) => {
  const [head, ...rest] = path.split('.');
  return rest.length ? { [head]: { terms: [{ path: rest.join('.'), operator, value }] } } : { [head]: { operator, value } };
};
const inGroup = (path, operator, value) => ({ AND: [{ conditions: [{ field: path, operator, value }] }] });
const framed = (quantifier, path, condition) => ({ AND: [{ [quantifier]: [{ path, conditions: [condition] }] }] });
// The single condition of a field filter, or null for groups and quantified field filters.
const conditionOf = (args) => {
  const entries = Object.entries(args);
  if (entries.length !== 1) return null;
  const [[head, filter]] = entries;
  if (['AND', 'OR'].includes(head) || filter.quantifier) return null;
  if (!filter.terms) return { field: head, operator: filter.operator, value: filter.value };
  return filter.terms.length === 1 ? { field: `${head}.${filter.terms[0].path}`, operator: filter.terms[0].operator, value: filter.terms[0].value } : null;
};
// The surfaces of a row: its field filter, or its explicit group, then the same condition as an AND condition and in an
// OR branch beside NOTHING. A quantified field filter has its field filter only.
const surfaces = (item) => {
  if (item.frame) {
    const { quantifier, path, condition } = item.frame;
    return [['explicit group', item.args], ['OR branch', { OR: [{ [quantifier]: [{ path, conditions: [{ ...condition }] }] }, { conditions: [NOTHING] }] }]];
  }
  const condition = item.condition ?? conditionOf(item.args);
  if (!condition) return [['field filter', item.args]];
  return [
    ['field filter', item.args],
    ['AND condition', { AND: [{ conditions: [{ ...condition }] }] }],
    ['OR branch', { OR: [{ conditions: [{ ...condition }] }, { conditions: [NOTHING] }] }],
  ];
};
const argumentType = (name, value) => {
  if (['AND', 'OR'].includes(name)) return '[QLFilterGroup]';
  return value?.terms ? 'QLTypeFilterExpression' : 'QLFilter';
};
// A query whose field `name` receives each argument of `args` as a variable, plus `rest`; `wrap` places that field.
const operation = (name, args, { selection = 'key', rest = BY_KEY, wrap = (inner) => inner } = {}) => {
  const names = Object.keys(args);
  const declared = names.map((key) => `$${key}:${argumentType(key, args[key])}`).join(',');
  const passed = [...names.map((key) => `${key}:$${key}`), rest].filter(Boolean).join(',');
  return { source: `query${declared ? `(${declared})` : ''}{${wrap(`${name}${passed ? `(${passed})` : ''}{${selection}}`)}}`, variables: args };
};
const contextOf = (shape) => (shape === 'admin' ? {} : { scopes: [shape] });
const keysOf = (rows) => rows.map((row) => row.key).join(' ');
const groupsOf = (rows) => rows.map((row) => `${row.groupId} ${row.facts.n}`).sort().join(', ');
const errorOf = ({ errors: [error] }) => `${error.extensions?.code} ${error.extensions?.status}: ${error.message}`;

describe.skipIf(!mongoUri || !postgresUri)('MongoDB/PostgreSQL list operator parity', () => {
  const namespace = `ql_parity_${randomUUID().replaceAll('-', '')}`;
  let pool; let backends; let unicode16;
  // Runs an operation on a backend with a fresh copy of `context`, which receives the count of a counted page.
  const ask = async (backend, source, variableValues, context = {}) => {
    const contextValue = structuredClone(context);
    const result = await graphql({ schema: backend.schema, source, variableValues, contextValue });
    return { result, count: contextValue.count };
  };
  // A root's list endpoint: a type key of the list operator fixture, or an endpoint of the text fixture.
  const endpoint = (backend, root) => (root.startsWith('qt') ? root : backend.types.roots[root].plural);
  const listed = async (backend, root, args, context, rest = BY_KEY) => {
    const name = endpoint(backend, root);
    const { source, variables } = operation(name, listOperatorArgs(args, backend.seeded), { rest });
    const { result, count } = await ask(backend, source, variables, context);
    if (result.errors) return errorOf(result);
    return rest === COUNTED ? `${keysOf(result.data[name])}, count ${count}` : keysOf(result.data[name]);
  };
  const aggregated = async (backend, root, args, groupId, context = {}) => {
    const name = `${endpoint(backend, root)}_aggregate`;
    const { source, variables } = operation(name, listOperatorArgs(args, backend.seeded), { selection: 'groupId facts', rest: aggregation(groupId) });
    const { result } = await ask(backend, source, variables, context);
    return result.errors ? errorOf(result) : groupsOf(result.data[name]);
  };
  // Runs `body` while counting the backend adapter's reads.
  const counting = async (backend, body) => {
    const originals = Object.fromEntries(READS.filter((method) => typeof backend.adapter[method] === 'function').map((method) => [method, backend.adapter[method]]));
    let reads = 0;
    for (const [method, original] of Object.entries(originals)) {
      backend.adapter[method] = function counted(...inputs) { reads += 1; return original.apply(this, inputs); };
    }
    try {
      return { outcome: await body(), reads };
    } finally {
      Object.assign(backend.adapter, originals);
    }
  };
  // The same rows on both backends: the lines each backend gives, and those the row expects, one per scope shape,
  // surface and read; the 403 shapes also read as an aggregate, and reach no adapter.
  const rowLines = async (item, root) => {
    const observed = [];
    const expected = [];
    for (const shape of [...Object.keys(item.rows), ...(item.forbidden ?? [])]) {
      for (const [surface, args] of surfaces(item)) {
        for (const backend of backends) {
          const label = `${shape} ${surface} ${backend.name}`;
          const context = contextOf(shape);
          if (item.forbidden?.includes(shape)) {
            for (const [read, run] of [
              ['listed', () => listed(backend, root, args, context)],
              ['counted', () => listed(backend, root, args, context, COUNTED)],
              ['aggregated', () => aggregated(backend, root, args, 'key', context)],
            ]) {
              const { outcome, reads } = await counting(backend, run);
              observed.push(`${label} ${read}: ${outcome}, ${reads} adapter reads`);
              expected.push(`${label} ${read}: ${forbidden(backend.prefix)}, 0 adapter reads`);
            }
            continue;
          }
          const keys = item.rows[shape];
          observed.push(`${label} listed: ${await listed(backend, root, args, context)}`);
          expected.push(`${label} listed: ${keys.join(' ')}`);
          observed.push(`${label} counted: ${await listed(backend, root, args, context, COUNTED)}`);
          expected.push(`${label} counted: ${keys.join(' ')}, count ${item.counts?.[shape] ?? keys.length}`);
          if (item.forbidden) {
            observed.push(`${label} aggregated: ${await aggregated(backend, root, args, 'key', context)}`);
            expected.push(`${label} aggregated: ${keys.map((key) => `${key} 1`).join(', ')}`);
          }
        }
      }
    }
    return { observed, expected };
  };
  // The items of every visible shop through the Shop.items collection field, batched and one parent at a time.
  const shopItemLines = async (item, fixture) => {
    const observed = [];
    const expected = [];
    for (const backend of backends) {
      const shops = fixture === 'list' ? backend.types.roots.shop.plural : 'qtShops';
      // Shop.items takes no argument named after its connection field, so a condition on shop goes in an AND group.
      const args = Object.hasOwn(item.args, 'shop') ? { AND: [{ conditions: [{ ...(item.condition ?? conditionOf(item.args)) }] }] } : item.args;
      const { source, variables } = operation('items', listOperatorArgs(args, backend.seeded), { wrap: (inner) => `${shops}(${BY_KEY}){key ${inner}}` });
      let batches = 0;
      const batch = backend.adapter.findChildrenBatch;
      const batching = backend.adapter.batchesChildren;
      for (const shape of Object.keys(item.rows)) {
        const visible = fixture === 'list' ? VISIBLE_SHOPS[shape] : ['S1', 'S2', 'S3'];
        const want = visible.map((shop) => `${shop}[${item.rows[shape].filter((key) => SHOP_OF[fixture][key] === shop).join(' ')}]`).join(' ');
        for (const mode of ['batched', 'one parent at a time']) {
          let result;
          try {
            if (mode === 'batched') backend.adapter.findChildrenBatch = function counted(...inputs) { batches += 1; return batch.apply(this, inputs); };
            else backend.adapter.batchesChildren = () => false;
            ({ result } = await ask(backend, source, variables, contextOf(shape)));
          } finally {
            backend.adapter.findChildrenBatch = batch;
            backend.adapter.batchesChildren = batching;
          }
          observed.push(`${shape} ${mode} ${backend.name}: ${result.errors ? errorOf(result) : result.data[shops].map((shop) => `${shop.key}[${keysOf(shop.items)}]`).join(' ')}`);
          expected.push(`${shape} ${mode} ${backend.name}: ${want}`);
        }
      }
      observed.push(`${backend.name} batched reads: ${batches > 0}`);
      expected.push(`${backend.name} batched reads: true`);
    }
    return { observed, expected };
  };
  // The outcome of one list query on each backend, by backend name: its keys, or its error.
  const outcomes = async (root, args, context = {}) => Object.fromEntries(await Promise.all(backends.map(async (backend) => [backend.name, await listed(backend, root, args, context)])));
  const alike = (value) => Object.fromEntries(backends.map(({ name }) => [name, value]));
  // The words each condition finds on each backend, one operation per 200 conditions, each condition an aliased field.
  const wordsOf = async (conditions) => {
    const found = {};
    for (const backend of backends) {
      found[backend.name] = [];
      for (let start = 0; start < conditions.length; start += 200) {
        const chunk = conditions.slice(start, start + 200);
        const source = `query(${chunk.map((_, index) => `$f${index}:QLFilter`).join(',')}){${chunk.map((_, index) => `f${index}:qtWords(word:$f${index},${BY_KEY}){key}`).join(' ')}}`;
        const { result } = await ask(backend, source, Object.fromEntries(chunk.map((condition, index) => [`f${index}`, condition])));
        expect(result.errors, backend.name).toBeUndefined();
        chunk.forEach((_, index) => found[backend.name].push(result.data[`f${index}`].map((row) => row.key)));
      }
    }
    return found;
  };

  const VIEWS = {
    qlItemsWithTags: (types) => ({
      type: types.Item, description: 'Items with every tag', params: { codes: { type: new GraphQLList(GraphQLString) } },
      where: ({ params }) => [{ conditions: [{ field: 'tags', operator: 'CONTAINS_ALL', value: params.codes }] }],
    }),
    qlItemsNamed: (types) => ({
      type: types.Item, description: 'Items with one of the names, ignoring case', params: { names: { type: new GraphQLList(GraphQLString) } },
      where: ({ params }) => [{ conditions: [{ field: 'name', operator: 'IIN', value: params.names }] }],
    }),
  };

  beforeAll(async () => {
    await mongoose.connect(mongoUri, { dbName: namespace });
    pool = new pg.Pool({ connectionString: postgresUri });
    backends = [
      { name: 'mongodb', prefix: 'Qlm', adapter: createMongoAdapter({ batchedCollections: true }) },
      { name: 'postgres', prefix: 'Ql', adapter: createSQLAdapter(postgresPlugin({ pool, schema: namespace, batchedCollections: true })) },
    ];
    for (const backend of backends) {
      backend.api = createRuntime(backend.adapter);
      if (backend.name === 'mongodb') backend.api.preventCreatingCollection(true);
      backend.types = createListOperatorTypes(null, { backend: backend.name, scopes: true });
      registerListOperatorTypes(backend.api, backend.types);
      registerTextOperatorFixture(backend.api, createTextOperatorFixture());
      for (const [name, view] of Object.entries(VIEWS)) backend.api.registerView(name, view(backend.types));
      backend.schema = backend.api.createSchema();
      if (backend.adapter.initialize) await backend.adapter.initialize();
      else for (const { model } of backend.api.getRegistrations()) if (model) { await model.createCollection(); await model.init(); }
      const execute = (source, variableValues) => graphql({ schema: backend.schema, source, variableValues, contextValue: {} });
      backend.seeded = await seedListOperators(execute, backend.name);
      await seedTextOperatorFixture(execute);
    }
    unicode16 = (await pool.query('SELECT lower(chr(42972) COLLATE "pg_catalog"."und-x-icu") = chr(411) AS folds')).rows[0].folds;
  }, 120000);
  afterAll(async () => {
    if (mongoose.connection.readyState) { await mongoose.connection.db.dropDatabase(); await mongoose.disconnect(); }
    if (pool) { await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); await pool.end(); }
  });

  // Every row of 9.3 that returns keys, in every scope shape it names, on every surface: the CONTAINS_ALL rows, the
  // group-level joined scopes, the frames, the frames through scoped references, the empty IIN lists, the IIN rows, the
  // shopTags rows and the 403's admin keys, whose scope shapes give FORBIDDEN_FILTER_PATH with no adapter read.
  it.each(LIST_OPERATOR_CASES.map((item) => [`${item.guard ? 'guard: ' : ''}${item.bullet}: ${item.name}`, item]))('%s, in every scope shape, listed and counted, on every surface', async (name, item) => {
    const { observed, expected } = await rowLines(item, 'item');
    expect(observed).toEqual(expected);
  }, 60000);

  // Not the frames through the scoped references reviews.item.shop, where a hidden shop is also a hidden parent, nor
  // the 403; the scope-free ANY shop rows run here.
  it.each(LIST_OPERATOR_CASES.filter((item) => item.bullet !== 'The 403' && !(item.bullet === 'Frames through scoped references' && item.frame.path === 'reviews'))
    .map((item) => [`${item.guard ? 'guard: ' : ''}${item.bullet}: ${item.name}`, item]))('%s, through the Shop.items collection field, batched and one parent at a time', async (name, item) => {
    const { observed, expected } = await shopItemLines(item, 'list');
    expect(observed).toEqual(expected);
  }, 60000);

  // The oracle "IIN is the union of IEQ" on the text fixture.
  it.each(IIN_ITEM_CASES.map((item) => [item.name, item]))('returns the same rows for %s, as IEQ returns them, listed and counted, on every surface', async (name, item) => {
    const { observed, expected } = await rowLines({ ...item, rows: { admin: item.keys } }, 'qtItems');
    expect(observed).toEqual(expected);
  }, 60000);

  it.each(IIN_ITEM_CASES.map((item) => [item.name, item]))('returns the same rows for %s through the Shop.items collection field, batched and one parent at a time', async (name, item) => {
    const { observed, expected } = await shopItemLines({ ...item, rows: { admin: item.keys } }, 'text');
    expect(observed).toEqual(expected);
  }, 60000);

  const FOLDING_ROWS = IIN_FOLDING_CASES.map(([operator, values, words, mongodb, difference]) => [`${operator} ${JSON.stringify(values)}${difference ? `, which differs on ${difference}` : ''}`, values, words, mongodb]);
  it.each(FOLDING_ROWS)('folds case for %s', async (name, values, words, mongodb) => {
    const found = await wordsOf([{ operator: 'IIN', value: values }]);
    expect({ mongodb: found.mongodb[0], postgres: found.postgres[0] }).toEqual({ mongodb: mongodb ?? words, postgres: words });
  });

  // The same words as a field filter, an AND condition and in an OR branch beside a condition that matches nothing,
  // listed and counted; QtWord has no name field, so that condition is word EQ "zzz".
  it.each(FOLDING_ROWS)('folds case for %s as a field filter, an AND condition and an OR branch, listed and counted', async (name, values, words, mongodb) => {
    const condition = { field: 'word', operator: 'IIN', value: values };
    const forms = [
      ['field filter', { word: { operator: 'IIN', value: values } }],
      ['AND condition', { AND: [{ conditions: [{ ...condition }] }] }],
      ['OR branch', { OR: [{ conditions: [{ ...condition }] }, { conditions: [{ field: 'word', operator: 'EQ', value: 'zzz' }] }] }],
    ];
    const observed = [];
    const expected = [];
    for (const backend of backends) {
      const keys = backend.name === 'mongodb' ? mongodb ?? words : words;
      for (const [surface, args] of forms) {
        observed.push(`${surface} ${backend.name} listed: ${await listed(backend, 'qtWords', args, {})}`);
        expected.push(`${surface} ${backend.name} listed: ${keys.join(' ')}`);
        observed.push(`${surface} ${backend.name} counted: ${await listed(backend, 'qtWords', args, {}, COUNTED)}`);
        expected.push(`${surface} ${backend.name} counted: ${keys.join(' ')}, count ${keys.length}`);
      }
    }
    expect(observed).toEqual(expected);
  }, 60000);

  it('folds Unicode 16 letters with IIN on PostgreSQL only with an ICU that knows them, never on MongoDB 8.0', async () => {
    const found = await wordsOf([[WORDS.w25], [WORDS.w26], [WORDS.w25, WORDS.w26]].map((value) => ({ operator: 'IIN', value })));
    expect(found).toEqual({
      mongodb: [['w25'], ['w26'], ['w25', 'w26']],
      postgres: [unicode16 ? ['w25', 'w26'] : ['w25'], unicode16 ? ['w25', 'w26'] : ['w26'], ['w25', 'w26']],
    });
  });

  it('returns with IIN, on each backend, the words IEQ returns for each value and the union for several, and differs between the backends only on the accepted words', async () => {
    const accepted = [...ACCEPTED_FOLDING_DIFFERENCES.dottedCapitalI, ...(unicode16 ? ACCEPTED_FOLDING_DIFFERENCES.unicode16 : [])];
    const forms = Object.values(WORDS).map((word) => [...new Set([word, word.toUpperCase(), word.toLowerCase()])]);
    const values = [...new Set(forms.flat())];
    const conditions = [
      ...values.map((value) => ({ operator: 'IEQ', value })),
      ...values.map((value) => ({ operator: 'IIN', value: [value] })),
      ...forms.map((value) => ({ operator: 'IIN', value })),
    ];
    const found = await wordsOf(conditions);
    const differences = [];
    for (const backend of backends) {
      const ieq = Object.fromEntries(values.map((value, index) => [value, found[backend.name][index]]));
      values.forEach((value, index) => {
        const iin = found[backend.name][values.length + index];
        if (JSON.stringify(iin) !== JSON.stringify(ieq[value])) differences.push(`${backend.name}: IIN ${JSON.stringify([value])} gives ${iin.join(', ')}, IEQ ${ieq[value].join(', ')}`);
      });
      forms.forEach((value, index) => {
        const iin = found[backend.name][2 * values.length + index];
        const union = [...new Set(value.flatMap((item) => ieq[item]))].sort();
        if (JSON.stringify(iin) !== JSON.stringify(union)) differences.push(`${backend.name}: IIN ${JSON.stringify(value)} gives ${iin.join(', ')}, the union of IEQ ${union.join(', ')}`);
      });
    }
    conditions.forEach(({ operator, value }, index) => {
      if (operator !== 'IIN') return;
      const onlyMongo = found.mongodb[index].filter((key) => !found.postgres[index].includes(key));
      const onlyPostgres = found.postgres[index].filter((key) => !found.mongodb[index].includes(key) && !accepted.includes(key));
      if (onlyMongo.length || onlyPostgres.length) differences.push(`IIN ${JSON.stringify(value)}: only MongoDB ${onlyMongo.join(', ') || '-'}, only PostgreSQL ${onlyPostgres.join(', ') || '-'}`);
    });
    expect(values.length).toBeGreaterThan(Object.keys(WORDS).length);
    expect(differences).toEqual([]);
  }, 60000);

  describe('aggregates', () => {
    it('filters the joined reviews of the J prefix reviews with IIN and groups them under their stored spelling', async () => {
      const results = {};
      for (const backend of backends) results[backend.name] = await aggregated(backend, 'item', inGroup('reviews.author', 'IIN', ['ANA', 'bob']), 'reviews.author');
      expect(results).toEqual(alike('ANA 1, Ana 1, bob 1'));
    });

    it('filters the records by CONTAINS_ALL on their own list in an aggregate grouped by the J prefix reviews', async () => {
      const results = {};
      for (const backend of backends) results[backend.name] = await aggregated(backend, 'item', field('tags', 'CONTAINS_ALL', ['A', 'B']), 'reviews.author');
      expect(results).toEqual(alike('Ana 1, bob 1, null 1'));
    });

    it('rejects CONTAINS_ALL through the J prefix reviews with the shorthand message', async () => {
      const results = {};
      for (const backend of backends) {
        results[backend.name] = [
          await aggregated(backend, 'item', inGroup('reviews.tags', 'CONTAINS_ALL', ['x']), 'reviews.author'),
          await aggregated(backend, 'item', field('reviews.tags', 'CONTAINS_ALL', ['x']), 'reviews.author'),
        ];
      }
      expect(results).toEqual(alike([SHORTHAND, SHORTHAND]));
    });

    it('cuts an IIN shorthand below the J prefix items into a frame anchored at items', async () => {
      const results = {};
      for (const backend of backends) results[backend.name] = await aggregated(backend, 'shop', inGroup('items.reviews.author', 'IIN', ['ana']), 'items.name');
      expect(results).toEqual(alike('TWO 1, one 1'));
    });
  });

  // [label, root, args, outcome by backend or for both, scope shapes (admin by default)]. An outcome is the keys a
  // list query returns or `<code> <status>: <message>`.
  const REJECTIONS = [
    // CONTAINS_ALL on a scalar with no embedded list before it, and on an inferred inverse reference.
    ...[['name', ['one']], ['id', ['<id:I1>']], ['dims.label', ['L']], ['box.label', ['x']], ['shop.name', ['Alpha']]]
      .map(([path, value]) => [`CONTAINS_ALL on ${path}`, 'item', field(path, 'CONTAINS_ALL', value), notList(path)]),
    ['CONTAINS_ALL on the inferred inverse reference Note.itemId', 'note', field('itemId', 'CONTAINS_ALL', ['<id:I1>']), notList('itemId')],
    // CONTAINS_ALL on an object field: an embedded object or list, a reference or a collection at the end.
    // The runtime's gates keep the validator's shared message for them.
    ...['dims', 'lines', 'box', 'shop', 'reviews'].map((path) => [`CONTAINS_ALL on the object field ${path}`, 'item', inGroup(path, 'CONTAINS_ALL', ['A']),
      'MISSING_FILTER_PATH 400: Filter on object field requires a scalar path']),
    ...['box.shop', 'parts.shop', 'shop.items', 'reviews.item'].map((path) => [`CONTAINS_ALL on the object field ${path}`, 'item', inGroup(path, 'CONTAINS_ALL', ['A']),
      'INVALID_FILTER_PATH 400: Filter on object field requires a scalar path']),
    // CONTAINS_ALL through a collection, as an AND condition and as the shorthand term, and through a reference after
    // an embedded list.
    ...[['reviews.tags', ['x']], ['shop.items.tags', ['A']], ['notes.itemId', ['<id:I1>']]].flatMap(([path, value]) => [
      [`CONTAINS_ALL through a collection: ${path} as an AND condition`, 'item', inGroup(path, 'CONTAINS_ALL', value), SHORTHAND],
      [`CONTAINS_ALL through a collection: ${path} as a field filter`, 'item', field(path, 'CONTAINS_ALL', value), SHORTHAND],
    ]),
    ...[['parts.shop.tags', ['a']], ['parts.shop.slines.sku', ['A']]].flatMap(([path, value]) => [
      [`CONTAINS_ALL through the reference parts.shop after an embedded list: ${path} as an AND condition`, 'item', inGroup(path, 'CONTAINS_ALL', value), crossing('parts.shop')],
      [`CONTAINS_ALL through the reference parts.shop after an embedded list: ${path} as a field filter`, 'item', field(path, 'CONTAINS_ALL', value), crossing('parts.shop')],
    ]),
    // IIN on a field that is not String, the inferred inverse reference included.
    ...['kinds', 'id', 'ids', 'ranks', 'scores', 'flags', 'ats', 'shop.id'].map((path) => [`IIN on the field ${path}, which is not String`, 'item', field(path, 'IIN', ['x']), notString(path)]),
    ['IIN on the inferred inverse reference Note.itemId', 'note', field('itemId', 'IIN', ['x']), notString('itemId')],
    // The value rules of 2.5, as the GraphQL contexts word them.
    ...[['null', null], ['no value', undefined]].map(([label, value]) => [`CONTAINS_ALL with ${label}`, 'item', field('tags', 'CONTAINS_ALL', value), invalidValue('Expected a scalar filter value')]),
    ...[['[null]', [null]], ['a nested list', [['a']]], ['an object element', [{}]], ['an object element beside a string', ['A', { a: 1 }]]]
      .map(([label, value]) => [`CONTAINS_ALL with ${label}`, 'item', field('tags', 'CONTAINS_ALL', value), invalidValue('Filter lists require non-null scalar elements')]),
    ['CONTAINS_ALL with a string', 'item', field('tags', 'CONTAINS_ALL', 'A'), invalidValue('CONTAINS_ALL requires an array value')],
    ['CONTAINS_ALL with []', 'item', field('tags', 'CONTAINS_ALL', []), invalidValue('CONTAINS_ALL requires a non-empty list')],
    ...[['a string', 'a'], ['null', null], ['no value', undefined]].map(([label, value]) => [`IIN with ${label}`, 'item', field('name', 'IIN', value), invalidValue('IIN requires an array value on name')]),
    ...[['[null]', [null]], ['a number element', ['a', 5]], ['a nested list', [['a']]]].map(([label, value]) => [`IIN with ${label}`, 'item', field('name', 'IIN', value), invalidValue('IIN requires non-null string elements on name')]),
    ['IIN with U+0000', 'item', field('name', 'IIN', ['a\u0000']), invalidValue('IIN values cannot contain U+0000 on name')],
    // MongoDB checks each pattern against its limit of 32,764 bytes: ^, the escaped value and \z. PostgreSQL binds
    // the values and has no such limit.
    ['IIN with a value of 32,761 characters, which runs on both', 'item', field('name', 'IIN', ['a'.repeat(32761)]), ''],
    ['IIN with a value of 32,762 characters, rejected by MongoDB only', 'item', field('name', 'IIN', ['ok', 'a'.repeat(32762)]), {
      mongodb: invalidValue('IIN value on name is too long: MongoDB accepts regular expressions of at most 32764 bytes, and this one has 32765'), postgres: '',
    }],
    // Frame-relative rejections, as an explicit group and as a quantified field filter; the reference after an
    // embedded list stays a 400 under shopNE, since the validator runs before the scopes are filled.
    ...[
      ['ANY reviews: author CONTAINS_ALL ["x"]', 'reviews', 'author', ['x'], notList('author'), ['admin']],
      ['ANY reviews: item.parts.shop.tags CONTAINS_ALL ["a"]', 'reviews', 'item.parts.shop.tags', ['a'], crossing('item.parts.shop'), ['admin', 'shopNE']],
      ['ANY shop: items.tags CONTAINS_ALL ["A"]', 'shop', 'items.tags', ['A'], SHORTHAND, ['admin']],
    ].flatMap(([label, path, relative, value, outcome, shapes]) => [
      [`${label} as an explicit group`, 'item', framed('ANY', path, { field: relative, operator: 'CONTAINS_ALL', value }), outcome, shapes],
      [`${label} as a quantified field filter`, 'item', { [path]: { quantifier: 'ANY', terms: [{ path: relative, operator: 'CONTAINS_ALL', value }] } }, outcome, shapes],
    ]),
    // ID casts, inherited from IN (issue 2.3): MongoDB reports a malformed identifier as INVALID_FILTER_VALUE,
    // PostgreSQL as NOT_VALID_ID. Neither needs the seeded line ids: both fail while compiling.
    ...['ids', 'lines.id'].map((path) => [`the inherited divergence of IN: CONTAINS_ALL with a malformed ID element on ${path}`, 'item', field(path, 'CONTAINS_ALL', ['not-an-id']), {
      mongodb: invalidValue(`Invalid value for ${path}`), postgres: 'NOT_VALID_ID 400: Expected a UUID identifier',
    }]),
    // Date numbers, inherited from IN: MongoDB reads a number as epoch milliseconds (d1 here), PostgreSQL takes only
    // dates and strings. I3's lines have no `at`.
    ['the inherited divergence of IN: CONTAINS_ALL with a number on the DateTime list ats', 'item', field('ats', 'CONTAINS_ALL', [Date.parse('2024-01-01T00:00:00.000Z')]), {
      mongodb: 'I1 I2 I3', postgres: invalidValue('Invalid date for ats'),
    }],
    ['the inherited divergence of IN: CONTAINS_ALL with a number on the DateTime member lines.at', 'item', field('lines.at', 'CONTAINS_ALL', [Date.parse('2024-01-01T00:00:00.000Z')]), {
      mongodb: 'I1 I2', postgres: invalidValue('Invalid date for at'),
    }],
    // Cast failures: MongoDB names the storage path, PostgreSQL's encodeScalar the leaf field.
    ...[
      ['ranks', [1.5], 'Expected a 32-bit integer for ranks'], ['ranks', ['x'], 'Expected a 32-bit integer for ranks'],
      ['ats', ['not-a-date'], 'Invalid date for ats'], ['lines.at', ['bad'], 'Invalid date for at'], ['kinds', ['FOUR'], 'Invalid enum value for kinds'],
      ['tags', [5], 'Expected a string for tags'], ['lines.qty', ['x'], 'Expected a 32-bit integer for qty'],
      ['scores', ['x'], 'Expected a finite number for scores'], ['flags', [1], 'Expected a boolean for flags'],
    ].map(([path, value, message]) => [`CONTAINS_ALL ${JSON.stringify(value)} on ${path}, which does not cast`, 'item', field(path, 'CONTAINS_ALL', value), {
      mongodb: invalidValue(`Invalid value for ${path}`), postgres: invalidValue(message),
    }]),
  ];

  it.each(REJECTIONS.map((row) => [row[0], row]))('%s: the outcome of 9.3 on each backend', async (label, [, root, args, outcome, shapes = ['admin']]) => {
    for (const shape of shapes) expect(await outcomes(root, args, contextOf(shape)), shape).toEqual(typeof outcome === 'string' ? alike(outcome) : outcome);
  });

  // A record identity declared String (decision 5): core accepts IIN and IEQ on it, MongoDB compiles them on _id and
  // returns no rows, PostgreSQL's compiler reads the uuid identity as ID; the inherited divergence of IEQ.
  const IDENTITY = [
    ['qlLabels(id <OP> [LB1])', 'label', (operator, value) => field('id', operator, value)],
    ['qlItems(label.id <OP> [LB1])', 'item', (operator, value) => field('label.id', operator, value)],
    ['qlItems(ANY label: id <OP> [LB1])', 'item', (operator, value) => framed('ANY', 'label', { field: 'id', operator, value })],
  ];
  it.each(IDENTITY.flatMap(([label, root, args]) => [[label.replace('<OP>', 'IIN'), root, args('IIN', ['<id:LB1>'])], [label.replace('<OP>', 'IIN').replace('[LB1]', '[]'), root, args('IIN', [])]]))(
    'the inherited divergence of IEQ: %s returns no rows on MongoDB and fails on PostgreSQL', async (label, root, args) => {
      expect(await outcomes(root, args)).toEqual({ mongodb: '', postgres: invalidValue('IIN requires a String field') });
    },
  );
  it.each(IDENTITY.map(([label, root, args]) => [label.replace('<OP>', 'IEQ').replace('[LB1]', 'LB1'), root, args('IEQ', '<id:LB1>')]))(
    'pin: the inherited divergence of IEQ: %s returns no rows on MongoDB and fails on PostgreSQL', async (label, root, args) => {
      expect(await outcomes(root, args)).toEqual({ mongodb: '', postgres: invalidValue('IEQ requires a String field') });
    },
  );

  describe('scopes', () => {
    // The adapter reads of a request on each backend, beside its outcome.
    const withReads = async (run) => Object.fromEntries(await Promise.all(backends.map(async (backend) => {
      const { outcome, reads } = await counting(backend, () => run(backend));
      return [backend.name, `${outcome}, ${reads > 0 ? 'some' : 'no'} adapter reads`];
    })));

    it('gives parts.shop.name EQ "Alpha" under the shopTags scope INVALID_FILTER_PATH naming parts.shop, with no adapter read', async () => {
      const args = inGroup('parts.shop.name', 'EQ', 'Alpha');
      // The legacy join through parts.shop: one row per distinct matching shop, and I6's two parts name S1.
      expect(await withReads((backend) => listed(backend, 'item', args, contextOf('admin')))).toEqual(alike('I1 I3 I6, some adapter reads'));
      expect(await withReads((backend) => listed(backend, 'item', args, contextOf('shopTags')))).toEqual(alike(`${crossing('parts.shop')}, no adapter reads`));
    });

    it('gives an aggregate on the J prefix reviews with reviews.item.name EQ "one" under the itemTags scope INVALID_FILTER_PATH, with no adapter read', async () => {
      const args = inGroup('reviews.item.name', 'EQ', 'one');
      expect(await withReads((backend) => aggregated(backend, 'item', args, 'reviews.author'))).toEqual(alike('Ana 1, bob 1, some adapter reads'));
      expect(await withReads((backend) => aggregated(backend, 'item', args, 'reviews.author', contextOf('itemTags')))).toEqual(alike(`${SHORTHAND}, no adapter reads`));
    });

    it.each(['byIdTags', 'byIdName'])('applies the get_by_id scope %s to qlItem(id) alike', async (shape) => {
      const results = {};
      for (const backend of backends) {
        const single = backend.types.roots.item.single;
        const { result } = await ask(backend, `query($a:ID!,$b:ID!){a:${single}(id:$a){key} b:${single}(id:$b){key}}`, { a: backend.seeded.ids.I1, b: backend.seeded.ids.I2 }, contextOf(shape));
        results[backend.name] = result.errors ? errorOf(result) : result.data;
      }
      expect(results).toEqual(alike({ a: { key: 'I1' }, b: null }));
    });
  });

  it('reads the named views qlItemsWithTags and qlItemsNamed alike, and rejects an empty CONTAINS_ALL list per call', async () => {
    const results = {};
    for (const backend of backends) {
      const view = async (source) => {
        const { result } = await ask(backend, source, {});
        return result.errors ? errorOf(result) : keysOf(Object.values(result.data)[0]);
      };
      results[backend.name] = [
        await view(`{qlItemsWithTags(codes:["A","B"],${BY_KEY}){key}}`),
        await view(`{qlItemsWithTags(codes:[],${BY_KEY}){key}}`),
        await view(`{qlItemsNamed(names:["one"],${BY_KEY}){key}}`),
      ];
    }
    expect(results).toEqual(alike(['I1 I3', invalidValue('CONTAINS_ALL requires a non-empty list'), 'I1']));
  });

  it('runs 70,001 IIN values on name and 70,001 CONTAINS_ALL values on box.tags alike', async () => {
    const names = ['ONE', ...Array.from({ length: 70000 }, (_, index) => `name ${index}`)];
    const tags = ['p', ...Array.from({ length: 70000 }, (_, index) => `tag ${index}`)];
    expect(await outcomes('item', field('name', 'IIN', names))).toEqual(alike('I1'));
    expect(await outcomes('item', field('box.tags', 'CONTAINS_ALL', tags))).toEqual(alike(''));
  }, 120000);
});
