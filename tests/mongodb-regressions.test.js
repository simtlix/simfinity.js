import {
  afterEach, beforeAll, describe, expect, test, vi,
} from 'vitest';
import mongoose from 'mongoose';
import {
  GraphQLID, GraphQLObjectType, GraphQLString, GraphQLList, graphql,
} from 'graphql';
import * as simfinity from '../src/index.js';

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
          'author.name': 'Alice',
          'author._id': authorId,
        },
      },
    ]));
    const repeated = await simfinity.buildQuery({ author: { terms: [
      { path: 'name', operator: 'NE', value: 'Alice' },
      { path: 'name', operator: 'NE', value: 'Bob' },
    ] } }, BookType);
    expect(repeated).toContainEqual({ $match: { $and: [
      { 'author.name': { $ne: 'Alice' } },
      { 'author.name': { $ne: 'Bob' } },
    ] } });
  });
});
