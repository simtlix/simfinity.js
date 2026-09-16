import { createSQLAdapter } from '@simtlix/simfinity-sql/internal/adapter';
import { postgresPlugin } from './plugin.js';

export const createPostgresAdapter = (options) => createSQLAdapter(postgresPlugin(options));
