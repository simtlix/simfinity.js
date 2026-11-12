# Access boundaries

| Boundary | Mechanism | Does not imply |
| --- | --- | --- |
| Authenticated identity | Application authentication/context | Permission to every operation |
| Which records are visible | `scope.find`, `scope.get_by_id`, `scope.aggregate` | Permission to write them |
| Operations and output fields | `createAuthPlugin` permission map | Automatic checks for native code or every nested mutation |
| Stored ownership/business permission | Reusable policies in controllers or an authorized custom command | Correctness of an unlocked concurrent invariant |
| Valid source/destination state | State machine | Permission to invoke an action |
| Server-owned input | `readOnly` | Hidden output or permission to filter it |

## Persist and evaluate grants

When the application owns authorization data, model memberships, roles and grants as registered Simfinity entities. Use typed references for their subjects and targets and expose only the administration operations the application needs. Resolve effective grants from authenticated identity and current authority records, or reuse the application’s established authority service. Feed the same policy into generated `scope` callbacks, the auth plugin’s operation and field rules, and session-bound write checks. Bootstrap authority with an explicit administrative or private service path so evaluating a grant does not recursively require the product permission it supplies.

## Scope all read paths

```javascript
const tenantScope = ({ args, context }) => {
  if (!context?.user?.tenantId) throw new auth.UnauthenticatedError();
  args.AND = [...(args.AND || []), {
    conditions: [{ field: 'tenantId', operator: 'EQ', value: context.user.tenantId }],
  }];
};
// On the object type:
const extensions = { scope: {
  find: tenantScope, get_by_id: tenantScope, aggregate: tenantScope,
} };
```

Import `auth` from the installed core package. The snippet assumes a typed tenantId field and a trusted context factory. Scope callbacks mutate arguments; a returned filter is ignored. Use exact supported keys and functions. Preserve the normalized ID predicate; intersect caller OR/AND rather than replacing it. For a server OR, append `{ OR: branches }` inside `args.AND`. An empty permitted-ID set must match nothing, not omit the restriction.

Generated single references run the target's `get_by_id` scope; collections run its `find` scope before paging. Joined client filter/sort/fact paths use the referenced type's `find` restrictions. Check installed capabilities: with `queryFeatures.quantifiers`, collection filters use the target's `find` frame scope and references inside frames use scoped joins, so hidden references read as missing and lists/counts/pages do not repeat roots. Same group/prefix requires one visible child; appending a separate server group can use another. Keep client filter objects/markers and their marked explicit frames; never rebuild or wrap them in trusted quantified groups. Aggregate group/fact paths into scoped collections and unsupported joined paths retain their documented restrictions. Since 3.18.0, declared `elementFrames` supports scoped references and comparisons inside explicit embedded frames; do not carry an earlier blanket ban into those paths. Check the exact installed path/capabilities before diagnosing a 403, and never remove scopes to bypass it. `get_by_id` scopes are trusted and their collection terms use stored frames too, so `NE`/`NIN`/`EQ null` no longer admit childless records after this upgrade. Check each example/application lockfile independently; the library checkout version does not upgrade its registry dependencies. Custom relation resolvers, embedded values, native reads and mutations do not acquire those scope guarantees.

Resolve authorized scope IDs once per request when appropriate, then intersect server predicates. Avoid post-page filtering and stale permission caches. A search index spanning owners needs live authorization or a read model with explicit revocation guarantees; existing scopes do not magically secure arbitrary native searches.

## Authorize operations and writes

Use `createAuthPlugin(permissions, { defaultPolicy: 'DENY' })` through Envelop or its documented schema hook. Map the real names `RootQueryType`, `Mutation`, output types and aggregate result fields. Exact rules replace wildcards; compose them when both conditions are required. A custom rule returning `undefined` grants access, so return an explicit boolean or throw on denial. Missing/malformed context must not fall through to an implicit grant.

`isOwner` examines the resolver parent; a root mutation's parent is not its stored target. Load/check the target with the supplied session in a controller or command. Protect server-owned tenant/owner assignments and check that each referenced target is eligible for the relationship in the same transaction. Existence or readability alone can be insufficient. Nested children run their lifecycle and parent-link check, but not the child root mutation's permission rule: enforce required child permissions in controllers/middleware too.

Read permissions also apply to filter/sort/aggregation paths. Path checks have no record parent, so parent-dependent rules can deny a field even when a particular returned record is readable. Design field permissions and scopes deliberately instead of silently granting paths.

Workers executing graphql-js need auth wrappers installed on that schema, explicit actor grants and fresh contexts. MCP needs the documented `schemaPlugins` path for standalone execution; remote execution uses the remote server's controls. A schema wrapper does not install all HTTP/server request plugins.

## New execution boundaries

Since 3.16.0, the opt-in transaction mutation authorizes its own root and each enclosed generated root operation; it retains the nested-child authorization boundary described above. Grant the transaction field deliberately, retain per-operation rules, and test a denied later operation rolls back earlier writes. Hiding a child root is not a substitute for checking child policy inside nested writes.

`saveObject`, `updateObject`, `deleteObject` and `transitionObject` are lifecycle helpers, not authorization boundaries: they skip root/field GraphQL checks and the record's own global middleware, and can target registered types absent from the exposed schema. Put reusable business authorization in controllers/command policies, pass context, and explicitly authorize the caller. Do not treat a helper or native read as a scoped GraphQL execution.

Standalone MCP needs schema authorization installed independently of HTTP plugins. Transaction tools additionally require `transactionTools: true`; verify effective tool allowlists and permissions in the chosen transport. Client metadata likewise needs its own endpoint gate and does not grant operations.

## Concurrent revocation

State the guarantee the application promises. Checking membership from a transaction snapshot, using a request cache, or supplying a business record's optimistic version does not by itself prevent a concurrent membership revocation from committing first.

When strict coordination is required, choose an application-owned authority revision/lock or equivalent conditional protocol and make both protected operations and every authority writer participate: grants/revocations, role/team changes, administration, jobs and migration-era writers. Scope caches to the request and authorization identity; do not reuse them across sessions or tenants. Keep policy functions reusable across entry points, with transactional checks in controllers/commands rather than a second generic permission framework.

Test revocation between authorization and write with controlled concurrency, not only “revoke, then try again”. Test old workers/admin paths too. If that coordination is outside the current slice, state the narrower guarantee explicitly. For optimistic entities, `get_by_id` scope controls early stale-version visibility; a hidden query root or write controller alone does not establish it. See [optimistic concurrency](https://simtlix.github.io/simfinity.js/guide/concurrency.html).

Sources: [query scopes](https://simtlix.github.io/simfinity.js/guide/query-scope.html), [authorization](https://simtlix.github.io/simfinity.js/guide/authorization.html), [controllers](https://simtlix.github.io/simfinity.js/guide/controllers.html), [MCP](https://simtlix.github.io/simfinity.js/guide/mcp.html).
