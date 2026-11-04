---
name: simfinity-application-design
description: Use when designing a Simfinity application or module, reviewing an existing application architecture, planning migration or assessing a missing library capability.
---

# Design an application with Simfinity

Start from the domain and the generated API's lifecycle. Read the application's instructions, installed package versions, lockfile resolutions and selected engine. The maintained reference is Simfinity 3.19.0; use the [capability checkpoints](references/capabilities.md) when assessing upgrades or an alleged missing API. Inspect the installed source or matching release documentation: private forks and local tarballs can differ from the release bearing their version number.

Identify actors, business entities, relationships, invariants and atomic operations from the existing brief/code. Ask only for missing decisions that affect the implementation. Separate infrastructure records such as receipts/leases from business entities. For a new model, propose a compact entity/relation diagram and access/operation table; for an approved model, update only what changes.

Use the [decision guide](references/design.md) to choose generated operations, controllers, custom mutations or native infrastructure. Load specialized skills only for relevant work: `simfinity-domain-modeling`, `simfinity-access-control`, `simfinity-business-workflows`, `simfinity-server-operations`, `simfinity-queries-and-reports`. Each also works independently; the linked public guides provide the fallback when it is unavailable.

The [order example](references/order-example.md) connects types, scopes, authorization, nested writes, authoritative totals and approval on both engines. Adapt its business policy, not its names or permissions blindly.

For maintenance, reconstruct the affected operation across API, frontend and workers before changing its boundary. Prove a claimed library gap with a minimal operation on the actual domain graph; a custom repository or dispatcher is not evidence that generated operations are insufficient.

Deliver a scoped implementation/migration with runnable operations, meaningful failure checks and explicit limitations. Preserve existing authorization, idempotency and transaction guarantees during migration. An application task does not authorize changing the library, publishing, deploying or rewriting unrelated modules.
