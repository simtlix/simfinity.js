import {
  afterEach, describe, expect, test, vi,
} from 'vitest';
import mongoose from 'mongoose';
import {
  GraphQLBoolean, GraphQLFloat, GraphQLID, GraphQLInt, GraphQLList, GraphQLNonNull,
  GraphQLObjectType, GraphQLScalarType, GraphQLString,
} from 'graphql';
import {
  createMongoAdapter, createRuntime, createValidatedScalar, scalars,
} from '../packages/mongodb/src/index.js';
import { createMongoModel, resolveStorageScalar } from '../packages/mongodb/src/mongo/models.js';

const accept = () => {};
const DateTime = new GraphQLScalarType({ name: 'DateTime' });
const CorporateEmail = createValidatedScalar('ModelCorporateEmail', 'Corporate email', scalars.EmailScalar, accept);
const EvenPositive = createValidatedScalar('ModelEvenPositive', 'Even positive', scalars.PositiveIntScalar, accept);
const Ratio = createValidatedScalar('ModelRatio', 'Ratio', createValidatedScalar('ModelUnit', 'Unit', GraphQLFloat, accept), accept);
const Flag = createValidatedScalar('ModelFlag', 'Flag', createValidatedScalar('ModelToggle', 'Toggle', GraphQLBoolean, accept), accept);
const Reference = createValidatedScalar('ModelReference', 'Reference', createValidatedScalar('ModelKey', 'Key', GraphQLID, accept), accept);
const FutureDate = createValidatedScalar('ModelFuture', 'Future date', DateTime, accept);
const ChainedDate = createValidatedScalar('ModelChainedDate', 'Chained date', FutureDate, accept);

const createdModels = [];
const modelOf = (type, options = { createCollection: false }) => {
  const model = createMongoModel(type, null, options);
  createdModels.push(type.name);
  return model;
};

afterEach(() => {
  vi.restoreAllMocks();
  while (createdModels.length) mongoose.deleteModel(createdModels.pop());
});

describe('resolveStorageScalar', () => {
  test('walks validated scalar chains to their built-in storage scalar', () => {
    expect(resolveStorageScalar(GraphQLString)).toBe(GraphQLString);
    expect(resolveStorageScalar(scalars.EmailScalar)).toBe(GraphQLString);
    expect(resolveStorageScalar(CorporateEmail)).toBe(GraphQLString);
    expect(resolveStorageScalar(EvenPositive)).toBe(GraphQLInt);
    expect(resolveStorageScalar(ChainedDate)).toBe(DateTime);
  });

  test('stops on cyclic chains without throwing', () => {
    const first = new GraphQLScalarType({ name: 'ModelCycleA' });
    const second = new GraphQLScalarType({ name: 'ModelCycleB' });
    first.baseScalarType = second;
    second.baseScalarType = first;

    expect([first, second]).toContain(resolveStorageScalar(first));
  });
});

describe('createMongoModel', () => {
  test('stores fields typed with chained validated scalars', () => {
    const PersonType = new GraphQLObjectType({
      name: 'ModelChainedPerson',
      fields: {
        id: { type: GraphQLID },
        email: { type: scalars.EmailScalar },
        workEmail: { type: CorporateEmail },
        requiredWork: { type: new GraphQLNonNull(CorporateEmail) },
        uniqueWork: { type: CorporateEmail, extensions: { unique: true } },
        workEmails: { type: new GraphQLList(CorporateEmail) },
        requiredEmails: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(CorporateEmail))) },
        score: { type: EvenPositive },
        scores: { type: new GraphQLList(EvenPositive) },
        ratio: { type: Ratio },
        flag: { type: new GraphQLNonNull(Flag) },
        flags: { type: new GraphQLList(Flag) },
        reference: { type: Reference },
        references: { type: new GraphQLList(Reference) },
        due: { type: ChainedDate },
        requiredDue: { type: new GraphQLNonNull(ChainedDate) },
        dues: { type: new GraphQLList(new GraphQLNonNull(ChainedDate)) },
      },
    });
    const Model = modelOf(PersonType);
    const instanceOf = (path) => Model.schema.path(path)?.instance;
    const itemInstanceOf = (path) => Model.schema.path(path)?.caster?.instance;

    expect({
      email: instanceOf('email'),
      workEmail: instanceOf('workEmail'),
      requiredWork: instanceOf('requiredWork'),
      uniqueWork: instanceOf('uniqueWork'),
      score: instanceOf('score'),
      ratio: instanceOf('ratio'),
      flag: instanceOf('flag'),
      reference: instanceOf('reference'),
      due: instanceOf('due'),
      requiredDue: instanceOf('requiredDue'),
      workEmails: itemInstanceOf('workEmails'),
      requiredEmails: itemInstanceOf('requiredEmails'),
      scores: itemInstanceOf('scores'),
      flags: itemInstanceOf('flags'),
      references: itemInstanceOf('references'),
      dues: itemInstanceOf('dues'),
    }).toEqual({
      email: 'String',
      workEmail: 'String',
      requiredWork: 'String',
      uniqueWork: 'String',
      score: 'Number',
      ratio: 'Number',
      flag: 'Boolean',
      reference: 'ObjectId',
      due: 'Date',
      requiredDue: 'Date',
      workEmails: 'String',
      requiredEmails: 'String',
      scores: 'Number',
      flags: 'Boolean',
      references: 'ObjectId',
      dues: 'Date',
    });
    expect(Model.schema.path('uniqueWork').options.unique).toBe(true);

    const stored = new Model({
      workEmail: 'a@acme.test',
      workEmails: ['b@acme.test'],
      score: 4,
      due: '2030-01-01T00:00:00.000Z',
    }).toObject();
    expect(stored).toMatchObject({
      workEmail: 'a@acme.test',
      workEmails: ['b@acme.test'],
      score: 4,
      due: new Date('2030-01-01T00:00:00.000Z'),
    });
  });

  test('keeps skipping cyclic and unrecognized scalars without failing', () => {
    const first = new GraphQLScalarType({ name: 'ModelOpaqueCycleA' });
    const second = new GraphQLScalarType({ name: 'ModelOpaqueCycleB' });
    first.baseScalarType = second;
    second.baseScalarType = first;
    const OpaqueType = new GraphQLObjectType({
      name: 'ModelOpaqueHolder',
      fields: {
        id: { type: GraphQLID },
        cyclic: { type: first },
        opaque: { type: new GraphQLScalarType({ name: 'ModelOpaqueJSON' }) },
      },
    });

    const Model = modelOf(OpaqueType);
    expect(Model.schema.path('cyclic')).toBeUndefined();
    expect(Model.schema.path('opaque')).toBeUndefined();
  });

  describe('explicit collection creation', () => {
    const createType = (name) => new GraphQLObjectType({
      name,
      fields: { id: { type: GraphQLID }, name: { type: GraphQLString } },
    });

    const settle = () => new Promise((resolve) => { setImmediate(resolve); });

    const createWithFailure = async (name, failure) => {
      const unhandled = [];
      const onUnhandled = (reason) => { unhandled.push(reason); };
      process.on('unhandledRejection', onUnhandled);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(mongoose.connection, 'createCollection').mockRejectedValue(failure);
      try {
        const Model = modelOf(createType(name), {});
        await settle();
        await settle();
        return { Model, warn, unhandled };
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    };

    test('reports a rejected collection creation instead of leaving it unhandled', async () => {
      const failure = new mongoose.mongo.MongoServerError({ message: 'not authorized', errmsg: 'not authorized', code: 13 });
      const { Model, warn, unhandled } = await createWithFailure('ModelUnauthorizedCreate', failure);

      expect(unhandled).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain(Model.collection.collectionName);
      expect(warn.mock.calls[0][0]).toContain('not authorized');
    });

    test('stays silent when the collection already exists', async () => {
      const failure = new mongoose.mongo.MongoServerError({ message: 'exists', errmsg: 'exists', code: 48 });
      const { warn, unhandled } = await createWithFailure('ModelExistingCreate', failure);

      expect(unhandled).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});

describe('fields named like Object.prototype members', () => {
  const members = ['constructor', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', 'toString', 'valueOf'];
  const depths = ['at the root', 'in an embedded object', 'in embedded list items'];
  const embeddedReason = 'embedded fields cannot be named like Object.prototype members';
  const constructorReason = 'Mongoose drops a stored path named constructor';
  let built = 0;

  // A Doc type with the given fields at the root, or in a Holder it embeds as an object or a list.
  const build = (depth, createFields) => {
    built += 1;
    const prefix = `ModelProto${built}_`;
    createdModels.push(new RegExp(`^${prefix}`));
    const Maker = new GraphQLObjectType({ name: `${prefix}Maker`, fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
    const Inner = new GraphQLObjectType({ name: `${prefix}Inner`, fields: { label: { type: GraphQLString } } });
    const shaped = { label: { type: GraphQLString }, ...createFields({ Maker, Inner }) };
    const Holder = new GraphQLObjectType({ name: `${prefix}Holder`, fields: shaped });
    const holder = {
      type: depth === 'in an embedded object' ? Holder : new GraphQLList(Holder),
      extensions: { relation: { embedded: true } },
    };
    const Doc = new GraphQLObjectType({
      name: `${prefix}Doc`,
      fields: { id: { type: GraphQLID }, name: { type: GraphQLString }, ...(depth === 'at the root' ? shaped : { holder }) },
    });
    const runtime = createRuntime(createMongoAdapter());
    runtime.preventCreatingCollection(true);
    runtime.connect(null, Maker, `${prefix}maker`, `${prefix}makers`);
    runtime.addNoEndpointType(Inner);
    if (depth !== 'at the root') runtime.addNoEndpointType(Holder);
    runtime.connect(null, Doc, `${prefix}doc`, `${prefix}docs`);
    return { runtime, Doc, owner: depth === 'at the root' ? Doc.name : Holder.name };
  };

  const embeddedField = (name, list) => ({ Inner }) => ({
    [name]: { type: list ? new GraphQLList(Inner) : Inner, extensions: { relation: { embedded: true } } },
  });
  const rejected = depths.flatMap((depth) => [
    ...members.flatMap((name) => [
      [`an embedded object named ${name}`, depth, name, embeddedField(name, false), embeddedReason],
      [`an embedded list named ${name}`, depth, name, embeddedField(name, true), embeddedReason],
    ]),
    ['a scalar named constructor', depth, 'constructor', () => ({ constructor: { type: GraphQLString } }), constructorReason],
    ['a scalar list named constructor', depth, 'constructor',
      () => ({ constructor: { type: new GraphQLList(GraphQLString) } }), constructorReason],
    ['a reference named constructor', depth, 'constructor',
      ({ Maker }) => ({ constructor: { type: Maker, extensions: { relation: { embedded: false } } } }), constructorReason],
    ['a reference stored as constructor', depth, 'maker',
      ({ Maker }) => ({ maker: { type: Maker, extensions: { relation: { embedded: false, connectionField: 'constructor' } } } }),
      constructorReason],
  ]);

  test.each(rejected)('rejects %s %s before building its Mongoose model', (label, depth, field, createFields, reason) => {
    const { runtime, Doc, owner } = build(depth, createFields);

    expect(() => runtime.createSchema()).toThrow(expect.objectContaining({
      message: `${owner}.${field} cannot be stored on MongoDB: ${reason}`,
      extensions: expect.objectContaining({ code: 'INVALID_MODEL', status: 400 }),
    }));
    expect(mongoose.modelNames()).not.toContain(Doc.name);
  });

  test('rejects a collection whose child stores its link under a private constructor path', () => {
    const prefix = 'ModelProtoCollection_';
    createdModels.push(new RegExp(`^${prefix}`));
    const Thing = new GraphQLObjectType({ name: `${prefix}Thing`, fields: { id: { type: GraphQLID }, label: { type: GraphQLString } } });
    const Owner = new GraphQLObjectType({
      name: `${prefix}Owner`,
      fields: {
        id: { type: GraphQLID },
        things: { type: new GraphQLList(Thing), extensions: { relation: { embedded: false, connectionField: 'constructor' } } },
      },
    });
    const runtime = createRuntime(createMongoAdapter());
    runtime.preventCreatingCollection(true);
    runtime.connect(null, Thing, `${prefix}thing`, `${prefix}things`);
    runtime.connect(null, Owner, `${prefix}owner`, `${prefix}owners`);

    expect(() => runtime.createSchema()).toThrow(expect.objectContaining({
      message: `${Thing.name}.constructor cannot be stored on MongoDB: ${constructorReason}`,
      extensions: expect.objectContaining({ code: 'INVALID_MODEL', status: 400 }),
    }));
    expect(mongoose.modelNames()).not.toContain(Thing.name);
  });

  // The other members, as scalars, scalar lists or references, next to a reference named
  // constructor that its connectionField stores as makerId.
  const others = members.filter((name) => name !== 'constructor');
  const stored = [
    ['scalars', () => ({ type: GraphQLString }), 'String'],
    ['scalar lists', () => ({ type: new GraphQLList(GraphQLString) }), 'Array'],
    ['references', ({ Maker }) => ({ type: Maker, extensions: { relation: { embedded: false } } }), 'ObjectId'],
  ];
  test.each(depths.flatMap((depth) => stored.map((shape) => [...shape, depth])))('stores %s so named %s', (label, createField, instance, depth) => {
    const { runtime, Doc } = build(depth, (types) => ({
      ...Object.fromEntries(others.map((name) => [name, createField(types)])),
      constructor: { type: types.Maker, extensions: { relation: { embedded: false, connectionField: 'makerId' } } },
    }));

    runtime.createSchema();
    const { schema } = runtime.getModel(Doc);
    const pathOf = (name) => {
      if (depth === 'at the root') return schema.path(name);
      if (depth === 'in an embedded object') return schema.path(`holder.${name}`);
      return schema.path('holder').schema.path(name);
    };
    expect(Object.fromEntries([...others, 'makerId'].map((name) => [name, pathOf(name)?.instance]))).toEqual({
      ...Object.fromEntries(others.map((name) => [name, instance])),
      makerId: 'ObjectId',
    });
  });
});

describe('embedded cycles', () => {
  const embedded = (type, { list = false, readOnly = false } = {}) => ({
    type: list ? new GraphQLList(type) : type,
    extensions: { relation: { embedded: true }, ...(readOnly ? { readOnly: true } : {}) },
  });
  // A.b embeds B and B.a embeds A, as objects or lists; `readOnly` marks B.a.
  const createPair = (prefix, options = {}) => {
    createdModels.push(new RegExp(`^${prefix}`));
    const A = new GraphQLObjectType({
      name: `${prefix}A`,
      fields: () => ({ id: { type: GraphQLID }, b: embedded(B, { list: options.list }) }),
    });
    const B = new GraphQLObjectType({
      name: `${prefix}B`,
      fields: () => ({ label: { type: GraphQLString }, a: embedded(A, options) }),
    });
    return { A, B };
  };
  const invalidModel = (message) => expect.objectContaining({
    message, extensions: expect.objectContaining({ code: 'INVALID_MODEL', status: 400 }),
  });
  // Which type the reported path starts at depends on which model is generated first.
  const embeddedCycle = invalidModel(expect.stringMatching(/^Embedded cycle at /));

  const registrations = {
    'the entity first': (runtime, { A, B }) => {
      runtime.connect(null, A, `${A.name}a`, `${A.name}as`);
      runtime.addNoEndpointType(B);
    },
    'embedded types first': (runtime, { A, B }) => {
      runtime.addNoEndpointType(B);
      runtime.connect(null, A, `${A.name}a`, `${A.name}as`);
    },
    'a supplied model': (runtime, { A, B }) => {
      runtime.addNoEndpointType(B);
      runtime.connect(mongoose.model(A.name, new mongoose.Schema({ b: { label: String } })), A, `${A.name}a`, `${A.name}as`);
    },
    'an unregistered embedded type': (runtime, { A }) => {
      runtime.connect(null, A, `${A.name}a`, `${A.name}as`);
    },
  };
  const cases = Object.keys(registrations).flatMap((registration) => [
    [registration, 'objects', 'off', { list: false }],
    [registration, 'lists', 'off', { list: true }],
    [registration, 'objects with a readOnly link', 'off', { list: false, readOnly: true }],
    [registration, 'lists with a readOnly link', 'off', { list: true, readOnly: true }],
  ]).concat([
    ['embedded types first', 'objects', 'transactional', { list: false }],
    ['embedded types first', 'lists', 'transactional', { list: true }],
  ]);

  let built = 0;
  test.each(cases)('rejects, with %s, embedded %s that contain each other (%s integrity)', (registration, label, referentialIntegrity, options) => {
    built += 1;
    const prefix = `ModelCycle${built}_`;
    const types = createPair(prefix, options);
    const runtime = createRuntime(createMongoAdapter({ referentialIntegrity }));
    runtime.preventCreatingCollection(true);
    registrations[registration](runtime, types);

    expect(() => runtime.createSchema()).toThrow(embeddedCycle);
    // No model is generated for either type.
    expect(mongoose.modelNames().filter((name) => name.startsWith(prefix)))
      .toEqual(registration === 'a supplied model' ? [types.A.name] : []);
  });

  test('rejects a cycle that does not pass through the root type', () => {
    const prefix = 'ModelCycleBelow_';
    createdModels.push(new RegExp(`^${prefix}`));
    const C = new GraphQLObjectType({ name: `${prefix}C`, fields: () => ({ x: { type: GraphQLString }, b: embedded(B) }) });
    const B = new GraphQLObjectType({ name: `${prefix}B`, fields: () => ({ y: { type: GraphQLString }, c: embedded(C) }) });
    const Root = new GraphQLObjectType({ name: `${prefix}Root`, fields: () => ({ id: { type: GraphQLID }, b: embedded(B) }) });
    const runtime = createRuntime(createMongoAdapter());
    runtime.preventCreatingCollection(true);
    runtime.connect(null, Root, `${prefix}root`, `${prefix}roots`);
    runtime.addNoEndpointType(B);
    runtime.addNoEndpointType(C);

    expect(() => runtime.createSchema()).toThrow(embeddedCycle);
    expect(() => createMongoModel(Root, null, { createCollection: false }))
      .toThrow(invalidModel(`Embedded cycle at ${Root.name}.b.c.b`));
  });

  test('createMongoModel rejects an indirect embedded cycle with the path from its type', () => {
    const { A, B } = createPair('ModelCycleDirectCall_', { list: true });

    expect(() => createMongoModel(A, null, { createCollection: false })).toThrow(invalidModel(`Embedded cycle at ${A.name}.b.a`));
    expect(() => createMongoModel(B, null, { createCollection: false })).toThrow(invalidModel(`Embedded cycle at ${B.name}.a.b`));
  });

  test.each([['an object', false], ['a list', true]])('keeps the message for a type that embeds itself as %s, now with INVALID_MODEL', (label, list) => {
    const prefix = `ModelSelfEmbed${list ? 'List' : 'Object'}_`;
    createdModels.push(new RegExp(`^${prefix}`));
    const Self = new GraphQLObjectType({ name: `${prefix}Self`, fields: () => ({ id: { type: GraphQLID }, self: embedded(Self, { list }) }) });

    expect(() => createMongoModel(Self, null, { createCollection: false }))
      .toThrow(invalidModel('A type cannot have a field of its same type and embedded'));
  });

  test('builds a type that embeds the same type in sibling and nested fields', () => {
    const prefix = 'ModelEmbeddedDag_';
    createdModels.push(new RegExp(`^${prefix}`));
    const Geo = new GraphQLObjectType({ name: `${prefix}Geo`, fields: { lat: { type: GraphQLFloat } } });
    const Address = new GraphQLObjectType({ name: `${prefix}Address`, fields: { street: { type: GraphQLString }, geo: embedded(Geo) } });
    const Root = new GraphQLObjectType({
      name: `${prefix}Root`,
      fields: {
        id: { type: GraphQLID }, home: embedded(Address), work: embedded(Address, { list: true }), geo: embedded(Geo),
      },
    });

    const model = createMongoModel(Root, null, { createCollection: false });

    expect(model.schema.path('home.geo.lat').instance).toBe('Number');
    expect(model.schema.path('geo.lat').instance).toBe('Number');
    expect(model.schema.path('work').schema.path('geo.lat').instance).toBe('Number');
  });
});
