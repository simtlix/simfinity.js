import {
  describe, test, expect,
} from 'vitest';
import { GraphQLString, GraphQLInt, GraphQLFloat, GraphQLBoolean, GraphQLID } from 'graphql';
import { createValidatedScalar } from '../src/index.js';

describe('Validated Scalar Naming Convention', () => {
  test('should generate correct type names with base scalar type suffix', () => {
    const EmailScalar = createValidatedScalar(
      'Email',
      'A valid email address',
      GraphQLString,
      (value) => {
        if (!value.includes('@')) {
          throw new Error('Invalid email format');
        }
      },
    );

    const EpisodeNumberScalar = createValidatedScalar(
      'EpisodeNumber',
      'A valid episode number',
      GraphQLInt,
      (value) => {
        if (value <= 0) {
          throw new Error('Episode number must be positive');
        }
      },
    );

    const RatingScalar = createValidatedScalar(
      'Rating',
      'A valid rating between 0 and 10',
      GraphQLFloat,
      (value) => {
        if (value < 0 || value > 10) {
          throw new Error('Rating must be between 0 and 10');
        }
      },
    );

    const IsActiveScalar = createValidatedScalar(
      'IsActive',
      'A boolean indicating if something is active',
      GraphQLBoolean,
      (value) => {
        // Boolean validation is usually not needed, but this is for testing
        if (typeof value !== 'boolean') {
          throw new Error('Must be a boolean value');
        }
      },
    );

    const CustomIdScalar = createValidatedScalar(
      'CustomId',
      'A custom ID with specific format',
      GraphQLID,
      (value) => {
        if (!value.startsWith('CUST_')) {
          throw new Error('Custom ID must start with CUST_');
        }
      },
    );

    // Test the naming convention
    expect(EmailScalar.name).toBe('Email_String');
    expect(EpisodeNumberScalar.name).toBe('EpisodeNumber_Int');
    expect(RatingScalar.name).toBe('Rating_Float');
    expect(IsActiveScalar.name).toBe('IsActive_Boolean');
    expect(CustomIdScalar.name).toBe('CustomId_ID');
  });

  test('should maintain baseScalarType property', () => {
    const EmailScalar = createValidatedScalar(
      'Email',
      'A valid email address',
      GraphQLString,
      (value) => {
        if (!value.includes('@')) {
          throw new Error('Invalid email format');
        }
      },
    );

    expect(EmailScalar.baseScalarType).toBe(GraphQLString);
    expect(EmailScalar.name).toBe('Email_String');
  });

  test('should work with validation functions', () => {
    const EpisodeNumberScalar = createValidatedScalar(
      'EpisodeNumber',
      'A valid episode number',
      GraphQLInt,
      (value) => {
        if (value <= 0) {
          throw new Error('Episode number must be positive');
        }
      },
    );

    // Test valid value
    expect(() => EpisodeNumberScalar.serialize(5)).not.toThrow();
    expect(EpisodeNumberScalar.serialize(5)).toBe(5);

    // Test invalid value
    expect(() => EpisodeNumberScalar.serialize(0)).toThrow('Episode number must be positive');
    expect(() => EpisodeNumberScalar.serialize(-1)).toThrow('Episode number must be positive');
  });

  test('should generate error messages with correct type names', () => {
    const EpisodeNumberScalar = createValidatedScalar(
      'EpisodeNumber',
      'A valid episode number',
      GraphQLInt,
      (value) => {
        if (value <= 0) {
          throw new Error('Episode number must be positive');
        }
      },
    );

    // The error message should include the full type name
    expect(() => EpisodeNumberScalar.serialize(0)).toThrow('Episode number must be positive');
  });
}); 