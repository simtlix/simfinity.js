[![Simfinity.js — Define once. Build beyond. GraphQL, MongoDB, PostgreSQL, and optional MCP.](https://raw.githubusercontent.com/simtlix/simfinity.js/master/.github/assets/readme-cover.png)](https://simtlix.github.io/simfinity.js/)

# @simtlix/simfinity-descriptor

[![npm version](https://img.shields.io/npm/v/@simtlix/simfinity-descriptor.svg)](https://www.npmjs.com/package/@simtlix/simfinity-descriptor)
[![Node.js](https://img.shields.io/node/v/@simtlix/simfinity-descriptor.svg)](https://nodejs.org/)
[![License](https://img.shields.io/npm/l/@simtlix/simfinity-descriptor.svg)](https://github.com/simtlix/simfinity.js/blob/master/LICENSE)
[![Documentation](https://img.shields.io/badge/docs-simtlix.github.io-2563eb.svg)](https://simtlix.github.io/simfinity.js/)

**Client metadata for a [Simfinity.js](https://simtlix.github.io/simfinity.js/) schema, as JSON, with an explicitly authorized HTTP endpoint to serve it.** A descriptor is immutable JSON metadata for the exact schema that `createSchema()` returned. It is built without querying a database and can be served even when introspection queries are disabled. It is optional and works with both database packages.

**[Documentation](https://simtlix.github.io/simfinity.js/)** ·
**[Client descriptor reference](https://simtlix.github.io/simfinity.js/reference/client-descriptor.html)** ·
**[JavaScript client](https://simtlix.github.io/simfinity.js/guide/client.html)** ·
**[Releases](https://github.com/simtlix/simfinity.js/releases)**

## Install

```sh
npm install @simtlix/simfinity-descriptor
```

Install it as a direct dependency at the same version as your Simfinity database package. It requires Node.js 18.18 or later and `graphql@^16.11.0`.

## Quick start

```javascript
import { buildClientDescriptor, createClientDescriptorHandler } from '@simtlix/simfinity-descriptor';

const descriptor = buildClientDescriptor(schema);
app.all('/graphql-metadata', createClientDescriptorHandler(schema, { authorize: 'public' }));
```

- Pass the exact schema returned by `createSchema()`. Clones and composed schemas do not inherit ownership.
- Choose access explicitly: `authorize: 'public'` or your own authorization function.
- Finish your declarations before the first build. Create a new schema and handler when the metadata changes.

Importing this package does not patch GraphQL introspection. A descriptor does not evaluate dynamic permissions or serialize arbitrary validators.

The [`@simtlix/simfinity-js-client`](https://www.npmjs.com/package/@simtlix/simfinity-js-client) package reads this endpoint through its `descriptorEndpoint` option.

## Documentation

| I want to… | Read |
| --- | --- |
| Build a descriptor for the schema I serve | [Build for the schema you serve](https://simtlix.github.io/simfinity.js/reference/client-descriptor.html#build-for-the-schema-you-serve) |
| Know every field of the JSON | [Format version 1](https://simtlix.github.io/simfinity.js/reference/client-descriptor.html#format-version-1) |
| Protect the endpoint | [Mount the HTTP handler](https://simtlix.github.io/simfinity.js/reference/client-descriptor.html#mount-the-http-handler) |
| Turn off the deprecated `__Field.extensions` introspection field | [Disable the legacy extension explicitly](https://simtlix.github.io/simfinity.js/reference/client-descriptor.html#disable-the-legacy-extension-explicitly) |
| Migrate a client from introspection | [Client migration boundary](https://simtlix.github.io/simfinity.js/reference/client-descriptor.html#client-migration-boundary) |
| Use it from the JavaScript client | [Initialize with a descriptor](https://simtlix.github.io/simfinity.js/guide/client.html#initialize-with-a-descriptor) |

## Packages

All Simfinity packages are released together under the same version. Keep the ones you install aligned. The ESLint plugin has its own version.

| Package | Use it for |
| --- | --- |
| [`@simtlix/simfinity-js`](https://www.npmjs.com/package/@simtlix/simfinity-js) | MongoDB/Mongoose applications |
| [`@simtlix/simfinity-postgres`](https://www.npmjs.com/package/@simtlix/simfinity-postgres) | PostgreSQL 15+ applications, with real tables and foreign keys |
| [`@simtlix/simfinity-mcp`](https://www.npmjs.com/package/@simtlix/simfinity-mcp) | MCP tools and transports for any Simfinity schema |
| [`@simtlix/simfinity-js-client`](https://www.npmjs.com/package/@simtlix/simfinity-js-client) | JavaScript client for Simfinity APIs |
| **`@simtlix/simfinity-descriptor`** | Client metadata endpoint for a schema (this package) |
| [`@simtlix/simfinity-core`](https://www.npmjs.com/package/@simtlix/simfinity-core) | Shared GraphQL runtime, installed automatically |
| [`@simtlix/simfinity-sql`](https://www.npmjs.com/package/@simtlix/simfinity-sql) | Relational runtime and database plugin contract |
| [`@simtlix/eslint-plugin-simfinity`](https://www.npmjs.com/package/@simtlix/eslint-plugin-simfinity) | Optional lint rules for Simfinity applications |

## Contributing

Source, issues and the contribution guide live in the [simtlix/simfinity.js](https://github.com/simtlix/simfinity.js) monorepo, under `packages/descriptor`. See [Contributing](https://simtlix.github.io/simfinity.js/resources/contributing.html).

## License

[Apache-2.0](https://github.com/simtlix/simfinity.js/blob/master/LICENSE)
