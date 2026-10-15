# Registered server data operations

`runtime.execute(typeName, operation, args, options)` calls the existing generated lifecycle after `connect()` and `createSchema()`. Supported operations are `save`, `update`, `delete`, `get_by_id`, `find`, `count` and `aggregate`. Inputs and filter/sort/pagination arguments use the existing GraphQL contracts. No native backend dispatcher or second query language is introduced.

## Connection and model ownership

The application opens and closes its Mongoose connection, as in the existing MongoDB examples. Mongoose remains a peer dependency. Supply the existing model to `runtime.connect(model, type, single, list)`, or use the existing default connection for generated models. `connect()` registers a model; it does not open a database connection. Native operations needed by application infrastructure can use `runtime.getModel(type)` on this same registration. They do not run generated validators, controllers or scopes; their caller must enforce authorization, predicates and transaction ownership explicitly.

## Generated lifecycle

```js
const row = await runtime.execute('Item', 'update', {
  input: { id: 'item-17', title: null },
}, {
  context: { actor },
  session,
  storage: {
    filter: { tenantId, version: expectedVersion },
    increments: { version: 1 },
    nulls: 'preserve',
  },
});
```

Writes coerce generated input values and run registered runtime middleware, validation and controller hooks. An active supplied session is adopted without committing or aborting it; otherwise the existing adapter owns the transaction. Mongo rejects inactive sessions and sessions belonging to another client. Schema authorization wrappers and GraphQL output resolvers do not run: server callers must authorize commands before invoking this API.

Reads use generated query compilation and registered scopes. `count` uses the find scope; by-ID reads apply their registered scope. Ordinary pagination keeps the existing configured limit. There is no implicit unbounded read.

## Conditional write options

| Option | Use | Why it exists |
| --- | --- | --- |
| `storage.filter` | Update/delete only; ANDed with the requested immutable ID on the read and write | Retain tenant, version, state and lease predicates through the generated lifecycle |
| `storage.increments` | Update only; declared writable built-in Int/Float fields without custom validators | Atomically advance revisions while returning the actual stored result |
| `storage.id` | Save only; cast by the registered model | Preserve caller-assigned idempotency identities |
| `storage.nulls: 'preserve'` | Explicit opt-in on writes | Distinguish persisted null from the legacy clear/unset/list behavior |

A missed conditional update reports `NOT_VALID_ID`; a missed conditional delete returns null. Numeric increments reject invalid deltas and add guards against out-of-range results. They cannot overlap fields written by the generated update. Storage options are rejected with transactional reference integrity, rather than bypassing that mode. Calls without these options retain their existing semantics.

## Bounded read observation

`options.readOptions` forwards supported Mongo read options, including deadlines, batch size, collation and projection. `options.observer` can observe physical fetches (`beforeFetch`), reads (`beforeRead`), fetched batches (`onRows`) and pending promises (`track`). Throwing from observation stops the read and closes the cursor. A read failure takes precedence over cleanup failure; cleanup failure propagates after a successful read.

Observed reads require models without the query hooks they would bypass. Unsupported adapters fail explicitly. `observeMongoCursor(cursor, observer)` also instruments a caller-owned native cursor; it neither executes nor authorizes the native query. Connection and cursor lifetime remain with their owners.

## Standard introspection opt-out

Applications composing schemas through standard introspection may call `configureIntrospection({ fieldExtensions: false })` before creating any Simfinity schema. This process-wide opt-out avoids cloning Simfinity's shared introspection metadata types. The default remains unchanged, and enabling the extension again or disabling it after schema creation is rejected.
