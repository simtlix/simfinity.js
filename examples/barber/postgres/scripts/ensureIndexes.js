import { initializeApplication } from '../application.js';
import { closeDatabase } from '../database.js';
try {
  await initializeApplication();
  console.log('PostgreSQL schema, foreign keys and indexes ready.');
} finally {
  await closeDatabase();
}
