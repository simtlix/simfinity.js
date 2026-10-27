import { describe, expect, test, vi } from 'vitest';
import {
  GraphQLID, GraphQLInputObjectType, GraphQLList, GraphQLNonNull,
  GraphQLObjectType, GraphQLScalarType, GraphQLString, GraphQLUnionType, __Field, graphql, validateSchema,
} from 'graphql';
import { createRuntime } from '../packages/core/src/runtime.js';
import SimfinityError from '../packages/core/src/errors/simfinity.error.js';

const createAdapter = () => ({
  prepare: vi.fn(),
  createModel: vi.fn((type) => ({ name: type.name })),
  withTransaction: vi.fn(async (session, body) => body(session || { attempt: 1 })),
});

const entity = (name, extensions) => new GraphQLObjectType({
  name,
  fields: { id: { type: GraphQLID }, name: { type: GraphQLString } },
  extensions,
});

describe('registerCustomQuery', () => {
  test('executes a query-only schema with input, middleware and no transaction', async () => {
    const adapter = createAdapter();
    const runtime = createRuntime(adapter);
    const Input = new GraphQLInputObjectType({
      name: 'QueryAvailabilityInput',
      fields: { date: { type: new GraphQLNonNull(GraphQLString) } },
    });
    const Result = new GraphQLObjectType({
      name: 'QueryBusyRange',
      fields: { start: { type: GraphQLString } },
    });
    const context = { user: 'client' };
    const events = [];
    runtime.use(async (params, next) => {
      expect(params).toMatchObject({
        operation: 'custom_query', entry: 'availability', context,
        args: { input: { date: '2026-10-17' } },
      });
      expect(params.type).toBeUndefined();
      events.push('before');
      params.args.input.date = '2026-10-18';
      await next();
      events.push('after');
    });
    runtime.registerCustomQuery('availability', 'Busy times', Input, new GraphQLList(Result),
      (...args) => {
        expect(args).toEqual([{ date: '2026-10-18' }, context]);
        expect(args[1]).toBe(context);
        events.push('callback');
        return [{ start: '10:00' }];
      });

    const schema = runtime.createSchema();
    expect(validateSchema(schema)).toEqual([]);
    expect(schema.getMutationType()).toBeUndefined();
    expect(schema.getQueryType().getFields().availability.extensions.simfinityQuery).toBeUndefined();
    const result = await graphql({
      schema, source: '{ availability(input: { date: "2026-10-17" }) { start } }', contextValue: context,
    });
    expect(result).toEqual({ data: { availability: [{ start: '10:00' }] } });
    expect(events).toEqual(['before', 'after', 'callback']);
    expect(adapter.withTransaction).not.toHaveBeenCalled();
    expect(adapter.createModel).not.toHaveBeenCalled();
    expect(runtime.getRegistrations()).toEqual([]);

    const missingInput = await graphql({ schema, source: '{ availability { start } }' });
    expect(missingInput.errors?.[0].message).toContain('argument "input"');
    expect(events).toHaveLength(3);
  });

  test('passes no input as undefined and keeps registrations isolated from earlier schemas and runtimes', async () => {
    const runtime = createRuntime(createAdapter());
    const callback = vi.fn((input, context) => `${context.label}:${input}`);
    runtime.registerCustomQuery('health', null, null, GraphQLString, callback);
    const earlier = runtime.createSchema();
    runtime.registerCustomQuery('version', 'Version', undefined, GraphQLString, () => '3.9.0');
    const later = runtime.createSchema();
    expect(earlier.getQueryType().getFields().version).toBeUndefined();
    expect(later.getQueryType().getFields().version).toBeDefined();
    expect(earlier.getQueryType().getFields().health.args).toEqual([]);
    expect(await graphql({ schema: earlier, source: '{ health }', contextValue: { label: 'ok' } }))
      .toEqual({ data: { health: 'ok:undefined' } });

    const other = createRuntime(createAdapter());
    other.registerCustomQuery('health', 'Health', null, GraphQLString, () => 'other');
    expect(await graphql({ schema: other.createSchema(), source: '{ health }' }))
      .toEqual({ data: { health: 'other' } });
  });

  test('gives the callback a typed input copy without a transaction and keeps its errors', async () => {
    const adapter = createAdapter();
    const runtime = createRuntime(adapter);
    const DateTime = new GraphQLScalarType({
      name: 'QueryCopyDate', serialize: (value) => value.toISOString(), parseValue: (value) => new Date(value),
    });
    const Input = new GraphQLInputObjectType({
      name: 'QueryCopyInput',
      fields: { values: { type: new GraphQLList(GraphQLString) }, date: { type: DateTime } },
    });
    runtime.registerCustomQuery('report', 'Report', Input, GraphQLString, async (input) => {
      expect(input.date).toBeInstanceOf(Date);
      input.values.push('changed');
      return input.values.join(',');
    });
    const schema = runtime.createSchema();
    const variables = { input: { values: ['original'], date: '2026-10-17T00:00:00.000Z' } };
    expect(await graphql({
      schema, source: 'query($input: QueryCopyInput!) { report(input: $input) }', variableValues: variables,
    })).toEqual({ data: { report: 'original,changed' } });
    expect(variables.input.values).toEqual(['original']);
    expect(adapter.withTransaction).not.toHaveBeenCalled();

    const failure = new SimfinityError('Quote unavailable', 'QUOTE_UNAVAILABLE', 409);
    runtime.registerCustomQuery('failure', 'Failure', null, GraphQLString, async () => { throw failure; });
    const failed = await graphql({ schema: runtime.createSchema(), source: '{ failure }' });
    expect(failed.errors?.[0].originalError).toBe(failure);
    expect(failed.errors?.[0].extensions).toMatchObject({ code: 'QUOTE_UNAVAILABLE', status: 409 });
    expect(adapter.withTransaction).not.toHaveBeenCalled();
  });

  test('middleware rejection prevents callback and transaction creation', async () => {
    const adapter = createAdapter();
    const runtime = createRuntime(adapter);
    const callback = vi.fn(() => 'forbidden');
    runtime.use(() => { throw new Error('denied'); });
    runtime.registerCustomQuery('protectedReport', 'Report', null, GraphQLString, callback);
    const result = await graphql({ schema: runtime.createSchema(), source: '{ protectedReport }' });
    expect(result.errors?.[0].message).toBe('denied');
    expect(callback).not.toHaveBeenCalled();
    expect(adapter.withTransaction).not.toHaveBeenCalled();
  });

  test.each([
    ['empty name', { name: '' }],
    ['invalid name', { name: 'busy-times' }],
    ['reserved name', { name: '__busyTimes' }],
    ['invalid description', { description: 1 }],
    ['input scalar', { input: GraphQLString }],
    ['input object as output', { output: new GraphQLInputObjectType({ name: 'QueryInvalidOutput', fields: { value: { type: GraphQLString } } }) }],
    ['missing output', { output: undefined }],
    ['non-function callback', { callback: 'query' }],
  ])('rejects %s at registration without keeping the entry', (label, invalid) => {
    const runtime = createRuntime(createAdapter());
    const config = {
      name: 'report', description: label, input: null, output: GraphQLString, callback: () => 'ok', ...invalid,
    };
    expect(() => runtime.registerCustomQuery(config.name, config.description, config.input, config.output, config.callback))
      .toThrow(expect.objectContaining({ extensions: expect.objectContaining({ code: 'INVALID_QUERY_REGISTRATION', status: 500 }) }));
    runtime.registerCustomQuery('report', 'Report', null, GraphQLString, () => 'ok');
    expect(Object.keys(runtime.createSchema().getQueryType().getFields())).toEqual(['report']);
  });

  test('rejects a duplicate registration instead of replacing the callback', async () => {
    const runtime = createRuntime(createAdapter());
    runtime.registerCustomQuery('report', 'Report', null, GraphQLString, () => 'first');
    expect(() => runtime.registerCustomQuery('report', 'Replacement', null, GraphQLString, () => 'second'))
      .toThrow(expect.objectContaining({ extensions: expect.objectContaining({ code: 'QUERY_NAME_CONFLICT', status: 500 }) }));
    expect(await graphql({ schema: runtime.createSchema(), source: '{ report }' }))
      .toEqual({ data: { report: 'first' } });
  });

  test.each(['item', 'items', 'items_aggregate'])('rejects the generated %s collision before preparation in either registration order', (name) => {
    for (const customFirst of [true, false]) {
      const adapter = createAdapter();
      const runtime = createRuntime(adapter);
      const Item = entity(`QueryConflict${name}${customFirst}`);
      const custom = () => runtime.registerCustomQuery(name, 'Custom', null, GraphQLString, () => 'custom');
      if (customFirst) custom();
      runtime.connect(null, Item, 'item', 'items');
      if (!customFirst) custom();
      expect(() => runtime.createSchema()).toThrow(expect.objectContaining({
        extensions: expect.objectContaining({ code: 'QUERY_NAME_CONFLICT', status: 500 }),
      }));
      expect(adapter.prepare).not.toHaveBeenCalled();
      expect(adapter.createModel).not.toHaveBeenCalled();
    }
  });

  test('keeps includedCustomQueries independent and only rejects names that coexist', async () => {
    const runtime = createRuntime(createAdapter());
    const Item = entity('QueryAllowlistItem');
    runtime.connect(null, Item, 'item', 'items');
    runtime.registerCustomQuery('items', 'Custom items', null, GraphQLString, () => 'custom');
    runtime.registerCustomQuery('health', 'Health', null, GraphQLString, () => 'ok');
    runtime.registerMutation('ping', 'Ping', null, GraphQLString, () => 'pong');
    const generatedOnly = runtime.createSchema([Item], [], ['ping'], { includedCustomQueries: [] });
    expect(Object.keys(generatedOnly.getQueryType().getFields())).toEqual(['item', 'items', 'items_aggregate']);
    expect(Object.keys(generatedOnly.getMutationType().getFields())).toEqual(['ping']);
    for (const all of [undefined, {}, { includedCustomQueries: undefined }, { includedCustomQueries: null }]) {
      const customOnly = runtime.createSchema([], [], [], all);
      expect(Object.keys(customOnly.getQueryType().getFields())).toEqual(['items', 'health']);
      expect(customOnly.getMutationType()).toBeUndefined();
      expect(await graphql({ schema: customOnly, source: '{ items health }' }))
        .toEqual({ data: { items: 'custom', health: 'ok' } });
    }
    const selected = runtime.createSchema([Item], null, [], { includedCustomQueries: ['health'] });
    expect(Object.keys(selected.getQueryType().getFields())).toEqual(['item', 'items', 'items_aggregate', 'health']);
    expect(selected.getMutationType().getFields().ping).toBeUndefined();
    expect(selected.getMutationType().getFields().additem).toBeDefined();
  });

  test.each([
    { label: 'no registered queries', included: [], register: false },
    { label: 'empty allowlist', included: [], register: true },
    { label: 'unknown query name', included: ['missing'], register: true },
  ])('preserves storage preparation without exposed queries for $label', ({ included, register }) => {
    const adapter = createAdapter();
    const runtime = createRuntime(adapter);
    if (register) runtime.registerCustomQuery('health', 'Health', null, GraphQLString, () => 'ok');
    const schema = runtime.createSchema([], [], [], { includedCustomQueries: included });
    expect(adapter.prepare).toHaveBeenCalledWith([], { createCollection: true });
    expect(Object.keys(schema.getQueryType().getFields())).toEqual([]);
    expect(adapter.createModel).not.toHaveBeenCalled();
  });

  test('allows generated queries to keep the root valid when custom queries are excluded', () => {
    const runtime = createRuntime(createAdapter());
    const Item = entity('QueryNonemptyGeneratedItem');
    runtime.connect(null, Item, 'item', 'items');
    runtime.registerCustomQuery('health', 'Health', null, GraphQLString, () => 'ok');
    const schema = runtime.createSchema([Item], [], [], { includedCustomQueries: [] });
    expect(validateSchema(schema)).toEqual([]);
    expect(Object.keys(schema.getQueryType().getFields())).toEqual(['item', 'items', 'items_aggregate']);
    expect(schema.getMutationType()).toBeUndefined();
  });

  test('does not apply CRUD scopes to the custom callback or its returned entity', async () => {
    const runtime = createRuntime(createAdapter());
    const scope = vi.fn(() => { throw new Error('CRUD scope must not run'); });
    const Item = entity('QueryScopedResult', { scope: { find: scope, get_by_id: scope, aggregate: scope } });
    runtime.connect(null, Item, 'item', 'items');
    runtime.registerCustomQuery('report', 'Report', null, Item, () => ({ _id: '1', name: 'custom' }));
    const result = await graphql({ schema: runtime.createSchema([], [], []), source: '{ report { id name } }' });
    expect(result).toEqual({ data: { report: { id: '1', name: 'custom' } } });
    expect(scope).not.toHaveBeenCalled();
  });

  test('preserves deferred getInputType fields when no mutation fields are exposed', async () => {
    const runtime = createRuntime(createAdapter());
    const Item = entity('QueryDeferredItem');
    runtime.connect(null, Item, 'item', 'items');
    const fields = vi.fn(() => ({ item: { type: new GraphQLNonNull(runtime.getInputType(Item)) } }));
    const Input = new GraphQLInputObjectType({ name: 'QueryDeferredInput', fields });
    runtime.registerCustomQuery('inspectItem', 'Inspect', Input, GraphQLString, ({ item }) => item.name);
    expect(fields).not.toHaveBeenCalled();
    const schema = runtime.createSchema([], [], []);
    expect(schema.getMutationType()).toBeUndefined();
    expect(await graphql({ schema, source: '{ inspectItem(input: { item: { name: "ready" } }) }' }))
      .toEqual({ data: { inspectItem: 'ready' } });
    expect(fields).toHaveBeenCalledTimes(1);
  });

  test('keeps custom queries and their allowlist when application JSON rebuilds the root', async () => {
    const adapter = createAdapter();
    adapter.aggregate = async () => [{ groupId: 'group', facts: { count: 1 } }];
    const runtime = createRuntime(adapter);
    runtime.connect(null, entity('QueryJSONItem'), 'item', 'items');
    const JSONScalar = new GraphQLScalarType({ name: 'JSON', serialize: (value) => ({ wrapped: value }) });
    runtime.registerCustomQuery('report', 'Report', null, JSONScalar, () => 'query');
    runtime.registerCustomQuery('hidden', 'Hidden', null, GraphQLString, () => 'hidden');
    const schema = runtime.createSchema(null, [], [], { includedCustomQueries: ['report'] });
    expect(validateSchema(schema)).toEqual([]);
    expect(schema.getType('JSON')).toBe(JSONScalar);
    expect(schema.getType('QLTypeAggregationResult').getFields().facts.type).toBe(JSONScalar);
    expect(schema.getQueryType().getFields().hidden).toBeUndefined();
    expect(await graphql({ schema, source: '{ report }' })).toEqual({ data: { report: { wrapped: 'query' } } });
  });

  test('rejects bound result types and copied relation resolvers before preparation', () => {
    const Author = entity('QueryBoundAuthor');
    const Book = new GraphQLObjectType({
      name: 'QueryBoundBook',
      fields: { id: { type: GraphQLID }, author: { type: Author, extensions: { relation: {} } } },
    });
    const first = createRuntime(createAdapter());
    first.connect(null, Author, 'author', 'authors');
    first.connect(null, Book, 'book', 'books');
    first.createSchema();
    const Copy = new GraphQLObjectType({ ...Book.toConfig(), name: 'QueryBoundBookCopy' });
    for (const type of [Book, Copy]) {
      const adapter = createAdapter();
      const second = createRuntime(adapter);
      const Output = new GraphQLUnionType({ name: `${type.name}Result`, types: [type] });
      second.registerCustomQuery('report', 'Report', null, Output, () => null);
      expect(() => second.createSchema()).toThrow(expect.objectContaining({
        extensions: expect.objectContaining({ code: 'TYPE_BOUND_TO_OTHER_RUNTIME' }),
      }));
      expect(adapter.prepare).not.toHaveBeenCalled();
    }
  });

  test('reserves unresolved relations reached only through a query result', () => {
    const Author = entity('QueryReservedAuthor');
    const Book = new GraphQLObjectType({
      name: 'QueryReservedBook',
      fields: { author: { type: Author, extensions: { relation: {} } } },
    });
    const first = createRuntime(createAdapter());
    first.registerCustomQuery('report', 'Report', null, Book, () => ({}));
    first.createSchema();
    const second = createRuntime(createAdapter());
    expect(() => second.addNoEndpointType(Book)).toThrow(expect.objectContaining({
      extensions: expect.objectContaining({ code: 'TYPE_BOUND_TO_OTHER_RUNTIME' }),
    }));
    expect(Book.getFields().author.resolve).toBeUndefined();
  });

  test.each(['input', 'output'])('rejects a reserved metadata name in an included query %s before preparation', (position) => {
    const seed = createRuntime(createAdapter());
    seed.registerCustomQuery('health', 'Health', null, GraphQLString, () => 'ok');
    seed.createSchema();
    const name = __Field.getFields().extensions.type.name;
    const Input = new GraphQLInputObjectType({ name, fields: { value: { type: GraphQLString } } });
    const adapter = createAdapter();
    const runtime = createRuntime(adapter);
    runtime.registerCustomQuery('report', 'Report', position === 'input' ? Input : null,
      position === 'output' ? entity(name) : GraphQLString, () => null);
    runtime.registerCustomQuery('health', 'Health', null, GraphQLString, () => 'ok');
    expect(() => runtime.createSchema()).toThrow(expect.objectContaining({
      extensions: expect.objectContaining({ code: 'RESERVED_TYPE_NAME' }),
    }));
    expect(adapter.prepare).not.toHaveBeenCalled();
    const excluded = runtime.createSchema([], [], [], { includedCustomQueries: ['health'] });
    expect(validateSchema(excluded)).toEqual([]);
    expect(excluded.getQueryType().getFields().report).toBeUndefined();
  });
  test.each([
    ['null', null],
    ['an array', []],
    ['an array of names', ['health']],
    ['a string', 'health'],
    ['a number', 1],
    ['a function', () => ({ includedCustomQueries: [] })],
    ['a Map', new Map([['includedCustomQueries', []]])],
    ['an object with a prototype', Object.create({ includedCustomQueries: [] })],
    ['an unknown key', { transactions: {} }],
    ['a misspelled key', { includedCustomQuery: ['health'] }],
    ['an unknown undefined key', { includedCustomQueries: ['health'], extra: undefined }],
    ['a symbol key', { [Symbol('extra')]: true }],
    ['a string includedCustomQueries', { includedCustomQueries: 'health' }],
    ['a non-string name', { includedCustomQueries: ['health', 1] }],
    ['an object includedCustomQueries', { includedCustomQueries: { health: true } }],
  ])('rejects %s as the createSchema() options before preparation', (label, options) => {
    const adapter = createAdapter();
    const runtime = createRuntime(adapter);
    const Item = entity(`QueryOptions${label.replace(/\W/g, '')}`);
    runtime.connect(null, Item, 'item', 'items');
    runtime.registerCustomQuery('health', 'Health', null, GraphQLString, () => 'ok');
    expect(() => runtime.createSchema(null, null, null, options)).toThrow(expect.objectContaining({
      extensions: expect.objectContaining({ code: 'INVALID_SCHEMA_OPTIONS', status: 500 }),
    }));
    expect(adapter.prepare).not.toHaveBeenCalled();
    expect(adapter.createModel).not.toHaveBeenCalled();
    expect(Object.keys(runtime.createSchema().getQueryType().getFields()))
      .toEqual(['item', 'items', 'items_aggregate', 'health']);
  });

  test('rejects invalid createSchema() options before a query name conflict', () => {
    const adapter = createAdapter();
    const runtime = createRuntime(adapter);
    runtime.connect(null, entity('QueryOptionsBeforeConflict'), 'item', 'items');
    runtime.registerCustomQuery('items', 'Custom items', null, GraphQLString, () => 'custom');
    expect(() => runtime.createSchema(null, null, null, ['items'])).toThrow(expect.objectContaining({
      extensions: expect.objectContaining({ code: 'INVALID_SCHEMA_OPTIONS' }),
    }));
    expect(() => runtime.createSchema(null, null, null, { includedCustomQueries: ['items'] }))
      .toThrow(expect.objectContaining({ extensions: expect.objectContaining({ code: 'QUERY_NAME_CONFLICT' }) }));
    expect(adapter.prepare).not.toHaveBeenCalled();
  });

  test('accepts an options object with a null prototype', () => {
    const runtime = createRuntime(createAdapter());
    runtime.registerCustomQuery('health', 'Health', null, GraphQLString, () => 'ok');
    runtime.registerCustomQuery('version', 'Version', null, GraphQLString, () => '3.9.0');
    const options = Object.assign(Object.create(null), { includedCustomQueries: ['version'] });
    expect(Object.keys(runtime.createSchema(null, null, null, options).getQueryType().getFields()))
      .toEqual(['version']);
  });
});
