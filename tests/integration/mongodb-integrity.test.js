import {
  afterAll, beforeAll, beforeEach, describe, expect, test, vi,
} from 'vitest';
import mongoose from 'mongoose';
import {
  GraphQLID, GraphQLList, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import { integrityFixture } from '../fixtures/mongodb-integrity.js';
import { createMongoAdapter, createRuntime } from '../../packages/mongodb/src/index.js';

const uri = process.env.SIMFINITY_MONGODB_URI;
const withMongo = uri ? describe : describe.skip;
const missingId = () => new mongoose.Types.ObjectId().toString();
const transactionOptions = { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } };
const execute = (fixture, source, variableValues, contextValue) => graphql({
  schema: fixture.schema, source, variableValues, contextValue,
});
const mutate = (fixture, verb, name, input, selection = 'id') => execute(fixture,
  `mutation($input: ${fixture.types[name].name}Input${verb === 'update' ? 'ForUpdate' : ''}!) {
    ${verb}${name.toLowerCase()}(input: $input) { ${selection} }
  }`, { input });
const remove = (fixture, name, id) => execute(fixture,
  `mutation { delete${name.toLowerCase()}(id: "${id}") { id } }`);
const expectViolation = (result, operation) => {
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0].path).toEqual([operation]);
  expect(result.errors[0].extensions).toMatchObject({ code: 'REFERENCE_CONSTRAINT_VIOLATION', status: 409 });
};
const expectInvalidId = (result, operation) => {
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0].path).toEqual([operation]);
  expect(result.errors[0].extensions).toMatchObject({ code: 'NOT_VALID_ID', status: 400 });
};

// Chained collections and a tree that reuse one private connectionField no child declares.
const privateLinkFixture = (prefix) => {
  const adapter = createMongoAdapter({ referentialIntegrity: 'transactional' });
  const runtime = createRuntime(adapter);
  runtime.preventCreatingCollection(true);
  const types = {};
  const owned = (type) => ({ type: new GraphQLList(type), extensions: { relation: { connectionField: 'owner' } } });
  types.Leaf = new GraphQLObjectType({
    name: `${prefix}Leaf`, fields: () => ({ id: { type: GraphQLID }, label: { type: GraphQLString } }),
  });
  types.Mid = new GraphQLObjectType({
    name: `${prefix}Mid`,
    fields: () => ({ id: { type: GraphQLID }, label: { type: GraphQLString }, leaves: owned(types.Leaf) }),
  });
  types.Root = new GraphQLObjectType({
    name: `${prefix}Root`,
    fields: () => ({ id: { type: GraphQLID }, label: { type: GraphQLString }, mids: owned(types.Mid) }),
  });
  types.Node = new GraphQLObjectType({
    name: `${prefix}Node`,
    fields: () => ({ id: { type: GraphQLID }, label: { type: GraphQLString }, children: owned(types.Node) }),
  });
  for (const [name, type] of Object.entries(types)) {
    const endpoint = `${prefix}${name}`.toLowerCase();
    runtime.connect(null, type, endpoint, `${endpoint}s`);
  }
  return {
    adapter, schema: runtime.createSchema(), types, model: (name) => runtime.getModel(types[name]),
  };
};

withMongo('MongoDB transactional reference integrity', () => {
  let fixture;
  const controllers = { Shop: {} };

  beforeAll(async () => {
    const dbName = `${new URL(uri).pathname.slice(1)}_integrity`;
    await mongoose.connect(uri, { dbName });
    await mongoose.connection.dropDatabase();
    fixture = integrityFixture({ controllers });
    for (const model of Object.values(fixture.models)) await model.createCollection();
    // The pre-implementation run must reach mutations so failures prove missing enforcement.
    if (fixture.adapter.initialize) await fixture.adapter.initialize();
  }, 30000);

  beforeEach(async () => {
    delete controllers.Shop.onSaving;
    delete controllers.Shop.onUpdating;
    for (const model of Object.values(fixture.models)) await model.deleteMany({});
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  test('requires explicit initialization before a protected mutation can write', async () => {
    const uninitialized = integrityFixture({ prefix: 'Uninitialized' });
    for (const model of Object.values(uninitialized.models)) await model.createCollection();
    const result = await mutate(uninitialized, 'add', 'Shop', { name: 'not ready' });
    expect(result.errors?.[0].extensions.code).toBe('MONGO_INTEGRITY_NOT_INITIALIZED');
    expect(await uninitialized.models.Shop.countDocuments()).toBe(0);
  });

  test.each([
    ['aliased reference', (id) => ({ service: { id } })],
    ['dotted storage alias', (id) => ({ dotted: { id } })],
    ['embedded object', (id) => ({ detail: { primary: { id } } })],
    ['embedded list', (id) => ({ detail: { items: [null, { service: { id } }] } })],
    ['two embedded list levels', (id) => ({ details: [null, { items: [null, { service: { id } }] }] })],
  ])('rejects missing target in %s and rolls back create and update', async (_, input) => {
    const invalid = input(missingId());
    expectViolation(await mutate(fixture, 'add', 'Shop', { name: 'invalid', ...invalid }), 'addshop');
    expect(await fixture.models.Shop.countDocuments()).toBe(0);
    const created = await mutate(fixture, 'add', 'Shop', { name: 'original' });
    expect(created.errors).toBeUndefined();
    const id = created.data.addshop.id;
    expectViolation(await mutate(fixture, 'update', 'Shop', { id, name: 'invalid', ...invalid }), 'updateshop');
    expect((await fixture.models.Shop.findById(id)).name).toBe('original');
  });

  test('commits new parents, children, private inverse keys and explicit links in one transaction', async () => {
    const service = await fixture.models.Service.create({ name: 'cut' });
    const result = await mutate(fixture, 'add', 'Shop', {
      name: 'shop', service: { id: service._id.toString() },
      children: { added: [{ name: 'child', service: { id: service._id.toString() } }] },
      notes: { added: [{ name: 'private inverse' }] },
      entries: { added: [{ name: 'scalar inverse', opaque: missingId() }] },
      links: { added: [{ service: { id: service._id.toString() } }] },
    }, 'id children { id } notes { id } entries { id } links { id }');
    expect(result.errors).toBeUndefined();
    for (const name of ['Child', 'Note', 'Entry', 'Link']) {
      expect(await fixture.models[name].countDocuments()).toBe(1);
    }
    expectViolation(await remove(fixture, 'Shop', result.data.addshop.id), 'deleteshop');
    expectViolation(await remove(fixture, 'Service', service._id.toString()), 'deleteservice');
  });

  test('rejects inferred scalar foreign keys while leaving unrelated IDs unrestricted', async () => {
    expectViolation(await mutate(fixture, 'add', 'Entry', { owner_id: missingId() }), 'addentry');
    expect((await mutate(fixture, 'add', 'Entry', { opaque: missingId() })).errors).toBeUndefined();
  });

  test('rolls back the parent and preceding valid siblings on an invalid nested child', async () => {
    const result = await mutate(fixture, 'add', 'Shop', {
      name: 'rollback', children: { added: [{ name: 'valid' }, { name: 'invalid', service: { id: missingId() } }] },
    });
    expectViolation(result, 'addshop');
    expect(await fixture.models.Shop.countDocuments()).toBe(0);
    expect(await fixture.models.Child.countDocuments()).toBe(0);
  });

  test('validates controller changes to persisted references', async () => {
    controllers.Shop.onSaving = (record) => { record.service_id = missingId(); };
    expectViolation(await mutate(fixture, 'add', 'Shop', { name: 'controller' }), 'addshop');
    expect(await fixture.models.Shop.countDocuments()).toBe(0);
    delete controllers.Shop.onSaving;
    const shop = await fixture.models.Shop.create({ name: 'original' });
    controllers.Shop.onUpdating = (id, update) => { update.$set = { service_id: missingId() }; };
    expectViolation(await mutate(fixture, 'update', 'Shop', { id: shop._id.toString(), name: 'changed' }), 'updateshop');
    expect((await fixture.models.Shop.findById(shop._id.toString())).name).toBe('original');
  });

  test('a controller cannot detach the guarded save from its transaction', async () => {
    controllers.Shop.onSaving = (record) => { record.$session(null); };
    expectViolation(await mutate(fixture, 'add', 'Shop', { service: { id: missingId() } }), 'addshop');
    expect(await fixture.models.Shop.countDocuments()).toBe(0);
  });

  test('fails closed if a save result conceals the actual stored identity', async () => {
    controllers.Shop.onSaving = (record) => {
      const save = record.save.bind(record);
      record.save = async (options) => { await save(options); return { _id: new mongoose.Types.ObjectId() }; };
    };
    expectViolation(await mutate(fixture, 'add', 'Shop', { service: { id: missingId() } }), 'addshop');
    expect(await fixture.models.Shop.countDocuments()).toBe(0);
  });

  test('restricts embedded incoming references and releases them after array replacement or unset', async () => {
    const service = await fixture.models.Service.create({ name: 'embedded' });
    const added = await mutate(fixture, 'add', 'Shop', {
      details: [{ items: [null, { service: { id: service._id.toString() } }] }],
      detail: { primary: { id: service._id.toString() } },
    });
    expect(added.errors).toBeUndefined();
    expectViolation(await remove(fixture, 'Service', service._id.toString()), 'deleteservice');
    const result = await mutate(fixture, 'update', 'Shop', { id: added.data.addshop.id, details: [], detail: null });
    expect(result.errors).toBeUndefined();
    expect((await remove(fixture, 'Service', service._id.toString())).errors).toBeUndefined();
  });

  test('supports a self-reference and deletion of its owning document', async () => {
    const service = await fixture.models.Service.create({ name: 'self' });
    expect((await mutate(fixture, 'update', 'Service', { id: service._id.toString(), related: { id: service._id.toString() } })).errors).toBeUndefined();
    expect((await remove(fixture, 'Service', service._id.toString())).errors).toBeUndefined();
  });

  test('a primary-key self-reference does not mistake other records for incoming references', async () => {
    const self = integrityFixture({
      prefix: 'PrimarySelf', selfConnectionField: '_id',
      modelFactory: (type) => type.name.endsWith('Service')
        ? mongoose.model(type.name, new mongoose.Schema({ _id: mongoose.Schema.Types.ObjectId, name: String }), type.name)
        : null,
    });
    for (const model of Object.values(self.models)) await model.createCollection();
    await self.adapter.initialize();
    const first = await self.models.Service.create({ _id: new mongoose.Types.ObjectId(), name: 'first' });
    await self.models.Service.create({ _id: new mongoose.Types.ObjectId(), name: 'second' });
    expect((await remove(self, 'Service', first._id)).errors).toBeUndefined();
    expect(await self.models.Service.countDocuments()).toBe(1);
  });

  test('keeps off mode backward compatible', async () => {
    const legacy = integrityFixture({ prefix: 'LegacyIntegrity', mode: 'off' });
    for (const model of Object.values(legacy.models)) {
      await model.createCollection();
      await model.init();
    }
    const result = await mutate(legacy, 'add', 'Shop', { service: { id: missingId() } }, 'id service { id }');
    expect(result.errors).toBeUndefined();
    expect(result.data.addshop.service).toBeNull();
    const query = legacy.adapter.update(legacy.models.Shop, result.data.addshop.id, { name: 'chainable' });
    // Consume a regressed Promise too, so a failure never leaves an unhandled database operation.
    if (!(query instanceof mongoose.Query)) await query;
    expect(query).toBeInstanceOf(mongoose.Query);
    expect((await query.select('name').lean()).name).toBe('chainable');
  });

  test('owns snapshot transactions with majority commits', async () => {
    let actual;
    controllers.Shop.onSaving = (record, args, session) => { actual = session.transaction.options; };
    expect((await mutate(fixture, 'add', 'Shop', { name: 'options' })).errors).toBeUndefined();
    expect(actual.readConcern.level).toBe('snapshot');
    expect(actual.writeConcern.w).toBe('majority');
  });

  test('rejects a supplied session without the required transaction guarantees', async () => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      await expect(fixture.runtime.saveObject(fixture.types.Shop.name, { name: 'wrong options' }, session))
        .rejects.toMatchObject({ extensions: { code: 'MONGO_INTEGRITY_TRANSACTION_OPTIONS' } });
      expect(await fixture.models.Shop.countDocuments().session(session)).toBe(0);
    } finally { await session.endSession(); }
  });

  test('a borrowed session can create parent and child, remove references and delete the target atomically', async () => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction(transactionOptions);
      const service = await fixture.runtime.saveObject(fixture.types.Service.name, { name: 'new service' }, session);
      const shop = await fixture.runtime.saveObject(fixture.types.Shop.name, { service: { id: String(service._id) } }, session);
      expect(await fixture.models.Shop.countDocuments()).toBe(0);
      await fixture.adapter.update(fixture.models.Shop, shop._id, { $unset: { service_id: '' } }, session);
      await fixture.adapter.delete(fixture.models.Service, service._id, session);
      expect(session.inTransaction()).toBe(true);
      await session.commitTransaction();
      expect(await fixture.models.Shop.countDocuments()).toBe(1);
      expect(await fixture.models.Service.countDocuments()).toBe(0);
    } finally { await session.endSession(); }
  });

  test('an integrity violation aborts a borrowed transaction even when the caller catches it', async () => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction(transactionOptions);
      await fixture.runtime.saveObject(fixture.types.Service.name, { name: 'must roll back' }, session);
      await expect(fixture.runtime.saveObject(fixture.types.Shop.name, { service: { id: missingId() } }, session))
        .rejects.toMatchObject({ extensions: { code: 'REFERENCE_CONSTRAINT_VIOLATION' } });
      expect(session.inTransaction()).toBe(false);
      await expect(session.commitTransaction()).rejects.toThrow();
      expect(await fixture.models.Service.countDocuments()).toBe(0);
      expect(await fixture.models.Shop.countDocuments()).toBe(0);
    } finally { await session.endSession(); }
  });

  test('creator locks first: concurrent delete conflicts and its retry rejects the committed reference', async () => {
    const service = await fixture.models.Service.create({ name: 'creator first' });
    const creator = await mongoose.startSession();
    const deleter = await mongoose.startSession();
    try {
      creator.startTransaction(transactionOptions);
      await fixture.runtime.saveObject(fixture.types.Shop.name, { service: { id: String(service._id) } }, creator);
      deleter.startTransaction(transactionOptions);
      await expect(fixture.adapter.delete(fixture.models.Service, service._id, deleter))
        .rejects.toMatchObject({ errorLabels: expect.arrayContaining(['TransientTransactionError']) });
      expect(deleter.inTransaction()).toBe(false);
      await creator.commitTransaction();
      expectViolation(await remove(fixture, 'Service', service._id), 'deleteservice');
      expect(await fixture.models.Shop.countDocuments()).toBe(1);
      expect(await fixture.models.Service.countDocuments()).toBe(1);
    } finally { await creator.endSession(); await deleter.endSession(); }
  });

  test('delete commits first: a creator with an old snapshot conflicts, then rejects the missing target', async () => {
    const service = await fixture.models.Service.create({ name: 'deleter first' });
    const creator = await mongoose.startSession();
    try {
      creator.startTransaction(transactionOptions);
      expect(await fixture.models.Service.findById(service._id).session(creator)).not.toBeNull();
      expect((await remove(fixture, 'Service', service._id)).errors).toBeUndefined();
      await expect(fixture.runtime.saveObject(fixture.types.Shop.name, { service: { id: String(service._id) } }, creator))
        .rejects.toMatchObject({ errorLabels: expect.arrayContaining(['TransientTransactionError']) });
      expect(creator.inTransaction()).toBe(false);
      expectViolation(await mutate(fixture, 'add', 'Shop', { service: { id: String(service._id) } }), 'addshop');
      expect(await fixture.models.Shop.countDocuments()).toBe(0);
    } finally { await creator.endSession(); }
  });

  test('a deleter with an old snapshot cannot overlook a newly committed reference', async () => {
    const service = await fixture.models.Service.create({ name: 'stale delete' });
    const deleter = await mongoose.startSession();
    try {
      deleter.startTransaction(transactionOptions);
      expect(await fixture.models.Shop.findOne().session(deleter)).toBeNull();
      expect((await mutate(fixture, 'add', 'Shop', { detail: { primary: { id: String(service._id) } } })).errors).toBeUndefined();
      await expect(fixture.adapter.delete(fixture.models.Service, service._id, deleter))
        .rejects.toMatchObject({ errorLabels: expect.arrayContaining(['TransientTransactionError']) });
      expect(deleter.inTransaction()).toBe(false);
      expectViolation(await remove(fixture, 'Service', service._id), 'deleteservice');
    } finally { await deleter.endSession(); }
  });

  test('independent runtimes and clients coordinate through database locks', async () => {
    const connection = await mongoose.createConnection(uri, { dbName: mongoose.connection.name }).asPromise();
    const peer = integrityFixture({
      prefix: 'PeerIntegrity',
      modelFactory: (type) => connection.model(type.name,
        fixture.models[type.name.slice('PeerIntegrity'.length)].schema.clone(),
        fixture.models[type.name.slice('PeerIntegrity'.length)].collection.collectionName),
    });
    let creator;
    let deleter;
    try {
      await peer.adapter.initialize();
      const service = await fixture.models.Service.create({ name: 'shared' });
      creator = await mongoose.startSession();
      deleter = await connection.startSession();
      creator.startTransaction(transactionOptions);
      await fixture.runtime.saveObject(fixture.types.Shop.name, { service: { id: String(service._id) } }, creator);
      deleter.startTransaction(transactionOptions);
      await expect(peer.adapter.delete(peer.models.Service, service._id, deleter))
        .rejects.toMatchObject({ errorLabels: expect.arrayContaining(['TransientTransactionError']) });
      expect(deleter.inTransaction()).toBe(false);
      await creator.commitTransaction();
      expectViolation(await remove(peer, 'Service', service._id), 'deleteservice');
      expect(await peer.models.Shop.countDocuments()).toBe(1);
    } finally {
      await creator?.endSession();
      await deleter?.endSession();
      await connection.close();
    }
  });

  test('initializes chained and self-referencing collections sharing a private connectionField and stores every link', async () => {
    const { adapter, schema, types, model } = privateLinkFixture('PrivateLink');
    for (const name of Object.keys(types)) await model(name).createCollection();
    await adapter.initialize();
    const run = (source, variableValues) => graphql({ schema, source, variableValues });

    const chain = await run(`mutation($input: ${types.Root.name}Input!) {
      addprivatelinkroot(input: $input) { id mids { id label leaves { id label } } }
    }`, { input: { label: 'root', mids: { added: [{ label: 'mid', leaves: { added: [{ label: 'leaf' }] } }] } } });
    expect(chain.errors).toBeUndefined();
    const root = chain.data.addprivatelinkroot;
    expect(root.mids).toEqual([{ id: expect.any(String), label: 'mid', leaves: [{ id: expect.any(String), label: 'leaf' }] }]);
    expect(String((await model('Mid').findById(root.mids[0].id).lean()).owner)).toBe(root.id);
    expect(String((await model('Leaf').findById(root.mids[0].leaves[0].id).lean()).owner)).toBe(root.mids[0].id);

    const tree = await run(`mutation($input: ${types.Node.name}Input!) {
      addprivatelinknode(input: $input) { id children { id label } }
    }`, { input: { label: 'tree', children: { added: [{ label: 'kid' }] } } });
    expect(tree.errors).toBeUndefined();
    const [kid] = tree.data.addprivatelinknode.children;
    expect(kid.label).toBe('kid');
    expect(String((await model('Node').findById(kid.id).lean()).owner)).toBe(tree.data.addprivatelinknode.id);
    // The private link is a protected reference: the parent cannot be removed while the child exists.
    expectViolation(await run(`mutation { deleteprivatelinkroot(id: "${root.id}") { id } }`), 'deleteprivatelinkroot');
  });

  test.each([
    ['update', ({ Shop }, session) => fixture.adapter.update(Shop, 'invalid', { name: 'changed' }, session)],
    ['delete', ({ Shop }, session) => fixture.adapter.delete(Shop, 'invalid', session)],
    ['update of a scalar ID', ({ Entry }, session, entry) => fixture.adapter.update(Entry, entry._id, { opaque: 'invalid' }, session)],
  ])('a direct adapter %s with a malformed ID fails with NOT_VALID_ID and aborts the supplied transaction', async (_, write) => {
    const entry = await fixture.models.Entry.create({ name: 'entry' });
    const session = await mongoose.startSession();
    try {
      session.startTransaction(transactionOptions);
      await fixture.runtime.saveObject(fixture.types.Service.name, { name: 'must roll back' }, session);
      await expect(write(fixture.models, session, entry))
        .rejects.toMatchObject({ message: 'Invalid identifier', extensions: { code: 'NOT_VALID_ID', status: 400 } });
      expect(session.inTransaction()).toBe(false);
      await expect(session.commitTransaction()).rejects.toThrow();
      expect(await fixture.models.Service.countDocuments()).toBe(0);
      expect((await fixture.models.Entry.findById(entry._id).lean()).opaque).toBeUndefined();
    } finally { await session.endSession(); }
  });

  test('generated mutations reject malformed IDs with NOT_VALID_ID and write nothing', async () => {
    const shop = await fixture.models.Shop.create({ name: 'original' });
    expectInvalidId(await mutate(fixture, 'update', 'Shop', { id: 'invalid', name: 'changed' }), 'updateshop');
    expectInvalidId(await remove(fixture, 'Shop', 'invalid'), 'deleteshop');
    expectInvalidId(await mutate(fixture, 'add', 'Shop', { name: 'bad reference', service: { id: 'invalid' } }), 'addshop');
    expectInvalidId(await mutate(fixture, 'add', 'Entry', { name: 'bad scalar', opaque: 'invalid' }), 'addentry');
    expectInvalidId(await mutate(fixture, 'update', 'Shop', {
      id: shop._id.toString(), name: 'changed', children: { deleted: ['invalid'] },
    }), 'updateshop');
    expect(await fixture.models.Shop.countDocuments()).toBe(1);
    expect((await fixture.models.Shop.findById(shop._id).lean()).name).toBe('original');
    expect(await fixture.models.Entry.countDocuments()).toBe(0);
  });

  test('a protected by-ID read leaves a supplied key setter to the query and rejects a malformed ID', async () => {
    // Maps the client's `item-<hex>` to the stored ObjectId key, as Mongoose applies it to queries.
    const setKey = vi.fn((value) => (typeof value === 'string' ? value.replace(/^item-/, '') : value));
    const adapter = createMongoAdapter({ referentialIntegrity: 'transactional' });
    const runtime = createRuntime(adapter);
    runtime.preventCreatingCollection(true);
    const Item = new GraphQLObjectType({
      name: 'IntegritySetterItem', fields: { id: { type: GraphQLID }, title: { type: GraphQLString } },
    });
    const ItemModel = mongoose.model('IntegritySetterItem', new mongoose.Schema({
      _id: { type: mongoose.Schema.Types.ObjectId, set: setKey }, title: String,
    }));
    runtime.connect(ItemModel, Item, 'integritysetteritem', 'integritysetteritems');
    const schema = runtime.createSchema();
    await ItemModel.createCollection();
    await adapter.initialize();
    const id = new mongoose.Types.ObjectId();
    await ItemModel.collection.insertOne({ _id: id, title: 'original' });
    setKey.mockClear();
    const read = (value) => graphql({
      schema, source: 'query($id: ID) { integritysetteritem(id: $id) { id title } }', variableValues: { id: value },
    });

    const found = await read(`item-${id}`);
    expect(found.errors).toBeUndefined();
    expect(found.data.integritysetteritem).toEqual({ id: String(id), title: 'original' });
    expect(setKey.mock.calls.map(([value]) => value)).toEqual([`item-${id}`]);
    expectInvalidId(await read('item-invalid'), 'integritysetteritem');
  });

  test('an owned delete that keeps conflicting with a held reference lock fails with TRANSACTION_RETRY_EXCEEDED (409)', async () => {
    const service = await fixture.models.Service.create({ name: 'held' });
    const creator = await mongoose.startSession();
    try {
      creator.startTransaction(transactionOptions);
      await fixture.runtime.saveObject(fixture.types.Shop.name, { service: { id: String(service._id) } }, creator);
      const result = await remove(fixture, 'Service', service._id);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toBe('Concurrent write could not be completed');
      expect(result.errors[0].extensions).toMatchObject({ code: 'TRANSACTION_RETRY_EXCEEDED', status: 409 });
      expect(result.errors[0].originalError.cause).toMatchObject({ code: 112 });
      await creator.commitTransaction();
      expectViolation(await remove(fixture, 'Service', service._id), 'deleteservice');
      expect(await fixture.models.Service.countDocuments()).toBe(1);
    } finally { await creator.endSession(); }
  });

  test('owned mutations retry real write conflicts without duplicating records', async () => {
    const service = await fixture.models.Service.create({ name: 'retry' });
    const blocker = await mongoose.startSession();
    let signalRetry;
    let releaseRetry;
    const retried = new Promise((resolve) => { signalRetry = resolve; });
    const released = new Promise((resolve) => { releaseRetry = resolve; });
    let attempts = 0;
    controllers.Shop.onSaving = async () => {
      attempts += 1;
      if (attempts === 2) { signalRetry(); await released; }
    };
    try {
      blocker.startTransaction(transactionOptions);
      await fixture.models.Service.updateOne({ _id: service._id }, { $set: { name: 'locked' } }).session(blocker);
      const saving = mutate(fixture, 'add', 'Shop', { service: { id: String(service._id) } });
      await retried;
      await blocker.commitTransaction();
      releaseRetry();
      expect((await saving).errors).toBeUndefined();
      expect(attempts).toBe(2);
      expect(await fixture.models.Shop.countDocuments()).toBe(1);
    } finally { releaseRetry(); await blocker.endSession(); }
  });

  test('startup rejects existing orphans and keeps the adapter unavailable', async () => {
    const invalid = integrityFixture({ prefix: 'ExistingOrphan' });
    for (const model of Object.values(invalid.models)) await model.createCollection();
    await invalid.models.Shop.create({ details: [{ items: [{ service_id: missingId() }] }] });
    await expect(invalid.adapter.initialize()).rejects.toMatchObject({ extensions: { code: 'REFERENCE_CONSTRAINT_VIOLATION' } });
    const result = await mutate(invalid, 'add', 'Service', { name: 'blocked' });
    expect(result.errors[0].extensions.code).toBe('MONGO_INTEGRITY_NOT_INITIALIZED');
    expect(await invalid.models.Service.countDocuments()).toBe(0);
  });

  test.each([
    ['dotted storage alias', 'Shop', (id) => ({ nested: { target_id: id } })],
    ['embedded object', 'Shop', (id) => ({ detail: { primary_id: id } })],
    ['two embedded list levels', 'Shop', (id) => ({ details: [null, { items: [null, { service_id: id }] }] })],
    ['string-typed reference', 'Shop', (id) => ({ service_id: id.toHexString() })],
    ['one-to-many child key', 'Child', (id) => ({ shop_id: id })],
    ['inferred scalar foreign key', 'Entry', (id) => ({ owner_id: id })],
    ['private inverse key', 'Note', (id) => ({ owner_id: id })],
    ['link entity', 'Link', (id) => ({ service_id: id })],
    ['self-reference', 'Service', (id) => ({ related_id: id })],
  ])('startup audit rejects an existing orphan in a %s', async (name, model, orphan) => {
    const audit = integrityFixture({ prefix: `AuditOrphan${name.replace(/\W/g, '')}` });
    for (const collection of Object.values(audit.models)) await collection.createCollection();
    const service = new mongoose.Types.ObjectId();
    const shop = new mongoose.Types.ObjectId();
    await audit.models.Service.collection.insertOne({ _id: service, related_id: service });
    await audit.models.Shop.collection.insertOne({ _id: shop, service_id: service, detail: { primary_id: null } });
    await audit.models.Child.collection.insertOne({ shop_id: shop, service_id: service });
    await audit.models[model].collection.insertOne(orphan(new mongoose.Types.ObjectId()));
    await expect(audit.adapter.initialize()).rejects.toMatchObject({
      message: 'Reference constraint violated', extensions: { code: 'REFERENCE_CONSTRAINT_VIOLATION', status: 409 },
    });
    expect((await mutate(audit, 'add', 'Service', { name: 'blocked' })).errors[0].extensions.code)
      .toBe('MONGO_INTEGRITY_NOT_INITIALIZED');
  });

  test.each([
    ['string', 'unlocked'],
    ['ObjectId list', [new mongoose.Types.ObjectId()]],
  ])('startup audit still rejects a %s lock field', async (name, value) => {
    const audit = integrityFixture({ prefix: `AuditLock${name.replace(/\W/g, '')}` });
    for (const collection of Object.values(audit.models)) await collection.createCollection();
    await audit.models.Service.collection.insertOne({ name: 'locked', _simfinityReferenceLock: value });
    await expect(audit.adapter.initialize())
      .rejects.toMatchObject({ extensions: { code: 'INVALID_MONGO_INTEGRITY_CONFIGURATION' } });
  });

  describe('startup audit round trips', () => {
    let connection;
    let reads;
    const monitoredFixture = (prefix) => integrityFixture({
      prefix,
      modelFactory: (type) => connection.model(type.name,
        fixture.models[type.name.slice(prefix.length)].schema.clone(), type.name),
    });

    beforeAll(async () => {
      connection = await mongoose.createConnection(uri, { dbName: mongoose.connection.name, monitorCommands: true })
        .asPromise();
      connection.getClient().on('commandStarted', ({ commandName }) => {
        if (['find', 'getMore', 'aggregate', 'count'].includes(commandName)) reads.push(commandName);
      });
    });

    beforeEach(() => { reads = []; });

    afterAll(async () => { await connection.close(); });

    test('verifies repeated targets with batched queries instead of one query per reference', async () => {
      const audit = monitoredFixture('AuditRoundTrips');
      for (const model of Object.values(audit.models)) await model.createCollection();
      const services = [0, 1, 2].map(() => new mongoose.Types.ObjectId());
      await audit.models.Service.collection.insertMany(services.map((_id) => ({ _id, related_id: _id })));
      await audit.models.Shop.collection.insertMany(Array.from({ length: 1200 }, (_, index) => {
        const service = services[index % services.length];
        return {
          service_id: service, detail: { primary_id: service, items: [null, { service_id: service }] },
          details: [null, { items: [null, { service_id: service }] }], nested: { target_id: service },
        };
      }));
      reads = [];
      await audit.adapter.initialize();
      // 6,003 stored references: one scan per model, its getMore and one batched check per target.
      expect(reads.length).toBeLessThan(20);
      expect((await mutate(audit, 'add', 'Shop', { service: { id: String(services[0]) } })).errors).toBeUndefined();
    }, 30000);

    test('reports an orphan found after the first full batch of distinct targets', async () => {
      const audit = monitoredFixture('AuditBatchBoundary');
      for (const model of Object.values(audit.models)) await model.createCollection();
      const services = Array.from({ length: 1500 }, () => new mongoose.Types.ObjectId());
      await audit.models.Service.collection.insertMany(services.map((_id) => ({ _id })));
      await audit.models.Shop.collection.insertMany(services.map((service, index) => ({
        service_id: index === 1300 ? new mongoose.Types.ObjectId() : service,
      })));
      reads = [];
      await expect(audit.adapter.initialize())
        .rejects.toMatchObject({ extensions: { code: 'REFERENCE_CONSTRAINT_VIOLATION' } });
      expect(reads.length).toBeLessThan(20);
      expect((await mutate(audit, 'add', 'Service', { name: 'blocked' })).errors[0].extensions.code)
        .toBe('MONGO_INTEGRITY_NOT_INITIALIZED');
    }, 30000);
  });

  describe('guarded write round trips', () => {
    const prefix = 'RoundTrips';
    const shopController = {};
    // Shop's reference paths to Service, in declaration order, and the post-image projection.
    const shopPaths = ['service_id', 'detail.primary_id', 'detail.items.service_id', 'nested.target_id',
      'details.primary_id', 'details.items.service_id'];
    const referenceProjection = Object.fromEntries([['_id', 1], ...shopPaths.map((path) => [path, 1])]);
    let connection;
    let guarded;
    let commands = [];
    let recording = false;
    const run = (source, variableValues) => graphql({ schema: guarded.schema, source, variableValues });
    const addShop = (input) => run(`mutation($input: ${prefix}ShopInput!) { addshop(input: $input) { id } }`, { input });
    const removeService = (id) => run(`mutation { deleteservice(id: "${id}") { id } }`);
    const items = (ids) => ({ details: [{ items: ids.map((id) => ({ service: { id: String(id) } })) }] });
    const plain = (value) => JSON.parse(JSON.stringify(value));
    const lockedServices = async () => plain((await guarded.models.Service.collection
      .find({ _simfinityReferenceLock: { $exists: true } }, { projection: { _id: 1 } }).toArray()).map(({ _id }) => _id)).sort();
    // The commands the body sends, by name and by collection without the fixture prefix.
    const record = async (body) => {
      commands = [];
      recording = true;
      try { return await body(); } finally { recording = false; }
    };
    const sent = (name, collection) => commands.filter((entry) => entry.name === name && entry.collection === collection);
    // The guarded post-image read of one stored Shop: by its _id, with the reference-path projection.
    const postImages = (id) => sent('find', 'Shop').filter(({ command }) => String(command.filter?._id) === String(id)
      && isDeepStrictEqual(command.projection, referenceProjection));
    // Reference probes of a guarded delete: existence queries by reference path, reading only _id.
    const probes = () => commands.filter(({ name, command }) => name === 'find' && command.filter && !('_id' in command.filter)
      && isDeepStrictEqual(command.projection, { _id: 1 }));
    // The distinct Service targets of one write: one existence read and one lock write, each with every id.
    const expectOneLockBatch = (ids) => {
      const expected = plain(ids).sort();
      const reads = sent('find', 'Service').filter(({ command }) => command.filter?._id?.$in);
      expect(reads.map(({ command }) => [plain(command.filter._id.$in).sort(), command.projection]))
        .toEqual([[expected, { _id: 1 }]]);
      const writes = sent('update', 'Service');
      expect(writes).toHaveLength(1);
      expect(writes[0].command.updates).toHaveLength(1);
      expect(writes[0].command.updates[0].multi).toBe(true);
      expect(plain(writes[0].command.updates[0].q._id.$in).sort()).toEqual(expected);
    };
    const planNodes = (node, nodes = []) => {
      if (Array.isArray(node)) node.forEach((child) => planNodes(child, nodes));
      else if (node && typeof node === 'object') {
        if (typeof node.stage === 'string') nodes.push({ stage: node.stage, indexName: node.indexName });
        Object.values(node).forEach((child) => planNodes(child, nodes));
      }
      return nodes;
    };

    beforeAll(async () => {
      connection = await mongoose.createConnection(uri, { dbName: mongoose.connection.name, monitorCommands: true })
        .asPromise();
      connection.getClient().on('commandStarted', ({ commandName, command }) => {
        if (!recording) return;
        const collection = typeof command[commandName] === 'string' ? command[commandName].replace(prefix, '') : undefined;
        commands.push({ name: commandName, collection, command });
      });
      guarded = integrityFixture({
        prefix,
        controllers: { Shop: shopController },
        modelFactory: (type) => connection.model(type.name,
          fixture.models[type.name.slice(prefix.length)].schema.clone(), type.name),
      });
      for (const model of Object.values(guarded.models)) await model.createCollection();
      await guarded.adapter.initialize();
    }, 30000);

    beforeEach(async () => {
      delete shopController.onSaving;
      for (const model of Object.values(guarded.models)) await model.deleteMany({});
    });

    afterAll(async () => { await connection.close(); });

    test('a guarded save reads only _id and reference paths and locks each target collection with one write', async () => {
      const services = await guarded.models.Service.insertMany(Array.from({ length: 20 }, (_, index) => ({ name: `service ${index}` })));
      const ids = services.map(({ _id }) => _id);
      const created = await record(() => addShop({
        name: 'shop', service: { id: String(ids[0]) }, detail: { primary: { id: String(ids[1]) } }, ...items(ids),
      }));
      expect(created.errors).toBeUndefined();
      expect(postImages(created.data.addshop.id)).toHaveLength(1);
      expectOneLockBatch(ids);
      expect(sent('getMore', 'Service')).toEqual([]);
      expect(await lockedServices()).toEqual(plain(ids).sort());
    });

    test('a guarded update locks its targets with one write per target collection', async () => {
      const services = await guarded.models.Service.insertMany(Array.from({ length: 20 }, (_, index) => ({ name: `service ${index}` })));
      const ids = services.map(({ _id }) => _id);
      const created = await addShop({ name: 'shop', ...items(ids) });
      expect(created.errors).toBeUndefined();
      const updated = await record(() => run(`mutation($input: ${prefix}ShopInputForUpdate!) { updateshop(input: $input) { id } }`,
        { input: { id: created.data.addshop.id, name: 'renamed' } }));
      expect(updated.errors).toBeUndefined();
      expect(postImages(created.data.addshop.id)).toHaveLength(1);
      expectOneLockBatch(ids);
    });

    test('a single target keeps one single-document lock write and no existence read', async () => {
      const service = await guarded.models.Service.create({ name: 'only' });
      const created = await record(() => addShop({ name: 'shop', service: { id: String(service._id) } }));
      expect(created.errors).toBeUndefined();
      expect(sent('find', 'Service').filter(({ command }) => command.filter?._id?.$in)).toEqual([]);
      expect(sent('update', 'Service').map(({ command }) => command.updates.map(({ q, multi }) => [plain(q), !!multi])))
        .toEqual([[[{ _id: String(service._id) }, false]]]);
      expect(await lockedServices()).toEqual([String(service._id)]);
    });

    test('locks more than 1,000 distinct targets of one collection in batches of 1,000', async () => {
      const services = await guarded.models.Service.insertMany(Array.from({ length: 1500 }, (_, index) => ({ name: `s${index}` })));
      const created = await record(() => addShop({ name: 'many', ...items(services.map(({ _id }) => _id)) }));
      expect(created.errors).toBeUndefined();
      expect(sent('find', 'Service').filter(({ command }) => command.filter?._id?.$in)
        .map(({ command }) => command.filter._id.$in.length)).toEqual([1000, 500]);
      expect(sent('getMore', 'Service')).toEqual([]);
      expect(sent('update', 'Service').map(({ command }) => command.updates.map(({ q, multi }) => [q._id.$in.length, multi])))
        .toEqual([[[1000, true]], [[500, true]]]);
      expect(await lockedServices()).toHaveLength(1500);
    }, 60000);

    test('a missing target among a batch rejects the write before any lock write', async () => {
      const services = await guarded.models.Service.insertMany(Array.from({ length: 5 }, (_, index) => ({ name: `service ${index}` })));
      const result = await record(() => addShop({ name: 'missing', ...items([...services.map(({ _id }) => _id), missingId()]) }));
      expectViolation(result, 'addshop');
      expect(result.errors[0].message).toBe('Reference constraint violated');
      expect(sent('update', 'Service')).toEqual([]);
      expect(await guarded.models.Shop.countDocuments()).toBe(0);
      expect(await lockedServices()).toEqual([]);
    });

    // 3.5.9 locked targets one by one in id order: it reported this violation at once only when the
    // missing id sorted first; otherwise it conflicted on the held target and retried.
    test.each([
      ['before', '000000000000000000000001'],
      ['after', 'ffffffffffffffffffffffff'],
    ])('a missing target that sorts %s a target held by another transaction fails at once without retries', async (_, missingHex) => {
      const missing = new mongoose.Types.ObjectId(missingHex);
      const held = await guarded.models.Service.create({ name: 'held' });
      const deleter = await connection.startSession();
      const creator = await connection.startSession();
      let attempts = 0;
      try {
        deleter.startTransaction(transactionOptions);
        await guarded.adapter.delete(guarded.models.Service, held._id, deleter);
        creator.startTransaction(transactionOptions);
        await expect(guarded.runtime.saveObject(guarded.types.Shop.name, items([missing, held._id]), creator)).rejects.toMatchObject({
          message: 'Reference constraint violated', extensions: { code: 'REFERENCE_CONSTRAINT_VIOLATION', status: 409 },
        });
        expect(creator.inTransaction()).toBe(false);
        shopController.onSaving = () => { attempts += 1; };
        const owned = await addShop(items([missing, held._id]));
        expectViolation(owned, 'addshop');
        expect(owned.errors[0].message).toBe('Reference constraint violated');
        expect(attempts).toBe(1);
        await deleter.abortTransaction();
        expect(await guarded.models.Shop.countDocuments()).toBe(0);
        expect(await guarded.models.Service.countDocuments({ _id: held._id })).toBe(1);
      } finally {
        if (deleter.inTransaction()) await deleter.abortTransaction();
        await creator.endSession();
        await deleter.endSession();
      }
    }, 30000);

    test('a target deleted after the creator read its snapshot makes the batched lock conflict', async () => {
      const [a, b, c] = await guarded.models.Service.insertMany([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
      const creator = await connection.startSession();
      try {
        creator.startTransaction(transactionOptions);
        expect(await guarded.models.Service.findById(a._id).session(creator)).not.toBeNull();
        expect((await removeService(b._id)).errors).toBeUndefined();
        await expect(guarded.runtime.saveObject(guarded.types.Shop.name, items([a._id, b._id, c._id]), creator))
          .rejects.toMatchObject({ errorLabels: expect.arrayContaining(['TransientTransactionError']) });
        expect(creator.inTransaction()).toBe(false);
        expectViolation(await addShop(items([a._id, b._id, c._id])), 'addshop');
        expect(await guarded.models.Shop.countDocuments()).toBe(0);
      } finally { await creator.endSession(); }
    });

    test('an uncommitted batched lock makes a concurrent delete of each target conflict', async () => {
      const targets = await guarded.models.Service.insertMany([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
      const creator = await connection.startSession();
      const deleter = await connection.startSession();
      try {
        creator.startTransaction(transactionOptions);
        await guarded.runtime.saveObject(guarded.types.Shop.name, items(targets.map(({ _id }) => _id)), creator);
        for (const target of targets) {
          deleter.startTransaction(transactionOptions);
          await expect(guarded.adapter.delete(guarded.models.Service, target._id, deleter))
            .rejects.toMatchObject({ errorLabels: expect.arrayContaining(['TransientTransactionError']) });
          expect(deleter.inTransaction()).toBe(false);
        }
        await creator.commitTransaction();
        for (const target of targets) expectViolation(await removeService(target._id), 'deleteservice');
        expect(await guarded.models.Service.countDocuments()).toBe(3);
      } finally { await creator.endSession(); await deleter.endSession(); }
    });

    test('an uncommitted delete of one target makes the batched lock conflict', async () => {
      const [a, b, c] = await guarded.models.Service.insertMany([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
      const deleter = await connection.startSession();
      const creator = await connection.startSession();
      try {
        deleter.startTransaction(transactionOptions);
        await guarded.adapter.delete(guarded.models.Service, c._id, deleter);
        creator.startTransaction(transactionOptions);
        await expect(guarded.runtime.saveObject(guarded.types.Shop.name, items([a._id, b._id, c._id]), creator))
          .rejects.toMatchObject({ errorLabels: expect.arrayContaining(['TransientTransactionError']) });
        expect(creator.inTransaction()).toBe(false);
        await deleter.commitTransaction();
        expectViolation(await addShop(items([a._id, b._id, c._id])), 'addshop');
        expect(await guarded.models.Shop.countDocuments()).toBe(0);
      } finally { await creator.endSession(); await deleter.endSession(); }
    });

    test('a guarded update locks exactly the targets its stored document references, whatever their shape', async () => {
      const ids = Array.from({ length: 12 }, () => new mongoose.Types.ObjectId());
      const [a, b, c, d, e, f, g, h, i, j, k, l] = ids;
      await guarded.models.Service.collection.insertMany(ids.map((_id) => ({ _id, name: 'target' })));
      // Stored shapes generated writes never produce, and the targets each one locks; a value that
      // is not an ObjectId on a reference path is a violation.
      const cases = [
        [{}, []],
        [{ service_id: null, detail: null, details: null, nested: null }, []],
        [{ service_id: a, unrelated: { service_id: 'x' }, other_id: b }, [a]],
        [{ service_id: [a, b] }, [a, b]],
        [{ service_id: [a, [b, [c]]] }, [a, b, c]],
        [{ service_id: 'not an object id' }, 'violation'],
        [{ service_id: { nested: a } }, 'violation'],
        [{ service_id: 5 }, 'violation'],
        [{ details: 'scalar' }, []],
        [{ nested: true }, []],
        [{ detail: [{ primary_id: a }, null, 'x', { primary_id: b, items: [{ service_id: c }] }] }, [a, b, c]],
        [{ detail: { primary_id: [a, null] } }, [a]],
        [{ detail: { primary_id: 'string' } }, 'violation'],
        [{ detail: { items: { service_id: d } } }, [d]],
        [{ detail: { items: [null, 1, 'x', [], [[{ service_id: e }]], { service_id: null }, { service_id: [f] }] } }, [e, f]],
        [{ details: [null, { items: [null, { service_id: g }] }, 'x', 5, [{ items: [{ service_id: h }] }]] }, [g, h]],
        [{ details: [[[{ items: [[{ service_id: i }]] }]]] }, [i]],
        [{ details: [{ items: [{ service_id: 'str' }] }] }, 'violation'],
        [{ details: [{ items: [{ service_id: { a: 1 } }] }] }, 'violation'],
        [{ details: [{ items: [{ service_id: [[j]] }] }] }, [j]],
        [{ nested: { target_id: k, other: 1 } }, [k]],
        [{ nested: [{ target_id: k }, { target_id: [l] }] }, [k, l]],
        [{ nested: { target_id: [] } }, []],
        [{ 'nested.target_id': a }, []],
        [{ details: [{ items: [{ service_id: b, service: { id: c } }] }], detail: { primary_id: a, title: 't' } }, [a, b]],
      ];
      const outcomes = [];
      for (const [shape] of cases) {
        await guarded.models.Service.collection.updateMany({}, { $unset: { _simfinityReferenceLock: '' } });
        const { insertedId } = await guarded.models.Shop.collection.insertOne(shape);
        const session = await connection.startSession();
        try {
          session.startTransaction(transactionOptions);
          const error = await guarded.adapter.update(guarded.models.Shop, insertedId, { name: 'renamed' }, session)
            .then(() => null, (failure) => failure);
          if (error) {
            expect(session.inTransaction()).toBe(false);
            outcomes.push(error.extensions?.code ?? error.message);
          } else {
            await session.commitTransaction();
            outcomes.push(await lockedServices());
          }
        } finally { await session.endSession(); }
      }
      expect(outcomes).toEqual(cases.map(([, expected]) => (expected === 'violation'
        ? 'REFERENCE_CONSTRAINT_VIOLATION' : plain(expected).sort())));
    }, 30000);

    test('a guarded delete queries each referencing collection once', async () => {
      const service = await guarded.models.Service.create({ name: 'free' });
      const result = await record(() => removeService(service._id));
      expect(result.errors).toBeUndefined();
      const id = String(service._id);
      expect(probes().map(({ collection, command }) => [collection, plain(command.filter)])
        .sort(([left], [right]) => left.localeCompare(right))).toEqual([
        ['Child', { service_id: id }],
        ['Link', { service_id: id }],
        ['Service', { $and: [{ related_id: id }, { _id: { $ne: id } }] }],
        ['Shop', { $or: shopPaths.map((path) => ({ [path]: id })) }],
      ]);
    });

    test('a multi-path self-reference, including an _id reference, is probed once', async () => {
      const adapter = createMongoAdapter({ referentialIntegrity: 'transactional' });
      const runtime = createRuntime(adapter);
      runtime.preventCreatingCollection(true);
      const reference = (connectionField) => ({ relation: { connectionField } });
      const Node = new GraphQLObjectType({
        name: `${prefix}SelfNode`,
        fields: () => ({
          id: { type: GraphQLID }, name: { type: GraphQLString },
          self: { type: Node, extensions: reference('_id') },
          parent: { type: Node, extensions: reference('parent_id') },
          alias: { type: Node, extensions: reference('alias_id') },
        }),
      });
      const schema = new mongoose.Schema({
        _id: mongoose.Schema.Types.ObjectId, name: String,
        parent_id: mongoose.Schema.Types.ObjectId, alias_id: mongoose.Schema.Types.ObjectId,
      });
      schema.index({ parent_id: 1 });
      schema.index({ alias_id: 1 });
      const NodeModel = connection.model(Node.name, schema, Node.name);
      runtime.connect(NodeModel, Node, 'roundtripsnode', 'roundtripsnodes');
      const graph = runtime.createSchema();
      await NodeModel.createCollection();
      await adapter.initialize();
      const remove = (id) => graphql({ schema: graph, source: `mutation { deleteroundtripsnode(id: "${id}") { id } }` });
      const oid = () => new mongoose.Types.ObjectId();

      const self = oid();
      await NodeModel.collection.insertOne({ _id: self, name: 'self only', parent_id: self, alias_id: self });
      const freed = await record(() => remove(self));
      expect(freed.errors).toBeUndefined();
      expect(probes().filter(({ collection }) => collection === 'SelfNode')).toHaveLength(1);
      expect(await NodeModel.countDocuments({ _id: self })).toBe(0);

      for (const field of ['parent_id', 'alias_id']) {
        const target = oid();
        await NodeModel.collection.insertMany([{ _id: target, name: 'target', [field]: target }, { _id: oid(), name: 'other', [field]: target }]);
        expectViolation(await remove(target), 'deleteroundtripsnode');
        expect(await NodeModel.countDocuments({ _id: target })).toBe(1);
        expect(await NodeModel.collection.countDocuments({ _simfinityReferenceLock: { $exists: true } })).toBe(0);
      }
      const lone = oid();
      await NodeModel.collection.insertMany([{ _id: lone, name: 'lone' }, { _id: oid(), name: 'unrelated' }]);
      expect((await remove(lone)).errors).toBeUndefined();
      expect(await NodeModel.countDocuments()).toBe(5);
    });

    // Plans are checked only where every branch has one candidate index; a self-reference's _id
    // branch can legitimately use the _id index.
    test('the Shop, Child and Link probes use the index of every path they query', async () => {
      const service = await guarded.models.Service.create({ name: 'free' });
      expect((await record(() => removeService(service._id))).errors).toBeUndefined();
      const expected = { Shop: shopPaths, Child: ['service_id'], Link: ['service_id'] };
      const captured = probes().filter(({ collection }) => collection in expected);
      expect(captured.map(({ collection }) => collection).sort()).toEqual(['Child', 'Link', 'Shop']);
      const other = () => new mongoose.Types.ObjectId();
      for (const size of [0, 1000]) {
        if (size) {
          await guarded.models.Shop.collection.insertMany(Array.from({ length: size }, () => ({
            service_id: other(), detail: { primary_id: other(), items: [{ service_id: other() }] },
            nested: { target_id: other() }, details: [{ primary_id: other(), items: [{ service_id: other() }] }],
          })));
          for (const name of ['Child', 'Link']) {
            await guarded.models[name].collection.insertMany(Array.from({ length: size }, () => ({ shop_id: other(), service_id: other() })));
          }
        }
        for (const { collection, command } of captured) {
          const explained = await guarded.models[collection].collection.find(command.filter, { projection: { _id: 1 } })
            .limit(1).explain('queryPlanner');
          const nodes = planNodes(explained.queryPlanner.winningPlan);
          expect(nodes.map(({ stage }) => stage)).not.toContain('COLLSCAN');
          expect([...new Set(nodes.map(({ indexName }) => indexName).filter(Boolean))].sort())
            .toEqual(expected[collection].map((path) => `${path}_1`).sort());
        }
      }
    }, 30000);

    test.each([
      ['Shop.service_id', 'Shop', (id) => ({ service_id: id })],
      ['Shop.detail.primary_id', 'Shop', (id) => ({ detail: { primary_id: id } })],
      ['Shop.detail.items.service_id', 'Shop', (id) => ({ detail: { items: [{ service_id: id }] } })],
      ['Shop.nested.target_id', 'Shop', (id) => ({ nested: { target_id: id } })],
      ['Shop.details.primary_id', 'Shop', (id) => ({ details: [{ primary_id: id }] })],
      ['Shop.details.items.service_id', 'Shop', (id) => ({ details: [null, { items: [null, { service_id: id }] }] })],
      ['Child.service_id', 'Child', (id) => ({ service_id: id })],
      ['Link.service_id', 'Link', (id) => ({ service_id: id })],
      ['Service.related_id of another service', 'Service', (id) => ({ related_id: id })],
    ])('a single reference through %s blocks the delete of its target', async (_, collection, reference) => {
      const service = await guarded.models.Service.create({ name: 'target' });
      await guarded.models[collection].collection.insertOne(reference(service._id));
      const result = await removeService(service._id);
      expectViolation(result, 'deleteservice');
      expect(result.errors[0].message).toBe('Reference constraint violated');
      expect(await guarded.models.Service.countDocuments({ _id: service._id })).toBe(1);
      expect(await lockedServices()).toEqual([]);
    });
  });

  test.skipIf(!process.env.SIMFINITY_STANDALONE_MONGODB_URI)('startup rejects a real standalone MongoDB server', async () => {
    const connection = await mongoose.createConnection(process.env.SIMFINITY_STANDALONE_MONGODB_URI).asPromise();
    const standalone = integrityFixture({
      prefix: 'StandaloneIntegrity',
      modelFactory: (type) => connection.model(type.name,
        fixture.models[type.name.slice('StandaloneIntegrity'.length)].schema.clone(), type.name),
    });
    try {
      for (const model of Object.values(standalone.models)) await model.createCollection();
      await expect(standalone.adapter.initialize()).rejects.toMatchObject({ extensions: { code: 'MONGO_TRANSACTIONS_REQUIRED' } });
      const result = await mutate(standalone, 'add', 'Service', { name: 'blocked' });
      expect(result.errors[0].extensions.code).toBe('MONGO_INTEGRITY_NOT_INITIALIZED');
    } finally {
      for (const model of Object.values(standalone.models)) await model.collection.drop();
      await connection.close();
    }
  });

  test('startup rejects supplied models with incompatible primary keys', async () => {
    const incompatible = integrityFixture({
      prefix: 'StringKeyIntegrity',
      modelFactory: (type) => type.name.endsWith('Service')
        ? mongoose.model(type.name, new mongoose.Schema({ _id: String, related_id: mongoose.Schema.Types.ObjectId }), type.name)
        : null,
    });
    for (const model of Object.values(incompatible.models)) await model.createCollection();
    await expect(incompatible.adapter.initialize()).rejects.toMatchObject({ extensions: { code: 'INVALID_MONGO_INTEGRITY_CONFIGURATION' } });
  });

  test('aborts a deletion if model middleware redirects the guarded target', async () => {
    const redirected = integrityFixture({
      prefix: 'RedirectIntegrity',
      modelFactory: (type) => {
        if (!type.name.endsWith('Service')) return null;
        const schema = fixture.models.Service.schema.clone();
        schema.pre('findOneAndDelete', function () { this.setQuery({ _id: redirectId }); });
        return mongoose.model(type.name, schema, type.name);
      },
    });
    for (const model of Object.values(redirected.models)) await model.createCollection();
    await redirected.adapter.initialize();
    const free = await redirected.models.Service.create({ name: 'free' });
    const protectedService = await redirected.models.Service.create({ name: 'referenced' });
    const redirectId = protectedService._id;
    await redirected.models.Shop.create({ service_id: redirectId });
    expectViolation(await remove(redirected, 'Service', free._id), 'deleteservice');
    expect(await redirected.models.Service.countDocuments()).toBe(2);
  });

  test('a hidden update result cannot commit an invalid reference in a borrowed transaction', async () => {
    const hidden = integrityFixture({
      prefix: 'HiddenResultIntegrity',
      modelFactory: (type) => {
        if (!type.name.endsWith('Shop')) return null;
        const schema = fixture.models.Shop.schema.clone();
        schema.post('findOneAndUpdate', () => mongoose.overwriteMiddlewareResult(null));
        return mongoose.model(type.name, schema, type.name);
      },
    });
    for (const model of Object.values(hidden.models)) await model.createCollection();
    await hidden.adapter.initialize();
    const shop = await hidden.models.Shop.create({ name: 'original' });
    const session = await mongoose.startSession();
    try {
      session.startTransaction(transactionOptions);
      await hidden.adapter.update(hidden.models.Shop, shop._id, { service_id: missingId() }, session).catch(() => {});
      expect(session.inTransaction()).toBe(false);
      await expect(session.commitTransaction()).rejects.toThrow();
      expect((await hidden.models.Shop.findById(shop._id).lean()).service_id).toBeUndefined();
    } finally { await session.endSession(); }
  });

  test.each(['save', 'update'])('a throwing post-%s hook cannot leave an unchecked write committable', async (operation) => {
    const prefix = `${operation}PostHook`;
    const hooked = integrityFixture({
      prefix,
      modelFactory: (type) => {
        if (!type.name.endsWith('Shop')) return null;
        const schema = fixture.models.Shop.schema.clone();
        schema.post(operation === 'save' ? 'save' : 'findOneAndUpdate', (record) => {
          if (record.name === 'throw-after-write') throw new Error('Post-write hook rejected');
        });
        return mongoose.model(type.name, schema, type.name);
      },
    });
    for (const model of Object.values(hooked.models)) await model.createCollection();
    await hooked.adapter.initialize();
    const original = operation === 'update' ? await hooked.models.Shop.create({ name: 'original' }) : null;
    const session = await mongoose.startSession();
    try {
      session.startTransaction(transactionOptions);
      const writing = operation === 'save'
        ? hooked.runtime.saveObject(hooked.types.Shop.name, { name: 'throw-after-write', service: { id: missingId() } }, session)
        : hooked.adapter.update(hooked.models.Shop, original._id, { name: 'throw-after-write', service_id: missingId() }, session);
      await expect(writing).rejects.toThrow('Post-write hook rejected');
      expect(session.inTransaction()).toBe(false);
      await expect(session.commitTransaction()).rejects.toThrow();
      expect(await hooked.models.Shop.countDocuments({ name: 'throw-after-write' })).toBe(0);
      expect(await hooked.models.Shop.countDocuments()).toBe(operation === 'update' ? 1 : 0);
    } finally { await session.endSession(); }
  });

  test('HTTP GraphQL rejects an embedded reference and rolls back its mutation', async () => {
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const result = await execute(fixture, body.query, body.variables);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(result));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/graphql`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: 'mutation($input: IntegrityShopInput!) { addshop(input: $input) { id } }',
          variables: { input: { name: 'HTTP rollback', detail: { primary: { id: missingId() } } } },
        }),
      });
      expectViolation(await response.json(), 'addshop');
      expect(await fixture.models.Shop.countDocuments()).toBe(0);
    } finally { await new Promise((resolve) => server.close(resolve)); }
  });
});
