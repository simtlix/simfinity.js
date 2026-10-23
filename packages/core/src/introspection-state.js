import { __Field } from 'graphql';

// Shared only by cooperating core evaluations using the same GraphQL peer. No schema/type mutation.
const KEY = Symbol.for('simfinity.introspectionConfiguration.v1');
const states = globalThis[KEY] || new WeakMap();
if (!globalThis[KEY]) Object.defineProperty(globalThis, KEY, { value: states });
export const introspectionState = () => {
  if (!states.has(__Field)) states.set(__Field, { disabled: false });
  return states.get(__Field);
};
