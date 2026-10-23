// The fixture of the named-views integration suite (tests/integration/named-views.test.js): shops and their items, an
// item scope by tenant and a shop scope that keeps open shops, three views over items, and records written through
// the generated create mutations, so each backend stores what its own mutations store.
//
// Exports:
// - createNamedViewTypes(prefix = 'Nv') -> { Shop, Item, embedded: [] }. Fresh GraphQL types for one runtime (a
//   relation field binds its types to the runtime that first builds its resolvers).
//   - Shop { id, key, name, state }: its find scope keeps the OPEN shops when the context has `openOnly`.
//   - Item { id, key, name, stock, tenant, shop }: its find, aggregate and get_by_id scopes keep the items of
//     `context.tenant` when the context has one; `shop` is a reference to Shop, stored as `shop`.
// - namedViewWhere() -> { openItems, shopItems, orphanItems }: a fresh object with the `where` of each view.
// - registerNamedViewFixture(api, types, whereRef = namedViewWhere()) -> whereRef. Connects Shop and Item, each named
//   after its type with a lower-case first letter (`nvShop`/`nvShops` and `nvItem`/`nvItems` with the default
//   prefix), and registers three views on Item: openItems(minStock: Int = 1) (stock GTE minStock),
//   shopItems(shopId: ID!) (shop.id EQ shopId) and orphanItems (shop IS_EMPTY). Each view's `where` calls
//   `whereRef[view name]` when it runs, so a test can replace one and restore it.
// - seedNamedViews(execute, prefix = 'Nv') -> Promise<{ [key]: id }>: creates the shops S1 (OPEN) and S2 (CLOSED), and
//   the items A (tenant a, stock 5, S1), B (a, 0, S2), C (a, 3, no shop) and D (b, 9, S1) through the generated create
//   mutations, and returns each record's id by key. `execute(source, variables)` returns a GraphQL result; an error
//   throws. Shop names: S1 'South', S2 'North'; item names: A 'First item', B 'Second item', C 'Spare part', D
//   'Fourth item'.
import {
  GraphQLID, GraphQLInt, GraphQLNonNull, GraphQLObjectType, GraphQLString,
} from 'graphql';

const lowerFirst = (value) => value.charAt(0).toLowerCase() + value.slice(1);

const tenantScope = ({ args, context }) => {
  if (context?.tenant) args.tenant = { operator: 'EQ', value: context.tenant };
};
const openOnlyScope = ({ args, context }) => {
  if (context?.openOnly) args.state = { operator: 'EQ', value: 'OPEN' };
};

export const createNamedViewTypes = (prefix = 'Nv') => {
  const Shop = new GraphQLObjectType({
    name: `${prefix}Shop`,
    extensions: { scope: { find: openOnlyScope } },
    fields: {
      id: { type: GraphQLID },
      key: { type: new GraphQLNonNull(GraphQLString) },
      name: { type: GraphQLString },
      state: { type: GraphQLString },
    },
  });
  const Item = new GraphQLObjectType({
    name: `${prefix}Item`,
    extensions: { scope: { find: tenantScope, aggregate: tenantScope, get_by_id: tenantScope } },
    fields: {
      id: { type: GraphQLID },
      key: { type: new GraphQLNonNull(GraphQLString) },
      name: { type: GraphQLString },
      stock: { type: GraphQLInt },
      tenant: { type: new GraphQLNonNull(GraphQLString) },
      shop: { type: Shop, extensions: { relation: { embedded: false, connectionField: 'shop' } } },
    },
  });
  return { Shop, Item, embedded: [] };
};

export const namedViewWhere = () => ({
  openItems: ({ params }) => [{ conditions: [{ field: 'stock', operator: 'GTE', value: params.minStock }] }],
  shopItems: ({ params }) => [{ conditions: [{ field: 'shop', path: 'id', operator: 'EQ', value: params.shopId }] }],
  orphanItems: () => [{ conditions: [{ field: 'shop', operator: 'IS_EMPTY' }] }],
});

const VIEWS = {
  openItems: {
    description: 'Items with at least minStock units in stock.',
    params: { minStock: { type: GraphQLInt, description: 'The least stock an item has', defaultValue: 1 } },
  },
  shopItems: {
    description: 'Items of one shop.',
    params: { shopId: { type: new GraphQLNonNull(GraphQLID), description: 'The shop whose items are listed' } },
  },
  orphanItems: { description: 'Items without a shop the caller can read.' },
};

export const registerNamedViewFixture = (api, types, whereRef = namedViewWhere()) => {
  for (const type of types.embedded) api.addNoEndpointType(type);
  for (const type of [types.Shop, types.Item]) {
    const name = lowerFirst(type.name);
    api.connect(null, type, name, `${name}s`);
  }
  for (const [name, view] of Object.entries(VIEWS)) {
    api.registerView(name, { type: types.Item, ...view, where: (input) => whereRef[name](input) });
  }
  return whereRef;
};

const SHOPS = [
  { key: 'S1', name: 'South', state: 'OPEN' },
  { key: 'S2', name: 'North', state: 'CLOSED' },
];
const ITEMS = [
  {
    key: 'A', name: 'First item', stock: 5, tenant: 'a', shop: 'S1',
  },
  {
    key: 'B', name: 'Second item', stock: 0, tenant: 'a', shop: 'S2',
  },
  {
    key: 'C', name: 'Spare part', stock: 3, tenant: 'a',
  },
  {
    key: 'D', name: 'Fourth item', stock: 9, tenant: 'b', shop: 'S1',
  },
];

export const seedNamedViews = async (execute, prefix = 'Nv') => {
  const ids = {};
  const create = async (typeName, input) => {
    const source = `mutation($input:${typeName}Input!){add${lowerFirst(typeName)}(input:$input){id}}`;
    const result = await execute(source, { input });
    if (result.errors) throw new Error(`${source} ${JSON.stringify(input)}: ${JSON.stringify(result.errors)}`);
    ids[input.key] = Object.values(result.data)[0].id;
  };
  for (const shop of SHOPS) await create(`${prefix}Shop`, shop);
  for (const { shop, ...item } of ITEMS) await create(`${prefix}Item`, shop ? { ...item, shop: { id: ids[shop] } } : item);
  return ids;
};
