import { describe, expect, it, vi } from 'vitest';
import { GraphQLObjectType, GraphQLSchema, GraphQLString, graphql } from 'graphql';
import { createControlledRace } from './helpers/controlled-race.js';

describe('optimistic-concurrency controlled race cleanup', () => {
  it.each(['rejection', 'GraphQL errors', 'early success'])('settles a waiting peer when a writer ends with %s before its arrival', async (outcome) => {
    const race = createControlledRace();
    const arrival = race.gate('second writer arrival');
    const original = new Error('injected early writer failure');
    let peerSettled = false;
    const peer = race.start(async () => {
      try { await arrival.wait(); }
      finally { peerSettled = true; }
    });
    const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: {
      write: { type: GraphQLString, resolve() { throw original; } },
    } }) });
    const early = race.start(() => {
      if (outcome === 'rejection') throw original;
      if (outcome === 'GraphQL errors') return graphql({ schema, source: '{ write }' });
      return 'ended without arriving';
    });
    try {
      const [peerResult, earlyResult] = await Promise.allSettled([peer, early]);
      expect(peerSettled).toBe(true);
      expect(peerResult.status).toBe('rejected');
      if (outcome === 'rejection') expect(peerResult.reason).toBe(original);
      else if (outcome === 'GraphQL errors') {
        expect(earlyResult.status).toBe('fulfilled');
        expect(peerResult.reason).toBe(earlyResult.value.errors[0]);
        expect(peerResult.reason.originalError).toBe(original);
      } else expect(peerResult.reason.message).toBe('Writer ended before race gates: second writer arrival');
      expect(() => race.check()).toThrow(peerResult.reason);
    } finally { await race.finish(); }
    expect(peerSettled).toBe(true);
  });

  it('uses its owned deadline only to fail and settle a missing arrival', async () => {
    vi.useFakeTimers();
    const race = createControlledRace({ timeoutMs: 100 });
    const arrival = race.gate('missing arrival');
    let settled = false;
    const writer = race.start(async () => {
      try { await arrival.wait(); }
      finally { settled = true; }
    });
    const result = Promise.allSettled([writer]);
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect((await result)[0].reason.message).toBe('Controlled race exceeded its safety deadline');
      expect(settled).toBe(true);
    } finally { await race.finish(); vi.useRealTimers(); }
  });
});
