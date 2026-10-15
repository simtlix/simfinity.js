import { randomUUID } from 'node:crypto';
import {
  afterAll, afterEach, beforeAll, describe, expect, it, vi,
} from 'vitest';
import {
  GraphQLID, GraphQLInputObjectType, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';
import mongoose from 'mongoose';

import { configureQueryLimits, createRuntime } from '../../packages/core/src/index.js';
import { createMongoAdapter } from '../../packages/mongodb/src/mongo/adapter.js';
import { generateMCPTools } from '../../packages/mcp/src/index.js';

// MongoDB opt-in collection batching (#165) on a real server: the same documents, with the same
// IDs, are stored for a runtime whose adapter batches collection reads (batchedCollections: true,
// collectionBatchSize 5) and for one that does not (the default). Assertions count the commands the
// driver sends and compare results; they never time anything.

const mongoUri = process.env.SIMFINITY_MONGODB_URI;
const describeWithMongo = mongoUri ? describe : describe.skip;

let seed = 165;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const shuffle = (items) => {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [items[index], items[other]] = [items[other], items[index]];
  }
  return items;
};
const ref = (connectionField) => ({ relation: { connectionField } });
const oid = () => new mongoose.Types.ObjectId();

// 20 authors with 30 books each (2 orphans: author missing and null) and 0 to 3 awards, 2
// publishers. Inserted in shuffled order, so natural order differs from _id and title order.
const createDocuments = () => {
  const publishers = [{ _id: oid(), name: 'Acme' }, { _id: oid(), name: 'Zeta' }];
  const authors = Array.from({ length: 20 }, (_, index) => ({ _id: oid(), name: `A${String(index).padStart(2, '0')}` }));
  const books = authors.flatMap((author, a) => Array.from({ length: 30 }, (_, index) => ({
    _id: oid(),
    title: `T${String(Math.floor(random() * 1000)).padStart(3, '0')}`,
    rank: Math.floor(random() * 10),
    status: random() < 0.5 ? 'x' : 'y',
    tag: ['red', 'green', 'blue'][(a + index) % 3],
    author: author._id,
    publisher: publishers[Math.floor(random() * 2)]._id,
  })));
  books.push({ _id: oid(), title: 'orphan-missing', status: 'x' }, { _id: oid(), title: 'orphan-null', status: 'x', author: null });
  const awards = authors.flatMap((author, a) => Array.from({ length: a % 4 }, (_, index) => ({
    _id: oid(), name: `W${a}-${index}`, year: 2000 + Math.floor(random() * 20), author: author._id,
  })));
  return {
    publishers, authors, books: shuffle(books), awards: shuffle(awards),
  };
};

const createFixture = async (prefix, adapterOptions, documents) => {
  const adapter = createMongoAdapter(adapterOptions);
  const runtime = createRuntime(adapter);
  const middleware = [];
  runtime.use(async (params, next) => {
    middleware.push(`${params.operation}:${params.type?.gqltype?.name}`);
    await next();
  });
  const Publisher = new GraphQLObjectType({
    name: `${prefix}Publisher`,
    fields: () => ({ id: { type: GraphQLID }, name: { type: new GraphQLNonNull(GraphQLString) } }),
    extensions: {
      scope: {
        find: ({ args, context }) => {
          if (context?.publisherNot) args.name = { operator: 'NE', value: context.publisherNot };
        },
      },
    },
  });
  const Book = new GraphQLObjectType({
    name: `${prefix}Book`,
    fields: () => ({
      id: { type: GraphQLID },
      title: { type: new GraphQLNonNull(GraphQLString) },
      rank: { type: GraphQLInt },
      status: { type: GraphQLString },
      tag: { type: GraphQLString },
      author: { type: Author, extensions: ref('author') },
      publisher: { type: Publisher, extensions: ref('publisher') },
    }),
    extensions: {
      scope: {
        find: ({ args, context }) => {
          if (context?.bookStatus) {
            args.AND = [...(args.AND || []), { conditions: [{ field: 'status', operator: 'EQ', value: context.bookStatus }] }];
          }
        },
      },
    },
  });
  const Award = new GraphQLObjectType({
    name: `${prefix}Award`,
    fields: () => ({
      id: { type: GraphQLID }, name: { type: GraphQLString }, year: { type: GraphQLInt }, author: { type: Author, extensions: ref('author') },
    }),
  });
  const Author = new GraphQLObjectType({
    name: `${prefix}Author`,
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: new GraphQLNonNull(GraphQLString) },
      books: { type: new GraphQLList(Book), extensions: ref('author') },
      awards: { type: new GraphQLList(Award), extensions: ref('author') },
    }),
  });
  const name = prefix.toLowerCase();
  runtime.preventCreatingCollection(true);
  runtime.connect(null, Publisher, `${name}publisher`, `${name}publishers`);
  runtime.connect(null, Author, `${name}author`, `${name}authors`);
  runtime.connect(null, Book, `${name}book`, `${name}books`);
  runtime.connect(null, Award, `${name}award`, `${name}awards`);
  runtime.registerMutation(`${name}Listed`, 'Authors returned by an application callback', new GraphQLInputObjectType({
    name: `${prefix}ListedInput`, fields: { ids: { type: new GraphQLList(GraphQLString) } },
  }), new GraphQLList(Author), async ({ ids }) => ids.map((id) => (id === 'none' ? { name: 'ghost' } : { _id: id, name: `as ${id}` })));
  const schema = runtime.createSchema();
  const models = {
    Publisher: runtime.getModel(Publisher), Author: runtime.getModel(Author), Book: runtime.getModel(Book), Award: runtime.getModel(Award),
  };
  for (const model of Object.values(models)) {
    await model.createCollection();
    await model.syncIndexes();
  }
  await models.Book.collection.createIndex({ status: 1, rank: 1 });
  await models.Publisher.collection.insertMany(documents.publishers.map((document) => ({ ...document })));
  await models.Author.collection.insertMany(documents.authors.map((document) => ({ ...document })));
  await models.Book.collection.insertMany(documents.books.map((document) => ({ ...document })));
  await models.Award.collection.insertMany(documents.awards.map((document) => ({ ...document })));
  return {
    name, adapter, runtime, schema, models, middleware, types: {
      Publisher, Author, Book, Award,
    },
  };
};

describeWithMongo('MongoDB batched collection reads (#165)', () => {
  const namespace = `cbmongo_${randomUUID().replaceAll('-', '')}`;
  const commands = [];
  let documents;
  let off;
  let on;

  // Commands sent to the children collections of a fixture.
  const childCommands = (fixture) => {
    const names = [fixture.models.Book, fixture.models.Award].map((model) => model.collection.collectionName);
    return commands.filter(({ collection }) => names.includes(collection));
  };
  // GraphQL errors from collection fields follow the order in which reads settle. The root field
  // name, which differs between the fixtures, is left out.
  const plainErrors = (errors) => errors?.map((error) => ({ message: error.message, path: error.path.slice(1), code: error.extensions?.code }))
    .sort((left, right) => JSON.stringify(left.path).localeCompare(JSON.stringify(right.path)));
  const run = async (fixture, source, contextValue = {}, variableValues) => {
    commands.length = 0;
    fixture.middleware.length = 0;
    const result = await graphql({
      schema: fixture.schema, source, contextValue, variableValues,
    });
    return {
      data: result.data && Object.values(result.data)[0],
      errors: plainErrors(result.errors),
      commands: childCommands(fixture),
      middleware: fixture.middleware.length,
    };
  };
  const expectSameResult = (batched, expected) => {
    expect(batched.data).toEqual(expected.data);
    expect(batched.errors).toEqual(expected.errors);
  };
  const byId = (rows) => [...rows].sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const authorsSource = (fixture, bookArgs = '', select = 'id title rank status tag publisher { name }') => `{ ${fixture.name}authors(sort: { terms: [{ field: "name", order: ASC }] }) {
    id name books${bookArgs} { ${select} } } }`;

  beforeAll(async () => {
    await mongoose.connect(mongoUri, { dbName: namespace, monitorCommands: true });
    mongoose.connection.getClient().on('commandStarted', (event) => {
      commands.push({
        name: event.commandName,
        collection: event.command.aggregate ?? event.command.collection ?? event.command.find,
        union: event.commandName === 'aggregate' && event.command.pipeline.some((stage) => stage.$unionWith || stage.$replaceWith),
        transaction: event.command.txnNumber != null,
      });
    });
    documents = createDocuments();
    off = await createFixture('CBMOff', undefined, documents);
    on = await createFixture('CBMOn', { batchedCollections: true }, documents);
  }, 120000);

  afterEach(() => {
    configureQueryLimits();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (mongoose.connection.readyState) {
      await mongoose.connection.db.dropDatabase();
      await mongoose.disconnect();
    }
    mongoose.deleteModel(/^CBM/);
  });

  it('reads the books of 20 authors with ceil(20 / 5) commands instead of 20, with the same data and middleware', async () => {
    // A spy on findChildren would be an override, which turns batching off.
    const findChildrenBatch = vi.spyOn(on.adapter, 'findChildrenBatch');
    const expected = await run(off, authorsSource(off));
    const batched = await run(on, authorsSource(on));
    expect(expected.errors).toBeUndefined();
    expectSameResult(batched, expected);
    expect(expected.data.map(({ books }) => books.length)).toEqual(Array(20).fill(30));
    expect(expected.commands.map(({ name, union }) => [name, union])).toEqual(Array(20).fill(['aggregate', false]));
    // No getMore: each command's first batch holds its rows.
    expect(batched.commands.map(({ name, union }) => [name, union])).toEqual(Array(4).fill(['aggregate', true]));
    expect(findChildrenBatch).toHaveBeenCalledTimes(1);
    expect(findChildrenBatch.mock.calls[0][3]).toHaveLength(20);
    // The root list, 20 book collections and 600 publisher references, in both modes.
    expect(batched.middleware).toBe(expected.middleware);
    expect(batched.middleware).toBe(1 + 20 + 600);

    const two = (fixture) => `{ ${fixture.name}authors(sort: { terms: [{ field: "name", order: ASC }] }) { name books { id } awards { id name year } } }`;
    const both = await run(off, two(off));
    const bothBatched = await run(on, two(on));
    expectSameResult(bothBatched, both);
    expect(both.commands).toHaveLength(40);
    expect(bothBatched.commands).toHaveLength(8);
  }, 60000);

  it('keeps each parent\'s rows: identical for total orders, the same set otherwise', async () => {
    const total = [
      ['sorted, ending in id', '(sort: { terms: [{ field: "title", order: ASC }, { field: "id", order: ASC }] })'],
      ['page 2 of 7, ending in id', '(pagination: { page: 2, size: 7 }, sort: { terms: [{ field: "rank", order: DESC }, { field: "id", order: ASC }] })'],
      ['last partial page', '(pagination: { page: 5, size: 7 }, sort: { terms: [{ field: "id", order: DESC }] })'],
      ['page past the end', '(pagination: { page: 9, size: 7 }, sort: { terms: [{ field: "id", order: ASC }] })'],
      ['relation term', '(publisher: { terms: [{ path: "name", operator: EQ, value: "Acme" }] }, sort: { terms: [{ field: "title", order: DESC }, { field: "id", order: ASC }] })'],
      ['relation sort', '(sort: { terms: [{ field: "publisher.name", order: ASC }, { field: "id", order: ASC }] }, pagination: { page: 1, size: 4 })'],
      ['empty for every parent', '(title: { operator: EQ, value: "nope" })'],
    ];
    // Pages that hold every matching child, without a total order.
    const sets = [
      ['unsorted', ''],
      ['sort with ties', '(sort: { terms: [{ field: "rank", order: DESC }] })'],
      ['filter on an indexed field', '(status: { operator: EQ, value: "x" })'],
      ['AND/OR groups', '(AND: [{ conditions: [{ field: "rank", operator: GTE, value: 3 }] }], OR: [{ conditions: [{ field: "tag", operator: EQ, value: "red" }] }, { conditions: [{ field: "status", operator: EQ, value: "y" }] }])'],
      ['LIKE and IN', '(title: { operator: LIKE, value: "1" }, tag: { operator: IN, value: ["red", "blue"] })'],
    ];
    for (const [label, args] of [...total, ...sets]) {
      const expected = await run(off, authorsSource(off, args));
      const batched = await run(on, authorsSource(on, args));
      expect(expected.errors, label).toBeUndefined();
      expect(batched.errors, label).toBeUndefined();
      expect(batched.commands.map(({ union }) => union), label).toEqual(Array(4).fill(true));
      if (total.some(([name]) => name === label)) expect(batched.data, label).toEqual(expected.data);
      else expect(batched.data.map(({ books }) => byId(books)), label).toEqual(expected.data.map(({ books }) => byId(books)));
    }

    // A page of an unsorted read: the same number of rows, each one of that parent's children.
    const expected = await run(off, authorsSource(off, '(pagination: { page: 2, size: 7 })'));
    const batched = await run(on, authorsSource(on, '(pagination: { page: 2, size: 7 })'));
    const all = await run(on, authorsSource(on));
    batched.data.forEach(({ books }, index) => {
      expect(books).toHaveLength(expected.data[index].books.length);
      const ids = new Set(all.data[index].books.map(({ id }) => id));
      expect(books.every(({ id }) => ids.has(id))).toBe(true);
    });

    // The book scope (from the context) and the publisher's joined scope.
    for (const [contextValue, args, check] of [
      [{ bookStatus: 'y' }, '', (book) => book.status === 'y'],
      [{ publisherNot: 'Zeta' }, '(publisher: { terms: [{ path: "name", operator: NE, value: "Nobody" }] })', (book) => book.publisher.name === 'Acme'],
    ]) {
      const scoped = await run(off, authorsSource(off, args), contextValue);
      const scopedBatched = await run(on, authorsSource(on, args), { ...contextValue });
      expect(scopedBatched.errors).toBeUndefined();
      expect(scopedBatched.commands).toHaveLength(4);
      expect(scopedBatched.data.map(({ books }) => byId(books))).toEqual(scoped.data.map(({ books }) => byId(books)));
      expect(scopedBatched.data.flatMap(({ books }) => books).every(check)).toBe(true);
    }
  }, 120000);

  it('gives every parent the same rows wherever it falls in a command (rotated parent order)', async () => {
    const ids = documents.authors.map(({ _id }) => _id);
    const { Book } = on.models;
    for (const args of [{}, { sort: { terms: [{ field: 'rank', order: 'ASC' }, { field: 'id', order: 'DESC' }] }, pagination: { page: 2, size: 4 } }]) {
      const expected = [];
      for (const id of ids) expected.push(await on.adapter.findChildren(Book, on.types.Book, 'author', id, structuredClone(args), null));
      // With 5 parents per command, rotations 0 to 4 put every parent first in a command once.
      for (let rotation = 0; rotation < 5; rotation += 1) {
        const rotated = [...ids.slice(rotation), ...ids.slice(0, rotation)];
        commands.length = 0;
        const lists = await on.adapter.findChildrenBatch(Book, on.types.Book, 'author', rotated, structuredClone(args), { context: {} });
        expect(commands.filter(({ union }) => union)).toHaveLength(4);
        rotated.forEach((id, index) => {
          const want = expected[ids.indexOf(id)];
          if (args.sort) expect(lists[index]).toEqual(want);
          else expect(byId(lists[index].map((row) => ({ ...row, id: row._id })))).toEqual(byId(want.map((row) => ({ ...row, id: row._id }))));
        });
      }
    }
  }, 60000);

  it('reads per field when a page is invalid or the batch fails, with each field\'s own result', async () => {
    configureQueryLimits({ maxPageSize: 10 });
    const invalid = await run(off, authorsSource(off, '(pagination: { page: 1, size: 11 })', 'id'));
    const invalidBatched = await run(on, authorsSource(on, '(pagination: { page: 1, size: 11 })', 'id'));
    expectSameResult(invalidBatched, invalid);
    // The root list's default page is 10 authors too.
    expect(invalid.errors).toHaveLength(10);
    expect(invalid.errors.every(({ code }) => code === 'INVALID_PAGINATION')).toBe(true);
    expect(invalidBatched.commands).toHaveLength(0);
    // The default page follows maxPageSize for each parent.
    const capped = await run(on, authorsSource(on, '', 'id'));
    expect(capped.data.map(({ books }) => books.length)).toEqual(Array(10).fill(10));
    configureQueryLimits();

    const expected = await run(off, authorsSource(off));
    const collection = Object.getPrototypeOf(on.models.Book.collection);
    const aggregate = collection.aggregate;
    vi.spyOn(collection, 'aggregate').mockImplementation(function failUnion(pipeline, ...rest) {
      if (pipeline.some((stage) => stage.$unionWith)) throw new Error('simulated batch failure');
      return aggregate.call(this, pipeline, ...rest);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failed = await run(on, authorsSource(on));
    expectSameResult(failed, expected);
    expect(failed.errors).toBeUndefined();
    expect(failed.commands.map(({ union }) => union)).toEqual(Array(20).fill(false));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('simulated batch failure');
  }, 60000);

  it('reads alone the parents without a batch key, as before (custom results)', async () => {
    const [first, second, third] = documents.authors.map(({ _id }) => String(_id));
    const variableValues = { ids: [first, first, 'none', second.toUpperCase(), 'not-an-object-id', third] };
    const source = (fixture) => `mutation($ids: [String]) { ${fixture.name}Listed(input: { ids: $ids }) {
      name books(sort: { terms: [{ field: "title", order: ASC }, { field: "id", order: ASC }] }) { title } } }`;
    const expected = await run(off, source(off), {}, variableValues);
    const batched = await run(on, source(on), {}, variableValues);
    expectSameResult(batched, expected);
    expect(batched.errors).toBeUndefined();
    // A parent without an ID lists the orphans, as before.
    expect(batched.data.map(({ books }) => books.length)).toEqual([30, 30, 2, 30, 0, 30]);
    // Per parent: 5 commands (the malformed ID sends none). Batched: the two distinct batchable
    // parents in one command, then the parent without an ID and the uppercase ID alone.
    expect(expected.commands).toHaveLength(5);
    expect(batched.commands.map(({ union }) => union).sort()).toEqual([false, false, true]);
  }, 60000);

  it('cuts the child commands of an MCP list tool with nested collections', async () => {
    const counts = [];
    for (const fixture of [off, on]) {
      commands.length = 0;
      const listed = await generateMCPTools(fixture.schema).callTool(`${fixture.name}authors`, { sort: { terms: [{ field: 'name', order: 'ASC' }] } });
      expect(listed.isError).toBe(false);
      const authors = listed.structuredContent[`${fixture.name}authors`];
      expect(authors.map(({ books, awards }) => [books.length, awards.length])).toEqual(documents.authors.map((_, a) => [30, a % 4]));
      counts.push(childCommands(fixture).length);
    }
    expect(counts).toEqual([40, 8]);
  }, 60000);

  describe('models and adapters that keep one read per parent', () => {
    let side;
    let parents;
    beforeAll(async () => {
      // Supplied models on a separate runtime: one without an index on its connection field, one
      // with soft-delete aggregate middleware and a discriminator.
      const adapter = createMongoAdapter({ batchedCollections: true });
      const runtime = createRuntime(adapter);
      runtime.preventCreatingCollection(true);
      const options = { autoCreate: false, autoIndex: false };
      const Loose = mongoose.model('CBMLooseItem', new mongoose.Schema({ title: String, rank: Number, owner: mongoose.Schema.Types.ObjectId }, options));
      const softSchema = new mongoose.Schema({ title: String, owner: mongoose.Schema.Types.ObjectId, deleted: Boolean }, options);
      softSchema.pre('aggregate', function softDelete() {
        this.pipeline().unshift({ $match: { deleted: { $ne: true } } });
      });
      const Soft = mongoose.model('CBMSoftItem', softSchema);
      const Base = mongoose.model('CBMBaseItem', new mongoose.Schema({ title: String, owner: mongoose.Schema.Types.ObjectId }, options));
      const Special = Base.discriminator('CBMSpecialItem', new mongoose.Schema({ level: Number }));
      const item = (name, extra = {}) => new GraphQLObjectType({
        name, fields: () => ({ id: { type: GraphQLID }, title: { type: GraphQLString }, ...extra, owner: { type: Owner, extensions: ref('owner') } }),
      });
      const LooseType = item('CBMLooseItem', { rank: { type: GraphQLInt } });
      const SoftType = item('CBMSoftItem');
      const SpecialType = item('CBMSpecialItem', { level: { type: GraphQLInt } });
      const Owner = new GraphQLObjectType({
        name: 'CBMOwner',
        fields: () => ({
          id: { type: GraphQLID },
          name: { type: GraphQLString },
          loose: { type: new GraphQLList(LooseType), extensions: ref('owner') },
          soft: { type: new GraphQLList(SoftType), extensions: ref('owner') },
          specials: { type: new GraphQLList(SpecialType), extensions: ref('owner') },
        }),
      });
      runtime.connect(null, Owner, 'cbmowner', 'cbmowners');
      runtime.connect(Loose, LooseType, 'cbmlooseitem', 'cbmlooseitems');
      runtime.connect(Soft, SoftType, 'cbmsoftitem', 'cbmsoftitems');
      runtime.connect(Special, SpecialType, 'cbmspecialitem', 'cbmspecialitems');
      const schema = runtime.createSchema();
      const OwnerModel = runtime.getModel(Owner);
      await OwnerModel.createCollection();
      const owners = Array.from({ length: 10 }, (_, index) => ({ _id: oid(), name: `O${index}` }));
      parents = owners.map(({ _id }) => _id);
      await OwnerModel.collection.insertMany(owners);
      await Loose.collection.insertMany(shuffle(owners.flatMap(({ _id }, o) => Array.from({ length: 15 }, (_, index) => ({
        title: `L${o}-${String(index).padStart(2, '0')}`, rank: Math.floor(random() * 4), owner: _id,
      })))));
      await Soft.collection.insertMany(owners.flatMap(({ _id }) => [{ title: 'kept', owner: _id }, { title: 'gone', owner: _id, deleted: true }]));
      await Base.collection.insertMany(owners.flatMap(({ _id }) => [{ title: 'base', owner: _id }, { title: 'special', owner: _id, __t: 'CBMSpecialItem', level: 1 }]));
      side = {
        adapter, schema, models: {
          Owner: OwnerModel, Loose, Soft, Base, Special,
        }, types: {
          LooseType, SoftType, SpecialType,
        },
      };
    }, 60000);

    const query = (select) => graphql({ schema: side.schema, source: `{ cbmowners(sort: { terms: [{ field: "name", order: ASC }] }) { name ${select} } }`, contextValue: {} });
    // Per-parent reads, with batching turned off on this adapter instance.
    const perParent = async (select) => {
      const saved = Object.getOwnPropertyDescriptor(side.adapter, 'findChildrenBatch');
      side.adapter.findChildrenBatch = undefined;
      try {
        return await query(select);
      } finally {
        Object.defineProperty(side.adapter, 'findChildrenBatch', saved);
      }
    };
    const sideCommands = (Model) => commands.filter(({ collection }) => collection === Model.collection.collectionName);

    it('batches a supplied model without an index on its connection field, with the same rows', async () => {
      expect((await side.models.Loose.collection.indexes()).map(({ name }) => name)).toEqual(['_id_']);
      for (const [args, exact] of [['', false], ['(sort: { terms: [{ field: "rank", order: DESC }, { field: "title", order: ASC }] }, pagination: { page: 2, size: 4 })', true]]) {
        const select = `loose${args} { title rank }`;
        const expected = await perParent(select);
        commands.length = 0;
        const batched = await query(select);
        expect(batched.errors).toBeUndefined();
        expect(sideCommands(side.models.Loose).map(({ union }) => union)).toEqual([true, true]);
        if (exact) expect(batched).toEqual(expected);
        else {
          const sorted = (result) => result.data.cbmowners.map(({ loose }) => loose.map(({ title }) => title).sort());
          expect(sorted(batched)).toEqual(sorted(expected));
        }
      }
    }, 60000);

    it('keeps per-parent reads for aggregate middleware and discriminators, which a batch would bypass', async () => {
      commands.length = 0;
      const result = await query('soft { title } specials { title level }');
      expect(result.errors).toBeUndefined();
      expect(result.data.cbmowners.every(({ soft, specials }) => soft.map(({ title }) => title).join() === 'kept'
        && specials.map(({ title }) => title).join() === 'special')).toBe(true);
      expect(sideCommands(side.models.Soft).map(({ union }) => union)).toEqual(Array(10).fill(false));
      expect(sideCommands(side.models.Special).map(({ union }) => union)).toEqual(Array(10).fill(false));

      // Why: in one $unionWith command, Mongoose adds the middleware's and the discriminator's
      // $match only to the command's pipeline, so the second parent would see excluded rows.
      const sub = (owner, index) => [{ $match: { owner } }, { $replaceWith: { i: index, d: '$$ROOT' } }];
      for (const [Model, kept] of [[side.models.Soft, 'kept'], [side.models.Special, 'special']]) {
        const rows = await Model.aggregate([...sub(parents[0], 0),
          { $unionWith: { coll: Model.collection.collectionName, pipeline: sub(parents[1], 1) } }]);
        expect(rows.filter(({ i }) => i === 0).map(({ d }) => d.title)).toEqual([kept]);
        expect(rows.filter(({ i }) => i === 1)).toHaveLength(2);
      }
    }, 60000);

    it('keeps per-parent reads for an override of findChildren, so the override applies', async () => {
      const own = side.adapter.findChildren;
      const override = vi.fn(function onlyHighRanks(Model, gqltype, field, parentId, args, session) {
        return own.call(this, Model, gqltype, field, parentId, { ...args, rank: { operator: 'GTE', value: 2 } }, session);
      });
      side.adapter.findChildren = override;
      try {
        commands.length = 0;
        const result = await query('loose { rank }');
        expect(result.errors).toBeUndefined();
        expect(override).toHaveBeenCalledTimes(10);
        expect(result.data.cbmowners.flatMap(({ loose }) => loose).every(({ rank }) => rank >= 2)).toBe(true);
        expect(sideCommands(side.models.Loose).map(({ union }) => union)).toEqual(Array(10).fill(false));
      } finally {
        side.adapter.findChildren = own;
      }
    }, 60000);

    it('keeps per-parent reads in a session or a transactionAsyncLocalStorage transaction, which $unionWith would abort', async () => {
      const session = await mongoose.startSession();
      try {
        commands.length = 0;
        await expect(side.adapter.findChildrenBatch(side.models.Loose, side.types.LooseType, 'owner', parents, {}, { session }))
          .rejects.toThrow('reads children one parent at a time');
        expect(commands).toHaveLength(0);
      } finally {
        await session.endSession();
      }

      const outside = await query('loose { title }');
      mongoose.set('transactionAsyncLocalStorage', true);
      try {
        let inside;
        await mongoose.connection.transaction(async () => {
          commands.length = 0;
          inside = await query('loose { title }');
          const loose = sideCommands(side.models.Loose);
          expect(loose.map(({ union, transaction }) => [union, transaction])).toEqual(Array(10).fill([false, true]));
        });
        expect(inside.errors).toBeUndefined();
        const sorted = (result) => result.data.cbmowners.map(({ loose }) => loose.map(({ title }) => title).sort());
        expect(sorted(inside)).toEqual(sorted(outside));
      } finally {
        mongoose.set('transactionAsyncLocalStorage', false);
      }
    }, 60000);
  });
});
