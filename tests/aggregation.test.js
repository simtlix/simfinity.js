import { describe, it, expect, beforeAll } from 'vitest';
import {
  GraphQLObjectType,
  GraphQLString,
  GraphQLInt,
  GraphQLFloat,
  GraphQLList,
} from 'graphql';
import * as simfinity from '../src/index.js';

describe('Aggregation Queries', () => {
  let schema;

  const CategoryType = new GraphQLObjectType({
    name: 'AggCategory',
    fields: () => ({
      id: { type: GraphQLString },
      name: { type: GraphQLString },
    }),
  });

  const SeriesType = new GraphQLObjectType({
    name: 'AggSeries',
    fields: () => ({
      id: { type: GraphQLString },
      title: { type: GraphQLString },
      category: { type: GraphQLString },
      rating: { type: GraphQLFloat },
      episodeCount: { type: GraphQLInt },
      country: {
        type: CategoryType,
        extensions: {
          relation: {
            embedded: false,
            connectionField: 'country_id',
          },
        },
      },
    }),
  });

  beforeAll(() => {
    // Prevent collection creation to avoid database connection issues
    simfinity.preventCreatingCollection(true);

    simfinity.addNoEndpointType(CategoryType);
    
    simfinity.connect(
      null,
      SeriesType,
      'aggseries',
      'aggseries',
      null,
      null,
      null,
    );

    schema = simfinity.createSchema();
  });

  it('should have aggregation endpoint in schema', () => {
    const queryType = schema.getQueryType();
    const fields = queryType.getFields();
    
    expect(fields).toHaveProperty('aggseries_aggregate');
  });

  it('should have correct aggregation query structure', () => {
    const queryType = schema.getQueryType();
    const fields = queryType.getFields();
    const aggregateField = fields.aggseries_aggregate;
    
    expect(aggregateField).toBeDefined();
    expect(aggregateField.type).toBeInstanceOf(GraphQLList);
    expect(aggregateField.type.ofType.name).toBe('QLTypeAggregationResult');
    
    // Check that it has the aggregation argument
    const args = aggregateField.args;
    const aggregationArg = args.find(arg => arg.name === 'aggregation');
    expect(aggregationArg).toBeDefined();
    expect(aggregationArg.type.toString()).toContain('QLTypeAggregationExpression!');
  });

  it('should have QLTypeAggregationResult with correct fields', () => {
    const queryType = schema.getQueryType();
    const fields = queryType.getFields();
    const aggregateField = fields.aggseries_aggregate;
    const resultType = aggregateField.type.ofType;
    
    const resultFields = resultType.getFields();
    expect(resultFields).toHaveProperty('groupId');
    expect(resultFields).toHaveProperty('facts');
    
    // Both should be JSON types
    expect(resultFields.groupId.type.name).toBe('JSON');
    expect(resultFields.facts.type.name).toBe('JSON');
  });

  it('should include filter arguments from the entity', () => {
    const queryType = schema.getQueryType();
    const fields = queryType.getFields();
    const aggregateField = fields.aggseries_aggregate;
    
    const args = aggregateField.args;
    const categoryArg = args.find(arg => arg.name === 'category');
    const ratingArg = args.find(arg => arg.name === 'rating');
    const paginationArg = args.find(arg => arg.name === 'pagination');
    const sortArg = args.find(arg => arg.name === 'sort');
    
    expect(categoryArg).toBeDefined();
    expect(ratingArg).toBeDefined();
    expect(paginationArg).toBeDefined();
    expect(sortArg).toBeDefined();
  });

  it('should have aggregation types in schema', () => {
    const schemaTypes = schema.getTypeMap();
    
    expect(schemaTypes).toHaveProperty('QLAggregationOperation');
    expect(schemaTypes).toHaveProperty('QLTypeAggregationFact');
    expect(schemaTypes).toHaveProperty('QLTypeAggregationExpression');
    expect(schemaTypes).toHaveProperty('QLTypeAggregationResult');
    
    const operationEnum = schemaTypes.QLAggregationOperation;
    const operations = operationEnum.getValues();
    const operationNames = operations.map(op => op.name);
    
    expect(operationNames).toContain('SUM');
    expect(operationNames).toContain('COUNT');
    expect(operationNames).toContain('AVG');
    expect(operationNames).toContain('MIN');
    expect(operationNames).toContain('MAX');
  });
});

