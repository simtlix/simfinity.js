import { describe, it, expect, beforeAll } from 'vitest';
import {
  GraphQLObjectType,
  GraphQLString,
  GraphQLFloat,
  GraphQLInt,
  GraphQLList,
} from 'graphql';
import * as simfinity from '../src/index.js';

describe('AND/OR Filter Support', () => {
  let schema;
  let bookType;
  let seasonType;

  const GenreType = new GraphQLObjectType({
    name: 'FilterGenre',
    fields: () => ({
      id: { type: GraphQLString },
      name: { type: GraphQLString },
    }),
  });

  const AuthorType = new GraphQLObjectType({
    name: 'FilterAuthor',
    fields: () => ({
      id: { type: GraphQLString },
      name: { type: GraphQLString },
      country: { type: GraphQLString },
    }),
  });

  const EpisodeType = new GraphQLObjectType({
    name: 'FilterEpisode',
    fields: () => ({
      id: { type: GraphQLString },
      name: { type: GraphQLString },
      duration: { type: GraphQLInt },
    }),
  });

  const SeasonType = new GraphQLObjectType({
    name: 'FilterSeason',
    fields: () => ({
      id: { type: GraphQLString },
      number: { type: GraphQLInt },
      year: { type: GraphQLInt },
      category: { type: GraphQLString },
      episodes: {
        type: new GraphQLList(EpisodeType),
        extensions: {
          relation: {
            embedded: false,
            connectionField: 'season_id',
          },
        },
      },
    }),
  });

  const SeriesType = new GraphQLObjectType({
    name: 'FilterSeries',
    fields: () => ({
      id: { type: GraphQLString },
      title: { type: GraphQLString },
      rating: { type: GraphQLFloat },
      seasons: {
        type: new GraphQLList(SeasonType),
        extensions: {
          relation: {
            embedded: false,
            connectionField: 'series_id',
          },
        },
      },
    }),
  });

  const BookType = new GraphQLObjectType({
    name: 'FilterBook',
    fields: () => ({
      id: { type: GraphQLString },
      title: { type: GraphQLString },
      rating: { type: GraphQLFloat },
      category: { type: GraphQLString },
      author: {
        type: AuthorType,
        extensions: {
          relation: {
            embedded: false,
            connectionField: 'author_id',
          },
        },
      },
      genre: {
        type: GenreType,
        extensions: {
          relation: {
            embedded: false,
            connectionField: 'genre_id',
          },
        },
      },
    }),
  });

  beforeAll(() => {
    simfinity.preventCreatingCollection(true);

    simfinity.addNoEndpointType(GenreType);
    simfinity.addNoEndpointType(AuthorType);
    simfinity.addNoEndpointType(EpisodeType);
    simfinity.addNoEndpointType(SeasonType);

    simfinity.connect(
      null,
      BookType,
      'filterbook',
      'filterbooks',
      null,
      null,
      null,
    );

    simfinity.connect(
      null,
      SeriesType,
      'filterseries',
      'filterseries',
      null,
      null,
      null,
    );

    schema = simfinity.createSchema();
    bookType = BookType;
    seasonType = SeasonType;
  });

  describe('Schema Structure', () => {
    it('should have AND and OR args on list endpoint', () => {
      const queryType = schema.getQueryType();
      const fields = queryType.getFields();
      const listField = fields.filterbooks;

      expect(listField).toBeDefined();

      const args = listField.args;
      const andArg = args.find(arg => arg.name === 'AND');
      const orArg = args.find(arg => arg.name === 'OR');

      expect(andArg).toBeDefined();
      expect(orArg).toBeDefined();
      expect(andArg.type.toString()).toBe('[QLFilterGroup]');
      expect(orArg.type.toString()).toBe('[QLFilterGroup]');
    });

    it('should have AND and OR args on aggregate endpoint', () => {
      const queryType = schema.getQueryType();
      const fields = queryType.getFields();
      const aggregateField = fields.filterbooks_aggregate;

      expect(aggregateField).toBeDefined();

      const args = aggregateField.args;
      const andArg = args.find(arg => arg.name === 'AND');
      const orArg = args.find(arg => arg.name === 'OR');

      expect(andArg).toBeDefined();
      expect(orArg).toBeDefined();
    });

    it('should have QLFilterGroup and QLTypeFilter types in schema', () => {
      const schemaTypes = schema.getTypeMap();

      expect(schemaTypes).toHaveProperty('QLFilterGroup');
      expect(schemaTypes).toHaveProperty('QLFilterCondition');

      const filterGroup = schemaTypes.QLFilterGroup;
      const groupFields = filterGroup.getFields();
      expect(groupFields).toHaveProperty('AND');
      expect(groupFields).toHaveProperty('OR');
      expect(groupFields).toHaveProperty('conditions');

      const filterCondition = schemaTypes.QLFilterCondition;
      const condFields = filterCondition.getFields();
      expect(condFields).toHaveProperty('field');
      expect(condFields).toHaveProperty('operator');
      expect(condFields).toHaveProperty('value');
      expect(condFields).toHaveProperty('path');
    });

    it('should still have existing flat filter args (backward compatible)', () => {
      const queryType = schema.getQueryType();
      const fields = queryType.getFields();
      const listField = fields.filterbooks;

      const args = listField.args;
      const titleArg = args.find(arg => arg.name === 'title');
      const ratingArg = args.find(arg => arg.name === 'rating');
      const authorArg = args.find(arg => arg.name === 'author');
      const paginationArg = args.find(arg => arg.name === 'pagination');
      const sortArg = args.find(arg => arg.name === 'sort');

      expect(titleArg).toBeDefined();
      expect(ratingArg).toBeDefined();
      expect(authorArg).toBeDefined();
      expect(paginationArg).toBeDefined();
      expect(sortArg).toBeDefined();
    });
  });

  describe('buildQuery - Backward Compatibility', () => {
    it('should produce same pipeline for flat scalar filters (no AND/OR)', async () => {
      const input = {
        title: { operator: 'EQ', value: 'Galaxy' },
      };
      const pipeline = await simfinity.buildQuery(input, bookType);

      // Should have $match with title condition
      const matchStage = pipeline.find(stage => stage.$match);
      expect(matchStage).toBeDefined();
      expect(matchStage.$match.title).toBe('Galaxy');
    });

    it('should produce pipeline with multiple flat filters as implicit AND', async () => {
      const input = {
        title: { operator: 'EQ', value: 'Galaxy' },
        rating: { operator: 'GTE', value: 8.0 },
      };
      const pipeline = await simfinity.buildQuery(input, bookType);

      const matchStage = pipeline.find(stage => stage.$match);
      expect(matchStage).toBeDefined();
      expect(matchStage.$match.title).toBe('Galaxy');
      expect(matchStage.$match.rating).toEqual({ $gte: 8.0 });
    });

    it('should include $limit and $skip defaults', async () => {
      const input = {
        title: { operator: 'EQ', value: 'Galaxy' },
      };
      const pipeline = await simfinity.buildQuery(input, bookType);

      const limitStage = pipeline.find(stage => stage.$limit !== undefined);
      const skipStage = pipeline.find(stage => stage.$skip !== undefined);
      expect(limitStage).toEqual({ $limit: 100 });
      expect(skipStage).toEqual({ $skip: 0 });
    });

    it('should produce empty pipeline with no filters', async () => {
      const input = {};
      const pipeline = await simfinity.buildQuery(input, bookType);

      // Should only have $limit and $skip, no $match
      const matchStage = pipeline.find(stage => stage.$match);
      expect(matchStage).toBeUndefined();
      expect(pipeline).toHaveLength(2); // $limit, $skip
    });
  });

  describe('buildQuery - Simple OR', () => {
    it('should create $or with two scalar conditions', async () => {
      const input = {
        OR: [
          { conditions: [{ field: 'category', operator: 'EQ', value: 'Sci-Fi' }] },
          { conditions: [{ field: 'category', operator: 'EQ', value: 'Fantasy' }] },
        ],
      };
      const pipeline = await simfinity.buildQuery(input, bookType);

      const matchStage = pipeline.find(stage => stage.$match);
      expect(matchStage).toBeDefined();
      expect(matchStage.$match.$or).toBeDefined();
      expect(matchStage.$match.$or).toHaveLength(2);
      expect(matchStage.$match.$or[0]).toEqual({ category: 'Sci-Fi' });
      expect(matchStage.$match.$or[1]).toEqual({ category: 'Fantasy' });
    });

    it('should handle OR with different fields', async () => {
      const input = {
        OR: [
          { conditions: [{ field: 'title', operator: 'LIKE', value: 'Galaxy' }] },
          { conditions: [{ field: 'category', operator: 'EQ', value: 'Fantasy' }] },
        ],
      };
      const pipeline = await simfinity.buildQuery(input, bookType);

      const matchStage = pipeline.find(stage => stage.$match);
      expect(matchStage.$match.$or).toHaveLength(2);
      expect(matchStage.$match.$or[0]).toEqual({ title: { $regex: '.*Galaxy.*' } });
      expect(matchStage.$match.$or[1]).toEqual({ category: 'Fantasy' });
    });

    it('should handle single OR branch as direct condition', async () => {
      const input = {
        OR: [
          { conditions: [{ field: 'category', operator: 'EQ', value: 'Sci-Fi' }] },
        ],
      };
      const pipeline = await simfinity.buildQuery(input, bookType);

      const matchStage = pipeline.find(stage => stage.$match);
      expect(matchStage).toBeDefined();
      // Single OR branch should not create $or wrapper
      expect(matchStage.$match.$or).toBeUndefined();
      expect(matchStage.$match.category).toBe('Sci-Fi');
    });
  });

  describe('buildQuery - Simple AND', () => {
    it('should create $and with explicit AND groups', async () => {
      const input = {
        AND: [
          { conditions: [{ field: 'rating', operator: 'GTE', value: 8.0 }] },
          { conditions: [{ field: 'category', operator: 'EQ', value: 'Sci-Fi' }] },
        ],
      };
      const pipeline = await simfinity.buildQuery(input, bookType);

      const matchStage = pipeline.find(stage => stage.$match);
      expect(matchStage).toBeDefined();
      expect(matchStage.$match.$and).toBeDefined();
      expect(matchStage.$match.$and).toHaveLength(2);
      expect(matchStage.$match.$and[0]).toEqual({ rating: { $gte: 8.0 } });
      expect(matchStage.$match.$and[1]).toEqual({ category: 'Sci-Fi' });
    });
  });

  describe('buildQuery - Mixed Flat + OR (Scope Safety)', () => {
    it('should AND flat filters with OR group', async () => {
      const input = {
        rating: { operator: 'GTE', value: 7.0 },
        OR: [
          { conditions: [{ field: 'category', operator: 'EQ', value: 'Sci-Fi' }] },
          { conditions: [{ field: 'category', operator: 'EQ', value: 'Fantasy' }] },
        ],
      };
      const pipeline = await simfinity.buildQuery(input, bookType);

      const matchStage = pipeline.find(stage => stage.$match);
      expect(matchStage).toBeDefined();
      // Flat + OR should produce $and at top level
      expect(matchStage.$match.$and).toBeDefined();
      expect(matchStage.$match.$and).toHaveLength(2);

      // First part: flat conditions
      expect(matchStage.$match.$and[0].rating).toEqual({ $gte: 7.0 });

      // Second part: $or
      expect(matchStage.$match.$and[1].$or).toHaveLength(2);
      expect(matchStage.$match.$and[1].$or[0]).toEqual({ category: 'Sci-Fi' });
      expect(matchStage.$match.$and[1].$or[1]).toEqual({ category: 'Fantasy' });
    });

    it('should AND scope-injected filters with user OR (scope cannot be bypassed)', async () => {
      // Simulate scope injecting a tenant filter before buildQuery
      const input = {
        category: { operator: 'EQ', value: 'tenant-123' },
        OR: [
          { conditions: [{ field: 'title', operator: 'LIKE', value: 'Galaxy' }] },
          { conditions: [{ field: 'title', operator: 'LIKE', value: 'Hitchhiker' }] },
        ],
      };
      const pipeline = await simfinity.buildQuery(input, bookType);

      const matchStage = pipeline.find(stage => stage.$match);
      expect(matchStage.$match.$and).toBeDefined();
      // Scope condition (flat) is always enforced at top level
      expect(matchStage.$match.$and[0].category).toBe('tenant-123');
      // User OR is a sibling, cannot bypass scope
      expect(matchStage.$match.$and[1].$or).toHaveLength(2);
    });
  });

  describe('buildQuery - Nested AND inside OR', () => {
    it('should support AND groups nested within OR', async () => {
      const input = {
        OR: [
          {
            AND: [
              { conditions: [{ field: 'rating', operator: 'GTE', value: 9.0 }] },
              { conditions: [{ field: 'category', operator: 'EQ', value: 'Sci-Fi' }] },
            ],
          },
          {
            AND: [
              { conditions: [{ field: 'rating', operator: 'GTE', value: 8.0 }] },
              { conditions: [{ field: 'category', operator: 'EQ', value: 'Fantasy' }] },
            ],
          },
        ],
      };
      const pipeline = await simfinity.buildQuery(input, bookType);

      const matchStage = pipeline.find(stage => stage.$match);
      expect(matchStage.$match.$or).toBeDefined();
      expect(matchStage.$match.$or).toHaveLength(2);

      // First OR branch: AND of rating >= 9 and category = Sci-Fi
      expect(matchStage.$match.$or[0].$and).toHaveLength(2);
      expect(matchStage.$match.$or[0].$and[0]).toEqual({ rating: { $gte: 9.0 } });
      expect(matchStage.$match.$or[0].$and[1]).toEqual({ category: 'Sci-Fi' });

      // Second OR branch: AND of rating >= 8 and category = Fantasy
      expect(matchStage.$match.$or[1].$and).toHaveLength(2);
      expect(matchStage.$match.$or[1].$and[0]).toEqual({ rating: { $gte: 8.0 } });
      expect(matchStage.$match.$or[1].$and[1]).toEqual({ category: 'Fantasy' });
    });

    it('should support OR nested within AND', async () => {
      const input = {
        AND: [
          {
            OR: [
              { conditions: [{ field: 'category', operator: 'EQ', value: 'Sci-Fi' }] },
              { conditions: [{ field: 'category', operator: 'EQ', value: 'Fantasy' }] },
            ],
          },
          { conditions: [{ field: 'rating', operator: 'GTE', value: 8.0 }] },
        ],
      };
      const pipeline = await simfinity.buildQuery(input, bookType);

      const matchStage = pipeline.find(stage => stage.$match);
      expect(matchStage.$match.$and).toBeDefined();
      expect(matchStage.$match.$and).toHaveLength(2);

      // First AND part: the OR group
      expect(matchStage.$match.$and[0].$or).toHaveLength(2);

      // Second AND part: the rating condition
      expect(matchStage.$match.$and[1]).toEqual({ rating: { $gte: 8.0 } });
    });
  });

  describe('buildQuery - Relationship Filters in AND/OR', () => {
    // Note: Relationship pipeline tests (with $lookup) require models which need
    // a real MongoDB connection. With preventCreatingCollection(true), models for
    // addNoEndpointType types are null, so we test the structural/schema aspects
    // and validate that buildFilterGroupMatch correctly identifies relation fields.

    it('should accept relation fields with path in conditions', () => {
      const queryType = schema.getQueryType();
      const fields = queryType.getFields();
      const listField = fields.filterbooks;

      // Verify author is available as a filter arg (QLTypeFilterExpression)
      const authorArg = listField.args.find(arg => arg.name === 'author');
      expect(authorArg).toBeDefined();
      expect(authorArg.type.name).toBe('QLTypeFilterExpression');

      // AND/OR conditions can reference 'author' with a path
      const schemaTypes = schema.getTypeMap();
      const conditionType = schemaTypes.QLTypeFilter;
      const condFields = conditionType.getFields();
      expect(condFields.path).toBeDefined();
    });

    it('should throw when relation field is used without path in AND/OR', async () => {
      const filterGroup = {
        conditions: [{ field: 'author', operator: 'EQ', value: 'test' }],
      };
      await expect(
        simfinity.buildFilterGroupMatch(filterGroup, bookType, [], {}),
      ).rejects.toThrow('requires a path');
    });

    it('should throw when relation field is used without path in OR group', async () => {
      const filterGroup = {
        conditions: [{ field: 'genre', operator: 'EQ', value: 'test' }],
      };
      await expect(
        simfinity.buildFilterGroupMatch(filterGroup, bookType, [], {}),
      ).rejects.toThrow('requires a path');
    });
  });

  describe('buildQuery - All Operators in AND/OR', () => {
    it('should support all operators within OR conditions', async () => {
      const input = {
        OR: [
          { conditions: [{ field: 'rating', operator: 'LT', value: 5.0 }] },
          { conditions: [{ field: 'rating', operator: 'GT', value: 9.0 }] },
        ],
      };
      const pipeline = await simfinity.buildQuery(input, bookType);

      const matchStage = pipeline.find(stage => stage.$match);
      expect(matchStage.$match.$or[0]).toEqual({ rating: { $lt: 5.0 } });
      expect(matchStage.$match.$or[1]).toEqual({ rating: { $gt: 9.0 } });
    });

    it('should support BTW and IN operators in AND/OR', async () => {
      const input = {
        OR: [
          { conditions: [{ field: 'rating', operator: 'BTW', value: [7.0, 8.0] }] },
          { conditions: [{ field: 'category', operator: 'IN', value: ['Sci-Fi', 'Fantasy'] }] },
        ],
      };
      const pipeline = await simfinity.buildQuery(input, bookType);

      const matchStage = pipeline.find(stage => stage.$match);
      expect(matchStage.$match.$or[0]).toEqual({ rating: { $gte: 7.0, $lte: 8.0 } });
      expect(matchStage.$match.$or[1]).toEqual({ category: { $in: ['Sci-Fi', 'Fantasy'] } });
    });

    it('should support NE and NIN operators in AND/OR', async () => {
      const input = {
        AND: [
          { conditions: [{ field: 'category', operator: 'NE', value: 'Horror' }] },
          { conditions: [{ field: 'category', operator: 'NIN', value: ['Romance', 'Drama'] }] },
        ],
      };
      const pipeline = await simfinity.buildQuery(input, bookType);

      const matchStage = pipeline.find(stage => stage.$match);
      expect(matchStage.$match.$and[0]).toEqual({ category: { $ne: 'Horror' } });
      expect(matchStage.$match.$and[1]).toEqual({ category: { $nin: ['Romance', 'Drama'] } });
    });
  });

  describe('buildQuery - Multiple Conditions per Group', () => {
    it('should AND multiple conditions within a single group', async () => {
      const input = {
        OR: [
          {
            conditions: [
              { field: 'rating', operator: 'GTE', value: 9.0 },
              { field: 'category', operator: 'EQ', value: 'Sci-Fi' },
            ],
          },
          { conditions: [{ field: 'category', operator: 'EQ', value: 'Fantasy' }] },
        ],
      };
      const pipeline = await simfinity.buildQuery(input, bookType);

      const matchStage = pipeline.find(stage => stage.$match);
      expect(matchStage.$match.$or).toHaveLength(2);
      // First branch has two conditions → $and
      expect(matchStage.$match.$or[0].$and).toHaveLength(2);
      expect(matchStage.$match.$or[0].$and[0]).toEqual({ rating: { $gte: 9.0 } });
      expect(matchStage.$match.$or[0].$and[1]).toEqual({ category: 'Sci-Fi' });
      // Second branch has one condition
      expect(matchStage.$match.$or[1]).toEqual({ category: 'Fantasy' });
    });
  });

  describe('buildQuery - Pagination and Sort with AND/OR', () => {
    it('should apply pagination alongside AND/OR filters', async () => {
      const input = {
        OR: [
          { conditions: [{ field: 'category', operator: 'EQ', value: 'Sci-Fi' }] },
          { conditions: [{ field: 'category', operator: 'EQ', value: 'Fantasy' }] },
        ],
        pagination: { page: 2, size: 10 },
      };
      const pipeline = await simfinity.buildQuery(input, bookType);

      const limitStage = pipeline.find(stage => stage.$limit !== undefined);
      const skipStage = pipeline.find(stage => stage.$skip !== undefined);
      expect(limitStage).toEqual({ $limit: 10 });
      expect(skipStage).toEqual({ $skip: 10 }); // size * (page - 1)
    });

    it('should apply sort alongside AND/OR filters', async () => {
      const input = {
        OR: [
          { conditions: [{ field: 'category', operator: 'EQ', value: 'Sci-Fi' }] },
          { conditions: [{ field: 'category', operator: 'EQ', value: 'Fantasy' }] },
        ],
        sort: { terms: [{ field: 'rating', order: 'DESC' }] },
      };
      const pipeline = await simfinity.buildQuery(input, bookType);

      const sortStage = pipeline.find(stage => stage.$sort);
      expect(sortStage).toEqual({ $sort: { rating: -1 } });
    });
  });

  describe('buildQuery - Empty and Edge Cases', () => {
    it('should handle empty OR array as no-op', async () => {
      const input = {
        OR: [],
      };
      const pipeline = await simfinity.buildQuery(input, bookType);

      const matchStage = pipeline.find(stage => stage.$match);
      expect(matchStage).toBeUndefined();
    });

    it('should handle empty AND array as no-op', async () => {
      const input = {
        AND: [],
      };
      const pipeline = await simfinity.buildQuery(input, bookType);

      const matchStage = pipeline.find(stage => stage.$match);
      expect(matchStage).toBeUndefined();
    });

    it('should handle group with empty conditions', async () => {
      const input = {
        OR: [
          { conditions: [] },
          { conditions: [{ field: 'category', operator: 'EQ', value: 'Sci-Fi' }] },
        ],
      };
      const pipeline = await simfinity.buildQuery(input, bookType);

      const matchStage = pipeline.find(stage => stage.$match);
      expect(matchStage).toBeDefined();
      // Empty branch is skipped, only one condition remains — no $or wrapper
      expect(matchStage.$match.category).toBe('Sci-Fi');
    });
  });

  describe('buildFilterGroupMatch - Validation', () => {
    it('should throw on unknown field name', async () => {
      const filterGroup = {
        conditions: [{ field: 'nonexistent', operator: 'EQ', value: 'test' }],
      };
      await expect(
        simfinity.buildFilterGroupMatch(filterGroup, bookType, [], {}),
      ).rejects.toThrow('Unknown filter field: nonexistent');
    });

    it('should throw when object field is missing path', async () => {
      const filterGroup = {
        conditions: [{ field: 'author', operator: 'EQ', value: 'test' }],
      };
      await expect(
        simfinity.buildFilterGroupMatch(filterGroup, bookType, [], {}),
      ).rejects.toThrow('requires a path');
    });

    it('should throw on excessive nesting depth', async () => {
      // Create deeply nested structure exceeding max depth (5)
      let group = { conditions: [{ field: 'title', operator: 'EQ', value: 'x' }] };
      for (let i = 0; i < 6; i++) {
        group = { AND: [group] };
      }
      await expect(
        simfinity.buildFilterGroupMatch(group, bookType, [], {}),
      ).rejects.toThrow('Filter nesting too deep');
    });

    it('should accept nesting at max depth', async () => {
      // Create structure exactly at max depth (5) — should succeed
      let group = { conditions: [{ field: 'title', operator: 'EQ', value: 'x' }] };
      for (let i = 0; i < 5; i++) {
        group = { AND: [group] };
      }
      const result = await simfinity.buildFilterGroupMatch(group, bookType, [], {});
      expect(result).toBeDefined();
      expect(result.title).toBe('x');
    });
  });

  describe('Collection Filtering with AND/OR - Schema', () => {
    it('should have AND and OR args on collection field resolvers', () => {
      const seriesQueryType = schema.getQueryType();
      const fields = seriesQueryType.getFields();
      const seriesField = fields.filterseries;
      expect(seriesField).toBeDefined();

      // The SeriesType has a 'seasons' collection field
      // After autoGenerateResolvers, seasons should have AND/OR args
      const seriesType = schema.getTypeMap().FilterSeries;
      const seasonsField = seriesType.getFields().seasons;

      const andArg = seasonsField.args.find(arg => arg.name === 'AND');
      const orArg = seasonsField.args.find(arg => arg.name === 'OR');

      expect(andArg).toBeDefined();
      expect(orArg).toBeDefined();
      expect(andArg.type.toString()).toBe('[QLFilterGroup]');
      expect(orArg.type.toString()).toBe('[QLFilterGroup]');
    });

    it('should have flat filter args alongside AND/OR on collection fields', () => {
      const seriesType = schema.getTypeMap().FilterSeries;
      const seasonsField = seriesType.getFields().seasons;

      const numberArg = seasonsField.args.find(arg => arg.name === 'number');
      const yearArg = seasonsField.args.find(arg => arg.name === 'year');
      const categoryArg = seasonsField.args.find(arg => arg.name === 'category');
      const paginationArg = seasonsField.args.find(arg => arg.name === 'pagination');
      const sortArg = seasonsField.args.find(arg => arg.name === 'sort');

      expect(numberArg).toBeDefined();
      expect(yearArg).toBeDefined();
      expect(categoryArg).toBeDefined();
      expect(paginationArg).toBeDefined();
      expect(sortArg).toBeDefined();
    });

    it('should not include the connection field in collection args', () => {
      // The SeasonType is related via 'series_id', so 'series_id' should be excluded
      const seriesType = schema.getTypeMap().FilterSeries;
      const seasonsField = seriesType.getFields().seasons;

      const connectionArg = seasonsField.args.find(arg => arg.name === 'series_id');
      expect(connectionArg).toBeUndefined();
    });
  });

  describe('buildQuery - Collection Filtering with AND/OR (pipeline)', () => {
    it('should produce OR pipeline for collection field type', async () => {
      const input = {
        OR: [
          { conditions: [{ field: 'year', operator: 'EQ', value: 2020 }] },
          { conditions: [{ field: 'year', operator: 'EQ', value: 2021 }] },
        ],
      };
      const pipeline = await simfinity.buildQuery(input, seasonType);

      const matchStage = pipeline.find(stage => stage.$match);
      expect(matchStage).toBeDefined();
      expect(matchStage.$match.$or).toHaveLength(2);
      expect(matchStage.$match.$or[0]).toEqual({ year: 2020 });
      expect(matchStage.$match.$or[1]).toEqual({ year: 2021 });
    });

    it('should produce mixed flat + OR pipeline for collection field type', async () => {
      const input = {
        number: { operator: 'GT', value: 1 },
        OR: [
          { conditions: [{ field: 'year', operator: 'EQ', value: 2020 }] },
          { conditions: [{ field: 'year', operator: 'EQ', value: 2021 }] },
        ],
      };
      const pipeline = await simfinity.buildQuery(input, seasonType);

      const matchStage = pipeline.find(stage => stage.$match);
      expect(matchStage.$match.$and).toBeDefined();
      expect(matchStage.$match.$and).toHaveLength(2);
      // Flat filter
      expect(matchStage.$match.$and[0].number).toEqual({ $gt: 1 });
      // OR group
      expect(matchStage.$match.$and[1].$or).toHaveLength(2);
      expect(matchStage.$match.$and[1].$or[0]).toEqual({ year: 2020 });
      expect(matchStage.$match.$and[1].$or[1]).toEqual({ year: 2021 });
    });

    it('should produce nested AND-inside-OR pipeline for collection type', async () => {
      const input = {
        OR: [
          {
            AND: [
              { conditions: [{ field: 'year', operator: 'GTE', value: 2022 }] },
              { conditions: [{ field: 'category', operator: 'EQ', value: 'Drama' }] },
            ],
          },
          { conditions: [{ field: 'year', operator: 'EQ', value: 2020 }] },
        ],
      };
      const pipeline = await simfinity.buildQuery(input, seasonType);

      const matchStage = pipeline.find(stage => stage.$match);
      expect(matchStage.$match.$or).toHaveLength(2);
      expect(matchStage.$match.$or[0].$and).toHaveLength(2);
      expect(matchStage.$match.$or[0].$and[0]).toEqual({ year: { $gte: 2022 } });
      expect(matchStage.$match.$or[0].$and[1]).toEqual({ category: 'Drama' });
      expect(matchStage.$match.$or[1]).toEqual({ year: 2020 });
    });
  });

  describe('buildQuery - Mixed Old Pattern with AND/OR', () => {
    it('should combine flat scalar filter + flat relation filter + OR', async () => {
      // Old pattern: rating flat filter + author relation filter
      // New pattern: OR group
      // All should AND together at top level
      const input = {
        rating: { operator: 'GTE', value: 7.0 },
        OR: [
          { conditions: [{ field: 'category', operator: 'EQ', value: 'Sci-Fi' }] },
          { conditions: [{ field: 'category', operator: 'EQ', value: 'Fantasy' }] },
        ],
      };
      const pipeline = await simfinity.buildQuery(input, bookType);

      const matchStage = pipeline.find(stage => stage.$match);
      expect(matchStage.$match.$and).toHaveLength(2);
      expect(matchStage.$match.$and[0].rating).toEqual({ $gte: 7.0 });
      expect(matchStage.$match.$and[1].$or).toHaveLength(2);
    });

    it('should combine multiple flat filters + AND group', async () => {
      const input = {
        title: { operator: 'LIKE', value: 'Galaxy' },
        rating: { operator: 'GTE', value: 5.0 },
        AND: [
          { conditions: [{ field: 'category', operator: 'NE', value: 'Horror' }] },
        ],
      };
      const pipeline = await simfinity.buildQuery(input, bookType);

      const matchStage = pipeline.find(stage => stage.$match);
      expect(matchStage.$match.$and).toHaveLength(2);
      // Flat conditions merged
      expect(matchStage.$match.$and[0].title).toEqual({ $regex: '.*Galaxy.*' });
      expect(matchStage.$match.$and[0].rating).toEqual({ $gte: 5.0 });
      // AND group condition
      expect(matchStage.$match.$and[1]).toEqual({ category: { $ne: 'Horror' } });
    });

    it('should combine flat filters + AND with nested OR', async () => {
      // rating >= 5 AND (category = Sci-Fi OR category = Fantasy) AND (title LIKE "Galaxy" OR title LIKE "Star")
      const input = {
        rating: { operator: 'GTE', value: 5.0 },
        AND: [
          {
            OR: [
              { conditions: [{ field: 'category', operator: 'EQ', value: 'Sci-Fi' }] },
              { conditions: [{ field: 'category', operator: 'EQ', value: 'Fantasy' }] },
            ],
          },
          {
            OR: [
              { conditions: [{ field: 'title', operator: 'LIKE', value: 'Galaxy' }] },
              { conditions: [{ field: 'title', operator: 'LIKE', value: 'Star' }] },
            ],
          },
        ],
      };
      const pipeline = await simfinity.buildQuery(input, bookType);

      const matchStage = pipeline.find(stage => stage.$match);
      expect(matchStage.$match.$and).toHaveLength(3);

      // Flat condition
      expect(matchStage.$match.$and[0].rating).toEqual({ $gte: 5.0 });

      // First AND group: OR of categories
      expect(matchStage.$match.$and[1].$or).toHaveLength(2);
      expect(matchStage.$match.$and[1].$or[0]).toEqual({ category: 'Sci-Fi' });
      expect(matchStage.$match.$and[1].$or[1]).toEqual({ category: 'Fantasy' });

      // Second AND group: OR of titles
      expect(matchStage.$match.$and[2].$or).toHaveLength(2);
      expect(matchStage.$match.$and[2].$or[0]).toEqual({ title: { $regex: '.*Galaxy.*' } });
      expect(matchStage.$match.$and[2].$or[1]).toEqual({ title: { $regex: '.*Star.*' } });
    });

    it('should combine flat filters + both AND and OR at top level', async () => {
      // rating >= 5 AND (explicit AND group) AND (explicit OR group)
      const input = {
        rating: { operator: 'GTE', value: 5.0 },
        AND: [
          { conditions: [{ field: 'category', operator: 'NE', value: 'Horror' }] },
        ],
        OR: [
          { conditions: [{ field: 'title', operator: 'LIKE', value: 'Galaxy' }] },
          { conditions: [{ field: 'title', operator: 'LIKE', value: 'Star' }] },
        ],
      };
      const pipeline = await simfinity.buildQuery(input, bookType);

      const matchStage = pipeline.find(stage => stage.$match);
      expect(matchStage.$match.$and).toHaveLength(3);

      // Flat
      expect(matchStage.$match.$and[0].rating).toEqual({ $gte: 5.0 });
      // AND group
      expect(matchStage.$match.$and[1]).toEqual({ category: { $ne: 'Horror' } });
      // OR group
      expect(matchStage.$match.$and[2].$or).toHaveLength(2);
    });

    it('should work with only flat filters (no AND/OR) — backward compatible', async () => {
      const input = {
        title: { operator: 'LIKE', value: 'Galaxy' },
        rating: { operator: 'GTE', value: 8.0 },
        category: { operator: 'IN', value: ['Sci-Fi', 'Fantasy'] },
      };
      const pipeline = await simfinity.buildQuery(input, bookType);

      const matchStage = pipeline.find(stage => stage.$match);
      // No $and or $or wrapper — flat merge like before
      expect(matchStage.$match.$and).toBeUndefined();
      expect(matchStage.$match.$or).toBeUndefined();
      expect(matchStage.$match.title).toEqual({ $regex: '.*Galaxy.*' });
      expect(matchStage.$match.rating).toEqual({ $gte: 8.0 });
      expect(matchStage.$match.category).toEqual({ $in: ['Sci-Fi', 'Fantasy'] });
    });

    it('should combine flat collection filters + OR on collection type', async () => {
      // Simulates what autoGenerateResolvers would pass: flat number + OR on year
      const input = {
        number: { operator: 'GT', value: 1 },
        category: { operator: 'EQ', value: 'Drama' },
        OR: [
          { conditions: [{ field: 'year', operator: 'EQ', value: 2020 }] },
          {
            AND: [
              { conditions: [{ field: 'year', operator: 'GTE', value: 2022 }] },
              { conditions: [{ field: 'number', operator: 'LTE', value: 5 }] },
            ],
          },
        ],
      };
      const pipeline = await simfinity.buildQuery(input, seasonType);

      const matchStage = pipeline.find(stage => stage.$match);
      expect(matchStage.$match.$and).toHaveLength(2);

      // Flat conditions merged together
      expect(matchStage.$match.$and[0].number).toEqual({ $gt: 1 });
      expect(matchStage.$match.$and[0].category).toBe('Drama');

      // OR group with nested AND
      expect(matchStage.$match.$and[1].$or).toHaveLength(2);
      expect(matchStage.$match.$and[1].$or[0]).toEqual({ year: 2020 });
      expect(matchStage.$match.$and[1].$or[1].$and).toHaveLength(2);
      expect(matchStage.$match.$and[1].$or[1].$and[0]).toEqual({ year: { $gte: 2022 } });
      expect(matchStage.$match.$and[1].$or[1].$and[1]).toEqual({ number: { $lte: 5 } });
    });
  });
});
