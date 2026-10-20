---
name: simfinity-server-operations
description: Use when invoking Simfinity from jobs, workers, webhooks or custom commands, or integrating native atomic operations with its transactions.
---

# Execute server-side work through a supported boundary

Check the installed version and engine, the caller's identity and whether a transaction already owns the work. The [execution guide](references/execution.md) describes the 3.7.0 paths and omissions; reconcile it with the installed source.

Outside an existing transaction, reuse generated operations through parsed/validated GraphQL and an authorized schema. Inside a hook/custom mutation, use its supplied session for transactional reads and native side writes; `saveObject()` is the creation helper, not general programmatic CRUD. A parent and its children usually fit one nested generated mutation.

Make authorization, validation, idempotency and retry ownership explicit at each boundary. Retain native conditional statements for counters, locks, leases and receipts. Do not emulate a driver over generated resolvers or move caller filters/sessions into adapter overrides.

Verify coercion, actor grants, session propagation, rollback and retry outcomes relevant to the command. Treat GraphQL errors after commit and unknown commit outcomes separately from rolled-back writes. Deliver runnable calls and a precise account of which guarantees the path provides and which belong to application code.
