# Barber MongoDB backend

An independent, private application using `@simtlix/simfinity-js@3.2.0`, Mongoose, Express, and GraphQL Yoga. It installs released packages from npm and is outside the monorepo's library workspaces. Use the [Barber quick start](../README.md) to run the complete Docker stack with the shared frontend.

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

The host server listens on `4400` and serves [GraphQL / GraphiQL](http://localhost:4400/graphql), [health](http://localhost:4400/health), `/mcp`, and the app's upload routes. Compose maps host `4400` to container `4300`.

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
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | Admin seed account; local defaults are `admin@demo.com` / `demo1234`. |
| `GRAPHQL_ENDPOINT` | Target API for HTTP seed, dataset, and contract commands. |
| `GRAPHQL_RATE_LIMIT_MAX` | GraphQL requests per minute per IP. |
| `MCP_BEARER` | Raw access token for the stdio MCP process. |

See [`.env.example`](.env.example). Demo and dataset commands use their documented local defaults; when targeting another endpoint, provide `GRAPHQL_ENDPOINT` in the shell. The dataset commands accept `ADMIN_EMAIL` and `ADMIN_PASSWORD` for admin login.

## Commands

Run these from `examples/barber/mongodb` after `npm ci`:

| Command | Purpose |
| --- | --- |
| `npm start` / `npm run dev` | Start HTTP, or watch for backend source changes. |
| `npm test` | Run backend unit and regression tests. |
| `npm run test:http` | Run `../tests/http-contract.mjs` against the running, seeded API. |
| `npm run test:mongodb` | Check real transactions and derived booking, bundle, and review values in a temporary MongoDB database. |
| `npm run test:dataset` | Verify dataset load and deletion with a temporary API and MongoDB database. |
| `npm run seed:admin` | Create or update the local admin account directly in MongoDB. |
| `npm run seed:demo` | Create the minimal demo through the running GraphQL API. |
| `npm run dataset:load` | Load the larger synthetic dataset through GraphQL. |
| `npm run dataset:delete` | Delete the covered catalog/activity records through GraphQL; retain users. |
| `npm run indexes` | Ensure application indexes. |
| `npm run mcp:stdio` | Start MCP over standard input/output. |

Integration checks use the configured `MONGO` deployment and create and remove temporary databases. Use a disposable replica set; the configured user needs database creation and deletion privileges. `test:http` and dataset commands modify the endpoint they are given. The [dedicated Barber workflow](../../../.github/workflows/barber.yml) runs the backend, real-database, and shared frontend checks independently from library CI.

## Application layout

`database.js` owns Mongoose connection and shutdown. `application.js` registers entities and builds the GraphQL schema; the HTTP server, seeds, and MCP transport reuse that initialization. Native model operations use Mongoose APIs and sessions.

| Location | Responsibility |
| --- | --- |
| `types/{entity}.js` | GraphQL fields, relationships, and registration. |
| `types/{entity}.scopes.js` | Role-aware filtering for reads and aggregations. |
| `types/{entity}.controller.js` | Domain checks and derived booking, bundle, or review values. |
| `types/{entity}.stateMachine.js` | Shop approval and booking transitions. |
| `auth/` | JWT request context, permission gates, and ownership checks. |
| `dataset/`, `scripts/` | Synthetic fixtures and local operational commands. |

MongoDB ObjectIds are exposed as GraphQL `ID`. Shared frontend code treats them as opaque strings. The PostgreSQL example expresses the same domain with UUID identities and separate native database code; see [the comparison](../README.md#what-to-compare).

## MCP

The HTTP server exposes generated tools at `http://localhost:4400/mcp`. Configure an MCP client for Streamable HTTP and send `Authorization: Bearer <accessToken>` for signed-in operations. Tool execution uses the GraphQL authentication context, permissions, and scopes.

For stdio, run a separate process against the same database with matching JWT secrets:

```sh
MCP_BEARER='<accessToken>' npm run --silent mcp:stdio
```

`MCP_BEARER` contains the raw JWT without the `Bearer ` prefix. The process binds that user context for its lifetime; without a token it uses anonymous context. Diagnostics use stderr so stdout remains available for the MCP protocol.

Stop or reset the example using the [project-specific Compose commands](../README.md#stop-or-reset-one-stack).
