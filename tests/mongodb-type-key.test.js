import {
  afterAll, beforeAll, beforeEach, describe, expect, test,
} from 'vitest';
import mongoose from 'mongoose';
import {
  graphql, GraphQLBoolean, GraphQLEnumType, GraphQLID, GraphQLInt, GraphQLList, GraphQLObjectType,
  GraphQLScalarType, GraphQLString,
} from 'graphql';
import { createMongoAdapter, createRuntime } from '../packages/mongodb/src/index.js';

const uri = process.env.SIMFINITY_TEST_MONGODB_URI;
const embedded = { relation: { embedded: true } };
const ref = (connectionField) => ({ relation: { connectionField } });

// Mongoose reads a `type` key inside a nested definition as the type of the whole path.
const buildPeople = (prefix, options) => {
  const Kind = new GraphQLEnumType({ name: `${prefix}Kind`, values: { HOME: {}, WORK: {} } });
  const Owner = new GraphQLObjectType({
    name: `${prefix}Owner`,
    fields: { id: { type: GraphQLID }, name: { type: GraphQLString } },
  });
  const Phone = new GraphQLObjectType({
    name: `${prefix}Phone`,
    fields: {
      type: { type: Kind },
      number: { type: GraphQLString },
      owner: { type: Owner, extensions: ref('ownerId') },
    },
  });
  const Tag = new GraphQLObjectType({
    name: `${prefix}Tag`,
    fields: { type: { type: GraphQLID }, label: { type: GraphQLString } },
  });
  const Person = new GraphQLObjectType({
    name: `${prefix}Person`,
    fields: {
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      type: { type: GraphQLString },
      phone: { type: Phone, extensions: embedded },
      phones: { type: new GraphQLList(Phone), extensions: embedded },
      tag: { type: Tag, extensions: embedded },
      tags: { type: new GraphQLList(Tag), extensions: embedded },
    },
  });
  const adapter = createMongoAdapter(options);
  const runtime = createRuntime(adapter);
  runtime.preventCreatingCollection(true);
  runtime.addNoEndpointType(Phone);
  runtime.addNoEndpointType(Tag);
  runtime.connect(null, Owner, `${prefix.toLowerCase()}owner`, `${prefix.toLowerCase()}owners`);
  runtime.connect(null, Person, `${prefix.toLowerCase()}person`, `${prefix.toLowerCase()}people`);
  const schema = runtime.createSchema();
  return {
    adapter, schema, Owner: runtime.getModel(Owner), Person: runtime.getModel(Person),
  };
};

const people = buildPeople('TypeKey');
const pathsOf = (Model, paths) => Object.fromEntries(paths.map((path) => {
  const schemaType = Model.schema.path(path);
  return [path, schemaType?.caster?.instance ? `${schemaType.instance}<${schemaType.caster.instance}>` : schemaType?.instance];
}));
const indexesOf = (Model) => Model.schema.indexes().map(([fields]) => fields);

describe('generated MongoDB models with an embedded field named type', () => {
  test('keep single and list embedded paths with their sibling fields', () => {
    expect(pathsOf(people.Person, [
      'type', 'phone.type', 'phone.number', 'phone.ownerId', 'phones.type', 'phones.number', 'phones.ownerId',
      'tag.type', 'tag.label', 'tags.type', 'tags.label',
    ])).toEqual({
      type: 'String',
      'phone.type': 'String',
      'phone.number': 'String',
      'phone.ownerId': 'ObjectId',
      'phones.type': 'String',
      'phones.number': 'String',
      'phones.ownerId': 'ObjectId',
      'tag.type': 'ObjectId',
      'tag.label': 'String',
      'tags.type': 'ObjectId',
      'tags.label': 'String',
    });
    expect(people.Person.schema.path('phones').instance).toBe('Array');
    expect(people.Person.schema.path('phones').schema).toBeDefined();
  });

  test('index references inside embedded types that have a type field', () => {
    expect(indexesOf(people.Person)).toEqual(expect.arrayContaining([
      { id: 1 }, { 'phone.ownerId': 1 }, { 'phones.ownerId': 1 }, { 'tag.type': 1 }, { 'tags.type': 1 },
    ]));
  });

  test('validate and cast embedded values instead of treating them as strings', () => {
    const ownerId = new mongoose.Types.ObjectId();
    const record = new people.Person({
      name: 'Ann',
      phone: { type: 'HOME', number: '123', ownerId },
      phones: [{ type: 'WORK', number: '456' }],
      tag: { type: ownerId.toString(), label: 'vip' },
    });
    expect(record.validateSync()).toBeUndefined();
    expect(record.toObject()).toMatchObject({
      phone: { type: 'HOME', number: '123', ownerId },
      phones: [{ type: 'WORK', number: '456' }],
      tag: { type: ownerId, label: 'vip' },
    });
  });

  test('escape every leaf shape the generator emits for a nested type key', () => {
    const DateTime = new GraphQLScalarType({ name: 'DateTime' });
    const Level = new GraphQLEnumType({ name: 'TypeKeyShapeLevelValue', values: { LOW: { value: 1 }, HIGH: { value: 2 } } });
    const Target = new GraphQLObjectType({ name: 'TypeKeyShapeTarget', fields: { id: { type: GraphQLID } } });
    const Inner = new GraphQLObjectType({
      name: 'TypeKeyShapeInner',
      fields: { type: { type: GraphQLString }, target: { type: Target, extensions: ref('targetId') } },
    });
    const holder = (name, typeField) => new GraphQLObjectType({
      name: `TypeKeyShape${name}`, fields: { type: typeField, note: { type: GraphQLString } },
    });
    const holders = {
      int: holder('Int', { type: GraphQLInt }),
      unique: holder('Unique', { type: GraphQLString, extensions: { unique: true } }),
      bool: holder('Bool', { type: GraphQLBoolean }),
      date: holder('Date', { type: DateTime }),
      level: holder('Level', { type: Level }),
      levels: holder('Levels', { type: new GraphQLList(Level) }),
      strings: holder('Strings', { type: new GraphQLList(GraphQLString) }),
      ids: holder('Ids', { type: new GraphQLList(GraphQLID) }),
      relation: new GraphQLObjectType({
        name: 'TypeKeyShapeRelation',
        fields: { target: { type: Target, extensions: ref('type') }, note: { type: GraphQLString } },
      }),
      nested: holder('Nested', { type: Inner, extensions: embedded }),
      nestedList: holder('NestedList', { type: new GraphQLList(Inner), extensions: embedded }),
    };
    const Root = new GraphQLObjectType({
      name: 'TypeKeyShapeRoot',
      fields: {
        id: { type: GraphQLID },
        ...Object.fromEntries(Object.entries(holders).map(([name, type]) => [name, { type, extensions: embedded }])),
      },
    });
    const runtime = createRuntime(createMongoAdapter());
    runtime.preventCreatingCollection(true);
    runtime.connect(null, Target, 'typekeyshapetarget', 'typekeyshapetargets');
    for (const type of [Inner, ...Object.values(holders)]) runtime.addNoEndpointType(type);
    runtime.connect(null, Root, 'typekeyshaperoot', 'typekeyshaperoots');
    runtime.createSchema();
    const Model = runtime.getModel(Root);

    expect(pathsOf(Model, [
      'int.type', 'unique.type', 'bool.type', 'date.type', 'level.type', 'levels.type', 'strings.type', 'ids.type',
      'relation.type', 'nested.type', 'nested.type.type', 'nested.type.targetId', 'nestedList.type',
      'nestedList.type.type', 'nestedList.type.targetId',
      'int.note', 'unique.note', 'bool.note', 'date.note', 'level.note', 'levels.note', 'strings.note', 'ids.note',
      'relation.note', 'nested.note', 'nestedList.note',
    ])).toEqual({
      'int.type': 'Number',
      'unique.type': 'String',
      'bool.type': 'Boolean',
      'date.type': 'Date',
      'level.type': 'Number',
      'levels.type': 'Array<Number>',
      'strings.type': 'Array<String>',
      'ids.type': 'Array<ObjectId>',
      'relation.type': 'ObjectId',
      'nested.type': 'Embedded',
      'nested.type.type': 'String',
      'nested.type.targetId': 'ObjectId',
      'nestedList.type': 'Array',
      'nestedList.type.type': 'String',
      'nestedList.type.targetId': 'ObjectId',
      'int.note': 'String',
      'unique.note': 'String',
      'bool.note': 'String',
      'date.note': 'String',
      'level.note': 'String',
      'levels.note': 'String',
      'strings.note': 'String',
      'ids.note': 'String',
      'relation.note': 'String',
      'nested.note': 'String',
      'nestedList.note': 'String',
    });
    expect(Model.schema.path('unique.type').options.unique).toBe(true);
    expect(indexesOf(Model)).toEqual(expect.arrayContaining([
      { 'relation.type': 1 }, { 'nested.type.targetId': 1 }, { 'nestedList.type.targetId': 1 },
    ]));
    const record = new Model({
      nested: { type: { type: 'inner' }, note: 'n' },
      nestedList: { type: [{ type: 'item' }], note: 'l' },
      level: { type: 2, note: 'x' },
    });
    expect(record.validateSync()).toBeUndefined();
    // Like other embedded objects, a nested `type` object has no generated _id.
    expect(record.toObject()).toMatchObject({
      nested: { type: { type: 'inner' }, note: 'n' },
      nestedList: { type: [{ type: 'item' }], note: 'l' },
      level: { type: 2, note: 'x' },
    });
    expect(record.toObject().nested.type._id).toBeUndefined();
  });

  test('let transactional reference integrity find references beside a type field', async () => {
    const unconnected = buildPeople('TypeKeyUnconnected', { referentialIntegrity: 'transactional' });
    // The ObjectId storage paths are checked before the connection is required.
    await expect(unconnected.adapter.initialize())
      .rejects.toThrow('Connect MongoDB before initializing reference integrity');
  });
});

describe.skipIf(!uri)('generated MongoDB models with an embedded field named type against a database', () => {
  const selection = 'id name type phone { type number owner { id name } } phones { type number owner { id } } tag { type label } tags { type label }';
  const execute = async (fixture, source) => graphql({ schema: fixture.schema, source, contextValue: {} });
  const expectData = async (fixture, source) => {
    const result = await execute(fixture, source);
    expect(result.errors).toBeUndefined();
    return result.data;
  };
  let protectedPeople;
  const models = () => [people.Owner, people.Person, protectedPeople.Owner, protectedPeople.Person];

  beforeAll(async () => {
    protectedPeople = buildPeople('TypeKeyProtected', { referentialIntegrity: 'transactional' });
    await mongoose.connect(uri);
    for (const Model of models()) {
      await Model.createCollection();
      await Model.init();
    }
    // Snapshot transactions read at the majority point; let it pass the collection and index builds.
    await people.Owner.collection.insertOne({ name: 'barrier' }, { writeConcern: { w: 'majority' } });
    await protectedPeople.adapter.initialize();
  }, 30000);

  beforeEach(async () => {
    for (const Model of models()) await Model.deleteMany({});
  });

  afterAll(async () => {
    if (mongoose.connection.readyState === 1) {
      for (const Model of models()) await Model.collection.drop().catch(() => {});
      await mongoose.disconnect();
    }
  });

  test('creates, reads and updates embedded values with a type field', async () => {
    const owner = await people.Owner.create({ name: 'Owner' });
    // Generated models store the GraphQL `id` field as a path, so use the document key.
    const ownerId = String(owner._id);
    const tagId = new mongoose.Types.ObjectId().toString();
    const { addtypekeyperson: added } = await expectData(people, `mutation { addtypekeyperson(input: {
      name: "Ann", type: "vip",
      phone: { type: HOME, number: "123", owner: { id: "${ownerId}" } },
      phones: [{ type: WORK, number: "456", owner: { id: "${ownerId}" } }],
      tag: { type: "${tagId}", label: "one" }, tags: [{ type: "${tagId}", label: "two" }]
    }) { ${selection} } }`);
    const expected = {
      name: 'Ann',
      type: 'vip',
      phone: { type: 'HOME', number: '123', owner: { id: ownerId, name: 'Owner' } },
      phones: [{ type: 'WORK', number: '456', owner: { id: ownerId } }],
      tag: { type: tagId, label: 'one' },
      tags: [{ type: tagId, label: 'two' }],
    };
    expect(added).toMatchObject(expected);

    const _id = new mongoose.Types.ObjectId(added.id);
    const stored = await people.Person.collection.findOne({ _id });
    expect(stored.phone).toEqual({ type: 'HOME', number: '123', ownerId: owner._id });
    expect(stored.phones[0]).toMatchObject({ type: 'WORK', number: '456', ownerId: owner._id });
    expect(stored.tag).toEqual({ type: new mongoose.Types.ObjectId(tagId), label: 'one' });

    expect((await expectData(people, `{ typekeyperson(id: "${added.id}") { ${selection} } }`)).typekeyperson).toEqual(added);
    expect((await expectData(people, `{ typekeypeople { ${selection} } }`)).typekeypeople).toEqual([added]);
    expect((await expectData(people, '{ typekeypeople(phone: { terms: [{ path: "type", value: "HOME" }] }) { name } }')).typekeypeople)
      .toEqual([{ name: 'Ann' }]);

    const { updatetypekeyperson: updated } = await expectData(people, `mutation { updatetypekeyperson(input: {
      id: "${added.id}", phone: { type: WORK, number: "789" }, phones: [{ type: HOME, number: "000" }]
    }) { phone { type number } phones { type number } } }`);
    expect(updated.phone).toMatchObject({ type: 'WORK', number: '789' });
    expect(updated.phones).toEqual(expect.arrayContaining([{ type: 'HOME', number: '000' }]));
    const afterUpdate = await people.Person.collection.findOne({ _id });
    expect(afterUpdate.phone).toMatchObject({ type: 'WORK', number: '789' });
    expect(afterUpdate.phones).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'HOME', number: '000' })]));
  });

  test('builds the reference indexes inside embedded types with a type field', async () => {
    await people.Person.init();
    const keys = (await people.Person.collection.indexes()).map(({ key }) => key);
    expect(keys).toEqual(expect.arrayContaining([
      { 'phone.ownerId': 1 }, { 'phones.ownerId': 1 }, { 'tag.type': 1 }, { 'tags.type': 1 },
    ]));
  });

  test('enforces transactional reference integrity inside embedded types with a type field', async () => {
    // A majority write is visible to the snapshot transaction that checks the reference.
    const { insertedId } = await protectedPeople.Owner.collection.insertOne({ name: 'Owner' }, { writeConcern: { w: 'majority' } });
    const ownerId = String(insertedId);
    const add = (id) => execute(protectedPeople, `mutation { addtypekeyprotectedperson(input: {
      name: "Ann", phone: { type: HOME, number: "1", owner: { id: "${id}" } }
    }) { phone { type owner { id } } } }`);
    const valid = await add(ownerId);
    expect(valid.errors).toBeUndefined();
    expect(valid.data.addtypekeyprotectedperson.phone).toEqual({ type: 'HOME', owner: { id: ownerId } });
    const missing = await add(new mongoose.Types.ObjectId().toString());
    expect(missing.errors?.[0].extensions.code).toBe('REFERENCE_CONSTRAINT_VIOLATION');
    expect(await protectedPeople.Person.countDocuments()).toBe(1);
  });
});
