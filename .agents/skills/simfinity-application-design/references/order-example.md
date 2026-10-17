# Executable order example

The three files under `assets/` are a small application example checked against Simfinity 3.7.0. Copy them together to an application directory with ES modules and compatible `graphql`, `@simtlix/simfinity-core` and the selected facade installed. Declare `mongoose` directly for the MongoDB setup, or `pg` directly for the PostgreSQL setup: these snippets import them, even if the selected facade also depends on them. They are not a new library API. Use the application's package manager and released versions; verify its lockfile before adapting them.

- [order-example.js](../assets/order-example.js): fresh types per runtime, all three tenant scopes, explicit permissions, customer ownership, nested lines and approval.
- [mongo-order-storage.js](../assets/mongo-order-storage.js): native reads and total update with a Mongoose session.
- [postgres-order-storage.js](../assets/postgres-order-storage.js): native reads and total update with a SQL session.

Choose one setup for the process. Supply connection details through the application's existing configuration, using disposable databases for experiments.

```javascript
// MongoDB: a transaction-capable deployment is required.
import mongoose from 'mongoose';
import { createRuntime, createMongoAdapter } from '@simtlix/simfinity-js';
import { createOrderExample } from './order-example.js';
import { mongoOrderStorage } from './mongo-order-storage.js';

await mongoose.connect(process.env.MONGODB_URI);
const api = createRuntime(createMongoAdapter());
const app = createOrderExample(api, mongoOrderStorage(api));
for (const type of Object.values(app.types)) await api.getModel(type).init();
```

```javascript
// PostgreSQL: initialize only in a database the application owns.
import pg from 'pg';
import { createPostgres } from '@simtlix/simfinity-postgres';
import { createOrderExample } from './order-example.js';
import { postgresOrderStorage } from './postgres-order-storage.js';

const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URI });
const namespace = 'skill_orders';
const api = createPostgres({ pool, schema: namespace });
const app = createOrderExample(api, postgresOrderStorage(api, namespace));
await api.initializeDatabase();
```

After either setup, execute the exported `operations` with graphql-js `graphql({ schema: app.schema, source, variableValues, contextValue })`. This convenience API parses and validates the document. Inspect `errors` even when data is returned. The example installs authorization once via `onSchemaChange`; if integrating with Yoga, choose one plugin installation path and use real authentication.

For a disposable test, the context shape is `{ user: { id: 'editor', tenantId: 'A', permissions: ['orders:read', 'orders:write'] } }`. It is a fixture, not an authentication mechanism. Run `operations.customer` with `{ name: 'Customer' }`, then `operations.create` with:

```javascript
{ input: {
  label: 'First order', customer: { id: customerId },
  lines: { added: [{ sku: 'PROMO', quantity: 2, unitPrice: 100 }] },
} }
```

The demo pricing rule sets PROMO's unit price to 75, so the returned and stored total is 150. Both create and update recompute from the lines stored in that session. Standalone line mutations are excluded. Approving requires both write and approve permissions; approved orders cannot be edited. Customer updates and all root deletes remain denied in this limited example. Edit lines before approval; an approval carrying child edits is rejected once its parent has transitioned.

For a smoke check in a consumer application, add these imports at the top of its setup file and run the rest after either setup above, against a disposable database:

```javascript
import assert from 'node:assert/strict';
import { graphql } from 'graphql';
import { operations } from './order-example.js';

const context = { user: { id: 'editor', tenantId: 'A', permissions: ['orders:read', 'orders:write'] } };
const run = async (source, variableValues) => {
  const result = await graphql({ schema: app.schema, source, variableValues, contextValue: context });
  assert.equal(result.errors, undefined);
  return result.data;
};
const customer = (await run(operations.customer, { name: 'Customer' })).addcustomer;
const order = (await run(operations.create, { input: {
  label: 'Smoke check', customer: { id: customer.id },
  lines: { added: [{ sku: 'PROMO', quantity: 2, unitPrice: 100 }] },
} })).addorder;
assert.equal(order.total, 150);
assert.equal((await run(operations.read, { id: order.id })).order.total, 150);
// Close the selected connection when the check ends: mongoose.disconnect() or pool.end().
```

The list operation deliberately supplies an OR over two tenants; the server scope must still restrict it. `context.count` holds the matching list count. The report sums stored totals. The example does not implement ownership within a tenant, audit/outbox, idempotency, currency conversion, per-user field permissions or configurable workflows; supply these when the application's requirements call for them. Native store methods are internal to these checked controllers, not public authorized CRUD.

The example's broad mutation selections make returned totals observable in tests. Worker command handlers should usually select only `id`, then read separately: output-field failure can occur after commit, and must not cause a blind mutation retry.

In the Simfinity checkout:

```sh
npx vitest run tests/application-skills-example.test.js
npx vitest run tests/integration/application-skills-example.test.js
```

The first verifies schema/input/executable-document contracts without databases. The second requires disposable `SIMFINITY_MONGODB_URI` and `SIMFINITY_POSTGRES_URI`; missing engines skip explicitly. Database CI executes both. It checks stored totals, scoped pagination/count/report/by-ID reads, cross-tenant writes/references, foreign-child rollback and state/action permissions. These destructive test fixtures create and drop their own randomly named database/schema.
