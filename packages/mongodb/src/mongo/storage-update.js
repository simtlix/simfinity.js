import { invalidStorage } from './storage-validation.js';

const isOperator = ([key]) => key.startsWith('$');
const isAssignment = (entry) => !isOperator(entry);

const splitUpdate = (update) => {
  const entries = Object.entries(update);
  return {
    assignments: Object.fromEntries(entries.filter(isAssignment)),
    operators: Object.fromEntries(entries.filter(isOperator)),
  };
};

const assertIndependentIncrements = (increments, assignments, operators) => {
  const changes = [assignments, ...Object.values(operators)];
  const overlaps = Object.keys(increments).some((key) =>
    changes.some((fields) => Object.hasOwn(fields, key)),
  );
  if (overlaps) {
    throw invalidStorage('Increment overlaps a generated update field');
  }
};

const withAssignments = (operators, assignments) => {
  if (Object.keys(assignments).length === 0) return operators;
  return { ...operators, $set: assignments };
};

export const prepareStorageUpdate = (update, storage) => {
  if (!storage?.increments) return update;
  const { assignments, operators } = splitUpdate(update);
  assertIndependentIncrements(storage.increments, assignments, operators);
  return { ...withAssignments(operators, assignments), $inc: storage.increments };
};
