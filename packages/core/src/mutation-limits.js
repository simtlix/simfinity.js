import SimfinityError from './errors/simfinity.error.js';

// Process-wide, like the query limits. null leaves nested collection operations unlimited.
let maxNestedOperations = null;

export const configureMutationLimits = (options = {}) => {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) {
    throw new SimfinityError('Mutation limit options must be a plain object', 'INVALID_MUTATION_LIMITS', 400);
  }
  // A misspelled option must not silently reset the limit to unlimited.
  const unknown = Reflect.ownKeys(options).find((key) => key !== 'maxNestedOperations');
  if (unknown !== undefined) {
    throw new SimfinityError(`Unknown mutation limit option ${String(unknown)}; use maxNestedOperations`,
      'INVALID_MUTATION_LIMITS', 400);
  }
  const { maxNestedOperations: value = null } = options;
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new SimfinityError('maxNestedOperations must be null or a non-negative safe integer', 'INVALID_MUTATION_LIMITS', 400);
  }
  maxNestedOperations = value;
};

export const getMaxNestedOperations = () => maxNestedOperations;
