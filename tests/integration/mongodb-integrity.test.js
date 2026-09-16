import {
  afterAll, beforeAll, beforeEach, describe, expect, test,
} from 'vitest';
import mongoose from 'mongoose';
import { graphql } from 'graphql';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { integrityFixture } from '../fixtures/mongodb-integrity.js';

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
    for (const model of Object.values(legacy.models)) await model.createCollection();
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
