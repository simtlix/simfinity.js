---
name: simfinity-business-workflows
description: Use when implementing Simfinity application state transitions, validators, controllers, nested writes, derived values or transactional side effects.
---

# Implement business behavior in its lifecycle

Inspect the installed version, entity model, existing write paths and invariants. This guidance uses the 3.7.0 contract; verify the selected package's behavior. Identify who may act, what persisted conditions must hold, what changes atomically and which external effects follow commit.

Use the [lifecycle guide](references/lifecycle.md) to choose validators, controllers, fixed state actions or an application command. Reuse pure domain policies from hooks; avoid duplicate business rules in each transport. Keep user-configurable/versioned workflows explicit when a fixed registered enum cannot represent them.

For parent/child work, use one nested mutation when it expresses the operation. Trace child permissions, ownership, validators and hooks, then parent derived values. All related native database work uses the supplied session. Preserve concurrent invariants with appropriate constraints/atomic operations; a read-check-write sequence alone is not a general lock.

Verify denied/repeated transitions, partial updates, foreign children, rollback and relevant retry/concurrency cases. Check stored state as well as GraphQL output. Deliver the transition/operation contract and test evidence; do not claim native calls or `saveObject()` run the entire generated request lifecycle.
