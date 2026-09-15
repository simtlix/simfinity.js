import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import pg from 'pg';

const databaseSchema = `dataset_${randomUUID().replaceAll('-', '')}`;
const env = { ...process.env, DATABASE_SCHEMA: databaseSchema, PORT: '4302', GRAPHQL_ENDPOINT: 'http://127.0.0.1:4302/graphql', GRAPHQL_RATE_LIMIT_MAX: '5000' };
const run = (file) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [file], { env, cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.on('exit', (code) => code ? reject(new Error(output)) : resolve(output));
});
const pool = new pg.Pool({ connectionString: env.DATABASE_URL || 'postgres://barber:barber_local@localhost:55441/barber' });
let server;
try {
  await run('scripts/seedAdmin.js');
  server = spawn(process.execPath, ['index.yoga.js'], { env, cwd: new URL('..', import.meta.url), stdio: 'ignore' });
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch('http://127.0.0.1:4302/health').catch(() => null);
    if (response?.ok) break;
    if (attempt === 99) throw new Error('Dataset server did not start');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const loaded = await run('dataset/loadDataset.js');
  console.log(loaded);
  assert.doesNotMatch(loaded, /FAILED| err:|failed|Skip:|Approve:|Submit:/);
  const before = await pool.query(`SELECT count(*)::int AS count FROM ${pg.escapeIdentifier(databaseSchema)}.barbershop`);
  assert.ok(before.rows[0].count > 0);
  console.log(await run('dataset/deleteDataset.js'));
  const after = await pool.query(`SELECT count(*)::int AS count FROM ${pg.escapeIdentifier(databaseSchema)}.barbershop`);
  assert.equal(after.rows[0].count, 0);
  console.log('Dataset GraphQL load and FK-ordered deletion passed in a private schema.');
} finally {
  if (server) { server.kill('SIGTERM'); await new Promise((resolve) => server.once('exit', resolve)); }
  await pool.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(databaseSchema)} CASCADE`);
  await pool.end();
}
