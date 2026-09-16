import { createRecordStore as createSQLRecordStore } from '@simtlix/simfinity-sql/internal/records';
import { postgresPlugin } from './plugin.js';

export const createRecordStore = (models, database, query) => createSQLRecordStore(models, database, (statement, session) => query(statement.text, statement.values, session), postgresPlugin());
