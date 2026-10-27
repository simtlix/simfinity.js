# Barber PostgreSQL backend

An independent, private application using the released `@simtlix/simfinity-postgres`, `@simtlix/simfinity-core`, and `@simtlix/simfinity-mcp` packages at exactly **3.15.0**. It uses Express, GraphQL Yoga, and `pg`, with no MongoDB or Mongoose runtime dependency. PostgreSQL delegates relational planning and runtime orchestration to `@simtlix/simfinity-sql`. This app retains the compatible PostgreSQL facade; the [SQL plugin guide](https://simtlix.github.io/simfinity.js/guide/sql-plugins.html) shows explicit plugin composition. It is outside the library workspaces and installs from npm without vendor archives.

Use the [Barber quick start](../README.md) to run the complete Docker stack with the shared frontend.

## Host development

Use Node.js 24. From `examples/barber`, start PostgreSQL, then run the backend on the host:

```sh
docker compose -f compose.postgres.yaml up -d --wait db
cd postgres
cp .env.example .env
npm ci
npm run dev
```

If the full stack is already running, stop its backend and frontend before using the same host ports:

```sh
# From examples/barber
docker compose -f compose.postgres.yaml stop backend frontend
```

The default host connection is `postgres://barber:barber_local@localhost:55441/barber`. The API listens on `4500` and serves [GraphQL / GraphiQL](http://localhost:4500/graphql), [health](http://localhost:4500/health), `/mcp`, and [image uploads](../README.md#uploads) at `/api/uploads`, which it stores under `uploads/`. Compose maps host `4500` to container `4300`.

With the API running, open another terminal in `postgres/`:

```sh
npm run seed:admin
npm run seed:demo
```

The [demo accounts and booking flow](../README.md#try-the-demo) match the MongoDB example. Configure the [frontend](../frontend/README.md) with `NEXT_PUBLIC_GRAPHQL_URL=http://localhost:4500/graphql`.

## Environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL Pool connection string. |
| `DATABASE_SCHEMA` | Application schema; default `barber`. |
| `PORT` | Host HTTP port; default `4500`. |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | Access and refresh token signing secrets. |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | Admin account for `seed:admin`; local defaults are `admin@demo.com` / `demo1234`. The password applies only when `seed:admin` creates the account: an existing admin is reactivated and keeps its password. `seed:admin` exits with code 1 when the email belongs to an account with another role, such as a client or owner. |
| `GRAPHQL_ENDPOINT` | Target API for HTTP seed, dataset, and contract commands. |
| `GRAPHQL_RATE_LIMIT_MAX` | GraphQL requests per minute per client IP; default `300`. |
| `MCP_RATE_LIMIT_MAX` | `/mcp` requests per minute per client IP; default `300`. |
| `UPLOAD_IP_RATE_LIMIT_MAX` | Upload requests per minute per client IP, counted before authentication; default `100`. |
| `UPLOAD_RATE_LIMIT_MAX` | Uploads per minute per account, counted after authentication; default `20`. |
| `MCP_BEARER` | Access token (15 minutes) of the user for the stdio MCP process, from GraphQL `login` or `refreshSession`. |
| `MCP_REFRESH_TOKEN` | Refresh token (7 days) from the same login, so the stdio MCP process renews its access token. |
| `DATASET_PORT` | Port of the temporary API that `test:dataset` starts; default `4302`. |

See [`.env.example`](.env.example). Provide `GRAPHQL_ENDPOINT` in the shell when HTTP scripts should target another endpoint. Dataset commands also accept `ADMIN_EMAIL` and `ADMIN_PASSWORD`. Each rate limit has its own counter, and a value that is not a positive integer stops the server at startup; see [request limits](../README.md#request-limits).

## Commands and checks

Run these from `examples/barber/postgres` after `npm ci`:

| Command | Purpose |
| --- | --- |
| `npm start` / `npm run dev` | Start HTTP, or watch for backend source changes. |
| `npm test` | Run unit, scope, ownership, and controller regressions. |
| `npm run test:query-mutations` | Check filters, combined aggregates and nested mutations against a disposable HTTP API; see the [shared runbook](../README.md#validate-changes). |
| `npm run test:http` | Run `../tests/http-contract.mjs` against the running, seeded API, including account suspension, uploads, MCP and review rules. |
| `npm run test:postgres` | Exercise PostgreSQL storage, FKs, transactions, booking overlap rules and concurrent creates, correction of legacy booking totals, review eligibility and a concurrent-review race, review statistics, account suspension, `seed:admin`, `mcp:stdio`, scope read counts, GraphQL, and MCP in a temporary schema. |
| `npm run test:dataset` | Start a temporary API on `DATASET_PORT` and verify dataset loading, shop ratings in a private schema, and FK-ordered deletion. |
| `npm run test:frontend-queries` | Validate the shared dashboard selections and the booking page's taken-times query against the GraphQL schema. |
| `npm run seed:admin` | Create the admin account, or reactivate an existing admin; never promotes another account. |
| `npm run seed:demo` | Create the minimal demo through the running GraphQL API, or finish one an earlier run left incomplete. |
| `npm run dataset:load` / `npm run dataset:delete` | Load synthetic fixtures or delete the covered catalog/activity records; deletion retains users. |
| `npm run indexes` | Initialize and validate generated storage and application indexes. |
| `npm run schema:export` | Write the current SDL, generated SQL, and real FK catalog under `generated/`. |
| `npm run mcp:stdio` | Start MCP over standard input/output. |

Use a disposable database for integration checks. `test:postgres` and `test:dataset` create and remove their own schemas; the configured database user needs schema creation privileges. `test:http`, `test:query-mutations` and dataset commands modify the endpoint they are given. These checks are owned by the [dedicated Barber workflow](../../../.github/workflows/barber.yml), separate from library CI.

## Storage and native APIs

`database.js` owns the Pool and configures one immutable backend. `application.js` registers GraphQL types, builds the schema, and awaits storage initialization before serving requests. It also exports `mcpOptions`, the MCP options that HTTP `/mcp`, `mcp:stdio` and the integration tests share. HTTP, MCP, and scripts reuse that setup; shutdown closes the Pool. `auth/context.js` builds the request context: it verifies the JWT and reads the account's status and role on every authenticated request. `routes/` holds the image upload route, the per-route rate limits, and the JSON answers for errors that reach Express (`errors.js`).

The upgrade from 3.5.9 to 3.7.0 left the generated tables, foreign keys, GraphQL SDL, MCP tools and responses unchanged. The app keeps the library defaults: the opt-in `batchedCollections`, `refreshTriggers`, `ownerIndexes`, and MCP `nestedCollections` and `textFormat` stay off. Only the statements changed. Generated mutations skip reads whose result they do not use, such as a state action's second read of its record; root updates and deletes keep the reads they made on 3.5.9, because `protect()` gives every type `onUpdating` and `onDelete`. Sessionless reads of types without owned tables run as one statement without a transaction, and owned booking lines and bundle and professional services are inserted with multi-row `INSERT`s. `create` mode checks an unchanged schema without locking its tables, but the app's own `CREATE INDEX IF NOT EXISTS barbershop_state_city` still takes a `SHARE` lock on `barbershop`, so startup and the scripts that initialize storage wait for open writes to shops. See the 3.6.0 and 3.7.0 [upgrade notes](../../../docs/resources/compatibility.md).

IDs and JWT subjects are UUID strings represented as GraphQL `ID`. Single references become UUID columns with real foreign keys. Embedded `bundle.services`, `professional.services`, and `booking.lines` contain references and use private owned tables. Private ownership links cascade on deletion; entity references prevent deletion until dependent records are removed. Value-only embedded structures use JSONB.

Native model handles return plain records with `id` and `_id`. Use typed Simfinity filters and pass the active session to database work inside controllers:

```javascript
const UserModel = simfinity.getModel(simfinity.getType('user'));
const [user] = await UserModel.find(
  { email: { operator: 'EQ', value: email } },
  { session },
);
```

Native methods do not provide Mongoose chaining or MongoDB aggregation pipelines. They bypass the GraphQL application boundary, so keep native writes inside an authorized workflow. Scopes, controllers, relationships, and state machines express the same domain as the MongoDB example; adapter-specific operations remain separate.

The review controller recomputes a shop's `averageRating` and `reviewCount` with one `count`/`sum` query on `review.barbershop`. It runs the query through `session.query` in the review mutation's transaction, then writes the values with the native model and the same session, so both roll back with the review. Earlier versions read every review of the shop, 100 rows per query, on each review write. That write to the shop row also serializes concurrent reviews of one booking, so reviews need no row lock; see the [review rules](../README.md#review-rules).

Catalog scopes and the owner branch of the booking scope restrict through the `barbershop` relation: its `state`, or `owner.id` for owners. Each restriction compiles to a join in the same query, instead of loading shop IDs on every scope call.

The booking controller also derives line prices from the shop's catalog, keeps booking lines and bundle services within their shop, and refuses inactive services and bundles for clients; see the [booking rules](../README.md#booking-rules) and [bundle rules](../README.md#bundle-rules). The service controller stores the new `totalDurationMinutes` of the bundles that list a service when the service's duration changes, in the same transaction.

Before the foreign keys answer `REFERENCE_CONSTRAINT_VIOLATION`, `auth/ownership.js` refuses, with `RESOURCE_IN_USE` (409) as on MongoDB, a non-admin delete of a shop that bookings or reviews reference, or of a booking that a review references. It checks with an `EXISTS` query in the delete's transaction. A platform admin's delete is not checked, so the foreign key refuses it.

`types/booking.schedule.js` holds the [booking rules](../README.md#booking-rules) shared by the booking controller and the barbershop's virtual `busyRanges` field in `types/barbershop.busyRanges.js`. Both read bookings through the native model, outside the client booking scope; the field reads without a session, since a query runs outside a transaction. The field is virtual, so the barbershop table has no column for it, and a database created before it existed starts unchanged. Before its overlap query, the controller runs `UPDATE … SET id = id` on the professional row, or on the shop row and all its professionals for a booking without one, through the active session. A concurrent REPEATABLE READ transaction for that schedule waits and then fails with a serialization error; Simfinity retries it, up to five times and each after a short random backoff, with a fresh snapshot that sees the committed booking. The controller reports that error as `BOOKING_SCHEDULE_BUSY` and keeps its SQLSTATE, so Simfinity still retries it and returns `BOOKING_SCHEDULE_BUSY`, as the MongoDB API does, if every retry fails. Each retry round lets about one waiting booking through, so a large burst of simultaneous bookings for one professional can exhaust the retries.

## Inspect generated schema artifacts

With PostgreSQL configured, run:

```sh
npm run schema:export
```

The ignored `generated/` directory contains:

- `postgres.graphql`: the current application's GraphQL SDL.
- `postgres.sql`: generated PostgreSQL DDL and the app's additional index.
- `foreign-keys.json`: constraints read from the running PostgreSQL catalog.

The export initializes or validates the configured app schema before reading its catalog. These files describe that local database and current registrations; they are not committed snapshots or release archives. See the library's [PostgreSQL storage reference](../../../docs/postgresql.md) for the wider adapter contract.

## MCP

The HTTP endpoint is `http://localhost:4500/mcp`. Configure Streamable HTTP in an MCP client and send `Authorization: Bearer <accessToken>` for signed-in operations. It uses the same JWT context, authorization plugin, and query scopes as GraphQL. The tools do not include `login`, `register`, `registerOwner` or `refreshSession`: get the access token from the GraphQL `login` mutation, for example in [GraphiQL](http://localhost:4500/graphql). It lasts 15 minutes; renew it with GraphQL `refreshSession`. An expired or invalid token, or a token of a suspended or deleted account, fails the tool call with a JSON-RPC error that names the cause, as over stdio; an expired token's error says to renew it with `refreshSession`. Only a request without a bearer token runs as anonymous. See the [shared MCP notes](../README.md#mcp) for the messages and codes.

The endpoint serves POST; other methods, such as the GET a client sends to open an event stream, receive `405 Method Not Allowed`, which tells the client that the server sends no separate stream. A JSON-RPC batch gets HTTP 400 with the error code `-32600`, a body that is not JSON gets HTTP 400 with `-32700`, one over 100 kB gets HTTP 413, and `/mcp` has its own rate limit, `MCP_RATE_LIMIT_MAX`.

For a separate stdio process against the same database, use matching JWT secrets and a raw access token:

```sh
MCP_BEARER='<accessToken>' npm run --silent mcp:stdio
```

The token has no `Bearer ` prefix. For sessions longer than its 15 minutes, also set `MCP_REFRESH_TOKEN='<refreshToken>'` from the same login. The process then renews the access token when it expires and keeps the new token pair in memory. The 7-day refresh token is a local-development convenience stored in the MCP client's configuration. With neither variable, the process is anonymous.

Every tool call checks the current token and its account. At startup, the process prints `mcp:stdio: <reason>` to stderr and exits with code 1 when:

- `MCP_BEARER` is expired or invalid and cannot be renewed;
- `MCP_REFRESH_TOKEN` is invalid, expired or not a refresh token;
- the two tokens belong to different accounts;
- the account is suspended or deleted.

During a session, an expired token without a refresh token, a failed renewal, or a suspended or deleted account fails the tool call with a JSON-RPC error that names the cause; the call never runs as anonymous. The stdio tools are the same as on HTTP `/mcp`. Diagnostics go to stderr, leaving stdout for MCP.

Stop or reset this stack with the [project-specific Compose commands](../README.md#stop-or-reset-one-stack).
