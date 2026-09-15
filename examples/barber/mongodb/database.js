import 'dotenv/config';
import mongoose from 'mongoose';

export const initializeDatabase = () => mongoose.connect(
  process.env.MONGO || 'mongodb://127.0.0.1:57417/barber?replicaSet=rs0&directConnection=true',
);
export const closeDatabase = () => mongoose.disconnect();
