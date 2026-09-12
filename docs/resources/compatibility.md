---
title: Compatibility and releases
description: Runtime requirements, documentation version, releases and upgrade checks for Simfinity.js.
---

<script setup>
import library from '../../package.json';
</script>

# Compatibility and releases

This documentation covers Simfinity.js **{{ library.version }}**. The version menu links to the package and release history.

## Requirements

| Component | Requirement |
| --- | --- |
| Library runtime | Node.js 18.18.0 or newer; use a maintained release for a new application |
| GraphQL peer | `^16.11.0` |
| MongoDB facade | Mongoose `^8.16.2`; MongoDB 7 or 8 replica set/sharded cluster for mutations |
| PostgreSQL facade | PostgreSQL 15, 16, or 18; `pg` `^8.16.3` |
| Downloadable starter | Node.js 22 or newer, npm and a transaction-capable MongoDB deployment |
| MCP tool generation | Opt-in `@simtlix/simfinity-mcp`; the SDK is needed for MCP transports |
| Documentation development | Node.js 22 or newer |

## Before upgrading

Version 3.2.0 is prepared as a local, unpublished four-package release. Do not assume registry availability from this documentation. For published versions, check the [release history](https://github.com/simtlix/simfinity.js/releases) and the [npm package](https://www.npmjs.com/package/@simtlix/simfinity-js), then read changes between your installed version and the version you intend to use.

Exercise the operations your application relies on: generated names and input shapes, relationships, permissions, scopes, custom mutations, state actions and MCP allowlists. Keep GraphQL and the selected adapter within supported ranges. PostgreSQL adoption also requires reviewing stronger `NOT NULL`, FK, uniqueness, embedded-shape, and UUID constraints, plus replacing Mongoose-native calls with the PostgreSQL Model/Session APIs.

The site currently documents one version. Historical examples in the repository README are not a separate, versioned documentation archive.

## Get help with an integration

Start with [troubleshooting](./troubleshooting). If an issue remains, [open a GitHub issue](https://github.com/simtlix/simfinity.js/issues/new) with the installed versions, minimal schema and operation, expected result, and actual error. Remove credentials and private data from the reproduction.
