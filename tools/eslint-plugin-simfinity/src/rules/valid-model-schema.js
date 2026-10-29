import { makeModelRule } from '../model-rule.js';
import { messages, inspect } from '../model-schema.js';

export default makeModelRule('valid-model-schema', 'Validate registered targets, generated inputs and runtime type ownership', messages, inspect, 'errors');
