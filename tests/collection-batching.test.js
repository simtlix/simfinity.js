import { AsyncLocalStorage } from 'node:async_hooks';
import { types } from 'node:util';
import {
  afterEach, describe, expect, test, vi,
} from 'vitest';
import {
  GraphQLID, GraphQLInt, GraphQLList, GraphQLObjectType, GraphQLSchema, GraphQLString, graphql,
} from 'graphql';

import {
  auth, configureQueryLimits, createRuntime, paginationStages, SimfinityError,
} from '../packages/core/src/index.js';
import { generateMCPTools } from '../packages/mcp/src/index.js';

// Generated collection fields read through adapter.findChildrenBatch when the adapter defines it and
// its batchesChildren predicate does not return false (#165). The in-memory adapter below reads each
// parent exactly as its findChildren does, so the equivalence cases test core plumbing (grouping,
// arguments, parents, chunks, fallbacks), not the order or pagination of a real backend, which the
// adapter suites cover.

const invalidId = () => new SimfinityError('Invalid ID', 'NOT_VALID_ID', 400);
// IDs starting with `bad` cannot be cast; others cast to their string form.
const defaultCastId = (value) => {
  if (String(value).startsWith('bad')) throw invalidId();
  return String(value);
};

// The stored identifier type of a few parents, like a MongoDB ObjectId: an object whose string form is its value.
class FakeObjectId {
  constructor(hex) { this.hex = hex; }

  toString() { return this.hex; }
}

const safeClone = (value) => {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
};

const RELATIONS = {
  LCAuthor: {},
  LCBook: { author: 'LCAuthor', publisher: 'LCPublisher' },
  LCPublisher: {},
  LCChapter: { book: 'LCBook' },
};

const compare = (left, right) => {
  if (left == null && right == null) return 0;
  if (left == null) return -1;
  if (right == null) return 1;
  if (left < right) return -1;
  return left > right ? 1 : 0;
};

const test1 = (actual, operator, value) => {
  switch (operator) {
    case 'EQ': return String(actual) === String(value);
    case 'NE': return String(actual) !== String(value);
    case 'GT': return actual != null && actual > value;
    case 'GTE': return actual != null && actual >= value;
    case 'LT': return actual != null && actual < value;
    case 'LTE': return actual != null && actual <= value;
    case 'IN': return value.map(String).includes(String(actual));
    case 'NIN': return !value.map(String).includes(String(actual));
    case 'LIKE': return actual != null && String(actual).includes(String(value));
    default: throw new SimfinityError(`Unsupported operator ${operator}`, 'INVALID_FILTER_VALUE', 400);
  }
};

// In-memory store with MongoDB-like collection semantics: findChildren matches the connection field
// against the cast parent ID (a missing parent ID matches children without a parent, an uncastable
// one matches none, an object parent ID with a `code` matches that code, and a stored list matches
// when one entry does, as a multikey field), applies filters, then sort (stable, so ties and unsorted
// reads keep insertion order) and per-parent pagination.
const createStore = (rows, castId) => {
  const table = (name) => rows[name] || [];
  const readPath = (typeName, row, segments) => {
    let currentType = typeName;
    let current = row;
    for (const [index, segment] of segments.entries()) {
      if (current == null) return undefined;
      const target = RELATIONS[currentType]?.[segment];
      if (target && index < segments.length - 1) {
        const id = current[segment];
        current = table(target).find((item) => String(item._id) === String(id));
        currentType = target;
      } else current = current[segment];
    }
    return current;
  };
  const matchesGroup = (typeName, row, group) => (group.conditions || []).every((condition) => test1(
    readPath(typeName, row, condition.field.split('.')), condition.operator, condition.value,
  )) && (group.AND || []).every((nested) => matchesGroup(typeName, row, nested))
    && (!group.OR?.length || group.OR.some((nested) => matchesGroup(typeName, row, nested)));
  const matches = (typeName, row, args) => {
    for (const [name, filter] of Object.entries(args)) {
      if (['pagination', 'sort', 'AND', 'OR', 'hint'].includes(name) || filter == null) continue;
      if (filter.terms) {
        for (const term of filter.terms) {
          if (!test1(readPath(typeName, row, [name, ...term.path.split('.')]), term.operator, term.value)) return false;
        }
      } else if (!test1(row[name], filter.operator, filter.value)) return false;
    }
    return (args.AND || []).every((group) => matchesGroup(typeName, row, group))
      && (!args.OR?.length || args.OR.some((group) => matchesGroup(typeName, row, group)));
  };
  const query = (typeName, candidates, args) => {
    const [{ $skip }, { $limit }] = paginationStages(args.pagination, true);
    let result = candidates.filter((row) => matches(typeName, row, args));
    if (args.sort) {
      const terms = args.sort.terms;
      result = [...result].sort((left, right) => {
        for (const { field, order } of terms) {
          const value = compare(readPath(typeName, left, field.split('.')), readPath(typeName, right, field.split('.')));
          if (value) return order === 'ASC' ? value : -value;
        }
        return 0;
      });
    }
    return result.slice($skip, $skip + $limit).map((row) => ({ ...row }));
  };
  const parentValue = (parentId) => {
    if (parentId == null) return null;
    if (typeof parentId === 'object' && 'code' in parentId) return parentId.code;
    try {
      return String(castId(parentId));
    } catch {
      return undefined;
    }
  };
  const children = (typeName, connectionField, parentId, args) => {
    const value = parentValue(parentId);
    if (value === undefined) return [];
    const stored = (row) => (Array.isArray(row[connectionField]) ? row[connectionField] : [row[connectionField]]);
    return query(typeName, table(typeName).filter((row) => (value === null
      ? row[connectionField] == null : stored(row).includes(value))), args);
  };
  return { table, query, children };
};

// The lists of a batch with each record's stored parent left out.
const withoutParent = (lists, connectionField) => lists.map(
  (list) => list.map(({ [connectionField]: omitted, ...record }) => { void omitted; return record; }),
);
// The lists of a defective batch that hands each parent the children of the next one.
const rotated = (lists) => lists.map((_, index) => lists[(index + 1) % lists.length]);

// Counting adapter. Without `batching` it has no findChildrenBatch. `predicate: false` leaves out
// batchesChildren; otherwise batchesChildren pairs the batch with the adapter's own findChildren, as
// the bundled adapters do. `failBatch` makes every batch fail ('error' rejects with an Error,
// 'sync' throws one, 'simfinity' rejects with a SimfinityError); `shape` makes it return another
// shape (a name below, or a function of the lists and `{ connectionField, parentIds }`);
// `changeBatchArgs` changes the arguments object a batch receives before the batch fails or reads,
// as an adapter that consumes them while it builds its query; `failChildrenOf` makes the reads of
// those parents fail (a batch that holds one of them fails as a whole, as the contract requires).
const createAdapter = (rows, {
  batching = true, predicate = true, failBatch = null, shape = null, changeBatchArgs, failChildrenOf = [],
  castId = defaultCastId, onRead,
} = {}) => {
  const store = createStore(rows, castId);
  const calls = {
    find: [], getById: [], getByIds: [], findChildren: [], findChildrenBatch: [],
  };
  const predicateCalls = [];
  const failFor = (parentId) => {
    if (failChildrenOf.includes(String(parentId))) {
      throw new SimfinityError(`Children of ${parentId} are unavailable`, 'CHILDREN_UNAVAILABLE', 503);
    }
  };
  const adapter = {
    calls,
    predicateCalls,
    store,
    bind() {},
    createModel: (gqltype) => ({ name: gqltype.name }),
    castId,
    withTransaction: async (session, body) => body(session || {}),
    async getById(Model, id) {
      calls.getById.push({ model: Model.name, id });
      return store.table(Model.name).find((row) => String(row._id) === castId(id)) ?? null;
    },
    async getByIds(Model, ids) {
      calls.getByIds.push({ model: Model.name, ids });
      const wanted = ids.map(castId);
      return store.table(Model.name).filter((row) => wanted.includes(String(row._id))).map((row) => ({ ...row }));
    },
    async find(Model, gqltype, args) {
      calls.find.push({ model: Model.name, args });
      return store.query(Model.name, store.table(Model.name), args);
    },
    async count(Model, gqltype, args) {
      return store.query(Model.name, store.table(Model.name), { ...args, pagination: { page: 1, size: 1000 } }).length;
    },
    async aggregate() { return []; },
    async findChildren(Model, gqltype, connectionField, parentId, args) {
      onRead?.();
      // The arguments are read when the call is made, as the bundled adapters build their query.
      calls.findChildren.push({
        model: Model.name, connectionField, parentId, args: safeClone(args), argsRef: args,
      });
      await Promise.resolve();
      failFor(parentId);
      return store.children(Model.name, connectionField, parentId, args);
    },
  };
  const ownFindChildren = adapter.findChildren;
  if (batching) {
    adapter.findChildrenBatch = function findChildrenBatch(Model, gqltype, connectionField, parentIds, args, options) {
      const call = {
        self: this, model: Model.name, connectionField, parentIds, args: safeClone(args), argsRef: args, options, failed: true,
      };
      calls.findChildrenBatch.push(call);
      changeBatchArgs?.(args);
      if (failBatch === 'sync') throw new TypeError('Batch read failed');
      return (async () => {
        await Promise.resolve();
        if (failBatch === 'error') throw new Error('Batch read failed');
        if (failBatch === 'simfinity') throw new SimfinityError('Batch read declined', 'BATCH_DECLINED', 503);
        parentIds.forEach(failFor);
        let lists = parentIds.map((parentId) => store.children(Model.name, connectionField, parentId, args));
        if (typeof shape === 'function') {
          call.failed = false;
          return shape(lists, { connectionField, parentIds });
        }
        if (shape === 'null') return null;
        if (shape === 'short') return lists.slice(1);
        // The last parent's list replaced by an array-like object; the others are right.
        if (shape === 'entry') return lists.map((list, index) => (index === lists.length - 1 ? { ...list, length: list.length } : list));
        if (shape === 'leak') return rotated(lists);
        // A batch whose records do not show their parent.
        if (shape === 'strip') lists = withoutParent(lists, connectionField);
        call.failed = false;
        return lists;
      })();
    };
    if (predicate) {
      adapter.batchesChildren = function batchesChildren(Model, gqltype, connectionField) {
        predicateCalls.push({ self: this, model: Model.name, connectionField });
        return this.findChildren === ownFindChildren;
      };
    }
  }
  return adapter;
};

const authorRows = Array.from({ length: 10 }, (_, index) => ({
  _id: `a${index}`, name: `Author ${index}`, tenant: index % 2 ? 'B' : 'A',
}));
const createRows = ({ authors = authorRows } = {}) => {
  const books = [];
  // Round robin, so each author's books are not contiguous in insertion (natural) order.
  for (let round = 0; round < 4; round += 1) {
    authors.forEach((author, index) => {
      const count = index === 9 ? 0 : (index % 4) + 1;
      if (round >= count) return;
      books.push({
        _id: `b${index}-${round}`,
        title: `Book ${index}-${round}`,
        year: 2000 + ((index + round * 3) % 5),
        tenant: author.tenant,
        author: String(author._id).toLowerCase(),
        publisher: `p${(index + round) % 2}`,
      });
    });
  }
  books.push({ _id: 'orphan-1', title: 'Orphan 1', year: 1999, tenant: 'A', author: null, publisher: 'p0' });
  books.push({ _id: 'orphan-2', title: 'Orphan 2', year: 1998, tenant: 'B', publisher: 'p1' });
  const chapters = books.flatMap((book) => [1, 2].map((n) => ({ _id: `${book._id}-c${n}`, n, book: book._id })));
  return {
    LCAuthor: authors,
    LCPublisher: [{ _id: 'p0', name: 'North', region: 'EU' }, { _id: 'p1', name: 'South', region: 'US' }],
    LCBook: books,
    LCChapter: chapters,
  };
};

// `middleware(params)` runs inside the recorded middleware; `scopes` adds find scopes by type name;
// `wrapAdapter` replaces the adapter the runtime binds.
const createFixture = (rows, {
  middleware, scopes = {}, plugins = [], wrapAdapter = (adapter) => adapter, ...adapterOptions
} = {}) => {
  const base = createAdapter(rows, adapterOptions);
  const adapter = wrapAdapter(base);
  const runtime = createRuntime(adapter);
  const middlewareCalls = [];
  runtime.use(async (params, next) => {
    middlewareCalls.push({ operation: params.operation, type: params.type?.gqltype?.name });
    if (middleware) await middleware(params);
    await next();
  });
  const withScope = (name) => (scopes[name] ? { scope: { find: scopes[name] } } : undefined);
  const rel = (connectionField) => ({ relation: { embedded: false, connectionField } });
  const Publisher = new GraphQLObjectType({
    name: 'LCPublisher',
    extensions: withScope('LCPublisher'),
    fields: () => ({ id: { type: GraphQLID }, name: { type: GraphQLString }, region: { type: GraphQLString } }),
  });
  const Chapter = new GraphQLObjectType({
    name: 'LCChapter',
    extensions: withScope('LCChapter'),
    fields: () => ({ id: { type: GraphQLID }, n: { type: GraphQLInt }, book: { type: Book, extensions: rel('book') } }),
  });
  const Book = new GraphQLObjectType({
    name: 'LCBook',
    extensions: withScope('LCBook'),
    fields: () => ({
      id: { type: GraphQLID },
      title: { type: GraphQLString },
      year: { type: GraphQLInt },
      tenant: { type: GraphQLString },
      author: { type: Author, extensions: rel('author') },
      publisher: { type: Publisher, extensions: rel('publisher') },
      chapters: { type: new GraphQLList(Chapter), extensions: rel('book') },
    }),
  });
  const Author = new GraphQLObjectType({
    name: 'LCAuthor',
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      tenant: { type: GraphQLString },
      books: { type: new GraphQLList(Book), extensions: rel('author') },
    }),
  });
  runtime.connect(null, Publisher, 'lcpublisher', 'lcpublishers');
  runtime.connect(null, Chapter, 'lcchapter', 'lcchapters');
  runtime.connect(null, Book, 'lcbook', 'lcbooks');
  runtime.connect(null, Author, 'lcauthor', 'lcauthors');
  const schema = runtime.createSchema();
  for (const plugin of plugins) plugin.onSchemaChange({ schema, replaceSchema: () => {} });
  const execute = (source, contextValue = {}, variableValues) => graphql({
    schema, source, contextValue, variableValues,
  });
  return {
    adapter: base, bound: adapter, middlewareCalls, execute, schema, Author,
  };
};

// The distinct parent IDs and arguments of the collection reads that returned data, whether read
// alone or in a batch (a batch reads a duplicate parent once).
const childReads = (adapter, model = 'LCBook') => {
  const reads = [
    ...adapter.calls.findChildren.filter((call) => call.model === model)
      .map((call) => ({ parentId: String(call.parentId), args: call.args })),
    ...adapter.calls.findChildrenBatch.filter((call) => call.model === model && !call.failed)
      .flatMap((call) => call.parentIds.map((parentId) => ({ parentId: String(parentId), args: call.args }))),
  ];
  const unique = new Map(reads.map((read) => [`${read.parentId}|${JSON.stringify(read.args)}`, read]));
  return [...unique.values()].sort((left, right) => compare(left.parentId, right.parentId));
};

const counts = (adapter, model = 'LCBook') => ({
  findChildren: adapter.calls.findChildren.filter((call) => call.model === model).length,
  findChildrenBatch: adapter.calls.findChildrenBatch.filter((call) => call.model === model).length,
});

// SimfinityError extensions carry a timestamp with one-second resolution; results compare without it.
const stable = (result) => JSON.parse(JSON.stringify(result, (key, value) => (key === 'timestamp' ? undefined : value)));

// Runs `source` on a per-parent adapter (no findChildrenBatch) and on a batching one, and checks
// that the results, middleware calls and each parent's effective arguments are the same.
const expectEquivalent = async (source, {
  rows = createRows(), context = () => ({}), variables, fixture: options = {}, model = 'LCBook',
} = {}) => {
  const perParent = createFixture(rows, { ...options, batching: false });
  const expected = await perParent.execute(source, context(), variables && structuredClone(variables));
  const batched = createFixture(rows, options);
  const result = await batched.execute(source, context(), variables && structuredClone(variables));
  expect(stable(result)).toEqual(stable(expected));
  expect(batched.middlewareCalls).toEqual(perParent.middlewareCalls);
  expect(childReads(batched.adapter, model)).toEqual(childReads(perParent.adapter, model));
  return {
    expected, result, perParent, batched,
  };
};

const asyncMiddleware = async () => {
  await Promise.resolve();
  await (async () => {
    await null;
    await Promise.resolve();
  })();
};

const silenceWarnings = () => vi.spyOn(console, 'warn').mockImplementation(() => {});
const batchWarnings = (warn) => warn.mock.calls.filter(([message]) => String(message).includes('findChildrenBatch'));

describe('batched collection reads (#165)', () => {
  afterEach(() => {
    configureQueryLimits();
    vi.restoreAllMocks();
  });

  describe('one adapter read per collection field and level', () => {
    test('reads the books of every listed author in one batch after async middleware', async () => {
      const source = '{ lcauthors { id name books { id title year } } }';
      const { perParent, batched, result } = await expectEquivalent(source, { fixture: { middleware: asyncMiddleware } });
      expect(result.errors).toBeUndefined();
      expect(counts(perParent.adapter)).toEqual({ findChildren: 10, findChildrenBatch: 0 });
      expect(counts(batched.adapter)).toEqual({ findChildren: 0, findChildrenBatch: 1 });
      const [call] = batched.adapter.calls.findChildrenBatch;
      expect(call.parentIds).toEqual(authorRows.map((author) => author._id));
      expect(call.connectionField).toBe('author');
      // Called as an adapter method, with the request context.
      expect(call.self).toBe(batched.adapter);
      expect(call.options).toEqual({ context: expect.any(Object) });
      expect(batched.middlewareCalls.filter((entry) => entry.type === 'LCBook')).toHaveLength(10);
      expect(batched.adapter.predicateCalls).toHaveLength(10);
      expect(batched.adapter.predicateCalls.every(({ self, model, connectionField }) => self === batched.adapter
        && model === 'LCBook' && connectionField === 'author')).toBe(true);
    });

    test('batches each collection field and nesting level once', async () => {
      const source = '{ lcauthors { id books { id chapters { id n } } } }';
      const { perParent, batched } = await expectEquivalent(source);
      expect(counts(perParent.adapter, 'LCChapter').findChildren).toBe(21);
      expect(counts(batched.adapter)).toEqual({ findChildren: 0, findChildrenBatch: 1 });
      expect(counts(batched.adapter, 'LCChapter')).toEqual({ findChildren: 0, findChildrenBatch: 1 });
      expect(childReads(batched.adapter, 'LCChapter')).toEqual(childReads(perParent.adapter, 'LCChapter'));
    });

    test('keeps fields with different arguments in separate batches', async () => {
      const source = `{ lcauthors { id
        newest: books(sort: { terms: [{ field: "year", order: DESC }] }) { id }
        second: books(pagination: { page: 2, size: 1 }) { id }
        plain: books { id } } }`;
      const { perParent, batched } = await expectEquivalent(source);
      expect(counts(perParent.adapter).findChildren).toBe(30);
      expect(counts(batched.adapter)).toEqual({ findChildren: 0, findChildrenBatch: 3 });
    });

    test('a lone parent reads with findChildren', async () => {
      const { batched, result } = await expectEquivalent('{ lcauthor(id: "a1") { id books { id } } }');
      expect(result.data.lcauthor.books).toHaveLength(2);
      expect(counts(batched.adapter)).toEqual({ findChildren: 1, findChildrenBatch: 0 });
    });

    test('fields of one parent share one findChildren read, each with its own list', async () => {
      const fixture = createFixture(createRows());
      const original = fixture.Author.getFields().books.resolve;
      const lists = [];
      fixture.Author.getFields().books.resolve = async (...args) => {
        const list = await original(...args);
        lists.push(list);
        return list;
      };
      const result = await fixture.execute('{ a: lcauthor(id: "a3") { books { id } } b: lcauthor(id: "a3") { books { id } } }');
      expect(result.errors).toBeUndefined();
      expect(result.data.a).toEqual(result.data.b);
      expect(counts(fixture.adapter)).toEqual({ findChildren: 1, findChildrenBatch: 0 });
      expect(lists).toHaveLength(2);
      expect(lists[0]).not.toBe(lists[1]);
      expect(lists[0]).toHaveLength(4);
      lists[0].forEach((record, index) => expect(lists[1][index]).toBe(record));
    });

    test('duplicate parents are read once in a batch', async () => {
      const source = '{ lcbooks(sort: { terms: [{ field: "title", order: ASC }] }) { id author { id books { id } } } }';
      const { batched, result } = await expectEquivalent(source);
      expect(result.errors).toBeUndefined();
      expect(counts(batched.adapter)).toEqual({ findChildren: 0, findChildrenBatch: 1 });
      const [call] = batched.adapter.calls.findChildrenBatch;
      expect(new Set(call.parentIds).size).toBe(call.parentIds.length);
      expect(call.parentIds).toHaveLength(9);
    });

    test('fields of a duplicate parent share its records: a resolver that changes a record shows it to the other fields', async () => {
      // As batched references share records. With per-parent reads each field had its own records.
      const run = async (batching) => {
        const fixture = createFixture(createRows(), { batching });
        const Book = fixture.schema.getType('LCBook');
        Book.getFields().title.resolve = (book) => {
          book.visits = (book.visits ?? 0) + 1;
          return `${book.title} #${book.visits}`;
        };
        const result = await fixture.execute('{ a: lcauthor(id: "a1") { books { title } } b: lcauthor(id: "a1") { books { title } } }');
        return [result.data.a.books, result.data.b.books].map((books) => books.map((book) => book.title));
      };
      expect(await run(false)).toEqual([['Book 1-0 #1', 'Book 1-1 #1'], ['Book 1-0 #1', 'Book 1-1 #1']]);
      expect(await run(true)).toEqual([['Book 1-0 #1', 'Book 1-1 #1'], ['Book 1-0 #2', 'Book 1-1 #2']]);
    });
  });

  describe('chunks of at most 100 distinct parents, whatever maxPageSize is', () => {
    const manyAuthors = (count) => {
      const authors = Array.from({ length: count }, (_, index) => ({ _id: `m${String(index).padStart(3, '0')}`, name: `M${index}` }));
      const rows = createRows({ authors: [] });
      rows.LCAuthor = authors;
      rows.LCBook = authors.map((author, index) => ({
        _id: `mb${index}`, title: `MB ${index}`, year: 2000, author: author._id, publisher: 'p0',
      }));
      return rows;
    };

    test('250 parents read in batches of 100, 100 and 50', async () => {
      const source = '{ lcauthors(pagination: { page: 1, size: 250 }) { id books { id } } }';
      const { batched, result } = await expectEquivalent(source, { rows: manyAuthors(250) });
      expect(result.data.lcauthors).toHaveLength(250);
      expect(batched.adapter.calls.findChildrenBatch.map((call) => call.parentIds.length)).toEqual([100, 100, 50]);
      expect(counts(batched.adapter).findChildren).toBe(0);
    });

    test('a remainder of one parent reads with findChildren', async () => {
      const source = '{ lcauthors(pagination: { page: 1, size: 201 }) { id books { id } } }';
      const { batched } = await expectEquivalent(source, { rows: manyAuthors(201) });
      expect(batched.adapter.calls.findChildrenBatch.map((call) => call.parentIds.length)).toEqual([100, 100]);
      expect(batched.adapter.calls.findChildren.map((call) => call.parentId)).toEqual(['m200']);
    });

    test('maxPageSize does not set the chunk size', async () => {
      configureQueryLimits({ maxPageSize: 20 });
      // Six lists of 20 authors resolve together, so their books form one group of 120 parents.
      const source = `{ ${Array.from({ length: 6 }, (_, page) => `p${page}: lcauthors(pagination: { page: ${page + 1}, size: 20 }) { id books { id } }`).join(' ')} }`;
      const { batched, result } = await expectEquivalent(source, { rows: manyAuthors(120) });
      expect(result.errors).toBeUndefined();
      expect(batched.adapter.calls.findChildrenBatch.map((call) => call.parentIds.length)).toEqual([100, 20]);
    });
  });

  describe('core plumbing: equivalence with per-parent reads (the memory batch reads each parent as findChildren does)', () => {
    test.each([
      ['unsorted', '{ lcauthors { id books { id title } } }'],
      ['sorted', '{ lcauthors { id books(sort: { terms: [{ field: "year", order: DESC }, { field: "title", order: ASC }] }) { id year } } }'],
      ['sorted through a relation', '{ lcauthors { id books(sort: { terms: [{ field: "publisher.name", order: ASC }] }) { id } } }'],
      ['explicit page', '{ lcauthors { id books(pagination: { page: 2, size: 1 }) { id } } }'],
      ['page beyond the children', '{ lcauthors { id books(pagination: { page: 9, size: 2 }) { id } } }'],
      ['scalar filter', '{ lcauthors { id books(year: { operator: GTE, value: 2002 }) { id year } } }'],
      ['IN filter', '{ lcauthors { id books(year: { operator: IN, value: [2000, 2004] }) { id } } }'],
      ['AND/OR groups', `{ lcauthors { id books(OR: [
        { conditions: [{ field: "year", operator: LT, value: 2001 }] },
        { AND: [{ conditions: [{ field: "title", operator: LIKE, value: "-1" }] }] }
      ]) { id } } }`],
      ['relation term', '{ lcauthors { id books(publisher: { terms: [{ path: "name", operator: EQ, value: "North" }] }) { id } } }'],
    ])('%s', async (label, source) => {
      const { result, batched } = await expectEquivalent(source);
      expect(result.errors).toBeUndefined();
      expect(counts(batched.adapter)).toEqual({ findChildren: 0, findChildrenBatch: 1 });
    });

    test('default page size per parent with a low maxPageSize', async () => {
      configureQueryLimits({ maxPageSize: 2 });
      const { result, batched } = await expectEquivalent('{ lcauthors(pagination: { page: 1, size: 2 }) { id books { id } } }');
      expect(result.errors).toBeUndefined();
      expect(result.data.lcauthors[1].books).toHaveLength(2);
      expect(counts(batched.adapter)).toEqual({ findChildren: 0, findChildrenBatch: 1 });
    });

    test('variables shared by every parent', async () => {
      const { batched } = await expectEquivalent(
        'query ($f: QLFilter, $s: QLSortExpression) { lcauthors { id books(year: $f, sort: $s) { id } } }',
        { variables: { f: { operator: 'LTE', value: 2003 }, s: { terms: [{ field: 'title', order: 'DESC' }] } } },
      );
      expect(counts(batched.adapter)).toEqual({ findChildren: 0, findChildrenBatch: 1 });
    });

    test('find scope and joined scope from the context', async () => {
      const scopes = {
        LCBook: async ({ args, context }) => {
          args.tenant = { operator: 'EQ', value: context.tenant };
        },
        LCPublisher: async ({ args, context }) => {
          args.region = { operator: 'EQ', value: context.region };
        },
      };
      const source = '{ lcauthors { id books(publisher: { terms: [{ path: "name", operator: LIKE, value: "o" }] }) { id tenant } } }';
      const { batched, result } = await expectEquivalent(source, {
        fixture: { scopes }, context: () => ({ tenant: 'A', region: 'EU' }),
      });
      expect(result.errors).toBeUndefined();
      expect(counts(batched.adapter)).toEqual({ findChildren: 0, findChildrenBatch: 1 });
      const [{ args }] = batched.adapter.calls.findChildrenBatch;
      expect(args.tenant).toEqual({ operator: 'EQ', value: 'A' });
      expect(args.AND).toEqual([{ conditions: [{ field: 'publisher.region', operator: 'EQ', value: 'EU' }] }]);
    });

    test('a joined scope that restricts only one OR group', async () => {
      const scopes = { LCPublisher: async ({ args }) => { args.region = { operator: 'EQ', value: 'US' }; } };
      const { batched } = await expectEquivalent(`{ lcauthors { id books(OR: [
        { conditions: [{ field: "publisher.name", operator: EQ, value: "South" }] },
        { conditions: [{ field: "year", operator: EQ, value: 2000 }] }
      ]) { id } } }`, { fixture: { scopes } });
      expect(counts(batched.adapter)).toEqual({ findChildren: 0, findChildrenBatch: 1 });
    });

    test('ObjectId-like parent IDs batch under their string form and reach the adapter as they are', async () => {
      const authors = authorRows.map((author) => ({ ...author, _id: new FakeObjectId(author._id) }));
      const { batched } = await expectEquivalent('{ lcauthors { books { id } } }', { rows: createRows({ authors }) });
      const [call] = batched.adapter.calls.findChildrenBatch;
      expect(call.parentIds).toHaveLength(10);
      expect(call.parentIds.every((id) => id instanceof FakeObjectId)).toBe(true);
    });

    test('concurrent requests with the same arguments keep separate batches, each in its own async context', async () => {
      // The request is its context object: two with equal content and the same query read the same
      // parents with the same arguments, so only the context keeps their groups apart.
      const requests = new AsyncLocalStorage();
      const stores = [];
      const fixture = createFixture(createRows(), {
        wrapAdapter: (adapter) => {
          const batch = adapter.findChildrenBatch;
          adapter.findChildrenBatch = function findChildrenBatch(...args) {
            stores.push(requests.getStore());
            return batch.apply(this, args);
          };
          return adapter;
        },
      });
      const [first, second] = [{ tenant: 'A' }, { tenant: 'A' }];
      const [firstStore, secondStore] = [{ request: 1 }, { request: 2 }];
      const source = '{ lcauthors { id books { id } } }';
      const [one, two] = await Promise.all([
        requests.run(firstStore, () => fixture.execute(source, first)),
        requests.run(secondStore, () => fixture.execute(source, second)),
      ]);
      expect(one.errors).toBeUndefined();
      expect(two).toEqual(one);
      const authorIds = authorRows.map((author) => author._id);
      const batches = fixture.adapter.calls.findChildrenBatch;
      expect(batches.map((call) => call.parentIds)).toEqual([authorIds, authorIds]);
      expect(batches[0].options.context).toBe(first);
      expect(batches[1].options.context).toBe(second);
      // Each batch runs in the async context of the request whose fields it reads.
      expect(stores).toHaveLength(2);
      expect(stores[0]).toBe(firstStore);
      expect(stores[1]).toBe(secondStore);
    });

    test('middleware that replaces params.args or freezes them still batches, with a frozen copy', async () => {
      const middleware = async (params) => {
        if (params.operation === 'find' && params.type.gqltype.name === 'LCBook') {
          params.args = Object.freeze({ ...params.args, pagination: Object.freeze({ page: 1, size: 2 }) });
        }
      };
      const { batched } = await expectEquivalent('{ lcauthors { id books { id } } }', { fixture: { middleware } });
      expect(counts(batched.adapter)).toEqual({ findChildren: 0, findChildrenBatch: 1 });
      const [{ argsRef }] = batched.adapter.calls.findChildrenBatch;
      expect(Object.isFrozen(argsRef)).toBe(true);
      expect(Object.isFrozen(argsRef.pagination)).toBe(true);
    });

    test('a middleware change to a shared variable object reaches each parent as it would per parent', async () => {
      // Mutates the request's variable value, which graphql-js shares between the parents' calls.
      const middleware = async (params) => {
        if (params.operation === 'find' && params.args.year) params.args.year.value += 1;
      };
      await expectEquivalent('query ($f: QLFilter) { lcauthors { id books(year: $f) { id year } } }', {
        fixture: { middleware: async (params) => { await middleware(params); await asyncMiddleware(); } },
        variables: { f: { operator: 'GTE', value: 1995 } },
      });
      await expectEquivalent('query ($f: QLFilter) { lcauthors { id books(year: $f) { id year } } }', {
        fixture: { middleware: async (params) => { await asyncMiddleware(); await middleware(params); } },
        variables: { f: { operator: 'LTE', value: 2000 } },
      });
    });

    test('middleware that waits for I/O still returns the per-parent results', async () => {
      // A timer per call, as a database lookup in middleware would: siblings no longer reach the
      // loader in the same promise jobs, so they form several smaller groups.
      const middleware = async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); };
      await expectEquivalent('{ lcauthors { id books { id } } }', { fixture: { middleware } });
    });

    test('authorization rules run per field and only allowed fields join the batch', async () => {
      const plugin = () => auth.createAuthPlugin({
        LCAuthor: { books: async (parent) => { await Promise.resolve(); return parent.tenant === 'A'; } },
      }, { defaultPolicy: 'ALLOW' });
      const source = '{ lcauthors { id books(year: { operator: GTE, value: 2000 }) { id } } }';
      const perParent = createFixture(createRows(), { batching: false, plugins: [plugin()] });
      const batched = createFixture(createRows(), { plugins: [plugin()] });
      const expected = await perParent.execute(source);
      const result = await batched.execute(source);
      expect(stable(result)).toEqual(stable(expected));
      expect(result.errors).toHaveLength(5);
      expect(result.errors.every((error) => error.extensions.code === 'FORBIDDEN')).toBe(true);
      expect(batched.adapter.calls.findChildrenBatch.map((call) => call.parentIds)).toEqual([['a0', 'a2', 'a4', 'a6', 'a8']]);
      expect(counts(perParent.adapter).findChildren).toBe(5);
    });

    test('an MCP list tool with nested collections makes one read per collection field', async () => {
      const run = async (batching) => {
        const fixture = createFixture(createRows(), { batching });
        const { callTool } = generateMCPTools(fixture.schema, {});
        const result = await callTool('lcauthors', {});
        return { fixture, result };
      };
      const perParent = await run(false);
      const batched = await run(true);
      expect(batched.result).toEqual(perParent.result);
      expect(batched.result.isError).toBeFalsy();
      expect(counts(perParent.fixture.adapter)).toEqual({ findChildren: 10, findChildrenBatch: 0 });
      expect(counts(batched.fixture.adapter)).toEqual({ findChildren: 0, findChildrenBatch: 1 });
    });

    test('lote 8 shape: an MCP list of 20 shops with 3 collections of 30 rows takes 4 reads instead of 61', async () => {
      const run = async (batching) => {
        const rows = { L9Shop: [], L9Service: [], L9Review: [], L9Booking: [] };
        for (let shop = 0; shop < 20; shop += 1) {
          rows.L9Shop.push({ _id: `s${shop}`, name: `Shop ${shop}` });
          for (let item = 0; item < 30; item += 1) {
            for (const name of ['L9Service', 'L9Review', 'L9Booking']) {
              rows[name].push({ _id: `${name}-${shop}-${item}`, label: `${item}`, shop: `s${shop}` });
            }
          }
        }
        const adapter = createAdapter(rows, { batching });
        const runtime = createRuntime(adapter);
        const child = (name) => new GraphQLObjectType({
          name, fields: () => ({ id: { type: GraphQLID }, label: { type: GraphQLString } }),
        });
        const [Service, Review, Booking] = ['L9Service', 'L9Review', 'L9Booking'].map(child);
        const rel = { relation: { embedded: false, connectionField: 'shop' } };
        const Shop = new GraphQLObjectType({
          name: 'L9Shop',
          fields: () => ({
            id: { type: GraphQLID },
            name: { type: GraphQLString },
            services: { type: new GraphQLList(Service), extensions: rel },
            reviews: { type: new GraphQLList(Review), extensions: rel },
            bookings: { type: new GraphQLList(Booking), extensions: rel },
          }),
        });
        for (const [type, name] of [[Service, 'l9service'], [Review, 'l9review'], [Booking, 'l9booking'], [Shop, 'l9shop']]) {
          runtime.connect(null, type, name, `${name}s`);
        }
        const { callTool } = generateMCPTools(runtime.createSchema(), {
          limits: { defaultPagination: { page: 1, size: 20 }, maxPageSize: 50 },
        });
        const result = await callTool('l9shops', {});
        return { adapter, result };
      };
      const perParent = await run(false);
      const batched = await run(true);
      const total = (adapter) => Object.fromEntries(Object.entries(adapter.calls).map(([name, list]) => [name, list.length]));
      expect(batched.result).toEqual(perParent.result);
      expect(total(perParent.adapter)).toEqual({
        find: 1, getById: 0, getByIds: 0, findChildren: 60, findChildrenBatch: 0,
      });
      expect(total(batched.adapter)).toEqual({
        find: 1, getById: 0, getByIds: 0, findChildren: 0, findChildrenBatch: 3,
      });
      expect(batched.adapter.calls.findChildrenBatch.map((call) => call.parentIds.length)).toEqual([20, 20, 20]);
    });
  });

  describe('grouping key', () => {
    // Author.books reads through `author` and Author.edited through `editor`: same child type, same
    // arguments, different connection fields.
    const editorFixture = (options = {}) => {
      const authors = Array.from({ length: 6 }, (_, index) => ({ _id: `e${index}`, name: `E${index}` }));
      const books = authors.flatMap((author, index) => [0, 1, 2].map((n) => ({
        _id: `eb${index}-${n}`, title: `EB${index}-${n}`, author: author._id, editor: authors[(index + 1) % 6]._id,
      })));
      const adapter = createAdapter({ EAuthor: authors, EBook: books }, options);
      const runtime = createRuntime(adapter);
      const rel = (connectionField) => ({ relation: { embedded: false, connectionField } });
      const Book = new GraphQLObjectType({
        name: 'EBook',
        fields: () => ({
          id: { type: GraphQLID },
          title: { type: GraphQLString },
          author: { type: Author, extensions: rel('author') },
          editor: { type: Author, extensions: rel('editor') },
        }),
      });
      const Author = new GraphQLObjectType({
        name: 'EAuthor',
        fields: () => ({
          id: { type: GraphQLID },
          name: { type: GraphQLString },
          books: { type: new GraphQLList(Book), extensions: rel('author') },
          edited: { type: new GraphQLList(Book), extensions: rel('editor') },
        }),
      });
      runtime.connect(null, Book, 'ebook', 'ebooks');
      runtime.connect(null, Author, 'eauthor', 'eauthors');
      const schema = runtime.createSchema();
      return { adapter, execute: (source) => graphql({ schema, source, contextValue: {} }) };
    };

    test('includes the connection storage field', async () => {
      const source = '{ eauthors { id books { id } edited { id } } }';
      const perParent = editorFixture({ batching: false });
      const batched = editorFixture();
      const expected = await perParent.execute(source);
      const result = await batched.execute(source);
      expect(result).toEqual(expected);
      expect(result.data.eauthors[0].edited.map((book) => book.id)).toEqual(['eb5-0', 'eb5-1', 'eb5-2']);
      expect(batched.adapter.calls.findChildrenBatch.map((call) => [call.connectionField, call.parentIds.length]))
        .toEqual([['author', 6], ['editor', 6]]);
    });

    // Parents returned by an application resolver.
    const ghostSchema = (fixture, parents) => new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'LCGhostQuery',
        fields: { ghosts: { type: new GraphQLList(fixture.Author), resolve: () => parents } },
      }),
    });
    const compareGhosts = async (parents, options = {}) => {
      const perParent = createFixture(createRows(), { ...options, batching: false });
      const batched = createFixture(createRows(), options);
      const source = '{ ghosts { name books { id } } }';
      const expected = await graphql({ schema: ghostSchema(perParent, parents), source, contextValue: {} });
      const result = await graphql({ schema: ghostSchema(batched, parents), source, contextValue: {} });
      expect(result).toEqual(expected);
      return { result, batched };
    };

    test('a parent without an ID reads alone, with the adapter semantics of findChildren', async () => {
      const { result, batched } = await compareGhosts([{ name: 'ghost' }, { _id: 'a1', name: 'Author 1' }, { id: null, name: 'other' }, { _id: 'a2' }]);
      expect(result.data.ghosts[0].books.map((book) => book.id)).toEqual(['orphan-1', 'orphan-2']);
      expect(batched.adapter.calls.findChildren.map((call) => call.parentId)).toEqual([undefined, null]);
      expect(batched.adapter.calls.findChildrenBatch.map((call) => call.parentIds)).toEqual([['a1', 'a2']]);
    });

    test('fields whose parents hold one ID in two forms share a parent, and read alone with their own form', async () => {
      const objectId = new FakeObjectId('a1');
      const parents = [{ _id: 'a1', name: 'string' }, { _id: objectId, name: 'object' }, { _id: 'a2', name: 'two' }];
      const shared = await compareGhosts(parents);
      expect(shared.batched.adapter.calls.findChildrenBatch.map((call) => call.parentIds)).toEqual([['a1', 'a2']]);
      const failed = await compareGhosts(parents, { failBatch: 'simfinity' });
      expect(failed.result.data.ghosts.map((ghost) => ghost.books.length)).toEqual([2, 2, 3]);
      expect(failed.batched.adapter.calls.findChildren.map((call) => call.parentId)).toEqual(['a1', objectId, 'a2']);
    });

    test('an object parent ID whose string form says nothing of its value reads alone', async () => {
      // A lenient castId accepts the objects unchanged, so only the string form check keeps them apart.
      const first = { code: 'a1' };
      const second = { code: 'a2' };
      const { result, batched } = await compareGhosts(
        [{ _id: first, name: 'first' }, { _id: second, name: 'second' }, { _id: 'a3', name: 'three' }, { _id: 'a4', name: 'four' }],
        { castId: (value) => value },
      );
      expect(result.data.ghosts.map((ghost) => ghost.books.length)).toEqual([2, 3, 4, 1]);
      expect(batched.adapter.calls.findChildren.map((call) => call.parentId)).toEqual([first, second]);
      expect(batched.adapter.calls.findChildrenBatch.map((call) => call.parentIds)).toEqual([['a3', 'a4']]);
    });

    test('a parent ID that castId normalizes reads alone', async () => {
      // castId lowercases, as the MongoDB adapter does with uppercase ObjectId hex.
      const castId = (value) => String(value).toLowerCase();
      const authors = authorRows.slice(0, 4).map((author) => (author._id === 'a2' ? { ...author, _id: 'A2' } : author));
      const rows = createRows({ authors });
      rows.LCAuthor = [...authors, { _id: 'a2', name: 'Lower 2', tenant: 'A' }];
      const { batched, result } = await expectEquivalent('{ lcauthors { id books { id } } }', { rows, fixture: { castId } });
      expect(result.data.lcauthors.map((author) => author.books.length)).toEqual([1, 2, 3, 4, 3]);
      expect(batched.adapter.calls.findChildren.map((call) => call.parentId)).toEqual(['A2']);
      expect(batched.adapter.calls.findChildrenBatch.map((call) => call.parentIds)).toEqual([['a0', 'a1', 'a3', 'a2']]);
    });

    test('a parent ID the adapter cannot cast reads alone and keeps its result', async () => {
      const authors = [...authorRows.slice(0, 3), { _id: 'bad-4', name: 'Bad', tenant: 'A' }];
      const { batched } = await expectEquivalent('{ lcauthors { id books { id } } }', { rows: createRows({ authors }) });
      expect(batched.adapter.calls.findChildren.map((call) => call.parentId)).toEqual(['bad-4']);
      expect(batched.adapter.calls.findChildrenBatch.map((call) => call.parentIds)).toEqual([['a0', 'a1', 'a2']]);
    });

    test('dates batch by value; functions, class instances, symbols and per-call values read per parent', async () => {
      const date = await expectEquivalent('{ lcauthors { books { id } } }', {
        fixture: { middleware: async (params) => { params.args.hint = new Date(0); } },
      });
      expect(counts(date.batched.adapter)).toEqual({ findChildren: 0, findChildrenBatch: 1 });
      expect(date.batched.adapter.calls.findChildrenBatch[0].argsRef.hint).toEqual(new Date(0));

      const instance = new (class Hint {})();
      for (const hint of [() => 1, instance, Symbol('hint')]) {
        const fixture = createFixture(createRows(), { middleware: async (params) => { params.args.hint = hint; } });
        const result = await fixture.execute('{ lcauthors { books { id } } }');
        expect(result.errors).toBeUndefined();
        expect(counts(fixture.adapter)).toEqual({ findChildren: 10, findChildrenBatch: 0 });
        // Read at once, with the object the middleware left.
        expect(fixture.adapter.calls.findChildren.every((call) => call.argsRef.hint === hint)).toBe(true);
      }

      let counter = 0;
      const differing = createFixture(createRows(), {
        middleware: async (params) => { if (params.operation === 'find') params.args.hint = counter++; },
      });
      expect((await differing.execute('{ lcauthors { books { id } } }')).errors).toBeUndefined();
      // Each parent's arguments differ, so each read is alone.
      expect(counts(differing.adapter)).toEqual({ findChildren: 10, findChildrenBatch: 0 });
    });

    test('keeps plain data with equal values apart when the key would differ', async () => {
      const variants = [
        () => ({ a: 1, b: 2 }), () => ({ b: 2, a: 1 }), () => Object.assign(Object.create(null), { a: 1, b: 2 }),
        () => Object.freeze({ a: 1, b: 2 }), () => [1, 2], () => ({ 0: 1, 1: 2 }), () => -0, () => 0, () => 1n, () => '1',
        () => 1, () => undefined, () => null, () => new Date(1), () => [new Date(1)], () => NaN,
      ];
      let call = 0;
      const fixture = createFixture(createRows(), {
        middleware: async (params) => {
          if (params.type.gqltype.name !== 'LCBook') return;
          params.args.hint = variants[call % variants.length]();
          call += 1;
        },
      });
      const source = `{ ${variants.map((_, index) => `v${index}: lcauthor(id: "a${index % 9}") { books { id } }`).join(' ')}
        ${variants.map((_, index) => `w${index}: lcauthor(id: "a${(index + 1) % 9}") { books { id } }`).join(' ')} }`;
      const result = await fixture.execute(source);
      expect(result.errors).toBeUndefined();
      // Each variant forms its own group of two parents.
      expect(fixture.adapter.calls.findChildrenBatch).toHaveLength(variants.length);
      expect(fixture.adapter.calls.findChildrenBatch.every((batch) => batch.parentIds.length === 2)).toBe(true);
      expect(counts(fixture.adapter).findChildren).toBe(0);
    });

    test('cyclic, accessor, sparse, inherited, sealed, hidden and exotic arguments read per parent', async () => {
      const makers = [
        () => { const cycle = {}; cycle.self = cycle; return cycle; },
        () => Object.defineProperty({}, 'value', { get: () => 1, enumerable: true }),
        // eslint-disable-next-line no-sparse-arrays
        () => [1, , 3],
        () => Object.preventExtensions({ a: 1 }),
        () => Object.seal({ a: 1 }),
        () => Object.assign(Object.create({ inherited: 1 }), { a: 1 }),
        () => new Proxy({}, { ownKeys: () => { throw new Error('trap'); } }),
        () => Object.defineProperty({}, 'hidden', { value: 1, enumerable: false }),
        () => Object.assign([1, 2], { extra: true }),
        () => ({ [Symbol('key')]: 1 }),
        () => Object.assign(new Date(0), { extra: true }),
        () => Object.create(Date.prototype),
      ];
      for (const make of makers) {
        const fixture = createFixture(createRows(), { middleware: async (params) => { params.args.hint = make(); } });
        await fixture.execute('{ lcauthors { books { id } } }');
        expect(counts(fixture.adapter)).toEqual({ findChildren: 10, findChildrenBatch: 0 });
      }
    });

    test('arguments with a key over 64 KiB read per parent with the arguments object they built', async () => {
      const run = async (size) => {
        const hint = Array.from({ length: size }, (_, index) => `${'x'.repeat(16)}${String(index).padStart(5, '0')}`);
        const seen = [];
        const fixture = createFixture(createRows(), {
          middleware: async (params) => {
            if (params.type.gqltype.name !== 'LCBook') return;
            params.args.hint = hint;
            seen.push(params.args);
          },
        });
        const result = await fixture.execute('{ lcauthors { books { id } } }');
        expect(result.errors).toBeUndefined();
        return { fixture, seen };
      };
      // About 24 characters per entry: 2,000 entries fit, 3,000 do not.
      const within = await run(2000);
      expect(counts(within.fixture.adapter)).toEqual({ findChildren: 0, findChildrenBatch: 1 });
      const over = await run(3000);
      expect(counts(over.fixture.adapter)).toEqual({ findChildren: 10, findChildrenBatch: 0 });
      expect(over.fixture.adapter.calls.findChildren.map((call) => call.argsRef)).toEqual(over.seen);
      over.fixture.adapter.calls.findChildren.forEach((call, index) => expect(call.argsRef).toBe(over.seen[index]));
    });

    test('canonicalizes each field\'s arguments once and copies them once per group and adapter call', async () => {
      const run = async (options) => {
        const traps = { ownKeys: 0, get: 0 };
        const hint = new Proxy({ ids: Array.from({ length: 50 }, (_, index) => `id${index}`) }, {
          ownKeys(target) { traps.ownKeys += 1; return Reflect.ownKeys(target); },
          get(target, key, receiver) { if (key === 'ids') traps.get += 1; return Reflect.get(target, key, receiver); },
        });
        const fixture = createFixture(createRows(), {
          ...options,
          middleware: async (params) => { if (params.type.gqltype.name === 'LCBook') params.args.hint = hint; },
        });
        await fixture.execute('{ lcauthors { books { id } } }');
        const argsObjects = [
          ...fixture.adapter.calls.findChildrenBatch.map((call) => call.argsRef),
          ...fixture.adapter.calls.findChildren.map((call) => call.argsRef),
        ];
        return { traps, fixture, argsObjects };
      };
      // Ten fields read the key once each; the group's first field also copies the arguments once,
      // which is the only read of a value (`get`). Adapter calls receive copies of that copy.
      const batched = await run({});
      expect(counts(batched.fixture.adapter)).toEqual({ findChildren: 0, findChildrenBatch: 1 });
      expect(batched.traps).toEqual({ ownKeys: 11, get: 1 });
      const failed = await run({ failBatch: 'simfinity' });
      expect(counts(failed.fixture.adapter)).toEqual({ findChildren: 10, findChildrenBatch: 1 });
      expect(failed.traps).toEqual({ ownKeys: 11, get: 1 });
      // Each adapter call has its own copy.
      expect(new Set(failed.argsObjects).size).toBe(11);
      expect(failed.argsObjects.every((args) => !types.isProxy(args.hint) && Array.isArray(args.hint.ids))).toBe(true);
    });
  });

  describe('adapters that do not batch', () => {
    // A microtask chain started by the books' find scope counts the promise jobs that run before
    // findChildren is called. A batched read waits until they have all run.
    const tickFixture = (options) => {
      const ticks = { count: 0, observed: [], args: [] };
      const casts = [];
      const fixture = createFixture(createRows(), {
        ...options,
        onRead: () => ticks.observed.push(ticks.count),
        scopes: {
          LCBook: ({ args }) => {
            ticks.args.push(args);
            ticks.count = 0;
            const step = () => {
              ticks.count += 1;
              if (ticks.count < 1000) queueMicrotask(step);
            };
            queueMicrotask(step);
          },
        },
        wrapAdapter: (adapter) => {
          // Counts the casts the runtime asks for; the memory store casts through its own closure.
          const castId = adapter.castId;
          adapter.castId = (value) => { casts.push(value); return castId(value); };
          return options.wrapAdapter ? options.wrapAdapter(adapter) : adapter;
        },
      });
      return { ...fixture, ticks, casts };
    };

    test('read at once, with the arguments object the field built, and call nothing else', async () => {
      const unexpected = [];
      const variants = {
        // No findChildrenBatch; a predicate without it is never called.
        noBatch: tickFixture({
          batching: false,
          wrapAdapter: (adapter) => Object.assign(adapter, { batchesChildren(...args) { unexpected.push(args); return true; } }),
        }),
        // batchesChildren returns false.
        declined: tickFixture({
          wrapAdapter: (adapter) => Object.assign(adapter, {
            batchesChildren(...args) { adapter.predicateCalls.push(args); return false; },
          }),
        }),
        batching: tickFixture({}),
      };
      const observed = {};
      for (const [name, fixture] of Object.entries(variants)) {
        const result = await fixture.execute('{ lcauthor(id: "a1") { books { id } } }');
        expect(result.data.lcauthor.books).toHaveLength(2);
        const [read] = fixture.adapter.calls.findChildren;
        observed[name] = {
          ticks: fixture.ticks.observed,
          casts: fixture.casts.length,
          batches: fixture.adapter.calls.findChildrenBatch.length,
          sameArgs: read.argsRef === fixture.ticks.args[0],
        };
      }
      // Reads that do not batch call findChildren with the field's arguments object after the same
      // number of promise jobs as 3.6.0 (2), and ask nothing else of the adapter.
      expect(observed.noBatch).toEqual({
        ticks: [2], casts: 0, batches: 0, sameArgs: true,
      });
      expect(observed.declined).toEqual({
        ticks: [2], casts: 0, batches: 0, sameArgs: true,
      });
      expect(unexpected).toHaveLength(0);
      expect(variants.declined.adapter.predicateCalls).toHaveLength(1);
      // A read that could batch waits for the flush, then reads its lone parent with a copy.
      expect(observed.batching).toEqual({
        ticks: [1000], casts: 1, batches: 0, sameArgs: false,
      });
    });

    test('a request without a context object reads per parent without asking the adapter', async () => {
      const fixture = createFixture(createRows());
      const source = '{ lcauthors { id books { id } } }';
      const expected = await createFixture(createRows(), { batching: false }).execute(source);
      expect(await graphql({ schema: fixture.schema, source })).toEqual(expected);
      expect(counts(fixture.adapter)).toEqual({ findChildren: 10, findChildrenBatch: 0 });
      expect(fixture.adapter.predicateCalls).toHaveLength(0);
    });

    test('the method is checked on every read, so removing it restores per-parent reads', async () => {
      const warn = vi.spyOn(console, 'warn');
      const fixture = createFixture(createRows());
      const source = '{ lcauthors { id books { id } } }';
      await fixture.execute(source);
      expect(counts(fixture.adapter)).toEqual({ findChildren: 0, findChildrenBatch: 1 });
      fixture.adapter.findChildrenBatch = undefined;
      await fixture.execute(source);
      expect(counts(fixture.adapter)).toEqual({ findChildren: 10, findChildrenBatch: 1 });
      expect(warn).not.toHaveBeenCalled();
    });

    test('a findChildren override disables batching through the pairing check, so the override applies', async () => {
      // Hides the soft-deleted rows, as an application override of the bundled adapters might.
      const rows = createRows();
      rows.LCBook = rows.LCBook.map((book, index) => ({ ...book, deleted: index % 3 === 0 }));
      const override = (adapter) => async function findChildren(...args) {
        const list = await adapter.findChildren.call(adapter, ...args);
        return list.filter((book) => !book.deleted);
      };
      const source = '{ lcauthors { id books { id } } }';
      const expected = await createFixture(rows, {
        batching: false, wrapAdapter: (adapter) => ({ ...adapter, findChildren: override(adapter) }),
      }).execute(source);
      // 7 of the 21 books are hidden.
      expect(expected.data.lcauthors.flatMap((author) => author.books)).toHaveLength(14);

      const assigned = createFixture(rows, { wrapAdapter: (adapter) => Object.assign(adapter, { findChildren: override({ ...adapter }) }) });
      expect(await assigned.execute(source)).toEqual(expected);
      expect(assigned.adapter.calls.findChildrenBatch).toHaveLength(0);
      expect(assigned.adapter.predicateCalls.every(({ self }) => self === assigned.adapter)).toBe(true);

      const copied = createFixture(rows, { wrapAdapter: (adapter) => ({ ...adapter, findChildren: override(adapter) }) });
      expect(await copied.execute(source)).toEqual(expected);
      expect(copied.adapter.calls.findChildrenBatch).toHaveLength(0);
      expect(copied.adapter.predicateCalls).toHaveLength(10);
      expect(copied.adapter.predicateCalls.every(({ self }) => self === copied.bound)).toBe(true);

      // A copy that keeps findChildren still batches, and the batch is called on the copy.
      const plain = createFixture(rows, { wrapAdapter: (adapter) => ({ ...adapter }) });
      await plain.execute(source);
      expect(plain.adapter.calls.findChildrenBatch.map((call) => call.self)).toEqual([plain.bound]);
    });

    test('a predicate that throws keeps per-parent reads and is reported once', async () => {
      const warn = silenceWarnings();
      const fixture = createFixture(createRows(), {
        wrapAdapter: (adapter) => Object.assign(adapter, { batchesChildren() { throw new Error('broken predicate'); } }),
      });
      await fixture.execute('{ lcauthors { id books { id } } }');
      await fixture.execute('{ lcauthors { id books { id } } }');
      expect(counts(fixture.adapter)).toEqual({ findChildren: 20, findChildrenBatch: 0 });
      expect(warn.mock.calls.filter(([message]) => message.includes('batchesChildren'))).toHaveLength(1);
    });
  });

  describe('failed batches', () => {
    test('an error of one parent fails only its field, without a warning', async () => {
      const warn = silenceWarnings();
      const { result, batched } = await expectEquivalent('{ lcauthors { id books { id } } }', { fixture: { failChildrenOf: ['a3'] } });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].path).toEqual(['lcauthors', 3, 'books']);
      expect(result.errors[0].extensions.code).toBe('CHILDREN_UNAVAILABLE');
      // The batch failed as a whole, then each field read alone.
      expect(counts(batched.adapter)).toEqual({ findChildren: 10, findChildrenBatch: 1 });
      expect(batchWarnings(warn)).toHaveLength(0);
    });

    test.each([
      ['rejects with a SimfinityError', 'simfinity', 0],
      ['rejects with another error', 'error', 1],
      ['throws synchronously', 'sync', 1],
    ])('a batch that %s reads each field alone, duplicates included', async (label, failBatch, warnings) => {
      const warn = silenceWarnings();
      const source = '{ lcbooks { id author { id books { id } } } }';
      const { batched } = await expectEquivalent(source, { fixture: { failBatch } });
      expect(counts(batched.adapter)).toEqual({ findChildren: 21, findChildrenBatch: 1 });
      // Each with its own raw parent ID and its own copy of the arguments.
      const parents = batched.adapter.calls.findChildren.map((call) => call.parentId);
      expect(new Set(parents).size).toBe(9);
      expect(new Set(batched.adapter.calls.findChildren.map((call) => call.argsRef)).size).toBe(21);
      expect(batchWarnings(warn)).toHaveLength(warnings);
    });

    test('unexpected failures are reported once per type', async () => {
      const warn = silenceWarnings();
      const fixture = createFixture(createRows(), { failBatch: 'error' });
      await fixture.execute('{ lcauthors { id books { id chapters { id } } } }');
      await fixture.execute('{ lcauthors { id books { id } } }');
      expect(counts(fixture.adapter)).toEqual({ findChildren: 20, findChildrenBatch: 2 });
      expect(counts(fixture.adapter, 'LCChapter')).toEqual({ findChildren: 21, findChildrenBatch: 1 });
      expect(batchWarnings(warn).map(([message]) => message.split(' ')[3])).toEqual(['LCBook', 'LCChapter']);
    });

    test.each([
      ['not an array', 'null'],
      ['one list too few', 'short'],
      // Records that do not show their parent pass the ownership check, so only the length catches it.
      ['one list too few, whose records do not show their parent', (lists, { connectionField }) => withoutParent(lists, connectionField).slice(1)],
      ['one list too many', (lists) => [...lists, []]],
      ['an entry that is not an array', 'entry'],
      ['records of another parent', 'leak'],
      // Array.prototype.every skips holes, so these must be checked index by index.
      ['a hole in place of a list', (lists) => {
        const sparse = [...lists];
        delete sparse[sparse.findIndex((records) => records.length > 0)];
        return sparse;
      }],
      ['a hole in place of a record', (lists) => {
        const sparse = lists.map((records) => [...records]);
        delete sparse[sparse.findIndex((records) => records.length > 0)][0];
        return sparse;
      }],
      ['a preallocated list filled only for some parents', (lists) => {
        const sparse = new Array(lists.length);
        lists.forEach((records, index) => { if (index % 2 === 0) sparse[index] = records; });
        return sparse;
      }],
    ])('a result with %s is reported once and read per field', async (label, shape) => {
      const warn = silenceWarnings();
      const { batched } = await expectEquivalent('{ lcauthors { id books { id } } }', { fixture: { shape } });
      expect(counts(batched.adapter)).toEqual({ findChildren: 10, findChildrenBatch: 1 });
      expect(batchWarnings(warn)).toHaveLength(1);
      expect(batchWarnings(warn)[0][0]).toMatch(/^Configuration issue: adapter\.findChildrenBatch did not return one list of LCBook records/);
    });

    test('records that do not show their parent are accepted', async () => {
      const warn = silenceWarnings();
      const { batched } = await expectEquivalent('{ lcauthors { id books { id title } } }', { fixture: { shape: 'strip' } });
      expect(counts(batched.adapter)).toEqual({ findChildren: 0, findChildrenBatch: 1 });
      expect(warn).not.toHaveBeenCalled();
    });

    test('a failed read of one parent shared by several fields reads each field alone', async () => {
      let failures = 1;
      const fixture = createFixture(createRows(), {
        wrapAdapter: (adapter) => {
          const read = adapter.findChildren;
          adapter.findChildren = async function findChildren(...args) {
            const list = await read.apply(this, args);
            if (failures > 0) {
              failures -= 1;
              throw new SimfinityError('Temporarily unavailable', 'UNAVAILABLE', 503);
            }
            return list;
          };
          // The memory adapter pairs its batch with the findChildren it was created with.
          adapter.batchesChildren = () => true;
          return adapter;
        },
      });
      const result = await fixture.execute('{ a: lcauthor(id: "a2") { books { id } } b: lcauthor(id: "a2") { books { id } } }');
      expect(result.errors).toBeUndefined();
      expect(result.data.a.books).toHaveLength(3);
      expect(result.data.b).toEqual(result.data.a);
      expect(fixture.adapter.calls.findChildren).toHaveLength(3);
    });

    // The arguments are a copy the adapter may change: after a failed read, each field reads alone
    // with the arguments it built, whatever the failed read did to its own copy.
    const sortedPage = 'books(year: { operator: GTE, value: 2001 }, sort: { terms: [{ field: "title", order: DESC }] }, pagination: { page: 1, size: 2 }) { id }';
    const consume = (args) => {
      delete args.sort;
      args.pagination.page = 2;
      args.year.value = 1900;
    };

    test.each(['simfinity', 'error', 'sync'])('a batch that changes its arguments and then fails (%s) leaves each field its own arguments', async (failBatch) => {
      silenceWarnings();
      const { batched, result } = await expectEquivalent(`{ lcauthors { id ${sortedPage} } }`, {
        fixture: { failBatch, changeBatchArgs: consume },
      });
      expect(result.errors).toBeUndefined();
      expect(result.data.lcauthors[3].books.map((book) => book.id)).toEqual(['b3-3', 'b3-2']);
      expect(counts(batched.adapter)).toEqual({ findChildren: 10, findChildrenBatch: 1 });
      const [batch] = batched.adapter.calls.findChildrenBatch;
      expect(batch.argsRef.sort).toBeUndefined();
      batched.adapter.calls.findChildren.forEach((call) => {
        expect(call.args).toEqual(batch.args);
        expect(call.argsRef).not.toBe(batch.argsRef);
      });
    });

    test('a lone parent\'s read that changes its arguments and then fails leaves each field its own arguments', async () => {
      const source = `{ a: lcauthor(id: "a3") { ${sortedPage} } b: lcauthor(id: "a3") { ${sortedPage} } }`;
      const expected = await createFixture(createRows(), { batching: false }).execute(source);
      let failures = 1;
      const fixture = createFixture(createRows(), {
        wrapAdapter: (adapter) => {
          const read = adapter.findChildren;
          adapter.findChildren = async function findChildren(...args) {
            const list = await read.apply(this, args);
            if (failures > 0) {
              failures -= 1;
              consume(args[4]);
              throw new SimfinityError('Temporarily unavailable', 'UNAVAILABLE', 503);
            }
            return list;
          };
          adapter.batchesChildren = () => true;
          return adapter;
        },
      });
      const result = await fixture.execute(source);
      expect(result).toEqual(expected);
      expect(result.data.a.books.map((book) => book.id)).toEqual(['b3-3', 'b3-2']);
      const reads = fixture.adapter.calls.findChildren;
      expect(reads).toHaveLength(3);
      expect(reads[0].argsRef.sort).toBeUndefined();
      expect(reads.slice(1).map((call) => call.args)).toEqual([reads[0].args, reads[0].args]);
      expect(new Set(reads.map((call) => call.argsRef)).size).toBe(3);
    });

    test('invalid pagination fails each field without a batch', async () => {
      const { result, batched } = await expectEquivalent('{ lcauthors(pagination: { page: 1, size: 3 }) { id books(pagination: { page: 0, size: 1 }) { id } } }');
      expect(result.errors.map((error) => error.extensions.code)).toEqual(['INVALID_PAGINATION', 'INVALID_PAGINATION', 'INVALID_PAGINATION']);
      expect(counts(batched.adapter)).toEqual({ findChildren: 3, findChildrenBatch: 0 });
    });

    test('a middleware error fails only its field; the others batch', async () => {
      let calls = 0;
      const middleware = async (params) => {
        if (params.type.gqltype.name !== 'LCBook') return;
        calls += 1;
        if (calls === 3) throw new SimfinityError('Denied', 'DENIED', 403);
      };
      const run = async (batching) => {
        calls = 0;
        const fixture = createFixture(createRows(), { middleware, batching });
        return { fixture, result: await fixture.execute('{ lcauthors { id books { id } } }') };
      };
      const perParent = await run(false);
      const batched = await run(true);
      expect(stable(batched.result)).toEqual(stable(perParent.result));
      expect(batched.result.errors.map((error) => error.path)).toEqual([['lcauthors', 2, 'books']]);
      expect(counts(batched.fixture.adapter)).toEqual({ findChildren: 0, findChildrenBatch: 1 });
      expect(batched.fixture.adapter.calls.findChildrenBatch[0].parentIds).toHaveLength(9);
    });

    test('an internal error settles every waiting field', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('console unavailable'); });
      const fixture = createFixture(createRows(), { shape: 'short' });
      const result = await fixture.execute('{ lcauthors { id books { id } } }');
      expect(result.errors).toHaveLength(10);
      expect(result.errors.every((error) => error.message === 'console unavailable')).toBe(true);
      expect(counts(fixture.adapter)).toEqual({ findChildren: 0, findChildrenBatch: 1 });
    });
  });

  describe('the parent a batched record shows', () => {
    // WWork stores its writer under `writer_id`, the storage name of its GraphQL field `writer`, and
    // its team's IDs under `team`, a list no field names (a multikey connection).
    const writerRows = () => {
      const writers = Array.from({ length: 4 }, (_, index) => ({ _id: `w${index}`, name: `W${index}` }));
      return {
        WWriter: writers,
        WWork: writers.flatMap((writer, index) => [0, 1].map((n) => ({
          _id: `ww${index}-${n}`, title: `WW${index}-${n}`, writer_id: writer._id, team: [writer._id, `w${(index + 1) % 4}`],
        }))),
      };
    };
    const writerFixture = (options) => {
      const adapter = createAdapter(writerRows(), options);
      const runtime = createRuntime(adapter);
      const rel = (connectionField) => ({ relation: { embedded: false, connectionField } });
      const Work = new GraphQLObjectType({
        name: 'WWork',
        fields: () => ({
          id: { type: GraphQLID }, title: { type: GraphQLString }, writer: { type: Writer, extensions: rel('writer_id') },
        }),
      });
      const Writer = new GraphQLObjectType({
        name: 'WWriter',
        fields: () => ({
          id: { type: GraphQLID },
          name: { type: GraphQLString },
          works: { type: new GraphQLList(Work), extensions: rel('writer_id') },
          teamWorks: { type: new GraphQLList(Work), extensions: rel('team') },
        }),
      });
      runtime.connect(null, Work, 'wwork', 'wworks');
      runtime.connect(null, Writer, 'wwriter', 'wwriters');
      const schema = runtime.createSchema();
      return { adapter, execute: (source) => graphql({ schema, source, contextValue: {} }) };
    };
    // An adapter that hydrates the parent under the GraphQL field name, as a populated reference.
    const underGraphQLName = (lists) => lists.map((list) => list.map(
      ({ writer_id: parent, ...record }) => ({ ...record, writer: { _id: parent } }),
    ));

    test.each([
      ['under the connection storage field', null],
      ['only under the GraphQL field name', underGraphQLName],
    ])('a record that shows its parent %s is checked there', async (label, hydrate) => {
      const warn = silenceWarnings();
      const source = '{ wwriters { id works { id title } } }';
      const expected = await writerFixture({ batching: false }).execute(source);
      expect(expected.errors).toBeUndefined();
      expect(expected.data.wwriters[1].works.map((work) => work.id)).toEqual(['ww1-0', 'ww1-1']);

      const right = writerFixture({ shape: hydrate });
      expect(await right.execute(source)).toEqual(expected);
      expect(counts(right.adapter, 'WWork')).toEqual({ findChildren: 0, findChildrenBatch: 1 });
      expect(warn).not.toHaveBeenCalled();

      // Each parent handed the works of the next one: the check rejects the batch and each field reads alone.
      const leaked = writerFixture({ shape: (lists) => rotated(hydrate ? hydrate(lists) : lists) });
      expect(await leaked.execute(source)).toEqual(expected);
      expect(counts(leaked.adapter, 'WWork')).toEqual({ findChildren: 4, findChildrenBatch: 1 });
      expect(batchWarnings(warn)).toHaveLength(1);
    });

    test('a record that stores a list of parents belongs to each parent in the list, and only to them', async () => {
      const warn = silenceWarnings();
      const source = '{ wwriters { id teamWorks { id } } }';
      const expected = await writerFixture({ batching: false }).execute(source);
      expect(expected.errors).toBeUndefined();
      // Writer 0 is on its own team and on writer 3's.
      expect(expected.data.wwriters[0].teamWorks.map((work) => work.id)).toEqual(['ww0-0', 'ww0-1', 'ww3-0', 'ww3-1']);

      const batched = writerFixture({});
      expect(await batched.execute(source)).toEqual(expected);
      expect(counts(batched.adapter, 'WWork')).toEqual({ findChildren: 0, findChildrenBatch: 1 });
      expect(batched.adapter.calls.findChildrenBatch[0].connectionField).toBe('team');
      expect(warn).not.toHaveBeenCalled();

      // Writer 0 handed writer 1's works, among them ww1-*, whose team (w1, w2) does not list it.
      const leaked = writerFixture({ shape: rotated });
      expect(await leaked.execute(source)).toEqual(expected);
      expect(counts(leaked.adapter, 'WWork')).toEqual({ findChildren: 4, findChildrenBatch: 1 });
      expect(batchWarnings(warn)).toHaveLength(1);
    });
  });
});
