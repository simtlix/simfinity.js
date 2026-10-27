import { describe, expect, it } from 'vitest';
import { collectQueryOperators, collectQueryPathEntries, createQueryPlan } from '../packages/core/src/query-plan.js';
import { frameCollectionPaths, frameUnits, validateQuantifiedGroups } from '../packages/core/src/query-frames.js';

const scalar = (name, type = 'Int', extra = {}) => ({ name, kind: 'scalar', scalar: type, ...extra });
const models = { entities: [
  { name: 'Product', fields: [scalar('id', 'ID'), scalar('stock'), scalar('maximum'), scalar('label', 'String'), scalar('tags', 'String', { list: true }),
    { name: 'shop', kind: 'reference', target: 'Shop' }, { name: 'reviews', kind: 'collection', target: 'Review', connectionField: 'product' },
    { name: 'otherReviews', kind: 'collection', target: 'Review', connectionField: 'product' },
    { name: 'details', kind: 'embedded', fields: [scalar('amount'), scalar('ceiling'), scalar('tags', 'String', { list: true })] },
    { name: 'items', kind: 'embedded', list: true, fields: [scalar('amount'), scalar('ceiling')] }] },
  { name: 'Review', fields: [scalar('id', 'ID'), scalar('rating'), scalar('maximum'), { name: 'author', kind: 'reference', target: 'Shop' },
    { name: 'votes', kind: 'collection', target: 'Vote', connectionField: 'review' }] },
  { name: 'Vote', fields: [scalar('score'), scalar('maximum')] },
  { name: 'Shop', fields: [scalar('minStock'), scalar('maximum'), scalar('label', 'String'), { name: 'products', kind: 'collection', target: 'Product', connectionField: 'shop' }] },
] };
const context = { models, entity: 'Product', quantifiers: true, referenceEmptiness: true, valuePath: true };
const plan = (args, options) => createQueryPlan(models, 'Product', args, options).where;
const fault = (args, code, options) => expect(() => plan(args, options)).toThrowError(expect.objectContaining({ extensions: expect.objectContaining({ code }) }));
const condition = (field, valuePath, extra = {}) => ({ AND: [{ conditions: [{ field, valuePath, ...extra }] }] });
const pred = (path, right, up = 0, operator = 'EQ') => ({ kind: 'predicate', path: path.split('.'), operator, value: null, operand: { up, path: right.split('.') } });

describe('field comparison walkers and plans', () => {
  it('walks both operands with the same owning carrier and lexical origins', () => {
    const filter = { operator: 'LT', valuePath: 'maximum' };
    const term = { path: 'minStock', valuePath: 'maximum' };
    const args = { stock: filter, shop: { terms: [term] } };
    const entries = collectQueryPathEntries(args);
    expect(entries.map(({ segments, relative, role, construct }) => ({ segments, relative, role, construct }))).toEqual([
      { segments: ['stock'], relative: ['stock'], role: 'left', construct: filter },
      { segments: ['maximum'], relative: ['maximum'], role: 'right', construct: filter },
      { segments: ['shop', 'minStock'], relative: ['shop', 'minStock'], role: 'left', construct: term },
      { segments: ['shop', 'maximum'], relative: ['shop', 'maximum'], role: 'right', construct: term },
    ]);
    expect(collectQueryOperators(args).map(({ valuePath, hasValuePath, construct }) => ({ valuePath, hasValuePath, construct })))
      .toEqual([{ valuePath: 'maximum', hasValuePath: true, construct: filter }, { valuePath: 'shop.maximum', hasValuePath: true, construct: term }]);
  });

  it('plans scalar filters, relation terms, embedded members and explicit element frames', () => {
    expect(plan({ stock: { operator: 'LT', valuePath: 'maximum' } })).toEqual(pred('stock', 'maximum', 0, 'LT'));
    expect(plan({ shop: { terms: [{ path: 'minStock', valuePath: 'maximum' }] } })).toEqual(pred('shop.minStock', 'shop.maximum'));
    expect(plan(condition('details.amount', 'details.ceiling'))).toEqual(pred('details.amount', 'details.ceiling'));
    expect(plan({ AND: [{ ANY: [{ path: 'reviews', conditions: [{ field: 'rating', valuePath: 'maximum' }] }] }] }))
      .toEqual({ kind: 'quantified', quantifier: 'ANY', path: ['reviews'], scope: null, where: pred('rating', 'maximum') });
  });

  it('keeps same-child shorthand and compiler-generated outer bindings through nested frames', () => {
    expect(plan(condition('reviews.rating', 'reviews.maximum'))).toEqual({ kind: 'quantified', quantifier: 'ANY', path: ['reviews'], scope: null, where: pred('rating', 'maximum') });
    expect(plan(condition('reviews.rating', 'stock'))).toEqual({ kind: 'quantified', quantifier: 'ANY', path: ['reviews'], scope: null, where: pred('rating', 'stock', 1) });
    expect(plan(condition('reviews.votes.score', 'reviews.maximum'))).toEqual({ kind: 'quantified', quantifier: 'ANY', path: ['reviews'], scope: null,
      where: { kind: 'quantified', quantifier: 'ANY', path: ['votes'], scope: null, where: pred('score', 'maximum', 1) } });
    expect(plan(condition('reviews.votes.score', 'stock')).where.where).toEqual(pred('score', 'stock', 2));
  });

  it('rejects right operands introducing unrelated or deeper collection witnesses', () => {
    fault(condition('reviews.rating', 'otherReviews.rating'), 'INVALID_FILTER_PATH');
    fault(condition('stock', 'reviews.rating'), 'INVALID_FILTER_PATH');
    fault(condition('reviews.rating', 'reviews.votes.score'), 'INVALID_FILTER_PATH');
  });

  it('validates comparison presence, endpoint, embedded-list staging and capability defaults', () => {
    fault(condition('stock', 'maximum', { value: null }), 'INVALID_FILTER_VALUE');
    fault(condition('stock', ''), 'INVALID_FILTER_PATH');
    fault(condition('stock', '$parent.maximum'), 'INVALID_FILTER_PATH');
    fault(condition('stock', 'label'), 'INVALID_FILTER_VALUE');
    fault(condition('stock', 'missing'), 'INVALID_FILTER_FIELD');
    fault(condition('stock', 'tags'), 'INVALID_FILTER_PATH');
    fault(condition('items.amount', 'items.ceiling'), 'UNSUPPORTED_QUERY');
    fault(condition('stock', 'maximum'), 'UNSUPPORTED_QUERY', { operators: ['EQ'] });
    fault(condition('stock', 'maximum'), 'UNSUPPORTED_QUERY', { operators: ['EQ'], valuePath: true });
    expect(plan(condition('stock', 'maximum'), { operators: ['EQ'], valuePath: true, referenceEmptiness: true })).toEqual(pred('stock', 'maximum'));
    fault(condition('reviews.rating', 'stock'), 'UNSUPPORTED_QUERY', { operators: ['EQ'], valuePath: true });
  });

  it('unions same-frame scoped references, retains outer scopes and counts each actual frame once', () => {
    const args = condition('shop.minStock', 'shop.maximum', { __scope: { id: 1, scopes: { shop: null } } });
    expect(plan(args)).toEqual({ ...pred('shop.minStock', 'shop.maximum'), joins: { shop: null } });
    const outer = condition('reviews.author.minStock', 'shop.maximum', { __scope: { id: 2, scopes: { reviews: null, 'reviews.author': null, shop: null } } });
    expect(plan(outer)).toEqual({ kind: 'quantified', quantifier: 'ANY', path: ['reviews'], scope: null,
      where: { ...pred('author.minStock', 'shop.maximum', 1), joins: { author: null }, operand: { up: 1, path: ['shop', 'maximum'], joins: { shop: null } } } });
    expect(frameUnits(outer, context).count).toBe(3);
    fault(condition('stock', 'shop.maximum', { __scope: { id: 1, scopes: {} } }), 'DETACHED_CLIENT_FILTER');
  });

  it('keeps literal predicate shapes stable and rejects malformed internal bindings', () => {
    expect(plan({ stock: { value: 5 } })).toEqual({ kind: 'predicate', path: ['stock'], operator: 'EQ', value: 5 });
    expect(() => validateQuantifiedGroups(condition('stock', 'maximum', { __operand: { up: -1, path: ['stock'] } }), context)).toThrow();
    const normalized = frameCollectionPaths(condition('reviews.rating', 'stock'), context);
    expect(normalized.AND[0].ANY[0].conditions[0]).toMatchObject({ field: 'rating', __operand: { up: 1, path: ['stock'] } });
  });

  it('preserves outer scope ownership across two generated collection frames', () => {
    const args = condition('reviews.votes.score', 'shop.maximum', { __scope: { id: 3, scopes: { reviews: null, 'reviews.votes': null, shop: null } } });
    expect(plan(args).where.where).toEqual({ ...pred('score', 'shop.maximum', 2), operand: { up: 2, path: ['shop', 'maximum'], joins: { shop: null } } });
    const normalized = frameCollectionPaths(args, context);
    expect(() => validateQuantifiedGroups(normalized, context)).not.toThrow();
    expect(frameUnits(args, context).count).toBe(3);
    expect(frameCollectionPaths(normalized, context)).toEqual(normalized);
  });

  it('retains shared aggregate J row bindings while adding only the remaining child frame', () => {
    const args = { ...condition('reviews.votes.score', 'reviews.maximum'), aggregation: { groupId: 'reviews.id', facts: [{ operation: 'COUNT', factName: 'count', path: 'reviews.id' }] } };
    const aggregate = createQueryPlan(models, 'Product', args, { mode: 'aggregate' });
    expect(aggregate.where).toEqual({ kind: 'quantified', quantifier: 'ANY', path: ['votes'], anchor: ['reviews'], scope: null, where: pred('score', 'reviews.maximum', 1) });
    const ctx = { ...context, operation: 'aggregate', J: new Set(['reviews']) };
    expect(() => validateQuantifiedGroups(frameCollectionPaths(args, ctx), ctx)).not.toThrow();
    expect(frameUnits(args, ctx).count).toBe(1);
  });

  it('counts the union of both operand reference paths without counting generated outer bindings', () => {
    expect(frameUnits(condition('shop.minStock', 'shop.maximum'), context).count).toBe(1);
    expect(frameUnits(condition('reviews.author.minStock', 'shop.maximum'), context).count).toBe(3);
    expect(frameUnits(condition('reviews.votes.score', 'reviews.author.maximum'), context).count).toBe(3);
  });

  it('accepts undefined literal placeholders before shorthand normalization', () => {
    const args = condition('reviews.rating', 'stock', { value: undefined });
    expect(() => validateQuantifiedGroups(frameCollectionPaths(args, context), context)).not.toThrow();
    expect(plan(args).where).toEqual(pred('rating', 'stock', 1));
  });

  it.each([
    { up: 0, path: ['stock'] }, { up: -1, path: ['stock'] }, { up: 2, path: ['stock'] },
    { up: 1.5, path: ['stock'] }, { up: 1, path: [] }, { up: 1, path: ['shop.maximum'] },
    { up: 1, path: ['stock'], extra: true },
  ])('rejects forged or malformed compiler-generated operands: %j', (__operand) => {
    const args = { AND: [{ ANY: [{ __implicit: true, path: 'reviews', conditions: [{ field: 'rating', __operand }] }] }] };
    fault(args, 'INVALID_FILTER_PATH');
  });

  it('rejects outer bindings on explicit client frames and incomplete outer scoped metadata', () => {
    fault({ AND: [{ ANY: [{ path: 'reviews', conditions: [{ field: 'rating', __operand: { up: 1, path: ['stock'] } }] }] }] }, 'INVALID_FILTER_PATH');
    const args = { AND: [{ ANY: [{ __implicit: true, path: 'reviews', __scope: { scopes: { reviews: null } },
      conditions: [{ field: 'author.minStock', __scope: { scopes: { author: null } }, __operand: { up: 1, path: ['shop', 'maximum'] } }] }] }] };
    fault(args, 'DETACHED_CLIENT_FILTER');
  });


  it('retains scoped reference guards before aggregate anchors without replacing J bindings', () => {
    const scopes = { shop: { maximum: { operator: 'GTE', value: 1 } }, 'shop.products': null, 'shop.products.reviews': null };
    const args = { ...condition('shop.products.reviews.rating', 'stock', { __scope: { id: 5, scopes } }),
      aggregation: { groupId: 'shop.products.id', facts: [{ operation: 'COUNT', factName: 'count', path: 'shop.products.id' }] } };
    expect(createQueryPlan(models, 'Product', args, { mode: 'aggregate' }).where).toEqual({
      kind: 'quantified', quantifier: 'ANY', path: ['reviews'], anchor: ['shop', 'products'],
      scope: null, joins: { shop: { kind: 'predicate', path: ['maximum'], operator: 'GTE', value: 1 } }, where: pred('rating', 'stock', 1),
    });
    const ctx = { ...context, operation: 'aggregate', J: new Set(['shop.products']) };
    const normalized = frameCollectionPaths(args, ctx);
    expect(() => validateQuantifiedGroups(normalized, ctx)).not.toThrow();
    expect(frameUnits(args, ctx).count).toBe(2);
  });


  it('keeps trusted comparisons inside shared client collection buckets free of recursive scopes', () => {
    const args = { AND: [{ conditions: [
      { field: 'reviews.rating', value: 1, __scope: { scopes: { reviews: null } } },
      { field: 'reviews.maximum', valuePath: 'shop.maximum' },
    ] }] };
    const normalized = frameCollectionPaths(args, context);
    expect(() => validateQuantifiedGroups(normalized, context)).not.toThrow();
    expect(plan(normalized).where.terms[1]).toEqual(pred('maximum', 'shop.maximum', 1));
  });

  it('budgets scoped and trusted reference reads separately while sharing both scoped operands', () => {
    const args = { AND: [{ conditions: [
      { field: 'shop.minStock', valuePath: 'shop.maximum', __scope: { scopes: { shop: null } } },
      { field: 'shop.minStock', valuePath: 'shop.maximum' },
    ] }] };
    expect(frameUnits(args, context).count).toBe(2);
  });

});
