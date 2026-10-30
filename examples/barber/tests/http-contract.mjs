import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { fetchWithRateLimitRetry } from './rateLimitedFetch.mjs';

// Run the identical public API contract against either independently started backend.
const endpoint = process.env.GRAPHQL_ENDPOINT;
assert.ok(endpoint, 'Set GRAPHQL_ENDPOINT to the disposable example backend');
const origin = new URL(endpoint).origin;
const slug = process.env.DEMO_SHOP_SLUG || 'barber-demo';
let checks = 0;
async function request(query, variables = {}, token) {
  const response = await fetchWithRateLimitRetry(endpoint, () => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  }));
  assert.equal(response.status, 200, `GraphQL HTTP ${response.status}`);
  return response.json();
}
const health = await fetch(`${origin}/health`);
assert.equal(health.status, 200, 'Server must become ready after database initialization');
assert.equal((await health.json()).status, 'ok');
const introspection = await request('{ __type(name:"Mutation") { fields { name args { name type { name kind ofType { name kind ofType { name kind } } } } } } }');
assert.equal(introspection.errors, undefined);
const fields = introspection.data.__type.fields;
const typeName = (type) => type.kind === 'NON_NULL' ? `${typeName(type.ofType)}!` : type.kind === 'LIST' ? `[${typeName(type.ofType)}]` : type.name;
async function mutate(name, input, selection = 'id', token, denied = false) {
  const field = fields.find((candidate) => candidate.name === name);
  assert.ok(field, `Missing mutation ${name}`);
  const arg = field.args.find((argument) => argument.name === 'input');
  const result = await request(`mutation($input:${typeName(arg.type)}) { ${name}(input:$input) { ${selection} } }`, { input }, token);
  checks++;
  if (denied) {
    const code = denied === true ? 'FORBIDDEN' : denied;
    assert.equal(result.errors?.[0]?.extensions?.code, code, `${name} must fail with ${code}: ${JSON.stringify(result)}`);
    return;
  }
  assert.equal(result.errors, undefined, `${name}: ${JSON.stringify(result.errors)}`);
  return result.data[name];
}
// Taken times come from the barbershop's virtual busyRanges field; `barbershopId` names the shop.
async function busyRanges({ barbershopId, ...args }, selection, token, denied = false) {
  const result = await request(
    `query($id:ID, $date:String!, $professionalId:ID, $excludeBookingId:ID) { barbershop(id:$id) { busyRanges(date:$date, professionalId:$professionalId, excludeBookingId:$excludeBookingId) { ${selection} } } }`,
    { id: barbershopId, ...args },
    token,
  );
  checks++;
  if (denied) {
    const codes = [denied].flat();
    assert.ok(codes.includes(result.errors?.[0]?.extensions?.code), `busyRanges must fail with ${codes.join(' or ')}: ${JSON.stringify(result)}`);
    return;
  }
  assert.equal(result.errors, undefined, `busyRanges: ${JSON.stringify(result.errors)}`);
  return result.data.barbershop.busyRanges;
}
const authFields = 'accessToken user { id role passwordHash }';
const login = (email) => mutate('login', { email, password: 'demo1234' }, authFields);
const admin = await login('admin@demo.com');
const owner = await login('propietario@demo.com');
const client = await mutate('register', {
  name: 'HTTP contract client', email: `http-${randomUUID()}@example.test`, password: 'demo1234',
}, authFields);
assert.match(client.user.id, /^(?:[0-9a-f]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
assert.equal(client.user.passwordHash, null);
let booking;
let otherOwner;
let otherClient;
let otherBooking;
let emptyBooking;
let suspended;
let demoted;
let review;
let ownerBooking;
let walkIn;
let adminBooking;
let adminForClient;
let inUseShop;
let inUseBooking;
// The first failure of the contract body; cleanup errors never replace it.
let failure;
try {
  await mutate('updateuser', { id: client.user.id, role: 'PLATFORM_ADMIN' }, 'id', client.accessToken, true);
  await mutate('updateuser', { id: client.user.id, emailVerified: true }, 'id', client.accessToken, true);
  await mutate('updateuser', { id: owner.user.id, name: 'Attack' }, 'id', client.accessToken, true);
  const updated = await mutate('updateuser', { id: client.user.id, name: 'Own profile' }, 'id name', client.accessToken);
  assert.equal(updated.name, 'Own profile');
  const hidden = await request('query($id:ID!) { user(id:$id) { id email } }', { id: owner.user.id }, client.accessToken);
  assert.equal(hidden.errors, undefined);
  assert.notEqual(hidden.data.user?.id, owner.user.id, 'Client query scope must hide another account');
  if (hidden.data.user) assert.equal(hidden.data.user.id, client.user.id);
  // #132: filter by slug on the server; an unfiltered list returns at most 100 shops and could miss it.
  const catalog = await request('query($slug: QLFilter) { barbershops(slug: $slug) { id slug state address { city } businessHours { dayOfWeek } services { id price durationMinutes } professionals { id } } }', { slug: { operator: 'EQ', value: slug } });
  assert.equal(catalog.errors, undefined, JSON.stringify(catalog.errors));
  const shop = catalog.data.barbershops.find((row) => row.slug === slug);
  assert.ok(shop, 'Run seed:admin and seed:demo before this contract');
  assert.equal(shop.state, 'APPROVED');
  assert.equal(shop.address.city, 'Buenos Aires');
  assert.equal(shop.businessHours.length, 7);
  // #54: an admin's suspension (user.status) blocks sign-in and renewal and ends access tokens already
  // issued: GraphQL treats them as anonymous, uploads reject them and MCP tool calls fail with an error.
  const suspendedEmail = `http-suspended-${randomUUID()}@example.test`;
  suspended = await mutate('register', { name: 'HTTP contract suspended', email: suspendedEmail, password: 'demo1234' }, `refreshToken ${authFields}`);
  await mutate('updateuser', { id: suspended.user.id, status: 'SUSPENDED' }, 'id', admin.accessToken);
  await mutate('login', { email: suspendedEmail, password: 'demo1234' }, authFields, undefined, 'ACCOUNT_SUSPENDED');
  const wrongPassword = await request('mutation($input:LoginInput!) { login(input:$input) { accessToken } }', { input: { email: suspendedEmail, password: 'wrong-password' } });
  assert.equal(wrongPassword.errors?.[0]?.message, 'Invalid email or password', 'A wrong password must not reveal the suspension');
  await mutate('refreshSession', { refreshToken: suspended.refreshToken }, 'accessToken', undefined, 'ACCOUNT_SUSPENDED');
  await mutate('addfavorite', { user: { id: suspended.user.id }, barbershop: { id: shop.id } }, 'id', suspended.accessToken, 'UNAUTHENTICATED');
  const suspendedSelf = await request('query($id:ID!) { user(id:$id) { id } }', { id: suspended.user.id }, suspended.accessToken);
  assert.equal(suspendedSelf.data.user, null);
  const suspendedUpload = await fetch(`${origin}/api/uploads`, { method: 'POST', headers: { authorization: `Bearer ${suspended.accessToken}` }, signal: AbortSignal.timeout(30_000) });
  assert.equal(suspendedUpload.status, 401);
  assert.deepEqual(await suspendedUpload.json(), { error: 'Token invalido' });
  const suspendedTool = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${suspended.accessToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'favorites', arguments: {} } }),
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(suspendedTool.status, 200, `MCP tools/call: HTTP ${suspendedTool.status}`);
  const toolBody = await suspendedTool.text();
  const toolMessage = suspendedTool.headers.get('content-type')?.includes('text/event-stream')
    ? toolBody.split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5))).find((entry) => entry.id === 1)
    : JSON.parse(toolBody);
  assert.equal(toolMessage?.result, undefined, `A suspended account's MCP call must fail: ${toolBody}`);
  assert.equal(toolMessage.error.message, 'This account is suspended');
  assert.equal(toolMessage.error.data?.code, 'ACCOUNT_SUSPENDED');
  checks += 3;
  // AUTH-1: an expired or invalid bearer fails an MCP call too, instead of running it as anonymous.
  // The expired token is signed with JWT_SECRET (the backend's default when unset); against a backend
  // with another secret it is merely invalid, which fails with the same code.
  const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const expiredBody = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ sub: client.user.id, roles: ['CLIENT'], iat: Math.floor(Date.now() / 1000) - 120, exp: Math.floor(Date.now() / 1000) - 60 })}`;
  const expiredToken = `${expiredBody}.${createHmac('sha256', process.env.JWT_SECRET || 'dev-jwt-secret-change-in-production').update(expiredBody).digest('base64url')}`;
  for (const [token, message] of [
    [expiredToken, process.env.JWT_SECRET ? /^The access token expired at .+; renew it with GraphQL refreshSession$/ : /^(The access token expired at|Invalid access token)/],
    ['not-a-jwt', /^Invalid access token/],
  ]) {
    const staleTool = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'favorites', arguments: {} } }),
      signal: AbortSignal.timeout(30_000),
    });
    const staleBody = await staleTool.text();
    const staleMessage = staleTool.headers.get('content-type')?.includes('text/event-stream')
      ? staleBody.split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5))).find((entry) => entry.id === 1)
      : JSON.parse(staleBody);
    assert.equal(staleMessage?.result, undefined, `An MCP call with an expired or invalid bearer must fail: ${staleBody}`);
    assert.equal(staleMessage?.error?.data?.code, 'UNAUTHENTICATED', staleBody);
    assert.match(staleMessage.error.message, message);
    checks++;
  }
  await mutate('updateuser', { id: suspended.user.id, status: 'ACTIVE' }, 'id', admin.accessToken);
  await mutate('login', { email: suspendedEmail, password: 'demo1234' }, authFields);
  // A token carries the role stored now: once demoted, an admin's earlier token cannot restore its role.
  const demotedEmail = `http-demoted-${randomUUID()}@example.test`;
  demoted = await mutate('register', { name: 'HTTP contract demoted', email: demotedEmail, password: 'demo1234' }, authFields);
  await mutate('updateuser', { id: demoted.user.id, role: 'PLATFORM_ADMIN' }, 'id', admin.accessToken);
  const promoted = await mutate('login', { email: demotedEmail, password: 'demo1234' }, authFields);
  assert.equal(promoted.user.role, 'PLATFORM_ADMIN');
  await mutate('updateuser', { id: demoted.user.id, role: 'CLIENT' }, 'id', admin.accessToken);
  await mutate('updateuser', { id: demoted.user.id, role: 'PLATFORM_ADMIN' }, 'id', promoted.accessToken, true);
  const stillDemoted = await request('query($id:ID!) { user(id:$id) { role } }', { id: demoted.user.id }, admin.accessToken);
  assert.equal(stillDemoted.data.user.role, 'CLIENT');
  await mutate('updatebarbershop', { id: shop.id, averageRating: null }, 'id', owner.accessToken, true);
  await mutate('addbarbershop', {
    name: 'Fabricated rating', slug: `rating-${randomUUID()}`, owner: { id: owner.user.id },
    averageRating: 5, reviewCount: 1000,
  }, 'id', owner.accessToken, true);
  const service = shop.services[0];
  assert.ok(service && shop.professionals[0]);
  otherOwner = await mutate('registerOwner', {
    name: 'Other shop owner', email: `http-owner-${randomUUID()}@example.test`, password: 'demo1234',
  }, authFields);
  await mutate('updateservice', { id: service.id, name: 'Attack' }, 'id', otherOwner.accessToken, true);
  await mutate('updatebarbershop', {
    id: shop.id, services: { updated: [{ id: service.id, name: 'Nested attack' }] },
  }, 'id', otherOwner.accessToken, true);
  const professionalId = shop.professionals[0].id;
  const scheduledDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const slot = (startTime, date = scheduledDate) => ({
    barbershop: { id: shop.id }, professional: { id: professionalId }, scheduledDate: date, startTime,
    lines: [{ service: { id: service.id }, price: 25, durationMinutes: 30 }],
  });
  booking = await mutate('addbooking', slot('10:00'), 'id state totalPrice endTime client { id } lines { service { id } }', client.accessToken);
  assert.equal(booking.state, 'CONFIRMED');
  assert.equal(booking.totalPrice, 25);
  assert.equal(booking.endTime, '10:30');
  assert.equal(booking.client.id, client.user.id);
  assert.equal(booking.lines[0].service.id, service.id);

  // Another client sees only the held time, cannot overlap it and cannot book outside the schedule.
  otherClient = await mutate('register', {
    name: 'HTTP contract second client', email: `http-second-${randomUUID()}@example.test`, password: 'demo1234',
  }, authFields);
  const rangeType = await request('{ __type(name:"BookingBusyRange") { fields { name } } }');
  assert.deepEqual(rangeType.data.__type.fields.map((field) => field.name).sort(), ['endTime', 'professionalId', 'startTime']);
  const availability = { barbershopId: shop.id, date: scheduledDate, professionalId };
  await busyRanges(availability, 'startTime', undefined, 'UNAUTHENTICATED');
  // busyRanges is virtual, so list queries have no filter argument for it and no client path can name it.
  const busyFilter = await request('{ barbershops(busyRanges: { terms: [{ path: "startTime", operator: EQ, value: "10:00" }] }) { id } }', {}, otherClient.accessToken);
  assert.match(busyFilter.errors?.[0]?.message ?? '', /^Unknown argument "busyRanges" on field "\w+\.barbershops"\.$/, JSON.stringify(busyFilter));
  const busySort = await request('{ barbershops(sort: { terms: [{ field: "busyRanges.startTime", order: ASC }] }) { id } }', {}, otherClient.accessToken);
  assert.equal(busySort.errors?.[0]?.extensions?.code, 'FORBIDDEN_FILTER_PATH', JSON.stringify(busySort));
  checks += 2;
  // The API derives endTime from the start time and lines; a sent endTime cannot shrink the held time.
  // #61: so do totalPrice and the confirmation code.
  const shrunk = await mutate('updatebooking', { id: booking.id, endTime: '10:00', totalPrice: 0, confirmationCode: 'AAAAAA' }, 'endTime totalPrice confirmationCode', client.accessToken);
  assert.equal(shrunk.endTime, '10:30');
  assert.equal(shrunk.totalPrice, 25, 'The API derives totalPrice from the lines');
  assert.notEqual(shrunk.confirmationCode, 'AAAAAA', 'The API owns the confirmation code');
  const busy = await busyRanges(availability, 'startTime endTime professionalId', otherClient.accessToken);
  assert.deepEqual(busy.filter((range) => range.startTime === '10:00'), [{ startTime: '10:00', endTime: '10:30', professionalId }]);
  const busyUppercase = await busyRanges({ ...availability, professionalId: professionalId.toUpperCase() }, 'startTime endTime professionalId', otherClient.accessToken);
  assert.deepEqual(busyUppercase, busy, 'Canonical IDs preserve professional availability');
  await mutate('addbooking', slot('10:15'), 'id', otherClient.accessToken, 'BOOKING_SLOT_UNAVAILABLE');
  await mutate('addbooking', slot('20:00'), 'id', otherClient.accessToken, 'BOOKING_OUTSIDE_HOURS');
  await mutate('addbooking', slot('10:00', '2020-01-01'), 'id', otherClient.accessToken, 'BOOKING_OUTSIDE_ADVANCE_WINDOW');
  await mutate('addbooking', slot('12:00', null), 'id', otherClient.accessToken, 'INVALID_BOOKING_TIME');
  // Each line references one service or bundle with a non-negative duration, so lines cannot shrink a booking.
  await mutate('addbooking', {
    ...slot('10:10'), lines: [...slot('10:10').lines, { price: 0, durationMinutes: -600 }],
  }, 'id', otherClient.accessToken, 'INVALID_BOOKING_LINE');
  await mutate('addbooking', {
    ...slot('17:45'), lines: [{ service: { id: service.id }, price: 25, durationMinutes: -60 }],
  }, 'id', otherClient.accessToken, 'INVALID_BOOKING_LINE');
  // A malformed shop ID fails in the generated barbershop(id) query, whose code differs by database.
  await busyRanges({ ...availability, barbershopId: 'not-an-id' }, 'startTime', otherClient.accessToken, ['NOT_VALID_ID', 'INVALID_FILTER_VALUE']);
  // Nor can it stretch a booking, or make a booking without lines hold more than its start.
  const stretched = await mutate('updatebooking', { id: booking.id, endTime: '16:00' }, 'endTime', client.accessToken);
  assert.equal(stretched.endTime, '10:30');
  emptyBooking = await mutate('addbooking', { ...slot('14:30'), lines: [], endTime: '17:30' }, 'id endTime', otherClient.accessToken);
  assert.equal(emptyBooking.endTime, '14:30');
  const emptyRange = await busyRanges(availability, 'startTime endTime', otherClient.accessToken);
  assert.deepEqual(emptyRange.filter((range) => range.startTime === '14:30'), [{ startTime: '14:30', endTime: '14:30' }]);
  otherBooking = await mutate('addbooking', {
    ...slot('11:00'), lines: [{ service: { id: service.id }, price: 25, durationMinutes: 0 }],
  }, 'id endTime', otherClient.accessToken);
  assert.equal(otherBooking.endTime, '11:30', 'The API derives durations from the service catalog');
  await mutate('updatebooking', { id: otherBooking.id, startTime: '10:00' }, 'id', otherClient.accessToken, 'BOOKING_SLOT_UNAVAILABLE');
  await mutate('updatebooking', {
    id: otherBooking.id, startTime: '10:10', lines: [{ price: 0, durationMinutes: -600 }],
  }, 'id', otherClient.accessToken, 'INVALID_BOOKING_LINE');
  // Edit forms resend the unchanged slot; start times are stored zero-padded and listed in clock order.
  const edited = await mutate('updatebooking', {
    id: otherBooking.id, scheduledDate, startTime: '11:00', professional: { id: professionalId }, notes: 'Owner note',
  }, 'notes startTime endTime', owner.accessToken);
  assert.deepEqual(edited, { notes: 'Owner note', startTime: '11:00', endTime: '11:30' });
  const moved = await mutate('updatebooking', { id: otherBooking.id, startTime: '9:00' }, 'startTime endTime', otherClient.accessToken);
  assert.deepEqual(moved, { startTime: '09:00', endTime: '09:30' });
  const ordered = await busyRanges(availability, 'startTime', otherClient.accessToken);
  assert.deepEqual(ordered.map((range) => range.startTime).filter((time) => ['09:00', '10:00'].includes(time)), ['09:00', '10:00']);

  // Availability leaves out a booking only for its own client, so the booking page can offer its new time.
  const withoutOwn = await busyRanges({ ...availability, excludeBookingId: booking.id }, 'startTime', client.accessToken);
  assert.ok(!withoutOwn.some((range) => range.startTime === '10:00'), "A client's own booking does not block its reschedule");
  const notOthers = await busyRanges({ ...availability, excludeBookingId: booking.id }, 'startTime', otherClient.accessToken);
  assert.ok(notOthers.some((range) => range.startTime === '10:00'), "Another client's booking is never left out");
  await busyRanges({ ...availability, excludeBookingId: 'not-an-id' }, 'startTime', client.accessToken, 'NOT_VALID_ID');
  // Choosing no professional turns a booking into one that holds the whole shop.
  const shopWide = await mutate('updatebooking', { id: otherBooking.id, professional: null }, 'startTime professional { id }', otherClient.accessToken);
  assert.deepEqual(shopWide, { startTime: '09:00', professional: null });

  // Clients reschedule with one update of their booking: a rejected time leaves it unchanged, and an
  // accepted one keeps the booking, even when the new time overlaps its old one.
  const reschedule = {
    id: booking.id, scheduledDate, professional: { id: professionalId }, lines: [{ service: { id: service.id }, price: 25, durationMinutes: 30 }],
  };
  await mutate('reschedule_booking', { ...reschedule, startTime: '10:15' }, 'id', undefined, 'UNAUTHENTICATED');
  await mutate('reschedule_booking', { ...reschedule, startTime: '10:15' }, 'id', otherClient.accessToken, true);
  await mutate('reschedule_booking', { ...reschedule, startTime: '09:15' }, 'id', client.accessToken, 'BOOKING_SLOT_UNAVAILABLE');
  const kept = await request('query($id:ID!) { booking(id:$id) { state startTime endTime } }', { id: booking.id }, client.accessToken);
  assert.deepEqual(kept.data.booking, { state: 'CONFIRMED', startTime: '10:00', endTime: '10:30' });
  const rescheduled = await mutate('reschedule_booking', { ...reschedule, id: booking.id.toUpperCase(), startTime: '10:15' }, 'id state startTime endTime', client.accessToken);
  assert.deepEqual(rescheduled, { id: booking.id, state: 'CONFIRMED', startTime: '10:15', endTime: '10:45' });

  await mutate('complete_booking', { id: booking.id }, 'id', client.accessToken, true);
  const complete = await mutate('complete_booking', { id: booking.id }, 'id state', owner.accessToken);
  assert.equal(complete.state, 'COMPLETED');
  await mutate('reschedule_booking', { ...reschedule, startTime: '12:00' }, 'id', client.accessToken, 'BAD_REQUEST');
  const stillCompleted = await request('query($id:ID!) { booking(id:$id) { state startTime endTime } }', { id: booking.id }, client.accessToken);
  assert.deepEqual(stillCompleted.data.booking, { state: 'COMPLETED', startTime: '10:15', endTime: '10:45' });
  const freed = await busyRanges(availability, 'startTime', otherClient.accessToken);
  assert.ok(!freed.some((range) => range.startTime === '10:15'), 'Completed bookings no longer hold their time');

  // #58: a booking keeps its shop and its history. Nobody clears the shop, only the shop's owner clears
  // the client, and clients cancel their bookings instead of deleting them.
  // The shop checks use a CONFIRMED booking, which its client may otherwise edit, so only the #58 rule
  // can refuse them; the shop's owner may edit completed bookings too.
  await mutate('updatebooking', { id: otherBooking.id, barbershop: null }, 'id', otherClient.accessToken, true);
  await mutate('updatebooking', { id: otherBooking.id, barbershop: null }, 'id', owner.accessToken, true);
  await mutate('updatebooking', { id: booking.id, barbershop: null }, 'id', owner.accessToken, true);
  await mutate('updatebooking', { id: otherBooking.id, client: null }, 'id', otherClient.accessToken, true);
  for (const [id, token] of [[booking.id, client.accessToken], [otherBooking.id, otherClient.accessToken]]) {
    const clientDelete = await request('mutation($id:ID!) { deletebooking(id:$id) { id } }', { id }, token);
    checks++;
    assert.equal(clientDelete.errors?.[0]?.extensions?.code, 'FORBIDDEN', `A client cannot delete their booking: ${JSON.stringify(clientDelete)}`);
  }

  // #59: a client reviews a completed booking of theirs at the shop, once, and never their own shop.
  const reviewInput = { rating: 4, comment: 'HTTP contract review', client: { id: client.user.id }, barbershop: { id: shop.id } };
  await mutate('addreview', reviewInput, 'id', client.accessToken, 'REVIEW_BOOKING_REQUIRED');
  await mutate('addreview', { ...reviewInput, booking: { id: otherBooking.id } }, 'id', client.accessToken, 'INVALID_REVIEW_BOOKING');
  await mutate('addreview', { ...reviewInput, client: { id: owner.user.id }, booking: { id: booking.id } }, 'id', owner.accessToken, true);
  // #57: the reply and the moderation flag belong to the shop's owner.
  await mutate('addreview', { ...reviewInput, booking: { id: booking.id }, reply: 'Forged owner reply' }, 'id', client.accessToken, true);
  review = await mutate('addreview', { ...reviewInput, booking: { id: booking.id } }, 'id booking { id } reply isReported', client.accessToken);
  assert.deepEqual([review.booking.id, review.reply, review.isReported], [booking.id, null, null]);
  await mutate('addreview', { ...reviewInput, booking: { id: booking.id } }, 'id', client.accessToken, 'REVIEW_ALREADY_EXISTS');
  await mutate('updatereview', { id: review.id, reply: 'Forged owner reply' }, 'id', client.accessToken, true);
  assert.equal((await mutate('updatereview', { id: review.id, reply: 'Thanks!' }, 'reply', owner.accessToken)).reply, 'Thanks!');
  await mutate('updatereview', { id: review.id, reply: null }, 'id', client.accessToken, true);
  // An edit form may resend the owner's fields unchanged.
  const resent = await mutate('updatereview', { id: review.id, rating: 5, reply: 'Thanks!', isReported: null }, 'rating reply', client.accessToken);
  assert.deepEqual(resent, { rating: 5, reply: 'Thanks!' });
  assert.equal((await mutate('updatereview', { id: review.id, reply: null }, 'reply', owner.accessToken)).reply, null);
  // The shop's owner replies and flags through the shop as well; only an admin clears the flag.
  await mutate('updatebarbershop', { id: shop.id, reviews: { updated: [{ id: review.id, reply: 'Thanks again', isReported: true }] } }, 'id', owner.accessToken);
  const flagged = await request('query($id:ID!) { review(id:$id) { reply isReported } }', { id: review.id }, owner.accessToken);
  assert.deepEqual(flagged.data?.review, { reply: 'Thanks again', isReported: true }, JSON.stringify(flagged));
  await mutate('updatereview', { id: review.id, isReported: false }, 'id', owner.accessToken, true);
  await mutate('updatereview', { id: review.id, isReported: false }, 'id', client.accessToken, true);
  // Only an admin deletes a review, so its author cannot remove a flagged review and post it again.
  const authorDelete = await request('mutation($id:ID!) { deletereview(id:$id) { id } }', { id: review.id }, client.accessToken);
  checks++;
  assert.equal(authorDelete.errors?.[0]?.extensions?.code, 'FORBIDDEN', `An author cannot delete a review: ${JSON.stringify(authorDelete)}`);
  const moderation = await request('{ reviews(isReported: { operator: EQ, value: true }) { id } }', {}, admin.accessToken);
  assert.ok(moderation.data.reviews.some((row) => row.id === review.id), 'A review its shop owner flags reaches the moderation queue');

  // #62: an owner booking another owner's shop books for themselves; the shop's owner books a walk-in.
  ownerBooking = await mutate('addbooking', slot('15:00'), 'id client { id }', otherOwner.accessToken);
  assert.equal(ownerBooking.client?.id, otherOwner.user.id);
  assert.equal((await mutate('cancelbyclient_booking', { id: ownerBooking.id }, 'state', otherOwner.accessToken)).state, 'CANCELLED_BY_CLIENT');
  walkIn = await mutate('addbooking', slot('15:30'), 'id client { id }', owner.accessToken);
  assert.equal(walkIn.client, null);
  // An admin who names no client is the client; an admin keeps the client they name.
  adminBooking = await mutate('addbooking', slot('16:00'), 'id client { id }', admin.accessToken);
  assert.equal(adminBooking.client?.id, admin.user.id);
  adminForClient = await mutate('addbooking', { ...slot('16:30'), client: { id: client.user.id } }, 'id client { id }', admin.accessToken);
  assert.equal(adminForClient.client?.id, client.user.id);

  // perm-1: a shop keeps its bookings and reviews, and a booking its review, so their owners cannot
  // delete them. Both APIs answer RESOURCE_IN_USE (MongoDB has no foreign key that would refuse it).
  const deleteCode = async (name, id, token) => {
    checks++;
    return (await request(`mutation($id:ID!) { ${name}(id:$id) { id } }`, { id }, token)).errors?.[0]?.extensions?.code;
  };
  assert.equal(await deleteCode('deletebooking', booking.id, owner.accessToken), 'RESOURCE_IN_USE', 'A reviewed booking keeps its review');
  inUseShop = await mutate('addbarbershop', { name: 'HTTP contract shop in use', slug: `in-use-${randomUUID()}`, owner: { id: otherOwner.user.id } }, 'id', otherOwner.accessToken);
  await mutate('approve_barbershop', { id: inUseShop.id }, 'id', admin.accessToken);
  inUseBooking = await mutate('addbooking', { barbershop: { id: inUseShop.id }, scheduledDate, startTime: '10:00', lines: [] }, 'id', otherOwner.accessToken);
  assert.equal(await deleteCode('deletebarbershop', inUseShop.id, owner.accessToken), 'FORBIDDEN');
  assert.equal(await deleteCode('deletebarbershop', inUseShop.id, otherOwner.accessToken), 'RESOURCE_IN_USE', 'A shop with bookings keeps them');

  // Exercise the actual Streamable HTTP endpoint, including generated-tool auth.
  let rpcId = 0;
  async function rpc(method, params) {
    const response = await fetch(`${origin}/mcp`, {
      method: 'POST', headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        authorization: `Bearer ${client.accessToken}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(response.status, 200, `MCP ${method}: HTTP ${response.status}`);
    const body = await response.text();
    const message = response.headers.get('content-type')?.includes('text/event-stream')
      ? body.split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5))).find((entry) => entry.id === rpcId)
      : JSON.parse(body);
    assert.ok(message, `MCP ${method} returned no response`);
    assert.equal(message.error, undefined, JSON.stringify(message.error));
    checks++;
    return message.result;
  }
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'barber-contract', version: '1.0.0' } });
  const { tools } = await rpc('tools/list', {});
  for (const name of ['barbershops', 'barbershop', 'barbershop_busyRanges', 'addbooking', 'updateuser', 'reschedule_booking']) assert.ok(tools.some((tool) => tool.name === name));
  // The virtual busyRanges field, whose date is required, is its own read tool: barbershop(id) { busyRanges(...) }.
  const busyRangesTool = tools.find((tool) => tool.name === 'barbershop_busyRanges');
  assert.equal(busyRangesTool.annotations?.readOnlyHint, true);
  assert.deepEqual(busyRangesTool.inputSchema.required, ['id', 'date']);
  const busyCall = await rpc('tools/call', { name: 'barbershop_busyRanges', arguments: { id: shop.id, date: scheduledDate, professionalId } });
  assert.ok(!busyCall.isError, JSON.stringify(busyCall));
  const busyRead = await busyRanges({ barbershopId: shop.id, date: scheduledDate, professionalId }, 'startTime endTime professionalId', client.accessToken);
  assert.deepEqual(busyCall.structuredContent, { barbershop: { busyRanges: busyRead } }, 'The MCP tool returns the GraphQL read');
  const catalogTool = await rpc('tools/call', { name: 'barbershops', arguments: {} });
  assert.ok(!catalogTool.isError, JSON.stringify(catalogTool));
  const forbiddenTool = await rpc('tools/call', { name: 'updateuser', arguments: { input: { id: client.user.id, role: 'PLATFORM_ADMIN' } } });
  assert.equal(forbiddenTool.isError, true);
  // The stateless endpoint serves POST only; a client's event-stream GET gets 405, not a 404 page.
  const streamAttempt = await fetch(`${origin}/mcp`, {
    method: 'GET', headers: { accept: 'text/event-stream', authorization: `Bearer ${client.accessToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(streamAttempt.status, 405, `MCP GET: HTTP ${streamAttempt.status}`);
  assert.equal(streamAttempt.headers.get('allow'), 'POST');
  await streamAttempt.body?.cancel();
  // #56: MCP publishes no password or token tools, refuses JSON-RPC batches and has its own limiter.
  for (const name of ['login', 'register', 'registerOwner', 'refreshSession']) assert.ok(!tools.some((tool) => tool.name === name), `MCP must not publish ${name}`);
  const batch = await fetch(`${origin}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify([1, 2].map((id) => ({ jsonrpc: '2.0', id, method: 'tools/list', params: {} }))),
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(batch.status, 400, `MCP batch: HTTP ${batch.status}`);
  assert.equal((await batch.json()).error?.code, -32600);
  assert.match(batch.headers.get('ratelimit-policy') ?? '', /^\d+;w=60$/, 'MCP responses carry the MCP limiter policy');
  // A body that is not JSON gets the JSON-RPC Parse error as JSON, not an HTML page with a stack trace.
  const malformed = await fetch(`${origin}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: '{"jsonrpc":', signal: AbortSignal.timeout(30_000),
  });
  assert.equal(malformed.status, 400, `MCP malformed body: HTTP ${malformed.status}`);
  assert.match(malformed.headers.get('content-type') ?? '', /^application\/json/);
  assert.deepEqual(await malformed.json(), { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: the request body is not valid JSON' }, id: null });
  checks++;
  // One GraphQL request may run only one password or token mutation, whatever the aliases.
  const aliased = await request('mutation { a: login(input:{email:"admin@demo.com",password:"guess-a"}) { accessToken } b: login(input:{email:"admin@demo.com",password:"guess-b"}) { accessToken } }');
  assert.deepEqual(aliased.errors?.map((error) => error.extensions?.code), ['AUTH_OPERATION_LIMIT'], JSON.stringify(aliased));
  checks += 3;
  // #52/#55: an upload is one raster image, stored under the type its bytes show and served inert.
  async function upload(parts) {
    const form = new FormData();
    for (const [name, value, filename, type] of parts) {
      if (filename === undefined) form.append(name, value);
      else form.append(name, new Blob([value], { type }), filename);
    }
    // Stored files stay on the server; their own folder keeps them easy to find.
    const response = await fetch(`${origin}/api/uploads?folder=http-contract`, {
      method: 'POST', body: form, headers: { authorization: `Bearer ${client.accessToken}` }, signal: AbortSignal.timeout(30_000),
    });
    checks++;
    if (response.status === 429) assert.fail(`Upload rate limit reached; raise UPLOAD_IP_RATE_LIMIT_MAX to rerun this contract within a minute: ${await response.text()}`);
    const header = (name) => response.headers.get(name);
    return { status: response.status, body: await response.json(), policy: header('ratelimit-policy'), limit: header('ratelimit-limit'), remaining: header('ratelimit-remaining') };
  }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const notAnImage = { status: 400, error: 'Solo se permiten imagenes (jpeg, png, webp, gif)' };
  const html = await upload([['file', Buffer.from('<!doctype html><script>alert(1)</script>'), 'x.png', 'image/png']]);
  assert.deepEqual({ status: html.status, error: html.body.error }, notAnImage, 'HTML declared as PNG must be rejected');
  const svg = await upload([['file', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'x.svg', 'image/svg+xml']]);
  assert.deepEqual({ status: svg.status, error: svg.body.error }, notAnImage, 'SVG must be rejected');
  assert.deepEqual(await upload([['note', 'x'], ['file', png, 'p.png', 'image/png']]).then(({ status, body }) => ({ status, body })), { status: 400, body: { error: 'Too many fields' } });
  const stored = await upload([['file', png, 'x.html', 'image/jpeg']]);
  assert.equal(stored.status, 200, JSON.stringify(stored.body));
  assert.match(stored.body.filename, /^[0-9a-f-]{36}\.png$/, 'The stored extension comes from the bytes');
  assert.equal(stored.body.url, `/api/uploads/http-contract/${stored.body.filename}`);
  assert.match(stored.policy ?? '', /^\d+;w=60$/, 'Uploads carry the upload limiter policy');
  // The per-account limiter reports last and counts only this client's 4 uploads; the per-IP limiter
  // also counted the suspended account's request, and any earlier run from this IP.
  assert.equal(Number(stored.limit) - Number(stored.remaining), 4, `The per-account upload limiter must be mounted: ${JSON.stringify(stored)}`);
  const served = await fetch(`${origin}${stored.body.url}`, { signal: AbortSignal.timeout(30_000) });
  assert.equal(served.status, 200);
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), png);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(served.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  assert.equal(served.headers.get('content-disposition'), null);
  console.log(`HTTP contract passed: ${checks} operations plus scopes, embedded relations, booking state, availability and MCP assertions.`);
} catch (error) {
  failure = error;
  throw error;
} finally {
  // Best effort: try every delete, so one failed delete (for example of a record that a regressed
  // rule already removed) neither stops the cleanup nor hides the contract's own failure.
  const cleanupErrors = [];
  for (const [name, id] of [
    // Reviews go before the bookings they cite (PostgreSQL foreign key).
    ['deletereview', review?.id], ['deletebooking', ownerBooking?.id], ['deletebooking', walkIn?.id],
    ['deletebooking', booking?.id], ['deletebooking', otherBooking?.id], ['deletebooking', emptyBooking?.id],
    ['deletebooking', adminBooking?.id], ['deletebooking', adminForClient?.id], ['deletebooking', inUseBooking?.id],
    ['deletebarbershop', inUseShop?.id],
    ['deleteuser', client.user.id], ['deleteuser', otherClient?.user.id], ['deleteuser', otherOwner?.user.id],
    ['deleteuser', suspended?.user.id], ['deleteuser', demoted?.user.id],
  ]) {
    if (!id) continue;
    try {
      const result = await request(`mutation($id:ID!) { ${name}(id:$id) { id } }`, { id }, admin.accessToken);
      if (result.errors) cleanupErrors.push(new Error(`${name} cleanup: ${JSON.stringify(result.errors)}`));
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length && failure) {
    console.error('Cleanup after the failure above also failed:', cleanupErrors.map((error) => error.message).join('\n'));
  } else if (cleanupErrors.length) {
    throw new AggregateError(cleanupErrors, `Contract cleanup failed: ${cleanupErrors.map((error) => error.message).join('; ')}`);
  }
}
