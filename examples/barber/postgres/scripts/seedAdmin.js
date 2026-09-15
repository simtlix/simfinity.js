import bcrypt from 'bcrypt';
import * as simfinity from '@simtlix/simfinity-postgres';
import { initializeApplication } from '../application.js';
import { closeDatabase } from '../database.js';

try {
  await initializeApplication();
  const model = simfinity.getModel(simfinity.getType('user'));
  const email = (process.env.SEED_ADMIN_EMAIL || 'admin@demo.com').toLowerCase();
  const existing = (await model.find({ email: { operator: 'EQ', value: email } }))[0];
  if (existing) {
    await model.update(existing.id, { role: 'PLATFORM_ADMIN', status: 'ACTIVE' });
  } else {
    await model.create({ email, name: 'Platform Admin', role: 'PLATFORM_ADMIN', status: 'ACTIVE', emailVerified: true,
      passwordHash: await bcrypt.hash(process.env.SEED_ADMIN_PASSWORD || 'demo1234', 12) });
  }
  console.log(`Admin ready: ${email}`);
} finally {
  await closeDatabase();
}
