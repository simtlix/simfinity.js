---
name: simfinity-access-control
description: Use when implementing or diagnosing Simfinity application tenant isolation, record visibility, operation or field permissions, nested-write authorization, or worker and capability access.
---

# Combine visibility and authorization

Read the application's authentication and permission model, installed library version and actual schema. Guidance is checked against 3.7.0; confirm installed-version behavior. Preserve existing grants and revocation semantics.

Build a compact matrix of actor, operation, visible rows, readable fields and writable targets. Include generated relations, nested writes, state actions, custom operations and workers when present. Use the [access guide](references/access.md) to implement each boundary. A find scope alone is not an authorization policy.

Resolve identity and tenant from trusted server context. Apply visibility before pagination/counts/aggregation, preserve client filters, and enforce write ownership with current data in the transaction. Install schema authorization on every execution path. An internal caller is an explicitly authorized actor.

Exercise allowed and denied paths with two tenants/owners, adversarial OR filters, foreign child IDs, sensitive query paths and revoked access. Assert denied writes leave storage unchanged. Keep valid existing scopes; replace them only for a demonstrated gap.

Deliver the policy matrix, implementation and verification evidence. Do not weaken controls to make a generated operation or report work; distinguish an unsupported query path from a missing grant.
