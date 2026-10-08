import { describe, it, expect, beforeAll, vi } from 'vitest';
import {
  GraphQLObjectType,
  GraphQLString,
  GraphQLInt,
  GraphQLFloat,
  GraphQLList,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLScalarType,
  GraphQLUnionType,
  validateSchema,
} from 'graphql';
import * as simfinity from '../packages/mongodb/src/index.js';
import { createRuntime } from '../packages/core/src/index.js';
import { createMongoAdapter } from '../packages/mongodb/src/mongo/adapter.js';
import { createPostgres } from '../packages/postgres/src/index.js';

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

describe('an application scalar named JSON', () => {
  // Like GraphQLJSON from graphql-scalars or graphql-type-json.
  const appJSON = () => new GraphQLScalarType({
    name: 'JSON', serialize: (value) => value, parseValue: (value) => value, parseLiteral: () => undefined,
  });
  const fakePool = () => ({ connect: vi.fn(), query: vi.fn() });
  const createApi = (backend) => {
    const api = backend === 'mongo'
      ? createRuntime(createMongoAdapter())
      : createPostgres({ pool: fakePool(), schema: 'app_json' });
    if (!api.initializeDatabase) api.preventCreatingCollection(true);
    return api;
  };
  const serieType = (name, extraFields = {}) => new GraphQLObjectType({
    name, fields: { id: { type: GraphQLID }, name: { type: GraphQLString }, ...extraFields },
  });

  it.each(['mongo', 'postgres'])('is reused for aggregation results when a custom mutation returns it (%s)', (backend) => {
    const JSONScalar = appJSON();
    const api = createApi(backend);
    api.connect(null, serieType(`AggAppJSON${backend}Serie`), 'aggAppJSONSerie', 'aggAppJSONSeries');
    api.registerMutation('aggAppJSONReport', 'Report', null, new GraphQLObjectType({
      name: `AggAppJSON${backend}Report`, fields: { payload: { type: JSONScalar } },
    }), async () => ({}));
    const schema = api.createSchema();

    expect(schema.getType('JSON')).toBe(JSONScalar);
    const result = schema.getQueryType().getFields().aggAppJSONSeries_aggregate.type.ofType;
    expect(result.name).toBe('QLTypeAggregationResult');
    expect(result.getFields().groupId.type).toBe(JSONScalar);
    expect(result.getFields().facts.type).toBe(JSONScalar);
  });

  it.each(['mongo', 'postgres'])('is reused when a custom mutation input uses it (%s)', (backend) => {
    const JSONScalar = appJSON();
    const api = createApi(backend);
    api.connect(null, serieType(`AggAppJSONInput${backend}Serie`), 'aggAppJSONSerie', 'aggAppJSONSeries');
    api.registerMutation('aggAppJSONReport', 'Report', new GraphQLInputObjectType({
      name: `AggAppJSONInput${backend}ReportInput`, fields: { payload: { type: JSONScalar } },
    }), GraphQLString, async () => 'ok');

    expect(api.createSchema().getType('JSON')).toBe(JSONScalar);
  });

  it('is reused when a computed MongoDB entity field uses it', () => {
    const JSONScalar = appJSON();
    const api = createApi('mongo');
    api.connect(null, serieType('AggAppJSONComputedSerie', { meta: { type: JSONScalar, resolve: () => ({}) } }),
      'aggAppJSONSerie', 'aggAppJSONSeries');
    const schema = api.createSchema();

    expect(schema.getType('JSON')).toBe(JSONScalar);
    expect(schema.getType('QLTypeAggregationResult').getFields().facts.type).toBe(JSONScalar);
  });

  it('is reused when only the query roots reach it', () => {
    const JSONScalar = appJSON();
    const api = createApi('mongo');
    api.connect(null, serieType('AggAppJSONQueryOnlySerie', { meta: { type: JSONScalar, resolve: () => ({}) } }),
      'aggAppJSONSerie', 'aggAppJSONSeries');
    api.registerMutation('aggAppJSONPing', 'Ping', null, GraphQLString, async () => 'ok');
    // No generated mutations, so only the query roots reach the scalar, past the aggregation results.
    const schema = api.createSchema(undefined, []);

    expect(validateSchema(schema)).toEqual([]);
    expect(schema.getType('JSON')).toBe(JSONScalar);
    const result = schema.getQueryType().getFields().aggAppJSONSeries_aggregate.type.ofType;
    expect(result.getFields().groupId.type).toBe(JSONScalar);
    expect(result.getFields().facts.type).toBe(JSONScalar);
  });

  it('is reused when only a union member of a readOnly field reaches it', () => {
    const JSONScalar = appJSON();
    const api = createApi('mongo');
    const Note = new GraphQLObjectType({ name: 'AggAppJSONUnionNote', fields: { text: { type: GraphQLString } } });
    const Chart = new GraphQLObjectType({ name: 'AggAppJSONUnionChart', fields: { data: { type: JSONScalar } } });
    const Preview = new GraphQLUnionType({
      name: 'AggAppJSONUnionPreview', types: [Note, Chart], resolveType: () => 'AggAppJSONUnionNote',
    });
    api.connect(null, serieType('AggAppJSONUnionSerie', {
      preview: { type: Preview, extensions: { readOnly: true }, resolve: () => null },
    }), 'aggAppJSONSerie', 'aggAppJSONSeries');
    const schema = api.createSchema();

    expect(validateSchema(schema)).toEqual([]);
    expect(schema.getType('JSON')).toBe(JSONScalar);
    const result = schema.getQueryType().getFields().aggAppJSONSeries_aggregate.type.ofType;
    expect(result.getFields().groupId.type).toBe(JSONScalar);
    expect(result.getFields().facts.type).toBe(JSONScalar);
  });

  it('keeps Simfinity\'s scalar when the mutation that uses the application scalar is left out (guard)', () => {
    const JSONScalar = appJSON();
    const api = createApi('mongo');
    api.connect(null, serieType('AggAppJSONExcludedSerie'), 'aggAppJSONSerie', 'aggAppJSONSeries');
    api.registerMutation('aggAppJSONReport', 'Report', null, new GraphQLObjectType({
      name: 'AggAppJSONExcludedReport', fields: { payload: { type: JSONScalar } },
    }), async () => ({}));
    api.registerMutation('aggAppJSONOther', 'Other', null, GraphQLString, async () => 'x');
    const schema = api.createSchema(undefined, undefined, ['aggAppJSONOther']);

    expect(schema.getType('JSON')).not.toBe(JSONScalar);
    expect(schema.getType('JSON').description).toBe('The `JSON` scalar type represents JSON values as specified by ECMA-404');
  });

  it('still reports a type named JSON that is not a scalar as a duplicate type name (guard)', () => {
    const api = createApi('mongo');
    api.connect(null, serieType('AggAppJSONObjectSerie'), 'aggAppJSONSerie', 'aggAppJSONSeries');
    api.registerMutation('aggAppJSONReport', 'Report', null, new GraphQLObjectType({
      name: 'JSON', fields: { a: { type: GraphQLString } },
    }), async () => ({}));

    expect(() => api.createSchema()).toThrow('Schema must contain uniquely named types but contains multiple types named "JSON".');
  });
});
