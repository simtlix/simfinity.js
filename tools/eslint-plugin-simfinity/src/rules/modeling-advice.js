import { inspect as fields, messages as fieldMessages } from '../model-fields.js';
import { inspect as storage, messages as storageMessages } from '../model-storage.js';
import { inspect as schema, messages as schemaMessages } from '../model-schema.js';
import { makeModelRule } from '../model-rule.js';

const inspect = graph => ({
  warnings: [fields, storage, schema].flatMap(inspector => inspector(graph).warnings),
});

export default makeModelRule('modeling-advice', 'Review accepted modeling choices and omitted generated inputs',
  { ...fieldMessages, ...storageMessages, ...schemaMessages }, inspect, 'warnings');
