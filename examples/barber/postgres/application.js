import { pool, databaseSchema } from './database.js';
import pg from 'pg';
import './types/index.js';
import * as simfinity from '@simtlix/simfinity-postgres';
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
  await simfinity.initializeDatabase({ mode: 'create' });
  await pool.query(`CREATE INDEX IF NOT EXISTS barbershop_state_city ON ${pg.escapeIdentifier(databaseSchema)}.barbershop (state, (address->>'city'))`);
};
