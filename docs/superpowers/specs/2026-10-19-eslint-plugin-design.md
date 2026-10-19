# Optional application linting for Simfinity 3.8.0

Issue: https://github.com/simtlix/simfinity.js/issues/112

The first delivery turns five documented contract violations into precise,
optional editor/CI feedback. The historical 3.7.0 catalogue is a backlog, not
a default ruleset. The runtime, its generated API and both adapters remain
unchanged. This complements the application skills; it cannot certify business
authorization, tenant isolation or transaction safety.

## Package and contract

- `tools/eslint-plugin-simfinity` contains `@simtlix/eslint-plugin-simfinity`,
  independently versioned at `0.1.0`, outside the five runtime workspaces and
  their release flow. This PR prepares a package; it does not publish it.
- ESM, ESLint 9 flat config, Node.js `^18.18.0 || ^20.9.0 || >=21.1.0`.
  Development and CI use Node.js 24. No production dependencies other than the
  ESLint peer. TypeScript parsing is tested with an optional consumer parser.
- An explicit `recommended-3.8` preset selects the Simfinity 3.8.0 contract for
  MongoDB and PostgreSQL. There is no inferred installed version or engine.
- Five rules: `no-schema-cloning`, `no-uncalled-auth-factory`,
  `valid-default-policy`, `valid-query-limits`, `valid-connection-field`.
- No automatic fixes. No executing application code, imports, getters or
  factories, and no database connections.

## Analysis boundary

Resolve actual ESM import bindings, local constant aliases and simple member
access, respecting shadowing and writes. Inspect inline plain configuration
objects and primitive constants; unknown spreads, computed keys, mutable or
escaped objects and dynamic values remain unknown. No cross-file graph,
CommonJS, type checking or general control-flow interpretation in this release.

Schema diagnostics require a proven Simfinity `createSchema` result and an
imported `applyMiddleware` or `mapSchema`. Authorization diagnostics inspect
permission slots and composition arguments, not every function reference.
The connection rule follows locally registered `GraphQLObjectType` declarations
and their embedded types through simple field thunks without invoking them.
It rejects proven dotted/non-string connection fields under 3.8.0, preserves
omitted/null/empty values and embedded relations, and adds no storage requirement
to virtual fields. Unrelated GraphQL schemas are outside its scope.

## Evidence and delivery

RuleTester cases include positive/negative imports, aliases, shadowing, dynamic
configuration, both engines, virtual fields and embedded recursion. An isolated
packed consumer exercises flat config, JavaScript and TypeScript without the
runtime installed. A bounded trial against both Barber backends records actual
coverage and limitations. A dedicated CI job owns this package's install,
security audit, tests and packing. Public docs explain configuration, each
diagnostic and the supported boundaries. A final independent review precedes
opening the implementation PR. Future diagnostics require separate evidence.
