import { startStdioMCPServer } from '@simtlix/simfinity-mcp';
import { schema, authPlugin, initializeApplication } from '../application.js';
import { closeDatabase } from '../database.js';
import { buildUserContext } from '../auth/context.js';

await initializeApplication();
const server = await startStdioMCPServer(schema, {
  serverName: 'simfinity-barber-mcp',
  serverVersion: '1.0.0',
  // Scalar results avoid automatically selecting related private user profiles.
  selectionDepth: 0,
  context: () => buildUserContext(process.env.MCP_BEARER ? `Bearer ${process.env.MCP_BEARER}` : null),
  schemaPlugins: [authPlugin],
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await server.close();
    await closeDatabase();
    process.exit(0);
  });
}
