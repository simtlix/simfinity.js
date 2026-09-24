# Dependency security and package quality review — 2026-09-24

## Scope and findings

This review covers the five library packages, the root development lockfile, and fresh npm consumers of the published 3.4.1 packages. It investigates the dependency alerts identified during the Skypack review. It is not a penetration test or an audit of a deployed application's authorization, secrets or infrastructure. The independent Barber applications were not modified or audited in this change.

The original root production audit reported **six affected dependency entries: two high and four moderate**. These counts represent packages matched by advisory records, not six demonstrated vulnerabilities in Simfinity's GraphQL API.

Fresh 3.4.1 installations of MongoDB, PostgreSQL, MCP without its SDK, and MCP with its SDK each returned **zero known dependency alerts** on this date. Their permitted ranges already select patched releases. The repository's older lockfile retained the affected versions; existing applications with similarly old lockfiles may also retain them.

## Runtime and optional dependency findings

| Dependency | Locked before → after | Issue and applicable context | Disposition |
| --- | --- | --- | --- |
| Mongoose | 8.24.0 → 8.24.4 | Update casting can modify Object.prototype when given a hostile dotted path. This was reproduced directly against the installed Mongoose dependency. Generated GraphQL input field names do not alone demonstrate reachability of that payload; native/custom update handlers accepting raw objects are the advisory's direct scenario. | Raise MongoDB's peer/optional minimum and the development range to `^8.24.2`; preserve Mongoose 8. Add an isolated regression test. |
| fast-uri | 3.1.2 → 3.1.8 | Malformed URLs can normalize to a different host; applications using that result as an outbound-request security decision can permit SSRF. Installed through MCP SDK → AJV / ajv-formats → AJV. No Simfinity SSRF path was demonstrated. | Refresh the compatible transitive resolution. |
| ip-address | 10.2.0 → 10.7.2 | IP parsing/classification inconsistencies can undermine address-based trust decisions. Installed through MCP SDK → express-rate-limit. No Simfinity SSRF exploit was demonstrated. | Refresh the compatible transitive resolution. |
| @hono/node-server | 1.19.14 → 1.19.17 | Static-file middleware on Windows can bypass path-prefix protection through encoded backslashes. The SDK HTTP transport imports the adapter's request listener; Simfinity does not configure its static-file server. | Refresh within version 1, retaining its existing Node compatibility. |
| hono | 4.12.25 → 4.13.9 | Multiple advisories concern specific parser, CORS, JSX, proxy and static-generation features: denial of service, disclosure and interpretation differences. Installed by the MCP SDK. Those additional Hono application features are not configured by Simfinity. | Refresh within version 4. |
| qs | 6.15.2 → 6.16.0 | Crafted inputs can bypass parser limits or cause denial of service. Installed through MCP SDK → Express / body-parser. Exposure depends on the application's parser and HTTP setup. | Refresh within version 6. |

MCP tools can be generated without installing the SDK. Its transports load the SDK lazily. The MongoDB facade retains its existing optional SDK compatibility dependency; PostgreSQL, SQL and core do not gain it. The root SDK remains 1.29.0: resolving its affected transitive packages was sufficient, so this fix does not require a new SDK API or add transitive overrides to libraries.

Advisory references:

- [Mongoose update casting](https://github.com/Automattic/mongoose/security/advisories/GHSA-664h-wqgq-64gw). The maintainer advisory's patched-version table lists 8.24.2; this review uses that stricter floor rather than the audit feed's 8.24.1 cutoff. The regression was also checked against exactly 8.24.2.
- [fast-uri malformed IPv6 normalization](https://github.com/advisories/GHSA-f65p-4m7j-42xc), representative of the reported host-normalization advisories.
- [ip-address leading-zero interpretation](https://github.com/advisories/GHSA-mwp4-54f8-5fhr).
- [Hono Node adapter static-file protection](https://github.com/honojs/node-server/security/advisories/GHSA-frvp-7c67-39w9).
- [Hono request-body nesting](https://github.com/honojs/hono/security/advisories/GHSA-g6gw-c38x-mqfc), representative of the reported Hono feature-specific advisories.
- [qs denial of service](https://github.com/ljharb/qs/security/advisories/GHSA-4mjr-xmp4-gh2g).

## Development dependencies

The full root audit also identified **seven development-only affected entries**, including Vitest and its mocker counted separately for the same advisory. Compatible updates resolve these entries:

| Component | Corrected installed version | Reported issue |
| --- | --- | --- |
| @humanfs/node | 0.16.8 | Recursive copying follows symlinked files outside the source tree |
| vitest / @vitest/mocker | 4.1.11 | Redirect mocks can allow arbitrary file reads/path traversal |
| brace-expansion | 1.1.21 | Crafted expansions can exhaust CPU or memory |
| js-yaml | 4.3.2 | Crafted merge/alias structures can cause excessive CPU consumption |
| nanoid | 3.3.19 | Certain generator size arguments can produce unbounded loops |
| postcss | 8.5.28 | Source-map auto-loading can read unintended map files |

The Vitest development minimum is now `^4.1.11`. No development tooling is added to runtime dependencies. No forced major upgrades were used. The independent documentation install also reported zero known alerts; its lockfile did not require changes.

## Packaging corrections

- Every library now has relevant discovery keywords.
- MongoDB now has an export map with its typed root and compatibility paths. A fixture captured from the published 3.4.1 archive checks **50 file paths and resolution aliases**, including extensionless source aliases and package.json access.
- Compatibility boundary: trailing-slash directory specifiers such as the package name followed by `/`, `src/` or `src/auth/` are not supported. They were never valid ESM imports, but older `require.resolve` directory normalization accepted them. Tools should resolve the canonical package root, `package.json` or explicit source filenames. Node's export-map resolver cannot retain the root trailing-slash alias; this exception is documented rather than claiming every directory-normalization behavior is preserved.
- Existing ESM module identity and strict TypeScript consumer tests are retained. Source path compatibility does not imply new declarations for every deep import or a CommonJS build.
- The official `@skypack/package-check@0.2.2` runs on extracted archives through `npm run test:packages`; all five pass **100/100**. Additional tests reject metadata that names missing files, missing exports/keywords, empty keywords and missing README/license files.
- The checker is installed only in the private root's development dependencies. Consumer checks reject any accidental dependency leak.
- Both PR CI and release validation run `npm run test:security`, which runs the full root `npm audit`. A nonzero result stops validation instead of being ignored.

The Skypack website previously showed data from August 2021. Passing the local checker neither refreshes that external index nor certifies browser support or security.

## Verification and reproduction

- Before the fix, the Mongoose casting regression reproduced prototype mutation and failed. After updating, it passes; exactly 8.24.2 was checked independently.
- Full root audit after remediation: **zero** known alerts, including development dependencies. Production-only audit: **zero**.
- Fresh published 3.4.1 consumer audits: MongoDB **0**, PostgreSQL **0**, MCP without SDK **0**, MCP with SDK **0**. These establish that the original six alerts were retained resolutions, while the Mongoose range still needed a safe minimum.
- Library suite with disposable MongoDB 7 replica set, separate standalone MongoDB and PostgreSQL 15: **1,113 tests passed**.
- An unrestricted parallel rerun hit the existing five-second limit in two nested-array aggregation cases (`a.nested.x`, ascending/descending). The focused parity file then passed all 142 cases; the full final suite passed all 1,113 with `--maxWorkers=4`. No query code or test timeout was changed. CI also runs its database matrix independently.
- All six isolated packed JavaScript/strict TypeScript consumers passed, including MCP both with and without its SDK.
- The same MongoDB archive passed its 50-path resolution fixture on Node.js **18.18.0** and **24.2.0**. This focused check exercises package resolution; it is not a claim that the full development suite runs on Node 18.

Run from the repository root using Node.js 24:

```sh
npm ci
npm run test:security
npm run lint
npm test
npm run test:packages
```

Database suites require the disposable URIs described in `.cursor/rules/simfinity-testing.mdc`; without them, database tests are explicitly skipped. Dependency audit results are a dated snapshot and depend on the registry's advisory database.

## Guidance for existing applications

Upgrade to the corrected Simfinity release and update the application's own dependency lockfile. Require Mongoose `^8.24.2` for MongoDB. Audit the actual application tree with `npm audit` and inspect retained versions with `npm explain`; changing Simfinity's repository lockfile does not replace a consumer's transitive resolutions. Applications that deliberately override or force incompatible dependency versions remain responsible for those choices.

Keep application-specific authorization and input validation in place. This update preserves GraphQL semantics, backend selection and package boundaries; it fixes package metadata and dependency baselines.
