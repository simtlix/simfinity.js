// Generated inputs that would have no fields (#161): GraphQL input objects need at least one field,
// so such inputs are left out with the collection operations, fields and mutations that take them,
// and a non-null embedded field that generated create inputs cannot set rejects the schema.
import {
  afterEach, describe, expect, test, vi,
} from 'vitest';
import {
  GraphQLEnumType, GraphQLID, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString,
  GraphQLUnionType, graphql, printSchema, validateSchema,
} from 'graphql';
import mongoose from 'mongoose';
import { createRuntime } from '../packages/core/src/index.js';
import { createMongoAdapter } from '../packages/mongodb/src/mongo/adapter.js';
import { createPostgres } from '../packages/postgres/src/index.js';
import { generateMCPTools } from '../packages/mcp/src/index.js';

const cloneRecord = (record) => (record == null ? null : JSON.parse(JSON.stringify(record)));

// Stores records per model, and finds the children of a collection by their back-reference.
const createMemoryAdapter = () => {
  const records = new Map();
  let nextId = 1;
  const key = (Model, id) => `${Model.name}:${id}`;
  const ofModel = (Model) => [...records.entries()]
    .filter(([entry]) => entry.startsWith(`${Model.name}:`)).map(([, record]) => cloneRecord(record));
  return {
    prepare: vi.fn(),
    createModel: vi.fn((gqltype) => ({ name: gqltype.name })),
    castId: String,
    withTransaction: async (session, body) => body(session || {}),
    newRecord: (Model, data) => ({ ...cloneRecord(data), _id: String(nextId++) }),
    async saveRecord(Model, record) {
      records.set(key(Model, record._id), cloneRecord(record));
      return record;
    },
    toObject: cloneRecord,
    async getById(Model, id) { return cloneRecord(records.get(key(Model, id))); },
    prepareUpdate: (set, unset) => ({ set, unset }),
    async update(Model, id, update) {
      const current = records.get(key(Model, id));
      if (!current) return null;
      for (const field of Object.keys(update.unset)) delete current[field];
      Object.assign(current, cloneRecord(update.set));
      return cloneRecord(current);
    },
    async delete(Model, id) {
      const record = records.get(key(Model, id));
      records.delete(key(Model, id));
      return cloneRecord(record);
    },
    find: async (Model) => ofModel(Model),
    count: async (Model) => ofModel(Model).length,
    aggregate: async () => [],
    findChildren: async (Model, gqltype, field, parentId) => ofModel(Model)
      .filter((record) => String(record[field]) === String(parentId)),
    getRecords: (typeName) => ofModel({ name: typeName }),
  };
};

let schemaSeq = 0;
const backends = {
  core: () => createRuntime(createMemoryAdapter()),
  mongodb: () => {
    const runtime = createRuntime(createMongoAdapter());
    runtime.preventCreatingCollection(true);
    return runtime;
  },
  postgres: () => createPostgres({
    pool: { connect: vi.fn(), query: vi.fn() },
    schema: `empty_inputs_${schemaSeq++}`,
  }),
};

const ref = (connectionField) => ({
  relation: { embedded: false, ...(connectionField ? { connectionField } : {}) },
});
const embedded = { relation: { embedded: true } };
const readOnly = { readOnly: true };
const createdTypes = [];
afterEach(() => {
  for (const T of createdTypes.splice(0)) if (mongoose.models[T.name]) mongoose.deleteModel(T.name);
  vi.restoreAllMocks();
});
const fieldNames = (schema, typeName) => Object.keys(schema.getType(typeName).getFields());
const mutationNames = (schema) => Object.keys(schema.getMutationType().getFields());
const warnings = () => console.warn.mock.calls.map(([message]) => message);
const invalidModel = (message) => expect.objectContaining({
  message, extensions: expect.objectContaining({ code: 'INVALID_MODEL', status: 400 }),
});
const requiredEmbeddedMessage = (owner, field, embeddedType) => `${owner}.${field} is non-null but its embedded `
  + `type ${embeddedType} has no writable fields, so generated create inputs cannot set it; mark it readOnly `
  + 'and set it in a controller, or make it nullable';

const TicketState = new GraphQLEnumType({
  name: 'EiTicketState',
  values: { OPEN: { value: 'OPEN' }, CLOSED: { value: 'CLOSED' } },
});
const ticketStateMachine = {
  initialState: TicketState.getValue('OPEN'),
  actions: { close: { from: TicketState.getValue('OPEN'), to: TicketState.getValue('CLOSED') } },
};

describe.each(Object.keys(backends))('generated inputs without fields on %s', (backend) => {
  const p = { core: 'Ei', mongodb: 'Eim', postgres: 'Eip' }[backend];
  const lower = p.toLowerCase();
  const connect = (runtime, T, stateMachine) => runtime.connect(null, T, T.name.toLowerCase(),
    `${T.name.toLowerCase()}s`, null, null, stateMachine);
  const register = (types, { noEndpoint = [], runtime = backends[backend]() } = {}) => {
    createdTypes.push(...types, ...noEndpoint);
    for (const T of noEndpoint) runtime.addNoEndpointType(T);
    for (const T of types) connect(runtime, T);
    return runtime;
  };
  const build = (types, { noEndpoint = [], included } = {}) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = register(types, { noEndpoint });
    return { runtime, schema: runtime.createSchema(undefined, included) };
  };
  const authorAndBook = (bookFields, { requiredBooks = false } = {}) => {
    const books = () => (requiredBooks ? new GraphQLNonNull(new GraphQLList(Book)) : new GraphQLList(Book));
    const Author = new GraphQLObjectType({
      name: `${p}Author`,
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        books: { type: books(), extensions: ref('author') },
      }),
    });
    const Book = new GraphQLObjectType({
      name: `${p}Book`,
      fields: () => ({
        id: { type: GraphQLID },
        author: { type: Author, extensions: ref() },
        ...bookFields(),
      }),
    });
    return [Author, Book];
  };
  const readOnlyStamp = () => new GraphQLObjectType({
    name: `${p}Stamp`,
    fields: () => ({ at: { type: GraphQLString, extensions: readOnly } }),
  });

  test('leaves `added` out of the collection inputs of a child whose only writable field is the back-reference', () => {
    const { schema } = build(authorAndBook(() => ({
      computed: { type: GraphQLString, extensions: readOnly },
    })));
    expect(validateSchema(schema)).toEqual([]);
    expect(fieldNames(schema, `OneToMany${p}AuthorAbooks`)).toEqual(['updated', 'deleted']);
    expect(fieldNames(schema, `OneToMany${p}AuthorUbooks`)).toEqual(['updated', 'deleted']);
    expect(schema.getType(`${p}AuthorA${p}BookInputForAuthor`)).toBeUndefined();
    expect(schema.getType(`${p}AuthorU${p}BookInputForAuthor`)).toBeUndefined();
    // The collection field stays, and the child keeps its own mutations.
    expect(String(schema.getType(`${p}AuthorInput`).getFields().books.type)).toBe(`OneToMany${p}AuthorAbooks`);
    expect(mutationNames(schema)).toEqual(expect.arrayContaining([
      `add${lower}book`, `update${lower}book`, `delete${lower}book`,
    ]));
    expect(warnings().filter((message) => message.includes(`${p}Author.books has no \`added\``))).toEqual([
      `Configuration issue: ${p}Author.books has no \`added\` operation in generated inputs, because ${p}Book has `
        + `no writable fields besides its connectionField author; create ${p}Book records with its own mutations `
        + 'or a registered mutation.',
    ]);
  });

  test('also leaves `updated` out for a child without a writable id whose fields are all readOnly', () => {
    const Author = new GraphQLObjectType({
      name: `${p}UpdAuthor`,
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        books: { type: new GraphQLList(Book), extensions: ref('author') },
      }),
    });
    const Book = new GraphQLObjectType({
      name: `${p}UpdBook`,
      fields: () => ({
        author: { type: Author, extensions: { ...ref(), readOnly: true } },
        label: { type: GraphQLString, extensions: readOnly },
      }),
    });
    const { schema } = build([Author, Book]);
    expect(validateSchema(schema)).toEqual([]);
    expect(fieldNames(schema, `OneToMany${p}UpdAuthorAbooks`)).toEqual(['deleted']);
    expect(fieldNames(schema, `OneToMany${p}UpdAuthorUbooks`)).toEqual(['deleted']);
    expect(schema.getType(`${p}UpdBookInputForUpdate`)).toBeUndefined();
    expect(mutationNames(schema)).toEqual(expect.arrayContaining([`delete${lower}updbook`, `update${lower}updauthor`]));
    expect(warnings().filter((message) => message.includes(`${p}UpdAuthor.books has no`))).toEqual([
      `Configuration issue: ${p}UpdAuthor.books has no \`added\` operation in generated inputs, because ${p}UpdBook `
        + `has no writable fields besides its connectionField author; create ${p}UpdBook records with its own `
        + 'mutations or a registered mutation.',
      `Configuration issue: ${p}UpdAuthor.books has no \`updated\` operation in generated inputs, because ${p}UpdBook `
        + `has no writable fields and no writable id; update ${p}UpdBook records with a registered mutation.`,
    ]);
  });

  test('keeps a required collection without `added` required on create', () => {
    const { schema } = build(authorAndBook(() => ({}), { requiredBooks: true }));
    expect(validateSchema(schema)).toEqual([]);
    expect(String(schema.getType(`${p}AuthorInput`).getFields().books.type)).toBe(`OneToMany${p}AuthorAbooks!`);
    expect(String(schema.getType(`${p}AuthorInputForUpdate`).getFields().books.type)).toBe(`OneToMany${p}AuthorUbooks`);
    expect(fieldNames(schema, `OneToMany${p}AuthorAbooks`)).toEqual(['updated', 'deleted']);
  });

  test('also when the child has only interface or union fields besides the back-reference', () => {
    const Other = new GraphQLObjectType({ name: `${p}Other`, fields: { x: { type: GraphQLString } } });
    const Either = new GraphQLUnionType({ name: `${p}Either`, types: [Other] });
    const types = authorAndBook(() => ({ either: { type: Either } }));
    if (backend === 'postgres') {
      // PostgreSQL cannot store interface or union fields, so it rejects the model first.
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const runtime = register(types);
      expect(() => runtime.createSchema()).toThrow(invalidModel(`Unsupported field type at ${p}Book.either`));
      return;
    }
    const { schema } = build(types);
    expect(validateSchema(schema)).toEqual([]);
    expect(fieldNames(schema, `OneToMany${p}AuthorAbooks`)).toEqual(['updated', 'deleted']);
  });

  test('also when the child\'s other fields have embedded types without writable fields', () => {
    const Stamp = readOnlyStamp();
    const { schema } = build(authorAndBook(() => ({
      stamp: { type: Stamp, extensions: embedded },
      stamps: { type: new GraphQLList(Stamp), extensions: embedded },
    })), { noEndpoint: [Stamp] });
    expect(validateSchema(schema)).toEqual([]);
    expect(fieldNames(schema, `${p}BookInput`)).toEqual(['author']);
    expect(fieldNames(schema, `${p}BookInputForUpdate`)).toEqual(['id', 'author']);
    expect(fieldNames(schema, `OneToMany${p}AuthorAbooks`)).toEqual(['updated', 'deleted']);
    expect(schema.getType(`${p}StampInput`)).toBeUndefined();
    expect(warnings()).toEqual(expect.arrayContaining([
      `Configuration issue: ${p}Book.stamp is left out of generated create and update inputs, because its `
        + `embedded type ${p}Stamp has no writable fields, so generated mutations cannot set it; set it in a `
        + 'controller or a registered mutation, and mark it readOnly to state that it is output-only.',
      expect.stringContaining(`${p}Book.stamps is left out of generated create and update inputs`),
    ]));
  });

  test('leaves an embedded field whose type has only an id out of create inputs and keeps it in update inputs', () => {
    const Ref = new GraphQLObjectType({ name: `${p}IdRef`, fields: () => ({ id: { type: GraphQLID } }) });
    const Doc = new GraphQLObjectType({
      name: `${p}IdDoc`,
      fields: () => ({
        id: { type: GraphQLID },
        title: { type: GraphQLString },
        r: { type: Ref, extensions: embedded },
      }),
    });
    const { schema } = build([Doc], { noEndpoint: [Ref] });
    expect(validateSchema(schema)).toEqual([]);
    expect(fieldNames(schema, `${p}IdDocInput`)).toEqual(['title']);
    expect(fieldNames(schema, `${p}IdDocInputForUpdate`)).toEqual(['id', 'title', 'r']);
    expect(String(schema.getType(`${p}IdDocInputForUpdate`).getFields().r.type)).toBe(`${p}IdRefInputForUpdate`);
    expect(schema.getType(`${p}IdRefInput`)).toBeUndefined();
    // Generated updates can set it, so the warning gives no readOnly advice.
    expect(warnings().filter((message) => message.includes(`${p}IdDoc.r `))).toEqual([
      `Configuration issue: ${p}IdDoc.r is left out of generated create inputs, because the create input of its `
        + `embedded type ${p}IdRef would have no fields (create inputs leave out ids), so generated creates cannot set `
        + 'it, while generated updates still can; to set it on create, use a controller or a registered mutation.',
    ]);
  });

  test.each([
    ['single', (Stamp) => new GraphQLNonNull(Stamp), 'stamp'],
    ['list', (Stamp) => new GraphQLNonNull(new GraphQLList(Stamp)), 'stamps'],
  ])('rejects a non-null embedded %s field whose type has no writable fields', (form, typeOf, field) => {
    const Stamp = readOnlyStamp();
    const Doc = new GraphQLObjectType({
      name: `${p}StampDoc`,
      fields: () => ({
        id: { type: GraphQLID },
        title: { type: GraphQLString },
        [field]: { type: typeOf(Stamp), extensions: embedded },
      }),
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = register([Doc], { noEndpoint: [Stamp] });
    expect(() => runtime.createSchema()).toThrow(invalidModel(requiredEmbeddedMessage(`${p}StampDoc`, field, `${p}Stamp`)));
    // Rejected the same way when created again.
    expect(() => runtime.createSchema()).toThrow(invalidModel(requiredEmbeddedMessage(`${p}StampDoc`, field, `${p}Stamp`)));
  });

  test('rejects a non-null embedded field that the collection items of a reachable type reach', () => {
    const Stamp = readOnlyStamp();
    const [Author, Book] = authorAndBook(() => ({
      title: { type: GraphQLString },
      stamp: { type: new GraphQLNonNull(Stamp), extensions: embedded },
    }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = register([Author, Book], { noEndpoint: [Stamp] });
    // Only the author's mutations are generated; their `added` books would need the stamp.
    expect(() => runtime.createSchema(undefined, [Author]))
      .toThrow(invalidModel(requiredEmbeddedMessage(`${p}Book`, 'stamp', `${p}Stamp`)));
  });

  test('leaves out a non-null embedded field without writable fields where generated mutations do not reach it', () => {
    const Stamp = readOnlyStamp();
    const Doc = new GraphQLObjectType({
      name: `${p}HiddenDoc`,
      fields: () => ({
        id: { type: GraphQLID },
        title: { type: GraphQLString },
        stamp: { type: new GraphQLNonNull(Stamp), extensions: embedded },
        stamps: { type: new GraphQLNonNull(new GraphQLList(Stamp)), extensions: embedded },
      }),
    });
    const Other = new GraphQLObjectType({
      name: `${p}Visible`,
      fields: () => ({ id: { type: GraphQLID }, label: { type: GraphQLString } }),
    });
    // Schemas whose generated mutations do not reach Doc's inputs start today, and keep starting.
    const { schema } = build([Doc, Other], { noEndpoint: [Stamp], included: [Other] });
    expect(validateSchema(schema)).toEqual([]);
    expect(mutationNames(schema)).toEqual([`add${lower}visible`, `delete${lower}visible`, `update${lower}visible`]);
    expect(warnings()).toEqual(expect.arrayContaining([
      expect.stringContaining(`${p}HiddenDoc.stamp is left out of generated create and update inputs`),
      expect.stringContaining(`${p}HiddenDoc.stamps is left out of generated create and update inputs`),
    ]));
  });

  test('gives a type without writable fields no add mutation and keeps its update and delete mutations', () => {
    const Tag = new GraphQLObjectType({
      name: `${p}Tag`,
      fields: () => ({
        id: { type: GraphQLID },
        label: { type: GraphQLString, extensions: readOnly },
      }),
    });
    const { schema } = build([Tag]);
    expect(validateSchema(schema)).toEqual([]);
    expect(mutationNames(schema)).toEqual([`delete${lower}tag`, `update${lower}tag`]);
    expect(schema.getType(`${p}TagInput`)).toBeUndefined();
    expect(warnings()).toEqual([
      `Configuration issue: ${p}Tag has no writable fields, so the schema has no add${lower}tag mutation; create `
        + 'its records with a registered mutation that takes no input or an input of its own, since '
        + `getInputType(${p}Tag) has no fields.`,
    ]);
  });

  test('gives an endpoint without a writable id and without writable fields only a delete mutation', () => {
    const Log = new GraphQLObjectType({
      name: `${p}NoIdLog`,
      fields: () => ({ label: { type: GraphQLString, extensions: readOnly } }),
    });
    const { schema } = build([Log]);
    expect(validateSchema(schema)).toEqual([]);
    expect(mutationNames(schema)).toEqual([`delete${lower}noidlog`]);
    expect(schema.getType(`${p}NoIdLogInput`)).toBeUndefined();
    expect(schema.getType(`${p}NoIdLogInputForUpdate`)).toBeUndefined();
    expect(warnings()).toEqual([
      expect.stringContaining(`${p}NoIdLog has no writable fields, so the schema has no add${lower}noidlog mutation`),
      `Configuration issue: ${p}NoIdLog has no writable fields and no writable id, so its generated update input `
        + `would have no fields and the schema has no update${lower}noidlog mutation.`,
    ]);
  });

  test('gives a state machine type whose only writable field is its state no add mutation', () => {
    const Ticket = new GraphQLObjectType({
      name: `${p}SmTicket`,
      fields: () => ({ id: { type: GraphQLID }, state: { type: TicketState } }),
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = backends[backend]();
    createdTypes.push(Ticket);
    connect(runtime, Ticket, ticketStateMachine);
    const schema = runtime.createSchema();
    expect(validateSchema(schema)).toEqual([]);
    expect(mutationNames(schema)).toEqual([`delete${lower}smticket`, `update${lower}smticket`, `close_${lower}smticket`]);
    expect(warnings()).toEqual([
      `Configuration issue: ${p}SmTicket has no writable fields besides its state, which its state machine `
        + `manages, so the schema has no add${lower}smticket mutation; create its records with a registered `
        + 'mutation, which must set the initial state (saveObject() sets it).',
    ]);
  });

  test('gives a state machine type without a writable id whose only writable field is its state only a delete mutation', () => {
    const Ticket = new GraphQLObjectType({ name: `${p}SmNoId`, fields: () => ({ state: { type: TicketState } }) });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = backends[backend]();
    createdTypes.push(Ticket);
    connect(runtime, Ticket, ticketStateMachine);
    const schema = runtime.createSchema();
    expect(validateSchema(schema)).toEqual([]);
    expect(mutationNames(schema)).toEqual([`delete${lower}smnoid`]);
    expect(warnings()).toEqual([
      `Configuration issue: ${p}SmNoId has no writable fields besides its state, which its state machine `
        + `manages, so the schema has no add${lower}smnoid mutation; create its records with a registered `
        + 'mutation, which must set the initial state (saveObject() sets it).',
      `Configuration issue: ${p}SmNoId has no writable fields besides its state, which its state machine `
        + 'manages, and no writable id, so its generated update input would have no fields and the schema has no '
        + `update${lower}smnoid mutation and no state machine actions.`,
    ]);
  });

  test('keeps every operation of children with a writable field', () => {
    const { schema } = build(authorAndBook(() => ({ title: { type: new GraphQLNonNull(GraphQLString) } })));
    expect(validateSchema(schema)).toEqual([]);
    expect(fieldNames(schema, `OneToMany${p}AuthorAbooks`)).toEqual(['added', 'updated', 'deleted']);
    expect(fieldNames(schema, `${p}AuthorA${p}BookInputForAuthor`)).toEqual(['title']);
    expect(warnings()).toEqual([]);
  });
});

describe('generated inputs without fields with transactional MongoDB integrity', () => {
  test('leaves `added` out of the collection inputs of a child whose only writable field is the back-reference', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = createRuntime(createMongoAdapter({ referentialIntegrity: 'transactional' }));
    runtime.preventCreatingCollection(true);
    const Author = new GraphQLObjectType({
      name: 'EitAuthor',
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        books: { type: new GraphQLList(Book), extensions: ref('author') },
      }),
    });
    const Book = new GraphQLObjectType({
      name: 'EitBook',
      fields: () => ({ id: { type: GraphQLID }, author: { type: Author, extensions: ref() } }),
    });
    createdTypes.push(Author, Book);
    runtime.connect(null, Author, 'eitauthor', 'eitauthors');
    runtime.connect(null, Book, 'eitbook', 'eitbooks');
    const schema = runtime.createSchema();
    expect(validateSchema(schema)).toEqual([]);
    expect(fieldNames(schema, 'OneToManyEitAuthorAbooks')).toEqual(['updated', 'deleted']);
    expect(fieldNames(schema, 'OneToManyEitAuthorUbooks')).toEqual(['updated', 'deleted']);
    expect(mutationNames(schema)).toEqual(expect.arrayContaining(['addeitbook', 'updateeitbook', 'deleteeitbook']));
  });
});

describe('generated inputs without fields at run time', () => {
  const library = (prefix, { requiredBooks = false } = {}) => {
    const books = () => (requiredBooks ? new GraphQLNonNull(new GraphQLList(Book)) : new GraphQLList(Book));
    const Author = new GraphQLObjectType({
      name: `${prefix}Author`,
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        books: { type: books(), extensions: ref('author') },
      }),
    });
    const Book = new GraphQLObjectType({
      name: `${prefix}Book`,
      fields: () => ({ id: { type: GraphQLID }, author: { type: Author, extensions: ref() } }),
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = createMemoryAdapter();
    const runtime = createRuntime(adapter);
    const lower = prefix.toLowerCase();
    runtime.connect(null, Author, `${lower}author`, `${lower}authors`);
    runtime.connect(null, Book, `${lower}book`, `${lower}books`);
    const schema = runtime.createSchema();
    const run = async (source) => {
      const result = await graphql({ schema, source, contextValue: {} });
      expect(result.errors).toBeUndefined();
      return result.data;
    };
    return { adapter, schema, run };
  };

  test('creates children with their own mutation, and updates and deletes them through the parent', async () => {
    const { adapter, schema, run } = library('Eir');
    const { addeirauthor: author } = await run('mutation { addeirauthor(input: { name: "A" }) { id } }');
    const { addeirbook: book } = await run(`mutation { addeirbook(input: { author: { id: "${author.id}" } }) { id } }`);
    const books = `{ eirauthor(id: "${author.id}") { books { id author { id } } } }`;
    expect((await run(books)).eirauthor.books).toEqual([{ id: book.id, author: { id: author.id } }]);

    const rejected = await graphql({
      schema,
      source: `mutation { updateeirauthor(input: { id: "${author.id}", books: { added: [{}] } }) { id } }`,
    });
    expect(rejected.errors[0].message).toContain('Field "added" is not defined by type "OneToManyEirAuthorUbooks"');

    // `updated` moves nothing here, but runs through the collection: the child stays linked.
    await run(`mutation { updateeirauthor(input: { id: "${author.id}", name: "B",
      books: { updated: [{ id: "${book.id}" }] } }) { id name } }`);
    expect((await run(books)).eirauthor.books).toEqual([{ id: book.id, author: { id: author.id } }]);

    await run(`mutation { updateeirauthor(input: { id: "${author.id}", books: { deleted: ["${book.id}"] } }) { id } }`);
    expect((await run(books)).eirauthor.books).toEqual([]);
    expect(adapter.getRecords('EirBook')).toEqual([]);
  });

  test('accepts `books: {}` for a required collection without `added`', async () => {
    const { schema, run } = library('Eirq', { requiredBooks: true });
    const missing = await graphql({ schema, source: 'mutation { addeirqauthor(input: { name: "A" }) { id } }' });
    expect(missing.errors[0].message).toContain('Field "EirqAuthorInput.books" of required type "OneToManyEirqAuthorAbooks!" was not provided.');
    const { addeirqauthor: author } = await run('mutation { addeirqauthor(input: { name: "A", books: {} }) { id name } }');
    expect(author.name).toBe('A');
  });

  test('MCP tools describe collection inputs without `added`', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = createRuntime(createMemoryAdapter());
    const Author = new GraphQLObjectType({
      name: 'EimcpAuthor',
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        books: { type: new GraphQLList(Book), extensions: ref('author') },
      }),
    });
    const Book = new GraphQLObjectType({
      name: 'EimcpBook',
      fields: () => ({ id: { type: GraphQLID }, author: { type: Author, extensions: ref() } }),
    });
    runtime.connect(null, Author, 'eimcpauthor', 'eimcpauthors');
    runtime.connect(null, Book, 'eimcpbook', 'eimcpbooks');
    const schema = runtime.createSchema();
    expect(printSchema(schema)).not.toContain('added');
    const { tools } = generateMCPTools(schema);
    const update = tools.find((tool) => tool.name === 'updateeimcpauthor');
    expect(Object.keys(update.inputSchema.$defs.OneToManyEimcpAuthorUbooks.properties)).toEqual(['updated', 'deleted']);
    // Without `added` the update cannot insert children, so repeating it changes nothing more.
    expect(update.annotations.idempotentHint).toBe(true);
  });

  test('rejects a schema that reaches inputs built for an earlier schema without a non-null embedded field', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = createRuntime(createMemoryAdapter());
    const Stamp = new GraphQLObjectType({
      name: 'EilStamp',
      fields: () => ({ at: { type: GraphQLString, extensions: readOnly } }),
    });
    const Doc = new GraphQLObjectType({
      name: 'EilDoc',
      fields: () => ({
        id: { type: GraphQLID },
        title: { type: GraphQLString },
        stamp: { type: new GraphQLNonNull(Stamp), extensions: embedded },
      }),
    });
    const Other = new GraphQLObjectType({
      name: 'EilOther',
      fields: () => ({ id: { type: GraphQLID }, label: { type: GraphQLString } }),
    });
    runtime.addNoEndpointType(Stamp);
    runtime.connect(null, Doc, 'eildoc', 'eildocs');
    runtime.connect(null, Other, 'eilother', 'eilothers');
    expect(validateSchema(runtime.createSchema(undefined, [Other]))).toEqual([]);
    expect(() => runtime.createSchema()).toThrow(invalidModel(requiredEmbeddedMessage('EilDoc', 'stamp', 'EilStamp')));
  });
});
