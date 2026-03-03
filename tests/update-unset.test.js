import {
  describe, test, expect, beforeAll, vi,
} from 'vitest';
import mongoose from 'mongoose';
import {
  GraphQLObjectType, GraphQLString, GraphQLID, GraphQLNonNull, graphql,
} from 'graphql';
import * as simfinity from '../src/index.js';

describe('Update mutation $unset merging', () => {
  let schema;
  let model;

  const UnsetTestType = new GraphQLObjectType({
    name: 'UnsetTest',
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: new GraphQLNonNull(GraphQLString) },
      nickname: { type: GraphQLString },
      bio: { type: GraphQLString },
      website: { type: GraphQLString },
    }),
  });

  beforeAll(() => {
    simfinity.preventCreatingCollection(true);

    simfinity.connect(
      null,
      UnsetTestType,
      'unsettest',
      'unsettests',
    );

    schema = simfinity.createSchema();
    model = mongoose.model('UnsetTest');
  });

  test('should merge $unset for multiple null fields instead of overwriting', async () => {
    const fakeSession = {
      startTransaction: vi.fn(),
      commitTransaction: vi.fn(),
      abortTransaction: vi.fn(),
      endSession: vi.fn(),
    };
    vi.spyOn(mongoose, 'startSession').mockResolvedValue(fakeSession);

    const fakeCurrentObject = {
      _id: '507f1f77bcf86cd799439011',
      name: 'Alice',
      nickname: 'ally',
      bio: 'A developer',
      website: 'https://example.com',
    };

    vi.spyOn(model, 'findById').mockReturnValue({
      lean: () => Promise.resolve(fakeCurrentObject),
    });

    let capturedUpdate = null;
    vi.spyOn(model, 'findByIdAndUpdate').mockImplementation((_id, update) => {
      capturedUpdate = update;
      return { session: () => Promise.resolve(fakeCurrentObject) };
    });

    const mutation = `
      mutation {
        updateunsettest(input: {
          id: "507f1f77bcf86cd799439011"
          nickname: null
          bio: null
          website: null
        }) {
          id
          name
        }
      }
    `;

    await graphql({ schema, source: mutation });

    expect(capturedUpdate).toBeDefined();
    expect(capturedUpdate.$unset).toBeDefined();
    expect(capturedUpdate.$unset).toEqual({
      nickname: '',
      bio: '',
      website: '',
    });
  });

  test('should handle single null field correctly', async () => {
    const fakeSession = {
      startTransaction: vi.fn(),
      commitTransaction: vi.fn(),
      abortTransaction: vi.fn(),
      endSession: vi.fn(),
    };
    vi.spyOn(mongoose, 'startSession').mockResolvedValue(fakeSession);

    const fakeCurrentObject = {
      _id: '507f1f77bcf86cd799439012',
      name: 'Bob',
      nickname: 'bobby',
      bio: 'Engineer',
      website: 'https://bob.dev',
    };

    vi.spyOn(model, 'findById').mockReturnValue({
      lean: () => Promise.resolve(fakeCurrentObject),
    });

    let capturedUpdate = null;
    vi.spyOn(model, 'findByIdAndUpdate').mockImplementation((_id, update) => {
      capturedUpdate = update;
      return { session: () => Promise.resolve(fakeCurrentObject) };
    });

    const mutation = `
      mutation {
        updateunsettest(input: {
          id: "507f1f77bcf86cd799439012"
          bio: null
        }) {
          id
          name
        }
      }
    `;

    await graphql({ schema, source: mutation });

    expect(capturedUpdate).toBeDefined();
    expect(capturedUpdate.$unset).toEqual({ bio: '' });
  });

  test('should not include NonNull fields in $unset', async () => {
    const fakeSession = {
      startTransaction: vi.fn(),
      commitTransaction: vi.fn(),
      abortTransaction: vi.fn(),
      endSession: vi.fn(),
    };
    vi.spyOn(mongoose, 'startSession').mockResolvedValue(fakeSession);

    const fakeCurrentObject = {
      _id: '507f1f77bcf86cd799439013',
      name: 'Charlie',
      nickname: 'chuck',
    };

    vi.spyOn(model, 'findById').mockReturnValue({
      lean: () => Promise.resolve(fakeCurrentObject),
    });

    let capturedUpdate = null;
    vi.spyOn(model, 'findByIdAndUpdate').mockImplementation((_id, update) => {
      capturedUpdate = update;
      return { session: () => Promise.resolve(fakeCurrentObject) };
    });

    const mutation = `
      mutation {
        updateunsettest(input: {
          id: "507f1f77bcf86cd799439013"
          nickname: null
        }) {
          id
          name
        }
      }
    `;

    await graphql({ schema, source: mutation });

    expect(capturedUpdate).toBeDefined();
    expect(capturedUpdate.$unset).toEqual({ nickname: '' });
    expect(capturedUpdate.$unset).not.toHaveProperty('name');
  });
});
