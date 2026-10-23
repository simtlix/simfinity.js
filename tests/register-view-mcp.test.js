import { describe, expect, it } from 'vitest';
import {
  GraphQLID, GraphQLInt, GraphQLNonNull, GraphQLObjectType, GraphQLString,
} from 'graphql';
import { auth, createRuntime } from '../packages/core/src/index.js';
import { generateMCPTools } from '../packages/mcp/src/index.js';

const rows = [
  {
    _id: 'i1', id: 'i1', name: 'first', stock: 5, shop: 's1',
  },
  {
    _id: 'i2', id: 'i2', name: 'second', stock: 3, shop: 's1',
  },
];
const inShop = ({ params }) => ({ conditions: [{ field: 'shop', operator: 'EQ', value: params.shopId }] });
const inStock = ({ params }) => ({ conditions: [{ field: 'stock', operator: 'GTE', value: params.minStock }] });

// A fresh schema per caller: an auth schema plugin wraps the resolvers of the schema it is given.
const build = () => {
  // The shape of tests/mcp.test.js: every read is recorded with its arguments.
  const calls = [];
  const runtime = createRuntime({
    bind() {},
    prepare() {},
    createModel: (gqltype) => ({ name: gqltype.name }),
    castId: String,
    withTransaction: async (session, body) => body(session || {}),
    async getById(Model, id) { return rows.find((row) => row._id === id) || null; },
    async find(Model, gqltype, args) {
      calls.push({ method: 'find', args: structuredClone(args) });
      return rows;
    },
    async count(Model, gqltype, args) {
      calls.push({ method: 'count', args: structuredClone(args) });
      return rows.length;
    },
  });
  const Item = new GraphQLObjectType({
    name: 'NvItem',
    fields: {
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      stock: { type: GraphQLInt },
      // The stored id of the item's shop; a param may not take a field's name, so the views take shopId.
      shop: { type: GraphQLID },
    },
  });
  // A second type, so the type selectors have something to keep.
  const Shop = new GraphQLObjectType({
    name: 'NvShop',
    fields: { id: { type: GraphQLID }, name: { type: GraphQLString } },
  });
  runtime.connect(null, Item, 'nvItem', 'nvItems');
  runtime.connect(null, Shop, 'nvShop', 'nvShops');
  runtime.registerView('openItems', {
    type: Item,
    description: 'Open items with stock.',
    params: {
      minStock: { type: GraphQLInt, description: 'Minimum stock', defaultValue: 1 },
      shopId: { type: new GraphQLNonNull(GraphQLID) },
    },
    where: (input) => [inStock(input), inShop(input)],
  });
  runtime.registerView('shopItems', {
    type: Item,
    description: 'Items of a shop.',
    params: { shopId: { type: new GraphQLNonNull(GraphQLID) } },
    where: (input) => [inShop(input)],
  });
  return { schema: runtime.createSchema(), calls };
};

describe('named views through MCP', () => {
  const { schema, calls } = build();
  const { tools, callTool } = generateMCPTools(schema, { context: {} });
  const tool = tools.find((t) => t.name === 'openItems');
  const names = (options) => generateMCPTools(schema, options).tools.map((t) => t.name);

  it('publishes a view as a read-only list tool titled by its name, described by the view and the generated language', () => {
    expect(tool).toMatchObject({
      kind: 'query', title: 'openItems', annotations: { title: 'openItems', openWorldHint: false, readOnlyHint: true },
    });
    expect(tool.description.startsWith('Open items with stock. ')).toBe(true);
    expect(tool.description).toContain('nested AND/OR and ANY/ALL/NONE filter groups, pagination (page/size) and sorting');
    const list = tools.find((t) => t.name === 'nvItems');
    expect(list.title).toBe('List NvItem'); // the generated tool keeps its title
    // The view's language is the generated list sentence, byte for byte.
    const language = tool.description.slice('Open items with stock. '.length);
    expect(language.startsWith('Supports per-field filters (operators: EQ, ')).toBe(true);
    expect(language).toContain('nested AND/OR and ANY/ALL/NONE filter groups, pagination (page/size) and sorting.');
    expect(language).toContain('queryFeatures.quantifiers: true');
    expect(language).toContain('conditions on the same collection prefix in one group must match the same element');
    expect(language.endsWith('otherwise they fail with UNSUPPORTED_QUERY.')).toBe(true);
    expect(list.description).toBe(`List and search NvItem records. ${language} Returns an array of NvItem.`);
  });

  it('exposes the params with descriptions, defaults and required, next to the generated arguments', () => {
    expect(tool.inputSchema.properties.minStock).toMatchObject({ description: 'Minimum stock', default: 1 });
    expect(tool.inputSchema.required).toEqual(['shopId']); // NonNull without default
    expect(Object.keys(tool.inputSchema.properties)).toEqual(expect.arrayContaining([
      'minStock', 'shopId', 'id', 'name', 'AND', 'OR', 'sort', 'pagination',
    ]));
    expect(tool.outputSchema.properties.totalCount).toMatchObject({ type: 'integer', minimum: 0 });
  });

  it('selects a view by name, prefix and base type, and overrides keep precedence', () => {
    const itemTools = ['openItems', 'shopItems', 'nvItems', 'nvItems_aggregate'];
    expect(names({ include: ['openItems'] })).toEqual(['openItems']);
    const [prefixed] = generateMCPTools(schema, { toolNamePrefix: 'app_', include: ['app_shopItems'] }).tools;
    expect(prefixed).toMatchObject({ name: 'app_shopItems', title: 'shopItems', annotations: { title: 'shopItems' } });
    expect(names({ exclude: ['openItems'] })).not.toContain('openItems');
    expect(names({ exclude: ['openItems'] })).toContain('shopItems');
    expect(names({ includeTypes: ['NvItem'] })).toEqual(expect.arrayContaining(itemTools));
    expect(names({ includeTypes: ['NvShop'] })).not.toContain('openItems');
    const withoutItems = names({ excludeTypes: ['NvItem'] });
    expect(withoutItems).toContain('nvShops');
    for (const name of itemTools) expect(withoutItems).not.toContain(name);

    const overridden = generateMCPTools(schema, {
      include: ['openItems', 'shopItems'],
      toolOverrides: { openItems: { title: 'Open stock' }, shopItems: { description: 'Items by shop' } },
    });
    expect(overridden.tools.map(({ name, title, description }) => ({ name, title, description }))).toEqual([
      { name: 'openItems', title: 'Open stock', description: tool.description },
      { name: 'shopItems', title: 'shopItems', description: 'Items by shop' },
    ]);
    expect(overridden.tools[0].annotations.title).toBe('Open stock');
  });

  it('runs the view with params and returns rows and totalCount', async () => {
    calls.length = 0;
    const response = await callTool('openItems', { shopId: 's1', pagination: { page: 1, size: 10, count: true } });
    expect(response.isError).toBe(false);
    expect(response.structuredContent.openItems.map((row) => row.id)).toEqual(['i1', 'i2']);
    expect(response.structuredContent.totalCount).toBe(2);
    expect(response._meta).toEqual({ count: 2 });
    expect(calls.map((call) => call.method)).toEqual(['find', 'count']);
    expect(calls.every((call) => !('shopId' in call.args) && !('minStock' in call.args))).toBe(true);
    // The params reach `where`, with the default of the omitted minStock.
    const input = { params: { minStock: 1, shopId: 's1' } };
    for (const call of calls) expect(call.args.AND).toEqual([inStock(input), inShop(input)]);
  });

  it('rejects an unknown argument and publishes the base type selection in the output schema', async () => {
    calls.length = 0;
    const unknown = await callTool('openItems', { shopId: 's1', nope: 1 });
    expect(unknown.isError).toBe(true);
    expect(JSON.parse(unknown.content[0].text).errors[0].extensions.code).toBe('MCP_UNKNOWN_ARGUMENT');
    expect(calls).toEqual([]);
    expect(Object.keys(tool.outputSchema.properties.openItems.items.properties))
      .toEqual(expect.arrayContaining(['id', 'name', 'stock']));
  });

  it('authorizes the root by the view name under DENY and keeps the base type field rules on rows and client paths', async () => {
    const plugin = auth.createAuthPlugin({
      RootQueryType: { openItems: auth.requireAuth() },
      NvItem: {
        id: auth.allow(), name: auth.allow(), shop: auth.allow(), stock: auth.deny(),
      },
    }, { defaultPolicy: 'DENY' });
    const { schema: authorized } = build();
    const options = { schemaPlugins: [plugin], context: (extra) => extra };
    const { callTool: call } = generateMCPTools(authorized, options);
    // The same view, narrowed to the fields the caller may read.
    const { callTool: narrowed } = generateMCPTools(authorized, {
      ...options, toolOverrides: { openItems: { selection: '{ id name }' } },
    });
    const user = { user: { id: 'u1' } };
    const errorsOf = (response) => JSON.parse(response.content[0].text).errors;

    // The root: its RootQueryType rule, and the DENY default for a view without one.
    expect(errorsOf(await narrowed('openItems', { shopId: 's1' }, {}))[0].extensions.code).toBe('UNAUTHENTICATED');
    expect(errorsOf(await call('shopItems', { shopId: 's1' }, user))[0].extensions.code).toBe('FORBIDDEN');

    // The rows: the default selection reads the denied stock of each row.
    const full = await call('openItems', { shopId: 's1' }, user);
    expect(full.isError).toBe(true);
    expect(errorsOf(full).map(({ path, extensions }) => [path, extensions.code])).toEqual([
      [['openItems', 0, 'stock'], 'FORBIDDEN'],
      [['openItems', 1, 'stock'], 'FORBIDDEN'],
    ]);

    // Without stock in the selection the params pass, and the where on stock is the author's.
    const allowed = await narrowed('openItems', { shopId: 's1', minStock: 2 }, user);
    expect(allowed.isError).toBe(false);
    expect(allowed.structuredContent.openItems).toEqual([{ id: 'i1', name: 'first' }, { id: 'i2', name: 'second' }]);

    // A client filter on stock is a path on the base type, read by its rule.
    const filtered = await narrowed('openItems', { shopId: 's1', stock: { operator: 'GTE', value: 1 } }, user);
    expect(errorsOf(filtered)[0].extensions.code).toBe('FORBIDDEN');
  });
});
