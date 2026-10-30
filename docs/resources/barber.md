---
title: Barber example app
description: Run a booking app with independent MongoDB and PostgreSQL backends, one shared Next.js frontend, GraphQL, MCP, and synthetic demo data.
---

# Barber example app

The [Barber examples](https://github.com/simtlix/simfinity.js/tree/master/examples/barber) put Simfinity's generated API into a booking application. Run either database backend with the same Next.js frontend, then explore customer booking, the owner dashboard, and shop administration.

Both backends consume released Simfinity runtime packages at exactly **3.19.0** from npm; the shared frontend pins `@simtlix/simfinity-js-client` to the same version and uses its bundled TypeScript declarations. Each backend and the shared frontend have independent manifests and lockfiles outside the library workspaces. The examples have a dedicated validation workflow and are not npm libraries.

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

Run `seed:admin` right after the stack is up. It creates `admin@demo.com` directly in the database, or reactivates that admin and keeps its password, but it never promotes an account someone already registered with that email. In that case it exits with an error; reset the stack with `docker compose -f compose.<db>.yaml down --volumes` and start again. Another admin email does not help, because `seed:demo`, the contract tests, the browser tests and the login page's demo button all use `admin@demo.com`. `seed:demo` finds the demo shop by slug and finishes a demo that an earlier run left incomplete.

| | MongoDB | PostgreSQL |
| --- | --- | --- |
| Open the app | `http://localhost:4401` | `http://localhost:4501` |
| GraphQL / GraphiQL | `http://localhost:4400/graphql` | `http://localhost:4500/graphql` |
| MCP HTTP endpoint | `http://localhost:4400/mcp` | `http://localhost:4500/mcp` |
| Database host port | `57417` | `55441` |

Compose waits for database and application health. MongoDB runs a single-node replica set; PostgreSQL runs version 18 and initializes the generated storage. The projects have separate ports and volumes, so both can run together. Their ports bind to loopback by default.

## Explore the booking flow

Bookings use optimistic concurrency: the UI sends the version it loaded, so an owner saving an old edit cannot undo a client reschedule. Conflicts require a reload. Existing PostgreSQL installations need the explicit version-column migration in the [example upgrade instructions](https://github.com/simtlix/simfinity.js/tree/master/examples/barber#upgrading-an-existing-booking-database); MongoDB needs no migration.

New shops start in `PENDING_REVIEW` with one create mutation. They remain private until approved. Existing `DRAFT` shops need no migration and can still be submitted by their owner or a platform admin.

The minimal seed creates an approved shop with slug `barber-demo`, a service named “Corte clásico”, and the professional “Alex Demo”. Sign in with one of these synthetic accounts; all use password `demo1234`:

| Account | Role | Example flow |
| --- | --- | --- |
| `cliente@demo.com` | Client | Browse the shop, select a service and professional, and create a booking. |
| `propietario@demo.com` | Owner | Manage the shop's catalog and bookings in the dashboard. |
| `admin@demo.com` | Platform administrator | Inspect users and shop approval. |

This is a local MVP with synthetic data. Payment is on site, and the reminder job is a stub. The example demonstrates application patterns rather than a production deployment configuration.

Both APIs validate confirmed bookings on the server. A booking must fit the shop's hours, narrowed by the professional's own hours, outside both breaks, respect the advance window and buffer, and not overlap another confirmed booking of the same professional. Each line must reference one service or bundle of the booking's shop, and line durations and prices come from that shop's catalog. The API derives `totalPrice` and `endTime`, ignores values sent by the client, and owns confirmation codes and creation times. Bundles must list services of their own shop, and their stored duration follows their services' durations. Clients cannot book inactive services or bundles. Concurrent bookings for one schedule are serialized in the database transaction. Updates are rechecked only when they change the booking's time, professional or services, so edit forms can resend unchanged fields. Because clients cannot read other clients' bookings, the booking page reads taken times from the barbershop's [virtual](../guide/queries#virtual-fields) `busyRanges(date:)` field, which returns only times and professional IDs to signed-in users through the generated `barbershop(id:)` query. No backend stores it, and MCP agents read it through the generated `barbershop_busyRanges` read tool. Earlier versions served the same read as the `bookingAvailability` custom mutation. Rescheduling updates the existing booking in one mutation, so a rejected new time leaves the original booking confirmed. See the [booking rules](https://github.com/simtlix/simfinity.js/blob/master/examples/barber/README.md#booking-rules).

The booking page reschedules through `reschedule_booking`, a `CONFIRMED -> CONFIRMED` state action that checks the current state and new slot in the same transaction. If the shop cancels or completes the booking while the form is open, the action rejects and the page reports the state change. A slot rejection preserves the original booking. Professional hours narrow the shop's window only when both opening and closing times are set; partial rows still contribute closed days and breaks.

Search boxes use case-insensitive literal text matching. Dashboard totals use server aggregates, and the booking calendar loads every page instead of stopping at 100 appointments. Admin rejection stores its reason in the same state transition; the owner's unanswered-review filter also finds empty replies.

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

Provide the access token as an `Authorization: Bearer …` header in GraphiQL and the booking ID in query variables. The [booking state machine](https://github.com/simtlix/simfinity.js/blob/master/examples/barber/postgres/types/booking.stateMachine.js) defines the transition from `CONFIRMED` to `COMPLETED`; authorization and ownership checks still apply. The same operations are available through MCP with the app's verified user context and auth plugin, except `login`, `register`, `registerOwner` and `refreshSession`, which stay GraphQL-only.

## API verification

Both backends provide `npm run test:query-mutations` for a running disposable GraphQL API. The shared matrix checks filters and nested AND/OR groups, filtered aggregates, relation joins, scopes and nested mutations with rollback. CI runs the same expected results against both databases. See the [test commands and data boundaries](https://github.com/simtlix/simfinity.js/blob/master/examples/barber/README.md#validate-changes).

Scopes intersect caller filters with access restrictions. Owners see approved shops plus their own shops in any state; other owners' unpublished shops are hidden from lists, reads by ID, aggregates and MCP tools. Catalog scopes and the owner branch of the booking scope restrict through the barbershop relation inside the query itself: its state for anonymous users and clients, its owner for owners. No scope loads shop IDs, although referenced records whose type has a `get_by_id` scope are still read with one query per reference. PostgreSQL additionally enforces foreign keys; this MongoDB example keeps the default integrity mode and can store a nonexistent referenced ID and resolve it to null. The matrix records this integrity difference explicitly. Since 3.4.0, Simfinity offers optional [transactional Mongo reference integrity](../guide/mongodb-integrity); the MongoDB example does not enable it.

## What the code demonstrates

GraphQL types describe shops, services, bundles, professionals, bookings, reviews, favorites, and notifications. Relationship metadata connects them; generated operations support the frontend's reads and writes. Controllers enforce domain checks and derive values such as booking totals. State machines implement shop approval and booking transitions. Reviews need the author's completed booking at an approved shop, one review per booking, and shop owners reply to and flag them. Bookings keep their shop, and clients cancel rather than delete them. A shop owner cannot delete a shop that bookings or reviews reference, or a booking that a review references; both APIs answer `RESOURCE_IN_USE`. A platform admin's delete is not checked: PostgreSQL's foreign keys refuse it, while on MongoDB the dependent bookings and reviews keep an ID that resolves to null.

Query scopes and JWT permission rules apply according to the current user. Every authenticated request reads the account, so suspending it blocks sign-in and stops tokens already issued, and requests use the role stored in the database. HTTP MCP calls use the same bearer-token context as GraphQL; get the access token from the GraphQL `login` mutation. Unlike GraphQL, MCP fails a call whose token is expired or invalid, or belongs to a suspended or deleted account, instead of running it as anonymous. Each backend also provides `npm run mcp:stdio` for an MCP process signed in with an access token and, optionally, a refresh token that renews it. GraphQL, MCP and uploads each have their own per-IP rate limit, and uploads also a per-account limit. Uploads accept JPEG, PNG, WebP and GIF images, detected from their bytes, and serve every stored file inert: nosniff and a sandbox CSP, plus `application/octet-stream` attachments for files that are not raster images (legacy SVG images keep `image/svg+xml` so `<img>` still shows them). Both backends mount the HTTP handler for every method, as the [MCP guide](../guide/mcp) recommends: it serves `POST` and answers other methods, such as a client's event-stream `GET`, with `405`.

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

The [Barber workflow](https://github.com/simtlix/simfinity.js/blob/master/.github/workflows/barber.yml) runs independently from library CI. It validates backend lint and units, frontend checks, HTTP/MCP behavior, and browser flows against both databases. Both backends check real transactions, derived domain values, and dataset loading/deletion; PostgreSQL adds storage, foreign-key, and frontend-query checks. Root library lint and Vitest discovery exclude example applications.

Both backends run `npm run lint` with the published Simfinity ESLint plugin 0.5.0 and `recommended-3.8` preset. Its static checks complement the HTTP and database tests.

Each application also runs `npm run test:security` against its complete lockfile, including development tools. Use the committed lockfiles with `npm ci`: the backends require GraphQL Yoga `^5.24.4` and include patched transitive dependencies. See the [dependency validation notes](https://github.com/simtlix/simfinity.js/blob/master/examples/barber/README.md#validate-changes) before updating them.

Each backend's `index.yoga.js` logs every GraphQL error through `buildErrorFormatter`, one entry of the `errors` list that Envelop's `useErrorHandler` receives at a time, as the [error reference](../reference/errors#connect-it-to-your-server) describes. Logging does not change responses.

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
