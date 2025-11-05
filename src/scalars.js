import {
  GraphQLString, GraphQLInt, GraphQLFloat,
} from 'graphql';
import { createValidatedScalar } from './index.js';

/**
 * Email scalar - validates email format
 * Type name: Email_String
 */
export const EmailScalar = createValidatedScalar(
  'Email',
  'A valid email address',
  GraphQLString,
  (value) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(value)) {
      throw new Error('Invalid email format');
    }
  },
);

/**
 * URL scalar - validates URL format
 * Type name: URL_String
 */
export const URLScalar = createValidatedScalar(
  'URL',
  'A valid URL',
  GraphQLString,
  (value) => {
    try {
      new URL(value);
    } catch {
      throw new Error('Invalid URL format');
    }
  },
);

/**
 * PositiveInt scalar - validates positive integers
 * Type name: PositiveInt_Int
 */
export const PositiveIntScalar = createValidatedScalar(
  'PositiveInt',
  'A positive integer',
  GraphQLInt,
  (value) => {
    if (value <= 0) {
      throw new Error('Value must be positive');
    }
  },
);

/**
 * PositiveFloat scalar - validates positive floats
 * Type name: PositiveFloat_Float
 */
export const PositiveFloatScalar = createValidatedScalar(
  'PositiveFloat',
  'A positive float',
  GraphQLFloat,
  (value) => {
    if (value <= 0) {
      throw new Error('Value must be positive');
    }
  },
);

/**
 * Factory function to create a bounded string scalar
 * @param {string} name - Name for the scalar
 * @param {number} min - Minimum length
 * @param {number} max - Maximum length
 * @returns {GraphQLScalarType} A scalar type with length validation
 */
export const createBoundedStringScalar = (name, min, max) => {
  return createValidatedScalar(
    name,
    `A string with length between ${min} and ${max} characters`,
    GraphQLString,
    (value) => {
      if (typeof value !== 'string') {
        throw new Error('Value must be a string');
      }
      if (min !== undefined && value.length < min) {
        throw new Error(`String must be at least ${min} characters`);
      }
      if (max !== undefined && value.length > max) {
        throw new Error(`String must be at most ${max} characters`);
      }
    },
  );
};

/**
 * Factory function to create a bounded integer scalar
 * @param {string} name - Name for the scalar
 * @param {number} min - Minimum value
 * @param {number} max - Maximum value
 * @returns {GraphQLScalarType} A scalar type with range validation
 */
export const createBoundedIntScalar = (name, min, max) => {
  return createValidatedScalar(
    name,
    `An integer between ${min} and ${max}`,
    GraphQLInt,
    (value) => {
      if (typeof value !== 'number' || isNaN(value)) {
        throw new Error('Value must be a number');
      }
      if (min !== undefined && value < min) {
        throw new Error(`Value must be at least ${min}`);
      }
      if (max !== undefined && value > max) {
        throw new Error(`Value must be at most ${max}`);
      }
    },
  );
};

/**
 * Factory function to create a bounded float scalar
 * @param {string} name - Name for the scalar
 * @param {number} min - Minimum value
 * @param {number} max - Maximum value
 * @returns {GraphQLScalarType} A scalar type with range validation
 */
export const createBoundedFloatScalar = (name, min, max) => {
  return createValidatedScalar(
    name,
    `A float between ${min} and ${max}`,
    GraphQLFloat,
    (value) => {
      if (typeof value !== 'number' || isNaN(value)) {
        throw new Error('Value must be a number');
      }
      if (min !== undefined && value < min) {
        throw new Error(`Value must be at least ${min}`);
      }
      if (max !== undefined && value > max) {
        throw new Error(`Value must be at most ${max}`);
      }
    },
  );
};

/**
 * Factory function to create a regex pattern string scalar
 * @param {string} name - Name for the scalar
 * @param {RegExp|string} pattern - Regex pattern to validate against
 * @param {string} message - Error message if validation fails
 * @returns {GraphQLScalarType} A scalar type with pattern validation
 */
export const createPatternStringScalar = (name, pattern, message) => {
  const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
  const errorMessage = message || 'Value does not match required pattern';

  return createValidatedScalar(
    name,
    `A string matching the pattern: ${pattern}`,
    GraphQLString,
    (value) => {
      if (typeof value !== 'string') {
        throw new Error('Value must be a string');
      }
      if (!regex.test(value)) {
        throw new Error(errorMessage);
      }
    },
  );
};

// Export all scalars as an object for convenience
const scalars = {
  // Pre-built scalars
  EmailScalar,
  URLScalar,
  PositiveIntScalar,
  PositiveFloatScalar,
  // Factory functions
  createBoundedStringScalar,
  createBoundedIntScalar,
  createBoundedFloatScalar,
  createPatternStringScalar,
};

export default scalars;

