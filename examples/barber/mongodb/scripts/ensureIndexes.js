import { initializeApplication } from '../application.js';
import { closeDatabase } from '../database.js';

try {
  await initializeApplication();
  console.log('Generated collections and indexes ready');
} finally {
  await closeDatabase();
}
