# @simtlix/simfinity-mcp

Database-independent MCP tool generation and transports for Simfinity GraphQL schemas. It requires GraphQL 16 and Node.js 18.18 or later.

All Simfinity packages are released together. Install from npm and keep their versions aligned. Source: [simtlix/simfinity.js](https://github.com/simtlix/simfinity.js).

Tool generation and execution use only GraphQL:

```javascript
import { generateMCPTools } from '@simtlix/simfinity-mcp';

const { tools, callTool } = generateMCPTools(schema);
const result = await callTool(tools[0].name, {});
```

Install the optional MCP SDK when constructing a server or transport:

```sh
npm install @simtlix/simfinity-mcp@3.7.0 @modelcontextprotocol/sdk@^1.31.0
```

```javascript
import { createMCPServer } from '@simtlix/simfinity-mcp';

const server = await createMCPServer(schema);
// Connect an SDK transport, then close the server during application shutdown.
await server.close();
```

Generated tools select the virtual fields (`extensions.virtual`) that have no required arguments, but below any list position (the records of a list tool, and the items of a nested collection or embedded list in any tool) only those whose `mcp` option is `'select'`, because the resolver runs once per record. A virtual field with a required argument gets its own read tool, `<byIdQuery>_<field>` (for example `barbershop_busyRanges`), which takes the record's `id` and the field's arguments; `mcp: false` turns it off.

The package works with schemas produced by either `@simtlix/simfinity-js` or `@simtlix/simfinity-postgres`, including the `createSQL` composition API. `generateMCPTools` needs no SDK. Server and transport constructors report `MCP_SDK_NOT_INSTALLED` when the optional SDK is unavailable.
