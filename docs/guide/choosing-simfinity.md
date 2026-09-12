---
title: Is Simfinity a fit?
description: Evaluate Simfinity's GraphQL, MongoDB, and PostgreSQL architecture, what it generates, and what your application owns.
---

# Is Simfinity a fit?

Simfinity connects GraphQL object types to MongoDB models or PostgreSQL tables and generated operations. It is useful when your application has a connected domain, repeated CRUD behavior, and application rules you want to keep close to its schema.

<DomainDiagram kind="schema" />

## What you get, and what you own

| Simfinity generates | Your application provides |
| --- | --- |
| Mongoose models or PostgreSQL tables from registered GraphQL types | One supported database deployment, credentials and workload-specific indexes |
| Detail, list, aggregation and CRUD operations | Endpoint names and decisions about which operations to expose |
| Relationship inputs and resolvers | Storage choices, ownership checks and deletion policy |
| Integration points for permissions, validation and lifecycle hooks | Authentication, authorization policy and domain-specific behavior |
| MCP tool definitions from the schema | Allowed tools, trusted context and transport configuration |

## A concrete example: a series catalog

Start with a `Serie`, add embedded seasons, filter the catalog and expose a read tool. The [Quick start](./getting-started) includes the files and expected responses. The larger [Series Sample Project](https://github.com/simtlix/series-sample) shows additional relationships and application behavior.

Follow the same domain as it grows:

1. [Create and query the catalog](./getting-started).
2. [Choose how relationships are stored](./relationships).
3. [Validate data](./validation) and [authorize operations](./authorization).
4. [Add server-controlled query scope](./query-scope).
5. [Expose selected operations as MCP tools](./mcp).

## Architectural boundaries

- Choose MongoDB/Mongoose or PostgreSQL when the application starts. Runtime switching and automatic data migration are outside the package contract.
- Generated mutations use transactions. MongoDB needs a replica set or sharded cluster; PostgreSQL needs version 15 or later.
- Authentication belongs to your application. Query scopes restrict supported reads; write ownership checks require explicit application policy.
- Direct Mongoose calls and PostgreSQL native Model calls bypass the generated GraphQL pipelines.
- Registrations and middleware belong to a runtime instance. Register your types and build each schema during application startup; reuse the resulting schema rather than rebuilding it per request.
- Supporting types, custom mutations and lifecycle hooks let you adapt the generated behavior. Review the [Core API](../reference/api) when deciding where to extend it.

For requirements and version information, see [compatibility and releases](../resources/compatibility).
