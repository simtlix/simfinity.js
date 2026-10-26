import SimfinityError from './errors/simfinity.error.js';

// Internal, and never exported from the package. The state of one generated transaction attempt (#151):
// the mutation limits it snapshotted at its start and its joint count of nested collection entries.
// A state is attached to the session of its attempt for as long as the attempt runs, so every nested
// entry that runs on that session counts against the same budget, wherever it started: the
// operations, their middleware, actions and controllers, and the lifecycle helpers and saveObject
// calls those controllers make. Nothing public reads it and it never travels in `context`.
const states = new WeakMap();

const isUnlimited = (limit) => limit === null || limit === undefined;

// runtimeToken is the identity of the runtime that owns the attempt (see createRuntime), so that a
// session lent to another runtime finds no state.
export const createExecutionState = ({ runtimeToken, limits: { maxNestedOperations, maxTransactionOperations } }) => ({
  runtimeToken,
  limits: Object.freeze({ maxNestedOperations, maxTransactionOperations }),
  nestedCount: 0,
});

// The same state may be attached to more than one session: when the adapter's withTransaction hands a
// body another object than the one it was given, the state follows it for the duration of the body.
export const attachExecutionState = (session, state) => {
  states.set(session, state);
};

// Removes only that state: one that replaced it on the session stays attached.
export const detachExecutionState = (session, state) => {
  if (states.get(session) === state) states.delete(session);
};

// WeakMap.get answers undefined for a key that is not an object, so a missing session finds no state.
export const executionStateOf = (session, runtimeToken) => {
  const state = states.get(session);
  return state?.runtimeToken === runtimeToken ? state : undefined;
};

// One call per item that executeItemFunction iterates, before the item runs.
export const countNestedEntry = (state) => {
  state.nestedCount += 1;
  const limit = state.limits.maxNestedOperations;
  if (!isUnlimited(limit) && state.nestedCount > limit) {
    throw new SimfinityError(`A mutation may perform at most ${limit} nested collection operations`,
      'NESTED_OPERATIONS_EXCEEDED', 400);
  }
};

// The nested entries the attempt may still run, or null when it has no limit.
export const remainingNestedBudget = (state) => {
  const limit = state.limits.maxNestedOperations;
  return isUnlimited(limit) ? null : Math.max(0, limit - state.nestedCount);
};
