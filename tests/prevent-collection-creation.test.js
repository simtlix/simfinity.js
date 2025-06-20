const mongoose = require('mongoose');
const { GraphQLObjectType, GraphQLString, GraphQLID } = require('graphql');
const simfinity = require('../src/index');

describe('preventCreatingCollection option', () => {
  let createCollectionSpy;

  beforeEach(() => {
    // Reset modules to have a clean state for each test
    jest.resetModules();
    // Spy on the createCollection method of the mongoose model prototype
    createCollectionSpy = jest.spyOn(mongoose.Model, 'createCollection').mockImplementation(() => Promise.resolve());
  });

  afterEach(() => {
    // Restore the original implementation
    createCollectionSpy.mockRestore();
  });

  test('should create collection by default', () => {
    const TestType = new GraphQLObjectType({
      name: 'TestTypeDefault',
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
      }),
    });

    simfinity.connect(null, TestType, 'testTypeDefault', 'testTypesDefault');
    expect(createCollectionSpy).toHaveBeenCalledTimes(1);
  });

  test('should NOT create collection when preventCreatingCollection is true', () => {
    simfinity.preventCreatingCollection(true);

    const TestType = new GraphQLObjectType({
      name: 'TestTypePrevent',
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
      }),
    });

    simfinity.connect(null, TestType, 'testTypePrevent', 'testTypesPrevent');
    expect(createCollectionSpy).not.toHaveBeenCalled();
  });

  test('should create collection when preventCreatingCollection is set back to false', () => {
    simfinity.preventCreatingCollection(true); // first prevent
    simfinity.preventCreatingCollection(false); // then allow

    const TestType = new GraphQLObjectType({
      name: 'TestTypeAllow',
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
      }),
    });

    simfinity.connect(null, TestType, 'testTypeAllow', 'testTypesAllow');
    expect(createCollectionSpy).toHaveBeenCalledTimes(1);
  });
});
