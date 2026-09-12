import {
  afterEach, beforeAll, describe, expect, test, vi,
} from 'vitest';
import mongoose from 'mongoose';
import {
  GraphQLID, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';
import * as simfinity from '../src/index.js';

describe('Mutation input materialization', () => {
  let schema;
  let model;
  const callerSession = { inTransaction: () => true };
  const observedValues = [];
  const validator = {
    async validate(_type, _field, value) {
      await Promise.resolve();
      observedValues.push(value);
      if (value === 'invalid') throw new Error('Rejected asynchronously');
    },
  };
  const Owner = new GraphQLObjectType({
    name: 'MaterializationOwner',
    fields: { id: { type: GraphQLID }, name: { type: GraphQLString } },
  });
  const Subject = new GraphQLObjectType({
    name: 'MaterializationSubject',
    fields: {
      id: { type: GraphQLID },
      text: {
        type: GraphQLString,
        extensions: { validations: { CREATE: [validator], UPDATE: [validator] } },
      },
      other: { type: GraphQLString },
      owner: { type: Owner, extensions: { relation: { embedded: false } } },
      editor: { type: Owner, extensions: { relation: { embedded: false, connectionField: 'editorId' } } },
      reviewer: { type: Owner, extensions: { relation: { embedded: false, connectionField: 'reviewerId' } } },
    },
  });

  beforeAll(() => {
    simfinity.preventCreatingCollection(true);
    simfinity.connect(null, Owner, 'materializationowner', 'materializationowners');
    simfinity.connect(null, Subject, 'materializationsubject', 'materializationsubjects');
    schema = simfinity.createSchema();
    model = simfinity.getModel(Subject);
  });

  afterEach(() => {
    observedValues.length = 0;
    vi.restoreAllMocks();
  });

  test('preserves an empty string and default relation storage on create', async () => {
    vi.spyOn(model.prototype, 'save').mockImplementation(async function save() { return this; });
    const ownerId = new mongoose.Types.ObjectId().toString();
    const saved = await simfinity.saveObject(Subject.name, { text: '', owner: { id: ownerId } }, callerSession);
    expect(saved.text).toBe('');
    expect(saved.owner?.toString()).toBe(ownerId);
    expect(saved).not.toHaveProperty('undefined');
    expect(observedValues).toEqual(['']);
  });

  test('awaits async validation and prevents saving rejected input', async () => {
    const save = vi.spyOn(model.prototype, 'save');
    await expect(simfinity.saveObject(Subject.name, { text: 'invalid' }, callerSession)).rejects.toThrow('Rejected asynchronously');
    expect(save).not.toHaveBeenCalled();
  });

  test('stores a reference under the GraphQL field name when connectionField is omitted', async () => {
    vi.spyOn(model.prototype, 'save').mockImplementation(async function save() { return this; });
    const ownerId = new mongoose.Types.ObjectId().toString();
    const saved = await simfinity.saveObject(Subject.name, { owner: { id: ownerId } }, callerSession);
    expect(saved.owner?.toString()).toBe(ownerId);
  });

  test.each([
    ['empty', { text: '' }, { text: '' }, ['']],
    ['absent', {}, {}, [undefined]],
    ['null', { text: null, editor: null, reviewer: null, owner: null }, {
      $unset: { text: '', editorId: '', reviewerId: '', owner: '' },
    }, [null]],
  ])('keeps %s distinct during GraphQL updates', async (_case, input, expected, values) => {
    const session = {
      startTransaction: vi.fn(), commitTransaction: vi.fn(), abortTransaction: vi.fn(), endSession: vi.fn(),
    };
    vi.spyOn(mongoose, 'startSession').mockResolvedValue(session);
    let captured;
    vi.spyOn(model, 'findByIdAndUpdate').mockImplementation((_id, update) => {
      captured = update;
      return { session: () => Promise.resolve({ text: update.text ?? 'existing' }) };
    });
    const id = new mongoose.Types.ObjectId().toString();
    const result = await graphql({
      schema,
      source: 'mutation($input: MaterializationSubjectInputForUpdate!) { updatematerializationsubject(input: $input) { text } }',
      variableValues: { input: { id, ...input } },
    });
    expect(result.errors).toBeUndefined();
    expect(result.data.updatematerializationsubject.text).toBe(input.text === '' ? '' : 'existing');
    expect(captured).toEqual({ id, ...expected });
    expect(observedValues).toEqual(values);
  });
});
