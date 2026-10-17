# Select the execution boundary

| Situation | Supported path |
| --- | --- |
| Worker reads or invokes an existing operation | graphql-js against the authorized schema, with fresh actor context |
| Parent plus children | Generated nested mutation |
| Several new records in one transaction | `registerMutation` callback and `saveObject(typeName, input, session, context)` |
| Read the transaction's uncommitted data | Native model/driver with the supplied session |
| Conditional primitive or infrastructure persistence | Native atomic statement with explicit checks/session |
| Several unrelated updates/deletes atomically | Application command/native work with explicit lifecycle responsibilities; no generated operation-list transaction at 3.7.0 |

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

Every generated root mutation owns its own transaction; multiple root fields in a document are not one transaction. A generated query does not join a caller's session. Never call generated resolvers by hand to adopt a transaction or bypass HTTP: that skips coercion and can bypass auth wrappers captured later.

Inspect `result.errors`. Output resolution happens after the mutation commits, so an error is not proof of rollback. Prefer minimal mutation selections and explicit readback; even `{ id }` can fail permission checks. Reconcile results/idempotency before repeating an uncertain write.

## Inside a custom mutation or hook

`saveObject('Order', input, session, context)` takes the registered type's name as a string, not its GraphQL type object. It creates, materializes fields, validates, performs nested collection work and invokes creation controllers. It skips root GraphQL coercion, field authorization, the record's own root middleware and the generated nested-operation limit. The custom mutation's middleware already ran; child middleware needs the supplied context. Authorize/validate/bound the command and pass stored enum values. Compute dependent invoices from the saved order's authoritative total, not original line input.

On MongoDB use `.session(session)`/`{ session }` on models belonging to the same client. On PostgreSQL use Model methods with `{ session }` or `session.query(sql, values)`; native Model.find has a page limit, so do not assume it reads every row for a total. Native calls run none of Simfinity's scopes, hooks, state transitions or mutation permissions; retain the application's checks and physical constraints.

Keep native infrastructure code localized without banning it. Atomic increments/upserts/conditional claims are not equivalent to generated read-then-write loops. Session work is sequential. Outbox entries commit with the business change; delivery happens afterwards. A command doing only HTTP/email work gains no database guarantee from a retried mutation callback.

At 3.7.0 `runtime.execute`, `storage.filter/increments`, caller-assigned generated IDs and read-observer options from PR #96 are unavailable. Check new releases rather than treating this as a permanent ban on future APIs.

Sources: [server-side operations](https://simtlix.github.io/simfinity.js/guide/server-side-operations.html), [saveObject](https://simtlix.github.io/simfinity.js/reference/api.html#saveobject), [PostgreSQL native APIs](https://simtlix.github.io/simfinity.js/guide/postgresql.html#native-model-and-session-apis), [anti-patterns](https://simtlix.github.io/simfinity.js/guide/anti-patterns.html).
