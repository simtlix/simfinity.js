import {
  afterEach, beforeAll, describe, expect, test, vi,
} from 'vitest';
import mongoose from 'mongoose';
import * as simfinity from '../src/index.js';
import { createRelationFixture } from './fixtures/relation-authorization.js';

describe('Generated relation authorization', () => {
  let fixture;
  let model;
  const parentId = '507f1f77bcf86cd799439011';
  const childId = '507f1f77bcf86cd799439012';

  beforeAll(() => {
    simfinity.preventCreatingCollection(true);
    fixture = createRelationFixture('RelationAuth');
    model = mongoose.model(fixture.child.name);
  });
  afterEach(() => vi.restoreAllMocks());

  test.each([
    ['child', 'get_by_id'],
    ['children', 'find'],
  ])('rejects %s through awaited target middleware with the request context', async (field, operation) => {
    vi.spyOn(model, 'findById').mockResolvedValue({ name: 'Private child' });
    vi.spyOn(model, 'aggregate').mockResolvedValue([{ name: 'Private child' }]);
    const context = { tenant: 'A', rejectOperation: operation, calls: [] };
    await expect(fixture.parent.getFields()[field].resolve({ _id: parentId, child_id: childId }, {}, context))
      .rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(context.calls).toHaveLength(1);
    expect(context.calls[0].operation).toBe(operation);
    expect(model.findById).not.toHaveBeenCalled();
    expect(model.aggregate).not.toHaveBeenCalled();
  });

  test.each(['child', 'children'])('awaits target scope rejection for %s', async (field) => {
    vi.spyOn(model, 'findById').mockResolvedValue({ name: 'Private child' });
    vi.spyOn(model, 'aggregate').mockResolvedValue([{ name: 'Private child' }]);
    await expect(fixture.parent.getFields()[field].resolve(
      { _id: parentId, child_id: childId }, {}, { tenant: 'A', rejectScope: true },
    )).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(model.findById).not.toHaveBeenCalled();
    expect(model.aggregate).not.toHaveBeenCalled();
  });

  test('preserves explicitly supplied relation resolvers', () => {
    expect(fixture.parent.getFields().customChild.resolve).toBe(fixture.customResolver);
  });
});
