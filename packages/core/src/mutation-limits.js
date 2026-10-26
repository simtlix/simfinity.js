import SimfinityError from './errors/simfinity.error.js';

const OPTION_KEYS = ['maxNestedOperations', 'maxTransactionOperations'];
const DEFAULT_MAX_TRANSACTION_OPERATIONS = 100;

// Process-wide, like the query limits. null leaves nested collection operations unlimited.
let maxNestedOperations = null;
let maxTransactionOperations = DEFAULT_MAX_TRANSACTION_OPERATIONS;

// Each call replaces both values: an omitted or undefined option restores its default.
export const configureMutationLimits = (options = {}) => {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) {
    throw new SimfinityError('Mutation limit options must be a plain object', 'INVALID_MUTATION_LIMITS', 400);
  }
  // A misspelled option must not silently reset a limit to its default.
  const unknown = Reflect.ownKeys(options).find((key) => !OPTION_KEYS.includes(key));
  if (unknown !== undefined) {
    throw new SimfinityError(
      `Unknown mutation limit option ${String(unknown)}; use maxNestedOperations or maxTransactionOperations`,
      'INVALID_MUTATION_LIMITS',
      400,
    );
  }
  const {
    maxNestedOperations: nested = null,
    maxTransactionOperations: transaction = DEFAULT_MAX_TRANSACTION_OPERATIONS,
  } = options;
  if (nested !== null && (!Number.isSafeInteger(nested) || nested < 0)) {
    throw new SimfinityError('maxNestedOperations must be null or a non-negative safe integer', 'INVALID_MUTATION_LIMITS', 400);
  }
  if (!Number.isSafeInteger(transaction) || transaction < 1) {
    throw new SimfinityError('maxTransactionOperations must be a positive safe integer', 'INVALID_MUTATION_LIMITS', 400);
  }
  // Validate everything first: a rejected call keeps both current limits.
  maxNestedOperations = nested;
  maxTransactionOperations = transaction;
};

export const getMaxNestedOperations = () => maxNestedOperations;

export const getMaxTransactionOperations = () => maxTransactionOperations;

// Internal, like the getters: the package exports only configureMutationLimits. The error of a mutation
// past maxNestedOperations, which the preflights and a transaction attempt's counter (execution-state.js)
// raise alike.
export const nestedOperationsExceededError = (limit) => new SimfinityError(
  `A mutation may perform at most ${limit} nested collection operations`, 'NESTED_OPERATIONS_EXCEEDED', 400,
);

// The error of a generated transaction (#151) whose list is longer than maxTransactionOperations.
export const transactionOperationsExceededError = (limit) => new SimfinityError(
  `A transaction may run at most ${limit} operations`, 'TRANSACTION_OPERATIONS_EXCEEDED', 400,
);
