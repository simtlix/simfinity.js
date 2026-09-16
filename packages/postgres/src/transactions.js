import { createTransactions as createSQLTransactions } from '@simtlix/simfinity-sql/internal/transactions';
import { postgresPlugin } from './plugin.js';

export const createTransactions = (getPool, assertReady) => createSQLTransactions(() => ({ pool: getPool() }), assertReady, postgresPlugin());
