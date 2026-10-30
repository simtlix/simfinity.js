# Select the execution boundary

| Situation | Supported path |
| --- | --- |
| Worker reads or invokes an existing operation | graphql-js against the authorized schema, with fresh actor context |
| Parent plus children | Generated nested mutation |
| Server command coordinating lifecycle writes | `registerMutation` callback with `saveObject`, `updateObject`, `deleteObject` or `transitionObject`, sharing its session/context |
| Read the transaction's uncommitted data | Native model/driver with the supplied session |
| Conditional primitive or infrastructure persistence | Native atomic statement with explicit checks/session |
| Several independent generated writes from a client | Since 3.16.0, opt-in `transaction` mutation with explicit permitted types/operations |

## In-process execution

```javascript
import { execute, parse, validate } from 'graphql';
import { createAuthPlugin } from '@simtlix/simfinity-core/auth';

// schema and permissions come from application startup.
createAuthPlugin(permissions, { defaultPolicy: 'DENY' }).onSchemaChange({ schema });
const document = parse('mutation Rename($input: OrderInputForUpdate!) { updateorder(input: $input) { id } }');
const errors = validate(schema, document);
if (errors.length) throw errors[0];
const result = await execute({
  schema, document, variableValues: { input }, contextValue: { ...actorContext },
});
```

Cache validated constant documents per schema; values use variables. `execute()` coerces variables but does not validate the document. Use the same schema already authorized by the server or install its auth hook once in a standalone process. Do not double-install it or assume a system actor bypasses policy. `graphql()` is a convenient parse/validate/execute alternative.

Envelop/Yoga request hooks, masking, request cost/depth controls and tracing do not run merely because graphql-js executes. Add required execution policy at the entry point. One counted list stores its count in `context.count`; use a fresh context per operation. Standalone MCP similarly needs its schema plugins configured.

Each ordinary generated root mutation owns its own transaction; multiple root fields in a document are not one transaction. A generated query does not join a caller's session. Never call generated resolvers by hand to adopt a transaction or bypass HTTP: that skips coercion and can bypass auth wrappers captured later.

Inspect `result.errors`. Output resolution happens after the mutation commits, so an error is not proof of rollback. Prefer minimal mutation selections and explicit readback; even `{ id }` can fail permission checks. Reconcile results/idempotency before repeating an uncertain write.

## Inside a custom mutation or hook

`saveObject('Order', input, session, context)` takes the registered type's name as a string, not its GraphQL type object. It creates, materializes fields, validates, performs nested collection work and invokes creation controllers. It skips root GraphQL coercion, field authorization, the record's own root middleware and the generated nested-operation limit. The custom mutation's middleware already ran; child middleware needs the supplied context. Authorize/validate/bound the command and pass stored enum values. Compute dependent invoices from the saved order's authoritative total, not original line input.

On MongoDB use `.session(session)`/`{ session }` on models belonging to the same client. On PostgreSQL use Model methods with `{ session }` or `session.query(sql, values)`; native Model.find has a page limit, so do not assume it reads every row for a total. Native calls run none of Simfinity's scopes, hooks, state transitions or mutation permissions; retain the application's checks and physical constraints.

Keep native infrastructure code localized without banning it. Atomic increments/upserts/conditional claims are not equivalent to generated read-then-write loops. Session work is sequential. Outbox entries commit with the business change; delivery happens afterwards. A command doing only HTTP/email work gains no database guarantee from a retried mutation callback.

## Lifecycle helpers (since 3.16.0)

```javascript
// Inside an already authorized registered mutation callback or controller.
const edited = await simfinity.updateObject('Order', {
  id: String(orderId), version: observedVersion, label: 'Ready',
}, session, context);
await simfinity.transitionObject('Order', 'approve', {
  id: String(orderId), version: edited.version,
}, session, context);
await simfinity.deleteObject('Draft', {
  id: String(draftId), version: draftVersion,
}, session, context);
```

The example assumes protected Order/Draft types and a registered approve action. Unprotected inputs omit version. Helpers use registered type names, not GraphQL type objects. They run validators, controllers, nested ownership/lifecycle and version checks; transition also checks source state and runs its action. Like `saveObject`, they skip GraphQL coercion/field authorization and the record's own root middleware, and can write registered types even when their roots are excluded. Authorize explicitly and pass the actor context.

Use plain input data in stored form: internal enum values, dense arrays and string GraphQL IDs, including `{ id }` references. Do not pass `ObjectId` instances. Generated update shape applies, including each protected child's version; read-only fields and managed state are rejected. These helpers validate structure and apply nested limits, but do not run scalar parsing. `saveObject` retains its separate coercion/limit omissions described above.

Without a session each helper owns a transaction. With a session it borrows that transaction and never commits/retries it. A failure can follow earlier successful writes inside the same helper: it has no savepoint. Let the error abort the whole owner; catching it and committing can store a partial graph. Native savepoint rollback does not restore the committed-callback queue. Helpers join an observed owner's callback queue, but external native MongoDB sessions cannot dispatch new committed callbacks automatically. See [helpers](https://simtlix.github.io/simfinity.js/guide/server-side-operations.html#update-delete-and-transition-from-code).

## Generated transaction mutation (since 3.16.0)

Enable deliberately at schema creation with `createSchema(null, null, null, { transaction: { types: [OrderType, DraftType] } })`, adapting the existing root allowlists. The schema includes no transaction field by default. Only included generated add/update/delete/state-action roots for those types become operations; arbitrary custom mutations are not entries.

Send `operations` as a list of one-key inputs. The transaction root and each enclosed operation require authorization; GraphQL coercion, operation middleware and lifecycle run. All entries share a session, rollback and nested-operation budget. `maxTransactionOperations` defaults to 100. Retries repeat the whole list; context mutations are not rolled back. All MongoDB models the list may write, including nested targets, must share one MongoClient, and custom adapters must support `assertTransactionModels`.

`$0`, `$1`, etc. reference earlier operation IDs only in documented ID positions. They cannot reference arbitrary fields, nested results or versions. Versions remain explicit: after creating a protected record, an update sends version 1 and a following state action version 2. Select returned versions for later requests. A transaction does not create idempotency automatically. Selected output fields resolve after commit, as with ordinary roots. Test a failure in a later entry and inspect storage, plus output/cleanup failure after a successful commit. See [transaction mutation](https://simtlix.github.io/simfinity.js/guide/mutations.html#run-several-mutations-in-one-transaction).

Sources: [server-side operations](https://simtlix.github.io/simfinity.js/guide/server-side-operations.html), [saveObject](https://simtlix.github.io/simfinity.js/reference/api.html#saveobject), [PostgreSQL native APIs](https://simtlix.github.io/simfinity.js/guide/postgresql.html#native-model-and-session-apis), [anti-patterns](https://simtlix.github.io/simfinity.js/guide/anti-patterns.html).
