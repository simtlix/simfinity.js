---
title: Barber example app
description: Run a booking app with independent MongoDB and PostgreSQL backends, one shared Next.js frontend, GraphQL, MCP, and synthetic demo data.
---

# Barber example app

The [Barber examples](https://github.com/simtlix/simfinity.js/tree/master/examples/barber) put Simfinity's generated API into a booking application. Run either database backend with the same Next.js frontend, then explore customer booking, the owner dashboard, and shop administration.

Both apps consume released Simfinity runtime packages at exactly **3.2.0** from npm. Each backend and the shared frontend have independent manifests and lockfiles outside the library workspaces. The examples have a dedicated validation workflow and are not npm libraries.

For a smaller starting point, use the [MongoDB quick start](/guide/getting-started) or [PostgreSQL quick start](/guide/postgresql).

## Run an example

Install Docker with Compose v2, clone the repository, and enter the example directory:

```sh
git clone https://github.com/simtlix/simfinity.js.git
cd simfinity.js/examples/barber
cp .env.example .env
```

Choose one stack:

::: code-group

```sh [MongoDB]
docker compose -f compose.mongodb.yaml up --build -d --wait
docker compose -f compose.mongodb.yaml exec backend npm run seed:admin
docker compose -f compose.mongodb.yaml exec backend npm run seed:demo
```

```sh [PostgreSQL]
docker compose -f compose.postgres.yaml up --build -d --wait
docker compose -f compose.postgres.yaml exec backend npm run seed:admin
docker compose -f compose.postgres.yaml exec backend npm run seed:demo
```

:::

| | MongoDB | PostgreSQL |
| --- | --- | --- |
| Open the app | `http://localhost:4401` | `http://localhost:4501` |
| GraphQL / GraphiQL | `http://localhost:4400/graphql` | `http://localhost:4500/graphql` |
| MCP HTTP endpoint | `http://localhost:4400/mcp` | `http://localhost:4500/mcp` |
| Database host port | `57417` | `55441` |

Compose waits for database and application health. MongoDB runs a single-node replica set; PostgreSQL runs version 18 and initializes the generated storage. The projects have separate ports and volumes, so both can run together. Their ports bind to loopback by default.

## Explore the booking flow

The minimal seed creates an approved shop with slug `barber-demo`, a service named “Corte clásico”, and the professional “Alex Demo”. Sign in with one of these synthetic accounts; all use password `demo1234`:

| Account | Role | Example flow |
| --- | --- | --- |
| `cliente@demo.com` | Client | Browse the shop, select a service and professional, and create a booking. |
| `propietario@demo.com` | Owner | Manage the shop's catalog and bookings in the dashboard. |
| `admin@demo.com` | Platform administrator | Inspect users and shop approval. |

This is a local MVP with synthetic data. Payment is on site, and the reminder job is a stub. The example demonstrates application patterns rather than a production deployment configuration.

## From the homepage to the running app

The homepage's interactive example follows a simplified shop profile and its embedded opening hours. After seeding either stack, run this query in its GraphiQL endpoint to explore the complete app:

```graphql
query FindBarberShop {
  barbershops(
    slug: { operator: EQ, value: "barber-demo" }
    pagination: { page: 1, size: 10 }
  ) {
    id
    name
    slug
    businessHours { dayOfWeek openTime closeTime }
    services { id name price durationMinutes }
    professionals { id name }
  }
}
```

The query is identical for MongoDB and PostgreSQL. The seed creates “Simfinity Barber Demo”, opening hours from 09:00 to 18:00, “Corte clásico”, and “Alex Demo”. IDs come from your database; homepage IDs are illustrative.

Opening hours are embedded values. Services and professionals are separate records linked back to the shop through `extensions.relation.connectionField`. See the actual shop definitions for [MongoDB](https://github.com/simtlix/simfinity.js/blob/master/examples/barber/mongodb/types/barbershop.js) and [PostgreSQL](https://github.com/simtlix/simfinity.js/blob/master/examples/barber/postgres/types/barbershop.js), including their scopes and controller registration.

The homepage also shows `bookings_aggregate` and `complete_booking`. These operate within the authenticated caller's permissions and scopes. To complete a booking, sign in as its shop owner or an administrator, use an existing confirmed booking's ID, and invoke its state action:

```graphql
mutation CompleteBooking($id: ID!) {
  complete_booking(input: { id: $id }) {
    id
    state
  }
}
```

Provide the access token as an `Authorization: Bearer …` header in GraphiQL and the booking ID in query variables. The [booking state machine](https://github.com/simtlix/simfinity.js/blob/master/examples/barber/postgres/types/booking.stateMachine.js) defines the transition from `CONFIRMED` to `COMPLETED`; authorization and ownership checks still apply. The same operations are available through MCP with the app's verified user context and auth plugin.

## What the code demonstrates

GraphQL types describe shops, services, bundles, professionals, bookings, reviews, favorites, and notifications. Relationship metadata connects them; generated operations support the frontend's reads and writes. Controllers enforce domain checks and derive values such as booking totals. State machines implement shop approval and booking transitions.

Query scopes and JWT permission rules apply according to the current user. HTTP MCP calls use the same bearer-token context as GraphQL, and each backend also provides `npm run mcp:stdio` for an MCP process with a configured user context.

| Concern | MongoDB implementation | PostgreSQL implementation |
| --- | --- | --- |
| Identity | ObjectId exposed as GraphQL `ID` | UUID exposed as GraphQL `ID` |
| Native access | Mongoose models, documents, and sessions | PostgreSQL models, plain records, and sessions |
| Relationships | References and embedded documents | UUID foreign keys, JSONB values, and private tables for embedded references |
| Initialization | Connect to the replica set and register types | Register types and await storage initialization |

The shared frontend treats IDs as opaque strings. The backends keep their native database operations separate while demonstrating the same domain concepts. The [database guide](/guide/databases) and [PostgreSQL reference](/postgresql) explain the broader compatibility boundaries.

To inspect the PostgreSQL schema, run `npm run schema:export` from `examples/barber/postgres` with its database configured. It writes current GraphQL SDL, generated SQL, and foreign keys read from the real PostgreSQL catalog into ignored `generated/` files. These are local inspection artifacts, not packaged downloads.

## Development and validation

Use Node.js 24 for host development and install each app with its own `npm ci`. Backend `.env.example` files configure host database connections and API ports. The frontend uses `.env.local`; its `NEXT_PUBLIC_GRAPHQL_URL` must be browser-reachable and is embedded at build time.

The [Barber workflow](https://github.com/simtlix/simfinity.js/blob/master/.github/workflows/barber.yml) runs independently from library CI. It validates backend units, frontend checks, HTTP/MCP behavior, and browser flows against both databases. Both backends check real transactions, derived domain values, and dataset loading/deletion; PostgreSQL adds storage, foreign-key, and frontend-query checks. Root library lint and Vitest discovery exclude example applications.

The repository runbooks contain environment options, commands, and source provenance:

- [Full setup, demo data, and reset commands](https://github.com/simtlix/simfinity.js/blob/master/examples/barber/README.md)
- [MongoDB backend](https://github.com/simtlix/simfinity.js/blob/master/examples/barber/mongodb/README.md)
- [PostgreSQL backend](https://github.com/simtlix/simfinity.js/blob/master/examples/barber/postgres/README.md)
- [Shared frontend](https://github.com/simtlix/simfinity.js/blob/master/examples/barber/frontend/README.md)

## Stop or reset

From `examples/barber`, stop the selected project while keeping its data:

```sh
docker compose -f compose.mongodb.yaml down
# Or:
docker compose -f compose.postgres.yaml down
```

Add `--volumes` only to erase that example's database and uploaded demo files. Start and seed it again to restore a fresh demo. Each Compose file targets its own named project, so resetting one leaves the other stack's data intact.
