---
title: Query scope
description: Apply server-controlled filters to list, single-record, and aggregation queries.
---

# Query scope

Scope functions add server-controlled filters before generated root queries reach MongoDB. Use them to restrict records by tenant, owner, or another field in your GraphQL model.

<DomainDiagram kind="access" />

## Define a shared scope

This example declares a `tenantId` field and applies the same restriction to all three root query operations. The tenant ID must come from authenticated server context.

```javascript
import { GraphQLObjectType, GraphQLID, GraphQLString } from 'graphql';
import * as simfinity from '@simtlix/simfinity-js';

const tenantScope = async ({ args, context }) => {
  if (!context?.user?.tenantId) {
    throw new simfinity.auth.UnauthenticatedError();
  }
  args.tenantId = { operator: 'EQ', value: context.user.tenantId };
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
| `args` | Mutable query arguments used to construct the MongoDB pipeline. |
| `operation` | `find`, `get_by_id`, or `aggregate`. |
| `context` | The application's GraphQL context. |

Use GraphQL field names for filters. A scalar filter has `{ operator, value }`. A related-object filter uses `{ terms: [{ path, operator, value }] }`, as described in [queries](/guide/queries).

## Operation behavior

| Operation | Generated endpoint | Scope arguments |
| --- | --- | --- |
| `find` | `series(...)` | Field filters, `AND`/`OR`, sorting, and pagination. |
| `get_by_id` | `serie(id: ...)` | The ID is normalized to `args.id = { operator: 'EQ', value: id }`. |
| `aggregate` | `series_aggregate(...)` | Field filters plus the aggregation expression. |

A scoped ID lookup returns `null` when no record matches both the requested ID and the added restriction. Preserve the normalized ID filter when adding a scope.

Scopes run after [global middleware](/guide/middleware). Flat filters, including the filters added by a scope, are combined with user `AND`/`OR` conditions at the top level using AND. A user-provided OR does not remove that restriction.

## Scope boundaries

Scope hooks apply to these generated root queries. They do not automatically run for generated relationship resolvers, direct Mongoose access, `saveObject`, or mutations. Keep relationships within the same authorization boundary, or supply custom relationship resolvers that apply the necessary restrictions.

Combine scope with [authorization](/guide/authorization) for operation and field permissions, and with [controller checks](/guide/controllers) for writes. A scope alone is not a complete tenant authorization policy.
