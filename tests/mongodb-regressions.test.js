import {
  afterEach, beforeAll, describe, expect, test, vi,
} from 'vitest';
import mongoose from 'mongoose';
import {
  GraphQLID, GraphQLObjectType, GraphQLString, GraphQLList, graphql,
} from 'graphql';
import * as simfinity from '../packages/mongodb/src/index.js';

const adapterModes = [
  ['default', () => simfinity.createMongoAdapter()],
  ['transactional', () => simfinity.createMongoAdapter({ referentialIntegrity: 'transactional' })],
];

const createIsolatedRuntime = (createAdapter) => {
  const runtime = simfinity.createRuntime(createAdapter());
  runtime.preventCreatingCollection(true);
  return runtime;
};

// Root.mids and Mid.leaves reuse one private connectionField that neither child declares.
const createChainTypes = (prefix) => {
  const types = {};
  types.Leaf = new GraphQLObjectType({
    name: `${prefix}Leaf`,
    fields: () => ({ id: { type: GraphQLID }, label: { type: GraphQLString } }),
  });
  types.Mid = new GraphQLObjectType({
    name: `${prefix}Mid`,
    fields: () => ({
      id: { type: GraphQLID },
      label: { type: GraphQLString },
      leaves: { type: new GraphQLList(types.Leaf), extensions: { relation: { connectionField: 'owner' } } },
    }),
  });
  types.Root = new GraphQLObjectType({
    name: `${prefix}Root`,
    fields: () => ({
      id: { type: GraphQLID },
      label: { type: GraphQLString },
      mids: { type: new GraphQLList(types.Mid), extensions: { relation: { connectionField: 'owner' } } },
    }),
  });
  return types;
};

// A tree whose children collection stores its private link on the same type.
const createTreeType = (prefix) => {
  const Node = new GraphQLObjectType({
    name: `${prefix}Node`,
    fields: () => ({
      id: { type: GraphQLID },
      label: { type: GraphQLString },
      children: { type: new GraphQLList(Node), extensions: { relation: { connectionField: 'parentNode' } } },
    }),
  });
  return Node;
};

const createSession = () => ({
  startTransaction: vi.fn(),
  commitTransaction: vi.fn(),
  abortTransaction: vi.fn(),
  endSession: vi.fn(),
});

describe('MongoDB compatibility regressions', () => {
  beforeAll(() => {
    simfinity.preventCreatingCollection(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('stores a reference under the GraphQL field when connectionField is omitted', async () => {
    const AuthorType = new GraphQLObjectType({
      name: 'MongoFallbackAuthor',
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
      }),
    });
    const BookType = new GraphQLObjectType({
      name: 'MongoFallbackBook',
      fields: () => ({
        id: { type: GraphQLID },
        title: { type: GraphQLString },
        author: {
          type: AuthorType,
          extensions: { relation: { embedded: false } },
        },
      }),
    });

    simfinity.addNoEndpointType(AuthorType);
    simfinity.connect(null, BookType, 'mongofallbackbook', 'mongofallbackbooks');
    const schema = simfinity.createSchema();
    const BookModel = simfinity.getModel(BookType);
    const authorId = new mongoose.Types.ObjectId();
    let storedDocument;

    vi.spyOn(mongoose, 'startSession').mockResolvedValue(createSession());
    vi.spyOn(BookModel.prototype, 'save').mockImplementation(async function save() {
      storedDocument = this.toObject();
      return this;
    });

    const result = await graphql({
      schema,
      source: `
        mutation AddFallbackBook($input: MongoFallbackBookInput!) {
          addmongofallbackbook(input: $input) { id title }
        }
      `,
      variableValues: {
        input: { title: 'Stored reference', author: { id: authorId.toString() } },
      },
    });

    expect(result.errors).toBeUndefined();
    expect(storedDocument.author).toEqual(authorId);
  });

  test('clears a nullable relation using its storage field', async () => {
    const AuthorType = new GraphQLObjectType({
      name: 'MongoClearAuthor',
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
      }),
    });
    const BookType = new GraphQLObjectType({
      name: 'MongoClearBook',
      fields: () => ({
        id: { type: GraphQLID },
        title: { type: GraphQLString },
        author: {
          type: AuthorType,
          extensions: {
            relation: { embedded: false, connectionField: 'author_id' },
          },
        },
      }),
    });

    simfinity.addNoEndpointType(AuthorType);
    simfinity.connect(null, BookType, 'mongoclearbook', 'mongoclearbooks');
    const schema = simfinity.createSchema();
    const BookModel = simfinity.getModel(BookType);
    const bookId = new mongoose.Types.ObjectId();
    let capturedUpdate;

    vi.spyOn(mongoose, 'startSession').mockResolvedValue(createSession());
    vi.spyOn(BookModel, 'findByIdAndUpdate').mockImplementation((_id, update) => {
      capturedUpdate = update;
      return { session: () => Promise.resolve({ _id: bookId, title: 'Detached' }) };
    });

    const result = await graphql({
      schema,
      source: `
        mutation ClearBookAuthor($input: MongoClearBookInputForUpdate!) {
          updatemongoclearbook(input: $input) { id title }
        }
      `,
      variableValues: { input: { id: bookId.toString(), author: null } },
    });

    expect(result.errors).toBeUndefined();
    expect(capturedUpdate.$unset).toEqual({ author_id: '' });
  });

  test('creates a model for a scalar-only no-endpoint type referenced by an endpoint', () => {
    const LabelType = new GraphQLObjectType({
      name: 'MongoReferencedLabel',
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
      }),
    });
    const ItemType = new GraphQLObjectType({
      name: 'MongoLabelledItem',
      fields: () => ({
        id: { type: GraphQLID },
        label: {
          type: LabelType,
          extensions: { relation: { embedded: false } },
        },
      }),
    });

    simfinity.addNoEndpointType(LabelType);
    simfinity.connect(null, ItemType, 'mongolabelleditem', 'mongolabelleditems');
    simfinity.createSchema();

    expect(simfinity.getModel(LabelType)).not.toBeNull();
  });

  test('does not unset a parent scalar when an inverse collection is cleared', async () => {
    const Child = new GraphQLObjectType({ name: 'MongoClearInverseChild', fields: { id: { type: GraphQLID }, parent_id: { type: GraphQLID }, title: { type: GraphQLString } } });
    const Parent = new GraphQLObjectType({ name: 'MongoClearInverseParent', fields: {
      id: { type: GraphQLID }, parent_id: { type: GraphQLString },
      children: { type: new GraphQLList(Child), extensions: { relation: { connectionField: 'parent_id' } } },
    } });
    simfinity.connect(null, Child, 'mongoclearinversechild', 'mongoclearinversechildren');
    simfinity.connect(null, Parent, 'mongoclearinverseparent', 'mongoclearinverseparents');
    const schema = simfinity.createSchema();
    const id = new mongoose.Types.ObjectId();
    let capturedUpdate;
    vi.spyOn(mongoose, 'startSession').mockResolvedValue(createSession());
    vi.spyOn(simfinity.getModel(Parent), 'findByIdAndUpdate').mockImplementation((_id, update) => {
      capturedUpdate = update;
      return { session: async () => ({ _id: id, parent_id: 'Keep me' }) };
    });
    const result = await graphql({ schema, source: 'mutation($input: MongoClearInverseParentInputForUpdate!) { updatemongoclearinverseparent(input:$input) { id } }', variableValues: { input: { id: id.toString(), children: null } } });
    expect(result.errors).toBeUndefined();
    expect(capturedUpdate.$unset).toEqual({ children: '' });
  });

  test('awaits the updated record before invoking onUpdated', async () => {
    const updatedRecord = {
      _id: new mongoose.Types.ObjectId(),
      title: 'Updated title',
    };
    const controller = { onUpdated: vi.fn() };
    const BookType = new GraphQLObjectType({
      name: 'MongoAwaitedUpdate',
      fields: () => ({
        id: { type: GraphQLID },
        title: { type: GraphQLString },
      }),
    });

    simfinity.connect(
      null,
      BookType,
      'mongoawaitedupdate',
      'mongoawaitedupdates',
      controller,
    );
    const schema = simfinity.createSchema();
    const BookModel = simfinity.getModel(BookType);
    const session = createSession();

    vi.spyOn(mongoose, 'startSession').mockResolvedValue(session);
    vi.spyOn(BookModel, 'findByIdAndUpdate').mockReturnValue({
      session: () => Promise.resolve(updatedRecord),
    });

    const result = await graphql({
      schema,
      source: `
        mutation UpdateAwaitedBook($input: MongoAwaitedUpdateInputForUpdate!) {
          updatemongoawaitedupdate(input: $input) { id title }
        }
      `,
      variableValues: {
        input: { id: updatedRecord._id.toString(), title: updatedRecord.title },
      },
    });

    expect(result.errors).toBeUndefined();
    expect(controller.onUpdated).toHaveBeenCalledWith(updatedRecord, session, undefined);
  });

  test.each(adapterModes)('adds a private connection field to each level of chained collections that reuse one name (%s)', (mode, createAdapter) => {
    const runtime = createIsolatedRuntime(createAdapter);
    const types = createChainTypes(`MongoChain${mode}`);
    runtime.connect(null, types.Leaf, `mongochain${mode}leaf`, `mongochain${mode}leaves`);
    runtime.connect(null, types.Mid, `mongochain${mode}mid`, `mongochain${mode}mids`);
    runtime.connect(null, types.Root, `mongochain${mode}root`, `mongochain${mode}roots`);
    runtime.createSchema();

    for (const type of [types.Mid, types.Leaf]) {
      const model = runtime.getModel(type);
      expect(model.schema.path('owner')?.instance).toBe('ObjectId');
      expect(model.schema.indexes()).toContainEqual([{ owner: 1 }, expect.any(Object)]);
    }
    expect(runtime.getModel(types.Root).schema.path('owner')).toBeUndefined();
  });

  test.each(adapterModes)('adds a private connection field to a self-referencing collection (%s)', (mode, createAdapter) => {
    const runtime = createIsolatedRuntime(createAdapter);
    const Node = createTreeType(`MongoTree${mode}`);
    runtime.connect(null, Node, `mongotree${mode}node`, `mongotree${mode}nodes`);
    runtime.createSchema();

    expect(runtime.getModel(Node).schema.path('parentNode')?.instance).toBe('ObjectId');
  });

  test.each(adapterModes)('the %s adapter rejects a collection without connectionField at startup', (mode, createAdapter) => {
    const runtime = createIsolatedRuntime(createAdapter);
    const Thing = new GraphQLObjectType({
      name: `MongoMissingConnection${mode}Thing`,
      fields: () => ({ id: { type: GraphQLID }, label: { type: GraphQLString } }),
    });
    const Owner = new GraphQLObjectType({
      name: `MongoMissingConnection${mode}Owner`,
      fields: () => ({
        id: { type: GraphQLID },
        things: { type: new GraphQLList(Thing), extensions: { relation: { embedded: false } } },
      }),
    });
    runtime.connect(null, Thing, `mongomissing${mode}thing`, `mongomissing${mode}things`);
    runtime.connect(null, Owner, `mongomissing${mode}owner`, `mongomissing${mode}owners`);

    let error;
    try {
      runtime.createSchema();
    } catch (failure) {
      error = failure;
    }
    expect(error).toMatchObject({
      message: `${Owner.name}.things requires a child connectionField`,
      extensions: { code: 'INVALID_MODEL', status: 400 },
    });
  });

  test('preserves multiple flat terms on the same relation', async () => {
    const AuthorType = new GraphQLObjectType({
      name: 'MongoTermsAuthor',
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
      }),
    });
    const BookType = new GraphQLObjectType({
      name: 'MongoTermsBook',
      fields: () => ({
        id: { type: GraphQLID },
        author: {
          type: AuthorType,
          extensions: { relation: { embedded: false, connectionField: 'author_id' } },
        },
      }),
    });
    const authorId = new mongoose.Types.ObjectId();

    simfinity.connect(null, AuthorType, 'mongotermsauthor', 'mongotermsauthors');
    simfinity.connect(null, BookType, 'mongotermsbook', 'mongotermsbooks');
    simfinity.createSchema();

    const pipeline = await simfinity.buildQuery({
      author: {
        terms: [
          { path: 'name', operator: 'EQ', value: 'Alice' },
          { path: 'id', operator: 'EQ', value: authorId.toString() },
        ],
      },
    }, BookType);

    expect(pipeline).toEqual(expect.arrayContaining([
      {
        $match: {
          '__sf_l0.name': 'Alice',
          '__sf_l0._id': authorId,
        },
      },
    ]));
    const repeated = await simfinity.buildQuery({ author: { terms: [
      { path: 'name', operator: 'NE', value: 'Alice' },
      { path: 'name', operator: 'NE', value: 'Bob' },
    ] } }, BookType);
    expect(repeated).toContainEqual({ $match: { $and: [
      { '__sf_l0.name': { $ne: 'Alice' } },
      { '__sf_l0.name': { $ne: 'Bob' } },
    ] } });
  });
});
