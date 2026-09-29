import {
  afterEach, describe, expect, test, vi,
} from 'vitest';
import mongoose from 'mongoose';
import {
  GraphQLBoolean, GraphQLFloat, GraphQLID, GraphQLInt, GraphQLList, GraphQLNonNull,
  GraphQLObjectType, GraphQLScalarType, GraphQLString,
} from 'graphql';
import { createValidatedScalar, scalars } from '../packages/mongodb/src/index.js';
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
