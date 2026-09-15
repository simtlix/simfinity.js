import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createYoga } from 'graphql-yoga';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as simfinity from '@simtlix/simfinity-postgres';
import { generateMCPTools, createHTTPMCPHandler } from '@simtlix/simfinity-mcp';

process.env.DATABASE_SCHEMA = `test_${randomUUID().replaceAll('-', '')}`;
const { schema, authPlugin, initializeApplication } = await import('../application.js');
const { pool, closeDatabase, databaseSchema } = await import('../database.js');
const { buildUserContext } = await import('../auth/context.js');
const yoga = createYoga({ schema, plugins: [authPlugin], maskedErrors: false, logging: false, context: ({ request }) => buildUserContext(request.headers.get('authorization')) });
const model = (name) => simfinity.getModel(simfinity.getType(name));
let checks = 0;
async function request(query, variables = {}, token) {
  const response = await yoga.fetch('http://localhost/graphql', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) });
  return response.json();
}
async function mutation(name, input, fields = 'id', token, denied = false) {
  const type = schema.getMutationType().getFields()[name].args.find((arg) => arg.name === 'input')?.type;
  const result = await request(`mutation($input:${type}) { ${name}(input:$input) { ${fields} } }`, { input }, token);
  if (denied) { assert.ok(result.errors?.length, `${name} must fail: ${JSON.stringify(result)}`); checks++; return result; }
  assert.equal(result.errors, undefined, `${name}: ${JSON.stringify(result.errors)}`); checks++; return result.data[name];
}
const authFields = 'accessToken refreshToken user { id email name role passwordHash }';
try {
  await initializeApplication();
  const admin = await model('user').create({ email: 'admin@test.local', name: 'Admin', role: 'PLATFORM_ADMIN' });
  const adminToken = jwt.sign({ sub: admin.id, roles: ['PLATFORM_ADMIN'] }, process.env.JWT_SECRET || 'dev-jwt-secret-change-in-production');
  const owner = await mutation('registerOwner', { email: 'owner@test.local', password: 'password123', name: 'Owner' }, authFields);
  const otherOwner = await mutation('registerOwner', { email: 'other-owner@test.local', password: 'password123', name: 'Other Owner' }, authFields);
  const client = await mutation('register', { email: 'client@test.local', password: 'password123', name: 'Client' }, authFields);
  const otherClient = await mutation('register', { email: 'other@test.local', password: 'password123', name: 'Other' }, authFields);
  assert.match(client.user.id, /^[0-9a-f-]{36}$/); assert.equal(client.user.passwordHash, null); assert.equal(jwt.decode(client.accessToken).sub, client.user.id);
  await mutation('register', { email: 'CLIENT@test.local', password: 'password123', name: 'Duplicate' }, authFields, undefined, true);
  await mutation('login', { email: 'client@test.local', password: 'password123' }, authFields);
  await mutation('refreshSession', { refreshToken: client.refreshToken }, authFields);
  const race = await Promise.all([0, 1].map(() => request('mutation($input: RegisterInput!) { register(input: $input) { user { id } } }', { input: { email: 'race@test.local', name: 'Race', password: 'password123' } })));
  assert.equal(race.filter((result) => !result.errors).length, 1);
  assert.equal(race.find((result) => result.errors).errors[0].message, 'Email already registered');
  assert.equal((await model('user').find({ email: { operator: 'EQ', value: 'race@test.local' } })).length, 1);
  await mutation('updateuser', { id: client.user.id, role: 'PLATFORM_ADMIN' }, 'id', client.accessToken, true);
  await mutation('updateuser', { id: client.user.id, emailVerified: true }, 'id', client.accessToken, true);
  await mutation('updateuser', { id: otherClient.user.id, name: 'Attack' }, 'id', client.accessToken, true);
  await mutation('updateuser', { id: client.user.id, name: 'Self updated' }, 'id name', client.accessToken);
  const shop = await mutation('addbarbershop', { name: 'Shop', slug: 'shop', owner: { id: owner.user.id }, services: { added: [{ name: 'Nested cut', price: 20, durationMinutes: 30, isActive: true }] } }, 'id state services { id name }', owner.accessToken);
  assert.equal(shop.state, 'DRAFT'); assert.equal(shop.services.length, 1);
  const service = shop.services[0];
  await mutation('updateservice', { id: service.id, name: 'Attack' }, 'id', otherOwner.accessToken, true);
  await mutation('updateservice', { id: service.id, name: 'Cut' }, 'id name', owner.accessToken);
  await mutation('updatebarbershop', { id: shop.id, services: { updated: [{ id: service.id, name: 'Nested update' }] } }, 'id', owner.accessToken);
  await mutation('updateuser', { id: client.user.id, role: 'CLIENT' }, 'id', adminToken);
  await mutation('updateuser', { id: client.user.id, notifications: { added: [{ title: 'Nested own notification' }] } }, 'id', client.accessToken);
  await mutation('updatebarbershop', { id: shop.id, services: { updated: [{ id: service.id, name: 'Attack' }] } }, 'id', otherOwner.accessToken, true);
  const draft = await request('{ barbershops { id } }'); assert.equal(draft.errors, undefined); assert.equal(draft.data.barbershops.length, 0);
  await mutation('submitforreview_barbershop', { id: shop.id }, 'id state', owner.accessToken);
  await mutation('approve_barbershop', { id: shop.id }, 'id state', client.accessToken, true);
  await mutation('approve_barbershop', { id: shop.id }, 'id state', adminToken);
  const visible = await request('{ barbershops { id } }'); assert.equal(visible.data.barbershops.length, 1);
  const category = await mutation('addserviceCategory', { name: 'Cuts', barbershop: { id: shop.id } }, 'id', owner.accessToken);
  await mutation('updateservice', { id: service.id, category: { id: category.id } }, 'id', owner.accessToken);
  const professional = await mutation('addprofessional', { name: 'Alex', isActive: true, barbershop: { id: shop.id }, services: [{ service: { id: service.id } }] }, 'id', owner.accessToken);
  const bundle = await mutation('addbundle', { name: 'Deal', price: 15, barbershop: { id: shop.id }, services: [{ service: { id: service.id } }] }, 'id totalDurationMinutes', owner.accessToken);
  assert.equal(bundle.totalDurationMinutes, 30);
  await mutation('updatebundle', { id: bundle.id, price: 30 }, 'id', owner.accessToken, true);
  const bookingInput = { barbershop: { id: shop.id }, professional: { id: professional.id }, scheduledDate: '2026-10-01', startTime: '10:00', lines: [{ service: { id: service.id }, price: 20, durationMinutes: 30 }, { bundle: { id: bundle.id }, price: 15, durationMinutes: 30 }] };
  const booking = await mutation('addbooking', bookingInput, 'id state totalPrice endTime client { id }', client.accessToken);
  assert.equal(booking.state, 'CONFIRMED'); assert.equal(booking.totalPrice, 35); assert.equal(booking.endTime, '11:00'); assert.equal(booking.client.id, client.user.id);
  const clearingResults = [];
  for (const cleared of [[], null]) {
    const bookingFields = 'id totalPrice startTime endTime lines { price durationMinutes }';
    const fixtureBooking = await mutation('addbooking', bookingInput, bookingFields, client.accessToken);
    const unchangedBooking = await mutation('updatebooking', { id: fixtureBooking.id, notes: 'Keep lines' }, bookingFields, owner.accessToken);
    assert.equal(unchangedBooking.totalPrice, 35);
    assert.equal(unchangedBooking.endTime, '11:00');
    assert.deepEqual(unchangedBooking.lines, fixtureBooking.lines);
    await mutation('updatebooking', { id: fixtureBooking.id, lines: cleared }, bookingFields, owner.accessToken);
    const storedBooking = await model('booking').findById(fixtureBooking.id);
    const readBooking = await request(`{ booking(id: "${fixtureBooking.id}") { lines { price durationMinutes } } }`, {}, owner.accessToken);
    assert.equal(readBooking.errors, undefined);
    clearingResults.push({ entity: 'booking', lines: readBooking.data.booking.lines, totalPrice: storedBooking.totalPrice, endTime: storedBooking.endTime });

    const bundleFields = 'id price totalDurationMinutes services { service { id } }';
    const fixtureBundle = await mutation('addbundle', { name: 'Clearable', price: 10, barbershop: { id: shop.id }, services: [{ service: { id: service.id } }] }, bundleFields, owner.accessToken);
    const unchangedBundle = await mutation('updatebundle', { id: fixtureBundle.id, name: 'Keep services' }, bundleFields, owner.accessToken);
    assert.equal(unchangedBundle.totalDurationMinutes, 30);
    assert.deepEqual(unchangedBundle.services, fixtureBundle.services);
    await mutation('updatebundle', { id: fixtureBundle.id, services: cleared }, bundleFields, owner.accessToken);
    const storedBundle = await model('bundle').findById(fixtureBundle.id);
    const readBundle = await request(`{ bundle(id: "${fixtureBundle.id}") { services { service { id } } } }`, {}, owner.accessToken);
    assert.equal(readBundle.errors, undefined);
    clearingResults.push({ entity: 'bundle', services: readBundle.data.bundle.services, totalDurationMinutes: storedBundle.totalDurationMinutes, price: storedBundle.price });
    // Empty/null service lists retain the existing exemption from the price rule.
    await mutation('updatebundle', { id: fixtureBundle.id, price: 100 }, 'id', owner.accessToken);
    await mutation('updatebundle', { id: fixtureBundle.id, services: [{ service: { id: service.id } }] }, 'id', owner.accessToken, true);
    const afterInvalidReplacement = await model('bundle').findById(fixtureBundle.id);
    assert.deepEqual(afterInvalidReplacement.services ?? null, cleared);
    assert.equal(afterInvalidReplacement.price, 100);
    assert.equal(afterInvalidReplacement.totalDurationMinutes, 0);
    const validReplacement = await mutation('updatebundle', { id: fixtureBundle.id, price: 10, services: [{ service: { id: service.id } }] }, bundleFields, owner.accessToken);
    assert.equal(validReplacement.totalDurationMinutes, 30);
    assert.equal(validReplacement.services.length, 1);
  }
  assert.deepEqual(clearingResults, [[], null].flatMap((cleared) => [
    { entity: 'booking', lines: cleared, totalPrice: 0, endTime: '10:00' },
    { entity: 'bundle', services: cleared, totalDurationMinutes: 0, price: 10 },
  ]));
  await mutation('updatebooking', { id: booking.id, notes: 'Attack' }, 'id', otherClient.accessToken, true);
  await mutation('complete_booking', { id: booking.id }, 'id', otherOwner.accessToken, true);
  await mutation('complete_booking', { id: booking.id }, 'id state', owner.accessToken);
  await mutation('cancelbyclient_booking', { id: booking.id }, 'id', client.accessToken, true);
  const cancel = await mutation('addbooking', bookingInput, 'id', client.accessToken);
  await mutation('cancelbyclient_booking', { id: cancel.id }, 'id state', client.accessToken);
  const favoriteInput = { user: { id: client.user.id }, barbershop: { id: shop.id } };
  const favorite = await mutation('addfavorite', favoriteInput, 'id', client.accessToken);
  await mutation('addfavorite', favoriteInput, 'id', client.accessToken, true);
  await mutation('addfavorite', favoriteInput, 'id', otherClient.accessToken, true);
  await mutation('updatefavorite', { id: favorite.id, user: { id: otherClient.user.id } }, 'id', otherClient.accessToken, true);
  for (const [name, id, token] of [['deletefavorite', favorite.id, otherClient.accessToken], ['deleteservice', service.id, otherOwner.accessToken], ['deletebooking', booking.id, otherClient.accessToken]]) {
    const result = await request(`mutation { ${name}(id: "${id}") { id } }`, {}, token);
    assert.equal(result.errors?.[0]?.extensions?.code, 'FORBIDDEN', `${name}: ${JSON.stringify(result)}`);
  }
  const referencedDelete = await request(`mutation { deleteservice(id: "${service.id}") { id } }`, {}, owner.accessToken);
  assert.ok(referencedDelete.errors?.length);
  assert.ok(await model('service').findById(service.id));
  const review = await mutation('addreview', { rating: 5, client: { id: client.user.id }, barbershop: { id: shop.id }, booking: { id: booking.id } }, 'id', client.accessToken);
  assert.equal((await model('barbershop').findById(shop.id)).averageRating, 5);
  await mutation('updatereview', { id: review.id, rating: 3 }, 'id', client.accessToken);
  assert.equal((await model('barbershop').findById(shop.id)).averageRating, 3);
  await mutation('updatereview', { id: review.id, rating: 4 }, 'id', otherClient.accessToken, true);
  await mutation('updatereview', { id: review.id, reply: 'Thank you' }, 'id reply', owner.accessToken);
  await mutation('updatereview', { id: review.id, barbershop: null }, 'id', client.accessToken, true);
  await mutation('addnotification', { user: { id: otherClient.user.id }, title: 'Attack' }, 'id', client.accessToken, true);
  await mutation('addnotificationPreference', { user: { id: otherClient.user.id } }, 'id', client.accessToken, true);
  await mutation('addnotificationPreference', { user: { id: client.user.id } }, 'id', client.accessToken);
  const countBefore = (await model('barbershop').find({})).length;
  await mutation('addbarbershop', { name: 'Rollback', slug: 'rollback', owner: { id: owner.user.id }, bundles: { added: [{ name: 'Invalid', price: 30, services: [{ service: { id: service.id } }] }] } }, 'id', owner.accessToken, true);
  assert.equal((await model('barbershop').find({})).length, countBefore);
  const beforeBookings = (await model('booking').find({})).length;
  await mutation('addbooking', { ...bookingInput, lines: [{ service: { id: randomUUID() }, price: 5 }] }, 'id', client.accessToken, true);
  assert.equal((await model('booking').find({})).length, beforeBookings);
  const hidden = await request(`{ user(id: "${otherClient.user.id}") { id email } }`, {}, client.accessToken); assert.notEqual(hidden.data.user?.id, otherClient.user.id);
  const protectedRelation = await request(`{ booking(id: "${booking.id}") { id client { id } } }`, {}, owner.accessToken); assert.equal(protectedRelation.data.booking.client, null);
  const catalog = await pool.query('SELECT c.conname, c.confdeltype FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1 AND c.contype=$2', [databaseSchema, 'f']);
  for (const name of ['booking__lines__service__fk', 'booking__lines__bundle__fk', 'bundle__services__service__fk', 'professional__services__service__fk']) {
    assert.ok(catalog.rows.some((row) => row.conname === name && row.confdeltype === 'a'), name);
  }
  for (const name of ['booking__lines____owner_id__fk', 'bundle__services____owner_id__fk', 'professional__services____owner_id__fk']) {
    assert.ok(catalog.rows.some((row) => row.conname === name && row.confdeltype === 'c'), name);
  }
  const mcp = generateMCPTools(schema, { schemaPlugins: [authPlugin], context: buildUserContext(`Bearer ${client.accessToken}`), selectionDepth: 0 });
  assert.ok(mcp.tools.length > 50);
  assert.ok(!(await mcp.callTool('barbershops', {})).isError);
  assert.equal((await mcp.callTool('updateuser', { input: { id: client.user.id, role: 'PLATFORM_ADMIN' } })).isError, true);
  const app = express();
  const handler = await createHTTPMCPHandler(schema, { schemaPlugins: [authPlugin], context: (req) => buildUserContext(req.headers.authorization), selectionDepth: 0 });
  app.post('/mcp', express.json(), handler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${client.accessToken}` } } });
  const mcpClient = new Client({ name: 'barber-integration', version: '1.0.0' });
  try {
    await mcpClient.connect(transport);
    assert.ok((await mcpClient.listTools()).tools.length > 50);
    assert.ok(!(await mcpClient.callTool({ name: 'barbershops', arguments: {} })).isError);
    assert.equal((await mcpClient.callTool({ name: 'updateuser', arguments: { input: { id: client.user.id, role: 'PLATFORM_ADMIN' } } })).isError, true);
  } finally {
    await mcpClient.close();
    await new Promise((resolve) => server.close(resolve));
  }
  // An error after native creation must roll back the custom auth mutation.
  const userModel = model('user');
  const originalCreate = userModel.create;
  userModel.create = async (...args) => { await originalCreate(...args); throw new Error('Later workflow failure'); };
  try {
    await mutation('register', { email: 'rollback@test.local', password: 'password123', name: 'Rollback' }, authFields, undefined, true);
  } finally { userModel.create = originalCreate; }
  assert.equal((await userModel.find({ email: { operator: 'EQ', value: 'rollback@test.local' } })).length, 0);
  // Fail after statistics update: neither new review nor parent totals may remain.
  const shopModel = model('barbershop');
  const originalUpdate = shopModel.update;
  shopModel.update = async (...args) => { await originalUpdate(...args); throw new Error('Later statistics failure'); };
  try {
    await mutation('addreview', { rating: 1, client: { id: client.user.id }, barbershop: { id: shop.id } }, 'id', client.accessToken, true);
  } finally { shopModel.update = originalUpdate; }
  assert.equal((await shopModel.findById(shop.id)).averageRating, 3);
  assert.equal((await model('review').find({})).length, 1);
  await pool.query(`INSERT INTO ${pg.escapeIdentifier(databaseSchema)}.barbershop (id, owner, name, slug, state) SELECT gen_random_uuid(), $1, 'Paged shop', 'paged-' || i, 'APPROVED' FROM generate_series(1, 105) AS i`, [owner.user.id]);
  const { getApprovedBarbershopIds, getBarbershopIdsForOwner } = await import('../types/scopeHelpers.js');
  assert.equal((await getApprovedBarbershopIds(shopModel)).length, 106);
  assert.equal((await getBarbershopIdsForOwner(shopModel, owner.user.id)).length, 106);

  console.log(`PostgreSQL integration passed: ${checks} API checks plus auth, scopes, rollback, FKs and derived-value assertions.`);
} finally {
  await pool.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(databaseSchema)} CASCADE`);
  await closeDatabase();
}
