# Optional application linting

`@simtlix/eslint-plugin-simfinity` provides fourteen error rules and one opt-in advice rule for the
**Simfinity 3.8.0** contract, shared by MongoDB and PostgreSQL. It complements the
[application skills](./ai-project-bootstrap) and [usage guidance](./anti-patterns)
with specific editor/CI diagnostics. It does not evaluate business authorization,
scopes, state machines or transaction correctness.

The plugin is an independently versioned development tool (`0.5.0`), outside the
six runtime packages. Install it from npm in your application:

```sh
npm install --save-dev 'eslint@^9.30.1' '@simtlix/eslint-plugin-simfinity@0.5.0'
```

Version 0.5.0 completes the bounded modeling catalogue in #116. It adds
`valid-model-fields`, `valid-model-storage` and `valid-model-schema`, and extends
`valid-connection-field` and `no-schema-cloning`. Upgrading can report new errors
in `recommended-3.8`. Accepted but potentially surprising modeling choices are
reported only by `modeling-advice` in the opt-in `advice-3.8` preset. Both presets
retain the explicit Simfinity 3.8.0 contract.

Version 0.3.1 recognizes Simfinity 3.12.0 `registerView()` calls and preserves type tracking through TypeScript-wrapped options. It adds no rule and does not change the `recommended-3.8` preset contract.

Version 0.3.0 adds `valid-policy-expression` (AUTH-11) to `recommended-3.8`.
Upgrading can report malformed policies that earlier plugin versions did not diagnose.
Version 0.2.0 added `no-async-auth-extractor` and `no-auth-plugin-as-middleware`
to the eight rules in 0.1.0. These three authorization contracts were revalidated
against both Simfinity 3.8.0 and 3.10.0; this does not certify every rule for newer runtimes.

Use Node.js 24 for development. The plugin supports ESLint 9.30.1–9.x, ESM flat
config and Node.js `^18.18.0 || ^20.9.0 || >=21.1.0`. Selecting this preset explicitly
selects the 3.8.0 runtime contract; it does not detect your installed runtime or
claim support for a different Simfinity version.

```javascript
// eslint.config.mjs
import simfinity from '@simtlix/eslint-plugin-simfinity';

export default [simfinity.configs['recommended-3.8']];
```

For TypeScript, install `@typescript-eslint/parser` as a development dependency:

```javascript
import simfinity from '@simtlix/eslint-plugin-simfinity';
import parser from '@typescript-eslint/parser';

export default [
  { ...simfinity.configs['recommended-3.8'], files: ['**/*.{js,mjs,ts,mts,tsx}'] },
  { files: ['**/*.{ts,mts,tsx}'], languageOptions: { parser } },
];
```

All fourteen recommended rules are errors. Advice is separately opt-in:

```javascript
export default [
  simfinity.configs['recommended-3.8'],
  simfinity.configs['advice-3.8'], // enables only modeling-advice at warning severity
];
```

Both presets use the same plugin instance. To opt out of a rule, add a later flat
config entry, for example `{ rules: { 'simfinity/valid-query-limits': 'off' } }`.
Each diagnostic reports the rule ID, source location, violated contract and
suggested action. None supplies automatic source fixes.

## no-schema-cloning

Reports imported `graphql-middleware.applyMiddleware` or
`@graphql-tools/utils.mapSchema` receiving a locally proven Simfinity schema.
Rebuilding the schema duplicates its globally injected introspection types.
Use [Envelop authorization](./authorization) or in-place resolver wrapping.

```javascript
import * as simfinity from '@simtlix/simfinity-js';
import { mapSchema } from '@graphql-tools/utils';

const schema = simfinity.createSchema();
mapSchema(schema, {}); // simfinity/no-schema-cloning
```

The same check follows `createRuntime`, `createSQL` and `createPostgres` instances.
It also reports `buildClientSchema(introspectionFromSchema(schema))` when the
same-process schema provenance is proven, including stable aliases. The 3.8
introspection metadata causes duplicate type identities during reconstruction.
A `new GraphQLSchema(schema.toConfig())` copy preserves identities and is accepted;
passing that copy to a known cloner is still diagnosed. External/JSON introspection,
pre-import independent schemas, SDL roundtrips and unknown provenance are not
reported. The preset does not assume later runtime introspection opt-out features.

## no-uncalled-auth-factory

A factory returns a rule; the factory itself does not perform that rule's check.
Pass the returned rule to the permission map or `composeRules`/`anyRule`:

```javascript
import { createAuthPlugin, requireAuth, requireRole } from '@simtlix/simfinity-core/auth';

createAuthPlugin({ RootQueryType: { books: requireAuth } }); // diagnostic

createAuthPlugin({
  RootQueryType: { books: requireAuth() },
  Mutation: { '*': requireRole('admin') },
});
```

Known factories include `requireAuth`, `requireRole`, `requirePermission`,
`isOwner`, `allow`, `deny`, `createRule`, `createRuleFromExpression`, `composeRules`
and `anyRule`. Custom rule functions and policy expressions remain valid.
The plugin cannot choose a role or permission for the application.

## valid-default-policy

`createAuthPlugin` accepts `ALLOW` or `DENY`. Omitted/undefined defaults to `DENY`.
The check concerns accepted values, not whether a policy suits the application:

```javascript
import { createAuthPlugin } from '@simtlix/simfinity-core/auth';

createAuthPlugin({}, { defaultPolicy: 'deny' }); // diagnostic: case matters
createAuthPlugin({}, { defaultPolicy: 'DENY' }); // valid configuration
createAuthPlugin({}, { defaultPolicy: 'ALLOW' }); // also valid configuration
```

Review [authorization](./authorization) and [row visibility scopes](./query-scope)
together. A valid default policy alone does not provide tenant isolation.

## valid-permissions

`createAuthPlugin` requires a plain or null-prototype object mapping type names
to field-rule maps. A field rule can be a function, boolean, valid policy
expression or nonempty dense array of rules (including nested arrays).

```javascript
import { createAuthPlugin, requireAuth } from '@simtlix/simfinity-core/auth';

createAuthPlugin(null); // diagnostic: a permission map is required
createAuthPlugin({ Book: [] }); // diagnostic: a type needs a field-rule map
createAuthPlugin({ Book: { title: undefined } }); // diagnostic: invalid rule
createAuthPlugin({ Book: { title: [requireAuth(), , true] } }); // diagnostic: hole

createAuthPlugin({ Book: { title: [requireAuth(), { allOf: [] }] } });
createAuthPlugin({ Book: { title: true, summary: false } });
```

An omitted field uses the default policy; explicit `undefined` is invalid even
under `ALLOW`. Choose the intended rule before removing an entry. Empty maps are
valid, while `{}` in a field-rule slot is not a valid expression.

The check inspects inline maps/arrays and known primitive constants. It leaves
constructor/call results, object/array aliases and nonempty policy-expression
objects unknown. It does not validate the expression DSL, match permission keys
against the schema or inspect the deprecated middleware factories. Nested rule
inspection is bounded to 200 nodes per plugin call.

## valid-policy-expression

**Added in plugin 0.3.0.** This check validates syntax in
the first argument to `createRuleFromExpression` and in nonempty inline expressions
inside `createAuthPlugin` permission maps, including nested rule arrays. It reports
proven contract errors without deciding the application's permissions.

```javascript
import { createAuthPlugin, createRuleFromExpression } from '@simtlix/simfinity-core/auth';

createRuleFromExpression({ eq: [{ ref: 'context.user.id' }, 1] }); // diagnostic: use ctx
createRuleFromExpression({ eq: [1] }); // diagnostic: exactly two operands
createAuthPlugin({ Book: { title: { anyOf: [true, { unknown: true }] } } }); // diagnostic
createRuleFromExpression({ in: [{ ref: 'ctx.id' }, [{ ref: 'parent.id' }]] }); // diagnostic: nested literal ref

createRuleFromExpression({ eq: [{ ref: 'ctx.user.id' }, { ref: 'parent.ownerId' }] });
createRuleFromExpression({ in: [{ ref: 'ctx.id' }, { ref: 'args.allowedIds' }] });
createAuthPlugin({ Book: { title: { allOf: [] }, summary: { anyOf: [] } } }); // valid syntax
```

`eq` and `in` take dense two-element arrays. `allOf` and `anyOf` take dense arrays
of expressions; empty arrays remain valid logical identities. `not` takes an
expression. Unknown operators invalidate the AST even inside an `anyOf` with a
valid true branch. Multiple operator keys retain implicit AND semantics.

References must contain only `ref`, use `parent`, `args` or `ctx`, and have no empty,
`__proto__`, `prototype` or `constructor` segments. Root and array-index paths are
valid. References nested inside literals are not resolved by the runtime and are
rejected. A literal `in` list can contain null, booleans, strings, finite numbers,
bigints or genuine ObjectIds; the lint rule does not infer constructor results.
Undefined, NaN and function operands are invalid. Explicit null and object/array,
RegExp or Date equality literals remain supported where the runtime accepts them.

The analysis reads inline containers and safe primitive aliases, with a traversal
budget of 200 per recognized call. Oversized containers, object/array aliases,
dynamic values, call/constructor results, spreads, computed properties, getters and
method syntax remain unknown. Empty/invalid permission rules already diagnosed by
`valid-permissions` do not receive duplicate expression errors. Direct calls to
`isPolicyExpression` or `evaluateExpression` remain available for intentional
invalid-input validation. Valid syntax does not imply a grant: comparison types,
runtime reference values and application authorization intent are outside this rule.

## valid-auth-composition

`composeRules` and `anyRule` require at least one argument, and every argument
must be a function. `createRule` requires a predicate function as its first
argument; its later error-message/code arguments are unaffected.

```javascript
import { anyRule, composeRules, createRule, createRuleFromExpression, requireAuth } from '@simtlix/simfinity-core/auth';

anyRule(); // diagnostic: missing rules
composeRules({ eq: [{ ref: 'ctx.user.role' }, 'editor'] }); // diagnostic: not a function
createRule(false); // diagnostic: not a predicate function

composeRules(requireAuth(), createRuleFromExpression({ eq: [{ ref: 'ctx.user.role' }, 'editor'] }));
createRule(async (_parent, _args, ctx) => Boolean(await ctx.canRead()));
```

Booleans, arrays and expression objects are valid in the corresponding
permission-map slots, but composition requires functions. Async/custom functions
remain supported; the rule does not inspect their return values or business
logic. Unknown arguments and spread calls are skipped. The existing
`no-uncalled-auth-factory` rule separately detects a factory used as a rule.

## valid-required-claims

`requireRole` and `requirePermission` require a nonempty string or a nonempty
dense array of nonempty strings. Role lists use OR; permission lists use AND.

```javascript
import { requireRole, requirePermission } from '@simtlix/simfinity-core/auth';

requireRole([]); // diagnostic
requirePermission(['read', '']); // diagnostic
requirePermission(['read', undefined]); // diagnostic

requireRole(['admin', 'editor']); // either role
requirePermission(['read', 'write']); // both permissions
```

Whitespace is accepted without trimming, matching 3.8.0. The rule diagnoses
known invalid names and inline lists; dynamic names, aliased lists and spreads
remain unknown. It does not inspect the user's claims, recommend role names or
validate the extractor options (covered in part by the separate rule below).

## no-async-auth-extractor

Built-in authorization helpers read paths synchronously. Passing an `async`
function or an async generator as an extractor throws when creating the rule:

```javascript
import { requireAuth, requireRole, createRule } from '@simtlix/simfinity-core/auth';

requireAuth(async context => context.user); // diagnostic
requireRole('admin', { rolePath: async user => user.role }); // diagnostic

requireAuth(context => context.user); // data already resolved by the context
createRule(async (_parent, _args, context) => Boolean(await loadUser(context)));
```

The async custom rule illustrates an application-supplied `loadUser` function;
the linter does not infer that application's access policy or rewrite it.
Prefer resolving shared identity data once when building the GraphQL context.

Checked positions are `requireAuth(userPath)`, `requireRole` options
`userPath`/`rolePath`, `requirePermission` options `userPath`/`permissionsPath`,
and `isOwner(ownerField, userIdField, { userPath })`. Inline async functions,
async generators and stable local `const` aliases are supported. Options must
be inline plain objects; duplicate properties use the last value.

Unknown imports/calls, function declarations, option aliases, getters, method
shorthand, computed keys and spreads are skipped. Ordinary functions returning
promises are not inferred; the runtime rejects those results when evaluated.
Synchronous generators are outside this check because the runtime does not reject
them at creation. Async custom permission rules are valid and remain untouched.

## no-auth-plugin-as-middleware

Simfinity `use()` requires a middleware function. `createAuthPlugin()` returns an
Envelop plugin object, so passing it to `use()` throws `INVALID_MIDDLEWARE`:

```javascript
import * as simfinity from '@simtlix/simfinity-postgres';
import { createAuthPlugin } from '@simtlix/simfinity-core/auth';
import { createYoga } from 'graphql-yoga';

const schema = simfinity.createSchema();
const authPlugin = createAuthPlugin({}); // supply the application's permissions
simfinity.use(authPlugin); // diagnostic

// Correct integration for Yoga:
const yoga = createYoga({ schema, plugins: [authPlugin] });
```

This rule also supports the MongoDB facade and `createRuntime`, `createSQL` and
`createPostgres` instances. It follows proven imports and stable `const` aliases,
checks only the first `use` argument and leaves middleware functions, Envelop
hosts and MCP `schemaPlugins` alone. Bare factories passed to `use`, spread calls,
unknown wrappers and dynamic/mutable aliases remain outside this batch.

## valid-query-limits

`configureQueryLimits({ maxPageSize })` requires a positive safe integer.
Omitted/undefined restores the default of 1000. This check does not choose an
operational timeout or enforce a business policy.

```javascript
import { configureQueryLimits } from '@simtlix/simfinity-core';

configureQueryLimits({ maxPageSize: 0 }); // diagnostic
configureQueryLimits({ maxPageSize: 250 }); // valid
configureQueryLimits({ maxPageSize: undefined }); // default: 1000
```

Dynamic values remain unknown. Unknown option keys are not diagnosed: the
3.8.0 runtime ignores them. Invalid options-object shapes are outside this rule.

## valid-connection-field

In 3.8.0 a non-embedded relation's `connectionField` names a field, not a dotted
path. Non-string values also fail model validation. The rule checks locally
registered types and recursively follows their embedded types:

```javascript
import { GraphQLObjectType } from 'graphql';
import * as simfinity from '@simtlix/simfinity-postgres';

// Author is another application type. This excerpt shows the invalid link.
const Book = new GraphQLObjectType({
  name: 'Book',
  fields: {
    author: {
      type: Author,
      extensions: { relation: { connectionField: 'metadata.authorId' } }, // diagnostic
    },
  },
});
simfinity.connect(null, Book, 'book', 'books');
```

Use a field name such as `authorId` when the link belongs to Book. If the reference
belongs to an embedded value, declare it inside that embedded type. Decide which
model is intended before changing the declaration; moving a stored reference may
require a data migration. See [relationships](./relationships).

Links on embedded relations are not checked. Virtual fields have no added storage/relation
requirement, including virtual fields with required arguments introduced in 3.8.0.
The rule does not establish that a referenced target field exists.

### Required collection links

Version 0.4.0 extends this rule to report an omitted, `null`, `undefined` or
empty `connectionField` on a directly registered, writable referenced object
collection without its own resolver. This is an additional diagnostic under the
same `recommended-3.8` rule; plugin 0.3.1 and earlier do not include it.

```javascript
import { GraphQLID, GraphQLList, GraphQLObjectType, GraphQLString } from 'graphql';
import * as simfinity from '@simtlix/simfinity-postgres';

const Line = new GraphQLObjectType({
  name: 'Line',
  fields: { id: { type: GraphQLID }, label: { type: GraphQLString } },
});
const Order = new GraphQLObjectType({
  name: 'Order',
  fields: {
    id: { type: GraphQLID },
    lines: {
      type: new GraphQLList(Line),
      extensions: { relation: {} }, // missing-link diagnostic
      // Set relation: { connectionField: 'orderId' } to declare the child link.
    },
  },
});
simfinity.connect(null, Line, 'line', 'lines');
simfinity.connect(null, Order, 'order', 'orders');
```

The check follows local aliases and outer/item non-null wrappers. Imported types
and dynamic `simfinity.getType()` targets remain unknown. Singular references,
embedded and scalar lists do not require collection child links. Whitespace-only
links retain their runtime meaning, and missing child fields can be legitimate
private inverse links.

In 0.5.0, proven SQL/PostgreSQL or transactional MongoDB storage also requires a
link for readOnly collections and collections with an application resolver.
`readOnly` changes generated inputs; an own resolver changes reads; neither removes
storage. Valid virtual fields remain excluded. Outside metadata mode, a missing
link with exactly one of readOnly/own resolver receives opt-in advice because
nested writes are rejected; both together are accepted silently.

## valid-model-fields

Checks the field shapes that generated inputs and proven storage backends accept:
missing object relation metadata, nested lists, stored interfaces/unions,
unsupported or cyclic scalar bases, enum values that collide after storage
conversion, and a SQL machine's present non-enum state field.

```javascript
import { createPostgres } from '@simtlix/simfinity-postgres';
import { GraphQLObjectType, GraphQLString } from 'graphql';
const api = createPostgres();
const Address = new GraphQLObjectType({ name: 'Address', fields: { street: { type: GraphQLString } } });
const Customer = new GraphQLObjectType({ name: 'Customer', fields: {
  address: { type: Address }, // storage requires extensions.relation
} });
api.addNoEndpointType(Address);
api.connect(null, Customer, 'customer', 'customers');
```

Use `relation: { embedded: true }` for an owned value, a nonembedded relation for
an independent entity, or a valid virtual declaration with an own resolver for a
computed output. A resolver alone does not remove a field from storage or inputs.
Core permits readOnly nested-list outputs and omits abstract inputs; those cases
are not blanket errors. Mongo uses GraphQL scalar identity plus date-name fallback,
while SQL metadata uses supported scalar names and an acyclic base chain. The
analyzer recognizes imported validated-scalar factories and one ordered static
`baseScalarType` assignment; arbitrary callbacks are never invoked. Equal enum
aliases remain legal; distinct primitive values with the same stored text do not.
SQL state machines may omit `state` or use an enum list.

## valid-model-storage

Checks proven storage constraints: inverse target/kind and alias conflicts,
collection-to-collection links, duplicate stored paths, embedded storage/input
cycles, collections inside embedded values, declarative indexes, SQL identity
and reserved physical columns, Mongo generated-path names and SQL uniqueness of
whole embedded values.

Engine distinctions matter. Transactional Mongo validates metadata index shape;
SQL additionally checks index targets. SQL physical-column rules do not apply to
keys inside an embedded JSON value. Mongo naming checks apply to generated
models, with a separate check for a synthesized private `constructor` link.
Supplying all models can make a readOnly embedded cycle legal. Scalar lists and
leaf uniqueness remain supported where the engine supports them. Use explicit
link entities for stored many-to-many relationships.

## valid-model-schema

At a fresh, closed local runtime's schema build, this rule checks required target
registrations by **type name**, not constructor identity. Writable embedded/list
targets and generated collection resolvers need registration; readOnly embedded
outputs and readOnly collections with own resolvers can remain unregistered.
A dynamic/imported bootstrap cannot establish that a target is absent.

Empty generated inputs usually cause operation omission and are accepted. A
required embedded value with an empty create projection is an error only when
included generated mutation roots reach its inputs. Excluded roots, update IDs,
collection `deleted` operations and singular-reference input boundaries are
preserved. The opt-in advice rule explains omitted add/update/added inputs.

The rule also follows runtime ownership through ordered schema builds. Sharing
ordinary value types is legal; generated/reserved nonembedded relation resolvers
bind an object type to their runtime. Supported copies include `toConfig()`
configs/maps, known field spreads and explicit resolver/extensions overrides.
It preserves eager snapshots and first materialization of lazy field thunks.
Clearing a copied resolver is accepted; replacing it while retaining foreign
tagged extensions can still fail. Interface-field copies are exempt. Whole-map
`getFields()` copies are outside the supported config grammar because GraphQL's
runtime `args` arrays are not field-config argument objects; explicit individual
field copies with corrected `args` can be analyzed. Dynamic transforms, arbitrary
helpers and copy/delete/rest transforms remain unknown.

## modeling-advice

This opt-in rule reports **accepted behavior** that may differ from the author's
intent: misplaced metadata, nonboolean flags, omitted object/abstract inputs,
ignored Mongo mappings/uniqueness, storage overwrite, partially unlinked
collections, empty generated operations, bare state-machine flags and shared
embedded/entity IDs. It does not prescribe client write access or native indexes.
Controllers, custom mutations, supplied models and output-only types are valid
application choices. Review each warning in that context.

## Modeling catalogue coverage

This matrix accounts for every candidate in [#116](https://github.com/simtlix/simfinity.js/issues/116).
**Metadata mode** means SQL/PostgreSQL or explicitly transactional MongoDB;
**generated Mongo** requires a proven model-generation path. Error/advice describes
the default preset severity. Unknown syntax or context remains undiagnosed.

| Candidate | Rule / behavior | Important accepted alternative or limit |
| --- | --- | --- |
| MOD-01 metadata placement | `modeling-advice` | Unrelated custom metadata is allowed |
| MOD-02 missing relation | `valid-model-fields` in metadata mode; advice for input/Mongo omissions | Core object lists can still have inputs; virtual outputs are exempt |
| MOD-03 missing/invalid link | `valid-connection-field`; partial-output advice | Private links and whitespace names are valid; readOnly + resolver is legal outside metadata mode |
| MOD-04 target registration | `valid-model-schema`; singular-reference advice | Requires complete local history; lookup is by name |
| MOD-05 inverse conflict | `valid-model-storage` in metadata mode | Singular IDs infer references; absent links synthesize private fields |
| MOD-06 collection inverse | `valid-model-storage` in metadata mode | Explicit join entities and Mongo-off patterns remain allowed |
| MOD-07 stored-name collision | `valid-model-storage`; generated-Mongo overwrite advice | Collections occupy no parent storage slot |
| MOD-08 embedded cycles | `valid-model-storage` | Input/storage traversal differ; sibling reuse and all-supplied Mongo models can be legal |
| MOD-09 nested lists | `valid-model-fields` | ReadOnly/virtual core outputs and abstract output lists are preserved |
| MOD-10 embedded collections | `valid-model-storage` in metadata mode | Embedded lists and singular references are supported |
| MOD-11 abstract fields | `valid-model-fields` in metadata mode; input advice | Independent or intentional core output types remain legal |
| MOD-12 scalar storage | `valid-model-fields`; generated-Mongo mapping advice | Supported validated bases, date-name fallback and unknown callbacks are distinguished |
| MOD-13 enum encoding | `valid-model-fields` in metadata mode | Same-value aliases and undefined/default enum names remain valid |
| MOD-14 indexes | `valid-model-storage` | Metadata checks shape; only SQL checks stored targets; native Mongo indexes are not inferred |
| MOD-15 identity/private names | `valid-model-storage` in SQL | Embedded JSON keys and owned-value IDs do not inherit root identity restrictions |
| MOD-16 Mongo path names | `valid-model-storage` | Generated-model and private-link cases differ; supplied models and valid aliases are preserved |
| MOD-17 uniqueness | `valid-model-storage` for whole SQL embedded values; Mongo advice | Supported leaf/native constraints remain application choices |
| MOD-18 boolean flags | `modeling-advice` | Known truthiness/exact-boolean behavior is described; unknowns are skipped |
| MOD-19 empty inputs | `valid-model-schema` for reachable required empty embedded create input; omission advice | Empty operations, update IDs and collection deleted operations are otherwise accepted |
| MOD-20 bound types/copies | `valid-model-schema` | Same-runtime rebuilds, unbound types, early copies and resolver-cleared copies remain legal |
| MOD-21 schema cloning | `no-schema-cloning` | Identity-preserving toConfig copies and unknown/external introspection remain legal |
| MOD-22 machine fields | `valid-model-fields` for present SQL non-enum state; bare-flag advice | Missing state and enum-list state are accepted |
| MOD-23 shared embedded ID | `modeling-advice` | Shared identity can be intentional; own ID resolvers and embedded-only types are exempt |

The rules do not execute application code or promise complete detection of
arbitrary JavaScript. The published scope is the finite syntax and proof model
below, with paired accepted/rejected runtime fixtures in the repository.

## Supported analysis and limits

The plugin recognizes ESM imports from the core, MongoDB, SQL and PostgreSQL
packages, local constant aliases, simple namespace destructuring and supported
MongoDB legacy `src` imports. It respects shadowing and skips recognized writes
and escapes. Configuration objects must be inline plain literals; primitive
constants and simple TypeScript assertions are supported. Duplicate literal
properties use their final value. General spreads, computed keys, getters, mutable object
aliases and dynamic values remain unknown; the schema-copy grammar above is an
explicit, bounded exception.

Type checks require local provenance. Simple `fields` thunks are read as syntax,
never invoked. Scalar hints must be one direct, unconditional assignment before
registration/schema use. SQL/PostgreSQL constructors and facade imports prove
the engine; `createRuntime(createMongoAdapter({ referentialIntegrity:
'transactional' }))` proves transactional Mongo. Unknown adapters/options do not
prove engine-specific restrictions. Imported singleton registrations, callbacks
and conditional bootstraps cannot prove a complete registry or execution order.

Cross-file maps/types, CommonJS, arbitrary bootstrap code and mutations through
external exports remain outside the model. Bounds per file are 40 alias steps,
200 types, 10,000 fields/copy steps, 2,000 calls and 100,000 AST nodes. Exhausted
proofs remain unknown. No application imports, factories or database connections
run during analysis.

The packed JS/TS consumer checks all new error rules and advice severity as well
as the existing authorization contracts. The bounded Barber trial lints both
backends, with ten existing in-memory sentinels plus five local modeling sentinels
per backend. Dynamic `getType()` collection targets remain outside local proofs.
This trial checks diagnostics; it does not certify application business policies.
Native operations remain an application option; consult [server-side operations](./server-side-operations)
for lifecycle and transaction responsibilities.

The [source and verification commands](https://github.com/simtlix/simfinity.js/tree/master/tools/eslint-plugin-simfinity)
include an isolated packed JS/TS consumer. The broader candidates in
[issue #112](https://github.com/simtlix/simfinity.js/issues/112) are follow-up work.
Authorization delivery and remaining candidates are tracked in
[issue #117](https://github.com/simtlix/simfinity.js/issues/117). The authorization
source rules cover AUTH-02/04/06/07 and bounded AUTH-08/11/14 variants. This area remains open for its other candidates and
the limitations above.
