import { describe, expect, test } from 'vitest';

import {
  attachExecutionState, countNestedEntry, createExecutionState, detachExecutionState, executionStateOf,
  remainingNestedBudget,
} from '../packages/core/src/execution-state.js';

const limits = (maxNestedOperations = null, maxTransactionOperations = 100) => (
  { maxNestedOperations, maxTransactionOperations }
);

const thrown = (callback) => {
  try {
    callback();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('execution state', () => {
  test('starts with no nested entries and keeps the runtime and the limits it was given', () => {
    const runtimeToken = {};
    const state = createExecutionState({ runtimeToken, limits: limits(3, 7) });

    expect(state.nestedCount).toBe(0);
    expect(state.runtimeToken).toBe(runtimeToken);
    expect(state.limits).toEqual({ maxNestedOperations: 3, maxTransactionOperations: 7 });
  });

  test('an attached state is found by its session and gone once detached', () => {
    const runtimeToken = {};
    const session = {};
    const state = createExecutionState({ runtimeToken, limits: limits() });

    expect(executionStateOf(session, runtimeToken)).toBeUndefined();
    attachExecutionState(session, state);
    expect(executionStateOf(session, runtimeToken)).toBe(state);
    detachExecutionState(session, state);
    expect(executionStateOf(session, runtimeToken)).toBeUndefined();
  });

  test('a session lent to another runtime finds no state', () => {
    const runtimeToken = {};
    const session = {};
    attachExecutionState(session, createExecutionState({ runtimeToken, limits: limits() }));

    expect(executionStateOf(session, {})).toBeUndefined();
    expect(executionStateOf(session, runtimeToken)).toBeDefined();
  });

  test('a session that is not an object finds no state', () => {
    const runtimeToken = {};

    expect(executionStateOf(null, runtimeToken)).toBeUndefined();
    expect(executionStateOf(undefined, runtimeToken)).toBeUndefined();
  });

  test('detaching a different state keeps the attached one', () => {
    const runtimeToken = {};
    const session = {};
    const attached = createExecutionState({ runtimeToken, limits: limits() });
    const other = createExecutionState({ runtimeToken, limits: limits() });
    attachExecutionState(session, attached);

    detachExecutionState(session, other);

    expect(executionStateOf(session, runtimeToken)).toBe(attached);
  });

  test('one state may be attached to several sessions, and each detaches by itself', () => {
    const runtimeToken = {};
    const first = {};
    const second = {};
    const state = createExecutionState({ runtimeToken, limits: limits() });
    attachExecutionState(first, state);
    attachExecutionState(second, state);

    detachExecutionState(first, state);

    expect(executionStateOf(first, runtimeToken)).toBeUndefined();
    expect(executionStateOf(second, runtimeToken)).toBe(state);
  });

  test('detaching from a session without a state does nothing', () => {
    const runtimeToken = {};
    const state = createExecutionState({ runtimeToken, limits: limits() });

    expect(() => detachExecutionState({}, state)).not.toThrow();
  });
});

describe('nested entries', () => {
  test('countNestedEntry throws past the limit with today\'s message', () => {
    const state = createExecutionState({ runtimeToken: {}, limits: limits(2) });

    countNestedEntry(state);
    countNestedEntry(state);
    expect(state.nestedCount).toBe(2);
    const error = thrown(() => countNestedEntry(state));

    expect(error).toBeDefined();
    expect(error.getCode()).toBe('NESTED_OPERATIONS_EXCEEDED');
    expect(error.getStatus()).toBe(400);
    expect(error.message).toBe('A mutation may perform at most 2 nested collection operations');
  });

  test('a zero limit rejects the first nested entry', () => {
    const state = createExecutionState({ runtimeToken: {}, limits: limits(0) });

    const error = thrown(() => countNestedEntry(state));

    expect(error.getCode()).toBe('NESTED_OPERATIONS_EXCEEDED');
    expect(error.message).toBe('A mutation may perform at most 0 nested collection operations');
  });

  test('a null limit never throws, and the entries are still counted', () => {
    const state = createExecutionState({ runtimeToken: {}, limits: limits(null) });

    for (let entry = 0; entry < 1000; entry += 1) countNestedEntry(state);

    expect(state.nestedCount).toBe(1000);
  });

  test('remainingNestedBudget counts down to zero and stays there', () => {
    const state = createExecutionState({ runtimeToken: {}, limits: limits(2) });

    expect(remainingNestedBudget(state)).toBe(2);
    countNestedEntry(state);
    expect(remainingNestedBudget(state)).toBe(1);
    countNestedEntry(state);
    expect(remainingNestedBudget(state)).toBe(0);
    expect(thrown(() => countNestedEntry(state))).toBeDefined();
    expect(remainingNestedBudget(state)).toBe(0);
  });

  test('remainingNestedBudget is null without a limit', () => {
    const state = createExecutionState({ runtimeToken: {}, limits: limits(null) });

    expect(remainingNestedBudget(state)).toBeNull();
    countNestedEntry(state);
    expect(remainingNestedBudget(state)).toBeNull();
  });
});
