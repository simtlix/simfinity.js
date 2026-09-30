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
| [@simtlix/simfinity-js](https://www.npmjs.com/package/@simtlix/simfinity-js) | MongoDB facade, including compatibility exports | {{ library.version }} |
| [@simtlix/simfinity-postgres](https://www.npmjs.com/package/@simtlix/simfinity-postgres) | PostgreSQL adapter with generated schema and FKs | {{ library.version }} |
| [@simtlix/simfinity-sql](https://www.npmjs.com/package/@simtlix/simfinity-sql) | Driver-free relational runtime and plugin contract | {{ library.version }} |
| [@simtlix/simfinity-core](https://www.npmjs.com/package/@simtlix/simfinity-core) | Shared runtime and helpers | {{ library.version }} |
| [@simtlix/simfinity-mcp](https://www.npmjs.com/package/@simtlix/simfinity-mcp) | Optional MCP integration for either database | {{ library.version }} |

Follow [installation and downloads](../guide/databases#install-from-npm) or read the [latest stable release notes](https://github.com/simtlix/simfinity.js/releases/latest).

## Requirements

| Component | Requirement |
| --- | --- |
| Library runtime | Node.js 18.18.0 or newer; use a maintained release for a new application |
| GraphQL peer | `^16.11.0` |
| MongoDB facade | Mongoose `^8.24.2`; MongoDB 7 or 8 replica set/sharded cluster for mutations |
| PostgreSQL facade | PostgreSQL 15, 16, or 18; `pg` `^8.16.3` |
| Downloadable starters | Node.js 22 or newer, npm and the database selected in the corresponding quick start |
| MCP tool generation | Opt-in `@simtlix/simfinity-mcp`; the SDK is needed for MCP transports |
| Documentation development | Node.js 22 or newer |

## Upgrade to 3.5.1

Keep all directly installed Simfinity packages at 3.5.1. When upgrading from an earlier version than 3.5.0, also review the [3.5.0 notes](#upgrade-to-3-5-0) below.

- Generated MongoDB models store numeric and boolean enum values as numbers and booleans instead of strings. Documents written by earlier versions need a one-time conversion before lists, filters and aggregations match them; unique enum fields must be converted before new writes. See [What gets generated](../guide/schema#what-gets-generated).
- An embedded MongoDB type can declare a field named `type`.

## Upgrade to 3.5.0

Keep all directly installed Simfinity packages at 3.5.0 and review these behavior changes:

- Client filter, sort and aggregation paths now enforce field read rules and related-type scopes. Rules receive the identity of each path field in `info.fieldName`, `info.parentType` and `info.returnType`, with no parent and empty arguments. Parent-dependent rules deny such paths. See [authorization](../guide/authorization#filter-sort-and-aggregation-paths) and [scope restrictions](../guide/query-scope#relationship-paths-in-filters-sorts-and-aggregations).
- Fields with an application-defined resolver reject these paths unless they set `extensions.queryable: true`; `queryable: false` blocks paths regardless of the resolver. Remove manual relationship resolvers that only load stored references, or explicitly allow querying fields whose resolver returns the stored value. `readOnly` still controls mutation inputs only. See [path restrictions](../guide/queries#path-restrictions).
- Generated single-reference reads can batch within an object request context. Scoped targets and Mongoose models with any `find` or `findOne` pre/post hook retain individual reads, including when both operations share a hook function. See [relationships](../guide/relationships#query-related-records).
- MongoDB uses the application's GraphQL and Mongoose peers. Install the optional MCP SDK explicitly for transports; `graphql-middleware` is no longer installed by Simfinity. See [installation](../guide/databases#install-from-npm).
- Embedded updates enforce required fields when constructing replacement objects or list items; existing embedded objects still accept valid partial patches. SQL sessions reject statements after their callback settles, and a failed rollback discards the connection. See [mutations](../guide/mutations) and the [SQL plugin contract](../guide/sql-plugins#plugin-contract-version-1).

The current [downloadable starters](../guide/databases#download-the-starters) use 3.5.1. Historical archives and the Barber examples retain their documented package pins; upgrade all their Simfinity dependencies together before relying on newer library behavior.

## Upgrade from 3.2.0

Version 3.3.0 extracts the SQL runtime and adds `postgresPlugin` without changing existing PostgreSQL entry points or generated physical storage. Keep `createPostgres`, or use the explicit [SQL plugin API](../guide/sql-plugins). An unchanged 3.2.0 domain requires no generated-schema migration for this extraction. All Simfinity packages installed together should use the same version. PostgreSQL is currently the only supported SQL plugin.

## Before upgrading

Check the [release history](https://github.com/simtlix/simfinity.js/releases) and the [npm package](https://www.npmjs.com/package/@simtlix/simfinity-js), then read changes between your installed version and the version you intend to use.

Exercise the operations your application relies on: generated names and input shapes, relationships, permissions, scopes, custom mutations, state actions and MCP allowlists. Keep GraphQL and the selected adapter within supported ranges. PostgreSQL adoption also requires reviewing stronger `NOT NULL`, FK, uniqueness, embedded-shape, and UUID constraints, plus replacing Mongoose-native calls with the PostgreSQL Model/Session APIs.

The site documents two database adapters for the same GraphQL API. It does not host separate historical documentation archives. The 3.0.1 starter is retained as a published-version entry point; newer reference APIs may not exist in that release.

## Get help with an integration

Start with [troubleshooting](./troubleshooting). If an issue remains, [open a GitHub issue](https://github.com/simtlix/simfinity.js/issues/new) with the installed versions, minimal schema and operation, expected result, and actual error. Remove credentials and private data from the reproduction.
