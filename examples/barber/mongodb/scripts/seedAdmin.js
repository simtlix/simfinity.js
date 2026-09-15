import bcrypt from 'bcrypt';
import * as simfinity from '@simtlix/simfinity-js';
import { initializeApplication } from '../application.js';
import { closeDatabase } from '../database.js';

try {
  await initializeApplication();
  const model = simfinity.getModel(simfinity.getType('user'));
  const email = (process.env.SEED_ADMIN_EMAIL || 'admin@demo.com').toLowerCase();
  const existing = await model.findOne({ email });
  if (existing) {
    existing.role = 'PLATFORM_ADMIN';
    existing.status = 'ACTIVE';
    await existing.save();
  } else {
    await model.create({
      email, name: 'Platform Admin', role: 'PLATFORM_ADMIN', status: 'ACTIVE', emailVerified: true,
      passwordHash: await bcrypt.hash(process.env.SEED_ADMIN_PASSWORD || 'demo1234', 12),
    });
  }
  console.log(`Admin ready: ${email}`);
} finally {
  await closeDatabase();
}
