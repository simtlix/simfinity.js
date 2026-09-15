import 'dotenv/config';
import pg from 'pg';
import * as simfinity from '@simtlix/simfinity-postgres';

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://barber:barber_local@localhost:55441/barber',
});
export const databaseSchema = process.env.DATABASE_SCHEMA || 'barber';
simfinity.configure({ pool, schema: databaseSchema });
export const closeDatabase = () => pool.end();
