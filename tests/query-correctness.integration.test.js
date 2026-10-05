import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { graphql, GraphQLEnumType, GraphQLID, GraphQLInt, GraphQLObjectType, GraphQLScalarType, GraphQLString } from 'graphql';
import * as simfinity from '../packages/mongodb/src/index.js';

const uri = process.env.SIMFINITY_TEST_MONGODB_URI;

describe.skipIf(!uri)('query correctness against MongoDB (opt-in)', () => {
  let connection;
  let schema;
  let books;
  let firstId;
  let states;
  let plainStrings;
  let numbered;

  beforeAll(async () => {
    simfinity.preventCreatingCollection(true);
    connection = await mongoose.createConnection(uri).asPromise();
    const suffix = `${process.pid}_${Date.now()}`;
    const author = new GraphQLObjectType({ name: 'QueryMongoAuthor', fields: {
      id: { type: GraphQLID }, name: { type: GraphQLString }, age: { type: GraphQLInt },
    } });
    const profile = new GraphQLObjectType({ name: 'QueryMongoProfile', fields: {
      name: { type: GraphQLString }, age: { type: GraphQLInt },
    } });
    const book = new GraphQLObjectType({ name: 'QueryMongoBook', fields: {
      id: { type: GraphQLID }, title: { type: GraphQLString },
      author: { type: author, extensions: { relation: { connectionField: 'authorId' } } },
      profile: { type: profile, extensions: { relation: { embedded: true } } },
    } });
    const stringType = new GraphQLObjectType({ name: 'QueryMongoString', fields: {
      id: { type: GraphQLID }, title: { type: GraphQLString },
    }, extensions: { scope: { get_by_id: ({ args }) => { args.title = { value: 'A' }; } } } });
    // Supplied String and Number keys without scopes, read and written by ID through the adapter.
    const plainString = new GraphQLObjectType({ name: 'QueryMongoPlainString', fields: {
      id: { type: GraphQLID }, title: { type: GraphQLString },
    } });
    const numberType = new GraphQLObjectType({ name: 'QueryMongoNumbered', fields: {
      id: { type: GraphQLID }, title: { type: GraphQLString },
    } });
    const status = new GraphQLEnumType({ name: 'QueryMongoStatus', values: { ACTIVE: { value: 7 }, INACTIVE: { value: 9 } } });
    const state = new GraphQLObjectType({ name: 'QueryMongoState', fields: {
      title: { type: GraphQLString }, state: { type: status }, status: { type: status },
      date: { type: new GraphQLScalarType({ name: 'DateTime', serialize: (value) => value }) },
      email: { type: simfinity.scalars.EmailScalar },
    } });
    const authors = connection.model(`query_authors_${suffix}`, new mongoose.Schema({ name: String, age: Number }));
    books = connection.model(`query_books_${suffix}`, new mongoose.Schema({ title: String, authorId: mongoose.Schema.Types.ObjectId, profile: { name: String, age: Number } }));
    const strings = connection.model(`query_strings_${suffix}`, new mongoose.Schema({ _id: String, title: String }));
    plainStrings = connection.model(`query_plain_strings_${suffix}`, new mongoose.Schema({ _id: String, title: String }));
    numbered = connection.model(`query_numbered_${suffix}`, new mongoose.Schema({ _id: Number, title: String }));
    states = connection.model(`query_states_${suffix}`, new mongoose.Schema({ title: String, state: String, status: String, date: Date, email: String }));
    simfinity.addNoEndpointType(profile);
    simfinity.connect(authors, author, 'queryMongoAuthor', 'queryMongoAuthors');
    simfinity.connect(books, book, 'queryMongoBook', 'queryMongoBooks');
    simfinity.connect(strings, stringType, 'queryMongoString', 'queryMongoStrings');
    simfinity.connect(plainStrings, plainString, 'queryMongoPlainString', 'queryMongoPlainStrings');
    simfinity.connect(numbered, numberType, 'queryMongoNumbered', 'queryMongoNumbereds');
    simfinity.connect(states, state, 'queryMongoState', 'queryMongoStates', null, null,
      { initialState: { name: 'ACTIVE', value: 7 }, actions: {} });
    schema = simfinity.createSchema();
    const inserted = await authors.create([{ name: 'Alice', age: 25 }, { name: 'Bob', age: 25 }, { name: 'Alice', age: 40 }]);
    const records = await books.create(inserted.map((doc, i) => ({ title: ['A', 'B', 'C'][i], authorId: doc._id, profile: { name: doc.name, age: doc.age } })));
    firstId = records[0]._id;
    await strings.create([{ _id: 'record-b', title: 'B' }, { _id: 'record-a', title: 'A' }, { _id: 'record-c', title: 'C' }]);
    await plainStrings.create([{ _id: 'record-a', title: 'A' }, { _id: 'record-b', title: 'B' }]);
    await numbered.create([{ _id: 12, title: 'Twelve' }]);
    await simfinity.saveObject('QueryMongoState', { title: 'State A', status: 7, date: new Date('2025-06-01'), email: 'a@example.com' });
  });

  afterAll(async () => {
    simfinity.configureQueryLimits?.({ maxPageSize: 1000 });
    await connection?.close();
  });

  it.each(['author', 'profile'])('preserves %s conjunctions in persisted list/count and aggregation results', async (field) => {
    const filters = `${field}:{terms:[{path:"name",value:"Alice"},{path:"age",operator:GTE,value:18},{path:"age",operator:LTE,value:30}]}`;
    const context = {};
    const result = await graphql({ schema, contextValue: context, source: `{queryMongoBooks(${filters},OR:[{conditions:[{field:"title",value:"A"}]},{conditions:[{field:"title",value:"B"}]}],pagination:{page:1,size:10,count:true}){title}}` });
    expect(result.errors).toBeUndefined();
    expect(result.data.queryMongoBooks).toEqual([{ title: 'A' }]);
    expect(context.count).toBe(1);
    const aggregate = await graphql({ schema, contextValue: {}, source: `{queryMongoBooks_aggregate(${filters},aggregation:{groupId:"title",facts:[{operation:COUNT,factName:"total",path:"id"}]}){groupId facts}}` });
    expect(aggregate.errors).toBeUndefined();
    expect(aggregate.data.queryMongoBooks_aggregate).toEqual([{ groupId: 'A', facts: { total: 1 } }]);
  });

  it('excludes an ObjectId record with NE', async () => {
    const result = await graphql({ schema, contextValue: {}, source: `{queryMongoBooks(id:{operator:NE,value:"${firstId}"},sort:{terms:[{field:"title",order:ASC}]}){title}}` });
    expect(result.errors).toBeUndefined();
    expect(result.data.queryMongoBooks).toEqual([{ title: 'B' }, { title: 'C' }]);
    expect(await books.countDocuments()).toBe(3);
  });

  it('supports string-ID scoped reads, filters and ID sorting using persisted identifiers', async () => {
    const result = await graphql({ schema, contextValue: {}, source: '{single:queryMongoString(id:"record-a"){title} list:queryMongoStrings(id:{operator:NE,value:"record-c"},sort:{terms:[{field:"id",order:ASC}]}){title}}' });
    expect(result.errors).toBeUndefined();
    expect(result.data.single).toEqual({ title: 'A' });
    expect(result.data.list).toEqual([{ title: 'A' }, { title: 'B' }]);
  });

  it('reads, updates and deletes supplied String keys by ID', async () => {
    const read = await graphql({ schema, contextValue: {}, source: '{queryMongoPlainString(id:"record-a"){id title}}' });
    expect(read.errors).toBeUndefined();
    expect(read.data.queryMongoPlainString).toEqual({ id: 'record-a', title: 'A' });
    const updated = await graphql({ schema, contextValue: {}, source: 'mutation{updatequeryMongoPlainString(input:{id:"record-a",title:"A2"}){id title}}' });
    expect(updated.errors).toBeUndefined();
    expect(updated.data.updatequeryMongoPlainString).toEqual({ id: 'record-a', title: 'A2' });
    const deleted = await graphql({ schema, contextValue: {}, source: 'mutation{deletequeryMongoPlainString(id:"record-b"){id}}' });
    expect(deleted.errors).toBeUndefined();
    expect(deleted.data.deletequeryMongoPlainString).toEqual({ id: 'record-b' });
    expect(await plainStrings.find().sort({ _id: 1 }).lean()).toEqual([{ _id: 'record-a', title: 'A2', __v: 0 }]);
  });

  it('casts IDs with a supplied Number key and rejects values it cannot cast', async () => {
    const read = await graphql({ schema, contextValue: {}, source: '{queryMongoNumbered(id:"12"){id title}}' });
    expect(read.errors).toBeUndefined();
    expect(read.data.queryMongoNumbered).toEqual({ id: '12', title: 'Twelve' });
    const invalid = await graphql({ schema, contextValue: {}, source: '{queryMongoNumbered(id:"abc"){id}}' });
    expect(invalid.errors?.[0].extensions).toMatchObject({ code: 'NOT_VALID_ID', status: 400 });
    const update = await graphql({ schema, contextValue: {}, source: 'mutation{updatequeryMongoNumbered(input:{id:"abc",title:"x"}){id}}' });
    expect(update.errors?.[0].extensions).toMatchObject({ code: 'NOT_VALID_ID', status: 400 });
    expect(await numbered.findById(12).lean()).toMatchObject({ title: 'Twelve' });
  });

  it('caps lists while leaving unpaginated aggregates unbounded', async () => {
    expect(simfinity.configureQueryLimits).toBeTypeOf('function');
    simfinity.configureQueryLimits({ maxPageSize: 1 });
    const result = await graphql({ schema, contextValue: {}, source: '{queryMongoBooks{title} queryMongoBooks_aggregate(aggregation:{groupId:"title",facts:[{operation:COUNT,factName:"total",path:"id"}]}){groupId}}' });
    expect(result.errors).toBeUndefined();
    expect(result.data.queryMongoBooks).toHaveLength(1);
    expect(result.data.queryMongoBooks_aggregate).toHaveLength(3);
    const invalid = await graphql({ schema, contextValue: {}, source: '{queryMongoBooks_aggregate(pagination:{page:1,size:2},aggregation:{groupId:"title",facts:[{operation:COUNT,factName:"total",path:"id"}]}){groupId}}' });
    expect(invalid.errors?.[0].extensions.code).toBe('INVALID_PAGINATION');
  });

  it('matches actual stored enum values, generated state names, dates and partial scalar searches', async () => {
    const persisted = await states.findOne({ title: 'State A' }).lean();
    expect(persisted.state).toBe('ACTIVE');
    expect(persisted.status).toBe('7');
    const result = await graphql({ schema, contextValue: {}, source: '{queryMongoStates(state:{value:"ACTIVE"},status:{value:"ACTIVE"},email:{operator:LIKE,value:"@example.com"},date:{operator:BTW,value:["2025-01-01","2025-12-31"]}){title}}' });
    expect(result.errors).toBeUndefined();
    expect(result.data.queryMongoStates).toEqual([{ title: 'State A' }]);
  });
});
