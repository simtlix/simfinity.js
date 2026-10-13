import bcrypt from 'bcrypt';
import * as simfinity from '@simtlix/simfinity-postgres';
import { initializeApplication } from '../application.js';
import { closeDatabase } from '../database.js';

// Creates the platform admin, or reactivates it when it already is one; an existing admin keeps its
// password. It never promotes another account: anyone can register an email through the public API,
// so promoting an existing CLIENT or OWNER would hand admin rights to whoever chose its password and
// holds its sessions.
try {
  await initializeApplication();
  const model = simfinity.getModel(simfinity.getType('user'));
  const email = (process.env.SEED_ADMIN_EMAIL || 'admin@demo.com').toLowerCase();
  const existing = (await model.find({ email: { operator: 'EQ', value: email } }))[0];
  if (!existing) {
    await model.create({ email, name: 'Platform Admin', role: 'PLATFORM_ADMIN', status: 'ACTIVE', emailVerified: true,
      passwordHash: await bcrypt.hash(process.env.SEED_ADMIN_PASSWORD || 'demo1234', 12) });
    console.log(`Admin created: ${email}`);
  } else if (existing.role === 'PLATFORM_ADMIN') {
    await model.update(existing.id, { status: 'ACTIVE' });
    console.log(`Admin ready: ${email} (existing admin; password unchanged)`);
  } else {
    const role = existing.role || 'CLIENT';
    console.error(`seed:admin: ${email} already belongs to ${/^[AEIOU]/.test(role) ? 'an' : 'a'} ${role} account; `
      + 'refusing to promote it. Reset the example database '
      + '(docker compose -f compose.postgres.yaml down --volumes) and run seed:admin again.');
    process.exitCode = 1;
  }
} finally {
  await closeDatabase();
}
