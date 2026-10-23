# Access boundaries

| Boundary | Mechanism | Does not imply |
| --- | --- | --- |
| Authenticated identity | Application authentication/context | Permission to every operation |
| Which records are visible | `scope.find`, `scope.get_by_id`, `scope.aggregate` | Permission to write them |
| Operations and output fields | `createAuthPlugin` permission map | Automatic checks for native code or every nested mutation |
| Stored ownership/business permission | Controllers or appropriate middleware/custom command | Correctness of an unlocked concurrent invariant |
| Valid source/destination state | State machine | Permission to invoke an action |
| Server-owned input | `readOnly` | Hidden output or permission to filter it |

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

Generated single references run the target's `get_by_id` scope; collections run its `find` scope before paging. Joined client filter/sort/fact paths use the referenced type's `find` restrictions. Check installed capabilities: with `queryFeatures.quantifiers`, collection filters use the target's `find` frame scope and references inside frames use scoped joins, so hidden references read as missing and lists/counts/pages do not repeat roots. Same group/prefix requires one visible child; appending a separate server group can use another. Keep client filter objects/markers and their marked explicit frames; never rebuild or wrap them in trusted quantified groups. Aggregate group/fact paths into scoped collections, restrictive references inside embedded lists and embedded-list prefixes retain documented 403s, as do undeclared adapters; do not remove scopes to bypass them. `get_by_id` scopes are trusted and their collection terms use stored frames too, so `NE`/`NIN`/`EQ null` no longer admit childless records after this upgrade. The checked-in Barber 3.8.0 applications retain their registry behaviour. Custom relation resolvers, embedded values, native reads and mutations do not acquire those scope guarantees.

Resolve authorized scope IDs once per request when appropriate, then intersect server predicates. Avoid post-page filtering and stale permission caches. A search index spanning owners needs live authorization or a read model with explicit revocation guarantees; existing scopes do not magically secure arbitrary native searches.

## Authorize operations and writes

Use `createAuthPlugin(permissions, { defaultPolicy: 'DENY' })` through Envelop or its documented schema hook. Map the real names `RootQueryType`, `Mutation`, output types and aggregate result fields. Exact rules replace wildcards; compose them when both conditions are required. A custom rule returning `undefined` grants access, so return an explicit boolean or throw on denial. Missing/malformed context must not fall through to an implicit grant.

`isOwner` examines the resolver parent; a root mutation's parent is not its stored target. Load/check the target with the supplied session in a controller or command. Protect server-owned tenant/owner assignments and cross-tenant references. Nested children run their lifecycle and parent-link check, but not the child root mutation's permission rule: enforce required child permissions in controllers/middleware too.

Read permissions also apply to filter/sort/aggregation paths. Path checks have no record parent, so parent-dependent rules can deny a field even when a particular returned record is readable. Design field permissions and scopes deliberately instead of silently granting paths.

Workers executing graphql-js need auth wrappers installed on that schema, explicit actor grants and fresh contexts. MCP needs the documented `schemaPlugins` path for standalone execution; remote execution uses the remote server's controls. A schema wrapper does not install all HTTP/server request plugins.

Sources: [query scopes](https://simtlix.github.io/simfinity.js/guide/query-scope.html), [authorization](https://simtlix.github.io/simfinity.js/guide/authorization.html), [controllers](https://simtlix.github.io/simfinity.js/guide/controllers.html), [MCP](https://simtlix.github.io/simfinity.js/guide/mcp.html).
