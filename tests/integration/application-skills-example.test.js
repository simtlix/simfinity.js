import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { graphql } from 'graphql';
import mongoose from 'mongoose';
import pg from 'pg';
import { createRuntime } from '../../packages/core/src/index.js';
import { createMongoAdapter } from '../../packages/mongodb/src/mongo/adapter.js';
import { createPostgres } from '../../packages/postgres/src/index.js';
import { createOrderExample, operations } from '../../.agents/skills/simfinity-application-design/assets/order-example.js';
import { mongoOrderStorage } from '../../.agents/skills/simfinity-application-design/assets/mongo-order-storage.js';
import { postgresOrderStorage } from '../../.agents/skills/simfinity-application-design/assets/postgres-order-storage.js';

for (const backend of ['mongo', 'postgres']) {
  const uri = process.env[backend === 'mongo' ? 'SIMFINITY_MONGODB_URI' : 'SIMFINITY_POSTGRES_URI'];
  describe.skipIf(!uri)(`application skills example (${backend})`, () => {
    const namespace = `skills_${randomUUID().replaceAll('-', '')}`;
    const editor = (tenantId) => ({ user: { id: 'editor', tenantId, permissions: ['orders:read', 'orders:write'] } });
    const approver = { user: { ...editor('A').user, permissions: ['orders:read', 'orders:write', 'orders:approve'] } };
    let api; let pool; let schema; let types; let customerA; let customerB;
    const run = (source, variables = {}, context = editor('A')) => graphql({ schema, source, variableValues: variables, contextValue: { ...context } });
    const ok = async (pending) => {
      const result = await pending;
      expect(result.errors).toBeUndefined();
      return result.data;
    };
    const add = (label, customer = customerA, context = editor('A'), lines = [{ sku: 'PROMO', quantity: 2, unitPrice: 100 }]) =>
      run(operations.create, { input: { label, customer: { id: customer }, lines: { added: lines } } }, context);
    const get = async (id, context = editor('A')) => (await ok(run(operations.read, { id }, context))).order;

    beforeAll(async () => {
      if (backend === 'mongo') {
        await mongoose.connect(uri, { dbName: namespace });
        api = createRuntime(createMongoAdapter());
        api.preventCreatingCollection(true);
      } else {
        pool = new pg.Pool({ connectionString: uri });
        api = createPostgres({ pool, schema: namespace });
      }
      ({ schema, types } = createOrderExample(api, backend === 'mongo' ? mongoOrderStorage(api) : postgresOrderStorage(api, namespace)));
      if (backend === 'mongo') {
        for (const type of Object.values(types)) await api.getModel(type).init();
      } else await api.initializeDatabase();
    }, 30000);

    beforeEach(async () => {
      if (backend === 'mongo') {
        for (const type of Object.values(types)) await api.getModel(type).deleteMany({});
      } else await pool.query(`TRUNCATE "${namespace}"."SkillLine", "${namespace}"."SkillOrder", "${namespace}"."SkillCustomer" CASCADE`);
      customerA = (await ok(run(operations.customer, { name: 'A' }))).addcustomer.id;
      customerB = (await ok(run(operations.customer, { name: 'B' }, editor('B')))).addcustomer.id;
    });

    afterAll(async () => {
      if (backend === 'mongo' && mongoose.connection.readyState) {
        await mongoose.connection.dropDatabase();
        await mongoose.disconnect();
        mongoose.deleteModel(/^Skill/);
      } else if (pool) {
        await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
        await pool.end();
      }
    });

    test('uses stored line prices for the returned and persisted total', async () => {
      const order = (await ok(add('Total'))).addorder;
      expect(order.total).toBe(150);
      expect(order.lines[0].unitPrice).toBe(75);
      expect((await get(order.id)).total).toBe(150);
      const changed = (await ok(run(operations.update, { input: { id: order.id, lines: { updated: [{ id: order.lines[0].id, quantity: 3 }] } } }))).updateorder;
      expect(changed.total).toBe(225);
      expect((await get(order.id)).total).toBe(225);
    });

    test('restricts OR filters, pages, counts, by-ID and aggregates before returning data', async () => {
      const hidden = (await ok(add('000 Hidden', customerB, editor('B')))).addorder;
      await ok(add('001 Visible'));
      await ok(add('002 Visible'));
      await ok(add('003 Visible'));
      const context = { ...editor('A') };
      const page = await graphql({ schema, source: operations.list, variableValues: { page: 1 }, contextValue: context });
      expect(page.errors).toBeUndefined();
      expect(page.data.orders.map((row) => row.label)).toEqual(['001 Visible', '002 Visible']);
      expect(context.count).toBe(3);
      expect(await get(hidden.id)).toBeNull();
      const report = (await ok(run(operations.report))).orders_aggregate;
      expect(report).toEqual([{ groupId: 'A', facts: { total: 450 } }]);
    });

    test('rejects another tenant on writes and on customer references', async () => {
      const order = (await ok(add('Protected'))).addorder;
      expect((await run(operations.update, { input: { id: order.id, label: 'Stolen' } }, editor('B'))).errors?.[0].extensions.code).toBe('FORBIDDEN');
      expect((await add('Wrong customer', customerB)).errors?.[0].extensions.code).toBe('FORBIDDEN');
      expect((await get(order.id)).label).toBe('Protected');
    });

    test('rolls back the parent and earlier children when a nested child is invalid or foreign', async () => {
      const first = (await ok(add('Rollback'))).addorder;
      const second = (await ok(add('Other parent'))).addorder;
      const failed = await run(operations.update, { input: { id: first.id, label: 'Must rollback', lines: {
        added: [{ sku: 'X', quantity: 1, unitPrice: 10 }],
        updated: [{ id: second.lines[0].id, quantity: 5 }],
      } } });
      expect(failed.errors?.[0].extensions.code).toBe('FORBIDDEN');
      expect(await get(first.id)).toMatchObject({ label: 'Rollback', total: 150, lines: [{ quantity: 2 }] });
      expect((await get(first.id)).lines).toHaveLength(1);
      const invalid = await run(operations.update, { input: { id: first.id, label: 'Invalid', lines: { updated: [{ id: first.lines[0].id, quantity: -1 }] } } });
      expect(invalid.errors).toHaveLength(1);
      expect((await get(first.id)).label).toBe('Rollback');
    });

    test('requires action permission and prevents edits after approval', async () => {
      const order = (await ok(add('Approve'))).addorder;
      expect((await run(operations.approve, { id: order.id })).errors?.[0].extensions.code).toBe('FORBIDDEN');
      expect((await get(order.id)).state).toBe('DRAFT');
      expect((await ok(run(operations.approve, { id: order.id }, approver))).approve_order.state).toBe('APPROVED');
      expect((await run(operations.approve, { id: order.id }, approver)).errors?.[0].extensions.code).toBe('BAD_REQUEST');
      expect((await run(operations.update, { input: { id: order.id, label: 'Changed' } })).errors?.[0].extensions.code).toBe('ORDER_CLOSED');
    });
  });
}
