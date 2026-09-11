import mongoose from 'mongoose';
import * as simfinity from '@simtlix/simfinity-js';
import { schema } from './schema.js';

try {
  const { tools, callTool } = simfinity.generateMCPTools(schema, {
    include: ['series'],
    limits: { maxPageSize: 100, defaultPagination: { page: 1, size: 10 } },
  });
  console.log('Generated tools:', tools.map(tool => tool.name));
  const result = await callTool('series', {
    name: { operator: 'LIKE', value: 'Expanse' },
    pagination: { page: 1, size: 10 },
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await mongoose.disconnect();
}
