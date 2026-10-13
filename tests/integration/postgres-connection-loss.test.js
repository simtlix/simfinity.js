import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GraphQLID, GraphQLObjectType, GraphQLString, graphql } from 'graphql';
import pg from 'pg';
import { createPostgres } from '../../packages/postgres/src/index.js';

const uri = process.env.SIMFINITY_POSTGRES_URI;
describe.skipIf(!uri)('PostgreSQL connection loss during a read', () => {
  const namespace = `connection_loss_${randomUUID().replaceAll('-', '')}`;
  const table = `"${namespace}"."LossItem"`;
  // The runtime gets a pool of one connection, so a dead connection returned to it answers the next read.
  let pool; let admin; let schema;
  const execute = (source) => graphql({ schema, source, contextValue: {} });
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: uri });
    pool = new pg.Pool({ connectionString: uri, max: 1 });
    // As pg asks of applications: a terminated connection reports an error event, whether it is checked
    // out or idle in the pool.
    pool.on('connect', (client) => client.on('error', () => {}));
    pool.on('error', () => {});
    const api = createPostgres({ pool, schema: namespace });
    // Without owned tables, so a sessionless read is answered by one statement.
    const Item = new GraphQLObjectType({ name: 'LossItem', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
    api.connect(null, Item, 'lossitem', 'lossitems');
    schema = api.createSchema();
    await api.initializeDatabase();
    await admin.query(`INSERT INTO ${table} (id, name) VALUES ($1, 'kept')`, [randomUUID()]);
  });
  afterAll(async () => {
    if (admin) await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await Promise.all([admin?.end(), pool?.end()]);
  });

  it('discards a connection terminated during a single-statement read, so the next read succeeds', async () => {
    const client = await pool.connect();
    const { rows: [{ pid }] } = await client.query('SELECT pg_backend_pid() AS pid');
    client.release();
    // A second connection holds an ACCESS EXCLUSIVE lock, so the read is in flight when its backend is
    // terminated.
    const locker = await admin.connect();
    let outcome;
    try {
      await locker.query('BEGIN');
      await locker.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
      // The next read starts as soon as the first one fails, before the closed socket is reported, so it
      // would get the terminated connection if that connection went back to the pool.
      outcome = execute('{lossitems{name}}').then(async (failed) => [failed, await execute('{lossitems{name}}')]);
      let waiting = false;
      for (let check = 0; check < 500 && !waiting; check++) {
        const { rowCount } = await admin.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = $2', [pid, 'Lock']);
        waiting = rowCount === 1;
      }
      expect(waiting).toBe(true);
      const { rows: [{ terminated }] } = await admin.query('SELECT pg_terminate_backend($1) AS terminated', [pid]);
      expect(terminated).toBe(true);
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
    }
    const [failed, next] = await outcome;
    expect(failed.errors).toHaveLength(1);
    expect(failed.errors[0]).toMatchObject({ message: 'Database operation failed', extensions: { code: 'DATABASE_ERROR', status: 500 } });
    expect(failed.errors[0].originalError.getCause()).toMatchObject({ code: '57P01' });
    expect(next).toEqual({ data: { lossitems: [{ name: 'kept' }] } });
    const { rows: [{ pid: replacement }] } = await pool.query('SELECT pg_backend_pid() AS pid');
    expect(replacement).not.toBe(pid);
  });
});
