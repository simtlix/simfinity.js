# @simtlix/eslint-plugin-simfinity

Optional editor/CI checks for **Simfinity 3.8.0**, shared by MongoDB and PostgreSQL.
Version 0.5.0 provides fourteen error rules and one opt-in modeling advice rule.
It does not execute application
code or load Simfinity, GraphQL, database drivers or the MCP SDK.

The plugin has its own version (`0.5.0`) and is outside Simfinity's six runtime
workspaces and their release workflow. Install it from npm in your application:

```sh
npm install --save-dev 'eslint@^9.30.1' '@simtlix/eslint-plugin-simfinity@0.5.0'
```

Version 0.5.0 completes the bounded modeling catalogue in issue #116. It adds
`valid-model-fields`, `valid-model-storage` and `valid-model-schema`, extends
`valid-connection-field` and `no-schema-cloning`, and adds opt-in
`modeling-advice`. Upgrading can introduce errors in `recommended-3.8` for
previously undiagnosed declarations. The runtime contract remains Simfinity 3.8.0;
plugin and runtime versions are independent.

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
3.10.0; their runtime contracts are unchanged. Fourteen rules are errors
in this preset and can be individually disabled using normal ESLint config.
Accepted modeling choices remain silent unless you also opt into advice:

```javascript
export default [
  simfinity.configs['recommended-3.8'],
  simfinity.configs['advice-3.8'], // only simfinity/modeling-advice: warn
];
```

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
| `no-schema-cloning` | Imported schema cloners or a proven same-process introspection reconstruction receive a Simfinity schema | Use Envelop or in-place resolver wrapping |
| `no-uncalled-auth-factory` | A known factory is passed as a permission rule or composition argument | Call the factory with the intended arguments |
| `valid-default-policy` | Explicit `defaultPolicy` is neither `ALLOW`, `DENY` nor `undefined` | Choose the intended policy; omission defaults to `DENY` |
| `valid-permissions` | A proven invalid top-level/type permission map or a configured rule that is a nonboolean primitive, empty object, empty/sparse rule array | Supply maps and valid rules; omission means using the default policy |
| `valid-auth-composition` | Missing or provably nonfunction arguments to `composeRules`, `anyRule` or the `createRule` predicate | Supply functions; wrap expressions before composition |
| `valid-required-claims` | Missing/empty/non-string claims or an inline empty/sparse list with invalid entries | Supply nonempty strings; roles use OR, permissions use AND |
| `no-async-auth-extractor` | An async function or async generator in a built-in auth extractor position | Resolve data in the GraphQL context or use an async custom rule |
| `no-auth-plugin-as-middleware` | A proven `createAuthPlugin()` result passed to Simfinity `use()` | Install the plugin in the GraphQL server's Envelop plugins |
| `valid-policy-expression` | Malformed inline policy syntax in `createRuleFromExpression` or configured permission rules | Use valid operators, operands, logical arrays and `parent`/`args`/`ctx` references |
| `valid-query-limits` | Explicit `maxPageSize` is not a positive safe integer or `undefined` | Set a valid cap; omission/undefined restores 1000 |
| `valid-connection-field` | A locally registered relation has a dotted/non-string link, or a proven required object collection lacks a child link (including readOnly/resolver collections in storage metadata mode) | Use a field name linking the child to its parent; declare embedded references on their owning type |
| `valid-model-fields` | Unsupported stored/input field shapes, scalar bases, enum encodings or SQL machine state | Use a supported explicit model shape |
| `valid-model-storage` | Conflicting inverse links/storage names, cycles, indexes or engine storage restrictions | Choose a compatible relation and physical mapping |
| `valid-model-schema` | Proven absent registrations, reachable required empty inputs or foreign runtime-bound fields | Register dependencies or create the intended runtime-owned types |
| `modeling-advice` (opt-in) | Ignored metadata, accepted omissions and potentially surprising mappings | Confirm the application's intended behavior |

See the [rule examples and application guidance](https://simtlix.github.io/simfinity.js/guide/linting).
There are **no automatic fixes or suggestions**: changing permissions, relation
storage or transaction ownership needs a deliberate application decision.

## Precision and limits

The analysis recognizes ESM named/namespace imports, supported MongoDB legacy
paths, local `const` aliases, simple namespace destructuring and runtime factories
(`createRuntime`, `createSQL`, `createPostgres`). It respects binding identity,
shadowing, direct/alias writes and recognized escapes. It reads inline plain
configuration objects and primitive constants. Duplicate literal properties use
the last value. General spreads, computed keys, getters, mutable configuration objects,
imported permission maps and unknown values are skipped; schema field copies
have the narrowly defined exception below.

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

Modeling checks read local GraphQL declarations and simple zero-argument field
thunks without invoking them. They retain exact runtime/type identities, replace
registrations by type name, and distinguish SQL/PostgreSQL, explicit
transactional MongoDB, default MongoDB and unknown adapters. Storage checks follow
entity references and embedded values. Mongo generator checks require evidence
that the model is generated; supplied models and unknown hooks cannot establish
missing native constraints. Virtual fields have no storage requirement.

`valid-connection-field` keeps the 0.4.0 shared core missing-link error. In 0.5.0,
SQL/transactional Mongo also require links on stored readOnly/own-resolver
collections. Outside metadata mode, exactly one of these flags yields opt-in
advice; both together remain accepted. Private child links need not be declared,
and whitespace is not trimmed.

Schema absence/empty-input checks require a fresh local runtime and complete,
straight-line registration history. Imported singleton bootstraps and unknown or
conditional registrations cannot prove absence. Empty generated inputs are
usually permitted and only receive advice; a reachable required empty embedded
create input is an error. Runtime-bound type checks follow ordered schema builds
and bounded `toConfig()` field copies, preserving eager snapshot versus lazy
field-thunk materialization and resolver-clearing exceptions. Arbitrary helpers,
copy/delete transforms and external introspection remain unknown.
Captured `getFields()` maps stay live; resolver values and `toConfig()` field
configurations are snapshots. Writes or unknown escapes through runtime/schema
getters invalidate model proofs for the file because runtimes may share types.

See the [23-candidate coverage matrix](https://simtlix.github.io/simfinity.js/guide/linting#modeling-catalogue-coverage)
for engine applicability, accepted alternatives and message groups. The matrix
accounts for every MOD-01–MOD-23 candidate within these explicit static limits;
it is not a whole-program certification.

Alias chains are bounded to 40, type descriptors to 200, fields and copy-analysis
steps to 10,000, calls to 2,000 and AST nodes to 100,000 per file. Exhausted proofs
stay unknown. Unsupported reflection, cross-file mutation, external exports and
arbitrary bootstrap ordering are outside this model. A clean file does not
certify authorization, row visibility, lifecycle hooks, concurrency or transaction
safety. Legitimate native database operations remain supported.

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
violations per backend to check coverage. There are also five local sentinels per backend for a missing collection link,
field shape, engine storage, schema registration and opt-in advice. Barber's dynamic `getType()` targets remain outside local target proofs. The trial does not run the applications or
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
