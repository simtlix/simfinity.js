# Barber PostgreSQL backend

An independent, private application using the released `@simtlix/simfinity-postgres`, `@simtlix/simfinity-core`, and `@simtlix/simfinity-mcp` packages at exactly **3.3.0**. It uses Express, GraphQL Yoga, and `pg`, with no MongoDB or Mongoose runtime dependency. PostgreSQL delegates relational planning and runtime orchestration to `@simtlix/simfinity-sql`. This app retains the compatible PostgreSQL facade; the [SQL plugin guide](https://simtlix.github.io/simfinity.js/guide/sql-plugins.html) shows explicit plugin composition. It is outside the library workspaces and installs from npm without vendor archives.

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

The default host connection is `postgres://barber:barber_local@localhost:55441/barber`. The API listens on `4500` and serves [GraphQL / GraphiQL](http://localhost:4500/graphql), [health](http://localhost:4500/health), `/mcp`, and the app's upload routes. Compose maps host `4500` to container `4300`.

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
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | Admin seed account; local defaults are `admin@demo.com` / `demo1234`. |
| `GRAPHQL_ENDPOINT` | Target API for HTTP seed, dataset, and contract commands. |
| `GRAPHQL_RATE_LIMIT_MAX` | GraphQL requests per minute per IP. |
| `MCP_BEARER` | Raw access token for the stdio MCP process. |

See [`.env.example`](.env.example). Provide `GRAPHQL_ENDPOINT` in the shell when HTTP scripts should target another endpoint. Dataset commands also accept `ADMIN_EMAIL` and `ADMIN_PASSWORD`.

## Commands and checks

Run these from `examples/barber/postgres` after `npm ci`:

| Command | Purpose |
| --- | --- |
| `npm start` / `npm run dev` | Start HTTP, or watch for backend source changes. |
| `npm test` | Run unit, scope, ownership, and controller regressions. |
| `npm run test:query-mutations` | Check filters, combined aggregates and nested mutations against a disposable HTTP API; see the [shared runbook](../README.md#validate-changes). |
| `npm run test:http` | Run `../tests/http-contract.mjs` against the running, seeded API. |
| `npm run test:postgres` | Exercise PostgreSQL storage, FKs, transactions, GraphQL, and MCP in a temporary schema. |
| `npm run test:dataset` | Start a temporary API and verify dataset loading and FK-ordered deletion. |
| `npm run test:frontend-queries` | Validate the shared dashboard selections against the GraphQL schema. |
| `npm run seed:admin` | Create or update the local admin account. |
| `npm run seed:demo` | Create the minimal demo through the running GraphQL API. |
| `npm run dataset:load` / `npm run dataset:delete` | Load synthetic fixtures or delete the covered catalog/activity records; deletion retains users. |
| `npm run indexes` | Initialize and validate generated storage and application indexes. |
| `npm run schema:export` | Write the current SDL, generated SQL, and real FK catalog under `generated/`. |
| `npm run mcp:stdio` | Start MCP over standard input/output. |

Use a disposable database for integration checks. `test:postgres` and `test:dataset` create and remove their own schemas; the configured database user needs schema creation privileges. `test:http`, `test:query-mutations` and dataset commands modify the endpoint they are given. These checks are owned by the [dedicated Barber workflow](../../../.github/workflows/barber.yml), separate from library CI.

## Storage and native APIs

`database.js` owns the Pool and configures one immutable backend. `application.js` registers GraphQL types, builds the schema, and awaits storage initialization before serving requests. HTTP, MCP, and scripts reuse that setup; shutdown closes the Pool.

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

The HTTP endpoint is `http://localhost:4500/mcp`. Configure Streamable HTTP in an MCP client and send `Authorization: Bearer <accessToken>` for signed-in operations. It uses the same JWT context, authorization plugin, and query scopes as GraphQL.

For a separate stdio process against the same database, use matching JWT secrets and a raw access token:

```sh
MCP_BEARER='<accessToken>' npm run --silent mcp:stdio
```

The token has no `Bearer ` prefix. Its user context applies to the process lifetime; without a token the process uses anonymous context. Diagnostics go to stderr, leaving stdout for MCP.

Stop or reset this stack with the [project-specific Compose commands](../README.md#stop-or-reset-one-stack).
