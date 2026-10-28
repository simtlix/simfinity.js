import { describe, expect, it } from 'vitest';
import { describeModels } from '../packages/core/src/metadata.js';
import { createQueryPlan } from '../packages/core/src/query-plan.js';
import { describeDatabase } from '../packages/postgres/src/schema/describe.js';
import { compileChildrenQuery, compileQuery } from '../packages/postgres/src/query/compiler.js';
import { elementFixture, elementGroup } from './helpers/element-frames.js';

for (const owned of [false, true]) describe(`PostgreSQL element compiler (${owned ? 'owned' : 'JSONB'})`, () => {
  const fixture = elementFixture(`ElementUnit${owned}`, owned);
  const models = describeModels(fixture.registrations);
  const database = describeDatabase(fixture.registrations, { schema: 'app' });
  const planned = (args) => createQueryPlan(models, fixture.Order.name, args);
  it('correlates a quantified list to its owner without an outer multiplying join', () => {
    const compiled = compileQuery(models, database, planned(elementGroup()));
    expect(compiled.text).toContain('EXISTS');
    expect(compiled.text).toContain(owned ? '__owner_id' : 'jsonb_array_elements');
    expect(compiled.text).toContain('t0."limit"');
    expect(compiled.text).not.toContain('Unnormalized');
  });
  it('validates hand-built container operands against actual containment', () => {
    const plan = planned(elementGroup());
    const mutate = (node) => { if (node.operand) node.operand.container = { up: 8, path: [] }; node.terms?.forEach(mutate); if (node.where) mutate(node.where); };
    mutate(plan.where);
    expect(() => compileQuery(models, database, plan)).toThrow(expect.objectContaining({ extensions: expect.objectContaining({ code: 'INVALID_FILTER_PATH' }) }));
  });
  it('keeps batched children setup and a separate element witness in each branch', () => {
    const result = compileChildrenQuery(models, database, planned(elementGroup()), { column: 'batchKey', ids: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'] });
    expect(result.text).toContain(' UNION ALL ');
    expect(result.setup).toEqual([{ text: 'SET LOCAL jit = off', values: [] }]);
  });
});
