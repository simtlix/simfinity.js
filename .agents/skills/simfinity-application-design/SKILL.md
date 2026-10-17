---
name: simfinity-application-design
description: Use when designing a new Simfinity application or module, or planning migration of an existing integration that rebuilds CRUD or treats Simfinity as a database driver.
---

# Design an application with Simfinity

Start from the domain and the generated API's lifecycle. Read the application's instructions, installed package versions, lockfile resolutions and selected engine. These skills were checked against 3.7.0; inspect documentation/source for the installed version before recommending an API. Local tarballs can differ from the release bearing their version number.

Identify actors, business entities, relationships, invariants and atomic operations from the existing brief/code. Ask only for missing decisions that affect the implementation. Separate infrastructure records such as receipts/leases from business entities. For a new model, propose a compact entity/relation diagram and access/operation table; for an approved model, update only what changes.

Use the [decision guide](references/design.md) to choose generated operations, controllers, custom mutations or native infrastructure. Load specialized skills only for relevant work: `simfinity-domain-modeling`, `simfinity-access-control`, `simfinity-business-workflows`, `simfinity-server-operations`, `simfinity-queries-and-reports`. Each also works independently; the linked public guides provide the fallback when it is unavailable.

The [order example](references/order-example.md) connects types, scopes, authorization, nested writes, authoritative totals and approval on both engines. Adapt its business policy, not its names or permissions blindly.

Deliver a scoped implementation/migration with runnable operations, meaningful failure checks and explicit limitations. Preserve existing authorization, idempotency and transaction guarantees during migration. An application task does not authorize changing the library, publishing, deploying or rewriting unrelated modules.
