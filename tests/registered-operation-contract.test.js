import { execFileSync } from 'node:child_process';
import { test, expect } from 'vitest';
import { GraphQLString } from 'graphql';
import { createRuntime } from '../packages/core/src/index.js';

test('registered custom operations preserve opaque input/context/session identity concurrently', async () => {
  const runtime = createRuntime({ withTransaction: (session, body) => body(session) });
  const observed = [];
  runtime.use(async (operation, next) => { observed.push(operation); await next(); });
  runtime.registerMutation('ingress', 'Caller-owned ingress lifecycle', null, GraphQLString, async (input, session, context) => {
    await Promise.resolve(); return { input, session, context };
  });
  const a = { raw: Buffer.from('one') }, b = { raw: Buffer.from('two') };
  const contextA = {}, contextB = {}, sessionA = {}, sessionB = {};
  const [first, second] = await Promise.all([
    runtime.executeMutation('ingress', a, { context: contextA, session: sessionA }),
    runtime.executeMutation('ingress', b, { context: contextB, session: sessionB }),
  ]);
  expect(first.input).toBe(a); expect(second.input).toBe(b);
  expect(first.context).toBe(contextA); expect(second.context).toBe(contextB);
  expect(first.session).toBe(sessionA); expect(second.session).toBe(sessionB);
  expect(observed.map((operation) => operation.entry)).toEqual(['ingress', 'ingress']);
  await expect(runtime.executeMutation('missing')).rejects.toMatchObject({ extensions: { code: 'UNREGISTERED_OPERATION' } });
  runtime.use(() => { throw new Error('denied'); });
  await expect(runtime.executeMutation('ingress', a)).rejects.toThrow('denied');
});

test('process-wide introspection opt-out supports standard schema roundtrip and repeated imports', () => {
  expect(execFileSync(process.execPath, ['tests/fixtures/registered-introspection.js'], { encoding: 'utf8' })).toContain('standard introspection roundtrip passed');
});
