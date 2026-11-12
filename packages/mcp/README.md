[![Simfinity.js — Define once. Build beyond. GraphQL, MongoDB, PostgreSQL, and optional MCP.](https://raw.githubusercontent.com/simtlix/simfinity.js/master/.github/assets/readme-cover.png)](https://simtlix.github.io/simfinity.js/)

# @simtlix/simfinity-mcp

[![npm version](https://img.shields.io/npm/v/@simtlix/simfinity-mcp.svg)](https://www.npmjs.com/package/@simtlix/simfinity-mcp)
[![Node.js](https://img.shields.io/node/v/@simtlix/simfinity-mcp.svg)](https://nodejs.org/)
[![License](https://img.shields.io/npm/l/@simtlix/simfinity-mcp.svg)](https://github.com/simtlix/simfinity.js/blob/master/LICENSE)
[![Documentation](https://img.shields.io/badge/docs-simtlix.github.io-2563eb.svg)](https://simtlix.github.io/simfinity.js/)

**MCP tools for AI agents, generated from a [Simfinity.js](https://simtlix.github.io/simfinity.js/) GraphQL schema.** Each root query and mutation of the schema becomes a tool with a generated input schema and description. Tools run through GraphQL, so your authorization, scopes and validation still apply. It is database-independent and works with MongoDB and PostgreSQL schemas alike.

**[Documentation](https://simtlix.github.io/simfinity.js/)** ·
**[MCP guide](https://simtlix.github.io/simfinity.js/guide/mcp.html)** ·
**[MCP API reference](https://simtlix.github.io/simfinity.js/reference/mcp.html)** ·
**[Example app](https://simtlix.github.io/simfinity.js/resources/barber.html)** ·
**[Releases](https://github.com/simtlix/simfinity.js/releases)**

## Install

```sh
npm install @simtlix/simfinity-mcp graphql@^16.11.0
```

Add the MCP SDK when you use a server or transport helper:

```sh
npm install @modelcontextprotocol/sdk@^1.31.0
```

| Requirement | Version |
| --- | --- |
| Node.js | 18.18 or later, ES modules |
| `graphql` (peer) | `^16.11.0` |
| `@modelcontextprotocol/sdk` (optional peer) | `^1.31.0`, for `createMCPServer`, `startStdioMCPServer` and `createHTTPMCPHandler` |

`@simtlix/simfinity-js` already re-exports these helpers. Install this package directly with PostgreSQL, or when you want the MCP layer on its own.

## Quick start

Generate the tools from any schema returned by `createSchema()` and call them directly. This needs no SDK:

```javascript
import { generateMCPTools } from '@simtlix/simfinity-mcp';

const { tools, callTool } = generateMCPTools(schema);
const result = await callTool(tools[0].name, {});
```

Tool inputs accept the same filters as the GraphQL API, including quantifiers over collections:

```javascript
const result = await callTool('series', {
  seasons: { quantifier: 'NONE', terms: [{ path: 'year', operator: 'LT', value: 2000 }] },
  pagination: { page: 1, size: 10, count: true },
});
```

Serve them over MCP with the SDK installed:

```javascript
import { createMCPServer } from '@simtlix/simfinity-mcp';

const server = await createMCPServer(schema);
// Connect an SDK transport, then close the server during application shutdown.
await server.close();
```

## Documentation

| I want to… | Read |
| --- | --- |
| Generate tools and inspect what was created | [Generate and inspect tools](https://simtlix.github.io/simfinity.js/guide/mcp.html#generate-and-inspect-tools) |
| Expose custom queries and named views | [Custom query tools](https://simtlix.github.io/simfinity.js/guide/mcp.html#custom-query-tools), [named view tools](https://simtlix.github.io/simfinity.js/guide/mcp.html#named-view-tools) |
| Run a local stdio server | [Start a stdio server](https://simtlix.github.io/simfinity.js/guide/mcp.html#start-a-stdio-server) |
| Mount an HTTP endpoint next to GraphQL | [Serve Streamable HTTP](https://simtlix.github.io/simfinity.js/guide/mcp.html#serve-streamable-http) |
| Keep authorization in force | [Preserve authorization](https://simtlix.github.io/simfinity.js/guide/mcp.html#preserve-authorization) |
| Run several writes atomically | [Transaction tool](https://simtlix.github.io/simfinity.js/guide/mcp.html#transaction-tool) |
| Select, rename or override tools | [Generation options](https://simtlix.github.io/simfinity.js/reference/mcp.html#generation-options), [tool overrides](https://simtlix.github.io/simfinity.js/reference/mcp.html#tool-overrides) |
| Bound page sizes and results | [Limits](https://simtlix.github.io/simfinity.js/reference/mcp.html#limits) |
| Wrap every tool call | [Tool middleware](https://simtlix.github.io/simfinity.js/reference/mcp.html#tool-middleware) |
| Handle results and error codes | [Results and errors](https://simtlix.github.io/simfinity.js/reference/mcp.html#results-and-errors) |

## Packages

All Simfinity packages are released together under the same version. Keep the ones you install aligned. The ESLint plugin has its own version.

| Package | Use it for |
| --- | --- |
| [`@simtlix/simfinity-js`](https://www.npmjs.com/package/@simtlix/simfinity-js) | MongoDB/Mongoose applications |
| [`@simtlix/simfinity-postgres`](https://www.npmjs.com/package/@simtlix/simfinity-postgres) | PostgreSQL 15+ applications, with real tables and foreign keys |
| **`@simtlix/simfinity-mcp`** | MCP tools and transports for any Simfinity schema (this package) |
| [`@simtlix/simfinity-js-client`](https://www.npmjs.com/package/@simtlix/simfinity-js-client) | JavaScript client for Simfinity APIs |
| [`@simtlix/simfinity-descriptor`](https://www.npmjs.com/package/@simtlix/simfinity-descriptor) | Client metadata endpoint for a schema |
| [`@simtlix/simfinity-core`](https://www.npmjs.com/package/@simtlix/simfinity-core) | Shared GraphQL runtime, installed automatically |
| [`@simtlix/simfinity-sql`](https://www.npmjs.com/package/@simtlix/simfinity-sql) | Relational runtime and database plugin contract |
| [`@simtlix/eslint-plugin-simfinity`](https://www.npmjs.com/package/@simtlix/eslint-plugin-simfinity) | Optional lint rules for Simfinity applications |

## Contributing

Source, issues and the contribution guide live in the [simtlix/simfinity.js](https://github.com/simtlix/simfinity.js) monorepo, under `packages/mcp`. See [Contributing](https://simtlix.github.io/simfinity.js/resources/contributing.html).

## License

[Apache-2.0](https://github.com/simtlix/simfinity.js/blob/master/LICENSE)
