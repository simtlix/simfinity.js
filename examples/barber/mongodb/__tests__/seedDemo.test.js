// seed:demo finds its shop by slug on the server, however many shops exist, and finishes a partial demo (#132).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ shops: [], calls: [], user: null }));
const users = { 'propietario@demo.com': 'owner', 'cliente@demo.com': 'client', 'admin@demo.com': 'admin' };

vi.mock('@simtlix/simfinity-js-client', () => ({
  default: class FakeClient {
    async init() {}

    async execute(query, variables) {
      const transition = /(\w+)_barbershop\(input: \{ id: "([^"]+)" \}\)/.exec(query);
      if (transition) {
        const [, action, id] = transition;
        store.calls.push([action, store.user]);
        const shop = store.shops.find((row) => row.id === id);
        shop.state = { submitforreview: 'PENDING_REVIEW', approve: 'APPROVED' }[action];
        return { data: { [`${action}_barbershop`]: { id, state: shop.state } } };
      }
      const operation = /\{\s*(\w+)\(input/.exec(query)[1];
      store.user = users[variables.input.email];
      return { data: { [operation]: { accessToken: `token-${store.user}`, user: { id: store.user, email: variables.input.email, role: 'X' } } } };
    }

    find(type) {
      const filters = [];
      const builder = {
        where: (field, operator, value) => { store.calls.push(['where', type, field, operator, value]); filters.push([field, value]); return builder; },
        fields: () => builder,
        // The API returns at most 100 rows of an unpaged list. Owners see their own shops in any state
        // and other shops once APPROVED (#53); the admin sees every shop.
        exec: async () => store.shops
          .filter((shop) => store.user === 'admin' || shop.owner.id === store.user || shop.state === 'APPROVED')
          .filter((shop) => filters.every(([field, value]) => shop[field] === value)).slice(0, 100),
      };
      return builder;
    }

    async add(type, input) {
      store.calls.push(['add', type, store.user]);
      if (type === 'barbershop') {
        // Slugs are unique, whoever can see the shop that holds one.
        if (store.shops.some((row) => row.slug === input.slug)) throw new Error('E11000 duplicate key error collection: barbershop index: slug_1');
        const shop = { id: 'new-shop', slug: input.slug, state: 'DRAFT', owner: { id: input.owner.id }, services: [], professionals: [] };
        store.shops.push(shop);
        return shop;
      }
      const shop = store.shops.find((row) => row.id === input.barbershop.id);
      const row = { id: `${type}-${shop[`${type}s`].length + 1}` };
      shop[`${type}s`].push(row);
      return row;
    }
  },
}));

const filler = (i) => ({ id: `shop-${i}`, slug: `filler-${i}`, state: 'APPROVED', owner: { id: 'someone' }, services: [{ id: 's' }], professionals: [{ id: 'p' }] });
async function seed() {
  vi.resetModules();
  await import('../scripts/seedDemo.js');
}

beforeEach(() => {
  store.calls = [];
  store.user = null;
  process.env.GRAPHQL_ENDPOINT = 'http://localhost:1/graphql';
  delete process.env.DEMO_SHOP_SLUG;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('seed:demo', () => {
  it('finds the demo shop beyond the first 100 shops instead of adding its slug again', async () => {
    store.shops = Array.from({ length: 150 }, (_, i) => (i === 120
      ? { id: 'demo', slug: 'barber-demo', state: 'APPROVED', owner: { id: 'owner' }, services: [{ id: 'cut' }], professionals: [{ id: 'alex' }] }
      : filler(i)));
    await seed();
    expect(store.calls).toContainEqual(['where', 'barbershop', 'slug', 'EQ', 'barber-demo']);
    expect(store.calls.filter(([kind]) => kind === 'add')).toEqual([]);
    expect(console.log).toHaveBeenCalledWith('Demo already ready: demo');
  });

  it('finishes a demo that an earlier run left as a DRAFT shop without its professional', async () => {
    store.shops = [...Array.from({ length: 120 }, (_, i) => filler(i)),
      { id: 'demo', slug: 'barber-demo', state: 'DRAFT', owner: { id: 'owner' }, services: [{ id: 'cut' }], professionals: [] }];
    await seed();
    expect(store.calls.filter(([kind]) => kind !== 'where')).toEqual([
      ['add', 'professional', 'owner'],
      ['submitforreview', 'owner'],
      ['approve', 'admin'],
    ]);
    expect(store.shops.at(-1)).toMatchObject({ state: 'APPROVED', professionals: [{ id: 'professional-1' }] });
  });

  it('builds the whole demo when the shop does not exist', async () => {
    store.shops = Array.from({ length: 101 }, (_, i) => filler(i));
    await seed();
    expect(store.calls.filter(([kind]) => kind !== 'where')).toEqual([
      ['add', 'barbershop', 'owner'],
      ['add', 'service', 'owner'],
      ['add', 'professional', 'owner'],
      ['submitforreview', 'owner'],
      ['approve', 'admin'],
    ]);
    expect(console.log).toHaveBeenCalledWith('Demo ready: new-shop');
  });

  it("names the conflict when another owner's unpublished shop holds the slug", async () => {
    store.shops = [...Array.from({ length: 3 }, (_, i) => filler(i)),
      { id: 'foreign', slug: 'barber-demo', state: 'PENDING_REVIEW', owner: { id: 'someone' }, services: [], professionals: [] }];
    await expect(seed()).rejects.toThrow('The shop barber-demo belongs to another account; set DEMO_SHOP_SLUG to another slug');
    expect(store.calls.filter(([kind]) => kind !== 'where')).toEqual([]);
  });
});
