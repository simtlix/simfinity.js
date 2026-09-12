# @simtlix/simfinity-mcp

Database-independent MCP tool generation and transports for Simfinity GraphQL schemas. It requires GraphQL 16 and Node.js 18.18 or later.

Tool generation and execution use only GraphQL:

```javascript
import { generateMCPTools } from '@simtlix/simfinity-mcp';

const { tools, callTool } = generateMCPTools(schema);
const result = await callTool(tools[0].name, {});
```

Install the optional MCP SDK when constructing a server or transport:

```sh
npm install @simtlix/simfinity-mcp @modelcontextprotocol/sdk
```

```javascript
import { createMCPServer } from '@simtlix/simfinity-mcp';

const server = await createMCPServer(schema);
// Connect an SDK transport, then close the server during application shutdown.
await server.close();
```

The package works with schemas produced by either `@simtlix/simfinity-js` or `@simtlix/simfinity-postgres`. Server constructors report `MCP_SDK_NOT_INSTALLED` when the optional SDK is unavailable.
