import {
  afterEach, beforeEach, describe, expect, test, vi,
} from 'vitest';
import {
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
} from 'graphql';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createRuntime } from '../packages/core/src/index.js';
import { createMCPServer, generateMCPTools } from '../packages/mcp/src/index.js';

// Virtual fields (#109) in generated MCP tools: a virtual field with a required argument gets its own
// read tool, `<byIdQuery>_<field>`, and list tools select virtual fields only with `mcp: 'select'`.

const createMemoryAdapter = () => {
  const records = new Map();
  const ofModel = (Model) => [...records.values()].filter((record) => record.__model === Model.name);
  // Honors top-level EQ filters on scalar fields, so scopes can hide records.
  const matches = (record, args) => Object.entries(args || {}).every(([name, value]) => {
    if (['AND', 'OR', 'sort', 'pagination'].includes(name) || value?.operator !== 'EQ') return true;
    return String(name === 'id' ? record._id : record[name]) === String(value.value);
  });
  return {
    records,
    seed(Model, id, data) {
      records.set(id, { ...data, _id: id, __model: Model });
    },
    prepare: vi.fn(),
    createModel: vi.fn((gqltype) => ({ name: gqltype.name })),
    castId: (value) => String(value),
    withTransaction: async (session, body) => body(session || { adapter: 'memory' }),
    newRecord: (Model, data) => ({ ...data, _id: String(records.size + 1), __model: Model.name }),
    async saveRecord(Model, record) {
      records.set(record._id, record);
      return record;
    },
    toObject: (record) => ({ ...record }),
    async getById(Model, id) {
      const record = records.get(String(id));
      return record && record.__model === Model.name ? record : null;
    },
    prepareUpdate: vi.fn((set, unset) => ({ set, unset })),
    async update(Model, id) {
      return records.get(String(id));
    },
    async delete(Model, id) {
      return records.get(String(id)) || null;
    },
    find: vi.fn(async (Model, gqltype, args) => ofModel(Model).filter((record) => matches(record, args))),
    count: vi.fn(async () => 0),
    aggregate: vi.fn(async () => []),
    findChildren: vi.fn(async (Model, gqltype, connectionField, parentId) => ofModel(Model)
      .filter((record) => String(record[connectionField]) === String(parentId))),
  };
};

// Every virtual field also declares readOnly: true, which virtual implies. It lets the fixture build on
// a core without virtual fields, where the field would otherwise get a generated input, so that these
// tests fail there because of MCP, not because the schema cannot be built.
const virtualField = (resolve, config, virtual = true) => ({
  ...config,
  extensions: { readOnly: true, virtual },
  resolve,
});

const buildFixture = () => {
  const calls = {};
  const spy = (name, implementation) => {
    calls[name] = vi.fn(implementation);
    return calls[name];
  };

  const SlotType = new GraphQLObjectType({ name: 'VfmSlot', fields: { label: { type: GraphQLString } } });
  // Reached only through virtual fields, and not registered.
  const RangeType = new GraphQLObjectType({
    name: 'VfmRange',
    fields: { start: { type: GraphQLString }, end: { type: GraphQLString }, slot: { type: SlotType } },
  });
  const StatsType = new GraphQLObjectType({ name: 'VfmStats', fields: { visits: { type: GraphQLInt } } });
  const AddressType = new GraphQLObjectType({
    name: 'VfmAddress',
    fields: () => ({
      street: { type: GraphQLString },
      formatted: virtualField(spy('formatted', (address, args) => `${address.street} (${args.style})`), {
        type: GraphQLString, args: { style: { type: new GraphQLNonNull(GraphQLString) } },
      }),
    }),
  });
  const ShopType = new GraphQLObjectType({
    name: 'VfmShop',
    description: 'A barbershop.',
    extensions: {
      scope: {
        get_by_id: ({ args, context }) => {
          if (context?.onlyOpen) args.open = { operator: 'EQ', value: 'yes' };
        },
      },
    },
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      open: { type: GraphQLString },
      address: { type: AddressType, extensions: { relation: { embedded: true } } },
      bookings: { type: new GraphQLList(BookingType), extensions: { relation: { connectionField: 'shop' } } },
      score: virtualField(spy('score', () => 42), { type: new GraphQLNonNull(GraphQLInt) }),
      rating: virtualField(spy('rating', () => 4.5), { type: GraphQLFloat }, { mcp: 'select' }),
      stats: virtualField(spy('stats', () => ({ visits: 3 })), { type: StatsType }, { mcp: 'select' }),
      summary: virtualField(spy('summary', () => ({ visits: 9 })), { type: StatsType }),
      nickname: virtualField(spy('nickname', () => 'nick'), { type: GraphQLString }, { mcp: false }),
      busyRanges: virtualField(spy('busyRanges', (shop, args) => [
        { start: `${args.date}T10`, end: `${args.date}T11`, slot: { label: 'am' } },
      ]), {
        type: new GraphQLList(new GraphQLNonNull(RangeType)),
        description: 'Times that confirmed bookings hold on a date.',
        args: { date: { type: new GraphQLNonNull(GraphQLString) }, professionalId: { type: GraphQLID } },
      }),
      openAt: virtualField(spy('openAt', () => true), {
        type: GraphQLBoolean, args: { time: { type: new GraphQLNonNull(GraphQLString) } },
      }, { mcp: 'select' }),
      hiddenRanges: virtualField(spy('hiddenRanges', () => []), {
        type: new GraphQLList(RangeType), args: { date: { type: new GraphQLNonNull(GraphQLString) } },
      }, { mcp: false }),
      greeting: virtualField(spy('greeting', (shop, args) => `hi ${args.locale}`), {
        type: GraphQLString, args: { locale: { type: new GraphQLNonNull(GraphQLString), defaultValue: 'en' } },
      }),
      label: virtualField(spy('label', () => 'label'), { type: GraphQLString, args: { format: { type: GraphQLString } } }),
      // The pattern virtual fields replace: stored, so no tool.
      stored: {
        type: GraphQLString,
        args: { at: { type: new GraphQLNonNull(GraphQLString) } },
        extensions: { readOnly: true },
        resolve: spy('stored', () => 'stored'),
      },
    }),
  });
  const BookingType = new GraphQLObjectType({
    name: 'VfmBooking',
    fields: () => ({
      id: { type: GraphQLID },
      when: { type: GraphQLString },
      shop: { type: ShopType, extensions: { relation: { connectionField: 'shop' } } },
      note: virtualField(spy('note', (booking, args) => `${booking.when}@${args.locale}`), {
        type: GraphQLString, args: { locale: { type: new GraphQLNonNull(GraphQLString) } },
      }),
      fee: virtualField(spy('fee', () => 7), { type: GraphQLInt }),
    }),
  });

  const adapter = createMemoryAdapter();
  const runtime = createRuntime(adapter);
  runtime.connect(null, ShopType, 'vfmShop', 'vfmShops');
  runtime.connect(null, BookingType, 'vfmBooking', 'vfmBookings');
  runtime.addNoEndpointType(AddressType);
  const schema = runtime.createSchema();
  adapter.seed('VfmShop', '1', { name: 'Main', open: 'yes', address: { street: 'Elm' } });
  adapter.seed('VfmShop', '2', { name: 'Closed', open: 'no' });
  adapter.seed('VfmBooking', '3', { when: 'mon', shop: '1' });
  return { schema, adapter, calls };
};

const toolNamed = (tools, name) => tools.find((tool) => tool.name === name);
const nullable = (type) => ({ type: [type, 'null'] });
const VIRTUAL_TOOLS = ['vfmShop_busyRanges', 'vfmShop_openAt', 'vfmBooking_note'];
const BUSY_RANGES_OPERATION = 'query vfmShop_busyRangesOperation($id: ID, $date: String!, $professionalId: ID) {\n'
  + '  vfmShop(id: $id) {\n'
  + '    busyRanges(date: $date, professionalId: $professionalId) { start end slot { label } }\n'
  + '  }\n'
  + '}';
const rangeSchema = (withSlot = true) => ({
  type: 'object',
  properties: {
    start: nullable('string'),
    end: nullable('string'),
    ...(withSlot ? { slot: { type: ['object', 'null'], properties: { label: nullable('string') } } } : {}),
  },
});
const busyRangesOutputSchema = (withSlot = true) => ({
  type: 'object',
  properties: {
    vfmShop: {
      type: ['object', 'null'],
      description: 'A barbershop.',
      properties: {
        busyRanges: {
          type: ['array', 'null'],
          items: rangeSchema(withSlot),
          description: 'Times that confirmed bookings hold on a date.',
        },
      },
    },
  },
});
// The root field line of a generated operation, such as `vfmShop(id: $id) { id name }`.
const selectionOf = (operation) => operation.split('\n')[1].trim();

let warn;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('virtual field tools', () => {
  test('a virtual field with a required argument gets a <byIdQuery>_<field> tool, after every root field tool', () => {
    const { schema } = buildFixture();
    const names = generateMCPTools(schema).tools.map((tool) => tool.name);

    expect(names.slice(-3)).toEqual(VIRTUAL_TOOLS);
    // No tool for mcp: false, a required argument with a default, optional arguments, a stored field
    // with arguments, or a virtual field of a type without a by-ID query.
    expect(names.filter((name) => name.includes('_') && !name.endsWith('_aggregate'))).toEqual(VIRTUAL_TOOLS);
  });

  test('publishes the input schema, operation, annotations and output schema of a virtual field tool', () => {
    const { schema } = buildFixture();
    const { tools, getOperation } = generateMCPTools(schema);

    expect(toolNamed(tools, 'vfmShop_busyRanges')).toEqual({
      name: 'vfmShop_busyRanges',
      title: 'Get VfmShop busyRanges',
      description: 'Times that confirmed bookings hold on a date.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Unique identifier (id) of the record.' },
          date: { type: 'string' },
          professionalId: nullable('string'),
        },
        additionalProperties: false,
        required: ['id', 'date'],
      },
      annotations: { title: 'Get VfmShop busyRanges', openWorldHint: false, readOnlyHint: true },
      kind: 'query',
      outputSchema: busyRangesOutputSchema(),
    });
    expect(getOperation('vfmShop_busyRanges')).toBe(BUSY_RANGES_OPERATION);
    expect(getOperation('vfmBooking_note')).toBe('query vfmBooking_noteOperation($id: ID, $locale: String!) {\n'
      + '  vfmBooking(id: $id) {\n    note(locale: $locale)\n  }\n}');
  });

  test('describes a field without a description, and keeps mcp: \'select\' fields with a required argument', () => {
    const { schema } = buildFixture();
    const tool = toolNamed(generateMCPTools(schema).tools, 'vfmShop_openAt');

    expect(tool.description).toBe('Read the `openAt` field of a single VfmShop by id, passing the field\'s arguments. '
      + 'Returns the VfmShop with only that field, or null when no VfmShop with that id exists or is visible. A barbershop.');
    expect(tool.outputSchema).toEqual({
      type: 'object',
      properties: {
        vfmShop: { type: ['object', 'null'], description: 'A barbershop.', properties: { openAt: nullable('boolean') } },
      },
    });
  });

  test('reads the field through the by-ID query, with its arguments and the call context', async () => {
    const { schema, calls } = buildFixture();
    const context = { user: 'u1' };
    const { callTool } = generateMCPTools(schema, { context });

    const result = await callTool('vfmShop_busyRanges', { id: '1', date: '2026-10-18' });

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      vfmShop: { busyRanges: [{ start: '2026-10-18T10', end: '2026-10-18T11', slot: { label: 'am' } }] },
    });
    expect(calls.busyRanges).toHaveBeenCalledTimes(1);
    const [parent, args, received] = calls.busyRanges.mock.calls[0];
    expect(parent).toMatchObject({ _id: '1', name: 'Main' });
    expect(args).toEqual({ date: '2026-10-18' });
    expect(received).toBe(context);

    await callTool('vfmShop_busyRanges', { id: '1', date: '2026-10-19', professionalId: '5' });
    expect(calls.busyRanges.mock.calls[1][1]).toEqual({ date: '2026-10-19', professionalId: '5' });
    expect(calls.score).not.toHaveBeenCalled();
  });

  test('returns null for a record the get_by_id scope hides, without calling the resolver', async () => {
    const { schema, calls } = buildFixture();
    const { callTool } = generateMCPTools(schema, { context: { onlyOpen: true } });

    expect((await callTool('vfmShop_busyRanges', { id: '2', date: '2026-10-18' })).structuredContent)
      .toEqual({ vfmShop: null });
    expect(calls.busyRanges).not.toHaveBeenCalled();
    expect((await callTool('vfmShop_busyRanges', { id: '1', date: '2026-10-18' })).structuredContent.vfmShop)
      .not.toBeNull();
  });

  test('rejects an argument the tool does not declare, without executing it', async () => {
    const { schema, calls } = buildFixture();
    const { callTool } = generateMCPTools(schema);

    const result = await callTool('vfmShop_busyRanges', { id: '1', date: 'd', pagination: { page: 1, size: 1 } });

    expect(result.isError).toBe(true);
    const [error] = JSON.parse(result.content[0].text).errors;
    expect(error.extensions.code).toBe('MCP_UNKNOWN_ARGUMENT');
    expect(error.message).toContain('Valid arguments: id, date, professionalId.');
    expect(calls.busyRanges).not.toHaveBeenCalled();
  });

  test('publishes the tool through an SDK server whose client validates the result against the output schema', async () => {
    const { schema } = buildFixture();
    const server = await createMCPServer(schema, { context: { onlyOpen: true } });
    const client = new Client({ name: 'virtual-fields-client', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = toolNamed((await client.listTools()).tools, 'vfmShop_busyRanges');
      expect(listed.outputSchema).toEqual(busyRangesOutputSchema());
      expect(listed.annotations.readOnlyHint).toBe(true);

      const found = await client.callTool({ name: 'vfmShop_busyRanges', arguments: { id: '1', date: '2026-10-18' } });
      expect(found.isError).toBe(false);
      expect(found.structuredContent.vfmShop.busyRanges).toHaveLength(1);
      const hidden = await client.callTool({ name: 'vfmShop_busyRanges', arguments: { id: '2', date: '2026-10-18' } });
      expect(hidden.structuredContent).toEqual({ vfmShop: null });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test('sends the virtual field operation to a remote endpoint', async () => {
    const { schema } = buildFixture();
    const data = { vfmShop: { busyRanges: [] } };
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data }) }));
    vi.stubGlobal('fetch', fetchMock);
    const { callTool, getOperation } = generateMCPTools(schema, {
      execution: { mode: 'remote', endpoint: 'http://graphql.test/graphql' },
    });

    const result = await callTool('vfmShop_busyRanges', { id: '1', date: 'd' });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      query: getOperation('vfmShop_busyRanges'), variables: { id: '1', date: 'd' },
    });
    expect(result.structuredContent).toEqual(data);
  });
});

describe('virtual fields in generated selections', () => {
  test('by-ID and mutation tools select every virtual field without required arguments; list tools only mcp: \'select\' ones', () => {
    const { schema } = buildFixture();
    const { getOperation } = generateMCPTools(schema);
    // Below a list position, such as the nested bookings collection, only mcp: 'select' ones: VfmBooking.fee is left out.
    const single = '{ id name open address { street } bookings { id when } score rating stats { visits } summary { visits } nickname greeting label }';

    expect(selectionOf(getOperation('vfmShop'))).toBe(`vfmShop(id: $id) ${single}`);
    expect(selectionOf(getOperation('addvfmShop'))).toBe(`addvfmShop(input: $input) ${single}`);
    expect(getOperation('vfmShops')).toMatch(/\) \{ id name open address \{ street \} bookings \{ id when \} rating stats \{ visits \} \}\n\}$/);
    // Also in the records a list reaches through a reference.
    expect(getOperation('vfmBooking')).toMatch(/\{ id when shop \{ id name open score rating nickname greeting label \} fee \}\n\}$/);
    expect(getOperation('vfmBookings')).toMatch(/\) \{ id when shop \{ id name open rating \} \}\n\}$/);
  });

  test('list tool output schemas mirror the selection, and their inputs have no property for virtual fields', () => {
    const { schema } = buildFixture();
    const { tools } = generateMCPTools(schema);
    const list = toolNamed(tools, 'vfmShops');
    const single = toolNamed(tools, 'vfmShop');

    expect(Object.keys(list.outputSchema.properties.vfmShops.items.properties))
      .toEqual(['id', 'name', 'open', 'address', 'bookings', 'rating', 'stats']);
    expect(Object.keys(list.outputSchema.properties.vfmShops.items.properties.bookings.items.properties))
      .toEqual(['id', 'when']);
    expect(Object.keys(single.outputSchema.properties.vfmShop.properties)).toEqual([
      'id', 'name', 'open', 'address', 'bookings', 'score', 'rating', 'stats', 'summary', 'nickname', 'greeting', 'label',
    ]);
    expect(Object.keys(list.inputSchema.properties))
      .toEqual(['id', 'name', 'open', 'address', 'bookings', 'stored', 'pagination', 'sort', 'AND', 'OR']);
  });

  test('a list tool runs only the resolvers of mcp: \'select\' virtual fields, once per record', async () => {
    const { schema, calls } = buildFixture();
    const result = await generateMCPTools(schema).callTool('vfmShops', {});

    expect(result.structuredContent.vfmShops).toEqual([
      expect.objectContaining({ id: '1', rating: 4.5, stats: { visits: 3 } }),
      expect.objectContaining({ id: '2', rating: 4.5, stats: { visits: 3 } }),
    ]);
    expect(result.structuredContent.vfmShops[0]).not.toHaveProperty('score');
    expect(calls.rating).toHaveBeenCalledTimes(2);
    for (const name of ['score', 'summary', 'nickname', 'greeting', 'label', 'busyRanges', 'fee']) {
      expect(calls[name]).not.toHaveBeenCalled();
    }
  });

  test('a virtual field tool selects its result like a root field: depth from the result, its parent not expanded again', () => {
    const { schema } = buildFixture();
    const depth0 = generateMCPTools(schema, { selectionDepth: 0 });

    expect(depth0.getOperation('vfmShop_busyRanges')).toContain('busyRanges(date: $date, professionalId: $professionalId) { start end }\n');
    expect(toolNamed(depth0.tools, 'vfmShop_busyRanges').outputSchema).toEqual(busyRangesOutputSchema(false));
    expect(selectionOf(depth0.getOperation('vfmShop'))).toBe(
      'vfmShop(id: $id) { id name open score rating nickname greeting label }',
    );
  });
});

describe('virtual fields below a list position', () => {
  // Each item of a list runs the resolvers of the virtual fields selected in it, so every tool selects
  // there only mcp: 'select' ones, as list tools do at every depth.
  const buildNested = () => {
    const calls = { label: vi.fn(() => 'label'), tag: vi.fn(() => 'tag'), total: vi.fn(() => 10), code: vi.fn(() => 'c') };
    const Line = new GraphQLObjectType({
      name: 'VfnLine',
      fields: {
        qty: { type: GraphQLInt },
        total: virtualField(calls.total, { type: GraphQLInt }),
        code: virtualField(calls.code, { type: GraphQLString }, { mcp: 'select' }),
      },
    });
    const Parent = new GraphQLObjectType({
      name: 'VfnParent',
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        main: { type: Line, extensions: { relation: { embedded: true } } },
        lines: { type: new GraphQLList(Line), extensions: { relation: { embedded: true } } },
        children: { type: new GraphQLList(Child), extensions: { relation: { connectionField: 'parent' } } },
      }),
    });
    const Child = new GraphQLObjectType({
      name: 'VfnChild',
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        parent: { type: Parent, extensions: { relation: { connectionField: 'parent' } } },
        label: virtualField(calls.label, { type: new GraphQLNonNull(GraphQLString) }),
        tag: virtualField(calls.tag, { type: GraphQLString }, { mcp: 'select' }),
      }),
    });
    const adapter = createMemoryAdapter();
    const runtime = createRuntime(adapter);
    runtime.connect(null, Parent, 'vfnParent', 'vfnParents');
    runtime.connect(null, Child, 'vfnChild', 'vfnChildren');
    runtime.addNoEndpointType(Line);
    const schema = runtime.createSchema();
    adapter.seed('VfnParent', '1', { name: 'p', main: { qty: 1 }, lines: [{ qty: 2 }, { qty: 3 }] });
    for (const id of ['2', '3', '4']) adapter.seed('VfnChild', id, { name: `c${id}`, parent: '1' });
    return { schema, calls };
  };
  const selection = '{ id name main { qty total code } lines { qty code } children { id name tag } }';

  test('by-ID and mutation tools select only mcp: \'select\' virtual fields inside nested collections and embedded lists', () => {
    const { schema } = buildNested();
    const { getOperation, tools } = generateMCPTools(schema);

    expect(selectionOf(getOperation('vfnParent'))).toBe(`vfnParent(id: $id) ${selection}`);
    for (const name of ['addvfnParent', 'updatevfnParent', 'deletevfnParent']) expect(getOperation(name)).toContain(` ${selection}\n`);
    expect(getOperation('vfnParents')).toMatch(/\) \{ id name main \{ qty code \} lines \{ qty code \} children \{ id name tag \} \}\n\}$/);
    const properties = toolNamed(tools, 'vfnParent').outputSchema.properties.vfnParent.properties;
    expect(Object.keys(properties.main.properties)).toEqual(['qty', 'total', 'code']);
    expect(Object.keys(properties.lines.items.properties)).toEqual(['qty', 'code']);
    expect(Object.keys(properties.children.items.properties)).toEqual(['id', 'name', 'tag']);
    // A single reference is no list position: the parent of a child keeps every virtual field of its embedded value.
    expect(selectionOf(generateMCPTools(schema, { selectionDepth: 2 }).getOperation('vfnChild')))
      .toBe('vfnChild(id: $id) { id name parent { id name main { qty total code } lines { qty code } } label tag }');
  });

  test('a by-ID tool runs the resolvers of the other virtual fields once, not once per item', async () => {
    const { schema, calls } = buildNested();
    const result = await generateMCPTools(schema).callTool('vfnParent', { id: '1' });

    expect(result.structuredContent.vfnParent).toEqual({
      id: '1',
      name: 'p',
      main: { qty: 1, total: 10, code: 'c' },
      lines: [{ qty: 2, code: 'c' }, { qty: 3, code: 'c' }],
      children: ['2', '3', '4'].map((id) => ({ id, name: `c${id}`, tag: 'tag' })),
    });
    expect(calls.label).not.toHaveBeenCalled();
    expect(calls.tag).toHaveBeenCalledTimes(3);
    expect(calls.total).toHaveBeenCalledTimes(1);
    expect(calls.code).toHaveBeenCalledTimes(3);
  });

  test('a virtual field tool applies the same rule to its result: inside a list, only mcp: \'select\' virtual fields', () => {
    const Stats = new GraphQLObjectType({
      name: 'VfnStats',
      fields: { visits: { type: GraphQLInt }, label: virtualField(() => 'l', { type: GraphQLString }) },
    });
    const Range = new GraphQLObjectType({
      name: 'VfnRange',
      fields: {
        start: { type: GraphQLString },
        label: virtualField(() => 'l', { type: GraphQLString }),
        code: virtualField(() => 'c', { type: GraphQLString }, { mcp: 'select' }),
      },
    });
    const query = { q: { type: new GraphQLNonNull(GraphQLString) } };
    const Shop = new GraphQLObjectType({
      name: 'VfnShop',
      fields: {
        id: { type: GraphQLID },
        busyRanges: virtualField(() => [], { type: new GraphQLList(Range), args: query }),
        summary: virtualField(() => ({}), { type: Stats, args: query }),
      },
    });
    const runtime = createRuntime(createMemoryAdapter());
    runtime.connect(null, Shop, 'vfnShop', 'vfnShops');
    const { getOperation, tools } = generateMCPTools(runtime.createSchema());

    expect(getOperation('vfnShop_busyRanges')).toContain('    busyRanges(q: $q) { start code }\n');
    expect(getOperation('vfnShop_summary')).toContain('    summary(q: $q) { visits label }\n');
    const result = (name, field) => toolNamed(tools, name).outputSchema.properties.vfnShop.properties[field];
    expect(Object.keys(result('vfnShop_busyRanges', 'busyRanges').items.properties)).toEqual(['start', 'code']);
    expect(Object.keys(result('vfnShop_summary', 'summary').properties)).toEqual(['visits', 'label']);
  });
});

describe('virtual field tools and generation options', () => {
  test('toolNamePrefix prefixes the tool name; the operation keeps the unprefixed name', () => {
    const { schema } = buildFixture();
    const { tools, getOperation } = generateMCPTools(schema, { toolNamePrefix: 'shop_' });

    expect(tools.slice(-3).map((tool) => tool.name)).toEqual(VIRTUAL_TOOLS.map((name) => `shop_${name}`));
    expect(getOperation('shop_vfmShop_busyRanges')).toBe(BUSY_RANGES_OPERATION);
  });

  test.each([
    [{ include: ['vfmShop_busyRanges'] }, ['vfmShop_busyRanges']],
    [{ include: 'p_vfmBooking_note', toolNamePrefix: 'p_' }, ['p_vfmBooking_note']],
    [{ include: 'query', exclude: ['vfmShop_openAt'] }, ['vfmShop_busyRanges', 'vfmBooking_note']],
    [{ include: ['mutation', 'vfmBooking_note'] }, ['vfmBooking_note']],
    // Filters match tool names, so the by-ID tool's name keeps only that tool out.
    [{ exclude: ['vfmShop'] }, VIRTUAL_TOOLS],
    [{ includeTypes: ['VfmBooking'] }, ['vfmBooking_note']],
    [{ excludeTypes: 'VfmShop' }, ['vfmBooking_note']],
  ])('include/exclude and includeTypes/excludeTypes select virtual field tools (%j)', (options, expected) => {
    const { schema } = buildFixture();
    const names = generateMCPTools(schema, options).tools.map((tool) => tool.name);

    expect(names.filter((name) => /_(busyRanges|openAt|note)$/.test(name))).toEqual(expected);
  });

  test('toolOverrides apply by published name, which wins, or by unprefixed name', () => {
    const { schema } = buildFixture();
    const { tools, getOperation } = generateMCPTools(schema, {
      toolNamePrefix: 'p_',
      toolOverrides: {
        vfmShop_busyRanges: { title: 'Ignored', description: 'Ignored' },
        p_vfmShop_busyRanges: { title: 'Busy times', annotations: { idempotentHint: true }, selectionDepth: 0 },
        vfmBooking_note: { description: 'The booking note.' },
      },
    });
    const busy = toolNamed(tools, 'p_vfmShop_busyRanges');

    expect(busy.title).toBe('Busy times');
    expect(busy.description).toBe('Times that confirmed bookings hold on a date.');
    expect(busy.annotations).toEqual({
      title: 'Busy times', openWorldHint: false, readOnlyHint: true, idempotentHint: true,
    });
    expect(busy.outputSchema).toEqual(busyRangesOutputSchema(false));
    expect(getOperation('p_vfmShop_busyRanges')).toContain('{ start end }\n');
    expect(toolNamed(tools, 'p_vfmBooking_note').description).toBe('The booking note.');

    // An explicit selection replaces the field's selection set and omits the output schema.
    const selected = generateMCPTools(schema, { toolOverrides: { vfmShop_busyRanges: { selection: 'start' } } });
    expect(selected.getOperation('vfmShop_busyRanges')).toContain('    busyRanges(date: $date, professionalId: $professionalId) { start }\n');
    expect(toolNamed(selected.tools, 'vfmShop_busyRanges')).not.toHaveProperty('outputSchema');
  });
});

describe('virtual field tools and limits', () => {
  test('limits apply to a pagination argument of the field, as to a root field\'s', async () => {
    const PageType = new GraphQLInputObjectType({
      name: 'VfmPage',
      fields: { page: { type: new GraphQLNonNull(GraphQLInt) }, size: { type: new GraphQLNonNull(GraphQLInt) } },
    });
    const resolve = vi.fn((log, args) => [`${args.kind}:${args.pagination?.size}`]);
    const LogType = new GraphQLObjectType({
      name: 'VfmLog',
      fields: {
        id: { type: GraphQLID },
        entries: virtualField(resolve, {
          type: new GraphQLList(GraphQLString),
          args: { kind: { type: new GraphQLNonNull(GraphQLString) }, pagination: { type: PageType } },
        }),
      },
    });
    const adapter = createMemoryAdapter();
    const runtime = createRuntime(adapter);
    runtime.connect(null, LogType, 'vfmLog', 'vfmLogs');
    const schema = runtime.createSchema();
    adapter.seed('VfmLog', '1', {});
    const { callTool } = generateMCPTools(schema, { limits: { maxPageSize: 10, defaultPagination: { page: 1, size: 5 } } });

    expect((await callTool('vfmLog_entries', { id: '1', kind: 'a' })).structuredContent)
      .toEqual({ vfmLog: { entries: ['a:5'] } });
    const tooLarge = await callTool('vfmLog_entries', { id: '1', kind: 'a', pagination: { page: 1, size: 50 } });
    expect(JSON.parse(tooLarge.content[0].text).errors[0].extensions.code).toBe('MCP_PAGE_SIZE_EXCEEDED');
    expect(resolve).toHaveBeenCalledTimes(1);
    // Valid for the list tool's QLPagination, not for the field's VfmPage.
    expect(() => generateMCPTools(schema, { limits: { defaultPagination: { page: 1, size: 5, count: true } } }))
      .toThrow('limits.defaultPagination is not a valid VfmPage for the pagination argument of tool "vfmLog_entries"');
  });
});

describe('virtual field tool errors and collisions', () => {
  const clashSchema = (virtual) => {
    const ClashType = new GraphQLObjectType({
      name: 'VfmClash',
      fields: {
        id: { type: GraphQLID },
        lookup: virtualField(() => 'x', { type: GraphQLString, args: { id: { type: new GraphQLNonNull(GraphQLID) } } }, virtual),
      },
    });
    const runtime = createRuntime(createMemoryAdapter());
    runtime.connect(null, ClashType, 'vfmClash', 'vfmClashes');
    return runtime.createSchema();
  };

  test('a field argument named id is MCP_INVALID_OPTIONS, unless the field has no tool or the tool is excluded', () => {
    expect(() => generateMCPTools(clashSchema(true))).toThrow(expect.objectContaining({
      message: 'The virtual field VfmClash.lookup has an argument named id, which its MCP tool "vfmClash_lookup" takes '
        + 'for the VfmClash id. Rename the argument, set extensions.virtual.mcp to false, or exclude the tool.',
      extensions: expect.objectContaining({ code: 'MCP_INVALID_OPTIONS' }),
    }));
    expect(() => generateMCPTools(clashSchema({ mcp: 'select' }), { toolNamePrefix: 'p_' }))
      .toThrow('its MCP tool "p_vfmClash_lookup"');
    expect(generateMCPTools(clashSchema({ mcp: false })).tools.map((tool) => tool.name)).not.toContain('vfmClash_lookup');
    expect(generateMCPTools(clashSchema(true), { exclude: 'vfmClash_lookup' }).tools.length).toBeGreaterThan(0);
  });

  // MCP reads extensions.virtual on any schema, so a hand-built one shows name collisions directly.
  const virtualWithArg = (value) => ({
    type: GraphQLString,
    args: { at: { type: new GraphQLNonNull(GraphQLString) } },
    extensions: { virtual: true },
    resolve: () => value,
  });
  const record = (name, fields) => new GraphQLObjectType({ name, fields: { id: { type: GraphQLID }, ...fields } });

  test('a name collision skips the virtual field tool with a warning, so root fields and earlier tools win', async () => {
    const Shop = record('DupShop', { busy: virtualWithArg('virtual') });
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          shop: { type: Shop, args: { id: { type: GraphQLID } }, resolve: () => ({ id: '1' }) },
          shop_busy: { type: GraphQLString, resolve: () => 'root' },
          a_b: { type: record('DupAB', { c: virtualWithArg('a_b.c') }), args: { id: { type: GraphQLID } }, resolve: () => ({}) },
          a: { type: record('DupA', { b_c: virtualWithArg('a.b_c') }), args: { id: { type: GraphQLID } }, resolve: () => ({}) },
        },
      }),
    });

    const { tools, callTool } = generateMCPTools(schema);

    expect(tools.map((tool) => tool.name)).toEqual(['shop', 'shop_busy', 'a_b', 'a', 'a_b_c']);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      '[simfinity-mcp] Duplicate tool name "shop_busy": the tool of virtual field "DupShop.busy" collides with an existing '
        + 'query tool and is skipped — calls to "shop_busy" execute that query. Rename one of the fields, set '
        + 'extensions.virtual.mcp to false or use include/exclude to disambiguate.',
      '[simfinity-mcp] Duplicate tool name "a_b_c": the tool of virtual field "DupA.b_c" collides with an existing '
        + 'query tool and is skipped — calls to "a_b_c" execute that query. Rename one of the fields, set '
        + 'extensions.virtual.mcp to false or use include/exclude to disambiguate.',
    ]);
    expect((await callTool('shop_busy')).structuredContent).toEqual({ shop_busy: 'root' });
    expect((await callTool('a_b_c', { id: '1', at: 'x' })).structuredContent).toEqual({ a_b: { c: 'a_b.c' } });
  });

  test('a field argument named id does not fail setup when the tool is skipped as a duplicate', () => {
    const Shop = record('RbShop', {
      busy: {
        type: GraphQLString, args: { id: { type: new GraphQLNonNull(GraphQLID) } }, extensions: { virtual: true }, resolve: () => 'v',
      },
    });
    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          shop: { type: Shop, args: { id: { type: GraphQLID } }, resolve: () => ({ id: '1' }) },
          shop_busy: { type: GraphQLString, resolve: () => 'root' },
        },
      }),
    });

    expect(generateMCPTools(schema).tools.map((tool) => tool.name)).toEqual(['shop', 'shop_busy']);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      '[simfinity-mcp] Duplicate tool name "shop_busy": the tool of virtual field "RbShop.busy" collides with an existing '
        + 'query tool and is skipped — calls to "shop_busy" execute that query. Rename one of the fields, set '
        + 'extensions.virtual.mcp to false or use include/exclude to disambiguate.',
    ]);
  });

  test('only a by-ID query, whose only argument is id, gets virtual field tools; an over-long name is MCP_INVALID_TOOL_NAME', () => {
    const Shop = record('ByIdShop', { busy: virtualWithArg('v') });
    const query = (fields) => new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields }) });
    const others = query({
      shopByCode: { type: Shop, args: { code: { type: new GraphQLNonNull(GraphQLString) } } },
      shopWithLocale: { type: Shop, args: { id: { type: GraphQLID }, locale: { type: GraphQLString } } },
      shops: { type: new GraphQLList(Shop), args: { id: { type: GraphQLID }, pagination: { type: GraphQLInt } } },
      shop: { type: Shop, args: { id: { type: GraphQLID } } },
    });
    expect(generateMCPTools(others).tools.map((tool) => tool.name)).toEqual(['shopByCode', 'shopWithLocale', 'shops', 'shop', 'shop_busy']);

    const long = query({ ['s'.repeat(64)]: { type: record('LongShop', { ['b'.repeat(64)]: virtualWithArg('v') }), args: { id: { type: GraphQLID } } } });
    expect(() => generateMCPTools(long)).toThrow(expect.objectContaining({
      message: `Generated MCP tool name "${'s'.repeat(64)}_${'b'.repeat(64)}" is invalid (allowed: letters, digits, underscore, hyphen; max 128 chars)`,
      extensions: expect.objectContaining({ code: 'MCP_INVALID_TOOL_NAME' }),
    }));
  });
});
