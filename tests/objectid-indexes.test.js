import {
  describe, test, expect, beforeEach, afterEach, vi,
} from 'vitest';
import mongoose from 'mongoose';
import { GraphQLObjectType, GraphQLString, GraphQLID, GraphQLList } from 'graphql';
import * as simfinity from '../src/index.js';

describe('ObjectId Index Creation', () => {
  let indexSpy;

  beforeEach(() => {
    // Spy on the index method of mongoose Schema
    indexSpy = vi.spyOn(mongoose.Schema.prototype, 'index').mockImplementation(() => {});
    // Prevent collection creation to avoid database connection issues
    simfinity.preventCreatingCollection(true);
  });

  afterEach(() => {
    // Restore the original implementation
    indexSpy.mockRestore();
  });

  test('should create index for direct ObjectId field', () => {
    const TestType = new GraphQLObjectType({
      name: 'TestTypeWithObjectId',
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        userId: { type: GraphQLID },
      }),
    });

    simfinity.connect(null, TestType, 'testTypeWithObjectId', 'testTypesWithObjectId');
    simfinity.createSchema();

    // Should create indexes for both id and userId fields
    expect(indexSpy).toHaveBeenCalledWith({ id: 1 });
    expect(indexSpy).toHaveBeenCalledWith({ userId: 1 });
    expect(indexSpy).toHaveBeenCalledTimes(2);
  });

  test('should create index for embedded ObjectId field', () => {
    const EmbeddedType = new GraphQLObjectType({
      name: 'EmbeddedType',
      fields: () => ({
        embeddedId: { type: GraphQLID },
        embeddedName: { type: GraphQLString },
      }),
    });

    const TestType = new GraphQLObjectType({
      name: 'TestTypeWithEmbedded',
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        embedded: { 
          type: EmbeddedType,
          extensions: {
            relation: { embedded: true },
          },
        },
      }),
    });

    // Register the embedded type first
    simfinity.addNoEndpointType(EmbeddedType);
    simfinity.connect(null, TestType, 'testTypeWithEmbedded', 'testTypesWithEmbedded');
    simfinity.createSchema();

    // Should create indexes for id and embedded.embeddedId fields
    expect(indexSpy).toHaveBeenCalledWith({ id: 1 });
    expect(indexSpy).toHaveBeenCalledWith({ 'embedded.embeddedId': 1 });
    expect(indexSpy).toHaveBeenCalledTimes(2);
  });

  test('should create index for nested embedded ObjectId field', () => {
    const DeepEmbeddedType = new GraphQLObjectType({
      name: 'DeepEmbeddedType',
      fields: () => ({
        deepId: { type: GraphQLID },
        deepName: { type: GraphQLString },
      }),
    });

    const EmbeddedType = new GraphQLObjectType({
      name: 'EmbeddedTypeWithDeep',
      fields: () => ({
        embeddedId: { type: GraphQLID },
        embeddedName: { type: GraphQLString },
        deep: { 
          type: DeepEmbeddedType,
          extensions: {
            relation: { embedded: true },
          },
        },
      }),
    });

    const TestType = new GraphQLObjectType({
      name: 'TestTypeWithNestedEmbedded',
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        embedded: { 
          type: EmbeddedType,
          extensions: {
            relation: { embedded: true },
          },
        },
      }),
    });

    // Register the embedded types first
    simfinity.addNoEndpointType(DeepEmbeddedType);
    simfinity.addNoEndpointType(EmbeddedType);
    simfinity.connect(null, TestType, 'testTypeWithNestedEmbedded', 'testTypesWithNestedEmbedded');
    simfinity.createSchema();

    // Should create indexes for all ObjectId fields at all levels
    expect(indexSpy).toHaveBeenCalledWith({ embeddedId: 1 }); // EmbeddedType
    expect(indexSpy).toHaveBeenCalledWith({ 'deep.deepId': 1 }); // DeepEmbeddedType
    expect(indexSpy).toHaveBeenCalledWith({ id: 1 }); // TestType
    expect(indexSpy).toHaveBeenCalledWith({ 'embedded.embeddedId': 1 }); // embedded field in TestType
    expect(indexSpy).toHaveBeenCalledWith({ 'embedded.deep.deepId': 1 }); // nested embedded field in TestType
    expect(indexSpy).toHaveBeenCalledTimes(5);
  });

  test('should create index for array of embedded objects with ObjectId', () => {
    const EmbeddedType = new GraphQLObjectType({
      name: 'EmbeddedTypeForArray',
      fields: () => ({
        embeddedId: { type: GraphQLID },
        embeddedName: { type: GraphQLString },
      }),
    });

    const TestType = new GraphQLObjectType({
      name: 'TestTypeWithEmbeddedArray',
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        embeddedArray: { 
          type: new GraphQLList(EmbeddedType),
          extensions: {
            relation: { embedded: true },
          },
        },
      }),
    });

    // Register the embedded type first
    simfinity.addNoEndpointType(EmbeddedType);
    simfinity.connect(null, TestType, 'testTypeWithEmbeddedArray', 'testTypesWithEmbeddedArray');
    simfinity.createSchema();

    // Should create indexes for id and embeddedArray.embeddedId fields
    expect(indexSpy).toHaveBeenCalledWith({ id: 1 });
    expect(indexSpy).toHaveBeenCalledWith({ 'embeddedArray.embeddedId': 1 });
    expect(indexSpy).toHaveBeenCalledTimes(2);
  });

  test('should not create index for non-ObjectId fields', () => {
    const TestType = new GraphQLObjectType({
      name: 'TestTypeWithoutObjectId',
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        age: { type: GraphQLString },
        active: { type: GraphQLString },
      }),
    });

    simfinity.connect(null, TestType, 'testTypeWithoutObjectId', 'testTypesWithoutObjectId');
    simfinity.createSchema();

    // Should only create index for id field (ObjectId), not for other fields
    expect(indexSpy).toHaveBeenCalledWith({ id: 1 });
    expect(indexSpy).toHaveBeenCalledTimes(1);
  });

  test('should create index for relationship fields (non-embedded)', () => {
    const DepartmentType = new GraphQLObjectType({
      name: 'DepartmentType',
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
      }),
    });

    const UserType = new GraphQLObjectType({
      name: 'TestTypeWithRelationship',
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        department: { 
          type: DepartmentType,
          extensions: {
            relation: { embedded: false },
          },
        },
      }),
    });

    // Register both types
    simfinity.connect(null, DepartmentType, 'department', 'departments');
    simfinity.connect(null, UserType, 'testTypeWithRelationship', 'testTypesWithRelationship');
    simfinity.createSchema();

    // Should create indexes for id fields in both types and the relationship field
    expect(indexSpy).toHaveBeenCalledWith({ id: 1 }); // DepartmentType
    expect(indexSpy).toHaveBeenCalledWith({ id: 1 }); // UserType
    expect(indexSpy).toHaveBeenCalledWith({ department: 1 }); // relationship field
    expect(indexSpy).toHaveBeenCalledTimes(3);
  });
}); 