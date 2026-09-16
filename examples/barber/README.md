# Barber examples

Run the same barbershop booking app with either MongoDB or PostgreSQL. Both backends demonstrate generated GraphQL operations, relationships, query scopes, JWT authorization, controllers, state machines, and MCP tools. A shared Next.js frontend provides customer booking, an owner dashboard, and administration screens.

These are independent, private npm applications in the Simfinity monorepo. They install released Simfinity runtime packages at exactly **3.3.0** from npm, with their own manifests and lockfiles. They are outside the `packages/*` workspaces and are not published with the libraries.

## Start with Docker

Install Docker with Compose v2. Run the commands from `examples/barber`; a root `npm install` is not required for this flow.

```sh
cd examples/barber
cp .env.example .env
```

Choose a stack, then create the synthetic demo accounts and shop:

```sh
docker compose -f compose.mongodb.yaml up --build -d --wait
docker compose -f compose.mongodb.yaml exec backend npm run seed:admin
docker compose -f compose.mongodb.yaml exec backend npm run seed:demo
```

Or use PostgreSQL:

```sh
docker compose -f compose.postgres.yaml up --build -d --wait
docker compose -f compose.postgres.yaml exec backend npm run seed:admin
docker compose -f compose.postgres.yaml exec backend npm run seed:demo
```

| Endpoint | MongoDB stack | PostgreSQL stack |
| --- | --- | --- |
| Frontend | [localhost:4401](http://localhost:4401) | [localhost:4501](http://localhost:4501) |
| GraphQL / GraphiQL | [localhost:4400/graphql](http://localhost:4400/graphql) | [localhost:4500/graphql](http://localhost:4500/graphql) |
| Health | [localhost:4400/health](http://localhost:4400/health) | [localhost:4500/health](http://localhost:4500/health) |
| MCP Streamable HTTP | `http://localhost:4400/mcp` | `http://localhost:4500/mcp` |
| Database host port | `57417` | `55441` |

The Compose projects are `simfinity-example-barber-mongodb` and `simfinity-example-barber-postgres`. Their ports, databases, and named volumes are separate, so both can run together. Inside each project's network, the backend listens on `4300` and the frontend on `4301`; those are container ports, not the default host ports.

MongoDB uses a single-node replica set initialized by its health check. PostgreSQL uses version 18 and waits for generated storage initialization before the API is ready.

## Try the demo

All three accounts use the password **`demo1234`**:

| Account | Role | Try |
| --- | --- | --- |
| `cliente@demo.com` | Client | Find the demo shop and book a service. |
| `propietario@demo.com` | Owner | Open the dashboard and manage the shop's catalog and bookings. |
| `admin@demo.com` | Platform administrator | Inspect users and the shop approval workflow. |

`seed:demo` creates the approved shop with slug `barber-demo`, the service “Corte clásico”, and the professional “Alex Demo”. It uses the running GraphQL API, so run `seed:admin` first and wait for a healthy backend. Each stack has its own data and generated IDs.

The accounts, passwords, addresses, and dataset are synthetic local demo fixtures. This MVP demonstrates application patterns; it is not a production deployment recipe. Payments are on site, and the reminder job is a stub.

## Configure and develop

The example root [`.env.example`](.env.example) controls Compose host ports, bind address, public hostname, PostgreSQL password, and JWT secrets. Ports bind to `127.0.0.1` by default. After changing ports or `PUBLIC_HOST`, rebuild the stack: Next.js embeds the browser's GraphQL URL at build time.

For host development, use Node.js 24 and install each app independently with `npm ci` in its directory. Each backend's `.env.example` supplies its host connection and API settings; the frontend uses `.env.local`.

- [MongoDB backend setup and commands](mongodb/README.md)
- [PostgreSQL backend setup, native APIs, and schema export](postgres/README.md)
- [Shared frontend setup and tests](frontend/README.md)

The root Compose `.env` and the app-specific environment files serve different processes. Keep connection strings and JWT secrets consistent when mixing a host process with Docker services.

## What to compare

| Concern | MongoDB backend | PostgreSQL backend |
| --- | --- | --- |
| Runtime dependency | `@simtlix/simfinity-js` | `@simtlix/simfinity-postgres`, shared core, and MCP |
| GraphQL identity | ObjectId represented as `ID` | UUID represented as `ID` |
| Native database work | Mongoose models, documents, and sessions | PostgreSQL models, plain records, and sessions |
| Relationships | Mongoose references and embedded documents | UUID foreign keys, JSONB values, and private owned tables for embedded references |
| Startup | Connect to the replica set and register the schema | Register the schema and await generated storage initialization |

The shared frontend treats IDs as opaque strings. Relationship metadata, role scopes, controller responsibilities, and state transitions express the same domain, while native database calls stay in their own backend. Choosing a Compose file selects an application; there is no runtime database switch or automatic data migration.

Start reading either backend at `application.js`, then inspect `types/`, `auth/`, and `database.js`. Entity files register GraphQL types; adjacent `.scopes.js`, `.controller.js`, and `.stateMachine.js` files hold behavior. The domain includes users, shops, categories, services, bundles, professionals, bookings, reviews, favorites, and notifications.

Both APIs also expose `/mcp`. HTTP requests use the same bearer JWT context as GraphQL. The `mcp:stdio` command provides a separate transport bound to the `MCP_BEARER` environment variable; see the backend READMEs.

## Validate changes

Install and run each backend's unit suite from the repository root:

```sh
npm ci --prefix examples/barber/mongodb
npm test --prefix examples/barber/mongodb
npm ci --prefix examples/barber/postgres
npm test --prefix examples/barber/postgres
```

With a stack running and seeded, run its shared HTTP contract from the matching backend directory:

```sh
# In examples/barber/mongodb
GRAPHQL_ENDPOINT=http://localhost:4400/graphql npm run test:http

# In examples/barber/postgres
GRAPHQL_ENDPOINT=http://localhost:4500/graphql npm run test:http
```

Run the filter, aggregation and nested-mutation matrix against each disposable API:

```sh
GRAPHQL_ENDPOINT=http://localhost:4400/graphql npm run test:query-mutations --prefix examples/barber/mongodb
GRAPHQL_ENDPOINT=http://localhost:4500/graphql npm run test:query-mutations --prefix examples/barber/postgres
```

Run these two commands from the repository root. The matrix creates its own synthetic users and catalog after `seed:admin`; it leaves them in the disposable database for diagnosis. It checks scalar/enum/null filters, nested AND/OR groups, relation paths, sorting/counts/pagination, COUNT/SUM/AVG/MIN/MAX with filters, scopes, nested create/update/delete, embedded replacement/clearing, authorization and transactional rollback. Set `CONTRACT_REPORT` to write a JSON result file. The dedicated CI runs it on both databases and saves the reports.

The scopes preserve caller filters and intersect them with server restrictions. For example, selecting one shop still returns only that shop when the owner can access several; a booking OR filter remains combined with the owner's access rule. A requested user ID outside the scope returns null or an empty list.

**Reference integrity differs:** PostgreSQL FKs reject an embedded reference to a nonexistent service and roll back the mutation. MongoDB can store that reference and resolve it to null on reads; Mongoose references are not foreign keys. The matrix checks this difference explicitly. Add application validation when the MongoDB API must reject missing references too.

These tests exercise login, scopes, booking, and MCP against a real backend and create test records. Both backends also have real-database checks for transactions, derived domain values, and dataset loading/deletion. PostgreSQL adds storage, foreign-key, and frontend-query checks; see the backend READMEs. The frontend has its own unit, type, build, and browser checks.

The dedicated [Barber workflow](../../.github/workflows/barber.yml) owns these apps' validation, including a database matrix and browser checks against both backends. Root library lint and Vitest discovery exclude `examples/`; root package release checks do not install or publish these apps. Example changes do not require an npm library release.

## Stop or reset one stack

Stop the selected project while preserving its data:

```sh
docker compose -f compose.mongodb.yaml down
# Or:
docker compose -f compose.postgres.yaml down
```

To erase only the selected example's database and uploaded demo files, add `--volumes`:

```sh
docker compose -f compose.mongodb.yaml down --volumes
# Or:
docker compose -f compose.postgres.yaml down --volumes
```

Start and seed that stack again for a fresh demo. These commands target the named project in the selected Compose file.

`dataset:load` loads the larger synthetic fixture through GraphQL after `seed:admin`. `dataset:delete` removes all records of the covered catalog and activity types at its configured endpoint, including records created through the UI, while retaining user accounts. Use these commands only against a disposable example database.

## Source and license

These examples were adapted from [`claudiojgonzalez/simfinity-barber`](https://github.com/claudiojgonzalez/simfinity-barber):

- MongoDB backend: commit [`00718c0195374ab1baaefd32d8a24e21a238b4c3`](https://github.com/claudiojgonzalez/simfinity-barber/tree/00718c0195374ab1baaefd32d8a24e21a238b4c3).
- PostgreSQL backend and shared frontend: local PostgreSQL port commit `d149c625100178f412b792d961a8ac4f42dc78b8` from the source checkout; this commit was not published in the original repository.

The monorepo uses the [Apache 2.0 License](../../LICENSE); the original [frontend license](frontend/LICENSE) is retained. Environment files, private uploads, dependency directories, local vendor archives, and generated schema exports are not part of the source examples.
