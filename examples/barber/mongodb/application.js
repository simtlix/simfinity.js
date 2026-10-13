import mongoose from 'mongoose';
import * as simfinity from '@simtlix/simfinity-js';
import { initializeDatabase } from './database.js';
import './types/index.js';
import { permissions } from './auth/permissions.js';
import { AUTH_OPERATIONS } from './auth/authOperations.js';

export const schema = simfinity.createSchema();
export const authPlugin = simfinity.auth.createAuthPlugin(permissions, { defaultPolicy: 'ALLOW' });

// MCP options every entry point shares: HTTP /mcp (index.yoga.js), mcp:stdio (scripts/mcp-stdio.js) and
// the integration tests. Each adds only its own `context`.
export const mcpOptions = Object.freeze({
  serverName: 'simfinity-barber-mcp',
  serverVersion: '1.0.0',
  // Scalar results avoid automatically selecting related private user profiles.
  selectionDepth: 0,
  // MCP callers send the access token of a GraphQL login; the password and token mutations are not
  // published as tools, so every password check goes through GraphQL and its limits.
  exclude: [...AUTH_OPERATIONS],
  // The SAME auth plugin instance as Yoga, so tool calls enforce the permission rules. createAuthPlugin
  // wraps the schema's resolvers from its onSchemaChange hook (which Envelop fires for Yoga);
  // schemaPlugins fires it for the in-process MCP execution path too. Sharing the instance means the
  // shared schema is wrapped exactly once (the plugin wraps each field once).
  schemaPlugins: [authPlugin],
});
export const initializeApplication = async () => {
  await initializeDatabase();
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  const model = (name) => simfinity.getModel(simfinity.getType(name));
  await model('barbershop').collection.createIndex({ state: 1, 'address.city': 1 });
  await model('booking').collection.createIndex({ barbershop: 1, scheduledDate: 1 });
  await model('favorite').collection.createIndex({ user: 1, barbershop: 1 }, { unique: true });
};
