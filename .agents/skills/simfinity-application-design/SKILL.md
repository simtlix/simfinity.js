---
name: simfinity-application-design
description: Use when designing a Simfinity application or module, reviewing an existing application architecture, planning migration or assessing a missing library capability.
---

# Design an application with Simfinity

Start from the domain and the generated API's lifecycle. Read the application's instructions, installed package versions, lockfile resolutions and selected engine. The maintained reference is Simfinity 3.19.0; use the [capability checkpoints](references/capabilities.md) when assessing upgrades or an alleged missing API. Inspect the installed source or matching release documentation: private forks and local tarballs can differ from the release bearing their version number.

Identify actors, business entities, relationships, invariants and atomic operations from the existing brief/code. Ask only for missing decisions that affect the implementation. Identify which settings and other values share their owner’s lifecycle, and which related records and grants need an identity of their own. Identify infrastructure records such as receipts and leases separately. For a new model, propose a compact entity/relation diagram and access/operation table. For an approved model, update only what changes.

Use the [decision guide](references/design.md) to choose generated operations, controllers, custom mutations or native infrastructure. Load specialized skills only for relevant work: `simfinity-domain-modeling`, `simfinity-access-control`, `simfinity-business-workflows`, `simfinity-server-operations`, `simfinity-queries-and-reports`. Each also works independently; the linked public guides provide the fallback when it is unavailable.

The [order example](references/order-example.md) connects types, scopes, authorization, nested writes, authoritative totals and approval on both engines. Adapt its business policy, not its names or permissions blindly.

For a new application, prove one representative write and scoped read on the generated schema before repeating the pattern across modules. For maintenance, trace the existing operation through its actual consumers and compare its behavior with a generated slice. Use the decision guide to record the owner, compatible contracts and any exception supported by an executable probe.

Deliver a scoped implementation/migration with runnable operations, meaningful failure checks and explicit limitations. Preserve existing authorization, idempotency and transaction guarantees during migration. An application task does not authorize changing the library, publishing, deploying or rewriting unrelated modules.
