import { pool, databaseSchema } from './database.js';
import pg from 'pg';
import './types/index.js';
import * as simfinity from '@simtlix/simfinity-postgres';
import { permissions } from './auth/permissions.js';

export const schema = simfinity.createSchema();
export const authPlugin = simfinity.auth.createAuthPlugin(permissions, { defaultPolicy: 'ALLOW' });
export const initializeApplication = async () => {
  await simfinity.initializeDatabase({ mode: 'create' });
  await pool.query(`CREATE INDEX IF NOT EXISTS barbershop_state_city ON ${pg.escapeIdentifier(databaseSchema)}.barbershop (state, (address->>'city'))`);
};
