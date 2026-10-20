import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  GraphQLEnumType,
  GraphQLFloat,
  GraphQLID,
  GraphQLInt,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLString,
  GraphQLUnionType,
  graphql,
} from 'graphql';
import pg from 'pg';
import { createSQL } from '../../packages/sql/src/index.js';
import { createPostgres, describeDatabase, postgresPlugin } from '../../packages/postgres/src/index.js';

// Virtual fields (#109) on PostgreSQL: fields with their own resolver, declared with `extensions.virtual`,
// that get no storage of any kind, and the SCHEMA_MISMATCH a database reports when a field it stored
// becomes virtual.

const uri = process.env.SIMFINITY_POSTGRES_URI;
const q = (name) => `"${name.replaceAll('"', '""')}"`;
const embedded = { relation: { embedded: true } };
const reference = (connectionField) => ({ relation: { embedded: false, ...(connectionField ? { connectionField } : {}) } });
const UPGRADE_NOTES = 'See the upgrade notes at https://simtlix.github.io/simfinity.js/resources/compatibility.html';
// Enough of a pg.Pool to describe a schema; nothing connects.
const offlinePool = { connect: () => { throw new Error('not connected'); }, query: () => { throw new Error('not connected'); } };

const VIRTUAL_NAMES = [
  'vScore', 'vNickname', 'vKeywords', 'vLevel', 'vOwnerId', 'vStats', 'vBusyRanges', 'vPayload', 'vNamed', 'vTagged',
  'vTopBooking', 'vRecentBookings', 'vFormatted', 'vGeoText', 'vSummary',
];

/**
 * A shop with a virtual field of each result kind: a non-null scalar, a scalar, a scalar list, an enum, an ID,
 * an object, an object list with arguments, a custom scalar without baseScalarType, an interface, a union and
 * registered entities. Members of embedded values are virtual too: of a JSON value (VfpAddress and the VfpGeo
 * inside it) and of a value with its own table (VfpLine, which has a reference). With `virtual: false` the same
 * types have none of these fields, and with a list of names only those.
 */
const buildShop = ({ virtual = true, calls = [], scope } = {}) => {
  const state = { api: null };
  const only = (fields) => Object.fromEntries(Object.entries(fields).filter(([name]) => (Array.isArray(virtual) ? virtual.includes(name) : virtual)));
  const field = (name, type, resolve, args) => ({
    type,
    ...(args ? { args } : {}),
    extensions: { virtual: true },
    resolve: (parent, values, context) => {
      calls.push({ field: name, parent, args: values });
      return resolve(parent, values, context);
    },
  });
  // Records of a registered type that a virtual field loads natively.
  const bookingsOf = async (shop) => (await state.api.getModel(Booking).find({}))
    .filter((booking) => booking.shop === shop.id).sort((a, b) => a.label.localeCompare(b.label));

  const Level = new GraphQLEnumType({ name: 'VfpLevel', values: { LOW: { value: 'low' }, HIGH: { value: 'high' } } });
  const Json = new GraphQLScalarType({ name: 'VfpJSON', serialize: (value) => value });
  const Named = new GraphQLInterfaceType({ name: 'VfpNamed', fields: { label: { type: GraphQLString } } });
  const Tag = new GraphQLObjectType({
    name: 'VfpTag', interfaces: [Named], fields: { label: { type: GraphQLString } }, isTypeOf: (value) => typeof value?.label === 'string',
  });
  const TagUnion = new GraphQLUnionType({ name: 'VfpTagUnion', types: [Tag], resolveType: () => 'VfpTag' });
  const Stats = new GraphQLObjectType({ name: 'VfpStats', fields: { visits: { type: GraphQLInt } } });
  const Range = new GraphQLObjectType({ name: 'VfpRange', fields: { start: { type: GraphQLString }, end: { type: GraphQLString } } });
  const Geo = new GraphQLObjectType({
    name: 'VfpGeo',
    fields: () => ({
      lat: { type: GraphQLFloat },
      ...only({ vGeoText: field('vGeoText', new GraphQLNonNull(GraphQLString), (geo) => `lat ${geo.lat}`) }),
    }),
  });
  const Address = new GraphQLObjectType({
    name: 'VfpAddress',
    fields: () => ({
      street: { type: GraphQLString },
      geo: { type: Geo, extensions: embedded },
      ...only({ vFormatted: field('vFormatted', new GraphQLNonNull(GraphQLString), (address) => `${address.street}, formatted`) }),
    }),
  });
  const Line = new GraphQLObjectType({
    name: 'VfpLine',
    fields: () => ({
      qty: { type: GraphQLInt },
      booking: { type: Booking, extensions: reference() },
      ...only({ vSummary: field('vSummary', new GraphQLNonNull(GraphQLString), (line) => `${line.qty} x`) }),
    }),
  });
  const Shop = new GraphQLObjectType({
    name: 'VfpShop',
    ...(scope ? { extensions: { scope } } : {}),
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: new GraphQLNonNull(GraphQLString) },
      address: { type: Address, extensions: embedded },
      lines: { type: new GraphQLList(Line), extensions: embedded },
      bookings: { type: new GraphQLList(Booking), extensions: reference('shop') },
      ...only({
        vScore: field('vScore', new GraphQLNonNull(GraphQLInt), (shop) => shop.name.length),
        vNickname: field('vNickname', GraphQLString, (shop) => `${shop.name}!`),
        vKeywords: field('vKeywords', new GraphQLList(new GraphQLNonNull(GraphQLString)), (shop) => shop.name.split(' ')),
        vLevel: field('vLevel', Level, () => 'high'),
        vOwnerId: field('vOwnerId', GraphQLID, (shop) => shop.id),
        vStats: field('vStats', Stats, () => ({ visits: 3 })),
        vBusyRanges: field('vBusyRanges', new GraphQLList(new GraphQLNonNull(Range)), (shop, { date }) => [{ start: `${date}T10`, end: `${date}T11` }], {
          date: { type: new GraphQLNonNull(GraphQLString) },
        }),
        vPayload: field('vPayload', Json, (shop) => ({ name: shop.name, tags: [1, 2] })),
        vNamed: field('vNamed', Named, (shop) => ({ label: shop.name })),
        vTagged: field('vTagged', TagUnion, () => ({ label: 'tagged' })),
        vTopBooking: field('vTopBooking', Booking, async (shop) => (await bookingsOf(shop))[0] ?? null),
        vRecentBookings: field('vRecentBookings', new GraphQLList(Booking), bookingsOf),
      }),
    }),
  });
  const Booking = new GraphQLObjectType({
    name: 'VfpBooking',
    fields: () => ({
      id: { type: GraphQLID },
      label: { type: GraphQLString },
      shop: { type: Shop, extensions: reference('shop') },
    }),
  });
  const register = (api) => {
    state.api = api;
    api.connect(null, Shop, 'vfpshop', 'vfpshops');
    api.connect(null, Booking, 'vfpbooking', 'vfpbookings');
    for (const type of [Address, Geo, Line]) api.addNoEndpointType(type);
    return api.createSchema();
  };
  return { Shop, Booking, Address, Line, calls, register };
};

// Columns of a table in the order PostgreSQL holds them.
const columnsOf = async (pool, schema, table) => (await pool.query(`SELECT a.attname AS name FROM pg_attribute a
  WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [`${q(schema)}.${q(table)}`])).rows.map((row) => row.name);
// Every name of a table, column, constraint, index, function or trigger in a schema.
const catalogNames = async (pool, schema) => (await pool.query(`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1
  UNION ALL SELECT a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND a.attnum > 0
  UNION ALL SELECT co.conname FROM pg_constraint co JOIN pg_namespace n ON n.oid = co.connamespace WHERE n.nspname = $1
  UNION ALL SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1
  UNION ALL SELECT t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1`, [schema])).rows.map((row) => row.name);

describe('PostgreSQL storage description of virtual fields', () => {
  const runtime = (virtual) => {
    const api = createPostgres({ pool: offlinePool, schema: 'vfp' });
    const fixture = buildShop({ virtual });
    fixture.register(api);
    return api;
  };

  it('describes, compiles and plans nothing for virtual fields of any result kind', () => {
    const withVirtual = runtime(true);
    const withoutVirtual = runtime(false);
    const description = withVirtual.describeDatabase();
    expect(description).toEqual(withoutVirtual.describeDatabase());
    expect(withVirtual.compileDatabaseSchema()).toEqual(withoutVirtual.compileDatabaseSchema());
    expect(describeDatabase(withVirtual.getRegistrations(), { schema: 'vfp' })).toEqual(description);
    const text = `${JSON.stringify(description)}\n${withVirtual.compileDatabaseSchema().join('\n')}`;
    for (const name of VIRTUAL_NAMES) expect(text).not.toContain(name);
    // The stored members around them keep their storage.
    expect(description.tables.map((table) => [table.name, table.columns.map((column) => column.name)])).toEqual([
      ['VfpBooking', ['id', 'label', 'shop']],
      ['VfpShop', ['id', 'name', 'address', '__field__address__present', '__lines_state']],
      ['VfpShop__guard', ['__owner_id', 'version']],
      ['VfpShop__lines', ['__id', '__owner_id', '__position', '__item_present', 'qty', '__field__qty__present', 'booking', '__field__booking__present']],
    ]);
    expect(description.functions.map((fn) => fn.name).filter((name) => name.endsWith('json_valid'))).toEqual([
      'VfpShop__address__street__json_valid', 'VfpShop__address__geo__lat__json_valid', 'VfpShop__address__geo__json_valid', 'VfpShop__address__json_valid',
    ]);
  });

  it.each([
    ['non-null scalar', 'vScore'], ['scalar', 'vNickname'], ['scalar list', 'vKeywords'], ['enum', 'vLevel'], ['ID', 'vOwnerId'],
    ['object', 'vStats'], ['object list with arguments', 'vBusyRanges'], ['custom scalar without baseScalarType', 'vPayload'],
    ['interface', 'vNamed'], ['union', 'vTagged'], ['registered entity', 'vTopBooking'], ['list of a registered entity', 'vRecentBookings'],
    ['member of a JSON value', 'vFormatted'], ['member of a nested JSON value', 'vGeoText'], ['member of a value with its own table', 'vSummary'],
  ])('describes and compiles nothing for a virtual %s', (kind, name) => {
    const one = runtime([name]);
    const none = runtime(false);
    expect(one.describeDatabase()).toEqual(none.describeDatabase());
    expect(one.compileDatabaseSchema()).toEqual(none.compileDatabaseSchema());
  });

  it('passes the plugin where each virtual field is, and keeps its three arguments without virtual fields', async () => {
    const initialize = async (virtual, options) => {
      const plugin = postgresPlugin({ pool: offlinePool, schema: 'vfp' });
      plugin.initialize = vi.fn(async () => ({ mode: 'validate', created: [] }));
      const api = createSQL({ plugin });
      buildShop({ virtual }).register(api);
      await api.initializeDatabase(options);
      return { api, calls: plugin.initialize.mock.calls };
    };
    const plain = await initialize(false);
    expect(plain.calls).toHaveLength(1);
    expect(plain.calls[0]).toHaveLength(3);
    const { api, calls } = await initialize(true, { mode: 'validate' });
    expect(calls).toHaveLength(1);
    const [configuration, description, options, context] = calls[0];
    expect(configuration).toMatchObject({ schema: 'vfp' });
    expect(description).toEqual(api.describeDatabase());
    expect(options).toEqual({ mode: 'validate' });
    const shop = (name) => ({ table: 'VfpShop', path: [], field: `VfpShop.${name}`, name });
    expect(context).toEqual({
      virtualFields: [
        ...['vScore', 'vNickname', 'vKeywords', 'vLevel', 'vOwnerId', 'vStats', 'vBusyRanges', 'vPayload', 'vNamed', 'vTagged', 'vTopBooking', 'vRecentBookings'].map(shop),
        { table: 'VfpShop', path: ['address'], field: 'VfpAddress.vFormatted', name: 'vFormatted' },
        { table: 'VfpShop', path: ['address', 'geo'], field: 'VfpGeo.vGeoText', name: 'vGeoText' },
        { table: 'VfpShop__lines', path: [], field: 'VfpLine.vSummary', name: 'vSummary' },
      ],
    });
  });
});

describe.skipIf(!uri)('PostgreSQL virtual fields', () => {
  let pool; let shared;
  const namespace = `vfp_${randomUUID().replaceAll('-', '')}`;
  const namespaces = [namespace];
  const t = (name) => `${q(namespace)}.${q(name)}`;
  // The shared runtime, built and initialized on first use, so that each test reports a schema that cannot be built.
  const setup = async () => {
    if (!shared) {
      const api = createPostgres({ pool, schema: namespace });
      const fixture = buildShop();
      const schema = fixture.register(api);
      const initialized = await api.initializeDatabase();
      const execute = (source, variableValues, contextValue = {}) => graphql({ schema, source, variableValues, contextValue });
      shared = { api, fixture, initialized, execute };
    }
    return shared;
  };
  beforeAll(() => { pool = new pg.Pool({ connectionString: uri, max: 4 }); });
  afterAll(async () => {
    if (!pool) return;
    for (const name of namespaces) await pool.query(`DROP SCHEMA IF EXISTS ${q(name)} CASCADE`);
    await pool.end();
  });

  it('creates a database without storage for virtual fields, which then validates in both modes', async () => {
    const { api, initialized: result } = await setup();
    expect(result.mode).toBe('create');
    expect(result.created).toContain(`table:${namespace}.VfpShop__lines`);
    expect(await api.initializeDatabase({ mode: 'validate' })).toEqual({ mode: 'validate', created: [] });
    expect(await api.initializeDatabase()).toEqual({ mode: 'create', created: [] });
    const names = await catalogNames(pool, namespace);
    expect(names).toContain('VfpShop__address__geo__json_valid');
    for (const name of VIRTUAL_NAMES) expect(names.filter((item) => item.includes(name))).toEqual([]);
    expect(await columnsOf(pool, namespace, 'VfpShop')).toEqual(['id', 'name', 'address', '__field__address__present', '__lines_state']);
    expect(await columnsOf(pool, namespace, 'VfpShop__lines'))
      .toEqual(['__id', '__owner_id', '__position', '__item_present', 'qty', '__field__qty__present', 'booking', '__field__booking__present']);
  });

  it('stores nothing for virtual fields, non-null ones included, on generated and native creates and updates', async () => {
    const { api, fixture, execute } = await setup();
    const booking = await api.getModel(fixture.Booking).create({ label: 'b1' });
    fixture.calls.length = 0;
    const selection = 'id name vScore vNickname vKeywords vLevel vOwnerId vStats { visits } vBusyRanges(date: "2026-10-18") { start end } vPayload '
      + 'vNamed { label } vTagged { ... on VfpTag { label } } address { street vFormatted geo { lat vGeoText } } lines { qty vSummary booking { label } }';
    const added = await execute(`mutation($input: VfpShopInput!) { addvfpshop(input: $input) { ${selection} } }`, {
      input: { name: 'Main shop', address: { street: 'Main 1', geo: { lat: 1.5 } }, lines: [{ qty: 2, booking: { id: booking.id } }] },
    });
    expect(added.errors).toBeUndefined();
    const { id } = added.data.addvfpshop;
    expect(added.data.addvfpshop).toEqual({
      id, name: 'Main shop', vScore: 9, vNickname: 'Main shop!', vKeywords: ['Main', 'shop'], vLevel: 'HIGH', vOwnerId: id,
      vStats: { visits: 3 }, vBusyRanges: [{ start: '2026-10-18T10', end: '2026-10-18T11' }], vPayload: { name: 'Main shop', tags: [1, 2] },
      vNamed: { label: 'Main shop' }, vTagged: { label: 'tagged' },
      address: { street: 'Main 1', vFormatted: 'Main 1, formatted', geo: { lat: 1.5, vGeoText: 'lat 1.5' } },
      lines: [{ qty: 2, vSummary: '2 x', booking: { label: 'b1' } }],
    });
    // Resolvers receive the hydrated records.
    const call = (name) => fixture.calls.find((item) => item.field === name);
    expect(call('vScore').parent).toEqual({ id, _id: id, name: 'Main shop', address: { street: 'Main 1', geo: { lat: 1.5 } }, lines: [{ qty: 2, booking: booking.id }] });
    expect(call('vBusyRanges').args).toEqual({ date: '2026-10-18' });
    expect(call('vFormatted').parent).toEqual({ street: 'Main 1', geo: { lat: 1.5 } });
    expect(call('vGeoText').parent).toEqual({ lat: 1.5 });
    expect(call('vSummary').parent).toEqual({ qty: 2, booking: booking.id });
    const shopRow = async (value) => (await pool.query(`SELECT * FROM ${t('VfpShop')} WHERE id = $1`, [value])).rows;
    const lineRows = async (value) => (await pool.query(`SELECT * FROM ${t('VfpShop__lines')} WHERE __owner_id = $1 ORDER BY __position`, [value])).rows;
    expect(await shopRow(id)).toEqual([{ id, name: 'Main shop', address: { street: 'Main 1', geo: { lat: 1.5 } }, __field__address__present: true, __lines_state: 'present' }]);
    expect(await lineRows(id)).toEqual([{
      __id: expect.any(String), __owner_id: id, __position: 0, __item_present: true, qty: 2, __field__qty__present: true, booking: booking.id, __field__booking__present: true,
    }]);

    const updated = await execute('mutation($input: VfpShopInputForUpdate!) { updatevfpshop(input: $input) { vScore vNickname address { street vFormatted geo { vGeoText } } lines { vSummary } } }', {
      input: { id, name: 'Second', address: { street: 'Main 2' } },
    });
    expect(updated).toEqual({ data: { updatevfpshop: {
      vScore: 6, vNickname: 'Second!', address: { street: 'Main 2', vFormatted: 'Main 2, formatted', geo: { vGeoText: 'lat 1.5' } }, lines: [{ vSummary: '2 x' }],
    } } });
    expect(await shopRow(id)).toEqual([{ id, name: 'Second', address: { street: 'Main 2', geo: { lat: 1.5 } }, __field__address__present: true, __lines_state: 'present' }]);
    // Generated inputs have no virtual fields.
    const rejected = await execute('mutation { addvfpshop(input: { name: "Rejected", vScore: 1 }) { id } }');
    expect(rejected.errors[0].message).toContain('"vScore" is not defined by type "VfpShopInput"');

    // Native writes drop values given for virtual fields.
    const model = api.getModel(fixture.Shop);
    const native = await model.create({
      name: 'Native', vScore: 5, vNickname: 'n', address: { street: 'N 1', vFormatted: 'x', geo: { lat: 2, vGeoText: 'y' } }, lines: [{ qty: 1, vSummary: 'z' }],
    });
    expect(native).toEqual({ id: native.id, _id: native.id, name: 'Native', address: { street: 'N 1', geo: { lat: 2 } }, lines: [{ qty: 1 }] });
    expect(await model.update(native.id, { name: 'Native 2', vScore: 6, $unset: { vNickname: true } }))
      .toEqual({ id: native.id, _id: native.id, name: 'Native 2', address: { street: 'N 1', geo: { lat: 2 } }, lines: [{ qty: 1 }] });
    expect(await shopRow(native.id)).toEqual([{
      id: native.id, name: 'Native 2', address: { street: 'N 1', geo: { lat: 2 } }, __field__address__present: true, __lines_state: 'present',
    }]);
    expect(await lineRows(native.id)).toEqual([{
      __id: expect.any(String), __owner_id: native.id, __position: 0, __item_present: true, qty: 1, __field__qty__present: true, booking: null, __field__booking__present: false,
    }]);
  });

  it('resolves virtual fields in by-ID, list, reference and collection reads', async () => {
    const { execute } = await setup();
    const shop = (await execute('mutation { addvfpshop(input: { name: "Read shop" }) { id } }')).data.addvfpshop.id;
    for (const label of ['r2', 'r1']) {
      const result = await execute('mutation($input: VfpBookingInput!) { addvfpbooking(input: $input) { id } }', { input: { label, shop: { id: shop } } });
      expect(result.errors).toBeUndefined();
    }
    const byId = await execute('query($id: ID) { vfpshop(id: $id) { vScore vTopBooking { label shop { name vNickname } } vRecentBookings { label } bookings { label shop { vScore } } } }', { id: shop });
    expect(byId.errors).toBeUndefined();
    expect(byId.data.vfpshop).toEqual({
      vScore: 9,
      vTopBooking: { label: 'r1', shop: { name: 'Read shop', vNickname: 'Read shop!' } },
      vRecentBookings: [{ label: 'r1' }, { label: 'r2' }],
      bookings: expect.arrayContaining([{ label: 'r1', shop: { vScore: 9 } }, { label: 'r2', shop: { vScore: 9 } }]),
    });
    expect(byId.data.vfpshop.bookings).toHaveLength(2);
    expect(await execute('{ vfpshops(name: { operator: EQ, value: "Read shop" }) { vScore vBusyRanges(date: "d") { start } } }'))
      .toEqual({ data: { vfpshops: [{ vScore: 9, vBusyRanges: [{ start: 'dT10' }] }] } });
    expect(await execute('{ vfpbookings(label: { operator: EQ, value: "r1" }) { shop { vScore vKeywords } } }'))
      .toEqual({ data: { vfpbookings: [{ shop: { vScore: 9, vKeywords: ['Read', 'shop'] } }] } });
  });

  it('compiles no statement for a path through a virtual field', async () => {
    await setup();
    const statements = [];
    const recording = {
      query: (text, values) => { statements.push(text); return pool.query(text, values); },
      async connect() {
        const client = await pool.connect();
        return { query: (text, values) => { statements.push(text); return client.query(text, values); }, release: (error) => client.release(error) };
      },
    };
    const runtime = async (scope) => {
      const instance = createPostgres({ pool: recording, schema: namespace });
      const types = buildShop({ scope });
      const built = types.register(instance);
      await instance.initializeDatabase({ mode: 'validate' });
      return { instance, types, run: (source) => graphql({ schema: built, source, contextValue: {} }) };
    };
    const plain = await runtime();
    const scoped = await runtime({ find: ({ args }) => { args.vScore = { operator: 'EQ', value: 1 }; } });
    statements.length = 0;
    const clientPath = { code: 'FORBIDDEN_FILTER_PATH', message: 'Query path vScore uses the virtual field VfpShop.vScore, which is not stored' };
    const errorOf = (result) => ({ code: result.errors?.[0].extensions?.code, message: result.errors?.[0].message });
    expect(errorOf(await plain.run('{ vfpshops(sort: { terms: [{ field: "vScore", order: ASC }] }) { id } }'))).toEqual(clientPath);
    expect(errorOf(await plain.run('{ vfpshops(AND: [{ conditions: [{ field: "vScore", operator: EQ, value: 1 }] }]) { id } }'))).toEqual(clientPath);
    expect(errorOf(await plain.run('{ vfpshops_aggregate(aggregation: { groupId: "vScore", facts: [{ operation: COUNT, factName: "n", path: "id" }] }) { groupId } }')))
      .toEqual(clientPath);
    expect((await plain.run('{ vfpshops(vScore: { operator: EQ, value: 1 }) { id } }')).errors[0].message).toContain('Unknown argument "vScore" on field "RootQueryType.vfpshops".');
    await expect(plain.instance.getModel(plain.types.Shop).find({ vScore: { operator: 'EQ', value: 1 } }))
      .rejects.toMatchObject({ extensions: { code: 'INVALID_FILTER_FIELD' } });
    expect(errorOf(await scoped.run('{ vfpshops { id } }')))
      .toEqual({ code: 'INVALID_MODEL', message: 'Query path vScore, added by middleware or a scope, uses the virtual field VfpShop.vScore, which is not stored' });
    expect(statements.filter((text) => text.includes('VfpShop'))).toEqual([]);
  });

  it('validates a database created before its virtual fields were added, and reads its rows', async () => {
    const before = `vfp_before_${randomUUID().replaceAll('-', '')}`;
    namespaces.push(before);
    const earlier = buildShop({ virtual: false });
    const old = createPostgres({ pool, schema: before });
    earlier.register(old);
    await old.initializeDatabase();
    const record = await old.getModel(earlier.Shop).create({ name: 'Old shop', address: { street: 'Old 1', geo: { lat: 3 } }, lines: [{ qty: 7 }] });
    const current = createPostgres({ pool, schema: before });
    const currentSchema = buildShop().register(current);
    expect(await current.initializeDatabase({ mode: 'validate' })).toEqual({ mode: 'validate', created: [] });
    expect(await current.initializeDatabase()).toEqual({ mode: 'create', created: [] });
    expect(await graphql({
      schema: currentSchema,
      source: 'query($id: ID) { vfpshop(id: $id) { vScore address { vFormatted geo { vGeoText } } lines { vSummary } } }',
      variableValues: { id: record.id },
      contextValue: {},
    })).toEqual({ data: { vfpshop: { vScore: 8, address: { vFormatted: 'Old 1, formatted', geo: { vGeoText: 'lat 3' } }, lines: [{ vSummary: '7 x' }] } } });
  });
});

/**
 * Fields that are stored, or with `virtual: true` the same fields declared virtual: a non-null scalar of a
 * shop, a list of JSON objects (as Barber's busyRanges was), a member of a JSON value, a member of a value with
 * its own table, a list with its own table on an archive that owns nothing else, and a unique list, whose keys
 * a booking maintains with refresh triggers. With a list of names, only those fields are virtual.
 */
const buildOptIn = (virtual) => {
  const field = (name, stored, type, resolve, args) => ((Array.isArray(virtual) ? virtual.includes(name) : virtual)
    ? { type, ...(args ? { args } : {}), extensions: { virtual: true }, resolve }
    : stored);
  const Range = new GraphQLObjectType({ name: 'VfoRange', fields: { start: { type: GraphQLString } } });
  const Address = new GraphQLObjectType({
    name: 'VfoAddress',
    fields: () => ({
      street: { type: GraphQLString },
      formatted: field('formatted', { type: GraphQLString }, new GraphQLNonNull(GraphQLString), (address) => `${address.street}, formatted`),
    }),
  });
  const Line = new GraphQLObjectType({
    name: 'VfoLine',
    fields: () => ({
      qty: { type: GraphQLInt },
      booking: { type: Booking, extensions: reference() },
      summary: field('summary', { type: GraphQLString }, new GraphQLNonNull(GraphQLString), (line) => `${line.qty} x`),
    }),
  });
  const Entry = new GraphQLObjectType({
    name: 'VfoEntry',
    fields: () => ({ note: { type: GraphQLString }, booking: { type: Booking, extensions: reference() } }),
  });
  const Shop = new GraphQLObjectType({
    name: 'VfoShop',
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: new GraphQLNonNull(GraphQLString) },
      address: { type: Address, extensions: embedded },
      lines: { type: new GraphQLList(Line), extensions: embedded },
      score: field('score', { type: new GraphQLNonNull(GraphQLInt) }, new GraphQLNonNull(GraphQLInt), (shop) => shop.name.length),
      busyRanges: field(
        'busyRanges',
        { type: new GraphQLList(new GraphQLNonNull(Range)), extensions: embedded },
        new GraphQLList(new GraphQLNonNull(Range)),
        (shop, { date }) => [{ start: date }],
        { date: { type: new GraphQLNonNull(GraphQLString) } },
      ),
    }),
  });
  const Archive = new GraphQLObjectType({
    name: 'VfoArchive',
    fields: () => ({
      id: { type: GraphQLID },
      title: { type: GraphQLString },
      history: field('history', { type: new GraphQLList(Entry), extensions: embedded }, new GraphQLList(Entry), () => []),
    }),
  });
  const Booking = new GraphQLObjectType({
    name: 'VfoBooking',
    fields: () => ({
      id: { type: GraphQLID },
      label: { type: GraphQLString },
      codes: field('codes', { type: new GraphQLList(GraphQLString), extensions: { unique: true } }, new GraphQLList(GraphQLString), (booking) => [booking.label]),
    }),
  });
  const register = (api) => {
    api.connect(null, Shop, 'vfoshop', 'vfoshops');
    api.connect(null, Archive, 'vfoarchive', 'vfoarchives');
    api.connect(null, Booking, 'vfobooking', 'vfobookings');
    for (const type of [Range, Address, Line, Entry]) api.addNoEndpointType(type);
    return api.createSchema();
  };
  return { Shop, Archive, Booking, register };
};

describe.skipIf(!uri)('PostgreSQL databases that stored fields which are now virtual', () => {
  let pool;
  const namespaces = [];
  const newNamespace = () => {
    const name = `vfo_${randomUUID().replaceAll('-', '')}`;
    namespaces.push(name);
    return name;
  };
  beforeAll(() => { pool = new pg.Pool({ connectionString: uri, max: 4 }); });
  afterAll(async () => {
    if (!pool) return;
    for (const name of namespaces) await pool.query(`DROP SCHEMA IF EXISTS ${q(name)} CASCADE`);
    await pool.end();
  });

  it.each(['perRow', 'perRoot'])('names each field that left storage, with the migration that makes validation pass (%s refresh triggers)', async (refreshTriggers) => {
    const namespace = newNamespace();
    const s = q(namespace);
    const earlier = buildOptIn(false);
    const before = createPostgres({ pool, schema: namespace, refreshTriggers });
    earlier.register(before);
    await before.initializeDatabase();
    const booking = await before.getModel(earlier.Booking).create({ label: 'b', codes: ['b1'] });
    const shop = await before.getModel(earlier.Shop).create({
      name: 'Old shop', score: 3, address: { street: 'Old 1', formatted: 'stored' }, lines: [{ qty: 1, summary: 'stored', booking: booking.id }], busyRanges: [{ start: 'stored' }],
    });
    const archive = await before.getModel(earlier.Archive).create({ title: 'Old archive', history: [{ note: 'stored', booking: booking.id }] });

    const after = createPostgres({ pool, schema: namespace, refreshTriggers });
    const schema = buildOptIn(true).register(after);
    const statements = [
      `ALTER TABLE ${s}."VfoArchive" DROP COLUMN "__history_state";`,
      `ALTER TABLE ${s}."VfoBooking" DROP COLUMN "codes";`,
      `ALTER TABLE ${s}."VfoShop" DROP COLUMN "score", DROP COLUMN "busyRanges", DROP COLUMN "__field__busyRanges__present";`,
      `ALTER TABLE ${s}."VfoShop__lines" DROP COLUMN "summary", DROP COLUMN "__field__summary__present";`,
      `DROP TABLE IF EXISTS ${s}."VfoArchive__history" CASCADE;`,
      // Neither root owns anything now, so the refresh triggers they kept would call functions that refer to dropped storage.
      ...['VfoArchive', 'VfoBooking'].flatMap((root) => [
        `DROP TRIGGER IF EXISTS "${root}__touch" ON ${s}."${root}";`,
        `DROP TRIGGER IF EXISTS "${root}__deferred" ON ${s}."${root}";`,
        `DROP TABLE IF EXISTS ${s}."${root}__guard";`,
      ]),
    ];
    const message = `Schema mismatch at ${namespace}.VfoShop__address__json_valid: function identity, body, signature or configuration differs. `
      + 'Apply an explicit migration before startup. VfoArchive.history, VfoBooking.codes, VfoShop.score, VfoShop.busyRanges, VfoAddress.formatted and VfoLine.summary are '
      + 'virtual (extensions.virtual), so they are never stored, but this database still holds their earlier storage. Once nothing reads that storage, '
      + `migrate it: ${statements.join(' ')} Replace the functions ${s}."VfoShop__address__json_valid" and ${s}."VfoShop__owned_valid" with their `
      + `CREATE FUNCTION statements from compileDatabaseSchema(), run as CREATE OR REPLACE FUNCTION. ${UPGRADE_NOTES}`;
    for (const mode of ['validate', 'create']) {
      await expect(after.initializeDatabase({ mode })).rejects.toMatchObject({ message, extensions: { code: 'SCHEMA_MISMATCH', status: 409 } });
    }

    // The migration: the statements, then the two functions from compileDatabaseSchema(), as CREATE OR REPLACE.
    const ddl = after.compileDatabaseSchema();
    const replacement = (name) => ddl.find((statement) => statement.startsWith(`CREATE FUNCTION ${s}.${q(name)}(`)).replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION');
    for (const statement of [...statements, replacement('VfoShop__address__json_valid'), replacement('VfoShop__owned_valid')]) await pool.query(statement);
    expect(await after.initializeDatabase({ mode: 'validate' })).toEqual({ mode: 'validate', created: [] });
    expect(await after.initializeDatabase()).toEqual({ mode: 'create', created: [] });

    // Rows written before the migration read like new ones, and every generated write succeeds.
    const run = async (source, variableValues) => {
      const result = await graphql({ schema, source, variableValues, contextValue: {} });
      expect(result.errors).toBeUndefined();
      return result.data;
    };
    expect(await run('query($id: ID) { vfoshop(id: $id) { score busyRanges(date: "d") { start } address { street formatted } lines { qty summary } } }', { id: shop.id }))
      .toEqual({ vfoshop: { score: 8, busyRanges: [{ start: 'd' }], address: { street: 'Old 1', formatted: 'Old 1, formatted' }, lines: [{ qty: 1, summary: '1 x' }] } });
    expect(await run('mutation { addvfoshop(input: { name: "New shop", address: { street: "New 1" }, lines: [{ qty: 4 }] }) { score address { formatted } lines { summary } } }'))
      .toEqual({ addvfoshop: { score: 8, address: { formatted: 'New 1, formatted' }, lines: [{ summary: '4 x' }] } });
    expect(await run('mutation($input: VfoShopInputForUpdate!) { updatevfoshop(input: $input) { name lines { summary } } }', { input: { id: shop.id, name: 'Renamed', lines: [{ qty: 5 }] } }))
      .toEqual({ updatevfoshop: { name: 'Renamed', lines: [{ summary: '5 x' }] } });
    const added = await run('mutation { addvfoarchive(input: { title: "New archive" }) { id history { note } } }');
    expect(added.addvfoarchive.history).toEqual([]);
    expect(await run('mutation($input: VfoArchiveInputForUpdate!) { updatevfoarchive(input: $input) { title } }', { input: { id: archive.id, title: 'Renamed' } }))
      .toEqual({ updatevfoarchive: { title: 'Renamed' } });
    expect(await run('mutation($id: ID!) { deletevfoarchive(id: $id) { title } }', { id: added.addvfoarchive.id })).toEqual({ deletevfoarchive: { title: 'New archive' } });
    const newBooking = await run('mutation { addvfobooking(input: { label: "c" }) { id codes } }');
    expect(newBooking.addvfobooking.codes).toEqual(['c']);
    expect(await run('mutation($input: VfoBookingInputForUpdate!) { updatevfobooking(input: $input) { codes } }', { input: { id: booking.id, label: 'd' } }))
      .toEqual({ updatevfobooking: { codes: ['d'] } });
    expect(await run('mutation($id: ID!) { deletevfobooking(id: $id) { label } }', { id: newBooking.addvfobooking.id })).toEqual({ deletevfobooking: { label: 'c' } });
    expect(await columnsOf(pool, namespace, 'VfoShop')).toEqual(['id', 'name', 'address', '__field__address__present', '__lines_state']);
    expect(await columnsOf(pool, namespace, 'VfoArchive')).toEqual(['id', 'title']);
    // A JSON value keeps the key of a member that is now virtual until a generated update rewrites the value.
    const address = async () => (await pool.query(`SELECT address FROM ${s}."VfoShop" WHERE id = $1`, [shop.id])).rows[0].address;
    expect(await address()).toEqual({ street: 'Old 1', formatted: 'stored' });
    await run('mutation($input: VfoShopInputForUpdate!) { updatevfoshop(input: $input) { name } }', { input: { id: shop.id, address: { street: 'Old 2' } } });
    expect(await address()).toEqual({ street: 'Old 2' });
  });

  it('names one list of JSON objects that became virtual, as Barber busyRanges would, and its migration', async () => {
    const namespace = newNamespace();
    const s = q(namespace);
    const earlier = buildOptIn(false);
    const before = createPostgres({ pool, schema: namespace });
    earlier.register(before);
    await before.initializeDatabase();
    await before.getModel(earlier.Shop).create({ name: 'Old shop', score: 1, busyRanges: [{ start: 'stored' }] });
    const after = createPostgres({ pool, schema: namespace });
    const schema = buildOptIn(['busyRanges']).register(after);
    const migration = `ALTER TABLE ${s}."VfoShop" DROP COLUMN "busyRanges", DROP COLUMN "__field__busyRanges__present";`;
    await expect(after.initializeDatabase({ mode: 'validate' })).rejects.toMatchObject({
      message: `Schema mismatch at ${namespace}.VfoShop: column set differs. Apply an explicit migration before startup. VfoShop.busyRanges is virtual `
        + '(extensions.virtual), so it is never stored, but this database still holds its earlier storage. Once nothing reads that storage, '
        + `migrate it: ${migration} ${UPGRADE_NOTES}`,
    });
    await pool.query(migration);
    expect(await after.initializeDatabase({ mode: 'validate' })).toEqual({ mode: 'validate', created: [] });
    // Its validation functions are left; initialization does not check functions it no longer describes.
    const left = await pool.query('SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname LIKE $2 ORDER BY 1', [namespace, '%busyRanges%']);
    expect(left.rows.map((row) => row.proname)).toEqual([
      'VfoShop__busyRanges__item__busyRanges__json_valid', 'VfoShop__busyRanges__item__busyRanges__start__json_valid', 'VfoShop__busyRanges__json_valid',
    ]);
    const added = await graphql({ schema, source: 'mutation { addvfoshop(input: { name: "New", score: 2 }) { score busyRanges(date: "d") { start } } }', contextValue: {} });
    expect(added).toEqual({ data: { addvfoshop: { score: 2, busyRanges: [{ start: 'd' }] } } });
  });

  it.each([false, true])('names the last member with its own table of an embedded value, which then is stored as JSON, and its data migration (root keeps other owned values: %s)', async (keepsOwned) => {
    // VfmvShop.lines owns a table only because of its reference member, VfmvLine.booking, which becomes virtual.
    // With keepsOwned, VfmvShop.extras still owns a table afterwards, so its root keeps its refresh triggers.
    const build = (virtual) => {
      const Booking = new GraphQLObjectType({ name: 'VfmvBooking', fields: () => ({ id: { type: GraphQLID }, label: { type: GraphQLString } }) });
      const Line = new GraphQLObjectType({
        name: 'VfmvLine',
        fields: () => ({
          qty: { type: GraphQLInt },
          booking: virtual
            ? { type: GraphQLString, extensions: { virtual: true }, resolve: (line) => `booking of ${line.qty}` }
            : { type: Booking, extensions: reference() },
        }),
      });
      const Extra = new GraphQLObjectType({ name: 'VfmvExtra', fields: () => ({ booking: { type: Booking, extensions: reference() } }) });
      const Shop = new GraphQLObjectType({
        name: 'VfmvShop',
        fields: () => ({
          id: { type: GraphQLID },
          name: { type: GraphQLString },
          lines: { type: new GraphQLList(Line), extensions: embedded },
          ...(keepsOwned ? { extras: { type: new GraphQLList(Extra), extensions: embedded } } : {}),
        }),
      });
      const register = (api) => {
        api.connect(null, Shop, 'vfmvshop', 'vfmvshops');
        api.connect(null, Booking, 'vfmvbooking', 'vfmvbookings');
        api.addNoEndpointType(Line);
        api.addNoEndpointType(Extra);
        return api.createSchema();
      };
      return { Shop, Booking, register };
    };
    const namespace = newNamespace();
    const s = q(namespace);
    const earlier = build(false);
    const before = createPostgres({ pool, schema: namespace });
    earlier.register(before);
    await before.initializeDatabase();
    const booking = await before.getModel(earlier.Booking).create({ label: 'b' });
    const shop = await before.getModel(earlier.Shop).create({ name: 'Old shop', lines: [{ qty: 1, booking: booking.id }, { qty: 2 }] });
    // Without lines, a native create stores an empty list.
    const bare = await before.getModel(earlier.Shop).create({ name: 'No lines' });

    const after = createPostgres({ pool, schema: namespace });
    const schema = build(true).register(after);
    const explanation = 'VfmvLine.booking is virtual (extensions.virtual), so it is never stored, but this database still holds its earlier storage. '
      + `Once nothing reads that storage, migrate it: The embedded value lines of ${s}."VfmvShop" now has no member with its own table, so it is stored `
      + 'as JSON in the columns "lines" and "__field__lines__present" of that table, with the checks and functions that compileDatabaseSchema() gives '
      + `them, instead of in the table ${s}."VfmvShop__lines": add them, fill them from the rows of ${s}."VfmvShop__lines", then drop the column `
      + `"__lines_state" and run DROP TABLE IF EXISTS ${s}."VfmvShop__lines" CASCADE; `
      + (keepsOwned
        // The root's validation function still checks the owned table.
        ? `Replace the function ${s}."VfmvShop__owned_valid" with its CREATE FUNCTION statement from compileDatabaseSchema(), run as CREATE OR REPLACE FUNCTION. `
        : `DROP TRIGGER IF EXISTS "VfmvShop__touch" ON ${s}."VfmvShop"; DROP TRIGGER IF EXISTS "VfmvShop__deferred" ON ${s}."VfmvShop"; `
          + `DROP TABLE IF EXISTS ${s}."VfmvShop__guard"; `)
      + UPGRADE_NOTES;
    await expect(after.initializeDatabase({ mode: 'validate' })).rejects.toMatchObject({
      message: `Schema mismatch at ${namespace}.VfmvShop__lines__item__lines__qty__json_valid: function is missing. Apply an explicit migration before startup. ${explanation}`,
      extensions: { code: 'SCHEMA_MISMATCH', status: 409 },
    });
    // Create mode reports the first drift it inspects.
    const drift = keepsOwned ? 'VfmvShop__owned_valid: function identity, body, signature or configuration differs' : 'VfmvShop: column set differs';
    await expect(after.initializeDatabase()).rejects.toMatchObject({
      message: `Schema mismatch at ${namespace}.${drift}. Apply an explicit migration before startup. ${explanation}`,
    });

    // The data migration: the JSON validation functions, the two columns filled from the owned rows, their checks, then the drops.
    const shopTable = after.describeDatabase().tables.find((table) => table.name === 'VfmvShop');
    const column = (name) => shopTable.columns.find((item) => item.name === name);
    for (const statement of after.compileDatabaseSchema().filter((text) => text.startsWith(`CREATE FUNCTION ${s}."VfmvShop__lines__`))) await pool.query(statement);
    const present = column('__field__lines__present');
    await pool.query(`ALTER TABLE ${s}."VfmvShop" ADD COLUMN "lines" ${column('lines').type}, ADD COLUMN "__field__lines__present" ${present.type} NOT NULL DEFAULT ${present.default}`);
    await pool.query(`UPDATE ${s}."VfmvShop" t SET "__field__lines__present" = t."__lines_state" <> 'missing', "lines" = CASE t."__lines_state" WHEN 'present' THEN
      COALESCE((SELECT jsonb_agg(CASE WHEN NOT o.__item_present THEN 'null'::jsonb WHEN o."__field__qty__present" THEN jsonb_build_object('qty', o.qty) ELSE '{}'::jsonb END
        ORDER BY o.__position) FROM ${s}."VfmvShop__lines" o WHERE o.__owner_id = t.id), '[]'::jsonb) END`);
    const existing = (await pool.query('SELECT conname FROM pg_constraint WHERE conrelid = to_regclass($1)', [`${s}."VfmvShop"`])).rows.map((row) => row.conname);
    for (const check of shopTable.checks.filter((item) => !existing.includes(item.name))) {
      await pool.query(`ALTER TABLE ${s}."VfmvShop" ADD CONSTRAINT ${q(check.name)} CHECK (${check.expression})`);
    }
    await pool.query(`ALTER TABLE ${s}."VfmvShop" DROP COLUMN "__lines_state"`);
    for (const statement of explanation.match(/(DROP TABLE|DROP TRIGGER) [^;]+;/g)) await pool.query(statement);
    if (keepsOwned) {
      const replacement = after.compileDatabaseSchema().find((text) => text.startsWith(`CREATE FUNCTION ${s}."VfmvShop__owned_valid"(`));
      await pool.query(replacement.replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION'));
    }
    expect(await after.initializeDatabase({ mode: 'validate' })).toEqual({ mode: 'validate', created: [] });
    expect(await after.initializeDatabase()).toEqual({ mode: 'create', created: [] });

    const read = await graphql({
      schema, source: 'query($id: ID) { vfmvshop(id: $id) { name lines { qty booking } } }', variableValues: { id: shop.id }, contextValue: {},
    });
    expect(read).toEqual({ data: { vfmvshop: { name: 'Old shop', lines: [{ qty: 1, booking: 'booking of 1' }, { qty: 2, booking: 'booking of 2' }] } } });
    expect((await pool.query(`SELECT lines, "__field__lines__present" AS present FROM ${s}."VfmvShop" WHERE id = $1`, [bare.id])).rows)
      .toEqual([{ lines: [], present: true }]);
    const updated = await graphql({
      schema, source: 'mutation($input: VfmvShopInputForUpdate!) { updatevfmvshop(input: $input) { lines { qty booking } } }', variableValues: { input: { id: shop.id, lines: [{ qty: 5 }] } }, contextValue: {},
    });
    expect(updated).toEqual({ data: { updatevfmvshop: { lines: [{ qty: 5, booking: 'booking of 5' }] } } });
  });

  it('blames no virtual field for a changed function of another column or root', async () => {
    // A new virtual member VfaAddress.note, named like the member that VfaInfo, on another entity, drops.
    const build = (after) => {
      const Info = new GraphQLObjectType({
        name: 'VfaInfo', fields: () => ({ title: { type: GraphQLString }, ...(after ? {} : { note: { type: GraphQLString } }) }),
      });
      const Address = new GraphQLObjectType({
        name: 'VfaAddress',
        fields: () => ({
          street: { type: GraphQLString },
          ...(after ? { note: { type: GraphQLString, extensions: { virtual: true }, resolve: () => 'n' } } : {}),
        }),
      });
      const Shop = new GraphQLObjectType({
        name: 'VfaShop', fields: () => ({ id: { type: GraphQLID }, name: { type: GraphQLString }, address: { type: Address, extensions: embedded } }),
      });
      const Other = new GraphQLObjectType({
        name: 'VfaOther', fields: () => ({ id: { type: GraphQLID }, qty: { type: GraphQLInt }, info: { type: Info, extensions: embedded } }),
      });
      return (api) => {
        api.connect(null, Shop, 'vfashop', 'vfashops');
        api.connect(null, Other, 'vfaother', 'vfaothers');
        api.addNoEndpointType(Info);
        api.addNoEndpointType(Address);
        return api.createSchema();
      };
    };
    const namespace = newNamespace();
    const before = createPostgres({ pool, schema: namespace });
    build(false)(before);
    await before.initializeDatabase();
    const after = createPostgres({ pool, schema: namespace });
    build(true)(after);
    for (const mode of ['validate', 'create']) {
      await expect(after.initializeDatabase({ mode })).rejects.toMatchObject({
        message: `Schema mismatch at ${namespace}.VfaOther__info__json_valid: function identity, body, signature or configuration differs. Apply an explicit migration before startup.`,
      });
    }
  });

  it('keeps the earlier message for a mismatch that no virtual field explains', async () => {
    const namespace = newNamespace();
    const s = q(namespace);
    const api = createPostgres({ pool, schema: namespace });
    buildOptIn(true).register(api);
    await api.initializeDatabase();
    await pool.query(`ALTER FUNCTION ${s}."VfoShop__address__json_valid"(jsonb) SET work_mem = '64kB'`);
    await expect(api.initializeDatabase({ mode: 'validate' })).rejects.toMatchObject({
      message: `Schema mismatch at ${namespace}.VfoShop__address__json_valid: function identity, body, signature or configuration differs. Apply an explicit migration before startup.`,
    });
    await pool.query(`ALTER FUNCTION ${s}."VfoShop__address__json_valid"(jsonb) RESET work_mem`);
    // A column named like a virtual field of another table.
    await pool.query(`ALTER TABLE ${s}."VfoBooking" ADD COLUMN "score" integer`);
    await expect(api.initializeDatabase({ mode: 'validate' })).rejects.toMatchObject({
      message: `Schema mismatch at ${namespace}.VfoBooking: column set differs. Apply an explicit migration before startup.`,
    });
  });
});
