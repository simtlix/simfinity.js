import {
  afterEach, beforeEach, describe, expect, test, vi,
} from 'vitest';
import {
  GraphQLEnumType,
  GraphQLID,
  GraphQLInt,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLString,
  GraphQLUnionType,
  getNamedType,
  graphql,
  printSchema,
} from 'graphql';

import {
  createRuntime, describeModels, isVirtualField, SimfinityError, virtualFieldOptions,
} from '../packages/core/src/index.js';

// Virtual fields (#109): fields with their own resolver, declared with `extensions.virtual`, that no
// backend stores and that are not part of the query language.

const createMemoryAdapter = () => {
  const records = new Map();
  let nextId = 1;
  const ofModel = (Model) => [...records.values()].filter((record) => record.__model === Model.name);
  // Honors top-level EQ filters on scalar fields, so scopes can hide records.
  const matches = (record, args) => Object.entries(args || {}).every(([name, value]) => {
    if (['AND', 'OR', 'sort', 'pagination', 'aggregation'].includes(name) || value?.operator !== 'EQ') return true;
    return String(name === 'id' ? record._id : record[name]) === String(value.value);
  });
  return {
    records,
    prepare: vi.fn(),
    createModel: vi.fn((gqltype, onModelCreated) => {
      const model = { name: gqltype.name };
      if (onModelCreated) onModelCreated(model);
      return model;
    }),
    castId: (value) => String(value),
    withTransaction: async (session, body) => body(session || { adapter: 'memory' }),
    newRecord: (Model, data) => ({ ...data, _id: String(nextId++), __model: Model.name }),
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
    async update(Model, id, update) {
      const current = records.get(String(id));
      for (const key of Object.keys(update.unset)) delete current[key];
      Object.assign(current, update.set);
      return current;
    },
    async delete(Model, id) {
      const record = records.get(String(id)) || null;
      records.delete(String(id));
      return record;
    },
    find: vi.fn(async (Model, gqltype, args) => ofModel(Model).filter((record) => matches(record, args))),
    count: vi.fn(async () => 0),
    aggregate: vi.fn(async () => []),
    findChildren: vi.fn(async (Model, gqltype, connectionField, parentId) => ofModel(Model)
      .filter((record) => String(record[connectionField]) === String(parentId))),
  };
};

const JSONLike = new GraphQLScalarType({ name: 'VfJSON', serialize: (value) => value });
const Named = new GraphQLInterfaceType({ name: 'VfNamed', fields: { label: { type: GraphQLString } } });
const Tag = new GraphQLObjectType({
  name: 'VfTag', interfaces: [Named], fields: { label: { type: GraphQLString } }, isTypeOf: () => true,
});
const TagUnion = new GraphQLUnionType({ name: 'VfTagUnion', types: [Tag], resolveType: () => 'VfTag' });

// One model, with or without its virtual fields, so that their only effect can be compared.
const buildModel = ({ virtual = true, spies = {}, scopes = {} } = {}) => {
  const resolver = (name, value) => vi.fn((...call) => {
    spies[name]?.(...call);
    return typeof value === 'function' ? value(...call) : value;
  });
  const calls = {};
  const virtualField = (name, config) => {
    calls[name] = resolver(name, config.value);
    return {
      type: config.type,
      args: config.args,
      extensions: { ...config.extensions, virtual: config.virtual ?? true },
      resolve: calls[name],
    };
  };
  const only = (fields) => (virtual ? fields : {});

  // Reached only through virtual fields, and not registered.
  const RangeType = new GraphQLObjectType({
    name: 'VfRange',
    fields: { start: { type: GraphQLString }, end: { type: GraphQLString } },
  });
  const AddressType = new GraphQLObjectType({
    name: 'VfAddress',
    fields: () => ({
      street: { type: GraphQLString },
      ...only({
        formatted: virtualField('formatted', {
          type: new GraphQLNonNull(GraphQLString), value: (address) => `${address.street} (formatted)`,
        }),
        lines: virtualField('lines', { type: new GraphQLList(GraphQLString), value: (address) => [address.street] }),
      }),
    }),
  });
  const StatsType = new GraphQLObjectType({
    name: 'VfStats',
    fields: { visits: { type: GraphQLInt } },
  });
  const ShopType = new GraphQLObjectType({
    name: 'VfShop',
    extensions: scopes.shop ? { scope: scopes.shop } : {},
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      address: { type: AddressType, extensions: { relation: { embedded: true } } },
      bookings: { type: new GraphQLList(BookingType), extensions: { relation: { connectionField: 'shop' } } },
      ...only({
        score: virtualField('score', { type: new GraphQLNonNull(GraphQLInt), value: 42 }),
        nickname: virtualField('nickname', {
          type: GraphQLString, value: 'shop', extensions: { readOnly: true, queryable: false },
        }),
        keywords: virtualField('keywords', { type: new GraphQLList(GraphQLString), value: ['a'] }),
        busyRanges: virtualField('busyRanges', {
          type: new GraphQLList(new GraphQLNonNull(RangeType)),
          args: { date: { type: new GraphQLNonNull(GraphQLString) }, professionalId: { type: GraphQLID } },
          value: (shop, args) => [{ start: `${args.date}T10`, end: `${args.date}T11` }],
          virtual: { mcp: 'tool' },
        }),
        topBooking: virtualField('topBooking', {
          type: BookingType, value: (shop, args, context) => context.topBooking ?? null,
        }),
        recentBookings: virtualField('recentBookings', { type: new GraphQLList(BookingType), value: [] }),
        stats: virtualField('stats', { type: StatsType, value: { visits: 3 }, virtual: { mcp: 'select' } }),
        raw: virtualField('raw', { type: JSONLike, value: { any: 'thing' }, virtual: { mcp: false } }),
        named: virtualField('named', { type: Named, value: { label: 'tag' } }),
        tagged: virtualField('tagged', { type: new GraphQLList(TagUnion), value: [{ label: 'u' }] }),
        grid: virtualField('grid', { type: new GraphQLList(new GraphQLList(GraphQLInt)), value: [[1]] }),
      }),
    }),
  });
  const BookingType = new GraphQLObjectType({
    name: 'VfBooking',
    extensions: scopes.booking ? { scope: scopes.booking } : {},
    fields: () => ({
      id: { type: GraphQLID },
      when: { type: GraphQLString },
      shop: { type: ShopType, extensions: { relation: { connectionField: 'shop' } } },
      ...only({
        label: virtualField('label', {
          type: GraphQLString, args: { locale: { type: new GraphQLNonNull(GraphQLString) } },
          value: (booking, args) => `${booking.when}@${args.locale}`,
        }),
      }),
    }),
  });
  return {
    ShopType, BookingType, AddressType, StatsType, RangeType, calls,
  };
};

const createFixture = (options = {}) => {
  const model = buildModel(options);
  const adapter = createMemoryAdapter();
  const runtime = createRuntime(adapter);
  runtime.connect(null, model.ShopType, 'vfShop', 'vfShops');
  runtime.connect(null, model.BookingType, 'vfBooking', 'vfBookings');
  runtime.addNoEndpointType(model.AddressType);
  runtime.addNoEndpointType(model.StatsType);
  for (const middleware of options.middlewares || []) runtime.use(middleware);
  const schema = runtime.createSchema();
  const run = (source, variableValues, contextValue = {}) => graphql({
    schema, source, variableValues, contextValue,
  });
  return {
    ...model, adapter, runtime, schema, run,
  };
};

const errorOf = (result) => {
  expect(result.errors?.length).toBe(1);
  const error = result.errors[0].originalError ?? result.errors[0];
  return { code: error.extensions?.code, status: error.extensions?.status, message: error.message };
};

const VIRTUAL_NAMES = ['score', 'nickname', 'keywords', 'busyRanges', 'topBooking', 'recentBookings', 'stats', 'raw',
  'named', 'tagged', 'grid'];

let warn;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe('virtual field declarations', () => {
  const singleType = (field, { typeExtensions = {}, extraFields = {} } = {}) => new GraphQLObjectType({
    name: 'VfDecl',
    extensions: typeExtensions,
    fields: () => ({ id: { type: GraphQLID }, name: { type: GraphQLString }, ...extraFields, value: field }),
  });
  const resolve = () => 1;
  const schemaFor = (type, { stateMachine } = {}) => {
    const adapter = createMemoryAdapter();
    const runtime = createRuntime(adapter);
    runtime.connect(null, type, 'vfDecl', 'vfDecls', null, null, stateMachine);
    return { adapter, build: () => runtime.createSchema() };
  };
  const expectInvalidModel = (type, message, options) => {
    const { adapter, build } = schemaFor(type, options);
    let thrown;
    try {
      build();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SimfinityError);
    expect(thrown.extensions).toMatchObject({ code: 'INVALID_MODEL', status: 400 });
    expect(thrown.message).toContain(message);
    // Rejected before anything is built.
    expect(adapter.prepare).not.toHaveBeenCalled();
    expect(adapter.createModel).not.toHaveBeenCalled();
    // describeModels, which backends call, rejects the same declaration.
    expect(() => describeModels([{ gqltype: type, stateMachine: options?.stateMachine }]))
      .toThrow(expect.objectContaining({ message: expect.stringContaining(message) }));
  };

  test.each([
    ['a string', 'yes'],
    ['false', false],
    ['null', null],
    ['a number', 1],
    ['an array', []],
    ['a class instance', new (class Options {})()],
  ])('rejects %s as extensions.virtual', (label, value) => {
    expectInvalidModel(singleType({ type: GraphQLInt, resolve, extensions: { virtual: value } }),
      'VfDecl.value extensions.virtual must be true or an options object');
  });

  test('rejects unknown options and invalid mcp values', () => {
    expectInvalidModel(singleType({ type: GraphQLInt, resolve, extensions: { virtual: { batch: () => [] } } }),
      'VfDecl.value extensions.virtual has the unknown option batch');
    for (const mcp of ['tools', true, null, 0]) {
      expectInvalidModel(singleType({ type: GraphQLInt, resolve, extensions: { virtual: { mcp } } }),
        'VfDecl.value extensions.virtual.mcp must be \'tool\', \'select\' or false');
    }
  });

  test('requires the field\'s own resolver', () => {
    expectInvalidModel(singleType({ type: GraphQLInt, extensions: { virtual: true } }),
      'VfDecl.value is virtual, so it requires its own resolve function');
  });

  test.each([
    ['extensions.relation', { relation: { embedded: true } }],
    ['unique: true', { unique: true }],
    ['extensions.validations', { validations: { CREATE: [], UPDATE: [] } }],
    ['queryable: true', { queryable: true }],
    ['readOnly: false', { readOnly: false }],
  ])('rejects a virtual field that also declares %s', (setting, extensions) => {
    expectInvalidModel(singleType({ type: GraphQLInt, resolve, extensions: { ...extensions, virtual: true } }),
      `VfDecl.value is virtual, which is never stored, so it cannot declare ${setting}`);
  });

  test('rejects a virtual identity field', () => {
    const type = new GraphQLObjectType({
      name: 'VfDecl',
      fields: { id: { type: GraphQLID, resolve, extensions: { virtual: true } }, name: { type: GraphQLString } },
    });
    expectInvalidModel(type, 'VfDecl.id is the identity field, so it cannot be virtual');
  });

  test('rejects a virtual field named in extensions.indexes', () => {
    expectInvalidModel(singleType({ type: GraphQLInt, resolve, extensions: { virtual: true } }, {
      typeExtensions: { indexes: [{ fields: ['name', 'value'] }] },
    }), 'An index of VfDecl names the virtual field VfDecl.value, which is never stored');
  });

  test('rejects a virtual state field of a state machine', () => {
    const State = new GraphQLEnumType({ name: 'VfDeclState', values: { DRAFT: { value: 'draft' }, DONE: { value: 'done' } } });
    const type = new GraphQLObjectType({
      name: 'VfDecl',
      fields: {
        id: { type: GraphQLID },
        state: { type: State, resolve: () => 'draft', extensions: { virtual: true } },
      },
    });
    expectInvalidModel(type, 'VfDecl.state holds the state of its state machine, so it cannot be virtual', {
      stateMachine: {
        initialState: { name: 'DRAFT', value: 'draft' },
        actions: { finish: { from: { name: 'DRAFT', value: 'draft' }, to: { name: 'DONE', value: 'done' } } },
      },
    });
  });

  test('rejects a virtual connectionField of a collection or a reference', () => {
    const Parent = new GraphQLObjectType({
      name: 'VfDeclParent',
      fields: () => ({ id: { type: GraphQLID }, children: { type: new GraphQLList(Child), extensions: { relation: { connectionField: 'parentKey' } } } }),
    });
    const Child = new GraphQLObjectType({
      name: 'VfDeclChild',
      fields: () => ({ id: { type: GraphQLID }, parentKey: { type: GraphQLID, resolve, extensions: { virtual: true } } }),
    });
    const runtime = createRuntime(createMemoryAdapter());
    runtime.connect(null, Parent, 'vfDeclParent', 'vfDeclParents');
    runtime.connect(null, Child, 'vfDeclChild', 'vfDeclChildren');
    const message = 'VfDeclParent.children uses the virtual field VfDeclChild.parentKey as its connectionField';
    expect(() => runtime.createSchema()).toThrow(message);
    expect(() => describeModels([{ gqltype: Parent }, { gqltype: Child }])).toThrow(message);

    const Owner = new GraphQLObjectType({ name: 'VfDeclOwner', fields: { id: { type: GraphQLID } } });
    expectInvalidModel(singleType({ type: Owner, extensions: { relation: { connectionField: 'ownerKey' } } }, {
      extraFields: { ownerKey: { type: GraphQLID, resolve, extensions: { virtual: true } } },
    }), 'VfDecl.value uses the virtual field VfDecl.ownerKey as its connectionField');
  });

  test('rejects a dotted connectionField or index key that ends at or passes through a virtual member', () => {
    const Meta = new GraphQLObjectType({
      name: 'VfDeclMeta',
      fields: { label: { type: GraphQLString }, key: { type: GraphQLID, resolve, extensions: { virtual: true } } },
    });
    const Owner = new GraphQLObjectType({ name: 'VfDeclOwner', fields: { id: { type: GraphQLID } } });
    const embeddedMeta = { meta: { type: Meta, extensions: { relation: { embedded: true } } } };
    // A reference whose dotted connectionField ends at a virtual member of an embedded type.
    expectInvalidModel(singleType({ type: Owner, extensions: { relation: { connectionField: 'meta.key' } } }, {
      extraFields: embeddedMeta,
    }), 'VfDecl.value uses the virtual field VfDeclMeta.key as its connectionField (through meta.key); a virtual field is never stored');
    // A dotted path that passes through a virtual object.
    const Info = new GraphQLObjectType({ name: 'VfDeclInfo', fields: { key: { type: GraphQLID } } });
    expectInvalidModel(singleType({ type: Owner, extensions: { relation: { connectionField: 'info.key' } } }, {
      extraFields: { info: { type: Info, resolve, extensions: { virtual: true } } },
    }), 'VfDecl.value uses the virtual field VfDecl.info as its connectionField (through info.key)');
    // A collection whose dotted connectionField ends at a virtual member of the item type.
    const Parent = new GraphQLObjectType({
      name: 'VfDeclParent',
      fields: () => ({ id: { type: GraphQLID }, children: { type: new GraphQLList(Child), extensions: { relation: { connectionField: 'meta.key' } } } }),
    });
    const Child = new GraphQLObjectType({
      name: 'VfDeclChild',
      fields: () => ({ id: { type: GraphQLID }, ...embeddedMeta }),
    });
    const runtime = createRuntime(createMemoryAdapter());
    runtime.addNoEndpointType(Meta);
    runtime.connect(null, Parent, 'vfDeclParent', 'vfDeclParents');
    runtime.connect(null, Child, 'vfDeclChild', 'vfDeclChildren');
    const message = 'VfDeclParent.children uses the virtual field VfDeclMeta.key as its connectionField (through meta.key)';
    expect(() => runtime.createSchema()).toThrow(message);
    expect(() => describeModels([{ gqltype: Parent }, { gqltype: Child }])).toThrow(message);
    // An index key that ends at a virtual member.
    expectInvalidModel(singleType({ type: GraphQLInt }, {
      typeExtensions: { indexes: [{ fields: ['name', 'meta.key'] }] },
      extraFields: embeddedMeta,
    }), 'An index of VfDecl names the virtual field VfDeclMeta.key (through meta.key), which is never stored');
  });

  test('rejects non-string connectionFields that name virtual members', () => {
    const Owner = new GraphQLObjectType({ name: 'VfDeclOwner', fields: { id: { type: GraphQLID } } });
    const Meta = new GraphQLObjectType({
      name: 'VfDeclMeta',
      fields: { key: { type: GraphQLID, resolve, extensions: { virtual: true } } },
    });
    // A String object, as an application could pass one.
    expectInvalidModel(singleType({ type: Owner, extensions: { relation: { connectionField: new String('ownerKey') } } }, {
      extraFields: { ownerKey: { type: GraphQLID, resolve, extensions: { virtual: true } } },
    }), 'VfDecl.value uses the virtual field VfDecl.ownerKey as its connectionField; a virtual field is never stored');
    expectInvalidModel(singleType({ type: Owner, extensions: { relation: { connectionField: ['meta.key'] } } }, {
      extraFields: { meta: { type: Meta, extensions: { relation: { embedded: true } } } },
    }), 'VfDecl.value uses the virtual field VfDeclMeta.key as its connectionField (through meta.key)');
  });

  test('checks the field name that a collection without a connectionField reads its items by', () => {
    const build = (collection) => {
      const Parent = new GraphQLObjectType({
        name: 'VfDeclParent',
        fields: () => ({ id: { type: GraphQLID }, kids: { type: new GraphQLList(Child), ...collection } }),
      });
      const Child = new GraphQLObjectType({
        name: 'VfDeclChild',
        fields: () => ({ id: { type: GraphQLID }, label: { type: GraphQLString }, kids: { type: GraphQLID, resolve, extensions: { virtual: true } } }),
      });
      const runtime = createRuntime(createMemoryAdapter());
      runtime.connect(null, Parent, 'vfDeclParent', 'vfDeclParents');
      runtime.connect(null, Child, 'vfDeclChild', 'vfDeclChildren');
      return () => runtime.createSchema();
    };
    expect(build({ extensions: { readOnly: true, relation: {} } }))
      .toThrow('VfDeclParent.kids uses the virtual field VfDeclChild.kids as its connectionField; a virtual field is never stored');
    // A collection that the application resolves is never read by Simfinity, so its name is not a link.
    expect(build({ extensions: { readOnly: true, relation: {} }, resolve: () => [] })).not.toThrow();
  });

  test('rejects a dotted connectionField even when its path crosses a reference', () => {
    const Target = new GraphQLObjectType({
      name: 'VfDeclTarget',
      fields: { id: { type: GraphQLID }, vk: { type: GraphQLID, resolve, extensions: { virtual: true } } },
    });
    const Owner = new GraphQLObjectType({ name: 'VfDeclOwner', fields: { id: { type: GraphQLID } } });
    const runtime = createRuntime(createMemoryAdapter());
    runtime.connect(null, Target, 'vfDeclTarget', 'vfDeclTargets');
    runtime.connect(null, Owner, 'vfDeclOwner', 'vfDeclOwners');
    runtime.connect(null, singleType({ type: Owner, extensions: { relation: { connectionField: 'link.vk' } } }, {
      extraFields: { link: { type: Target, extensions: { relation: { connectionField: 'linkId' } } } },
    }), 'vfDecl', 'vfDecls');
    expect(() => runtime.createSchema()).toThrow('VfDecl.value extensions.relation.connectionField link.vk must name a field of VfDecl, not a path into an embedded value');
  });

  test('checks members of embedded types and types reached only through virtual fields', () => {
    const Embedded = new GraphQLObjectType({
      name: 'VfDeclEmbedded',
      fields: { street: { type: GraphQLString }, formatted: { type: GraphQLString, extensions: { virtual: true } } },
    });
    expectInvalidModel(singleType({ type: Embedded, extensions: { relation: { embedded: true } } }),
      'VfDeclEmbedded.formatted is virtual, so it requires its own resolve function');

    const Result = new GraphQLObjectType({
      name: 'VfDeclResult',
      fields: { inner: { type: GraphQLInt, extensions: { virtual: 'yes' }, resolve } },
    });
    const { build } = schemaFor(singleType({ type: Result, resolve, extensions: { virtual: true } }));
    expect(build).toThrow('VfDeclResult.inner extensions.virtual must be true or an options object');
  });

  test('accepts true, every mcp option, and readOnly: true or queryable: false with it', () => {
    for (const virtual of [true, {}, { mcp: undefined }, { mcp: 'tool' }, { mcp: 'select' }, { mcp: false },
      Object.assign(Object.create(null), { mcp: 'select' })]) {
      const type = singleType({ type: GraphQLInt, resolve, extensions: { virtual, readOnly: true, queryable: false } });
      expect(() => schemaFor(type).build()).not.toThrow();
      expect(describeModels([{ gqltype: type }]).entities[0].fields.map(({ name }) => name)).toEqual(['id', 'name']);
    }
  });
});

describe('virtual fields are not stored', () => {
  const plainDescription = (models) => models.entities.map(({ gqltype, ...entity }) => ({
    ...entity, type: gqltype.name,
  }));

  test('describeModels leaves them out of entities, embedded and no-endpoint types, and describes no result type', () => {
    const withVirtual = buildModel();
    const without = buildModel({ virtual: false });
    const registrations = (model) => [
      { gqltype: model.ShopType }, { gqltype: model.BookingType },
      { gqltype: model.AddressType, endpoint: false }, { gqltype: model.StatsType, endpoint: false },
    ];
    const described = describeModels(registrations(withVirtual));
    expect(plainDescription(described)).toEqual(plainDescription(describeModels(registrations(without))));
    expect(described.entities.map(({ name }) => name)).toEqual(['VfBooking', 'VfShop']);
    const shop = described.entities.find(({ name }) => name === 'VfShop');
    expect(shop.fields.map(({ name }) => name)).toEqual(['id', 'name', 'address', 'bookings']);
    expect(shop.fields.find(({ name }) => name === 'address').fields.map(({ name }) => name)).toEqual(['street']);
    // A registered entity as a virtual result adds no reference, collection or inferred inverse.
    const booking = described.entities.find(({ name }) => name === 'VfBooking');
    expect(booking.fields.map(({ name, kind }) => [name, kind])).toEqual([
      ['id', 'scalar'], ['when', 'scalar'], ['shop', 'reference'],
    ]);
  });

  test('a no-endpoint type that only virtual fields reach is not described, and needs no registration', () => {
    const Stats = new GraphQLObjectType({ name: 'VfOnlyStats', fields: { visits: { type: GraphQLInt } } });
    const Holder = new GraphQLObjectType({
      name: 'VfHolder',
      fields: {
        id: { type: GraphQLID },
        stats: { type: Stats, resolve: () => ({ visits: 1 }), extensions: { virtual: true } },
        history: { type: new GraphQLNonNull(new GraphQLList(Stats)), resolve: () => [], extensions: { virtual: true } },
      },
    });
    expect(describeModels([{ gqltype: Holder }, { gqltype: Stats, endpoint: false }]).entities.map(({ name, fields }) => [
      name, fields.map((field) => field.name),
    ])).toEqual([['VfHolder', ['id']]]);
    const runtime = createRuntime(createMemoryAdapter());
    runtime.connect(null, Holder, 'vfHolder', 'vfHolders');
    expect(() => runtime.createSchema()).not.toThrow();
  });

  test('generated creates and updates write nothing for them, whatever middleware adds', async () => {
    const fixture = createFixture({
      middlewares: [({ operation, args }, next) => {
        if (operation === 'save' || operation === 'update') {
          Object.assign(args.input, { score: 7, nickname: operation === 'save' ? 'x' : null, keywords: null });
          if (args.input.address) Object.assign(args.input.address, { formatted: 'f', lines: ['l'] });
        }
        return next();
      }],
    });
    const added = await fixture.run('mutation { addvfShop(input: { name: "A", address: { street: "S" } }) { id score } }');
    expect(added.errors).toBeUndefined();
    const id = added.data.addvfShop.id;
    expect(fixture.adapter.records.get(id)).toEqual({
      _id: id, __model: 'VfShop', name: 'A', address: { street: 'S' },
    });

    const updated = await fixture.run(`mutation { updatevfShop(input: { id: "${id}", address: { street: "T" } }) { id } }`);
    expect(updated.errors).toBeUndefined();
    const [[set, unset]] = fixture.adapter.prepareUpdate.mock.calls;
    expect(set).toEqual({ id, address: { street: 'T' } });
    expect(unset).toEqual({});
    expect(fixture.adapter.records.get(id)).toEqual({
      _id: id, id, __model: 'VfShop', name: 'A', address: { street: 'T' },
    });
  });

  test('generated inputs leave them out, and their result types get no input', () => {
    const { schema } = createFixture();
    const fieldsOf = (name) => Object.keys(schema.getType(name).getFields());
    expect(fieldsOf('VfShopInput')).toEqual(['name', 'address', 'bookings']);
    expect(fieldsOf('VfShopInputForUpdate')).toEqual(['id', 'name', 'address', 'bookings']);
    expect(fieldsOf('VfAddressInput')).toEqual(['street']);
    expect(fieldsOf('VfBookingInput')).toEqual(['when', 'shop']);
    expect(fieldsOf('VfShopAVfBookingInputForShop')).toEqual(['when']);
    expect(schema.getType('VfRangeInput')).toBeUndefined();
    expect(schema.getType('VfStatsInput')).toBeUndefined();
  });
});

describe('virtual fields are not part of the query language', () => {
  test('list, aggregate and collection fields have no argument for them', () => {
    const { schema } = createFixture();
    const argsOf = (field) => field.args.map(({ name }) => name);
    const query = schema.getQueryType().getFields();
    expect(argsOf(query.vfShops)).toEqual(['id', 'name', 'address', 'bookings', 'pagination', 'sort', 'AND', 'OR']);
    expect(argsOf(query.vfShops_aggregate)).toEqual(['id', 'name', 'address', 'bookings', 'pagination', 'sort', 'AND', 'OR',
      'aggregation']);
    expect(argsOf(query.vfBookings).slice(0, 3)).toEqual(['id', 'when', 'shop']);
    expect(argsOf(query.vfBookings)).not.toContain('label');
    expect(argsOf(schema.getType('VfShop').getFields().bookings)).toEqual(['id', 'when', 'pagination', 'sort', 'AND', 'OR']);
  });

  test('a top-level filter argument for one fails validation', async () => {
    const { run, adapter } = createFixture();
    const result = await run('{ vfShops(score: { operator: EQ, value: 1 }) { id } }');
    expect(result.errors[0].message).toMatch(/^Unknown argument "score" on field "RootQueryType\.vfShops"\./);
    expect(adapter.find).not.toHaveBeenCalled();
  });

  test.each([
    ['an AND condition', '{ vfShops(AND: [{ conditions: [{ field: "score", operator: EQ, value: 1 }] }]) { id } }', 'score', 'VfShop.score'],
    ['an OR condition', '{ vfShops(OR: [{ conditions: [{ field: "nickname", operator: EQ, value: "a" }] }]) { id } }', 'nickname', 'VfShop.nickname'],
    ['a sort term', '{ vfShops(sort: { terms: [{ field: "keywords", order: ASC }] }) { id } }', 'keywords', 'VfShop.keywords'],
    ['an embedded member', '{ vfShops(address: { terms: [{ path: "formatted", operator: EQ, value: "a" }] }) { id } }', 'address.formatted', 'VfAddress.formatted'],
    ['a path through a virtual object', '{ vfShops(AND: [{ conditions: [{ field: "stats", path: "visits", operator: EQ, value: 1 }] }]) { id } }', 'stats', 'VfShop.stats'],
    ['a reference path', '{ vfBookings(shop: { terms: [{ path: "score", operator: EQ, value: 1 }] }) { id } }', 'shop.score', 'VfShop.score'],
    ['a collection filter', '{ vfShops { bookings(AND: [{ conditions: [{ field: "label", operator: EQ, value: "a" }] }]) { id } } }', 'label', 'VfBooking.label'],
  ])('a client path through one in %s fails with FORBIDDEN_FILTER_PATH', async (label, source, path, field) => {
    const { run, adapter } = createFixture();
    if (label === 'a collection filter') await run('mutation { addvfShop(input: { name: "A" }) { id } }');
    const result = await run(source);
    expect(errorOf(result)).toEqual({
      code: 'FORBIDDEN_FILTER_PATH', status: 403, message: `Query path ${path} uses the virtual field ${field}, which is not stored`,
    });
    expect(adapter.findChildren).not.toHaveBeenCalled();
    if (label !== 'a collection filter') expect(adapter.find).not.toHaveBeenCalled();
  });

  test.each([
    ['groupId', '{ vfShops_aggregate(aggregation: { groupId: "score", facts: [{ operation: COUNT, factName: "n", path: "id" }] }) { groupId } }', 'score'],
    ['a fact path', '{ vfShops_aggregate(aggregation: { groupId: "name", facts: [{ operation: SUM, factName: "n", path: "score" }] }) { groupId } }', 'score'],
  ])('a client %s through one fails with FORBIDDEN_FILTER_PATH', async (label, source, path) => {
    const { run, adapter } = createFixture();
    expect(errorOf(await run(source))).toEqual({
      code: 'FORBIDDEN_FILTER_PATH', status: 403, message: `Query path ${path} uses the virtual field VfShop.${path}, which is not stored`,
    });
    expect(adapter.aggregate).not.toHaveBeenCalled();
  });

  const trusted = (extra) => ({
    code: 'INVALID_MODEL', status: 500, message: expect.stringContaining(`, added by middleware or a scope, uses the virtual field ${extra}, which is not stored`),
  });

  test('a path that middleware adds through one fails with a configuration error before the adapter runs', async () => {
    const { run, adapter } = createFixture({
      middlewares: [({ operation, args }, next) => {
        if (operation === 'find' || operation === 'aggregate') {
          args.AND = [{ conditions: [{ field: 'address', path: 'formatted', operator: 'EQ', value: 'x' }] }];
        }
        return next();
      }],
    });
    expect(errorOf(await run('{ vfShops { id } }'))).toEqual(trusted('VfAddress.formatted'));
    expect(errorOf(await run('{ vfShops_aggregate(aggregation: { groupId: "name", facts: [{ operation: COUNT, factName: "n", path: "id" }] }) { groupId } }')))
      .toEqual(trusted('VfAddress.formatted'));
    expect(adapter.find).not.toHaveBeenCalled();
    expect(adapter.count).not.toHaveBeenCalled();
    expect(adapter.aggregate).not.toHaveBeenCalled();
  });

  test('a path that a find, get_by_id or joined scope adds through one fails with a configuration error', async () => {
    const shopScope = {
      find: ({ args }) => { args.score = { operator: 'EQ', value: 1 }; },
      get_by_id: ({ args }) => { args.nickname = { operator: 'EQ', value: 'x' }; },
    };
    const { run, adapter } = createFixture({ scopes: { shop: shopScope } });
    expect(errorOf(await run('{ vfShops { id } }'))).toEqual(trusted('VfShop.score'));
    expect(errorOf(await run('{ vfShop(id: "1") { id } }'))).toEqual(trusted('VfShop.nickname'));
    // The Shop find scope, joined below the client's shop path.
    expect(errorOf(await run('{ vfBookings(shop: { terms: [{ path: "name", operator: EQ, value: "A" }] }) { id } }')))
      .toEqual(trusted('VfShop.score'));
    expect(adapter.find).not.toHaveBeenCalled();
  });

  test('a path that a collection item scope adds through one fails with a configuration error', async () => {
    const { run, adapter } = createFixture({
      scopes: { booking: { find: ({ args }) => { args.AND = [{ conditions: [{ field: 'label', operator: 'EQ', value: 'x' }] }]; } } },
    });
    const shop = await run('mutation { addvfShop(input: { name: "A" }) { id } }');
    const result = await run(`{ vfShop(id: "${shop.data.addvfShop.id}") { bookings { id } } }`);
    expect(errorOf(result)).toEqual(trusted('VfBooking.label'));
    expect(result.data.vfShop).toEqual({ bookings: null });
    expect(adapter.findChildren).not.toHaveBeenCalled();
  });

  test('trusted paths through stored fields still reach the adapter', async () => {
    const { run, adapter } = createFixture({
      scopes: { shop: { find: ({ args }) => { args.name = { operator: 'EQ', value: 'A' }; } } },
    });
    expect((await run('{ vfShops { id } }')).errors).toBeUndefined();
    expect(adapter.find).toHaveBeenCalledTimes(1);
    expect(adapter.find.mock.calls[0][2]).toEqual({ name: { operator: 'EQ', value: 'A' } });
  });
});

describe('virtual fields resolve wherever their type appears', () => {
  test('the resolver receives the record, the coerced arguments and the context', async () => {
    const seen = [];
    const fixture = createFixture({
      spies: {
        busyRanges: (parent, args, context) => seen.push(['busyRanges', parent._id, args, context.user]),
        label: (parent, args, context) => seen.push(['label', parent._id, args, context.user]),
        score: (parent, args, context) => seen.push(['score', parent._id, args, context.user]),
      },
    });
    const context = { user: 'u1' };
    const added = await fixture.run('mutation { addvfShop(input: { name: "A", address: { street: "S" }, bookings: { added: [{ when: "w" }] } }) { id score address { formatted lines } } }', undefined, context);
    expect(added.errors).toBeUndefined();
    const shopId = added.data.addvfShop.id;
    expect(added.data.addvfShop).toEqual({ id: shopId, score: 42, address: { formatted: 'S (formatted)', lines: ['S'] } });
    const bookingId = [...fixture.adapter.records.values()].find((record) => record.__model === 'VfBooking')._id;

    const byId = await fixture.run(`query ($date: String!) { vfShop(id: "${shopId}") { busyRanges(date: $date) { start end } stats { visits } raw named { label } tagged { ... on VfTag { label } } grid } }`, { date: '2026-10-18' }, context);
    expect(byId.errors).toBeUndefined();
    expect(byId.data.vfShop).toEqual({
      busyRanges: [{ start: '2026-10-18T10', end: '2026-10-18T11' }], stats: { visits: 3 }, raw: { any: 'thing' },
      named: { label: 'tag' }, tagged: [{ label: 'u' }], grid: [[1]],
    });

    const list = await fixture.run('{ vfShops { score bookings { label(locale: "es") shop { score } } } }', undefined, context);
    expect(list.errors).toBeUndefined();
    expect(list.data.vfShops).toEqual([{ score: 42, bookings: [{ label: 'w@es', shop: { score: 42 } }] }]);

    expect(seen).toEqual([
      ['score', shopId, {}, 'u1'],
      ['busyRanges', shopId, { date: '2026-10-18' }, 'u1'],
      ['score', shopId, {}, 'u1'],
      ['label', bookingId, { locale: 'es' }, 'u1'],
      ['score', shopId, {}, 'u1'],
    ]);
  });

  test('a registered entity type is a result without relation, and its relation fields still resolve', async () => {
    const fixture = createFixture();
    const shop = await fixture.run('mutation { addvfShop(input: { name: "A" }) { id } }');
    const shopId = shop.data.addvfShop.id;
    await fixture.run(`mutation { addvfBooking(input: { when: "w", shop: { id: "${shopId}" } }) { id } }`);
    const booking = [...fixture.adapter.records.values()].find((record) => record.__model === 'VfBooking');
    const result = await fixture.run(`{ vfShop(id: "${shopId}") { topBooking { when shop { name } } } }`, undefined, { topBooking: booking });
    expect(result.errors).toBeUndefined();
    expect(result.data.vfShop.topBooking).toEqual({ when: 'w', shop: { name: 'A' } });
  });

  test('a parent that a get_by_id scope hides never reaches the resolver', async () => {
    const fixture = createFixture({
      scopes: { shop: { get_by_id: ({ args }) => { args.name = { operator: 'EQ', value: 'visible' }; } } },
    });
    const hidden = await fixture.run('mutation { addvfShop(input: { name: "hidden" }) { id } }');
    fixture.calls.busyRanges.mockClear();
    const result = await fixture.run(`{ vfShop(id: "${hidden.data.addvfShop.id}") { busyRanges(date: "d") { start } } }`);
    expect(result).toEqual({ data: { vfShop: null } });
    expect(fixture.calls.busyRanges).not.toHaveBeenCalled();
  });
});

describe('virtual field introspection', () => {
  test('extensions read readOnly as true for virtual fields, add no metadata field, and are unchanged for others', async () => {
    const { schema } = createFixture();
    const result = await graphql({
      schema,
      source: '{ shop: __type(name: "VfShop") { fields { name extensions { readOnly relation { embedded } } } } address: __type(name: "VfAddress") { fields { name extensions { readOnly } } } meta: __type(name: "FieldExtensionsType") { fields { name } } }',
    });
    expect(result.errors).toBeUndefined();
    const byName = (type) => Object.fromEntries(type.fields.map(({ name, extensions }) => [name, extensions]));
    const shop = byName(result.data.shop);
    for (const name of VIRTUAL_NAMES) expect(shop[name]).toEqual({ readOnly: true, relation: null });
    expect(shop.name).toEqual({ readOnly: null, relation: null });
    expect(shop.address).toEqual({ readOnly: null, relation: { embedded: true } });
    expect(byName(result.data.address)).toEqual({
      street: { readOnly: null },
      formatted: { readOnly: true },
      lines: { readOnly: true },
    });
    expect(result.data.meta.fields.map(({ name }) => name)).toEqual(['relation', 'stateMachine', 'readOnly']);
  });
});

describe('virtual fields change nothing else', () => {
  // The output fields virtual fields add, and the types only they reach.
  const withoutVirtualParts = (sdl) => sdl
    .split('\n\n')
    .filter((block) => !/^(type VfRange|type VfStats|scalar VfJSON|interface VfNamed|type VfTag|union VfTagUnion)\b/.test(block))
    .map((block) => block.split('\n').filter((line) => !new RegExp(`^  (${[...VIRTUAL_NAMES, 'formatted', 'lines', 'label'].join('|')})[(:]`).test(line)).join('\n'))
    .join('\n\n');

  test('a schema with virtual fields equals the schema without them, except for the fields themselves', () => {
    const without = createFixture({ virtual: false });
    const baseWarnings = warn.mock.calls.splice(0);
    const withVirtual = createFixture();
    const sdl = printSchema(withVirtual.schema);
    expect(sdl).toContain('busyRanges(date: String!, professionalId: ID): [VfRange!]');
    expect(withoutVirtualParts(sdl)).toBe(printSchema(without.schema));
    // They add no configuration warning either.
    expect(warn.mock.calls).toEqual(baseWarnings);
  });

  test('the registrations handed to the adapter describe the same storage with and without them', () => {
    const plain = ({ entities }) => entities.map(({ gqltype, ...entity }) => ({ ...entity, type: gqltype.name }));
    const described = (fixture) => plain(describeModels(fixture.adapter.prepare.mock.calls[0][0]));
    expect(described(createFixture())).toEqual(described(createFixture({ virtual: false })));
  });
});

describe('custom adapters', () => {
  // A custom adapter that builds its storage from the GraphQL types it receives, as the bundled
  // MongoDB model generator does, with the public helper that the adapter contract points to.
  const storedPaths = (type, prefix = '') => Object.entries(type.getFields()).flatMap(([name, field]) => {
    if (isVirtualField(field)) return [];
    const named = getNamedType(field.type);
    return field.extensions?.relation?.embedded ? storedPaths(named, `${prefix}${name}.`) : [`${prefix}${name}`];
  });

  test('receive virtual fields in prepare() and createModel(), and skip them with the public isVirtualField', () => {
    const { adapter, ShopType } = createFixture();
    const [registrations] = adapter.prepare.mock.calls[0];
    const shop = registrations.find(({ gqltype }) => gqltype === ShopType).gqltype;
    expect(adapter.createModel.mock.calls.map(([type]) => type)).toContain(shop);
    // The types still contain the virtual fields, top-level and embedded.
    expect(Object.keys(shop.getFields())).toEqual(expect.arrayContaining(VIRTUAL_NAMES));
    expect(Object.keys(shop.getFields().address.type.getFields())).toEqual(['street', 'formatted', 'lines']);
    expect(storedPaths(shop)).toEqual(['id', 'name', 'address.street', 'bookings']);
    // The same fields as describeModels() keeps.
    const [described] = describeModels(registrations).entities.filter(({ gqltype }) => gqltype === shop);
    expect(described.fields.map((field) => field.name)).toEqual(['id', 'name', 'address', 'bookings']);
    expect(described.fields.find((field) => field.name === 'address').fields.map((field) => field.name)).toEqual(['street']);
  });

  test('read the normalized options with the public virtualFieldOptions', () => {
    const { ShopType } = createFixture();
    const fields = ShopType.getFields();
    expect(virtualFieldOptions(fields.score)).toEqual({ mcp: 'tool' });
    expect(virtualFieldOptions(fields.stats)).toEqual({ mcp: 'select' });
    expect(virtualFieldOptions(fields.raw)).toEqual({ mcp: false });
    expect(virtualFieldOptions(fields.name)).toBeNull();
    expect([isVirtualField(fields.name), isVirtualField(null), isVirtualField({ extensions: { virtual: 'yes' } })]).toEqual([false, false, false]);
  });
});

describe('the warning for readOnly fields with arguments and their own resolver', () => {
  const Target = new GraphQLObjectType({ name: 'VfLegacyTarget', fields: { id: { type: GraphQLID } } });
  const Legacy = new GraphQLObjectType({
    name: 'VfLegacy',
    fields: {
      id: { type: GraphQLID },
      computed: {
        type: new GraphQLList(GraphQLString), args: { date: { type: GraphQLString } }, resolve: () => [], extensions: { readOnly: true },
      },
      embeddedWorkaround: {
        type: new GraphQLList(Target), args: { date: { type: GraphQLString } }, resolve: () => [],
        extensions: { readOnly: true, relation: { embedded: true } },
      },
      stored: {
        type: GraphQLString, args: { date: { type: GraphQLString } }, resolve: () => 's',
        extensions: {
          readOnly: true, unique: true, queryable: true, validations: { CREATE: [], UPDATE: [] },
        },
      },
      virtualOne: {
        type: GraphQLString, args: { date: { type: GraphQLString } }, resolve: () => 'v', extensions: { readOnly: true, virtual: true },
      },
      reference: {
        type: Target, args: { date: { type: GraphQLString } }, resolve: () => null, extensions: { readOnly: true, relation: {} },
      },
      noArgs: { type: GraphQLString, resolve: () => 'x', extensions: { readOnly: true } },
      writable: { type: GraphQLString, args: { date: { type: GraphQLString } }, resolve: () => 'x' },
    },
  });

  test('createSchema warns once per such field that is not virtual, a reference or a collection', () => {
    const runtime = createRuntime(createMemoryAdapter());
    runtime.connect(null, Legacy, 'vfLegacy', 'vfLegacies');
    runtime.addNoEndpointType(Target);
    runtime.createSchema();
    runtime.createSchema();
    const messages = warn.mock.calls.map(([message]) => message).filter((message) => message.includes('is not virtual'));
    // The advice also names the settings that a virtual field cannot declare.
    expect(messages).toEqual([
      ['VfLegacy.computed', ''],
      ['VfLegacy.embeddedWorkaround', ' and remove extensions.relation'],
      ['VfLegacy.stored', ' and remove unique: true, extensions.validations and queryable: true'],
    ].map(([field, removal]) => `Configuration issue: ${field} is `
      + 'readOnly and has arguments and its own resolver, but it is not virtual, so Simfinity describes it as stored '
      + 'data: backends may store it, and list queries get a filter argument for it. If its resolver computes it, '
      + `declare extensions: { virtual: true }${removal}.`));
  });

  test('following the advice for a computed embedded value builds a schema with a virtual field', () => {
    const declare = (extensions) => new GraphQLObjectType({
      name: 'VfLegacyShop',
      fields: {
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        busyRanges: {
          type: new GraphQLList(Target), args: { date: { type: GraphQLString } }, resolve: () => [], extensions,
        },
      },
    });
    const build = (extensions) => {
      const runtime = createRuntime(createMemoryAdapter());
      runtime.connect(null, declare(extensions), 'vfLegacyShop', 'vfLegacyShops');
      runtime.addNoEndpointType(Target);
      return runtime.createSchema();
    };
    // The declaration of Barber's PostgreSQL busyRanges: only adding virtual is rejected.
    const legacy = { readOnly: true, queryable: false, relation: { embedded: true } };
    expect(() => build({ ...legacy, virtual: true })).toThrow('VfLegacyShop.busyRanges is virtual, which is never stored, so it cannot declare extensions.relation');
    const { relation, ...advised } = legacy;
    expect(relation).toEqual({ embedded: true });
    const schema = build({ ...advised, virtual: true });
    expect(schema.getType('VfLegacyShop').getFields().busyRanges.extensions.virtual).toBe(true);
    expect(warn.mock.calls.filter(([message]) => message.includes('VfLegacyShop'))).toEqual([]);
  });
});
