---
title: State machines
description: Define valid lifecycle transitions with GraphQL enums and generated action mutations.
---

# State machines

A state machine defines an entity's initial state and the actions that move it between states. Simfinity generates a mutation for each action, rejects invalid source states, and keeps the managed `state` field out of ordinary create and update inputs.

<DomainDiagram kind="states" />

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
import * as simfinity from '@simtlix/simfinity-js';

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

Use enum values whose internal value equals the enum name, as above. Simfinity persists state names and returns the configured values on creation and transition; keeping these equal makes reads and mutation responses consistent.

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

## Failure behavior

| Condition | Result |
| --- | --- |
| ID does not identify a record | `SimfinityError` with code `NOT_VALID_ID` and status `404` |
| Current state does not match the action's `from` | `SimfinityError` with code `BAD_REQUEST` and status `400` |
| Action callback or update validation throws | The mutation transaction is aborted |
| Transient transaction failure | The mutation may be retried, including its callback |

Each action has one `from` state and one `to` state. Define separate actions for distinct transitions. State machines govern transition validity; they do not decide which users may invoke an action. Add explicit authorization for action fields such as `activate_season`.

Keep external side effects outside the transaction callback or use an outbox pattern, as described in [controllers](./controllers#transactions-and-side-effects).
