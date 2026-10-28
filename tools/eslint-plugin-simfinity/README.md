# @simtlix/eslint-plugin-simfinity

Optional editor/CI checks for **Simfinity 3.8.0**, shared by MongoDB and PostgreSQL.
Version 0.4.0 provides eleven precise rules, including `valid-policy-expression`.
It does not execute application
code or load Simfinity, GraphQL, database drivers or the MCP SDK.

The plugin has its own version (`0.4.0`) and is outside Simfinity's six runtime
workspaces and their release workflow. Install it from npm in your application:

```sh
npm install --save-dev 'eslint@^9.30.1' '@simtlix/eslint-plugin-simfinity@0.4.0'
```

Version 0.4.0 extends `valid-connection-field` to detect a missing
child link on a locally proven, writable referenced object collection without its
own resolver. Upgrading can report new errors under the same rule in
`recommended-3.8`; the preset's Simfinity 3.8.0 contract remains unchanged.
See the limits below.

Version 0.3.1 recognizes Simfinity 3.12.0 `registerView()` calls and preserves type tracking through TypeScript-wrapped options. It adds no rule and does not change the `recommended-3.8` preset contract.

Version 0.3.0 adds `valid-policy-expression` to `recommended-3.8`, so upgrading
can report malformed policies that earlier plugin versions did not diagnose.
Version 0.2.0 added `no-async-auth-extractor` and `no-auth-plugin-as-middleware`;
0.1.0 contains the preceding eight rules. Runtime versions are independent.

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
or claim compatibility with older/newer contracts. The authorization checks added
in 0.2.0 and 0.3.0 were also revalidated against Simfinity
3.10.0; their runtime contracts are unchanged. All eleven rules are errors
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
| `no-async-auth-extractor` | An async function or async generator in a built-in auth extractor position | Resolve data in the GraphQL context or use an async custom rule |
| `no-auth-plugin-as-middleware` | A proven `createAuthPlugin()` result passed to Simfinity `use()` | Install the plugin in the GraphQL server's Envelop plugins |
| `valid-policy-expression` | Malformed inline policy syntax in `createRuleFromExpression` or configured permission rules | Use valid operators, operands, logical arrays and `parent`/`args`/`ctx` references |
| `valid-query-limits` | Explicit `maxPageSize` is not a positive safe integer or `undefined` | Set a valid cap; omission/undefined restores 1000 |
| `valid-connection-field` | A locally registered relation has a dotted/non-string link, or a proven writable object collection without its own resolver lacks a child link | Use a field name linking the child to its parent; declare embedded references on their owning type |

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

Calling the known runtime member `configureAfterCommit` preserves tracking for
subsequent schema and relation checks. The plugin does not validate its options
or certify callback delivery or transaction ownership.

Authorization checks cover `createAuthPlugin`, not the deprecated middleware
factories. Maps and rule/claim arrays must be inline to inspect their entries;
constructor/call results and mutable object/array aliases remain unknown.
Permission rules preserve booleans, custom/async functions and valid expression objects
such as `{ allOf: [] }`. Composition accepts functions, not permission-map booleans,
arrays or expression objects. `createRule` checks only its first argument.
Required names are not trimmed: `' '` is valid. All checks preserve the application's
choice of roles, permissions and AND/OR semantics. Rule-array traversal is bounded
to 200 nodes per `createAuthPlugin` call.

`valid-policy-expression` checks the first argument of `createRuleFromExpression`
and nonempty inline expressions in `createAuthPlugin` field rules, including nested
rule arrays. It catches unknown operators, invalid `eq`/`in` arity, sparse arrays,
malformed `allOf`/`anyOf`/`not`, invalid reference objects/paths, nested literal
references and provably invalid operands or membership lists. It preserves booleans,
multiple operator keys (implicit AND), empty logical arrays, explicit null and valid
equality literals. It does not decide whether a valid expression grants access or
infer incompatible comparison types (AUTH-12).

Expression/rule traversal is bounded to 200 per recognized call, and oversized
containers are skipped. Object/array aliases, dynamic expressions, call/constructor
results, spreads, computed keys, getters and method syntax remain unknown. Primitive
constant aliases and TypeScript assertions are supported. Direct `isPolicyExpression`
and `evaluateExpression` calls are not checked: applications can intentionally use
them to validate untrusted inputs. The rule loads no runtime to perform its analysis;
a separate repository test compares hand-paired fixtures with the shared runtime.

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
Links on embedded relations are not checked. This rule does not establish that a
target field exists.

Since 0.4.0, an omitted, `null`, `undefined` or empty link produces a
`missing` diagnostic when all of these facts are known locally: the owning type is
directly registered, the field is a non-embedded list of a `GraphQLObjectType`,
`readOnly` is absent or falsy, and `resolve` is absent, null or undefined. Outer and
item `GraphQLNonNull` wrappers are supported. Singular references, embedded lists,
virtual declarations, scalar/nested lists and unknown values stay outside the new
check. Whitespace-only links retain the runtime's existing meaning.

The list's object target must be a local declaration: imported targets and dynamic
`getType()` calls remain unknown. Merely reaching an unregistered embedded type
does not enable the missing-link check; explicitly registering it does. Read-only
or own-resolver collections are skipped even when an engine's storage metadata
would reject them. This is the shared core error check, not backend initialization
validation. The 3.8.0 contract was also rechecked against current 3.18.0 core and
both adapters. Broader MOD-03 variants and the rest of
[issue #116](https://github.com/simtlix/simfinity.js/issues/116) remain open.

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
The bounded trial lints both Barber backends and injects ten in-memory sentinel
violations per backend to check coverage. Version 0.4.0 adds one explicit
local collection sentinel per backend because Barber's dynamic `getType()` targets
are outside the new missing-link check. The trial does not run the applications or
certify their business policies. `.github/workflows/eslint-plugin.yml` owns this
package's checks. `release-eslint-plugin.yml` publishes stable plugin tags via OIDC
and tests the exact packed archive before publication. Runtime releases do not
install, test, version or publish this plugin.

The source authorization rules address AUTH-02/04/06/07 and bounded AUTH-08/11/14 variants
within the documented limits.
The remaining authorization candidates are tracked in
[issue #117](https://github.com/simtlix/simfinity.js/issues/117), under the
[issue #112 catalogue](https://github.com/simtlix/simfinity.js/issues/112).
They remain follow-up work, requiring motivating examples and precision tests.
