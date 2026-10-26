import { nestedOperationsExceededError } from './mutation-limits.js';

// Internal, and never exported from the package. The state of one generated transaction attempt (#151):
// the mutation limits it snapshotted at its start and its joint count of nested collection entries.
// A state is attached to the session of its attempt for as long as the attempt runs, so every nested
// entry that runs on that session counts against the same budget, wherever it started: the
// operations, their middleware, actions and controllers, and the lifecycle helpers and saveObject
// calls those controllers make. Nothing public reads it and it never travels in `context`.
//
// session -> the attachments it holds, oldest first, as `{ state, holds }`. The latest one is the
// session's state. Attaching the latest state again adds a hold instead of an entry, and a detach
// releases one hold, so an attachment lasts until the last caller that made it detaches, and the
// state it replaced is the session's state again once it is gone.
const attachments = new WeakMap();

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
  let held = attachments.get(session);
  if (held === undefined) {
    held = [];
    attachments.set(session, held);
  }
  const latest = held[held.length - 1];
  if (latest?.state === state) latest.holds += 1;
  else held.push({ state, holds: 1 });
};

// Releases one hold of the latest attachment of that state; a session without it is left as it is.
export const detachExecutionState = (session, state) => {
  const held = attachments.get(session);
  if (held === undefined) return;
  for (let index = held.length - 1; index >= 0; index -= 1) {
    if (held[index].state === state) {
      held[index].holds -= 1;
      if (held[index].holds === 0) held.splice(index, 1);
      break;
    }
  }
  if (held.length === 0) attachments.delete(session);
};

// WeakMap.get answers undefined for a key that is not an object, so a missing session finds no state.
export const executionStateOf = (session, runtimeToken) => {
  const held = attachments.get(session);
  const state = held?.[held.length - 1].state;
  return state?.runtimeToken === runtimeToken ? state : undefined;
};

// One call per item that executeItemFunction iterates, before the item runs.
export const countNestedEntry = (state) => {
  state.nestedCount += 1;
  const limit = state.limits.maxNestedOperations;
  if (!isUnlimited(limit) && state.nestedCount > limit) throw nestedOperationsExceededError(limit);
};

// The nested entries the attempt may still run, or null when it has no limit.
export const remainingNestedBudget = (state) => {
  const limit = state.limits.maxNestedOperations;
  return isUnlimited(limit) ? null : Math.max(0, limit - state.nestedCount);
};
