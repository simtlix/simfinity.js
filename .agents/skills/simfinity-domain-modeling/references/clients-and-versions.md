# Managed versions and schema-driven clients

## Optimistic concurrency (since 3.13.0)

Declare `extensions: { concurrency: { mode: 'optimistic' } }` before the entity's first schema preparation. Simfinity injects `version: RecordVersion!`; do not declare or write that managed field yourself. Failed schema preparation can already have fixed the input/model shape: rebuild types/process state when correcting startup, not by enabling protection late.

Read `id` and `version`, then send the observed numeric version for update, delete and state actions. Creates omit it and begin at 1. A protected child's `updated` item carries its own version and `deleted` uses `{ id, version }`, even if its parent is unprotected. Inspect actual generated inputs; `readOnly` metadata does not mean clients may discard the required version precondition.

```javascript
const changes = {
  id: order.id,
  version: order.version,
  lines: {
    updated: [{ id: line.id, version: line.version, quantity: 2 }],
    deleted: [{ id: obsolete.id, version: obsolete.version }],
  },
};
```

This assumes the order and both children are protected. On `VERSION_CONFLICT`, re-read and reconcile the user's intent before submitting a new version; never automatically refresh the version and replay stale input. Parent versions do not observe direct child changes or protect an entire graph. Membership revocation and shared-resource invariants need their own concurrent protocol. Keep visibility in `get_by_id` scope as well as write authorization: it governs early conflict/exhaustion disclosure.

Before rollout, inspect legacy records, version backfill/storage checks and every native or older writer. Native writes must preserve the documented conditional-write/version contract; a mixed deployment can invalidate protection. Test two writes from one revision, stale nested children, rollback and denied visibility on each supported engine. See [concurrency](https://simtlix.github.io/simfinity.js/guide/concurrency.html).

## Client descriptor (since 3.15.0)

Install `@simtlix/simfinity-descriptor` as a direct dependency aligned with core. Use `buildClientDescriptor(schema)` from that package with the exact `createSchema()` result being served. Core and facades do not re-export it. Finish declarations first: the full descriptor freezes on its first build, is per-schema and does not transfer to a clone or composed schema.

Use actual operation arguments/input types for forms, including nested patches and versions. `rootInputUsage` describes root inputs; it does not replace nested input shapes. Metadata is a schema description, not a per-user permission result or an adapter query-capability advertisement. A client must tolerate additive operation kinds, including `transaction` since 3.16.0.

Mount `createClientDescriptorHandler` only with explicit authorization (or an intentional public policy). It does not filter individual operations by dynamic permissions. Use separately constructed schema allowlists for different audiences and keep runtime authorization active. Disabling GraphQL introspection does not authorize the metadata endpoint.

Legacy introspection remains on by default. Its opt-out must be configured via `@simtlix/simfinity-core/introspection` before importing the runtime; static import evaluation order matters. Change it only after checking existing clients. Test fresh-process startup, the served schema/metadata pair and actual form submissions. See [client descriptor](https://simtlix.github.io/simfinity.js/reference/client-descriptor.html).
