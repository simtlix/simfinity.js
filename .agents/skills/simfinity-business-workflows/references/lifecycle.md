# Place each rule

| Rule | Place |
| --- | --- |
| Input shape and scalar validation | GraphQL types/scalars |
| Field and materialized-record validation | `extensions.validations` CREATE/UPDATE rules |
| Current ownership, context-dependent invariant, server values | Controller using context and session |
| Fixed transition graph | Registered enum state machine plus explicit action permissions |
| Data-driven/versioned workflow | Application model/policy and an atomic update or distinct transition command |
| Audit, totals, outbox in the same transaction | Appropriate controller/custom mutation using its session |
| Best-effort notification after a confirmed commit | Since 3.15.0, committed controller callback |
| Durable email/webhook delivery | Worker processing an outbox stored with the business write |

Validators run before controller hooks. A hook that changes values must preserve their invariants. On update, changes are partial and may contain `$unset`; merge with current values or inspect affected paths deliberately. Database uniqueness requires a constraint, not just a validator's existence query.

## Fixed state machines

```javascript
const machine = {
  initialState: OrderState.getValue('DRAFT'),
  actions: { approve: {
    from: OrderState.getValue('DRAFT'),
    to: OrderState.getValue('APPROVED'),
  } },
};
simfinity.connect(null, OrderType, 'order', 'orders', controller, null, machine);
```

`OrderType.state` must be the enum field; use string internal values matching enum names for portable behavior. Managed state is excluded from ordinary add/update inputs. The generated action is `approve_order`, with the same input type as `updateorder` and one configured source/destination. For a protected order with `id: GraphQLID`, send the observed version:

```graphql
mutation ApproveOrder($id: ID!, $version: RecordVersion!) {
  approve_order(input: { id: $id, version: $version }) { id state version }
}
```

Grant the exact action separately. Its input can carry ordinary writable fields and nested changes. If an actor may approve but has narrower edit rights, enforce the permitted patch in action policy and the transactional lifecycle, including nested changes. Test the combined input as well as the bare action.

The optional `action(input, session)` callback runs after the persisted source-state check and before the managed state update. It does not receive context. Use auth, `state_changed` middleware or controllers for actor-dependent policy, remembering ordinary root middleware runs before its transaction, while operation middleware inside the generated transaction mutation runs within that transaction and can repeat. The resulting update executes validators/controllers. Do not assume an ordinary update action key identifies a state transition.

Do not rebuild schemas per request to encode each user's workflow. A configurable graph with revision IDs, drafts and migration rules is application data. Keep its transition rules and concurrency checks explicit. Use a typed update with controller validation when it expresses the action, or a registered command when it owns a distinct operation. An entity can use fixed actions for archive/restore alongside a revisioned business workflow. Give their states and write policies separate fields when the two lifecycles are independent.

Since 3.13.0, protected writes require observed record versions. A parent version does not protect direct changes to children, authority records or shared resources. Since 3.16.0, use `transitionObject(typeName, actionName, input, session, context)` for a registered state action inside an authorized server command, or the opt-in transaction mutation for independent generated writes. Neither creates a configurable workflow engine. Confirm the installed version and follow [optimistic concurrency](https://simtlix.github.io/simfinity.js/guide/concurrency.html). Same-revision derived totals use MongoDB `updateOne` without version changes or PostgreSQL `{ session, version: false }`; do not perform another versioned write to a record that a later nested entry will update.

## Hooks and nested work

Signatures: `onSaving(record, input, session, context)`, `onSaved(record, input, session, context)`, `onUpdating(id, changes, session, context)`, `onUpdated(record, session, context)`, `onDelete(record, session, context)`. A missing delete target may be null. Hook record shapes differ by engine.

Nested referenced children run their own middleware, ownership checks, validators and controllers in the parent's transaction. They do not run the child's root mutation permission rule; enforce required child write permissions in controllers/middleware. Parent `onSaved`/`onUpdated` run after children. Compute totals from those stored children using the session, persist the total and update the returned parent. Implement both create and update paths. Child root mutations do not run the parent's hooks: exclude them when the aggregate requires changes through the parent, or maintain the invariant there too.

Neither `onSaved` nor `onUpdated` is after commit. Retries can rerun hooks and custom callbacks. Await session operations sequentially and use committed callbacks for best-effort external effects or outbox records for durable delivery. On PostgreSQL, catching a failed statement does not restore the transaction; use a savepoint for an intentionally recoverable native statement. Do not roll back lifecycle writes to a savepoint: that does not roll back their queued committed notifications. A failed lifecycle helper may already have made partial writes in a supplied session; propagate the error to its transaction owner instead of catching it and committing.

`simfinity.use()` is pre-execution: `await next()` advances middleware, not the database operation. Code after it still precedes persistence, and omitting it does not cancel the operation. Throw to reject; use controllers for persistence hooks.

## Committed callbacks and recovery

Since 3.15.0, controllers may declare `onSaveCommitted(record, args, context)`, `onUpdateCommitted(record, context)`, `onDeleteCommitted(record, context)` and `onTransitionCommitted(record, action, context)`. They receive no session. A state action queues only its transition notification; its ordinary update hooks still run before commit. Failed/retried attempts dispatch nothing; the confirmed attempt's callbacks run sequentially and are awaited. Callback failures are reported through `configureAfterCommit({ onError })` without failing or retrying the committed write.

Callbacks require observable transaction ownership. Registered mutations, generated roots/transactions, SQL `withTransaction` and sessionless lifecycle helpers own queues; a helper using that session joins the outer queue. External native MongoDB transactions skip new callbacks with a warning. Custom adapters need the documented callback capability. There is no public arbitrary closure queue or manual flush API.

For durable delivery, persist outbox intent in the same session, then let an idempotent worker deliver and retry it. A process may exit after commit and before a callback; callbacks are not exactly-once delivery. Bound callback I/O because it delays the response.

Test rollback, whole-attempt retries, successful commit with failed notification, and lost response/output failure separately. An error after commit or during connection cleanup does not prove that nothing was stored. Reconcile a durable command receipt/readback before repeating a write; a later read may show a newer revision than the one the command committed. See [committed callbacks](https://simtlix.github.io/simfinity.js/guide/controllers.html#after-commit-callbacks).

Sources: [state machines](https://simtlix.github.io/simfinity.js/guide/state-machines.html), [controllers](https://simtlix.github.io/simfinity.js/guide/controllers.html), [middleware](https://simtlix.github.io/simfinity.js/guide/middleware.html), [transaction boundaries](https://simtlix.github.io/simfinity.js/guide/mutations.html#transaction-boundaries).
