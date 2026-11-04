# Barber MongoDB backend

An independent, private application using `@simtlix/simfinity-js@3.19.0`, Mongoose, Express, and GraphQL Yoga. It installs released packages from npm and is outside the monorepo's library workspaces. Use the [Barber quick start](../README.md) to run the complete Docker stack with the shared frontend.

## Host development

Use Node.js 24. From `examples/barber`, start only the database, then run the backend on the host:

```sh
docker compose -f compose.mongodb.yaml up -d --wait db
cd mongodb
cp .env.example .env
npm ci
npm run dev
```

If the full stack is already running, stop its backend and frontend before using the same host ports:

```sh
# From examples/barber
docker compose -f compose.mongodb.yaml stop backend frontend
```

The default host URI is `mongodb://127.0.0.1:57417/barber?replicaSet=rs0&directConnection=true`. The direct connection option lets a host process use the published port of this Docker replica-set member. `MONGO` can point to another transaction-capable MongoDB deployment.

The host server listens on `4400` and serves [GraphQL / GraphiQL](http://localhost:4400/graphql), [health](http://localhost:4400/health), `/mcp`, and [image uploads](../README.md#uploads) at `/api/uploads`, which it stores under `uploads/`. Compose maps host `4400` to container `4300`.

With the API running, open another terminal in `mongodb/`:

```sh
npm run seed:admin
npm run seed:demo
```

The [demo accounts and booking flow](../README.md#try-the-demo) are shared with the PostgreSQL example. Configure the [frontend](../frontend/README.md) with `NEXT_PUBLIC_GRAPHQL_URL=http://localhost:4400/graphql`.

## Environment

| Variable | Purpose |
| --- | --- |
| `MONGO` | MongoDB connection string, including replica-set options. |
| `PORT` | Host HTTP port; default `4400`. |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | Access and refresh token signing secrets. |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | Admin account for `seed:admin`; local defaults are `admin@demo.com` / `demo1234`. The password applies only when `seed:admin` creates the account: an existing admin is reactivated and keeps its password. `seed:admin` exits with code 1 when the email belongs to an account with another role, such as a client or owner. |
| `GRAPHQL_ENDPOINT` | Target API for HTTP seed, dataset, and contract commands. |
| `GRAPHQL_RATE_LIMIT_MAX` | GraphQL requests per minute per client IP; default `300`. |
| `MCP_RATE_LIMIT_MAX` | `/mcp` requests per minute per client IP; default `300`. |
| `UPLOAD_IP_RATE_LIMIT_MAX` | Upload requests per minute per client IP, counted before authentication; default `100`. |
| `UPLOAD_RATE_LIMIT_MAX` | Uploads per minute per account, counted after authentication; default `20`. |
| `MCP_BEARER` | Access token (15 minutes) of the user for the stdio MCP process, from GraphQL `login` or `refreshSession`. |
| `MCP_REFRESH_TOKEN` | Refresh token (7 days) from the same login, so the stdio MCP process renews its access token. |
| `DATASET_PORT` | Port of the temporary API that `test:dataset` starts; default `4402`. |

See [`.env.example`](.env.example). Demo and dataset commands use their documented local defaults; when targeting another endpoint, provide `GRAPHQL_ENDPOINT` in the shell. The dataset commands accept `ADMIN_EMAIL` and `ADMIN_PASSWORD` for admin login. Each rate limit has its own counter, and a value that is not a positive integer stops the server at startup; see [request limits](../README.md#request-limits).

## Commands

Run these from `examples/barber/mongodb` after `npm ci`:

| Command | Purpose |
| --- | --- |
| `npm start` / `npm run dev` | Start HTTP, or watch for backend source changes. |
| `npm run lint` | Check static Simfinity contracts with the published ESLint plugin. |
| `npm run test:security` | Audit the complete application lockfile, development tools included. |
| `npm test` | Run backend unit and regression tests. |
| `npm run test:query-mutations` | Check filters, combined aggregates and nested mutations against a disposable HTTP API; see the [shared runbook](../README.md#validate-changes). |
| `npm run test:http` | Run `../tests/http-contract.mjs` against the running, seeded API, including account suspension, uploads, MCP and review rules. |
| `npm run test:mongodb` | Check real transactions, booking overlap rules and concurrent creates, derived booking, bundle, and review values, correction of legacy booking totals, review eligibility and a concurrent-review race, account suspension, `seed:admin`, `mcp:stdio`, and scope read counts in a temporary MongoDB database. |
| `npm run test:dataset` | Verify dataset load, shop ratings and deletion with a temporary API (on `DATASET_PORT`) and MongoDB database. |
| `npm run seed:admin` | Create the admin account directly in MongoDB, or reactivate an existing admin; never promotes another account. |
| `npm run seed:demo` | Create the minimal demo through the running GraphQL API, or finish one an earlier run left incomplete. |
| `npm run dataset:load` | Load the larger synthetic dataset through GraphQL. |
| `npm run dataset:delete` | Delete the covered catalog/activity records through GraphQL; retain users. |
| `npm run indexes` | Ensure application indexes. |
| `npm run mcp:stdio` | Start MCP over standard input/output. |

Integration checks use the configured `MONGO` deployment and create and remove temporary databases. Use a disposable replica set; the configured user needs database creation and deletion privileges. `test:http`, `test:query-mutations` and dataset commands modify the endpoint they are given. The [dedicated Barber workflow](../../../.github/workflows/barber.yml) runs the backend, real-database, and shared frontend checks independently from library CI.

## Application layout

`database.js` owns Mongoose connection and shutdown. `application.js` registers entities and builds the GraphQL schema, and exports `mcpOptions`, the MCP options that HTTP `/mcp`, `mcp:stdio` and the tests share; the HTTP server, seeds, and MCP transport reuse that initialization. Native model operations use Mongoose APIs and sessions.

The upgrade from 3.5.9 to 3.7.0 needed no code change and left the GraphQL SDL, MCP tools, responses, stored data and errors unchanged. Generated mutations skip reads whose result they do not use, so state actions and nested updated or deleted children send fewer `find` commands; root updates and deletes keep the reads they made on 3.5.9, because `protect()` gives every type `onUpdating` and `onDelete`. The app uses the package-root runtime of `@simtlix/simfinity-js`, so reference integrity stays in its default mode and collection fields keep one read per parent: 3.7.0's opt-in batched collection reads need an adapter created with `createMongoAdapter({ batchedCollections: true })` and a runtime of the app's own. See the 3.6.0 and 3.7.0 [upgrade notes](../../../docs/resources/compatibility.md).

| Location | Responsibility |
| --- | --- |
| `types/{entity}.js` | GraphQL fields, relationships, and registration. |
| `types/{entity}.scopes.js` | Role-aware filtering for reads and aggregations, expressed as relation-path filters, so a scope loads no shop IDs; referenced records whose type has a `get_by_id` scope are still read one query per reference. |
| `types/{entity}.controller.js` | Domain checks, review eligibility, and derived booking, bundle, or review values. |
| `types/{entity}.stateMachine.js` | Shop approval and booking transitions. |
| `auth/` | JWT request context that reads the account's status and role, permission gates, ownership checks, and the single-auth-operation rule. |
| `routes/` | Image uploads, per-route rate limits, and the JSON answers for errors that reach Express (`errors.js`). |
| `dataset/`, `scripts/` | Synthetic fixtures and local operational commands. |

The booking controller also derives line prices from the shop's catalog, keeps booking lines and bundle services within their shop, and refuses inactive services and bundles for clients; see the [booking rules](../README.md#booking-rules) and [bundle rules](../README.md#bundle-rules). Bookings nested in `updatebarbershop` now work on MongoDB; they used to fail with a `CastError`. The service controller stores the new `totalDurationMinutes` of the bundles that list a service when the service's duration changes or the service is deleted.

MongoDB has no foreign keys, so `auth/ownership.js` refuses, with `RESOURCE_IN_USE` (409), a non-admin delete of a shop that bookings or reviews reference, or of a booking that a review references. A platform admin's delete still goes through and leaves those references pointing at nothing; see the [booking rules](../README.md#booking-rules).

Owner reads restrict through `barbershop.owner.id`, which joins the shop's `owner` to the user collection; the barbershop scope uses `owner.id` on the shop itself. MongoDB, unlike PostgreSQL's foreign key, allows deleting a user who still owns shops. After that, the owner path no longer matches those shops. That user's still-valid token is anonymous on GraphQL and rejected on `/mcp` anyway, so it sees only the `APPROVED` public catalog. This stricter visibility is intended; earlier versions matched the raw `owner` field.

Simfinity's MongoDB adapter adds one `$lookup` per relation hop before the `$match`, in 3.7.0 as in 3.5.9. On owner reads, `barbershop.owner.id` therefore adds a `$lookup` into the user collection for every candidate booking or catalog document, and owner barbershop reads add one too. Measured with Simfinity 3.5.9 at about 5,000 bookings, as medians from earlier versions to this one:

- unfiltered owner booking list: 105 → 146 ms;
- `bookings_aggregate` without filters: 103 → 144 ms;
- the owner's “My bookings” page, filtered by client: 62 → 58 ms, because per-reference scopes no longer load shop IDs;
- dashboard reads filtered by shop and date: 17.4 → 16.3 ms.

PostgreSQL compiles the same terms to joins and is faster on all owner reads.

`types/booking.schedule.js` holds the [booking rules](../README.md#booking-rules) shared by the booking controller and the barbershop's virtual `busyRanges` field in `types/barbershop.busyRanges.js`. Both read bookings with native Mongoose queries, outside the client booking scope; the field reads without a session, since a query runs outside a transaction. The field is virtual, so the generated barbershop model has no path for it. Before its overlap query, the controller increments a hidden `_bookingScheduleLock` counter on the professional document, or on the shop and all its professionals for a booking without one, in the same transaction. A concurrent booking for that schedule then hits a write conflict; Simfinity retries it with a fresh snapshot that sees the committed booking. Simfinity retries up to five times, each after a short random backoff, and the controller first waits another 20–100 ms at random to spread concurrent retries further apart. If every retry conflicts, the API returns `BOOKING_SCHEDULE_BUSY`.

The review controller recomputes the shop's `averageRating` and `reviewCount` with one aggregate in the review mutation's transaction and writes them with the same session. That write to the shop document also serializes concurrent reviews of one booking, so reviews need no lock field; see the [review rules](../README.md#review-rules).

MongoDB ObjectIds are exposed as GraphQL `ID`. Shared frontend code treats them as opaque strings. The PostgreSQL example expresses the same domain with UUID identities and separate native database code; see [the comparison](../README.md#what-to-compare).

## MCP

The HTTP server exposes generated tools at `http://localhost:4400/mcp`. Configure an MCP client for Streamable HTTP and send `Authorization: Bearer <accessToken>` for signed-in operations. Tool execution uses the GraphQL authentication context, permissions, and scopes. The tools do not include `login`, `register`, `registerOwner` or `refreshSession`: get the access token from the GraphQL `login` mutation, for example in [GraphiQL](http://localhost:4400/graphql). It lasts 15 minutes; renew it with GraphQL `refreshSession`. An expired or invalid token, or a token of a suspended or deleted account, fails the tool call with a JSON-RPC error that names the cause, as over stdio; an expired token's error says to renew it with `refreshSession`. Only a request without a bearer token runs as anonymous. See the [shared MCP notes](../README.md#mcp) for the messages and codes.

The endpoint serves `POST` only; other methods, such as a client's `GET` for an event stream, receive `405` with `Allow: POST`. A JSON-RPC batch gets HTTP 400 with the error code `-32600`, a body that is not JSON gets HTTP 400 with `-32700`, one over 100 kB gets HTTP 413, and `/mcp` has its own rate limit, `MCP_RATE_LIMIT_MAX`.

For stdio, run a separate process against the same database with matching JWT secrets:

```sh
MCP_BEARER='<accessToken>' npm run --silent mcp:stdio
```

`MCP_BEARER` contains the raw access token without the `Bearer ` prefix. For sessions longer than its 15 minutes, also set `MCP_REFRESH_TOKEN='<refreshToken>'` from the same login. The process then renews the access token when it expires and keeps the new token pair in memory. The 7-day refresh token is a local-development convenience stored in the MCP client's configuration. With neither variable, the process is anonymous.

Every tool call checks the current token and its account. At startup, the process prints `mcp:stdio: <reason>` to stderr and exits with code 1 when:

- `MCP_BEARER` is expired or invalid and cannot be renewed;
- `MCP_REFRESH_TOKEN` is invalid, expired or not a refresh token;
- the two tokens belong to different accounts;
- the account is suspended or deleted.

During a session, an expired token without a refresh token, a failed renewal, or a suspended or deleted account fails the tool call with a JSON-RPC error that names the cause; the call never runs as anonymous. The stdio tools are the same as on HTTP `/mcp`. Diagnostics use stderr so stdout remains available for the MCP protocol.

Stop or reset the example using the [project-specific Compose commands](../README.md#stop-or-reset-one-stack).

## Current lifecycle examples

New shops enter review in one create, while existing `DRAFT` shops retain their submission action. Bookings use observed versions to prevent stale edits; see the [upgrade instructions](../README.md#upgrading-an-existing-booking-database), especially the explicit PostgreSQL migration for existing databases. Optional [reminder logs](../README.md#reminder-demonstration) run only after the owning transaction commits and demonstrate best-effort delivery.
