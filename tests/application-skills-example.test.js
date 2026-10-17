import { describe, expect, test } from 'vitest';
import { graphql, parse, validate, validateSchema } from 'graphql';
import { createRuntime } from '../packages/core/src/index.js';
import { createMongoAdapter } from '../packages/mongodb/src/mongo/adapter.js';
import { createPostgres } from '../packages/postgres/src/index.js';
import { createOrderExample, operations } from '../.agents/skills/simfinity-application-design/assets/order-example.js';

describe.each(['mongo', 'postgres'])('application skill example schema (%s)', (backend) => {
  const api = backend === 'mongo' ? createRuntime(createMongoAdapter()) : createPostgres({ pool: { query() {}, connect() {} } });
  if (backend === 'mongo') api.preventCreatingCollection(true);
  const { schema } = createOrderExample(api, { get() {}, lines() {}, setTotal() {} });

  test('validates the actual example documents on both generated schemas', () => {
    expect(validateSchema(schema)).toEqual([]);
    for (const source of Object.values(operations)) expect(validate(schema, parse(source))).toEqual([]);
  });

  test('owns state and totals and keeps children off root mutations', () => {
    const input = schema.getType('SkillOrderInput').getFields();
    for (const field of ['id', 'state', 'tenantId', 'total']) expect(input[field]).toBeUndefined();
    const mutations = schema.getMutationType().getFields();
    expect(mutations.approve_order).toBeDefined();
    expect(mutations.addline).toBeUndefined();
    expect(mutations.updateline).toBeUndefined();
    expect(mutations.deleteline).toBeUndefined();
  });

  test('denies a caller without authentication before touching storage', async () => {
    const result = await graphql({ schema, source: operations.list, variableValues: { page: 1 }, contextValue: {} });
    expect(result.errors?.[0].extensions.code).toBe('UNAUTHENTICATED');
  });
});
