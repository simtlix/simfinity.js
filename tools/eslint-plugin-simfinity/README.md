# @simtlix/eslint-plugin-simfinity

Optional editor/CI checks for **Simfinity 3.8.0**, shared by MongoDB and PostgreSQL.
The source provides ten precise rules (eight published in `0.1.0`, two unreleased).
It does not execute application
code or load Simfinity, GraphQL, database drivers or the MCP SDK.

The plugin has its own version (`0.1.0`) and is outside Simfinity's five runtime
workspaces and their release workflow. Install it from npm in your application:

```sh
npm install --save-dev 'eslint@^9.30.1' '@simtlix/eslint-plugin-simfinity@0.1.0'
```

`no-async-auth-extractor` and `no-auth-plugin-as-middleware` are **unreleased**;
the npm command above does not include them. To try them, pack this source as
described below. This change does not bump or publish the plugin or runtime.

ESLint **9.30.1 or later within 9.x**, ESM flat config and Node.js
`^18.18.0 || ^20.9.0 || >=21.1.0` are supported. ESLint 10 and CommonJS
application analysis are not covered by this release.

```javascript
// eslint.config.mjs
import simfinity from '@simtlix/eslint-plugin-simfinity';

export default [simfinity.configs['recommended-3.8']];
```

Selecting `recommended-3.8` explicitly selects the **3.8.0 runtime contract**.
The plugin does not discover your installed runtime version, infer a database,
or claim compatibility with older/newer contracts. The two new authorization
checks were also revalidated against Simfinity 3.10.0; their runtime contracts
are unchanged. All ten source rules are errors
in this preset and can be individually disabled using normal ESLint config.

For TypeScript, install `@typescript-eslint/parser` in the application and add:

```javascript
import simfinity from '@simtlix/eslint-plugin-simfinity';
import parser from '@typescript-eslint/parser';

export default [
  { ...simfinity.configs['recommended-3.8'], files: ['**/*.{js,mjs,ts,mts,tsx}'] },
  { files: ['**/*.{ts,mts,tsx}'], languageOptions: { parser } },
];
```

| Rule (`simfinity/` prefix) | Proven violation | Suggested action |
| --- | --- | --- |
| `no-schema-cloning` | Imported `applyMiddleware`/`mapSchema` receives a locally proven Simfinity schema | Use Envelop or in-place resolver wrapping |
| `no-uncalled-auth-factory` | A known factory is passed as a permission rule or composition argument | Call the factory with the intended arguments |
| `valid-default-policy` | Explicit `defaultPolicy` is neither `ALLOW`, `DENY` nor `undefined` | Choose the intended policy; omission defaults to `DENY` |
| `valid-permissions` | A proven invalid top-level/type permission map or a configured rule that is a nonboolean primitive, empty object, empty/sparse rule array | Supply maps and valid rules; omission means using the default policy |
| `valid-auth-composition` | Missing or provably nonfunction arguments to `composeRules`, `anyRule` or the `createRule` predicate | Supply functions; wrap expressions before composition |
| `valid-required-claims` | Missing/empty/non-string claims or an inline empty/sparse list with invalid entries | Supply nonempty strings; roles use OR, permissions use AND |
| `no-async-auth-extractor` (unreleased) | An async function or async generator in a built-in auth extractor position | Resolve data in the GraphQL context or use an async custom rule |
| `no-auth-plugin-as-middleware` (unreleased) | A proven `createAuthPlugin()` result passed to Simfinity `use()` | Install the plugin in the GraphQL server's Envelop plugins |
| `valid-query-limits` | Explicit `maxPageSize` is not a positive safe integer or `undefined` | Set a valid cap; omission/undefined restores 1000 |
| `valid-connection-field` | A locally registered relation has a dotted or non-string link field under 3.8.0 | Use a field name; declare embedded references on their owning type |

See the [rule examples and application guidance](https://simtlix.github.io/simfinity.js/guide/linting).
There are **no automatic fixes or suggestions**: changing permissions, relation
storage or transaction ownership needs a deliberate application decision.

## Precision and limits

The analysis recognizes ESM named/namespace imports, supported MongoDB legacy
paths, local `const` aliases, simple namespace destructuring and runtime factories
(`createRuntime`, `createSQL`, `createPostgres`). It respects binding identity,
shadowing, direct/alias writes and recognized escapes. It reads inline plain
configuration objects and primitive constants. Duplicate literal properties use
the last value. Spreads, computed keys, getters, mutable configuration objects,
imported permission maps and unknown values are skipped.

Authorization checks cover `createAuthPlugin`, not the deprecated middleware
factories. Maps and rule/claim arrays must be inline to inspect their entries;
constructor/call results and mutable object/array aliases remain unknown.
Permission rules preserve booleans, custom/async functions and expression objects
such as `{ allOf: [] }`. Beyond an empty object, policy-expression validation is
outside this batch. Composition accepts functions, not permission-map booleans,
arrays or expression objects. `createRule` checks only its first argument.
Required names are not trimmed: `' '` is valid. All checks preserve the application's
choice of roles, permissions and AND/OR semantics. Rule-array traversal is bounded
to 200 nodes per `createAuthPlugin` call.

The extractor rule checks `requireAuth`'s first argument, `requireRole`'s
`userPath`/`rolePath`, `requirePermission`'s `userPath`/`permissionsPath`, and
`isOwner`'s first two arguments and `userPath`. It recognizes inline async
functions/async generators and stable `const` function aliases. Options must be
inline plain literals. Method shorthand, getters, function declarations, dynamic
extractors and return-value inference remain unknown. Synchronous generators are
not rejected by the runtime's creation-time check and are outside this rule;
an ordinary function returning a promise is also outside this syntax check.
Async custom rules remain supported.

The middleware rule checks only the first argument to a proven Simfinity `use`
call, following direct `createAuthPlugin` results and stable `const` aliases.
Yoga/Envelop plugins and MCP `schemaPlugins` are valid destinations. Unknown
wrappers, mutable aliases, spread calls and a bare factory passed to `use` are
outside this batch. Neither rule decides an application's permissions.

GraphQL checks require local `connect`/`addNoEndpointType` registration. They follow
embedded object/list/non-null types and simple field thunks without invoking
them. Independent GraphQL schemas, dynamic type builders and cross-file type
registrations are not analyzed. Virtual fields have no added storage requirement.
Omitted/null/empty `connectionField` values and embedded relation links preserve
the runtime's meaning; this rule does not establish that a target field exists.

This is bounded syntax analysis, not whole-program interpretation. Alias chains
are bounded to 40 and type traversal to 200 nodes per file. Reflection, mutations
through external exports, arbitrary callbacks and application bootstrap ordering
are outside its proof model. An undiagnosed file is not evidence of correct
authorization, row visibility, lifecycle hooks, concurrency or transaction safety.
Legitimate native database operations remain supported.

## Contributing and verification

Use Node.js 24 for development. Run in this package:

```sh
npm ci
npm run test:security
npm test
npm run test:consumer
npm run test:trial
```

To try an unpublished change, run `npm pack --pack-destination /tmp` in this
directory and install the resulting archive in the consuming application.

The isolated consumer packs/installs the actual archive, exercises JS/TS flat
config and TypeScript config declarations, checks rule IDs/locations, and verifies
that `--fix` changes no source. No runtime dependency is installed or executed.
The bounded trial lints both Barber backends and injects eight in-memory sentinel
violations per backend to check coverage; it does not run the applications or
certify their business policies. `.github/workflows/eslint-plugin.yml` owns this
package's checks. Runtime releases do not install, test, version or publish it.

The published authorization batch addresses AUTH-02/04/06/07; the unreleased
addition covers bounded AUTH-08/14 variants within the documented limits.
The remaining authorization candidates are tracked in
[issue #117](https://github.com/simtlix/simfinity.js/issues/117), under the
[issue #112 catalogue](https://github.com/simtlix/simfinity.js/issues/112).
They remain follow-up work, requiring motivating examples and precision tests.
