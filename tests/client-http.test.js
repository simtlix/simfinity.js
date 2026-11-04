import { expect, test } from 'vitest';
import SimfinityClient from '../packages/client/src/SimfinityClient.js';
import { clientSchema } from './helpers/client-schema.js';

test('preserves GraphQL error extensions through HTTP failures and never retries writes', async () => {
  let calls = 0;
  const errors = [{ message: 'Conflict', extensions: { code: 'VERSION_CONFLICT', status: 409, operationIndex: 1, operation: 'updatebook' } }];
  const client = new SimfinityClient('/graphql', { descriptor: clientSchema().descriptor, fetch: async () => { calls++; return new Response(JSON.stringify({ errors }), { status: 409 }); } });
  await client.init();
  await expect(client.update('book', 'id', { title: 'x' })).rejects.toMatchObject({ graphQLErrors: errors });
  expect(calls).toBe(1);
});
test.each([['not json', 502], ['{}', 200], ['{"data":null}', 503]])('reports malformed HTTP envelopes without leaking credentials', async (body, status) => {
  const client = new SimfinityClient('/graphql', { fetch: async () => new Response(body, { status }), prepareHeaders: (h) => { h.Authorization = 'secret'; } });
  await expect(client.execute('{anything}')).rejects.toThrow(/response|HTTP|JSON/i);
});
test('returns nullable results safely and preserves raw and partial envelopes', async () => {
  const envelope = { data: { books: null }, extensions: { count: 0 } };
  const client = new SimfinityClient('/graphql', { descriptor: clientSchema().descriptor, fetch: async () => new Response(JSON.stringify(envelope)) }); await client.init();
  expect(await client.find('book').exec()).toBeNull();
  expect(await client.find('book').execWithMeta()).toEqual({ data: null, extensions: { count: 0 } });
  expect(await client.execute('{ books { id } }')).toEqual(envelope);
});
