# @simtlix/simfinity-mcp

Database-independent MCP tool generation and transports for Simfinity GraphQL schemas. It requires GraphQL 16 and Node.js 18.18 or later.

All Simfinity packages are released together. Install from npm and keep their versions aligned. Source: [simtlix/simfinity.js](https://github.com/simtlix/simfinity.js).

Named views are read-only list tools titled by their name.

Tool generation and execution use only GraphQL:

```javascript
import { generateMCPTools } from '@simtlix/simfinity-mcp';

const { tools, callTool } = generateMCPTools(schema);
const result = await callTool(tools[0].name, {});
```

Install the optional MCP SDK when constructing a server or transport:

```sh
npm install @simtlix/simfinity-mcp@3.12.0 @modelcontextprotocol/sdk@^1.31.0
```

```javascript
import { createMCPServer } from '@simtlix/simfinity-mcp';

const server = await createMCPServer(schema);
// Connect an SDK transport, then close the server during application shutdown.
await server.close();
```

Generated tools select the virtual fields (`extensions.virtual`) that have no required arguments, but below any list position (the records of a list tool, and the items of a nested collection or embedded list in any tool) only those whose `mcp` option is `'select'`, because the resolver runs once per record. A virtual field with a required argument gets its own read tool, `<byIdQuery>_<field>` (for example `barbershop_busyRanges`), which takes the record's `id` and the field's arguments; `mcp: false` turns it off.

Next release: `transactionTools: true` publishes a schema's generated `transaction` mutation (core's `transaction` schema option) as one destructive, non-idempotent tool that applies several generated writes together or not at all. It is off by default, and without it MCP never publishes that field or any mutation shaped like it. A schema rebuilt from introspection needs `getIntrospectionQuery({ oneOf: true })` with descriptions, and a server that enables the field exposes it as a custom tool to an earlier MCP release, so upgrade MCP first. See the [MCP guide](https://simtlix.github.io/simfinity.js/guide/mcp.html#transaction-tool-next-release).

The package works with schemas produced by either `@simtlix/simfinity-js` or `@simtlix/simfinity-postgres`, including the `createSQL` composition API. `generateMCPTools` needs no SDK. Server and transport constructors report `MCP_SDK_NOT_INSTALLED` when the optional SDK is unavailable.
