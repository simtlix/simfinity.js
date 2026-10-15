import {
  afterAll, afterEach, describe, expect, test, vi,
} from 'vitest';
import mongoose from 'mongoose';
import {
  graphql, GraphQLID, GraphQLInt, GraphQLList, GraphQLObjectType, GraphQLString,
} from 'graphql';
import * as simfinity from '../packages/mongodb/src/index.js';

const { createMongoAdapter, createRuntime } = simfinity;

// MongoDB opt-in collection batching (#165) without a database: the models are compiled but never
// connected, and the driver's collection.aggregate is replaced by an in-memory evaluator of the
// stages the adapter sends. tests/integration/mongodb-collection-batching.test.js checks results
// against a real server.

const ref = (connectionField) => ({ relation: { connectionField } });
// The driver collection method behind every model's collection; replacing it keeps the models' own
// collection objects untouched, as the gate that declines a wrapped collection.aggregate requires.
const collectionPrototype = Object.getPrototypeOf(mongoose.model(
  'CBMProbe', new mongoose.Schema({}, { autoCreate: false, autoIndex: false }),
).collection);

// The documents of each collection, by collection name.
const store = new Map();
const sameValue = (left, right) => String(left) === String(right);
// Equality $match, single-key $sort, $skip, $limit, $replaceWith { i, d: '$$ROOT' } and $unionWith.
const evaluate = (collection, stages) => {
  let rows = [...(store.get(collection) ?? [])];
  for (const stage of stages) {
    const [operator, value] = Object.entries(stage)[0];
    if (operator === '$match') {
      rows = rows.filter((row) => Object.entries(value).every(([path, expected]) => sameValue(row[path], expected)));
    } else if (operator === '$sort') {
      const [[path, order]] = Object.entries(value);
      rows.sort((left, right) => (left[path] < right[path] ? -order : left[path] > right[path] ? order : 0));
    } else if (operator === '$skip') rows = rows.slice(value);
    else if (operator === '$limit') rows = rows.slice(0, value);
    else if (operator === '$replaceWith') rows = rows.map((row) => ({ i: value.i, d: { ...row } }));
    else if (operator === '$unionWith') rows = [...rows, ...evaluate(value.coll, value.pipeline)];
    else throw new Error(`Unsupported stage ${operator}`);
  }
  return rows.map((row) => (row.d ? row : { ...row }));
};

// Records every aggregate command; `hold` keeps their cursors open until released.
const commands = [];
const mockAggregate = ({ hold = false, fail } = {}) => {
  const held = [];
  vi.spyOn(collectionPrototype, 'aggregate').mockImplementation(function aggregate(pipeline, options) {
    const command = { collection: this.collectionName, pipeline, options };
    commands.push(command);
    const rows = () => {
      if (fail?.(command)) throw new Error('simulated command failure');
      return evaluate(this.collectionName, pipeline);
    };
    return {
      toArray: () => (hold ? new Promise((resolve, reject) => held.push(() => {
        try {
          resolve(rows());
        } catch (error) {
          reject(error);
        }
      })) : Promise.resolve().then(rows)),
    };
  });
  return held;
};
const unionCommands = () => commands.filter(({ pipeline }) => pipeline.some((stage) => stage.$unionWith || stage.$replaceWith));

let fixtures = 0;
// A runtime with Author { books } and Book { author }, generated models and 20 authors with
// author-dependent book counts.
const createFixture = (options, { authors = 20 } = {}) => {
  fixtures += 1;
  const prefix = `CBM${fixtures}`;
  const Author = new GraphQLObjectType({
    name: `${prefix}Author`,
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      books: { type: new GraphQLList(Book), extensions: ref('author') },
    }),
  });
  const Book = new GraphQLObjectType({
    name: `${prefix}Book`,
    fields: () => ({
      id: { type: GraphQLID },
      title: { type: GraphQLString },
      rank: { type: GraphQLInt },
      author: { type: Author, extensions: ref('author') },
    }),
  });
  const adapter = createMongoAdapter(options);
  const runtime = createRuntime(adapter);
  runtime.preventCreatingCollection(true);
  runtime.connect(null, Author, `${prefix.toLowerCase()}author`, `${prefix.toLowerCase()}authors`);
  runtime.connect(null, Book, `${prefix.toLowerCase()}book`, `${prefix.toLowerCase()}books`);
  const schema = runtime.createSchema();
  const models = { Author: runtime.getModel(Author), Book: runtime.getModel(Book) };
  const authorRows = Array.from({ length: authors }, (_, index) => ({
    _id: new mongoose.Types.ObjectId(), name: `A${String(index).padStart(2, '0')}`,
  }));
  const bookRows = authorRows.flatMap((author, index) => Array.from({ length: (index % 4) + 1 }, (_, book) => ({
    _id: new mongoose.Types.ObjectId(), title: `T${index}-${book}`, rank: (index + book) % 3, author: author._id,
  })));
  store.set(models.Author.collection.collectionName, authorRows);
  store.set(models.Book.collection.collectionName, bookRows);
  return {
    prefix: prefix.toLowerCase(), adapter, runtime, schema, models, types: { Author, Book }, authorRows, bookRows,
  };
};

afterEach(() => {
  vi.restoreAllMocks();
  commands.length = 0;
});
afterAll(() => mongoose.deleteModel(/^CBM/));

describe('MongoDB batchedCollections option', () => {
  test('is off by default, and then the adapter has neither batching member', () => {
    for (const adapter of [createMongoAdapter(), createMongoAdapter({}), createMongoAdapter({ batchedCollections: false, collectionBatchSize: 20 }),
      simfinity.createMongoAdapter({ referentialIntegrity: 'off' })]) {
      expect('findChildrenBatch' in adapter).toBe(false);
      expect('batchesChildren' in adapter).toBe(false);
    }
  });

  test('defines both members, through the facade too, when it is true', () => {
    for (const adapter of [createMongoAdapter({ batchedCollections: true }),
      simfinity.createMongoAdapter({ batchedCollections: true, collectionBatchSize: 1, referentialIntegrity: 'transactional' })]) {
      expect(typeof adapter.findChildrenBatch).toBe('function');
      expect(typeof adapter.batchesChildren).toBe('function');
    }
  });

  test.each([
    [{ batchedCollections: 'yes' }], [{ batchedCollections: 1 }], [{ batchedCollections: null }],
    [{ batchedCollections: true, collectionBatchSize: 0 }], [{ batchedCollections: true, collectionBatchSize: 101 }],
    [{ batchedCollections: true, collectionBatchSize: 2.5 }], [{ batchedCollections: true, collectionBatchSize: '5' }],
    [{ batchedCollections: true, collectionBatchSize: Number.NaN }], [{ collectionBatchSize: null }],
  ])('rejects invalid batching options %j', (options) => {
    expect(() => createMongoAdapter(options)).toThrow(expect.objectContaining({
      extensions: expect.objectContaining({ code: 'INVALID_MONGO_ADAPTER_OPTIONS' }),
    }));
  });

  test('keeps rejecting unknown and misspelled options as before', () => {
    expect(() => createMongoAdapter({ batchedCollection: true })).toThrow(expect.objectContaining({
      extensions: expect.objectContaining({ code: 'INVALID_MONGO_INTEGRITY_CONFIGURATION' }),
    }));
  });

  test('is fixed at adapter creation', async () => {
    const options = { batchedCollections: true, collectionBatchSize: 2 };
    const fixture = createFixture(options, { authors: 4 });
    options.batchedCollections = false;
    options.collectionBatchSize = 4;
    mockAggregate();
    const ids = fixture.authorRows.map(({ _id }) => _id);
    await fixture.adapter.findChildrenBatch(fixture.models.Book, fixture.types.Book, 'author', ids, {}, { context: {} });
    expect(commands.map(({ pipeline }) => pipeline.filter((stage) => stage.$unionWith).length)).toEqual([1, 1]);
  });
});

describe('MongoDB findChildrenBatch', () => {
  test('reads each parent with its own pipeline, in $unionWith commands of collectionBatchSize parents', async () => {
    const fixture = createFixture({ batchedCollections: true });
    mockAggregate();
    const { Book } = fixture.models;
    const ids = fixture.authorRows.slice(0, 12).map(({ _id }) => _id);
    const args = { sort: { terms: [{ field: 'title', order: 'DESC' }] }, pagination: { page: 1, size: 3 } };
    const lists = await fixture.adapter.findChildrenBatch(Book, fixture.types.Book, 'author', ids, args, { context: {} });

    // 12 parents in commands of 5, 5 and 2.
    expect(commands.map(({ collection }) => collection)).toEqual(Array(3).fill(Book.collection.collectionName));
    const subPipeline = (key, index) => [
      { $match: { author: key } }, { $sort: { title: -1 } }, { $skip: 0 }, { $limit: 3 }, { $replaceWith: { i: index, d: '$$ROOT' } },
    ];
    expect(commands[0].pipeline).toEqual([
      ...subPipeline(ids[0], 0),
      ...[1, 2, 3, 4].map((index) => ({ $unionWith: { coll: Book.collection.collectionName, pipeline: subPipeline(ids[index], index) } })),
    ]);
    expect(commands[2].pipeline).toEqual([
      ...subPipeline(ids[10], 10), { $unionWith: { coll: Book.collection.collectionName, pipeline: subPipeline(ids[11], 11) } },
    ]);
    // The first batch holds every row the command can return, so the server closes the cursor.
    expect(commands.map(({ options }) => options.batchSize)).toEqual([16, 16, 7]);
    expect(commands.every(({ options }) => options.session === undefined)).toBe(true);

    // One list per parent, in order, equal to findChildren's.
    const expected = [];
    for (const id of ids) expected.push(await fixture.adapter.findChildren(Book, fixture.types.Book, 'author', id, args, null));
    expect(lists).toEqual(expected);
    expect(lists.map((list) => list.length)).toEqual(ids.map((_, index) => Math.min(3, (index % 4) + 1)));
    // Records keep their stored parent, as findChildren's records do.
    expect(lists.every((list, index) => list.every((record) => record.author.equals(ids[index])))).toBe(true);
  });

  test('runs the commands of one call concurrently and returns after all of them', async () => {
    const fixture = createFixture({ batchedCollections: true, collectionBatchSize: 4 });
    const held = mockAggregate({ hold: true });
    const ids = fixture.authorRows.map(({ _id }) => _id);
    const reading = fixture.adapter.findChildrenBatch(fixture.models.Book, fixture.types.Book, 'author', ids, {}, { context: {} });
    await vi.waitFor(() => expect(held).toHaveLength(5));
    let settled = false;
    reading.then(() => { settled = true; });
    held.slice(0, 4).forEach((release) => release());
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);
    held[4]();
    expect((await reading).flat()).toHaveLength(fixture.bookRows.length);
  });

  test('accepts null or missing options, and gives duplicates their own lists and records', async () => {
    const fixture = createFixture({ batchedCollections: true });
    mockAggregate();
    const { _id: first } = fixture.authorRows[3];
    const ids = [first, fixture.authorRows[1]._id, first];
    for (const options of [null, undefined, {}]) {
      commands.length = 0;
      const lists = await fixture.adapter.findChildrenBatch(fixture.models.Book, fixture.types.Book, 'author', ids, {}, options);
      expect(commands).toHaveLength(1);
      expect(lists.map((list) => list.length)).toEqual([4, 2, 4]);
      expect(lists[0]).toEqual(lists[2]);
      expect(lists[0]).not.toBe(lists[2]);
      expect(lists[0][0]).not.toBe(lists[2][0]);
    }
  });

  test('gives parents the connection path cannot cast an empty list and no sub-pipeline, as findChildren does', async () => {
    const fixture = createFixture({ batchedCollections: true });
    mockAggregate();
    const { Book } = fixture.models;
    const id = fixture.authorRows[2]._id;
    const lists = await fixture.adapter.findChildrenBatch(Book, fixture.types.Book, 'author', ['nope', id, 'x1'], {}, { context: {} });
    expect(lists.map((list) => list.length)).toEqual([0, 3, 0]);
    expect(commands).toHaveLength(1);
    expect(commands[0].pipeline.some((stage) => stage.$unionWith)).toBe(false);
    expect(commands[0].pipeline.at(-1)).toEqual({ $replaceWith: { i: 1, d: '$$ROOT' } });

    commands.length = 0;
    expect(await fixture.adapter.findChildrenBatch(Book, fixture.types.Book, 'author', ['nope', 'x1'], {})).toEqual([[], []]);
    expect(await fixture.adapter.findChildrenBatch(Book, fixture.types.Book, 'author', [], {})).toEqual([]);
    expect(commands).toHaveLength(0);
  });

  test('sends fewer parents per command when a sub-pipeline is large', async () => {
    const fixture = createFixture({ batchedCollections: true, collectionBatchSize: 20 });
    mockAggregate();
    const ids = fixture.authorRows.slice(0, 10).map(({ _id }) => _id);
    // About 3 MiB per sub-pipeline: two parents per command stay below the 8 MiB budget.
    const value = Array.from({ length: 3 * 1024 }, (_, index) => `${index}-${'x'.repeat(1010)}`);
    const args = { title: { operator: 'IN', value } };
    const bytes = mongoose.mongo.BSON.calculateObjectSize({ pipeline: [{ $match: { author: ids[0] } }, ...await fixture.adapter.buildQuery(args, fixture.types.Book), { $replaceWith: { i: 0, d: '$$ROOT' } }] });
    expect(bytes).toBeGreaterThan(3 * 1024 * 1024);
    await fixture.adapter.findChildrenBatch(fixture.models.Book, fixture.types.Book, 'author', ids, args, { context: {} });
    expect(commands.map(({ pipeline }) => pipeline.filter((stage) => stage.$unionWith).length + 1)).toEqual([2, 2, 2, 2, 2]);
  });

  test('fails as a whole once every command settles, never with partial lists', async () => {
    const fixture = createFixture({ batchedCollections: true });
    const held = mockAggregate({ hold: true, fail: ({ pipeline }) => pipeline[0].$match.author.equals(fixture.authorRows[5]._id) });
    const ids = fixture.authorRows.slice(0, 15).map(({ _id }) => _id);
    const reading = fixture.adapter.findChildrenBatch(fixture.models.Book, fixture.types.Book, 'author', ids, {}, { context: {} });
    const outcome = reading.then(() => 'resolved', (error) => error.message);
    await vi.waitFor(() => expect(held).toHaveLength(3));
    held[1]();
    let result;
    outcome.then((value) => { result = value; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(result).toBeUndefined();
    held[0]();
    held[2]();
    expect(await outcome).toBe('simulated command failure');
  });

  test('rejects before reading while reference integrity is not initialized, with its SimfinityError', async () => {
    const fixture = createFixture({ batchedCollections: true, referentialIntegrity: 'transactional' });
    mockAggregate();
    await expect(fixture.adapter.findChildrenBatch(fixture.models.Book, fixture.types.Book, 'author', [fixture.authorRows[0]._id], {}))
      .rejects.toMatchObject({ extensions: { code: 'MONGO_INTEGRITY_NOT_INITIALIZED' } });
    expect(commands).toHaveLength(0);
  });
});

describe('MongoDB batchesChildren gates', () => {
  const fixture = createFixture({ batchedCollections: true }, { authors: 2 });
  const parents = fixture.authorRows.map(({ _id }) => _id);
  const supplied = (name, register) => {
    const schema = new mongoose.Schema({ title: String, author: mongoose.Schema.Types.ObjectId }, { autoCreate: false, autoIndex: false });
    register?.(schema);
    return mongoose.model(`CBMGate${name}`, schema);
  };
  // batchesChildren is false, and findChildrenBatch rejects before any command.
  const expectDeclined = async (adapter, Model) => {
    mockAggregate();
    expect(adapter.batchesChildren(Model, fixture.types.Book, 'author')).toBe(false);
    await expect(adapter.findChildrenBatch(Model, fixture.types.Book, 'author', parents, {}, { context: {} }))
      .rejects.toThrow('reads children one parent at a time');
    expect(commands).toHaveLength(0);
    vi.restoreAllMocks();
  };

  test('allows a generated model and a plain supplied one', () => {
    expect(fixture.adapter.batchesChildren(fixture.models.Book, fixture.types.Book, 'author')).toBe(true);
    expect(fixture.adapter.batchesChildren(supplied('Plain'), fixture.types.Book, 'author')).toBe(true);
  });

  test('declines models whose aggregate middleware, own static or wrapped collection would see only the first parent', async () => {
    const noop = function noop() {};
    await expectDeclined(fixture.adapter, supplied('Pre', (schema) => schema.pre('aggregate', noop)));
    await expectDeclined(fixture.adapter, supplied('Post', (schema) => schema.post('aggregate', noop)));
    await expectDeclined(fixture.adapter, supplied('Static', (schema) => schema.static('aggregate', function aggregate(pipeline) {
      return mongoose.Model.aggregate.call(this, pipeline);
    })));
    const Wrapped = supplied('Wrapped');
    Wrapped.collection.aggregate = function aggregate(...args) {
      return collectionPrototype.aggregate.apply(this, args);
    };
    await expectDeclined(fixture.adapter, Wrapped);
  });

  test('declines a discriminator, whose key Mongoose adds to the first pipeline only, but not its base model', async () => {
    const Base = supplied('Base');
    const Special = Base.discriminator('CBMGateSpecial', new mongoose.Schema({ level: Number }));
    expect(fixture.adapter.batchesChildren(Base, fixture.types.Book, 'author')).toBe(true);
    await expectDeclined(fixture.adapter, Special);
  });

  test('declines copies and overrides of findChildren, so the override reads each parent', async () => {
    const { adapter } = fixture;
    const { Book } = fixture.models;
    const override = vi.fn(async () => []);
    expect({ ...adapter }.batchesChildren(Book, fixture.types.Book, 'author')).toBe(true);
    await expectDeclined({ ...adapter, findChildren: override }, Book);
    const assigned = createFixture({ batchedCollections: true }, { authors: 2 });
    Object.assign(assigned.adapter, { findChildren: override });
    await expectDeclined(assigned.adapter, assigned.models.Book);

    // Through the runtime, the override filter applies to every parent and nothing is batched.
    mockAggregate();
    const result = await graphql({
      schema: assigned.schema, source: `{ ${assigned.prefix}authors { name books { title } } }`, contextValue: {},
    });
    expect(result.errors).toBeUndefined();
    expect(result.data[`${assigned.prefix}authors`]).toEqual([{ name: 'A00', books: [] }, { name: 'A01', books: [] }]);
    expect(override).toHaveBeenCalledTimes(2);
    expect(unionCommands()).toHaveLength(0);
  });

  test('declines a session and a Mongoose transactionAsyncLocalStorage transaction', async () => {
    const { adapter } = fixture;
    const { Book } = fixture.models;
    mockAggregate();
    await expect(adapter.findChildrenBatch(Book, fixture.types.Book, 'author', parents, {}, { session: {} }))
      .rejects.toThrow('reads children one parent at a time: it reads in a session or a transaction');
    mongoose.set('transactionAsyncLocalStorage', true);
    try {
      expect(adapter.batchesChildren(Book, fixture.types.Book, 'author')).toBe(true);
      await mongoose.transactionAsyncLocalStorage.run({ session: {} }, async () => {
        expect(adapter.batchesChildren(Book, fixture.types.Book, 'author')).toBe(false);
        await expect(adapter.findChildrenBatch(Book, fixture.types.Book, 'author', parents, {}))
          .rejects.toThrow('reads children one parent at a time');
      });
    } finally {
      mongoose.set('transactionAsyncLocalStorage', false);
    }
    expect(commands).toHaveLength(0);
  });
});

describe('MongoDB collection batching through the runtime', () => {
  const source = (prefix, bookArgs = '') => `{ ${prefix}authors(sort: { terms: [{ field: "name", order: ASC }] }) { name books${bookArgs} { title rank } } }`;

  test('20 authors read their books with ceil(20 / collectionBatchSize) commands; without the option, 20', async () => {
    const off = createFixture();
    const on = createFixture({ batchedCollections: true });
    const wide = createFixture({ batchedCollections: true, collectionBatchSize: 20 });
    mockAggregate();
    const run = async ({ schema, prefix, models }, bookArgs) => {
      commands.length = 0;
      const result = await graphql({ schema, source: source(prefix, bookArgs), contextValue: {} });
      expect(result.errors).toBeUndefined();
      return {
        data: result.data[`${prefix}authors`],
        bookCommands: commands.filter(({ collection }) => collection === models.Book.collection.collectionName),
      };
    };
    for (const bookArgs of ['', '(sort: { terms: [{ field: "title", order: DESC }] }, pagination: { page: 1, size: 2 })']) {
      const expected = await run(off, bookArgs);
      expect(expected.bookCommands).toHaveLength(20);
      expect(expected.bookCommands.some(({ pipeline }) => pipeline.some((stage) => stage.$unionWith))).toBe(false);
      const batched = await run(on, bookArgs);
      expect(batched.data).toEqual(expected.data);
      expect(batched.bookCommands).toHaveLength(Math.ceil(20 / 5));
      const single = await run(wide, bookArgs);
      expect(single.data).toEqual(expected.data);
      expect(single.bookCommands).toHaveLength(1);
      expect(single.bookCommands[0].pipeline.filter((stage) => stage.$unionWith)).toHaveLength(19);
    }
  });

  test('a failed batch reads each parent alone and reports once', async () => {
    const on = createFixture({ batchedCollections: true });
    mockAggregate({ fail: ({ pipeline }) => pipeline.some((stage) => stage.$unionWith) });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await graphql({ schema: on.schema, source: source(on.prefix), contextValue: {} });
    expect(result.errors).toBeUndefined();
    expect(result.data[`${on.prefix}authors`].map(({ books }) => books.length)).toEqual(on.authorRows.map((_, index) => (index % 4) + 1));
    expect(unionCommands()).toHaveLength(4);
    expect(commands.filter(({ collection }) => collection === on.models.Book.collection.collectionName)).toHaveLength(4 + 20);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('simulated command failure');
  });
});
