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

`extensions.scope` must be a plain object, or an object with a null prototype. Its keys must be `find`, `get_by_id` or `aggregate`, and each value must be a function. Omit a key to leave that operation unscoped. To combine several restrictions, call them from one function; arrays of scope functions are not supported.

`connect()`, `addNoEndpointType()` and `createSchema()` reject any other shape with `INVALID_SCOPE` (500), so a scope can never be skipped silently. This includes misspelled keys such as `getById` or `findAll`, a key set to `undefined`, an array, a bare function, a class instance, and `scope: undefined` or `scope: null`; omit the key or the property instead. Every own string key is checked, including non-enumerable keys defined with `Object.defineProperty()`. The TypeScript `TypeScopes` type accepts `{ find: undefined }`, but the runtime rejects it at startup, so add the key only when it has a function, for example `const scope: TypeScopes = { find: tenantScope }; if (multiTenant) scope.get_by_id = tenantScope;`. Scopes are checked again on every read. If a scope is changed into an invalid shape after `createSchema()`, every read of that type fails with `INVALID_SCOPE`, including relation reads and filter paths that join it.

Use GraphQL field names for filters. A scalar filter has `{ operator, value }`. A related-object filter uses `{ terms: [{ path, operator, value }] }`, as described in [queries](/guide/queries).

`find` and `get_by_id` scopes restrict a field named `aggregation` through `args.aggregation`, like any other field. In an `aggregate` scope, `args.aggregation` is the aggregation expression, so append the restriction to `args.AND` as a group condition instead. Fields named `sort`, `pagination`, `AND` or `OR` can only be restricted with group conditions; see [fields named like query arguments](/guide/queries#fields-named-like-query-arguments).

Assigning a filter to an existing argument replaces the caller's filter. Append a server restriction as an AND group, as above, to retain both. A separate group has its own collection frame and can match a different child; merge conditions into one group when a restriction must share the caller's child witness. For a server rule containing OR, append `{ OR: scopeBranches }` to `args.AND`; assigning `args.OR` would discard the caller's OR. The Barber examples use `intersectScopeFilter` in each backend's `types/scopeHelpers.js` to preserve scalar, relation, ID and logical filters. With an adapter that supports [emptiness through references and collections](/guide/queries#references-and-collections), assigning over or rebuilding a marked client emptiness or collection condition does more than lose it: the request fails with `DETACHED_CLIENT_FILTER` (500), because that condition carries a [marker](#client-and-trusted-conditions) that its target scopes need. See [keep the client's filter objects](/guide/middleware#keep-client-filter-objects).

## Operation behavior

| Operation | Generated endpoint | Scope arguments |
| --- | --- | --- |
| `find` | `series(...)` | Field filters, `AND`/`OR`, sorting, and pagination. |
| `get_by_id` | `serie(id: ...)` | The ID is normalized to `args.id = { operator: 'EQ', value: id }`. |
| `aggregate` | `series_aggregate(...)` | Field filters plus the aggregation expression. |

A scoped ID lookup returns `null` when no record matches both the requested ID and the added restriction. Preserve the normalized ID filter when adding a scope. A `get_by_id` scope is trusted: its collection terms now become stored-data frames on declaring adapters, so `NE`, `NIN` and `EQ null` through a collection no longer admit a record without stored children. This affects generated reference reads and required-ID reads. Client filter frames use `find`, not `get_by_id`; the two scopes can intentionally admit different records.

Scopes run after [global middleware](/guide/middleware) and modify the same `args` object that is sent to the database adapter, including when list, aggregate or collection-relationship middleware replaces `params.args`; such a replacement must carry the client's filter objects, not rebuilt copies of them. Flat filters, including the filters added by a scope, are combined with user `AND`/`OR` conditions at the top level using AND. A user-provided OR does not remove that restriction.

## Relationship paths in filters, sorts and aggregations

Filter, sort, `groupId` and fact paths can name fields of related types, such as `author.email` on a post. When a client-supplied path crosses a non-embedded single reference to a type whose scope defines `find`, Simfinity calls that `find` scope with empty `args` and the request context after the root scope runs. It moves the conditions the scope adds below the relation path, so `tenant` becomes `author.tenant`, and ANDs them with the query. When a client uses the path only in `AND`/`OR` group conditions, the conditions are ANDed into each group that uses it instead, so an `OR` alternative that does not name the reference keeps its matches. Any other use (a field filter, relation `terms`, a sort, `groupId` or fact path) restricts the whole query, as does a group that middleware or a scope replaced, or a group nested so deeply that adding the scope would exceed the five-level filter depth limit. Each relation path is scoped once, and a path through several scoped references applies each target's scope. Collection-frame filters and a client's `IS_EMPTY` and `IS_NOT_EMPTY` conditions are the exception: they apply the scope inside the condition instead; see [emptiness through references and collections](#emptiness-through-references-and-collections).

On adapters that declare `queryFeatures.quantifiers`, a client collection filter uses the child's `find` scope inside its frame, and single references inside frames use scoped joins. The scope runs after middleware and the query's own scope, with empty arguments, `operation: 'find'` and the context, once per call and target type. It decides which elements exist before `ANY`, `ALL` or `NONE` tests them; hidden references read as missing. Separate groups may use different children, while conditions in one group on the same collection prefix need one child. Legacy single-reference paths outside frames retain the group/query-level joined scopes above.

Joined scopes cache by relation prefix, while frame and scoped-join scopes cache by target type. A type reached both ways runs its `find` scope twice in one resolver call; each cache still runs its entry once.

A joined `find` scope may filter through a non-embedded collection on a declaring adapter: membership-based tenancy such as `args.memberships = { terms: [{ path: 'org', value: org }] }` compiles as a trusted frame without repeating roots. The rejection remains when the client's prefix reaches that type through an embedded list, such as `olines.shop`, including an explicit quantified reference in the target scope; that diagnostic names the quantified reference and the embedded-list prefix. Scopes reaching a non-embedded reference inside an embedded list, such as `roles.org.id`, still give `FORBIDDEN_FILTER_PATH` when restrictive. A client reference crossing inside an embedded list before or inside a collection frame also gives 403 if its target scope adds conditions; an empty scope and trusted paths keep plain vector joins. `groupId` and fact paths into a scoped collection, references after aggregate join prefixes, and adapters without `quantifiers` retain their legacy restrictions. Do not remove scopes to bypass them.

Write these `find` scopes with the documented filter forms: flat filters, relation `terms`, and `AND`/`OR` groups. `args.aggregation` is joined like any other field filter, and fails with `INVALID_FILTER_FIELD` (400) when the scoped type declares no such field. Sort and pagination values they set are checked for shape (non-empty sort terms, each with a field name and an `ASC` or `DESC` order, and a page and size that a direct query accepts), failing with `INVALID_SORT` or `INVALID_PAGINATION` (400), and are then ignored; sort field names are not resolved. A shorthand relation filter without terms is rejected; a quantified relation filter may omit terms. Raw joined-scope arguments are validated on the target before prefixing and before prefix restrictions, so a scope invalid in itself keeps its own error. Invalid client fields and values reject before frame-count limits and middleware; on MongoDB, `INVALID_FILTER_VALUE` (400) now uses `Filter lists require non-null scalar elements` for null elements in `IN`/`NIN`/`BTW` (formerly `<OP> does not accept null elements`), `Expected a scalar filter value` for null ordered/`LIKE` values (formerly `<OP> does not accept null` or `LIKE requires a string field and string value`), and `BTW requires two values` for a wrong-sized list (formerly `BTW requires exactly two values`). Existing sort-shape diagnostics are preserved. Paths added by middleware or scope functions are trusted and do not trigger joined scopes, and their `IS_EMPTY` and `IS_NOT_EMPTY` conditions read stored data; see [client and trusted conditions](#client-and-trusted-conditions). Fields that clients may not query at all are described under [path restrictions](/guide/queries#path-restrictions).

### Emptiness through references and collections

A client's [`IS_EMPTY` or `IS_NOT_EMPTY`](/guide/queries#references-and-collections) condition gets no joined scope. With an adapter that declares `queryFeatures.referenceEmptiness`, as both bundled adapters do, it reads each reference it crosses, and each reference or collection it ends at or reads as a member of an embedded object, through that target type's `find` scope. Each such scope runs once per list, aggregate or collection-field call and target type, with empty `args`, `operation: 'find'` and the request context, after middleware and the query's own scope, so it sees what middleware set on the context. The scope applies inside the condition, at the reference or collection it restricts, and never to the group or the whole query: a crossed reference joins its target only when the scope admits it, and a reference or collection that the condition ends at counts only the records that the scope admits, before the condition tests them. A scoped-out record therefore reads exactly like a missing one, so `serie IS_EMPTY` holds for a season whose serie the caller may not see, and no emptiness condition depends on hidden records, whether or not the scope's conditions accept `null`. The sort and pagination such a scope sets are checked for shape and ignored, and its conditions are checked on its own type with the codes that type's list query gives them, such as `INVALID_MODEL` (500) for a path through a virtual field. With another adapter, the condition fails with `UNSUPPORTED_QUERY` (400) before any scope runs.

The `FORBIDDEN_FILTER_PATH` checks above guard joined scopes only. A scope applied inside an emptiness condition never repeats a record, so a client's emptiness condition on a scoped collection, or on a reference to a type whose scope filters through a collection or through a reference inside an embedded list, runs with that scope instead of failing with 403. A restricted caller's `seasons: { terms: [{ operator: IS_EMPTY }] }` returns the series without a season that the `Season` scope admits, and `seasons.number` with another operator uses a collection frame on quantifier-capable adapters. The undeclared-adapter 403 remains.

The reference field itself resolves through the target type's `get_by_id` scope, while emptiness uses its `find` scope. When the `get_by_id` scope is stricter, a record can match `serie IS_NOT_EMPTY` and still read `serie: null`; when it is more permissive, a record can match `serie IS_EMPTY` and still read a serie. Give both scopes the same restriction when clients compare the two.

### Client and trusted conditions

Client conditions are the ones the client sent. Every other condition is trusted: those that middleware, the query's own scope, joined scopes and `get_by_id` scopes add, the target scopes that client emptiness conditions apply, and the arguments that server code passes to `createQueryPlan()`, or to MongoDB's `buildQuery()` and `buildFilterGroupMatch()`. A trusted `IS_EMPTY` or `IS_NOT_EMPTY` reads stored data, whoever the caller is: a reference is empty when no stored reference resolves to an existing record, a collection when no stored child references the record, and a field through references is read through plain joins, without target scopes. On MongoDB, a reference to a record that no longer exists counts as empty; PostgreSQL's foreign keys keep a reference from pointing to a missing record. A `Season` scope that adds `{ field: 'serie', operator: 'IS_EMPTY' }` thus selects the seasons that store no existing serie, for every caller. The scopes that client conditions apply are trusted too, so a scope never runs another scope.

Before middleware, the runtime copies each call's filter arguments, including quantified groups, then marks eligible client constructs with enumerable `__scope: { id }` only when a relation on their absolute chain has a registered `find` scope. This includes explicit collection/reference groups and their marked descendants, shorthand collection predicates outside aggregate join prefixes, and emptiness constructs; legacy reference-only and all-join aggregate predicates retain their joined scopes. After middleware and the query's own scope it checks every issued marker, validates final arguments, then fills scope keys relative to each containing frame. Copy or edit client objects and append restrictions. Dropping/rebuilding one, parking its marker only in ignored scalar terms, wrapping it in an unmarked explicit frame, changing an ordinary shorthand prefix's aggregate-join membership, or aliasing a relative key to different target types gives `DETACHED_CLIENT_FILTER` before the adapter. An operator/path edit that still reads relations is allowed only when the final construct can receive its scope: an emptiness condition, an explicit quantified group, a condition inside a frame, or shorthand through a collection outside aggregate joined prefixes J. Changing marked `shop.name IS_EMPTY` to `shop.name EQ "S1"` outside a frame still gives `DETACHED_CLIENT_FILTER` (500), because the final reference-only predicate cannot receive its client scope. Narrowing to an own field removes the marker. Unscoped collection conditions need no marker and can still be rebuilt. See [keep client filter objects](/guide/middleware#keep-client-filter-objects).

### Legacy joined scopes beside emptiness conditions

Every legacy client path through a single reference outside a collection frame keeps its joined scope: a condition with another operator, the [text operators](/guide/queries#text-operators) included, a sort, a `groupId` or a fact path. Such a joined scope also restricts the emptiness conditions of the group it is ANDed into, or of the whole query, so the combination can tell hidden records from missing ones, as conditions with other operators alone already can. For example, a caller whom the `Serie` scope restricts sends `serie: { terms: [{ operator: IS_EMPTY }] }` together with `sort: { terms: [{ field: "serie.name", order: ASC }] }`, whose joined scope restricts the whole query:

- Under a scope whose conditions reject `null`, such as `state EQ "OPEN"`, the query returns no season: the joined scope removes both the seasons without a serie and those whose serie it hides.
- Under a scope whose conditions accept `null`, such as `name NE "Draft"`, the query returns the seasons without a serie and drops those whose serie it hides, which `serie IS_EMPTY` alone would return.

A condition with another operator restricts only its own group: in `OR: [{ conditions: [{ field: "serie", path: "name", operator: EQ, value: "Dark" }] }, { conditions: [{ field: "serie", operator: IS_NOT_EMPTY }] }]`, the first group gets the joined scope and the second reads the serie through its frame, so neither returns a season whose serie the caller may not see. Placed in the same group, as in `conditions: [{ field: "serie", path: "name", operator: EQ, value: "Dark" }, { field: "serie", operator: IS_NOT_EMPTY }]`, the joined scope restricts the emptiness condition too. Sort by a field of the queried record, or keep such conditions in separate groups, when hidden and missing records must read alike.

### Emptiness in joined scopes

A `find` scope may use emptiness, collection shorthand and explicit quantified groups on adapters that support them. In a client frame or scoped join it tests the target type's own fields, as a trusted condition without recursive scopes. Outside frames, legacy client paths prefix its conditions below the single reference. A prefixed emptiness condition through a list remains `INVALID_FILTER_PATH` for an embedded-list prefix, for aggregate `groupId`/fact and J-prefix filter paths, and on adapters without `quantifiers`. For a client collection filter on a declaring adapter, the reference is a scoped join inside the frame, so that invalid prefixed condition is never built. This narrows the collection case called permanent in the 3.10.0 and 3.11.0 notes; the embedded-list and legacy aggregate cases stay rejected.

On adapters that declare `quantifiers`, filters into scoped collections run frame scopes, and paths into types whose scopes filter through collections run those scopes as trusted frames, including scopes using emptiness. The retained 403s apply to `groupId` and facts into scoped collections, scopes reaching references inside embedded lists, embedded-list prefixes, and undeclared adapters. Raw scope validation precedes these prefix restrictions: `IS_EMPTY` with a non-null value reports its raw `INVALID_FILTER_VALUE`, and a pathless ordinary relation term reports `INVALID_FILTER_PATH` (`Relationship terms require a path`), rather than an error on a fabricated prefixed path. A raw-valid scope still receives the subsequent prefix checks.

## Scope boundaries

Generated non-embedded single relationships run the target type's `get_by_id` middleware and scope. Generated collection relationships run the target type's `find` middleware and scope. Both receive the same request context and await asynchronous callbacks. A scoped-out single relationship returns `null`; scoped-out children are omitted from a collection.

The referenced ID or stored parent connection is enforced by a separate database predicate, so middleware, scope filters, and user `OR` conditions cannot redirect a relationship to another record or parent. Scope filtering and the parent constraint are applied before collection pagination.

Custom relationship resolvers are preserved and must implement their own data restrictions. Scope hooks do not automatically run for embedded values, direct Mongoose/PostgreSQL native access, `saveObject`, or mutations. Nested collection mutations enforce parent ownership and run child operation middleware, but their write permissions remain separate from query scopes.

Combine scope with [authorization](/guide/authorization) for operation and field permissions, and with [controller checks](/guide/controllers) for writes. A scope alone is not a complete tenant authorization policy.
