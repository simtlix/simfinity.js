import { inspect, messages } from '../model-fields.js';
import { makeModelRule } from '../model-rule.js';

export default makeModelRule('valid-model-fields', 'Validate Simfinity field inputs and backend storage mappings', messages, inspect);
