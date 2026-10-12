import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcrypt';
import { createYoga } from 'graphql-yoga';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as simfinity from '@simtlix/simfinity-postgres';
import { generateMCPTools, createHTTPMCPHandler } from '@simtlix/simfinity-mcp';

process.env.DATABASE_SCHEMA = `test_${randomUUID().replaceAll('-', '')}`;
const { schema, authPlugin, mcpOptions, initializeApplication } = await import('../application.js');
const { pool, closeDatabase, databaseSchema } = await import('../database.js');
// The same request contexts as index.yoga.js: each request reads the caller's account.
const { resolveMcpUserContext, resolveUserContext } = await import('../auth/context.js');
const yoga = createYoga({ schema, plugins: [authPlugin], maskedErrors: false, logging: false, context: ({ request }) => resolveUserContext(request.headers.get('authorization')) });
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
  // The shop has no timezone or hours: bookings only need a future, free slot (UTC dates).
  const futureDate = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const bookingInput = { barbershop: { id: shop.id }, professional: { id: professional.id }, scheduledDate: futureDate(7), startTime: '10:00', lines: [{ service: { id: service.id }, price: 20, durationMinutes: 0 }, { bundle: { id: bundle.id }, price: 15, durationMinutes: 30 }] };
  const booking = await mutation('addbooking', bookingInput, 'id state totalPrice endTime client { id }', client.accessToken);
  assert.equal(booking.state, 'CONFIRMED'); assert.equal(booking.totalPrice, 35); assert.equal(booking.endTime, '11:00'); assert.equal(booking.client.id, client.user.id);
  const overlap = await mutation('addbooking', { ...bookingInput, startTime: '10:30' }, 'id', otherClient.accessToken, true);
  assert.equal(overlap.errors[0].extensions.code, 'BOOKING_SLOT_UNAVAILABLE');
  const past = await mutation('addbooking', { ...bookingInput, scheduledDate: '2020-01-01' }, 'id', otherClient.accessToken, true);
  assert.equal(past.errors[0].extensions.code, 'BOOKING_OUTSIDE_ADVANCE_WINDOW');
  const availability = await mutation('bookingAvailability', { barbershopId: shop.id, date: bookingInput.scheduledDate }, 'startTime endTime professionalId', otherClient.accessToken);
  assert.deepEqual(availability, [{ startTime: '10:00', endTime: '11:00', professionalId: professional.id }]);
  // Concurrent creates for one professional and slot serialize on the professional row.
  const raceInput = { ...bookingInput, startTime: '14:00' };
  const raced = await Promise.all([client, otherClient].map((user) => request('mutation($input: bookingInput!) { addbooking(input: $input) { id } }', { input: raceInput }, user.accessToken)));
  assert.equal(raced.filter((result) => !result.errors).length, 1, JSON.stringify(raced));
  assert.equal(raced.find((result) => result.errors).errors[0].extensions.code, 'BOOKING_SLOT_UNAVAILABLE');
  const clearingResults = [];
  for (const [index, cleared] of [[], null].entries()) {
    const bookingFields = 'id totalPrice startTime endTime lines { price durationMinutes }';
    const fixtureBooking = await mutation('addbooking', { ...bookingInput, scheduledDate: futureDate(8 + index) }, bookingFields, client.accessToken);
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
  // #61: every booking update stores the total of the stored lines, so the next update, a transition
  // included, corrects a total that an earlier version let a client store.
  const tampered = await mutation('addbooking', { ...bookingInput, scheduledDate: futureDate(10) }, 'id', client.accessToken);
  await pool.query(`UPDATE ${pg.escapeIdentifier(databaseSchema)}.booking SET "totalPrice" = 0 WHERE id = $1`, [tampered.id]);
  assert.deepEqual(await mutation('cancelbyclient_booking', { id: tampered.id }, 'state totalPrice', client.accessToken), { state: 'CANCELLED_BY_CLIENT', totalPrice: 35 });
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
  // #58: a booking keeps its shop, and its client cancels it instead of deleting it. The shop checks use
  // a CONFIRMED booking, which its client may otherwise edit, so only the #58 rule can refuse them.
  const confirmed = await mutation('addbooking', { ...bookingInput, scheduledDate: futureDate(11) }, 'id', client.accessToken);
  for (const token of [client.accessToken, owner.accessToken]) {
    assert.equal((await mutation('updatebooking', { id: confirmed.id, barbershop: null }, 'id', token, true)).errors[0].extensions?.code, 'FORBIDDEN');
  }
  assert.equal((await model('booking').findById(confirmed.id)).barbershop, shop.id);
  for (const [name, id, token] of [['deletefavorite', favorite.id, otherClient.accessToken], ['deleteservice', service.id, otherOwner.accessToken], ['deletebooking', booking.id, otherClient.accessToken], ['deletebooking', booking.id, client.accessToken]]) {
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
  // #57: the shop's owner flags a review; its author writes neither the reply nor the flag, and only an
  // admin deletes it. #59: a review needs its author's completed booking at the shop, once per booking.
  const failureCode = async (...args) => (await mutation(...args, true)).errors[0].extensions?.code;
  assert.equal((await mutation('updatereview', { id: review.id, isReported: true }, 'isReported', owner.accessToken)).isReported, true);
  assert.equal(await failureCode('updatereview', { id: review.id, reply: 'Forged', isReported: false }, 'id', client.accessToken), 'FORBIDDEN');
  assert.equal(await failureCode('updatereview', { id: review.id, barbershop: null }, 'id', client.accessToken), 'FORBIDDEN');
  const authorDelete = await request(`mutation { deletereview(id: "${review.id}") { id } }`, {}, client.accessToken);
  assert.equal(authorDelete.errors?.[0]?.extensions?.code, 'FORBIDDEN', JSON.stringify(authorDelete)); checks++;
  assert.equal(await failureCode('addreview', { rating: 1, client: { id: otherClient.user.id }, barbershop: { id: shop.id } }, 'id', otherClient.accessToken), 'REVIEW_BOOKING_REQUIRED');
  assert.equal(await failureCode('addreview', { rating: 5, client: { id: client.user.id }, barbershop: { id: shop.id }, booking: { id: booking.id } }, 'id', client.accessToken), 'REVIEW_ALREADY_EXISTS');
  // #62: an owner booking another owner's shop is its client.
  const ownerVisit = await mutation('addbooking', { ...bookingInput, scheduledDate: futureDate(12) }, 'id client { id }', otherOwner.accessToken);
  assert.equal(ownerVisit.client?.id, otherOwner.user.id);
  // #59: concurrent reviews of one booking both rewrite the shop's statistics row, so the later one
  // is retried, finds the committed review and fails: exactly one is stored.
  const visit = await mutation('addbooking', { ...bookingInput, scheduledDate: futureDate(13) }, 'id', otherClient.accessToken);
  await mutation('complete_booking', { id: visit.id }, 'id state', owner.accessToken);
  const visitReview = { rating: 4, client: { id: otherClient.user.id }, barbershop: { id: shop.id }, booking: { id: visit.id } };
  const racedReviews = await Promise.all([0, 1].map(() => request('mutation($input: reviewInput!) { addreview(input: $input) { id } }', { input: visitReview }, otherClient.accessToken)));
  assert.equal(racedReviews.filter((result) => !result.errors).length, 1, JSON.stringify(racedReviews));
  assert.equal(racedReviews.find((result) => result.errors).errors[0].extensions?.code, 'REVIEW_ALREADY_EXISTS');
  const visitReviews = await pool.query(`SELECT id FROM ${pg.escapeIdentifier(databaseSchema)}.review WHERE booking = $1`, [visit.id]);
  assert.equal(visitReviews.rows.length, 1);
  assert.equal((await request(`mutation { deletereview(id: "${visitReviews.rows[0].id}") { id } }`, {}, adminToken)).errors, undefined);
  checks += 2;
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
  // A context value, not a factory: pass the resolved context, never its Promise (which reads as anonymous).
  // The MCP options of index.yoga.js and mcp:stdio: no password or token tools.
  const mcp = generateMCPTools(schema, { ...mcpOptions, context: await resolveUserContext(`Bearer ${client.accessToken}`) });
  assert.ok(mcp.tools.length > 50);
  const authTools = (tools) => tools.map((tool) => tool.name).filter((name) => ['login', 'register', 'registerOwner', 'refreshSession'].includes(name));
  assert.deepEqual(authTools(mcp.tools), []);
  assert.ok(!(await mcp.callTool('barbershops', {})).isError);
  assert.equal((await mcp.callTool('updateuser', { input: { id: client.user.id, role: 'PLATFORM_ADMIN' } })).isError, true);
  const app = express();
  const handler = await createHTTPMCPHandler(schema, { ...mcpOptions, context: (req) => resolveMcpUserContext(req.headers.authorization) });
  app.all('/mcp', express.json(), handler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const mcpUrl = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  const transport = new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { authorization: `Bearer ${client.accessToken}` } } });
  const mcpClient = new Client({ name: 'barber-integration', version: '1.0.0' });
  const transportErrors = [];
  mcpClient.onerror = (error) => transportErrors.push(error.message);
  try {
    await mcpClient.connect(transport);
    const httpTools = (await mcpClient.listTools()).tools;
    assert.ok(httpTools.length > 50);
    assert.deepEqual(authTools(httpTools), []);
    assert.ok(!(await mcpClient.callTool({ name: 'barbershops', arguments: {} })).isError);
    assert.equal((await mcpClient.callTool({ name: 'updateuser', arguments: { input: { id: client.user.id, role: 'PLATFORM_ADMIN' } } })).isError, true);
    // Clients open an optional event stream with GET; 405 tells them the server offers none.
    const stream = await fetch(mcpUrl, { headers: { accept: 'text/event-stream' } });
    await stream.arrayBuffer();
    assert.equal(stream.status, 405);
    assert.deepEqual(transportErrors, []);
  } finally {
    await mcpClient.close();
    await new Promise((resolve) => server.close(resolve));
  }
  // #54: suspension (user.status) blocks sign-in and renewal, and ends access tokens already issued.
  const suspended = await mutation('register', { email: 'suspended@test.local', password: 'password123', name: 'Suspended' }, authFields);
  await model('user').update(suspended.user.id, { status: 'SUSPENDED' });
  for (const [name, input] of [['login', { email: 'suspended@test.local', password: 'password123' }], ['refreshSession', { refreshToken: suspended.refreshToken }]]) {
    assert.equal((await mutation(name, input, 'accessToken', undefined, true)).errors[0].extensions.code, 'ACCOUNT_SUSPENDED', name);
  }
  assert.equal((await mutation('login', { email: 'suspended@test.local', password: 'wrong-password' }, 'accessToken', undefined, true)).errors[0].message, 'Invalid email or password');
  assert.equal((await mutation('addfavorite', { user: { id: suspended.user.id }, barbershop: { id: shop.id } }, 'id', suspended.accessToken, true)).errors[0].extensions.code, 'UNAUTHENTICATED');
  await assert.rejects(resolveMcpUserContext(`Bearer ${suspended.accessToken}`), { message: 'This account is suspended' });
  await model('user').update(suspended.user.id, { status: 'ACTIVE' });
  await mutation('login', { email: 'suspended@test.local', password: 'password123' }, authFields);
  // #128: seed:admin creates or reactivates its own admin and never promotes an account someone registered.
  const backendRoot = fileURLToPath(new URL('..', import.meta.url));
  const seedAdmin = (email) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/seedAdmin.js'], { cwd: backendRoot, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SEED_ADMIN_EMAIL: email, SEED_ADMIN_PASSWORD: 'seed-password' } });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, output }));
  });
  const userByEmail = async (email) => (await model('user').find({ email: { operator: 'EQ', value: email } }))[0];
  for (const [email, role] of [['client@test.local', 'CLIENT'], ['owner@test.local', 'OWNER']]) {
    const refused = await seedAdmin(email);
    assert.equal(refused.code, 1, refused.output);
    assert.match(refused.output, new RegExp(`already belongs to an? ${role} account; refusing to promote it`));
    assert.equal((await userByEmail(email)).role, role);
  }
  await mutation('login', { email: 'client@test.local', password: 'password123' }, authFields); // Password unchanged.
  const created = await seedAdmin('seed-admin@test.local');
  assert.equal(created.code, 0, created.output); assert.match(created.output, /Admin created/);
  await model('user').update((await userByEmail('seed-admin@test.local')).id, { status: 'SUSPENDED', passwordHash: await bcrypt.hash('changed-by-admin', 4) });
  const rerun = await seedAdmin('seed-admin@test.local');
  assert.equal(rerun.code, 0, rerun.output);
  const reseeded = await userByEmail('seed-admin@test.local');
  assert.deepEqual([reseeded.role, reseeded.status], ['PLATFORM_ADMIN', 'ACTIVE']);
  assert.ok(await bcrypt.compare('changed-by-admin', reseeded.passwordHash), 'An existing admin keeps its password');
  // #131: stdio MCP checks its credentials at startup and on every call, and renews with MCP_REFRESH_TOKEN.
  const startStdioMcp = async (env) => {
    const stdio = new StdioClientTransport({ command: process.execPath, args: ['scripts/mcp-stdio.js'], cwd: backendRoot, stderr: 'pipe', env: { ...process.env, MCP_BEARER: '', MCP_REFRESH_TOKEN: '', ...env } });
    let stderr = '';
    stdio.stderr?.on('data', (chunk) => { stderr += chunk; });
    const stdioClient = new Client({ name: 'barber-integration', version: '1.0.0' });
    try {
      await stdioClient.connect(stdio);
      return { client: stdioClient, stderr: () => stderr };
    } catch (error) {
      await stdio.close().catch(() => {});
      return { error, stderr: () => stderr };
    }
  };
  const stdioUser = await mutation('register', { email: 'stdio@test.local', password: 'password123', name: 'Stdio' }, authFields);
  const { iat: _iat, exp: _exp, ...claims } = jwt.decode(stdioUser.accessToken);
  const accessTokenExpiringAt = (exp) => jwt.sign({ ...claims, exp }, process.env.JWT_SECRET || 'dev-jwt-secret-change-in-production');
  const seconds = () => Math.floor(Date.now() / 1000);
  const ownProfile = async (stdioClient) => (await stdioClient.callTool({ name: 'users', arguments: {} })).content[0].text;
  const refusals = [
    [{ MCP_BEARER: accessTokenExpiringAt(seconds() - 5) }, /MCP_BEARER expired at/],
    [{ MCP_BEARER: 'not-a-jwt' }, /MCP_BEARER is not a valid access token/],
    [{ MCP_REFRESH_TOKEN: 'not-a-jwt' }, /MCP_REFRESH_TOKEN is not a valid refresh token/],
    [{ MCP_REFRESH_TOKEN: stdioUser.accessToken }, /MCP_REFRESH_TOKEN is not a valid refresh token/],
    [{ MCP_BEARER: stdioUser.accessToken, MCP_REFRESH_TOKEN: otherClient.refreshToken }, /belong to different accounts/],
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
    startStdioMcp({ MCP_BEARER: accessTokenExpiringAt(exp), MCP_REFRESH_TOKEN: stdioUser.refreshToken }),
  ]);
  try {
    assert.ok(expiring.client, expiring.stderr());
    assert.ok(renewing.client, renewing.stderr());
    assert.deepEqual(authTools((await renewing.client.listTools()).tools), [], 'mcp:stdio publishes the same catalog as HTTP /mcp');
    assert.ok((await ownProfile(expiring.client)).includes('stdio@test.local'));
    await sleep(Math.max(0, exp * 1000 - Date.now()) + 1100);
    await assert.rejects(expiring.client.callTool({ name: 'users', arguments: {} }), /MCP_BEARER expired at/);
    assert.ok((await ownProfile(renewing.client)).includes('stdio@test.local'), 'MCP_REFRESH_TOKEN renews the session in memory');
    await model('user').update(stdioUser.user.id, { status: 'SUSPENDED' });
    await assert.rejects(renewing.client.callTool({ name: 'users', arguments: {} }), /This account is suspended/);
  } finally {
    await expiring.client?.close();
    await renewing.client?.close();
  }
  checks += 4;
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
    // An admin imports a review without a booking (#59), so only the injected failure stops this one.
    const failed = await mutation('addreview', { rating: 1, client: { id: client.user.id }, barbershop: { id: shop.id } }, 'id', adminToken, true);
    assert.equal(failed.errors[0].message, 'Later statistics failure');
  } finally { shopModel.update = originalUpdate; }
  assert.equal((await shopModel.findById(shop.id)).averageRating, 3);
  assert.equal((await model('review').find({})).length, 1);
  // #146: review statistics come from one count/sum query on the hook transaction, not from paging the
  // shop's reviews into Node.
  const table = (name) => `${pg.escapeIdentifier(databaseSchema)}.${pg.escapeIdentifier(name)}`;
  const statementsMatching = async (pattern, run) => {
    const seen = [];
    const query = pg.Client.prototype.query;
    pg.Client.prototype.query = function countedQuery(config, ...rest) {
      const text = typeof config === 'string' ? config : config?.text;
      if (pattern.test(text ?? '')) seen.push(text);
      return query.call(this, config, ...rest);
    };
    try { return { result: await run(), seen }; } finally { pg.Client.prototype.query = query; }
  };
  await pool.query(`INSERT INTO ${table('review')} (rating, comment, barbershop, client) SELECT 1 + i % 5, 'bulk', $1, $2 FROM generate_series(1, 250) AS i`, [shop.id, client.user.id]);
  const bulkAdd = await statementsMatching(/FROM "[^"]+"\."review"/, () => mutation('addreview', { rating: 5, client: { id: client.user.id }, barbershop: { id: shop.id } }, 'id', adminToken));
  assert.equal(bulkAdd.seen.length, 1, `addreview read the review table ${bulkAdd.seen.length} times`);
  const withBulk = await shopModel.findById(shop.id);
  assert.deepEqual([withBulk.averageRating, withBulk.reviewCount], [3, 252]);
  const bulkDelete = await request(`mutation { deletereview(id: "${bulkAdd.result.id}") { id } }`, {}, adminToken);
  assert.equal(bulkDelete.errors, undefined, JSON.stringify(bulkDelete.errors));
  const afterBulkDelete = await shopModel.findById(shop.id);
  assert.deepEqual([afterBulkDelete.averageRating, afterBulkDelete.reviewCount], [3, 251]);
  await pool.query(`DELETE FROM ${table('review')} WHERE comment = 'bulk'`);
  checks += 2;
  // #86: catalog scopes restrict through the barbershop relation instead of loading shop IDs. A service
  // of the 106th approved shop is visible, another owner's DRAFT shop's is not, a nested catalog read
  // reads the barbershop table once (the root list), and references resolved by ID read it not at all.
  await pool.query(`INSERT INTO ${table('barbershop')} (id, owner, name, slug, state) SELECT gen_random_uuid(), $1, 'Paged shop', 'paged-' || i, 'APPROVED' FROM generate_series(1, 105) AS i`, [owner.user.id]);
  await pool.query(`INSERT INTO ${table('service')} (name, price, "durationMinutes", barbershop, "isActive") SELECT 'Paged service', 10, 30, id, true FROM ${table('barbershop')} WHERE slug = 'paged-105'`);
  await pool.query(`INSERT INTO ${table('barbershop')} (owner, name, slug, state) VALUES ($1, 'Hidden draft', 'hidden-draft', 'DRAFT')`, [otherOwner.user.id]);
  await pool.query(`INSERT INTO ${table('service')} (name, price, "durationMinutes", barbershop, "isActive") SELECT 'Draft service', 10, 30, id, true FROM ${table('barbershop')} WHERE slug = 'hidden-draft'`);
  const rootShopReads = /FROM "[^"]+"\."barbershop" t0\b/;
  for (const [role, token, visibleServices] of [['anonymous', undefined, ['Paged service']], ['client', client.accessToken, ['Paged service']], ['owner', owner.accessToken, ['Paged service']], ['other owner', otherOwner.accessToken, ['Draft service']]]) {
    const found = await request('{ services(name: { operator: IN, value: ["Paged service", "Draft service"] }) { name } }', {}, token);
    assert.deepEqual(found.data?.services?.map((row) => row.name), visibleServices, `${role}: ${JSON.stringify(found)}`);
    const nested = await statementsMatching(rootShopReads, () => request('{ barbershops(pagination: { page: 1, size: 100 }) { id services { id } professionals { id } } }', {}, token));
    assert.equal(nested.result.errors, undefined, role);
    assert.equal(nested.seen.length, 1, `${role} catalog read the barbershop table ${nested.seen.length} times`);
    const references = await statementsMatching(rootShopReads, () => request('{ bundles(pagination: { page: 1, size: 100 }) { id services { service { id } } } }', {}, token));
    assert.equal(references.result.errors, undefined, role);
    const resolved = references.result.data.bundles.flatMap((row) => row.services).filter((item) => item.service).length;
    assert.ok(role === 'other owner' || resolved >= 3, `${role}: ${JSON.stringify(references.result)}`);
    assert.equal(references.seen.length, 0, `${role} bundle service references read the barbershop table ${references.seen.length} times`);
    checks += 3;
  }

  console.log(`PostgreSQL integration passed: ${checks} API checks plus auth, scopes, rollback, FKs and derived-value assertions.`);
} finally {
  await pool.query(`DROP SCHEMA IF EXISTS ${pg.escapeIdentifier(databaseSchema)} CASCADE`);
  await closeDatabase();
}
