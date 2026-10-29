import { makeModelRule } from '../model-rule.js';
import { inspect, messages } from '../model-storage.js';

export default makeModelRule('valid-model-storage', 'Validate Simfinity relation and backend storage contracts', messages, inspect, 'errors');
