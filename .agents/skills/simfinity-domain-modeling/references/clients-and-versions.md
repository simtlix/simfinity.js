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

## Browser client (since 3.19.0)

Use the default export from `@simtlix/simfinity-js-client`. Its 3.19.0 release preserves valid 1.1 JavaScript calls and ships TypeScript declarations; remove duplicate local ambient declarations when adopting those types. Install the browser client in the frontend's own package/lockfile. It has no runtime dependencies and needs neither a server package nor the descriptor builder in the browser. A client upgrade does not upgrade its server or enable missing schema features.

```javascript
import SimfinityClient from '@simtlix/simfinity-js-client';

const client = new SimfinityClient('/graphql', {
  descriptorEndpoint: '/client-metadata',
  async prepareHeaders(headers) {
    headers.Authorization = `Bearer ${await tokenStore.getAccessToken()}`;
  },
});
await client.init();
```

The example assumes the application's token store and an explicitly authorized descriptor endpoint for the served schema. `prepareHeaders` also runs for that endpoint: choose its origin deliberately. Alternatively pass `descriptor: document`, never both descriptor options. Descriptor mode does not query introspection or silently fall back after denial. With neither option, initialization uses legacy extended introspection; choose `introspection: 'standard'` if `__Field.extensions` is disabled, accepting that relation/state hints and authoritative view classification may be unavailable. Unsupported descriptor formats fail initialization.

Build forms from each concrete operation's input graph. `update(typeName, id, input, fields, { transform: true })` preserves required versions even though output metadata marks them read-only. Cleaning normally omits null/empty strings and collections: use `preserveEmpty: true` for explicit clears and `includeCollections: true` for nested deltas. Protected child updates/deletes keep their own observed versions; nested create inputs may omit a back-reference required by the root create. Standalone `transformInput` and `transformCollectionDelta` accept `inputType` for the actual input context, not a shape guessed from `rootInputUsage`.

For the protected Order/lines patch above, transformation options are siblings of `transform` in the fifth argument:

```javascript
await client.update('Order', order.id, changes, 'id version', {
  transform: true,
  preserveEmpty: true,
  includeCollections: true,
});
```


For a protected root, call `delete(typeName, id, fields, { version })`; state actions use `transition(typeName, actionName, id, { version, ...changes }, fields)`. Read/select the versions needed for later edits. IDs stay opaque strings. The client never refreshes versions or retries writes automatically; handle `error.graphQLErrors`, including `VERSION_CONFLICT`, by reconciling current state and the user's draft. A failed response/readback is not evidence of rollback.

Descriptors preserve canonical list endpoints separately from views. Use `findView(name, params)` for a named view or `query(name, args, fields)` for an exact query root. `transaction(operations, fields, options)` uses the descriptor's transaction name; in introspection mode supply `{ name: configuredRoot }`. Operation keys, `$K`/`$$K` references and versions pass to the server, which owns authorization, atomicity and retries.

Verify authenticated initialization, real form submissions, explicit clears, protected nested writes, view selection and uncertain errors against the application's actual API. See the [client guide](https://simtlix.github.io/simfinity.js/guide/client.html) for builders, signatures and migration examples.
