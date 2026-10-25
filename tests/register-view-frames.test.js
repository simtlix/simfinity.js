import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureQueryLimits, createRuntime, QLOperator } from '../packages/core/src/index.js';
import { createReferenceEmptinessTypes, registerReferenceEmptinessTypes } from './helpers/query-emptiness.js';
import { COLLECTION_DATA, createMemoryAdapter, referenceStore } from './helpers/collection-frames.js';

const features = { operators: QLOperator.getValues().map(({ value }) => value), referenceEmptiness: true, quantifiers: true };
const condition = (field = 'reviews.rating', value = 4, operator = 'GTE') => ({ field, value, operator });
const shorthand = () => ({ conditions: [condition()] });
const frame = (quantifier = 'ANY') => ({ [quantifier]: [{ path: 'reviews', conditions: [condition('rating')] }] });
const build = ({ groups = [shorthand()], scoped = true, middleware, scope, queryFeatures = features } = {}) => {
  const calls = [];
  const types = createReferenceEmptinessTypes('Vf');
  for (const { type } of Object.values(types.roots)) type.extensions = {};
  const scopeCalls = vi.fn(({ args }) => { args.author = { operator: 'NE', value: 'hidden' }; });
  if (scoped) types.Review.extensions.scope = { find: scopeCalls };
  if (scope) types.Product.extensions.scope = { find: scope };
  const runtime = createRuntime(createMemoryAdapter({ queryFeatures, calls, data: referenceStore('Vf', { records: COLLECTION_DATA }) }));
  const middlewareCalls = vi.fn(async (params, next) => { await middleware?.(params); await next(); });
  runtime.use(middlewareCalls);
  registerReferenceEmptinessTypes(runtime, types);
  runtime.registerView('framedProducts', { type: types.Product, description: 'Products with matching reviews', where: () => groups });
  const schema = runtime.createSchema();
  const invoke = (args = {}) => schema.getQueryType().getFields().framedProducts.resolve(null, args, {});
  return { calls, invoke, middlewareCalls, scopeCalls };
};
afterEach(() => configureQueryLimits());

describe('named views with collection frames', () => {
  it.each(['shorthand', 'ANY', 'ALL', 'NONE'])('copies and scopes %s where constructs', async (kind) => {
    const groups = [kind === 'shorthand' ? shorthand() : frame(kind)];
    const snapshot = structuredClone(groups);
    const f = build({ groups });
    await f.invoke();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].rows).toEqual(kind === 'NONE' ? ['C', 'D', 'F', 'c'] : kind === 'ALL' ? ['C', 'E', 'F', 'c'] : ['E', 'Ka']);
    expect(f.scopeCalls).toHaveBeenCalledTimes(1);
    expect(groups).toEqual(snapshot);
  });

  it('scopes nested quantified where groups with element-relative reference and collection paths', async () => {
    const groups = [{ ANY: [{ path: 'reviews', ANY: [{ path: 'product', NONE: [{ path: 'reviews', conditions: [condition('rating', 1, 'LT')] }] }] }] }];
    const snapshot = structuredClone(groups);
    const f = build({ groups });
    await f.invoke();
    expect(f.calls[0].rows).toEqual(['D', 'E', 'Ka']);
    expect(f.scopeCalls).toHaveBeenCalledTimes(1);
    expect(groups).toEqual(snapshot);
  });

  it('limits nested quantified where frames before target scopes or storage', async () => {
    configureQueryLimits({ maxFrameNesting: 1 });
    const f = build({ groups: [{ ANY: [{ path: 'reviews', ANY: [{ path: 'product' }] }] }] });
    await expect(f.invoke()).rejects.toMatchObject({ extensions: { code: 'FILTER_DEPTH_EXCEEDED', status: 400 } });
    expect(f.scopeCalls).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(0);
  });

  it('shares marker issuance and scope filling across client and where frames', async () => {
    const f = build();
    await f.invoke({ AND: [shorthand()] });
    const groups = f.calls[0].args.AND;
    expect(groups.map((group) => group.conditions[0].__scope.id)).toEqual([0, 1]);
    expect(f.calls[0].rows).toEqual(['E', 'Ka']);
    expect(f.scopeCalls).toHaveBeenCalledTimes(1);
  });

  it.each([['scoped', true], ['pin: unscoped', false]])('%s uses separate client/where frame budgets', async (label, scoped) => {
    configureQueryLimits({ maxReferenceFrames: 1 });
    const f = build({ scoped });
    await expect(f.invoke({ AND: [shorthand()] })).resolves.toBeDefined();
    expect(f.calls).toHaveLength(1);
  });

  it.each([true, false])('rejects oversized where before scopes/storage, scoped=%s', async (scoped) => {
    configureQueryLimits({ maxReferenceFrames: 1 });
    const f = build({ groups: [shorthand(), shorthand()], scoped });
    await expect(f.invoke()).rejects.toMatchObject({ extensions: { code: 'FILTER_DEPTH_EXCEEDED', status: 400 } });
    expect(f.middlewareCalls).toHaveBeenCalledTimes(1);
    expect(f.scopeCalls).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(0);
  });

  it.each([true, false])('rejects oversized client before middleware, scoped=%s', async (scoped) => {
    configureQueryLimits({ maxReferenceFrames: 1 });
    const f = build({ scoped });
    await expect(f.invoke({ AND: [shorthand(), shorthand()] })).rejects.toMatchObject({ extensions: { code: 'FILTER_DEPTH_EXCEEDED', status: 400 } });
    expect(f.middlewareCalls).not.toHaveBeenCalled();
    expect(f.calls).toHaveLength(0);
  });

  it('still detects a detached client condition when where issues more markers', async () => {
    const f = build({ middleware: ({ args }) => { args.AND = []; } });
    await expect(f.invoke({ AND: [shorthand()] })).rejects.toMatchObject({ extensions: { code: 'DETACHED_CLIENT_FILTER', status: 500 } });
    expect(f.calls).toHaveLength(0);
  });

  it('preserves view markers through the base scope detach check', async () => {
    const f = build({ scope: ({ args }) => { args.AND = []; } });
    await expect(f.invoke()).rejects.toMatchObject({ extensions: { code: 'DETACHED_CLIENT_FILTER', status: 500 } });
    expect(f.calls).toHaveLength(0);
  });

  // 3.12.0 also rejects these shapes, at its unsupported ANY key; the merged-tree RED
  // separately proves the nested validation regressions after ANY becomes supported.
  it.each([
    ['reserved frame marker', { path: 'reviews', __scope: { id: 0 } }],
    ['reserved condition marker', { path: 'reviews', conditions: [{ ...condition('rating'), __scope: { id: 0 } }] }],
    ['missing path', { conditions: [condition('rating')] }],
    ['non-string path', { path: 12 }],
    ['unknown frame key', { path: 'reviews', extra: true }],
    ['unknown nested group key', { path: 'reviews', AND: [{ extra: true }] }],
    ['unknown nested condition key', { path: 'reviews', conditions: [{ ...condition('rating'), extra: true }] }],
    ['unknown nested field', { path: 'reviews', conditions: [condition('unknown')] }],
    ['scalar nested conditions', { path: 'reviews', conditions: 1 }],
  ])('pin: rejects %s with INVALID_VIEW', async (label, group) => {
    const f = build({ groups: [{ ANY: [group] }] });
    await expect(f.invoke()).rejects.toMatchObject({ extensions: { code: 'INVALID_VIEW', status: 500 } });
    expect(f.calls).toHaveLength(0);
  });

  it('pin: rejects a cyclic quantified where group with INVALID_VIEW', async () => {
    const group = { path: 'reviews' };
    group.ANY = [group];
    const f = build({ groups: [{ ANY: [group] }] });
    await expect(f.invoke()).rejects.toMatchObject({ extensions: { code: 'INVALID_VIEW', status: 500 } });
  });

  it('checks adapter capability on valid quantified where', async () => {
    const f = build({ groups: [frame()], queryFeatures: { operators: features.operators, referenceEmptiness: true } });
    await expect(f.invoke()).rejects.toMatchObject({ extensions: { code: 'UNSUPPORTED_QUERY', status: 400 } });
    expect(f.calls).toHaveLength(0);
  });
});
