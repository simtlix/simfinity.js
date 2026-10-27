import { __Field } from 'graphql';
import SimfinityError from './errors/simfinity.error.js';
import { introspectionState } from './introspection-state.js';

/** Configure before importing the runtime or either database facade. Never removes an extension. */
export const configureIntrospection = (options) => {
  if (!options || ![Object.prototype, null].includes(Object.getPrototypeOf(options))
    || Reflect.ownKeys(options).length !== 1 || options.fieldExtensions !== false) {
    throw new SimfinityError('configureIntrospection requires only { fieldExtensions: false }',
      'INVALID_INTROSPECTION_CONFIGURATION', 500);
  }
  if (__Field.getFields().extensions) {
    throw new SimfinityError('Configure fieldExtensions before importing the Simfinity runtime; __Field.extensions is already installed',
      'INVALID_INTROSPECTION_CONFIGURATION', 500);
  }
  introspectionState().disabled = true;
};
