---
title: State machines
description: Define valid lifecycle transitions with GraphQL enums and generated action mutations.
---

# State machines

A state machine defines an entity's initial state and the actions that move it between states. Simfinity generates a mutation for each action, rejects invalid source states, and keeps the managed `state` field out of ordinary create and update inputs.

<DomainDiagram kind="states" />

Examples use the selected runtime from [database setup](./databases#runtime-setup-for-shared-examples). After `createSchema()`, PostgreSQL also requires awaited storage initialization before operations are served.

## Define the lifecycle

For a season, use this progression:

```text
SCHEDULED ──activate──▶ ACTIVE ──finalize──▶ FINISHED
```

Define a GraphQL enum, expose it as the type's `state` field, and use enum value objects in the machine configuration:

```javascript
import {
  GraphQLEnumType,
  GraphQLID,
  GraphQLInt,
  GraphQLNonNull,
  GraphQLObjectType,
} from 'graphql';
import { simfinity } from './runtime.js';

const SeasonState = new GraphQLEnumType({
  name: 'SeasonState',
  values: {
    SCHEDULED: { value: 'SCHEDULED' },
    ACTIVE: { value: 'ACTIVE' },
    FINISHED: { value: 'FINISHED' },
  },
});

const SeasonType = new GraphQLObjectType({
  name: 'Season',
  fields: {
    id: { type: GraphQLID },
    number: { type: new GraphQLNonNull(GraphQLInt) },
    year: { type: GraphQLInt },
    state: { type: SeasonState },
  },
});

const stateMachine = {
  initialState: SeasonState.getValue('SCHEDULED'),
  actions: {
    activate: {
      description: 'Start airing a scheduled season.',
      from: SeasonState.getValue('SCHEDULED'),
      to: SeasonState.getValue('ACTIVE'),
    },
    finalize: {
      description: 'Mark an active season as finished.',
      from: SeasonState.getValue('ACTIVE'),
      to: SeasonState.getValue('FINISHED'),
    },
  },
};

simfinity.connect(
  null,
  SeasonType,
  'season',
  'seasons',
  null,
  null,
  stateMachine,
);

const schema = simfinity.createSchema();
```

This is a self-contained `Season` type. Add the `serie` relationship from the [relationships guide](./relationships) if you are building on the catalog example.

Use enum values whose internal value equals the enum name, as above. MongoDB persists state names and PostgreSQL persists the enum's internal values, and both return the configured values on creation and transition; keeping these equal makes reads and mutation responses consistent.

On PostgreSQL and other SQL backends, `state` must be a GraphQL enum field: `createSchema()` rejects a `String`, `Int`, embedded object or other `state` field with `INVALID_MODEL` (400, `State machine field Season.state must be a GraphQL enum on SQL backends`).

## Create in the initial state

```graphql
mutation {
  addseason(input: { number: 1, year: 2026 }) {
    id
    number
    state
  }
}
```

The returned state is `SCHEDULED`. A client cannot choose `state` in this creation input or directly write it through `updateseason`.

## Execute an action

Mutation names use `{actionName}_{singular}`. Run these operations in order with the ID returned from `addseason`:

::: code-group

```graphql [Activate]
mutation ActivateSeason($id: ID!) {
  activate_season(input: { id: $id }) {
    id
    state
  }
}
```

```graphql [Finalize]
mutation FinalizeSeason($id: ID!) {
  finalize_season(input: { id: $id }) {
    id
    state
  }
}
```

:::

An action takes the generated update input, so it can include other writable fields alongside `id`:

```graphql
mutation ActivateSeason($id: ID!) {
  activate_season(input: { id: $id, year: 2026 }) {
    id
    year
    state
  }
}
```

Run this alternative while the season is still `SCHEDULED`. Calling `activate_season` again after activation is rejected because the persisted source state no longer matches.

## Add transition behavior

An action can provide an asynchronous callback:

```javascript
activate: {
  from: SeasonState.getValue('SCHEDULED'),
  to: SeasonState.getValue('ACTIVE'),
  action: async (input, session) => {
    const season = await simfinity.getModel(SeasonType)
      .findById(input.id)
      .session(session);

    if ((input.year ?? season.year) == null) {
      throw new simfinity.SimfinityError(
        'Set the year before activating this season',
        'YEAR_REQUIRED',
        400,
      );
    }
  },
}
```

Replace the `activate` entry in `stateMachine.actions` with this configuration before calling `connect()`. The callback receives the mutation input and transaction session. It does not receive GraphQL context; use [middleware](./middleware), [authorization](./authorization), or controller hooks for context-dependent policy.

The callback runs after the source-state check and before the managed state is added to the update. Throwing aborts the transition. The resulting update also passes through update validators and the type's update controller hooks.

The lookup above uses the MongoDB Model API. With PostgreSQL, use `await simfinity.getModel(SeasonType).findById(input.id, { session })`; it returns a plain record and joins the same transaction.

Next release: actions on a protected entity take its generated update input with required `input.version`; successful actions return the incremented version, and the precondition is captured before `action` can mutate its input. Re-read and reapply after `VERSION_CONFLICT` or `TRANSACTION_RETRY_EXCEEDED`. Driver retries can repeat an action; use an outbox for external effects. Protection applies to the action's record, not its whole relationship graph. See [optimistic concurrency](./concurrency).

## Run an action from code (next release)

Server code, such as a job, a hook or a custom mutation, can run an action without going through GraphQL. `transitionObject(typeName, actionName, input, session?, context?)` runs the lifecycle of the generated action mutation and resolves to the updated record, with `state` set to the action's target state:

```javascript
const season = await simfinity.transitionObject('Season', 'activate', { id: String(seasonId), year: 2026 }, session, context);
```

`actionName` is the key under `stateMachine.actions`, not the mutation name. It runs the same steps as `activate_season`: the check of the current state, the action's callback, the update with its validators and controller hooks, and, for a protected type, the version precondition. `input` has the shape of the generated update input, so it can carry other writable fields next to `id`, but never `state`: the helper rejects it with `INVALID_INPUT` (400), because the state changes only through the action. An action that the type does not declare, or a type without a state machine, is `UNKNOWN_ACTION` (500), and a record in another state than the action's `from` is `BAD_REQUEST` (400), as for the mutation.

Like `saveObject()`, it skips GraphQL coercion, field authorization and the global middleware of the record, so authorize the caller yourself. Pass the active session when you call it from a hook or a custom mutation, and the `context` for the middleware of nested children. Input rules, sessions, errors and limits are those of the other lifecycle helpers; see [update, delete and transition from code](./server-side-operations#update-delete-and-transition-from-code-next-release) and the [API reference](../reference/api#updateobject-deleteobject-and-transitionobject).

A [transaction mutation](./mutations#run-several-mutations-in-one-transaction-next-release) can also run actions: each action of a configured type is an operation named like its mutation, such as `activate_season`, whose value is that action's input.

## Failure behavior

| Condition | Result |
| --- | --- |
| ID is malformed for the backend | `SimfinityError` with code `NOT_VALID_ID` and status `400` |
| ID does not identify a record | `SimfinityError` with code `NOT_VALID_ID` and status `404` |
| Protected action has a stale version (next release) | `VERSION_CONFLICT` (409), before the source-state check/action for a caller visible to `get_by_id` scope |
| Protected update cannot advance past the maximum version (next release) | `VERSION_EXHAUSTED` (409); a hidden caller reaches its usual checks/hooks first |
| Current state does not match the action's `from` | `SimfinityError` with code `BAD_REQUEST` and status `400` |
| Action callback or update validation throws | The mutation transaction is aborted |
| Transient transaction failure | The mutation may be retried, including its callback |

Each action has one `from` state and one `to` state. Define separate actions for distinct transitions. State machines govern transition validity; they do not decide which users may invoke an action. Add explicit authorization for action fields such as `activate_season`.

Keep external side effects outside the transaction callback or use an outbox pattern, as described in [controllers](./controllers#transactions-and-side-effects).
