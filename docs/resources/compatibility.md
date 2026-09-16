---
title: Compatibility and releases
description: Runtime requirements, documentation version, releases and upgrade checks for Simfinity.js.
---

<script setup>
import library from '../../package.json';
</script>

# Compatibility and releases

This documentation covers Simfinity.js **{{ library.version }}**, for **MongoDB and PostgreSQL**. All five packages are versioned and released together.

## Package availability

| Package | Purpose | Release |
| --- | --- | --- |
| [@simtlix/simfinity-js](https://www.npmjs.com/package/@simtlix/simfinity-js) | MongoDB facade, including compatibility exports | 3.3.0 |
| [@simtlix/simfinity-postgres](https://www.npmjs.com/package/@simtlix/simfinity-postgres) | PostgreSQL adapter with generated schema and FKs | 3.3.0 |
| [@simtlix/simfinity-sql](https://www.npmjs.com/package/@simtlix/simfinity-sql) | Driver-free relational runtime and plugin contract | 3.3.0 |
| [@simtlix/simfinity-core](https://www.npmjs.com/package/@simtlix/simfinity-core) | Shared runtime and helpers | 3.3.0 |
| [@simtlix/simfinity-mcp](https://www.npmjs.com/package/@simtlix/simfinity-mcp) | Optional MCP integration for either database | 3.3.0 |

Follow [installation and downloads](../guide/databases#install-from-npm) or read the [v3.3.0 release notes](https://github.com/simtlix/simfinity.js/releases/tag/v3.3.0).

## Requirements

| Component | Requirement |
| --- | --- |
| Library runtime | Node.js 18.18.0 or newer; use a maintained release for a new application |
| GraphQL peer | `^16.11.0` |
| MongoDB facade | Mongoose `^8.16.2`; MongoDB 7 or 8 replica set/sharded cluster for mutations |
| PostgreSQL facade | PostgreSQL 15, 16, or 18; `pg` `^8.16.3` |
| Downloadable starters | Node.js 22 or newer, npm and the database selected in the corresponding quick start |
| MCP tool generation | Opt-in `@simtlix/simfinity-mcp`; the SDK is needed for MCP transports |
| Documentation development | Node.js 22 or newer |

## Upgrade from 3.2.0

Version 3.3.0 extracts the SQL runtime and adds `postgresPlugin` without changing existing PostgreSQL entry points or generated physical storage. Keep `createPostgres`, or use the explicit [SQL plugin API](../guide/sql-plugins). An unchanged 3.2.0 domain requires no generated-schema migration for this extraction. All Simfinity packages installed together should use the same version. PostgreSQL is currently the only supported SQL plugin.

## Before upgrading

Check the [release history](https://github.com/simtlix/simfinity.js/releases) and the [npm package](https://www.npmjs.com/package/@simtlix/simfinity-js), then read changes between your installed version and the version you intend to use.

Exercise the operations your application relies on: generated names and input shapes, relationships, permissions, scopes, custom mutations, state actions and MCP allowlists. Keep GraphQL and the selected adapter within supported ranges. PostgreSQL adoption also requires reviewing stronger `NOT NULL`, FK, uniqueness, embedded-shape, and UUID constraints, plus replacing Mongoose-native calls with the PostgreSQL Model/Session APIs.

The site documents two database adapters for the same v3.3.0 API. It does not host separate historical documentation archives. The 3.0.1 starter is retained as a published-version entry point; newer reference APIs may not exist in that release.

## Get help with an integration

Start with [troubleshooting](./troubleshooting). If an issue remains, [open a GitHub issue](https://github.com/simtlix/simfinity.js/issues/new) with the installed versions, minimal schema and operation, expected result, and actual error. Remove credentials and private data from the reproduction.
