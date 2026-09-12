---
title: Compatibility and releases
description: Runtime requirements, documentation version, releases and upgrade checks for Simfinity.js.
---

<script setup>
import library from '../public/preview/manifest.json';
</script>

# Compatibility and releases

This documentation covers Simfinity.js **{{ library.version }} preview**, for **MongoDB and PostgreSQL**. The version menu identifies the documented preview independently of the repository's current npm package version.

## Package availability

As checked on September 12, 2026:

| Distribution | Availability |
| --- | --- |
| MongoDB 3.0.1 | Published on npm as `@simtlix/simfinity-js`; [original starter](/simfinity-series-starter.zip) |
| MongoDB 3.2.0 preview | Verified archives in the [preview kit](../guide/databases#download-the-preview) |
| PostgreSQL 3.2.0 preview | Verified archives in the same kit; `@simtlix/simfinity-postgres` is not yet on npm |
| Core and optional MCP 3.2.0 preview | Included in the kit; install alongside the matching adapter |

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

## Before upgrading

Version 3.2.0 is distributed here as an unpublished four-package preview. Do not assume registry availability from this documentation. For published versions, check the [release history](https://github.com/simtlix/simfinity.js/releases) and the [npm package](https://www.npmjs.com/package/@simtlix/simfinity-js), then read changes between your installed version and the version you intend to use.

Exercise the operations your application relies on: generated names and input shapes, relationships, permissions, scopes, custom mutations, state actions and MCP allowlists. Keep GraphQL and the selected adapter within supported ranges. PostgreSQL adoption also requires reviewing stronger `NOT NULL`, FK, uniqueness, embedded-shape, and UUID constraints, plus replacing Mongoose-native calls with the PostgreSQL Model/Session APIs.

The site documents two database adapters for the same 3.2.0 preview API. It does not host separate historical documentation archives. The 3.0.1 starter is retained as a published-version entry point; newer reference APIs may not exist in that release.

## Get help with an integration

Start with [troubleshooting](./troubleshooting). If an issue remains, [open a GitHub issue](https://github.com/simtlix/simfinity.js/issues/new) with the installed versions, minimal schema and operation, expected result, and actual error. Remove credentials and private data from the reproduction.
