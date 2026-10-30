import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { graphql } from 'graphql';
import { createYoga } from 'graphql-yoga';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as simfinity from '@simtlix/simfinity-js';

const databaseName = `barber_test_${randomUUID().replaceAll('-', '')}`;
const uri = new URL(process.env.MONGO || 'mongodb://127.0.0.1:57417/barber?replicaSet=rs0&directConnection=true');
uri.pathname = `/${databaseName}`;
process.env.MONGO = uri.toString();
const { schema, authPlugin, initializeApplication } = await import('../application.js');
const { closeDatabase } = await import('../database.js');
const { resolveMcpUserContext, resolveUserContext } = await import('../auth/context.js');
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
  if ((name === 'updatebooking' || name.endsWith('_booking')) && input.version == null) {
    const stored = await model('booking').findById(input.id).lean();
    input = { ...input, version: stored.version ?? 1 };
  }
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
// Confirmed bookings need a date; fixture shops have no hours or timezone, so any future UTC date fits.
const nextWeek = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
async function booking(shop, service) {
  return mutation('addbooking', { barbershop: { id: shop.id }, client: { id: user.id }, scheduledDate: nextWeek, startTime: '10:00', lines: [{ service: { id: service.id }, price: 20, durationMinutes: 30 }] }, bookingFields);
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
  const longCut = await model('service').create({ name: 'Long cut', price: 35, durationMinutes: 45, barbershop: shop._id });
  const replaced = await mutation('updatebooking', { id: created.id, lines: [{ service: { id: String(longCut._id) }, price: 35, durationMinutes: 45 }] }, bookingFields);
  assert.equal(replaced.totalPrice, 35);
  assert.equal(replaced.endTime, '11:45');
  const stored = await model('booking').findById(created.id).lean();
  assert.equal(stored.totalPrice, 35);
  assert.equal(stored.endTime, '11:45');
});

test('confirmed bookings reject overlaps, expose only busy times and serialize concurrent creates', async () => {
  const { shop, service } = await fixture();
  await model('barbershop').updateOne({ _id: shop._id }, { bufferMinutes: 10 });
  const [first, second] = await model('professional').create([{ name: 'First', barbershop: shop._id }, { name: 'Second', barbershop: shop._id }]);
  const scheduledDate = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const add = (professional, startTime) => ({
    barbershop: { id: shop.id }, client: { id: user.id }, scheduledDate, startTime,
    ...(professional ? { professional: { id: String(professional._id) } } : {}),
    lines: [{ service: { id: service.id }, price: 20, durationMinutes: 0 }],
  });
  const code = (result) => result.errors?.[0]?.extensions?.code;
  const held = await mutation('addbooking', add(first, '10:00'), bookingFields);
  assert.equal(held.endTime, '10:30', 'Durations come from the service, not the client');
  assert.equal(code(await mutation('addbooking', add(first, '10:35'), 'id', true)), 'BOOKING_SLOT_UNAVAILABLE');
  assert.equal(code(await mutation('addbooking', add(null, '10:00'), 'id', true)), 'BOOKING_SLOT_UNAVAILABLE');
  assert.equal(code(await mutation('addbooking', { ...add(first, '10:00'), scheduledDate: '2020-01-01' }, 'id', true)), 'BOOKING_OUTSIDE_ADVANCE_WINDOW');
  assert.equal(code(await mutation('addbooking', { ...add(first, '10:00'), scheduledDate: null }, 'id', true)), 'INVALID_BOOKING_TIME');
  // A line without a reference, or with a negative duration, cannot shrink the booking onto another one.
  for (const lines of [[{ service: { id: service.id }, price: 20 }, { price: 0, durationMinutes: -600 }], [{ service: { id: service.id }, price: 20, durationMinutes: -30 }]]) {
    assert.equal(code(await mutation('addbooking', { ...add(first, '10:10'), lines }, 'id', true)), 'INVALID_BOOKING_LINE');
  }
  const moved = await mutation('addbooking', add(second, '10:00'), 'id');
  assert.equal(code(await mutation('updatebooking', { id: moved.id, professional: { id: String(first._id) } }, 'id', true)), 'BOOKING_SLOT_UNAVAILABLE');
  const busy = await graphql({
    schema,
    source: 'query($id: ID, $date: String!, $professionalId: ID) { barbershop(id: $id) { busyRanges(date: $date, professionalId: $professionalId) { startTime endTime professionalId } } }',
    variableValues: { id: shop.id, date: scheduledDate, professionalId: String(first._id) },
    contextValue: context,
  });
  assert.equal(busy.errors, undefined, JSON.stringify(busy.errors));
  assert.deepEqual(busy.data.barbershop.busyRanges.map((range) => ({ ...range })), [{ startTime: '10:00', endTime: '10:30', professionalId: String(first._id) }]);

  const race = (inputs) => Promise.all(inputs.map((input) => graphql({ schema, source: 'mutation($input: bookingInput!) { addbooking(input: $input) { id } }', variableValues: { input }, contextValue: context })));
  for (const inputs of [[add(first, '14:00'), add(first, '14:00')], [add(null, '16:00'), add(second, '16:00')]]) {
    const results = await race(inputs);
    assert.equal(results.filter((result) => !result.errors).length, 1, JSON.stringify(results));
    assert.equal(code(results.find((result) => result.errors)), 'BOOKING_SLOT_UNAVAILABLE');
  }
  const locked = await model('professional').collection.findOne({ _id: first._id });
  assert.ok(locked._bookingScheduleLock > 0, 'The schedule lock writes the professional document');
  assert.equal(await model('booking').countDocuments({ barbershop: shop._id, state: 'CONFIRMED' }), 4);
});

test('edits of a started booking skip the advance window unless the booking moves', async () => {
  const { shop, service } = await fixture();
  const [professional] = await model('professional').create([{ name: 'Started', barbershop: shop._id }]);
  const scheduledDate = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  // Stored natively: the API no longer creates a booking whose time has passed.
  const started = await model('booking').create({
    barbershop: shop._id, professional: professional._id, client: user._id, scheduledDate, startTime: '10:00', endTime: '10:30',
    state: 'CONFIRMED', totalPrice: 20, lines: [{ service: service._id, price: 20, durationMinutes: 30 }],
  });
  const id = String(started._id);
  const line = { service: { id: service.id }, price: 20, durationMinutes: 0 };
  // The dashboard edit form resends the unchanged date, time and professional with the notes.
  const edited = await mutation('updatebooking', {
    id, scheduledDate, startTime: '10:00', professional: { id: String(professional._id) }, notes: 'Running late',
  }, 'notes startTime endTime');
  assert.deepEqual({ ...edited }, { notes: 'Running late', startTime: '10:00', endTime: '10:30' });
  // Only real slot changes take the schedule lock, so it counts the checks that ran.
  const checks = async () => (await model('professional').collection.findOne({ _id: professional._id }))._bookingScheduleLock ?? 0;
  assert.equal(await checks(), 0);
  const extended = await mutation('updatebooking', { id, lines: [line, line] }, 'totalPrice endTime');
  assert.deepEqual({ ...extended }, { totalPrice: 40, endTime: '11:00' });
  assert.equal(await checks(), 1);
  await mutation('updatebooking', { id, lines: [line, line], professional: { id: String(professional._id) } }, 'id');
  assert.equal(await checks(), 1, 'Resent lines with the same services and durations are not rechecked');
  const moved = await mutation('updatebooking', { id, startTime: '11:00' }, 'id', true);
  assert.equal(moved.errors[0].extensions.code, 'BOOKING_OUTSIDE_ADVANCE_WINDOW');
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

test('every booking update stores the total of the stored lines, correcting a total an earlier version stored', async () => {
  const { shop, service } = await fixture();
  const created = await booking(shop, service);
  // Earlier versions let a client write totalPrice; the next update, a transition included, corrects it (#61).
  await model('booking').updateOne({ _id: created.id }, { totalPrice: 0 });
  const cancelled = await mutation('cancelbyclient_booking', { id: created.id }, 'state totalPrice');
  assert.deepEqual({ ...cancelled }, { state: 'CANCELLED_BY_CLIENT', totalPrice: 20 });
  assert.equal((await model('booking').findById(created.id).lean()).totalPrice, 20);
});

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

// #59: a non-admin reviews a COMPLETED booking of theirs at the shop, and each booking takes one review.
test('reviews by non-admins need a completed booking of their author, once per booking', async () => {
  const { shop, service } = await fixture();
  const author = await model('user').create({ email: `client-${randomUUID()}@test.local`, name: 'Client', role: 'CLIENT' });
  const authorContext = { user: { id: String(author._id), roles: ['CLIENT'] } };
  const visit = await mutation('addbooking', { barbershop: { id: shop.id }, client: { id: String(author._id) }, scheduledDate: nextWeek, startTime: '12:00', lines: [{ service: { id: service.id }, price: 20 }] }, 'id');
  const review = { rating: 5, client: { id: String(author._id) }, barbershop: { id: shop.id }, booking: { id: visit.id } };
  const add = (input) => graphql({ schema, source: 'mutation($input: reviewInput!) { addreview(input: $input) { id } }', variableValues: { input }, contextValue: authorContext });
  const code = (result) => result.errors?.[0]?.extensions?.code;
  assert.equal(code(await add({ ...review, booking: undefined })), 'REVIEW_BOOKING_REQUIRED');
  assert.equal(code(await add(review)), 'INVALID_REVIEW_BOOKING', 'A confirmed booking cannot be reviewed yet');
  await mutation('complete_booking', { id: visit.id }, 'id state');
  // Both transactions rewrite the shop's statistics, so the later one conflicts, is retried, and then
  // finds the committed review: exactly one is stored.
  const results = await Promise.all([add(review), add(review)]);
  assert.equal(results.filter((result) => !result.errors).length, 1, JSON.stringify(results));
  assert.equal(code(results.find((result) => result.errors)), 'REVIEW_ALREADY_EXISTS');
  assert.equal(await model('review').countDocuments({ booking: visit.id }), 1);
  assert.equal((await model('barbershop').findById(shop.id)).reviewCount, 1);
});

test('booking approval and bundle duration see records created in their active transaction', async () => {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const [shop] = await model('barbershop').create([{ name: 'Pending Shop', slug: randomUUID(), owner: user._id, state: 'APPROVED' }], { session });
    const [service] = await model('service').create([{ name: 'Pending Cut', price: 25, durationMinutes: 45, barbershop: shop._id }], { session });
    const created = await simfinity.saveObject('booking', {
      barbershop: { id: String(shop._id) }, client: { id: user.id }, scheduledDate: nextWeek, startTime: '10:00',
      lines: [{ service: { id: String(service._id) }, price: 25, durationMinutes: 0 }],
    }, session, context);
    assert.equal(created.endTime, '10:45');
    const bundle = await simfinity.saveObject('bundle', { name: 'Pending Deal', price: 20, barbershop: { id: String(shop._id) }, services: [{ service: { id: String(service._id) } }] }, session, context);
    assert.equal(bundle.totalDurationMinutes, 45);
  } finally {
    if (session.inTransaction()) await session.abortTransaction();
    await session.endSession();
  }
});

// #86: catalog scopes and the owner booking branch restrict through the barbershop relation, so they
// add no barbershop queries per parent row or per resolved reference.
test('catalog scopes restrict through the barbershop relation without reading shops per row or reference', async () => {
  const owner = await model('user').create({ email: `owner-${randomUUID()}@test.local`, name: 'Scope Owner', role: 'OWNER' });
  const marker = randomUUID();
  for (const [index, state] of ['APPROVED', 'APPROVED', 'APPROVED', 'DRAFT'].entries()) {
    const shop = await model('barbershop').create({ name: `Scope ${index}`, slug: `${marker}-${index}`, owner: owner._id, state });
    const service = await model('service').create({ name: `${marker} cut ${state}`, price: 10, durationMinutes: 30, barbershop: shop._id });
    await model('professional').create({ name: `${marker} pro ${index}`, barbershop: shop._id });
    await model('bundle').create({ name: `${marker} deal ${state}`, price: 9, barbershop: shop._id, services: [{ service: service._id }] });
  }
  const contexts = {
    anonymous: { user: null },
    client: { user: { id: new mongoose.Types.ObjectId().toHexString(), roles: ['CLIENT'] } },
    owner: { user: { id: String(owner._id), roles: ['OWNER'] } },
  };
  const operations = [];
  const shopReads = () => operations.filter((operation) => operation.startsWith('barbershop.'));
  mongoose.set('debug', (collection, method) => { operations.push(`${collection}.${method}`); });
  try {
    for (const [role, contextValue] of Object.entries(contexts)) {
      const visible = role === 'owner' ? ['APPROVED', 'APPROVED', 'APPROVED', 'DRAFT'] : ['APPROVED', 'APPROVED', 'APPROVED'];
      const services = await graphql({ schema, source: `{ services(name: { operator: LIKE, value: "${marker}" }) { name } }`, contextValue });
      assert.equal(services.errors, undefined, role);
      assert.deepEqual(services.data.services.map((row) => row.name).sort(), visible.map((state) => `${marker} cut ${state}`), role);

      operations.length = 0;
      const catalog = await graphql({ schema, source: `{ barbershops(slug: { operator: LIKE, value: "${marker}" }) { id services { name } professionals { name } } }`, contextValue });
      assert.equal(catalog.errors, undefined, role);
      assert.equal(catalog.data.barbershops.length, visible.length, role);
      assert.ok(catalog.data.barbershops.every((shop) => shop.services.length === 1 && shop.professionals.length === 1), role);
      assert.equal(shopReads().length, 1, `${role} nested catalog: ${shopReads().join(', ')}`);

      // Each bundle item resolves its service by ID through the service get_by_id scope.
      operations.length = 0;
      const bundles = await graphql({ schema, source: `{ bundles(name: { operator: LIKE, value: "${marker}" }) { name services { service { id name } } } }`, contextValue });
      assert.equal(bundles.errors, undefined, role);
      assert.deepEqual(bundles.data.bundles.map((row) => row.services[0].service?.name).sort(), visible.map((state) => `${marker} cut ${state}`), role);
      assert.equal(shopReads().length, 0, `${role} bundle service references: ${shopReads().join(', ')}`);
    }
  } finally {
    mongoose.set('debug', false);
  }
});

// #54: suspension (user.status) blocks sign-in and renewal, and ends access tokens already issued.
test('a suspended account cannot sign in, renew its session or use an access token already issued', async () => {
  const email = `suspended-${randomUUID()}@test.local`;
  const registered = await mutation('register', { email, name: 'Suspended', password: 'password123' }, 'accessToken refreshToken user { id }');
  const header = `Bearer ${registered.accessToken}`;
  assert.equal((await resolveUserContext(header)).user.id, registered.user.id);
  await model('user').updateOne({ email }, { status: 'SUSPENDED' });
  for (const [name, input] of [['login', { email, password: 'password123' }], ['refreshSession', { refreshToken: registered.refreshToken }]]) {
    const rejected = await mutation(name, input, 'accessToken', true);
    assert.equal(rejected.errors[0].extensions.code, 'ACCOUNT_SUSPENDED', name);
  }
  const wrongPassword = await mutation('login', { email, password: 'wrong-password' }, 'accessToken', true);
  assert.equal(wrongPassword.errors[0].message, 'Invalid email or password', 'A wrong password must not reveal the suspension');
  assert.deepEqual(await resolveUserContext(header), { user: null });
  await assert.rejects(resolveMcpUserContext(header), { message: 'This account is suspended' });
  await model('user').updateOne({ email }, { status: 'ACTIVE' });
  assert.ok((await mutation('login', { email, password: 'password123' }, 'accessToken')).accessToken);
  assert.equal((await resolveUserContext(header)).user.id, registered.user.id);
});

// #128: seed:admin creates or reactivates its own admin and never promotes an account someone registered.
const backendRoot = fileURLToPath(new URL('..', import.meta.url));
const seedAdmin = (email) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['scripts/seedAdmin.js'], {
    cwd: backendRoot, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SEED_ADMIN_EMAIL: email, SEED_ADMIN_PASSWORD: 'seed-password' },
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.once('error', reject);
  child.once('close', (code) => resolve({ code, output }));
});

test('seed:admin creates or reactivates its admin but never promotes another account', async () => {
  for (const role of ['CLIENT', 'OWNER']) {
    const taken = `seed-taken-${randomUUID()}@test.local`;
    await model('user').create({ email: taken, name: 'Registrant', role, status: 'ACTIVE', passwordHash: await bcrypt.hash('registrant', 4) });
    const refused = await seedAdmin(taken);
    assert.equal(refused.code, 1, refused.output);
    assert.match(refused.output, new RegExp(`already belongs to an? ${role} account; refusing to promote it`));
    const kept = await model('user').findOne({ email: taken }).lean();
    assert.equal(kept.role, role);
    assert.ok(await bcrypt.compare('registrant', kept.passwordHash), 'The registrant keeps its password');
  }

  const email = `seed-admin-${randomUUID()}@test.local`;
  const created = await seedAdmin(email);
  assert.equal(created.code, 0, created.output);
  assert.match(created.output, /Admin created/);
  await model('user').updateOne({ email }, { status: 'SUSPENDED', passwordHash: await bcrypt.hash('changed-by-admin', 4) });
  const rerun = await seedAdmin(email);
  assert.equal(rerun.code, 0, rerun.output);
  const admin = await model('user').findOne({ email }).lean();
  assert.deepEqual([admin.role, admin.status], ['PLATFORM_ADMIN', 'ACTIVE']);
  assert.ok(await bcrypt.compare('changed-by-admin', admin.passwordHash), 'An existing admin keeps its password');
});

// #131: stdio MCP checks its credentials at startup and on every call, and renews with MCP_REFRESH_TOKEN.
// Returns { client } once the MCP handshake is done, or { error } when the process exits first.
async function startStdioMcp(env) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['scripts/mcp-stdio.js'], cwd: backendRoot, stderr: 'pipe',
    env: { ...process.env, MCP_BEARER: '', MCP_REFRESH_TOKEN: '', ...env },
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr += chunk; });
  const client = new Client({ name: 'barber-integration', version: '1.0.0' });
  try {
    await client.connect(transport);
    return { client, stderr: () => stderr };
  } catch (error) {
    await transport.close().catch(() => {});
    return { error, stderr: () => stderr };
  }
}

test('stdio MCP refuses bad credentials, renews with MCP_REFRESH_TOKEN and never falls back to anonymous', async () => {
  const password = 'password123';
  const email = `stdio-${randomUUID()}@test.local`;
  const registered = await mutation('register', { email, name: 'Stdio', password }, 'accessToken refreshToken user { id }');
  const other = await mutation('register', { email: `stdio-other-${randomUUID()}@test.local`, name: 'Other', password }, 'refreshToken');
  const { iat: _iat, exp: _exp, ...claims } = jwt.decode(registered.accessToken);
  const accessTokenExpiringAt = (exp) => jwt.sign({ ...claims, exp }, process.env.JWT_SECRET || 'dev-jwt-secret-change-in-production');
  const seconds = () => Math.floor(Date.now() / 1000);
  const ownProfile = async (client) => (await client.callTool({ name: 'users', arguments: {} })).content[0].text;

  const refusals = [
    [{ MCP_BEARER: accessTokenExpiringAt(seconds() - 5) }, /MCP_BEARER expired at/],
    [{ MCP_BEARER: 'not-a-jwt' }, /MCP_BEARER is not a valid access token/],
    [{ MCP_REFRESH_TOKEN: 'not-a-jwt' }, /MCP_REFRESH_TOKEN is not a valid refresh token/],
    [{ MCP_REFRESH_TOKEN: registered.accessToken }, /MCP_REFRESH_TOKEN is not a valid refresh token/],
    [{ MCP_BEARER: registered.accessToken, MCP_REFRESH_TOKEN: other.refreshToken }, /belong to different accounts/],
  ];
  const refused = await Promise.all(refusals.map(([env]) => startStdioMcp(env)));
  // Close every started process before asserting, or a failure leaves children that keep the test alive.
  await Promise.all(refused.map((attempt) => attempt.client?.close()));
  for (const [index, [, message]] of refusals.entries()) {
    assert.ok(refused[index].error, `mcp:stdio must exit (${message})`);
    assert.match(refused[index].stderr(), message);
  }

  // Both processes get a bearer with the same explicit expiry, far enough ahead for startup and a call.
  const exp = seconds() + 8;
  const [expiring, renewing] = await Promise.all([
    startStdioMcp({ MCP_BEARER: accessTokenExpiringAt(exp) }),
    startStdioMcp({ MCP_BEARER: accessTokenExpiringAt(exp), MCP_REFRESH_TOKEN: registered.refreshToken }),
  ]);
  try {
    assert.ok(expiring.client, expiring.stderr());
    assert.ok(renewing.client, renewing.stderr());
    // The same catalog as HTTP /mcp (mcpOptions in application.js): no password or token tools.
    const toolNames = (await renewing.client.listTools()).tools.map((tool) => tool.name);
    assert.ok(toolNames.includes('users'));
    assert.deepEqual(toolNames.filter((name) => ['login', 'register', 'registerOwner', 'refreshSession'].includes(name)), []);
    assert.ok((await ownProfile(expiring.client)).includes(email));
    await sleep(Math.max(0, exp * 1000 - Date.now()) + 1100);
    await assert.rejects(expiring.client.callTool({ name: 'users', arguments: {} }), /MCP_BEARER expired at/);
    assert.ok((await ownProfile(renewing.client)).includes(email), 'MCP_REFRESH_TOKEN renews the session in memory');
    await model('user').updateOne({ email }, { status: 'SUSPENDED' });
    await assert.rejects(renewing.client.callTool({ name: 'users', arguments: {} }), /This account is suspended/);
  } finally {
    await expiring.client?.close();
    await renewing.client?.close();
  }
});

test('a stored DRAFT shop can still be submitted only by its owner', async () => {
  const owner = await model('user').create({ email: `legacy-${randomUUID()}@test.local`, name: 'Legacy owner', role: 'OWNER' });
  const other = await model('user').create({ email: `other-${randomUUID()}@test.local`, name: 'Other owner', role: 'OWNER' });
  const shop = await model('barbershop').create({ name: 'Legacy draft', slug: randomUUID(), owner: owner._id, state: 'DRAFT' });
  const yoga = createYoga({ schema, plugins: [authPlugin], maskedErrors: false, logging: false, context: ({ request }) => resolveUserContext(request.headers.get('authorization')) });
  const submit = async (actor) => {
    const token = jwt.sign({ sub: String(actor._id), roles: ['OWNER'] }, process.env.JWT_SECRET || 'dev-jwt-secret-change-in-production');
    const response = await yoga.fetch('http://localhost/graphql', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ query: `mutation { submitforreview_barbershop(input:{id:"${shop._id}"}){id state} }` }) });
    return response.json();
  };
  const denied = await submit(other);
  assert.equal(denied.errors?.[0].extensions.code, 'FORBIDDEN');
  assert.equal((await model('barbershop').findById(shop._id)).state, 'DRAFT');
  const result = await submit(owner);
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  assert.equal(result.data.submitforreview_barbershop.state, 'PENDING_REVIEW');
});

test('reminders follow committed writes, skip rolled-back children and report delivery failures', async () => {
  const { shop: reminderShop } = await fixture();
  const writeReminder = mutation;
  const previousEnabled = process.env.REMINDER_JOBS_ENABLED;
  const originalError = console.error;
  const events = [];
  const failures = [];
  process.env.REMINDER_JOBS_ENABLED = 'true';
  console.error = (...args) => { if (args[0] === '[reminderStub]') events.push(args); else if (args[0] === '[afterCommit]') failures.push(args); else originalError(...args); };
  try {
    const scheduledDate = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
    const input = (startTime) => ({ barbershop: { id: reminderShop.id }, scheduledDate, startTime, lines: [] });
    const created = await writeReminder('addbooking', input('09:00'), 'id version');
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], ['[reminderStub]', 'created', { bookingId: created.id, scheduledDate, startTime: '09:00' }]);
    await writeReminder('reschedule_booking', { id: created.id, version: created.version, startTime: '10:00' }, 'id');
    await writeReminder('updatebooking', { id: created.id, notes: 'No reminder for ordinary edits' }, 'id');
    await writeReminder('cancelbyclient_booking', { id: created.id }, 'id');
    assert.deepEqual(events.map((event) => event[1]), ['created', 'rescheduled', 'cancelled']);
    assert.equal(events[1][2].startTime, '10:00');
    const rejected = await writeReminder('updatebarbershop', { id: reminderShop.id, name: 'Must roll back', bookings: { added: [{ scheduledDate, startTime: '12:00', lines: [] }, { scheduledDate, startTime: 'invalid', lines: [] }] } }, 'id', true);
    assert.equal(rejected.errors[0].extensions.code, 'INVALID_BOOKING_TIME', JSON.stringify(rejected.errors));
    assert.equal(events.length, 3, 'A valid child queued before its failing sibling must not notify');
    assert.equal((await model('barbershop').findById(reminderShop.id)).name, reminderShop.name);
    // A delivery failure happens after persistence and is reported without rejecting the mutation.
    console.error = (...args) => { if (args[0] === '[reminderStub]') throw new Error('Synthetic reminder failure'); else if (args[0] === '[afterCommit]') failures.push(args); else originalError(...args); };
    const committed = await writeReminder('addbooking', input('14:00'), 'id version');
    assert.ok(await model('booking').findById(committed.id));
    assert.equal(failures.length, 1);
    assert.deepEqual(failures[0].slice(0, 3), ['[afterCommit]', 'booking', 'save']);
    assert.equal(failures[0][3].message, 'Synthetic reminder failure');
  } finally {
    console.error = originalError;
    if (previousEnabled === undefined) delete process.env.REMINDER_JOBS_ENABLED;
    else process.env.REMINDER_JOBS_ENABLED = previousEnabled;
  }
  // The enabled stub must preserve stdout for MCP JSON-RPC messages.
  const reminderMcp = await startStdioMcp({ MCP_BEARER: jwt.sign({ sub: user.id, roles: ['PLATFORM_ADMIN'] }, process.env.JWT_SECRET || 'dev-jwt-secret-change-in-production'), REMINDER_JOBS_ENABLED: 'true' });
  assert.ok(reminderMcp.client, reminderMcp.stderr());
  const protocolErrors = [];
  reminderMcp.client.onerror = (error) => { protocolErrors.push(error); };
  try {
    const response = await reminderMcp.client.callTool({ name: 'addbooking', arguments: { input: {
      barbershop: { id: reminderShop.id }, scheduledDate: new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10), startTime: '16:00', lines: [],
    } } });
    assert.ok(!response.isError, JSON.stringify(response));
    assert.deepEqual(protocolErrors, [], 'Reminder diagnostics must not enter the JSON-RPC stream');
    assert.match(reminderMcp.stderr(), /\[reminderStub\] created/);
  } finally {
    await reminderMcp.client.close();
  }
});
