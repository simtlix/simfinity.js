// Collection frames on both real engines, with a namespace independent of the dedicated compiler suites.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { graphql, GraphQLList } from 'graphql';
import mongoose from 'mongoose';
import pg from 'pg';
import { createRuntime } from '../../packages/core/src/index.js';
import { createMongoAdapter } from '../../packages/mongodb/src/mongo/adapter.js';
import { postgresPlugin } from '../../packages/postgres/src/index.js';
import { createSQLAdapter } from '../../packages/sql/src/adapter.js';
import { createContractModelFixtures } from '../contracts/model-fixtures.js';
import { COLLECTION_AGGREGATES, COLLECTION_ANCHOR_ROWS, COLLECTION_CASES, COLLECTION_DATA, seedCollectionFrames } from '../helpers/collection-frames.js';
import { REFERENCE_SHAPES, createReferenceEmptinessTypes, registerReferenceEmptinessTypes } from '../helpers/query-emptiness.js';

const mongoUri = process.env.SIMFINITY_MONGODB_URI;
const postgresUri = process.env.SIMFINITY_POSTGRES_URI;
const condition = (field, value, operator = 'EQ') => ({ field, value, operator });
const group = (...conditions) => ({ AND: [{ conditions }] });
const aggregation = (groupId = 'key') => ({ groupId, facts: [{ path: 'id', operation: 'COUNT', factName: 'n' }] });
const sorted = (rows) => rows.map((row) => row.key).sort();
const pins = new Set(['ALL alone', 'ALL alone AND neutral', 'reference inside frame EQ', 'ALL reference shop alone', 'ALL reference pro alone']);
const shapes = REFERENCE_SHAPES;

describe.skipIf(!mongoUri || !postgresUri)('MongoDB/PostgreSQL collection frame parity', () => {
  const namespace = `qframes_parity_${randomUUID().replaceAll('-', '')}`;
  let pool; let backends;
  const run = (backend, root, args, shape = 'admin', mode = 'find', extra = {}) => {
    const context = { shape, ...extra };
    const field = backend.schema.getQueryType().getFields()[`${backend.types.roots[root].plural}${mode === 'aggregate' ? '_aggregate' : ''}`];
    return field.resolve(null, structuredClone(args), context);
  };
  const compare = async (root, args, shape, expected, mode = 'find', extra = {}) => {
    const values = [];
    for (const backend of backends) {
      const rows = await run(backend, root, args, shape, mode, extra);
      values.push(mode === 'find' ? sorted(rows) : rows.map((row) => [row.groupId, row.facts.n]).sort());
    }
    expect(values[1], `${shape} ${JSON.stringify(args)}`).toEqual(values[0]);
    expect(values[0]).toEqual(expected);
  };
  const write = async (backend, root, input) => {
    const descriptor = backend.types.roots[root];
    const result = await graphql({ schema: backend.schema, source: `mutation($input:${descriptor.type.name}Input!){add${descriptor.single}(input:$input){id key}}`, variableValues: { input } });
    expect(result.errors).toBeUndefined();
    return Object.values(result.data)[0];
  };
  beforeAll(async () => {
    if (!mongoUri || !postgresUri) throw new Error('Both supplied database URIs are required');
    await mongoose.connect(mongoUri, { dbName: namespace });
    pool = new pg.Pool({ connectionString: postgresUri });
    backends = [
      { name: 'mongodb', adapter: createMongoAdapter({ batchedCollections: true }) },
      { name: 'postgres', adapter: createSQLAdapter(postgresPlugin({ pool, schema: namespace, batchedCollections: true })) },
    ];
    for (const backend of backends) {
      backend.api = createRuntime(backend.adapter);
      const hooks = Object.fromEntries(['shop', 'pro', 'product', 'review'].map((key) => [key,
        Object.fromEntries(['find', 'aggregate', 'get_by_id'].map((operation) => [operation, (params) => params.context?.scope?.[key]?.[operation]?.(params)])),
      ]));
      backend.types = createReferenceEmptinessTypes('Qfp', { backend: backend.name, scopes: hooks });
      backend.types.Review.getFields().lines = { name: 'lines', type: new GraphQLList(backend.types.embedded[1]), args: [], extensions: { relation: { embedded: true } } };
      backend.types.Review.getFields().item = { name: 'item', type: backend.types.Product, args: [], extensions: { relation: { embedded: false } } };
      backend.contract = createContractModelFixtures();
      if (backend.name === 'mongodb') backend.api.preventCreatingCollection(true);
      registerReferenceEmptinessTypes(backend.api, backend.types);
      for (const registration of backend.contract.registrations) {
        if (registration.endpoint) backend.api.connect(null, registration.gqltype, registration.simpleEntityEndpointName, registration.listEntitiesEndpointName, registration.controller);
        else backend.api.addNoEndpointType(registration.gqltype);
      }
      backend.api.use(async (params, next) => { await params.context?.middleware?.(params); await next(); });
      backend.schema = backend.api.createSchema();
      if (backend.adapter.initialize) await backend.adapter.initialize();
      else for (const { model } of backend.api.getRegistrations()) if (model) { await model.createCollection(); await model.init(); }
      backend.ids = await seedCollectionFrames(backend.schema, backend.types);
      for (const [title, seasons] of [
        ['all', [[30], [40, 10]]], ['some', [[30], [10]]], ['none', [[10], []]], ['empty', []],
      ]) {
        const input = { tenant: 'a', title, seasons: { added: seasons.map((durations, index) => ({ number: index + 1, episodes: { added: durations.map((duration, n) => ({ title: `${title}-${index}-${n}`, kind: 'episode', duration })) } })) } };
        const result = await graphql({ schema: backend.schema, source: 'mutation($input:ContractSerieInput!){addcontractserie(input:$input){id}}', variableValues: { input } });
        expect(result.errors).toBeUndefined();
      }
    }
  }, 60000);
  afterAll(async () => {
    if (mongoose.connection.readyState) { await mongoose.connection.db.dropDatabase(); await mongoose.disconnect(); }
    if (pool) { await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); await pool.end(); }
  });

  it.each(COLLECTION_CASES.map((item) => [(pins.has(item.name) ? 'pin: ' : '') + item.name, item]))('%s: same rows, count, pages and aggregate in every scope shape', async (name, item) => {
    for (const shape of shapes) {
      if (item.forbidden?.includes(shape)) {
        for (const backend of backends) for (const mode of ['find', 'aggregate']) await expect(run(backend, item.root, { ...item.args, ...(mode === 'aggregate' ? { aggregation: aggregation() } : {}) }, shape, mode)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN_FILTER_PATH' } });
        continue;
      }
      await compare(item.root, item.args, shape, item.rows[shape]);
      if (item.name === 'duplication: rating') {
        await compare('product', { reviews: { terms: [{ path: 'rating', operator: 'GTE', value: 1 }] } }, shape, item.rows[shape]);
        await compare('product', group({ field: 'reviews', path: 'rating', operator: 'GTE', value: 1 }), shape, item.rows[shape]);
      }
      await compare(item.root, { ...item.args, aggregation: aggregation() }, shape, item.rows[shape].map((key) => [key, 1]).sort(), 'aggregate');
      for (const backend of backends) {
        const field = backend.schema.getQueryType().getFields()[backend.types.roots[item.root].plural];
        for (const page of [1, 2]) {
          const context = { shape };
          const rows = await field.resolve(null, { ...structuredClone(item.args), pagination: { page, size: 3, count: true }, sort: { terms: [{ field: 'key', order: 'ASC' }] } }, context);
          expect(sorted(rows)).toEqual(item.rows[shape].slice((page - 1) * 3, page * 3));
          expect(context.count).toBe(item.rows[shape].length);
        }
      }
    }
  }, 60000);

  it.each(COLLECTION_AGGREGATES.map((item) => [(item.filter === 'rating1' ? '' : 'pin: ') + item.name, item]))('%s: J conditions inside groups preserve aggregate facts', async (name, item) => {
    const filter = !item.filter ? {} : item.filter === 'twoGroups' ? { AND: [{ conditions: [condition('reviews.rating', 4, 'GTE')] }, { conditions: [condition('reviews.author', 'x')] }] } : group(condition('reviews.rating', item.filter === 'rating1' ? 1 : 5, 'GTE'));
    for (const shape of shapes) {
      const values = [];
      for (const backend of backends) {
        const result = run(backend, 'product', { ...filter, aggregation: { groupId: item.groupId, facts: item.facts } }, shape, 'aggregate');
        if (item.forbidden?.includes(shape)) await expect(result).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN_FILTER_PATH' } });
        else values.push((await result).map((row) => [row.groupId, ...item.facts.map((fact) => row.facts[fact.factName])]).sort((a, b) => String(a[0] ?? '').localeCompare(String(b[0] ?? ''))));
      }
      if (values.length) { expect(values[1]).toEqual(values[0]); expect(values[0]).toEqual(item.rowsByShape[shape]); }
    }
  });
  it('anchors later collections after J and references using the extended seed', async () => {
    for (const [key, field, value] of [['reviewsPerProduct', 'products.reviews.rating', 1], ['referenceChain', 'products.pro.shop.products.name', 'Ka']]) for (const shape of shapes) {
      await compare('shop', { ...group(condition(field, value, key === 'reviewsPerProduct' ? 'GTE' : 'EQ')), aggregation: aggregation('products.key') }, shape, COLLECTION_ANCHOR_ROWS[key][shape], 'aggregate');
    }
    // A missing shop contributes the aggregate's null row, never an orphan child with a null connection key.
    for (const shape of shapes) {
      const expected = ['EQ', 'shopEQ'].includes(shape) ? [['E', 3], ['F', 3], ['Ka', 3]]
        : [[null, 1], ['D', 1], ['E', 3], ['F', 3], ['Ka', 3], ...(['NE', 'shopNE'].includes(shape) ? [] : [['c', 1]])];
      await compare('product', { aggregation: aggregation('shop.products.key') }, shape, expected.sort(), 'aggregate');
    }
  });
  it('pin: keeps no-later-collection J references as scoped legacy aggregate predicates', async () => {
    const args = { ...group(condition('products.pro.name', 'P2')), aggregation: aggregation('products.key') };
    await compare('shop', args, 'admin', [['F', 1], ['c', 1]], 'aggregate');
    await compare('shop', args, 'proOnly', [], 'aggregate');
  });
  it('keeps explicit ALL on a J prefix per record with nested collection frames', async () => {
    for (const shape of shapes) {
      const args = { aggregation: aggregation('products.reviews.author'), AND: [{ ALL: [{ path: 'products', conditions: [condition('reviews.rating', 5, 'GTE')] }] }] };
      if (['NE', 'EQ'].includes(shape)) for (const backend of backends) await expect(run(backend, 'shop', args, shape, 'aggregate')).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN_FILTER_PATH' } });
      else await compare('shop', args, shape, COLLECTION_ANCHOR_ROWS.universalProducts[shape].length ? [['hidden', 1], ['x', 1]] : [], 'aggregate');
    }
  });
  it.each(['ANY', 'ALL', 'NONE'])('quantified ContractSerie field filter %s nests ANY episodes per season', async (quantifier) => {
    const expected = { ANY: ['all', 'some'], ALL: ['all', 'empty'], NONE: ['empty', 'none'] }[quantifier];
    const results = [];
    for (const backend of backends) {
      const result = await graphql({ schema: backend.schema, source: `query{contractseries(seasons:{quantifier:${quantifier},terms:[{path:"episodes.duration",operator:GT,value:20}]},sort:{terms:[{field:"title",order:ASC}]}){title}}` });
      expect(result.errors).toBeUndefined();
      results.push(result.data.contractseries.map((row) => row.title));
    }
    expect(results).toEqual([expected, expected]);
  });
  it('reads collection fields with the same scoped frames batched and individually', async () => {
    for (const backend of backends) {
      const shops = await run(backend, 'shop', {}, 'admin');
      const field = backend.types.Shop.getFields().products;
      const batchRead = backend.adapter.findChildrenBatch;
      let batches = 0;
      backend.adapter.findChildrenBatch = function (...inputs) { batches++; return batchRead.apply(this, inputs); };
      try {
        for (const item of COLLECTION_CASES.filter((entry) => entry.root === 'product' && !entry.forbidden)) for (const shape of shapes) {
          const expected = shops.map((shop) => COLLECTION_DATA.product.filter((product) => product.shop === shop.key && item.rows[shape].includes(product.key)).map((product) => product.key).sort());
          const context = { shape };
          const batched = await Promise.all(shops.map((shop) => field.resolve(shop, structuredClone(item.args), context)));
          const individual = [];
          const batching = backend.adapter.batchesChildren;
          try {
            backend.adapter.batchesChildren = () => false;
            for (const shop of shops) individual.push(await field.resolve(shop, structuredClone(item.args), { shape }));
          } finally { backend.adapter.batchesChildren = batching; }
          expect(batched.map(sorted), `${backend.name} ${item.name} ${shape}`).toEqual(expected);
          expect(individual.map(sorted)).toEqual(expected);
        }
        expect(batches, `${backend.name} must exercise batching`).toBeGreaterThan(0);
      } finally { backend.adapter.findChildrenBatch = batchRead; }
    }
  }, 60000);
  it('scopes mixed trust in one witness and keeps a separately appended trusted group independent', async () => {
    const args = { reviews: { terms: [{ path: 'rating', operator: 'GTE', value: 4 }] } };
    const same = ({ type, args: query }) => { if (type.gqltype.name === 'QfpProduct' && query.reviews) query.reviews.terms.push({ path: 'author', value: 'x' }); };
    const separate = ({ type, args: query }) => { if (type.gqltype.name === 'QfpProduct') query.AND = [{ conditions: [condition('reviews.author', 'x')] }]; };
    for (const shape of shapes) {
      await compare('product', args, shape, ['E', 'Ka'], 'find', { middleware: same });
      await compare('product', args, shape, ['NE', 'EQ'].includes(shape) ? ['E', 'Ka'] : ['D', 'E', 'Ka'], 'find', { middleware: separate });
    }
  });
  it('ranges trusted middleware, own find and get_by_id scopes over stored children', async () => {
    for (const backend of backends) {
      const append = ({ args, type }) => { if (type.gqltype === backend.types.Product) args.AND = [...(args.AND ?? []), { ANY: [{ path: 'reviews', conditions: [condition('author', 'hidden')] }] }]; };
      for (const shape of shapes) {
        expect(sorted(await run(backend, 'product', {}, shape, 'find', { middleware: append }))).toEqual(['D', 'E', 'c']);
        expect(sorted(await run(backend, 'product', {}, shape, 'find', { scope: { product: { find: append } } }))).toEqual(['D', 'E', 'c']);
        const byId = backend.schema.getQueryType().getFields()[backend.types.roots.product.single];
        expect((await byId.resolve(null, { id: backend.ids.D }, { shape, scope: { product: { get_by_id: append } } })).key).toBe('D');
        const nullLeaf = ({ args }) => { args.reviews = { terms: [{ path: 'author', value: null }] }; };
        expect(await byId.resolve(null, { id: backend.ids.C }, { shape, scope: { product: { get_by_id: nullLeaf } } })).toBeNull();
      }
    }
  });
  it('uses 2b reference emptiness inside frames and rejects shorthand leaf emptiness', async () => {
    for (const shape of shapes) {
      await compare('product', { AND: [{ ANY: [{ path: 'reviews', conditions: [{ field: 'item', operator: 'IS_EMPTY' }] }] }] }, shape, ['NE', 'EQ'].includes(shape) ? ['D', 'E', 'Ka'] : ['D', 'E', 'Ka', 'c']);
      for (const backend of backends) for (const field of ['products.reviews', 'reviews.author']) await expect(run(backend, field.startsWith('products') ? 'shop' : 'product', { AND: [{ conditions: [{ field, operator: 'IS_EMPTY' }] }] }, shape)).rejects.toMatchObject({ extensions: { code: 'INVALID_FILTER_PATH' } });
    }
  });
  it('rejects sort through a collection before scopes in find and count modes', async () => {
    for (const backend of backends) for (const shape of shapes) for (const count of [false, true]) {
      let calls = 0;
      const scope = { product: { find: () => { calls++; } } };
      await expect(run(backend, 'product', { sort: { terms: [{ field: 'reviews.rating', order: 'ASC' }] }, pagination: { page: 1, size: 100, count } }, shape, 'find', { scope })).rejects.toMatchObject({ extensions: { code: 'INVALID_FILTER_PATH' } });
      expect(calls).toBe(0);
    }
  });
  it.each(['ANY', 'NONE'])('%s without a body equals live 2b collection and reference emptiness', async (quantifier) => {
    for (const backend of backends) for (const shape of shapes) for (const path of ['reviews', 'shop', 'pro']) {
      const framed = await run(backend, 'product', { AND: [{ [quantifier]: [{ path }] }] }, shape);
      const emptiness = await run(backend, 'product', { [path]: { terms: [{ operator: quantifier === 'ANY' ? 'IS_NOT_EMPTY' : 'IS_EMPTY' }] } }, shape);
      expect(sorted(framed)).toEqual(sorted(emptiness));
    }
  });
  it('guards embedded-list references inside collection frames and preserves trusted vector reads', async () => {
    for (const backend of backends) {
      const root = await write(backend, 'product', { key: 'embedded-root', name: 'embedded-root', olines: [{ qty: 1, shop: { id: backend.ids.S1 } }] });
      const child = await write(backend, 'review', { key: 'embedded-child', product: { id: root.id }, lines: [{ qty: 1, shop: { id: backend.ids.S1 } }] });
      try {
        for (const path of ['reviews.lines.shop.name', 'olines.shop.products.name']) {
          const value = path.startsWith('reviews') ? 'S1' : 'Ka';
          const args = { id: { value: root.id }, ...group(condition(path, value)) };
          for (const shape of shapes) {
            if (['NE', 'EQ', 'shopNE', 'shopEQ'].includes(shape)) {
              for (const mode of ['find', 'aggregate']) await expect(run(backend, 'product', { ...args, ...(mode === 'aggregate' ? { aggregation: aggregation() } : {}) }, shape, mode)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN_FILTER_PATH' } });
              await expect(run(backend, 'product', { ...args, pagination: { count: true } }, shape)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN_FILTER_PATH' } });
            } else expect(sorted(await run(backend, 'product', args, shape))).toEqual(['embedded-root']);
            const middleware = ({ args: query, type }) => { if (type.gqltype === backend.types.Product) Object.assign(query, group(condition(path, value))); };
            expect(sorted(await run(backend, 'product', { id: { value: root.id } }, shape, 'find', { middleware }))).toEqual(['embedded-root']);
          }
        }
        expect(sorted(await run(backend, 'product', { id: { value: root.id }, AND: [{ ALL: [{ path: 'reviews', conditions: [condition('author', 'x', 'NE')] }] }] }))).toEqual(['embedded-root']);
      } finally {
        for (const [kind, id] of [['review', child.id], ['product', root.id]]) {
          const result = await graphql({ schema: backend.schema, source: `mutation($id:ID!){delete${backend.types.roots[kind].single}(id:$id){id}}`, variableValues: { id } });
          expect(result.errors).toBeUndefined();
        }
      }
    }
  });
  it('preserves independent complete scope/body vector witnesses and one root after vector prefixes (R31–33)', async () => {
    for (const backend of backends) {
      const root = await write(backend, 'product', { key: 'vector-root', name: 'vector-root', stock: 1, olines: [{ qty: 1, shop: { id: backend.ids.S1 } }, { qty: 2, shop: { id: backend.ids.S3 } }] });
      const child = await write(backend, 'review', { key: 'vector-child', product: { id: root.id }, lines: [{ qty: 1, shop: { id: backend.ids.S1 } }, { qty: 2, shop: { id: backend.ids.S3 } }] });
      try {
        for (const quantifier of ['ANY', 'ALL', 'NONE']) {
          const args = { id: { value: root.id }, AND: [{ [quantifier]: [{ path: 'reviews', conditions: [condition('lines.shop.name', 'S3')] }] }] };
          const scope = { review: { find: ({ args: scoped }) => { Object.assign(scoped, group(condition('lines.shop.name', 'S1'))); } } };
          expect(sorted(await run(backend, 'product', args, 'admin', 'find', { scope }))).toEqual(quantifier === 'NONE' ? [] : ['vector-root']);
        }
        const prefix = { id: { value: root.id }, ...group(condition('olines.shop.products.name', ['Ka', 'D'], 'IN')) };
        expect(sorted(await run(backend, 'product', prefix))).toEqual(['vector-root']);
        const context = { shape: 'admin' };
        const field = backend.schema.getQueryType().getFields()[backend.types.roots.product.plural];
        expect(await field.resolve(null, { ...prefix, pagination: { count: true, page: 2, size: 1 } }, context)).toEqual([]);
        expect(context.count).toBe(1);
        // Vector-only joins retain their legacy multiplicity.
        expect(sorted(await run(backend, 'product', { id: { value: root.id }, ...group(condition('olines.shop.name', ['S1', 'S3'], 'IN')) }))).toEqual(['vector-root', 'vector-root']);
      } finally {
        const remove = async (kind, id) => {
          const single = backend.types.roots[kind].single;
          const result = await graphql({ schema: backend.schema, source: `mutation($id:ID!){delete${single}(id:$id){id}}`, variableValues: { id } });
          expect(result.errors).toBeUndefined();
        };
        await remove('review', child.id); await remove('product', root.id);
      }
    }
  });
});
