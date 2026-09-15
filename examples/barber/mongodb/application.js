import mongoose from 'mongoose';
import * as simfinity from '@simtlix/simfinity-js';
import { initializeDatabase } from './database.js';
import './types/index.js';
import { permissions } from './auth/permissions.js';

export const schema = simfinity.createSchema();
export const authPlugin = simfinity.auth.createAuthPlugin(permissions, { defaultPolicy: 'ALLOW' });
export const initializeApplication = async () => {
  await initializeDatabase();
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  const model = (name) => simfinity.getModel(simfinity.getType(name));
  await model('barbershop').collection.createIndex({ state: 1, 'address.city': 1 });
  await model('booking').collection.createIndex({ barbershop: 1, scheduledDate: 1 });
  await model('favorite').collection.createIndex({ user: 1, barbershop: 1 }, { unique: true });
};
