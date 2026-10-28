# Required collection links in the application linter

Issue: https://github.com/simtlix/simfinity.js/issues/116 (MOD-03).

The user approved this bounded delivery on 2026-10-28: extend
`valid-connection-field` to diagnose an absent, null, undefined or empty
`connectionField` on a locally registered, writable referenced object collection
without its own resolver. This catches a shared `createSchema()` error before
application startup. The contract is present in both v3.8.0 and current source.

## Approach and boundaries

Extend the existing rule and local syntax analyzer. The alternative was starting
opt-in misplaced-metadata and nonboolean-flag warnings (MOD-01/MOD-18); the
approved approach reuses the established error rule and its provenance checks.

- Keep the explicit `recommended-3.8` contract and existing eleven rule IDs.
- Require proven GraphQL object/list/non-null constructor identities and local
  `connect` or `addNoEndpointType` registration. Do not infer imported targets,
  `getType()` results or startup ordering.
- Diagnose only the common core error. Read-only or own-resolver cases, virtual
  fields, embedded relations, scalar/nested lists and dynamic values stay outside
  the new check. Backend-specific storage errors and contextual warnings remain
  follow-ups; skipping them does not certify that a schema will initialize.
- The missing-link check applies to directly registered types, including an
  embedded type registered separately. Existing dotted/non-string checks still
  traverse embedded types. Traversal order must not suppress or duplicate reports.
- Preserve aliases, shadowing, mutation/escape exclusions and bounded traversal.
  Never execute consumer code or add runtime/driver dependencies or autofixes.

## Delivery and validation

Add JS/TS RuleTester coverage, exact diagnostic locations in packed consumers,
and bounded trials on both Barber backends with an explicit local sentinel for
the new analysis boundary. Revalidate against core runtime fixtures. Update the
package README, public linting guide and root README. Run plugin tests, audit,
packed consumer/trial, root lint/tests and docs build. Keep #116 open, recording
only delivered coverage in the PR. Publication is outside this request.
