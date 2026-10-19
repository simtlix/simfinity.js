# Optional application linting

`@simtlix/eslint-plugin-simfinity` provides five optional ESLint rules for the
**Simfinity 3.8.0** contract, shared by MongoDB and PostgreSQL. It complements the
[application skills](./ai-project-bootstrap) and [usage guidance](./anti-patterns)
with specific editor/CI diagnostics. It does not evaluate business authorization,
scopes, state machines or transaction correctness.

The plugin is an independently versioned development tool (`0.1.0`), outside the
five runtime packages. The initial implementation is available for local trials;
this change does not publish it to npm. Build an archive from the repository:

```sh
cd tools/eslint-plugin-simfinity
npm ci
npm pack --pack-destination /tmp
```

Then, from your application directory:

```sh
npm install --save-dev 'eslint@^9.30.1' /tmp/simtlix-eslint-plugin-simfinity-0.1.0.tgz
```

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

All five rules are errors in the preset. To opt out of a rule, add a later flat
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
It does not report transformations of independent GraphQL schemas or schemas
whose provenance is unknown.

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

Omitted, null and empty link values retain their meaning. Links on embedded
relations are not checked. Virtual fields have no added storage/relation
requirement, including virtual fields with required arguments introduced in 3.8.0.
The rule does not establish that a referenced target field exists.

## Supported analysis and limits

The plugin recognizes ESM imports from the core, MongoDB, SQL and PostgreSQL
packages, local constant aliases, simple namespace destructuring and supported
MongoDB legacy `src` imports. It respects shadowing and skips recognized writes
and escapes. Configuration objects must be inline plain literals; primitive
constants and simple TypeScript assertions are supported. Duplicate literal
properties use their final value. Spreads, computed keys, getters, mutable object
aliases and dynamic values remain unknown.

Type checks require registration in the same file. Simple `fields` thunks are
read as syntax, never invoked. Cross-file permission maps and types, CommonJS,
arbitrary bootstrap code, reflection and mutations through external exports are
outside this first release. Alias analysis is bounded to 40 and type traversal
to 200 nodes per file. No application imports, factories or database connections
run during analysis.

The bounded consumer trial lints both Barber backends and checks injected policy
and relation violations in memory. It does not certify their business policies
or measure accuracy against the entire candidate catalogue. Native operations
remain an application option; consult [server-side operations](./server-side-operations)
for their lifecycle and transaction responsibilities.

The [source and verification commands](https://github.com/simtlix/simfinity.js/tree/master/tools/eslint-plugin-simfinity)
include an isolated packed JS/TS consumer. The broader candidates in
[issue #112](https://github.com/simtlix/simfinity.js/issues/112) are follow-up work.
