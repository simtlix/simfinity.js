# @simtlix/simfinity-mcp

Database-independent MCP tool generation and transports for Simfinity GraphQL schemas. It requires GraphQL 16 and Node.js 18.18 or later.

All Simfinity packages are released together. Install from npm and keep their versions aligned. Source: [simtlix/simfinity.js](https://github.com/simtlix/simfinity.js).

Named views are read-only list tools titled by their name.

Tool generation and execution use only GraphQL:

```javascript
import { generateMCPTools } from '@simtlix/simfinity-mcp';

const { tools, callTool } = generateMCPTools(schema);
const result = await callTool(tools[0].name, {});
```

Install the optional MCP SDK when constructing a server or transport:

```sh
npm install @simtlix/simfinity-mcp@3.16.0 @modelcontextprotocol/sdk@^1.31.0
```

```javascript
import { createMCPServer } from '@simtlix/simfinity-mcp';

const server = await createMCPServer(schema);
// Connect an SDK transport, then close the server during application shutdown.
await server.close();
```

List and aggregate input schemas include the recursive `QLQuantifiedGroup`, `QLQuantifier` (`ANY`, `ALL`, `NONE`), `QLFilterGroup.ANY/ALL/NONE`, and `QLTypeFilterExpression.quantifier` on every runtime. Their descriptions explain paths relative to each element, same-element correlation and visibility. Explicit quantified calls require `queryFeatures.quantifiers: true` on the database adapter, as both bundled adapters declare; an undeclared adapter returns `UNSUPPORTED_QUERY` before reads. An adapter enabling `quantifiers` must also declare `referenceEmptiness: true`. The SDK remains optional for generation and execution.

```javascript
const result = await callTool('series', {
  seasons: { quantifier: 'NONE', terms: [{ path: 'year', operator: 'LT', value: 2000 }] },
  pagination: { page: 1, size: 10, count: true },
});
```

On a declaring adapter, a collection filter path returns each record once, including pages and counts. Terms on the same collection prefix in one group must match the same child; separate groups may match different children. `ANY` needs a matching visible element, `ALL` needs every visible element to match, and `NONE` needs no visible element to match. `ALL` and `NONE` hold with no visible elements; with no conditions, `ANY` tests presence, `NONE` tests absence and `ALL` is always true. A client's target `find` scope decides visibility. Quantified paths may end at a collection or single reference; nest groups to cross another collection. Use `AND: [{ ANY: [{ path: 'seasons', conditions: [{ field: 'year', operator: 'GTE', value: 2020 }] }] }]` for the explicit group form in list or aggregate tools. Collection paths used by aggregate `groupId` or facts still expand rows; shorthand filters on those prefixes select joined rows, while explicit groups retain per-record meaning. See the [MCP reference](https://simtlix.github.io/simfinity.js/reference/mcp) for examples and limits.

Generated tools select the virtual fields (`extensions.virtual`) that have no required arguments, but below any list position (the records of a list tool, and the items of a nested collection or embedded list in any tool) only those whose `mcp` option is `'select'`, because the resolver runs once per record. A virtual field with a required argument gets its own read tool, `<byIdQuery>_<field>` (for example `barbershop_busyRanges`), which takes the record's `id` and the field's arguments; `mcp: false` turns it off.

Since 3.16.0, `transactionTools: true` publishes a schema's generated `transaction` mutation (core's `transaction` schema option) as one destructive, non-idempotent tool that applies several generated writes together or not at all. It is off by default, and without it MCP never publishes that field or any mutation shaped like it. A schema rebuilt from introspection needs `getIntrospectionQuery({ oneOf: true })` with descriptions, and a server that enables the field exposes it as a custom tool to an earlier MCP release, so upgrade MCP first. See the [MCP guide](https://simtlix.github.io/simfinity.js/guide/mcp.html#transaction-tool).

The package works with schemas produced by either `@simtlix/simfinity-js` or `@simtlix/simfinity-postgres`, including the `createSQL` composition API. `generateMCPTools` needs no SDK. Server and transport constructors report `MCP_SDK_NOT_INSTALLED` when the optional SDK is unavailable.

Generated list, counted-page and aggregate tools expose nullable `valuePath` in `QLFilter`, `QLTypeFilter` and `QLFilterCondition`, including SDL/remote execution. For example, `{ stock: { operator: "LTE", valuePath: "reorderLevel" } }` compares stored fields on a server declaring `queryFeatures.valuePath: true`. It is mutually exclusive with supplied `value`, including null, and both supplied produce the shared runtime `INVALID_FILTER_VALUE`. Filter inputs stay ordinary objects rather than `@oneOf`; `valuePath: null` preserves literal behavior. Tool descriptions explain relative origins and [supported operators, null/list semantics and visibility](https://simtlix.github.io/simfinity.js/guide/queries.html#compare-stored-fields).

Version 3.18.0 adds `queryFeatures.elementFrames: true` for embedded object `ANY`/`ALL`/`NONE` and structural `$parent` operands. It requires `quantifiers`, `referenceEmptiness` and `valuePath`, all true. Missing/null lists and null items contribute no elements; `ALL` and `NONE` are true without elements. Parent traversal includes single embedded containers and stops at entity boundaries. Filters preserve selected arrays and outer row cardinality. See [the syntax and examples](https://simtlix.github.io/simfinity.js/guide/queries.html#embedded-object-lists-and-parent); versions through 3.17.0 do not support this extension.
