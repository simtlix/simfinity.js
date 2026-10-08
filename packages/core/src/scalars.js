import {
  GraphQLString, GraphQLInt, GraphQLFloat,
} from 'graphql';
import { createValidatedScalar } from './scalars/factory.js';
import { isEmailFormat } from './scalars/email.js';
import { compilePattern, matchesPattern } from './scalars/pattern.js';

/**
 * Email scalar - validates email format
 * Type name: Email_String
 */
export const EmailScalar = createValidatedScalar(
  'Email',
  'A valid email address',
  GraphQLString,
  (value) => {
    if (!isEmailFormat(value)) {
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

// A null or omitted bound means no bound (#97). Other values keep JavaScript's comparison, so numeric strings work.
const hasBound = (bound) => bound !== undefined && bound !== null;

// The published description names only the bounds that are set. A NaN bound, which no comparison applies, is left out
// too. With both bounds the text is the same as in earlier versions.
const describeBounds = (min, max, texts) => {
  const described = (bound) => hasBound(bound) && !(typeof bound === 'number' && Number.isNaN(bound));
  if (described(min) && described(max)) return texts.between;
  if (described(min)) return texts.atLeast;
  if (described(max)) return texts.atMost;
  return texts.unbounded;
};

const checkNumberBounds = (min, max) => (value) => {
  if (typeof value !== 'number' || isNaN(value)) {
    throw new Error('Value must be a number');
  }
  if (hasBound(min) && value < min) {
    throw new Error(`Value must be at least ${min}`);
  }
  if (hasBound(max) && value > max) {
    throw new Error(`Value must be at most ${max}`);
  }
};

/**
 * Factory function to create a bounded string scalar
 * @param {string} name - Name for the scalar
 * @param {number|null} [min] - Minimum length; null or undefined means no minimum
 * @param {number|null} [max] - Maximum length; null or undefined means no maximum
 * @returns {GraphQLScalarType} A scalar type with length validation
 */
export const createBoundedStringScalar = (name, min, max) => {
  return createValidatedScalar(
    name,
    describeBounds(min, max, {
      between: `A string with length between ${min} and ${max} characters`,
      atLeast: `A string with at least ${min} characters`,
      atMost: `A string with at most ${max} characters`,
      unbounded: 'A string',
    }),
    GraphQLString,
    (value) => {
      if (typeof value !== 'string') {
        throw new Error('Value must be a string');
      }
      if (hasBound(min) && value.length < min) {
        throw new Error(`String must be at least ${min} characters`);
      }
      if (hasBound(max) && value.length > max) {
        throw new Error(`String must be at most ${max} characters`);
      }
    },
  );
};

/**
 * Factory function to create a bounded integer scalar
 * @param {string} name - Name for the scalar
 * @param {number|null} [min] - Minimum value; null or undefined means no minimum
 * @param {number|null} [max] - Maximum value; null or undefined means no maximum
 * @returns {GraphQLScalarType} A scalar type with range validation
 */
export const createBoundedIntScalar = (name, min, max) => {
  return createValidatedScalar(
    name,
    describeBounds(min, max, {
      between: `An integer between ${min} and ${max}`,
      atLeast: `An integer of at least ${min}`,
      atMost: `An integer of at most ${max}`,
      unbounded: 'An integer',
    }),
    GraphQLInt,
    checkNumberBounds(min, max),
  );
};

/**
 * Factory function to create a bounded float scalar
 * @param {string} name - Name for the scalar
 * @param {number|null} [min] - Minimum value; null or undefined means no minimum
 * @param {number|null} [max] - Maximum value; null or undefined means no maximum
 * @returns {GraphQLScalarType} A scalar type with range validation
 */
export const createBoundedFloatScalar = (name, min, max) => {
  return createValidatedScalar(
    name,
    describeBounds(min, max, {
      between: `A float between ${min} and ${max}`,
      atLeast: `A float of at least ${min}`,
      atMost: `A float of at most ${max}`,
      unbounded: 'A float',
    }),
    GraphQLFloat,
    checkNumberBounds(min, max),
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
  const regex = compilePattern(pattern);
  const errorMessage = message || 'Value does not match required pattern';

  return createValidatedScalar(
    name,
    `A string matching the pattern: ${pattern}`,
    GraphQLString,
    (value) => {
      if (typeof value !== 'string') {
        throw new Error('Value must be a string');
      }
      if (!matchesPattern(regex, value)) {
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
