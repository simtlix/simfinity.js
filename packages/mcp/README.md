# @simtlix/simfinity-mcp

Database-independent MCP tool generation and transports for Simfinity GraphQL schemas. It requires GraphQL 16 and Node.js 18.18 or later.

Version 3.2.0 is released together with the other Simfinity packages. Install from npm and keep their versions aligned. Source: [simtlix/simfinity.js](https://github.com/simtlix/simfinity.js).

Tool generation and execution use only GraphQL:

```javascript
import { generateMCPTools } from '@simtlix/simfinity-mcp';

const { tools, callTool } = generateMCPTools(schema);
const result = await callTool(tools[0].name, {});
```

Install the optional MCP SDK when constructing a server or transport:

```sh
npm install @simtlix/simfinity-mcp@3.2.0 @modelcontextprotocol/sdk@^1.13.0
```

```javascript
import { createMCPServer } from '@simtlix/simfinity-mcp';

const server = await createMCPServer(schema);
// Connect an SDK transport, then close the server during application shutdown.
await server.close();
```

The package works with schemas produced by either `@simtlix/simfinity-js` or `@simtlix/simfinity-postgres`. `generateMCPTools` needs no SDK. Server and transport constructors report `MCP_SDK_NOT_INSTALLED` when the optional SDK is unavailable.
