import { mkdir, writeFile } from 'node:fs/promises';
import { printSchema } from 'graphql';
import pg from 'pg';
import * as simfinity from '@simtlix/simfinity-postgres';
import { schema, initializeApplication } from '../application.js';
import { closeDatabase, pool, databaseSchema } from '../database.js';

const output = new URL('../generated/', import.meta.url);
try {
  await initializeApplication();
  await mkdir(output, { recursive: true });
  await writeFile(new URL('postgres.graphql', output), `${printSchema(schema)}\n`);
  const statements = simfinity.compileDatabaseSchema(
    simfinity.describeDatabase(simfinity.getRegistrations(), { schema: databaseSchema }),
  );
  statements.push(`CREATE INDEX IF NOT EXISTS barbershop_state_city ON ${pg.escapeIdentifier(databaseSchema)}.barbershop (state, (address->>'city'))`);
  await writeFile(new URL('postgres.sql', output), `${statements.join(';\n')};\n`);
  const constraints = await pool.query(
    `SELECT c.conrelid::regclass::text AS table_name, c.conname,
      pg_get_constraintdef(c.oid) AS definition
     FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
     WHERE n.nspname=$1 AND c.contype='f' ORDER BY 1,2`,
    [databaseSchema],
  );
  await writeFile(new URL('foreign-keys.json', output), `${JSON.stringify(constraints.rows, null, 2)}\n`);
  console.log(`Exported GraphQL, SQL and ${constraints.rows.length} foreign keys to generated/`);
} finally {
  await closeDatabase();
}
