import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import mongoose from 'mongoose';
import { graphql } from 'graphql';
import * as simfinity from '@simtlix/simfinity-js';

const databaseName = `barber_test_${randomUUID().replaceAll('-', '')}`;
const uri = new URL(process.env.MONGO || 'mongodb://127.0.0.1:57417/barber?replicaSet=rs0&directConnection=true');
uri.pathname = `/${databaseName}`;
process.env.MONGO = uri.toString();
const { schema, initializeApplication } = await import('../application.js');
const { closeDatabase } = await import('../database.js');
const model = (name) => simfinity.getModel(simfinity.getType(name));
let context;
let user;

before(async () => {
  await initializeApplication();
  const created = await model('user').create({ email: 'admin@test.local', name: 'Admin', role: 'PLATFORM_ADMIN' });
  user = { ...created.toObject(), id: String(created._id) };
  context = { user: { id: user.id, roles: ['PLATFORM_ADMIN'] } };
});
after(async () => {
  try {
    if (mongoose.connection.readyState === 1) {
      assert.equal(mongoose.connection.name, databaseName);
      await mongoose.connection.dropDatabase();
    }
  } finally {
    await closeDatabase();
  }
});

async function mutation(name, input, fields = 'id', denied = false) {
  const type = schema.getMutationType().getFields()[name].args.find((arg) => arg.name === 'input').type;
  const result = await graphql({ schema, source: `mutation($input: ${type}) { ${name}(input: $input) { ${fields} } }`, variableValues: { input }, contextValue: context });
  if (denied) {
    assert.ok(result.errors?.length, `${name} must fail`);
    return result;
  }
  assert.equal(result.errors, undefined, `${name}: ${JSON.stringify(result.errors)}`);
  return result.data[name];
}

async function fixture() {
  const shop = await model('barbershop').create({ name: 'Test Shop', slug: randomUUID(), owner: user._id, state: 'APPROVED' });
  const service = await model('service').create({ name: 'Cut', price: 20, durationMinutes: 30, barbershop: shop._id });
  return {
    shop: { ...shop.toObject(), id: String(shop._id) },
    service: { ...service.toObject(), id: String(service._id) },
  };
}

const bookingFields = 'id totalPrice startTime endTime lines { price durationMinutes }';
async function booking(shop, service) {
  return mutation('addbooking', { barbershop: { id: shop.id }, client: { id: user.id }, startTime: '10:00', lines: [{ service: { id: service.id }, price: 20, durationMinutes: 30 }] }, bookingFields);
}

test('booking updates recalculate price and end time while unrelated updates preserve them', async () => {
  const { shop, service } = await fixture();
  const created = await booking(shop, service);
  assert.equal(created.totalPrice, 20);
  assert.equal(created.endTime, '10:30');
  const unchanged = await mutation('updatebooking', { id: created.id, notes: 'Preserve lines' }, bookingFields);
  assert.equal(unchanged.totalPrice, 20);
  assert.equal(unchanged.endTime, '10:30');
  const moved = await mutation('updatebooking', { id: created.id, startTime: '11:00' }, bookingFields);
  assert.equal(moved.endTime, '11:30');
  const replaced = await mutation('updatebooking', { id: created.id, lines: [{ price: 35, durationMinutes: 45 }] }, bookingFields);
  assert.equal(replaced.totalPrice, 35);
  assert.equal(replaced.endTime, '11:45');
  const stored = await model('booking').findById(created.id).lean();
  assert.equal(stored.totalPrice, 35);
  assert.equal(stored.endTime, '11:45');
});

for (const cleared of [[], null]) {
  test(`clearing booking lines with ${JSON.stringify(cleared)} resets derived values`, async () => {
    const { shop, service } = await fixture();
    const created = await booking(shop, service);
    const updated = await mutation('updatebooking', { id: created.id, lines: cleared }, bookingFields);
    assert.equal(updated.totalPrice, 0);
    assert.equal(updated.endTime, '10:00');
    const stored = await model('booking').findById(created.id).lean();
    assert.equal(stored.totalPrice, 0);
    assert.equal(stored.endTime, '10:00');
    assert.deepEqual(stored.lines ?? null, cleared);
  });
}

test('bundle updates validate price against persisted services and recalculate replacement duration', async () => {
  const { shop, service } = await fixture();
  const created = await mutation('addbundle', { name: 'Deal', price: 15, barbershop: { id: shop.id }, services: [{ service: { id: service.id } }] }, 'id totalDurationMinutes');
  assert.equal(created.totalDurationMinutes, 30);
  await mutation('updatebundle', { id: created.id, price: 20 }, 'id', true);
  assert.equal((await model('bundle').findById(created.id)).price, 15);
  const second = await model('service').create({ name: 'Long cut', price: 40, durationMinutes: 60, barbershop: shop._id });
  const updated = await mutation('updatebundle', { id: created.id, services: [{ service: { id: String(second._id) } }] }, 'id totalDurationMinutes');
  assert.equal(updated.totalDurationMinutes, 60);
  assert.equal((await model('bundle').findById(created.id)).totalDurationMinutes, 60);
});

for (const cleared of [[], null]) {
  test(`clearing bundle services with ${JSON.stringify(cleared)} resets duration and revalidates replacements`, async () => {
    const { shop, service } = await fixture();
    const created = await mutation('addbundle', { name: 'Deal', price: 15, barbershop: { id: shop.id }, services: [{ service: { id: service.id } }] }, 'id totalDurationMinutes');
    const unchanged = await mutation('updatebundle', { id: created.id, name: 'Renamed deal' }, 'id totalDurationMinutes');
    assert.equal(unchanged.totalDurationMinutes, 30);
    const updated = await mutation('updatebundle', { id: created.id, services: cleared }, 'id totalDurationMinutes');
    assert.equal(updated.totalDurationMinutes, 0);
    await mutation('updatebundle', { id: created.id, price: 100 });
    await mutation('updatebundle', { id: created.id, services: [{ service: { id: service.id } }] }, 'id', true);
    const stored = await model('bundle').findById(created.id).lean();
    assert.deepEqual(stored.services ?? null, cleared);
    assert.equal(stored.totalDurationMinutes, 0);
    assert.equal(stored.price, 100);
    const restored = await mutation('updatebundle', { id: created.id, price: 10, services: [{ service: { id: service.id } }] }, 'id totalDurationMinutes');
    assert.equal(restored.totalDurationMinutes, 30);
  });
}

test('review create, update and deletion keep parent statistics current', async () => {
  const { shop } = await fixture();
  const first = await mutation('addreview', { rating: 5, client: { id: user.id }, barbershop: { id: shop.id } });
  let stored = await model('barbershop').findById(shop.id);
  assert.equal(stored.averageRating, 5);
  assert.equal(stored.reviewCount, 1);
  await mutation('addreview', { rating: 4, client: { id: user.id }, barbershop: { id: shop.id } });
  stored = await model('barbershop').findById(shop.id);
  assert.equal(stored.averageRating, 4.5);
  assert.equal(stored.reviewCount, 2);
  await mutation('updatereview', { id: first.id, rating: 2 });
  stored = await model('barbershop').findById(shop.id);
  assert.equal(stored.averageRating, 3);
  for (const review of await model('review').find({ barbershop: shop._id })) {
    const result = await graphql({ schema, source: `mutation { deletereview(id: "${review._id}") { id } }`, contextValue: context });
    assert.equal(result.errors, undefined);
  }
  stored = await model('barbershop').findById(shop.id);
  assert.equal(stored.averageRating, null);
  assert.equal(stored.reviewCount, 0);
});

test('review statistics use the active transaction and roll back with the review', async () => {
  const { shop } = await fixture();
  await model('barbershop').updateOne({ _id: shop._id }, { averageRating: 2, reviewCount: 1 });
  await model('review').create({ rating: 2, client: user._id, barbershop: shop._id });
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    await simfinity.saveObject('review', { rating: 4, client: { id: user.id }, barbershop: { id: shop.id } }, session, context);
    const inside = await model('barbershop').findById(shop.id).session(session);
    assert.equal(inside.averageRating, 3);
    assert.equal(inside.reviewCount, 2);
    const outside = await model('barbershop').findById(shop.id);
    assert.equal(outside.averageRating, 2);
    assert.equal(outside.reviewCount, 1);
  } finally {
    if (session.inTransaction()) await session.abortTransaction();
    await session.endSession();
  }
  const stored = await model('barbershop').findById(shop.id);
  assert.equal(stored.averageRating, 2);
  assert.equal(stored.reviewCount, 1);
  assert.equal(await model('review').countDocuments({ barbershop: shop._id }), 1);
});

test('booking approval and bundle duration see records created in their active transaction', async () => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const [shop] = await model('barbershop').create([{ name: 'Pending Shop', slug: randomUUID(), owner: user._id, state: 'APPROVED' }], { session });
    const [service] = await model('service').create([{ name: 'Pending Cut', price: 25, durationMinutes: 45, barbershop: shop._id }], { session });
    const created = await simfinity.saveObject('booking', { barbershop: { id: String(shop._id) }, client: { id: user.id }, startTime: '10:00', lines: [{ price: 25, durationMinutes: 45 }] }, session, context);
    assert.equal(created.endTime, '10:45');
    const bundle = await simfinity.saveObject('bundle', { name: 'Pending Deal', price: 20, barbershop: { id: String(shop._id) }, services: [{ service: { id: String(service._id) } }] }, session, context);
    assert.equal(bundle.totalDurationMinutes, 45);
  } finally {
    if (session.inTransaction()) await session.abortTransaction();
    await session.endSession();
  }
});
