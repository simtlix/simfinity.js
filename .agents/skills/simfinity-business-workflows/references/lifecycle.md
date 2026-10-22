# Place each rule

| Rule | Place |
| --- | --- |
| Input shape and scalar validation | GraphQL types/scalars |
| Field and materialized-record validation | `extensions.validations` CREATE/UPDATE rules |
| Current ownership, context-dependent invariant, server values | Controller using context and session |
| Fixed transition graph | Registered enum state machine plus explicit action permissions |
| Data-driven/versioned workflow | Application model/policy and an atomic transition command |
| Audit, totals, outbox in the same transaction | Appropriate controller/custom mutation using its session |
| Irreversible email/webhook | Worker processing the committed outbox |

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

`OrderType.state` must be the enum field; use string internal values matching enum names for portable behavior. Managed state is excluded from ordinary add/update inputs. The generated action is `approve_order`, with the update input and one configured source/destination. Authorize that action explicitly; a valid source state does not grant permission.

The optional `action(input, session)` callback runs after the persisted source-state check and before the managed state update. It does not receive context. Use auth, `state_changed` middleware or controllers for actor-dependent policy, remembering root middleware is outside the transaction. The resulting update executes validators/controllers. Do not assume an ordinary update action key identifies a state transition.

Do not rebuild schemas per request to encode each user's workflow. A configurable graph with revision IDs, drafts and migration rules is application data. Keep its transition rules and concurrency checks explicit; a registered command can be the entry point, but native writes need their own lifecycle checks. Concurrency #98 and operation-list transactions #100 were proposals at 3.7.0. Current source adds #98 for the next release, not 3.12.0; confirm the installed version and follow [optimistic concurrency](https://simtlix.github.io/simfinity.js/guide/concurrency.html). This does not change #100's status. Protected writes need observed record versions; same-revision derived totals use MongoDB `updateOne` without version changes or PostgreSQL `{ session, version: false }`.

## Hooks and nested work

Signatures: `onSaving(record, input, session, context)`, `onSaved(record, input, session, context)`, `onUpdating(id, changes, session, context)`, `onUpdated(record, session, context)`, `onDelete(record, session, context)`. A missing delete target may be null. Hook record shapes differ by engine.

Nested referenced children run their own middleware, ownership checks, validators and controllers in the parent's transaction. They do not run the child's root mutation permission rule; enforce required child write permissions in controllers/middleware. Parent `onSaved`/`onUpdated` run after children. Compute totals from those stored children using the session, persist the total and update the returned parent. Implement both create and update paths. Child root mutations do not run the parent's hooks: exclude them when the aggregate requires changes through the parent, or maintain the invariant there too.

Neither `onSaved` nor `onUpdated` is after commit. Retries can rerun hooks and custom callbacks. Await session operations sequentially and use outbox records for external effects. On PostgreSQL, catching a failed statement does not restore the transaction; use a savepoint for an intentionally recoverable statement.

`simfinity.use()` is pre-execution: `await next()` advances middleware, not the database operation. Code after it still precedes persistence, and omitting it does not cancel the operation. Throw to reject; use controllers for persistence hooks.

Sources: [state machines](https://simtlix.github.io/simfinity.js/guide/state-machines.html), [controllers](https://simtlix.github.io/simfinity.js/guide/controllers.html), [middleware](https://simtlix.github.io/simfinity.js/guide/middleware.html), [transaction boundaries](https://simtlix.github.io/simfinity.js/guide/mutations.html#transaction-boundaries).
