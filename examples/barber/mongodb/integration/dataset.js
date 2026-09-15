import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import mongoose from 'mongoose';

const databaseName = `barber_dataset_${randomUUID().replaceAll('-', '')}`;
const uri = new URL(process.env.MONGO || 'mongodb://127.0.0.1:57417/barber?replicaSet=rs0&directConnection=true');
uri.pathname = `/${databaseName}`;
const port = process.env.DATASET_PORT || '4402';
const endpoint = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  MONGO: uri.toString(),
  PORT: port,
  GRAPHQL_ENDPOINT: `${endpoint}/graphql`,
  GRAPHQL_RATE_LIMIT_MAX: '5000',
  SEED_ADMIN_EMAIL: 'admin@demo.com',
  SEED_ADMIN_PASSWORD: 'demo1234',
  ADMIN_EMAIL: 'admin@demo.com',
  ADMIN_PASSWORD: 'demo1234',
};
const cwd = new URL('..', import.meta.url);
const run = (file) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [file], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.once('error', reject);
  child.once('close', (code) => code === 0 ? resolve(output) : reject(new Error(`${file} failed: ${output}`)));
});
const database = await mongoose.createConnection(uri.toString()).asPromise();
let server;
let serverOutput = '';

try {
  await run('scripts/seedAdmin.js');
  server = spawn(process.execPath, ['index.yoga.js'], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let startupError;
  server.once('error', (error) => { startupError = error; });
  server.stdout.on('data', (chunk) => { serverOutput += chunk; });
  server.stderr.on('data', (chunk) => { serverOutput += chunk; });
  for (let attempt = 0; ; attempt++) {
    if (startupError) throw startupError;
    if (server.exitCode !== null || server.signalCode !== null) throw new Error(`Dataset server exited: ${serverOutput}`);
    // Only trust health after this child confirms it bound the test port.
    if (serverOutput.includes(`GraphQL endpoint: http://localhost:${port}/graphql`)) {
      const response = await fetch(`${endpoint}/health`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).database, 'mongodb');
      break;
    }
    if (attempt === 99) throw new Error(`Dataset server did not start: ${serverOutput}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const loaded = await run('dataset/loadDataset.js');
  assert.doesNotMatch(loaded, /FAILED| err:|failed|Skip:|Approve:|Submit:/);
  const counts = { user: 6, barbershop: 3, serviceCategory: 8, service: 13, professional: 6, bundle: 4, booking: 4, review: 4, favorite: 4 };
  for (const [name, count] of Object.entries(counts)) {
    assert.equal(await database.collection(name).countDocuments(), count, `${name} dataset count`);
  }
  const shops = await database.collection('barbershop').find().sort({ slug: 1 }).toArray();
  assert.deepEqual(shops.map(({ slug, state, averageRating, reviewCount }) => ({ slug, state, averageRating, reviewCount })), [
    { slug: 'barba-roja', state: 'APPROVED', averageRating: 4, reviewCount: 1 },
    { slug: 'heritage-club', state: 'APPROVED', averageRating: 4.5, reviewCount: 2 },
    { slug: 'noble-groomer', state: 'APPROVED', averageRating: 5, reviewCount: 1 },
  ]);
  assert.equal(await database.collection('booking').countDocuments({ totalPrice: { $gt: 0 }, endTime: { $type: 'string' } }), 4);
  assert.equal(await database.collection('bundle').countDocuments({ totalDurationMinutes: { $gt: 0 } }), 4);
  console.log('Dataset GraphQL load passed: 3 shops, 13 services, 4 bundles, 4 bookings and 4 reviews with correct ratings.');

  const deleted = await run('dataset/deleteDataset.js');
  assert.doesNotMatch(deleted, /Error|failed/i);
  for (const name of [...Object.keys(counts).filter((name) => name !== 'user'), 'notification']) {
    assert.equal(await database.collection(name).countDocuments(), 0, `${name} remains after deletion`);
  }
  assert.equal(await database.collection('user').countDocuments(), 6);
  console.log('Dataset GraphQL deletion removed all covered records and retained users.');
} finally {
  try {
    if (server?.pid && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');
      server.kill('SIGTERM');
      const timeout = setTimeout(() => server.kill('SIGKILL'), 5000);
      timeout.unref();
      try { await exited; } finally { clearTimeout(timeout); }
    }
  } finally {
    try {
      assert.equal(database.name, databaseName);
      await database.dropDatabase();
    } finally {
      await database.close();
    }
  }
}
