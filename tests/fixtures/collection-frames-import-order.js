import assert from 'node:assert/strict';

// Fresh-process dynamic imports deliberately test every entry into the ESM dependency cycle.
const paths = {
  operators: '../../packages/core/src/query-operators.js',
  plan: '../../packages/core/src/query-plan.js',
  frames: '../../packages/core/src/query-frames.js',
  core: '../../packages/core/src/index.js',
};
await import(paths[process.argv[2]]);
const internal = await import('@simtlix/simfinity-core/internal/query-operators');
const frames = await import(paths.frames);
const quantifiers = await import('../../packages/core/src/const/QLQuantifier.js');
for (const name of ['validateQuantifiedGroups', 'frameCollectionPaths', 'frameUnits', 'aggregateJoinPrefixes', 'crossingKeys']) {
  assert.equal(typeof internal[name], 'function');
  assert.equal(internal[name], frames[name]);
}
assert.equal(internal.GROUP_KEYS, quantifiers.GROUP_KEYS);
assert.equal(internal.IMPLICIT_KEY, '__implicit');
assert.equal(internal.ANCHOR_KEY, '__anchor');
console.log('collection frame imports passed');
