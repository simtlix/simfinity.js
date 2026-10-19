# @simtlix/eslint-plugin-simfinity

Optional editor/CI checks for **Simfinity 3.8.0**, shared by MongoDB and PostgreSQL.
This first delivery provides five precise rules. It does not execute application
code or load Simfinity, GraphQL, database drivers or the MCP SDK.

The plugin has its own version (`0.1.0`) and is outside Simfinity's five runtime
workspaces and their release workflow. This change prepares it for local trials;
it does **not** publish it to npm. Use a packed archive from this checkout:

```sh
# From the repository root. Use Node.js 24 for development.
cd tools/eslint-plugin-simfinity
npm ci
npm pack --pack-destination /tmp

# From the consuming application's directory:
npm install --save-dev 'eslint@^9.30.1' /tmp/simtlix-eslint-plugin-simfinity-0.1.0.tgz
```

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
or claim compatibility with older/newer contracts. All five rules are errors
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

Run in this package:

```sh
npm ci
npm run test:security
npm test
npm run test:consumer
npm run test:trial
```

The isolated consumer packs/installs the actual archive, exercises JS/TS flat
config and TypeScript config declarations, checks rule IDs/locations, and verifies
that `--fix` changes no source. No runtime dependency is installed or executed.
The bounded trial lints both Barber backends and injects two in-memory sentinel
violations per backend to check coverage; it does not run the applications or
certify their business policies. `.github/workflows/eslint-plugin.yml` owns this
package's checks. Runtime releases do not install, test, version or publish it.

The remaining diagnostic candidates in [issue #112](https://github.com/simtlix/simfinity.js/issues/112)
remain follow-up work, requiring motivating examples and precision tests.
