import { describe, expect, test } from 'vitest';
import SimfinityClient from '../packages/client/src/SimfinityClient.js';
import { clientSchema, schemaFetch } from './helpers/client-schema.js';

describe('browser client metadata', () => {
  test('initializes from descriptor without introspection and preserves old registry views', async () => {
    const { descriptor } = clientSchema({ singular: 'lookup', plural: 'catalog' });
    const client = new SimfinityClient('/graphql', { descriptor, fetch: () => { throw new Error('No request expected'); } });
    await client.init();
    expect(client.getPluralQueryName('book')).toBe('catalog');
    expect(client.getSingularQueryName('book')).toBe('lookup');
    expect(client.getTypes().book.kind).toBe('OBJECT');
    expect(client.getFieldsOfType('book').find((f) => f.name === 'title').rawType).toEqual({ kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'String' } });
    expect(client.getDescriptor()).toEqual(descriptor);
    expect(client.getTypes().bookInput.fields.find((f) => f.name === 'title').type.name).toBe('String');
  });
  test.each(['extended', 'standard'])('loads input fields and complete wrappers through %s introspection', async (introspection) => {
    const { schema } = clientSchema(); const requests = [];
    const client = new SimfinityClient('/graphql', { introspection, fetch: schemaFetch(schema, null, requests) });
    await client.init();
    expect(client.getTypes().bookInput.fields.find((f) => f.name === 'title').type.name).toBe('String');
    expect(client.getQueries().books.args.find((a) => a.name === 'pagination').type.name).toBe('QLPagination');
    expect(client.getDescriptor()).toBeNull();
    expect(requests[0].body.includes('extensions {')).toBe(introspection === 'extended');
  });
  test('fetches only the explicit descriptor endpoint with fresh async headers', async () => {
    const { schema, descriptor } = clientSchema(); const requests = [];
    const client = new SimfinityClient('/graphql', { descriptorEndpoint: '/metadata', fetch: schemaFetch(schema, descriptor, requests), prepareHeaders: async (headers) => { await Promise.resolve(); headers.Authorization = 'Bearer test'; } });
    await client.init();
    expect(requests.map((r) => [r.url, r.method, r.headers.Authorization])).toEqual([['/metadata', 'GET', 'Bearer test']]);
  });
  test('rejects malformed descriptors and installs reinitializations atomically per client', async () => {
    const { descriptor } = clientSchema(); let current = descriptor;
    const client = new SimfinityClient('/graphql', { descriptorEndpoint: '/metadata', fetch: async () => new Response(JSON.stringify(current)) });
    await client.init(); current = { ...descriptor, formatVersion: 2 };
    await expect(client.init()).rejects.toThrow(/format/i);
    expect(client.getPluralQueryName('book')).toBe('books');
    const other = new SimfinityClient('/graphql', { descriptor: clientSchema({ plural: 'others' }).descriptor });
    await other.init(); expect(other.getPluralQueryName('book')).toBe('others');
    expect(client.getPluralQueryName('book')).toBe('books');
    const broken = structuredClone(descriptor); broken.operations.query.books.returns = '[Missing!]!';
    await expect(new SimfinityClient('/graphql', { descriptor: broken }).init()).rejects.toThrow(/Missing/);
    expect(() => new SimfinityClient('/graphql', { descriptor, descriptorEndpoint: '/metadata' })).toThrow(/exclusive|both/i);
  });
});
