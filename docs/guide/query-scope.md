---
title: Query scope
description: Apply server-controlled filters to list, single-record, and aggregation queries.
---

# Query scope

Scope functions add server-controlled filters before generated root queries and non-embedded relationship reads reach the selected database adapter. They also restrict the referenced records that client filter, sort and aggregation paths reach. Use them to restrict records by tenant, owner, or another field in your GraphQL model.

<DomainDiagram kind="access" />

Examples use the selected runtime from [database setup](./databases#runtime-setup-for-shared-examples). After `createSchema()`, PostgreSQL also requires awaited storage initialization before operations are served.

## Define a shared scope

This example declares a `tenantId` field and applies the same restriction to all three root query operations. The tenant ID must come from authenticated server context.

```javascript
import { GraphQLObjectType, GraphQLID, GraphQLString } from 'graphql';
import { simfinity } from './runtime.js';

const tenantScope = async ({ args, context }) => {
  if (!context?.user?.tenantId) {
    throw new simfinity.auth.UnauthenticatedError();
  }
  args.AND = [
    ...(args.AND || []),
    { conditions: [{ field: 'tenantId', operator: 'EQ', value: context.user.tenantId }] },
  ];
};

const SerieType = new GraphQLObjectType({
  name: 'Serie',
  extensions: {
    scope: {
      find: tenantScope,
      get_by_id: tenantScope,
      aggregate: tenantScope,
    },
  },
  fields: {
    id: { type: GraphQLID },
    name: { type: GraphQLString },
    tenantId: {
      type: GraphQLString,
      extensions: { readOnly: true },
    },
  },
});

simfinity.connect(null, SerieType, 'serie', 'series', {
  onSaving(doc, args, session, context) {
    if (!context?.user?.tenantId) {
      throw new simfinity.auth.UnauthenticatedError();
    }
    doc.tenantId = context.user.tenantId;
  },
});
```

The create hook sets the server-owned tenant field. Update and delete authorization must be enforced separately before changing a record.

## Callback contract

```javascript
async function scope({ type, args, operation, context }) {
  // Mutate args in place. The return value is not used as a filter.
}
```

| Property | Meaning |
| --- | --- |
| `type` | Registered type metadata, including `gqltype` and `model`. |
| `args` | Mutable query arguments used to construct the validated database query plan. |
| `operation` | `find`, `get_by_id`, or `aggregate`. |
| `context` | The application's GraphQL context. |

Use GraphQL field names for filters. A scalar filter has `{ operator, value }`. A related-object filter uses `{ terms: [{ path, operator, value }] }`, as described in [queries](/guide/queries).

Assigning a filter to an existing argument replaces the caller's filter. Append a server restriction as an AND group, as above, to retain both. For a server rule containing OR, append `{ OR: scopeBranches }` to `args.AND`; assigning `args.OR` would discard the caller's OR. The Barber examples use `intersectScopeFilter` in each backend's `types/scopeHelpers.js` to preserve scalar, relation, ID and logical filters.

## Operation behavior

| Operation | Generated endpoint | Scope arguments |
| --- | --- | --- |
| `find` | `series(...)` | Field filters, `AND`/`OR`, sorting, and pagination. |
| `get_by_id` | `serie(id: ...)` | The ID is normalized to `args.id = { operator: 'EQ', value: id }`. |
| `aggregate` | `series_aggregate(...)` | Field filters plus the aggregation expression. |

A scoped ID lookup returns `null` when no record matches both the requested ID and the added restriction. Preserve the normalized ID filter when adding a scope.

Scopes run after [global middleware](/guide/middleware) and modify the same `args` object that is sent to the database adapter, including when list, aggregate or collection-relationship middleware replaces `params.args`. Flat filters, including the filters added by a scope, are combined with user `AND`/`OR` conditions at the top level using AND. A user-provided OR does not remove that restriction.

## Relationship paths in filters, sorts and aggregations

Filter, sort, `groupId` and fact paths can name fields of related types, such as `author.email` on a post. When a client-supplied path crosses a non-embedded single reference to a type whose scope defines `find`, Simfinity calls that `find` scope with empty `args` and the request context after the root scope runs. It moves the conditions the scope adds below the relation path, so `tenant` becomes `author.tenant`, and ANDs them with the query. When a client uses the path only in `AND`/`OR` group conditions, the conditions are ANDed into each group that uses it instead, so an `OR` alternative that does not name the reference keeps its matches. Any other use (a field filter, relation `terms`, a sort, `groupId` or fact path) restricts the whole query, as does a group that middleware or a scope replaced, or a group nested so deeply that adding the scope would exceed the five-level filter depth limit. Each relation path is scoped once, and a path through several scoped references applies each target's scope.

A relation filter therefore cannot confirm facts about a scoped-out record. When that scope restricts the caller, sorting or grouping through the reference also omits rows whose referenced record it excludes, including rows without a reference. A client path that enters a collection relation fails with `FORBIDDEN_FILTER_PATH` (403) when the collection type's `find` scope adds conditions for the caller, because a per-child scope cannot be correlated with the collection match. Callers for whom that scope adds nothing, such as administrators whose scope returns early, may use the path.

A joined `find` scope must not filter through a non-embedded collection relation, or through a non-embedded reference inside an embedded list. For example, membership-based tenancy on `User` (`args.memberships = { terms: [{ path: 'org', value: org }] }`) would become `author.memberships.org` on a post, and the join through the memberships would repeat a post once per matching membership in lists, counts and aggregate facts. Likewise, `args.roles = { terms: [{ path: 'org.id', operator: 'IN', value: orgIds }] }`, where `roles` is an embedded list of objects that reference `Org`, joins the organization once per role. Whenever such a scope adds conditions for the caller, a client path into its type fails with `FORBIDDEN_FILTER_PATH` and names the collection or reference. Callers for whom the scope adds nothing are unaffected. To allow these paths, express the scope with fields of the scoped type itself or its single references, such as a stored tenant field. Scalar fields of embedded lists, including fields of their embedded objects such as `roles.level`, are not joined and may be used.

Write these `find` scopes with the documented filter forms: flat filters, relation `terms`, and `AND`/`OR` groups. Sort and pagination values they set are ignored, and a relation filter without terms is rejected. Paths added by middleware or scope functions are trusted and do not trigger joined scopes. Fields that clients may not query at all are described under [path restrictions](/guide/queries#path-restrictions).

## Scope boundaries

Generated non-embedded single relationships run the target type's `get_by_id` middleware and scope. Generated collection relationships run the target type's `find` middleware and scope. Both receive the same request context and await asynchronous callbacks. A scoped-out single relationship returns `null`; scoped-out children are omitted from a collection.

The referenced ID or stored parent connection is enforced by a separate database predicate, so middleware, scope filters, and user `OR` conditions cannot redirect a relationship to another record or parent. Scope filtering and the parent constraint are applied before collection pagination.

Custom relationship resolvers are preserved and must implement their own data restrictions. Scope hooks do not automatically run for embedded values, direct Mongoose/PostgreSQL native access, `saveObject`, or mutations. Nested collection mutations enforce parent ownership and run child operation middleware, but their write permissions remain separate from query scopes.

Combine scope with [authorization](/guide/authorization) for operation and field permissions, and with [controller checks](/guide/controllers) for writes. A scope alone is not a complete tenant authorization policy.
