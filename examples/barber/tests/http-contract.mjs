import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Run the identical public API contract against either independently started backend.
const endpoint = process.env.GRAPHQL_ENDPOINT;
assert.ok(endpoint, 'Set GRAPHQL_ENDPOINT to the disposable example backend');
const origin = new URL(endpoint).origin;
const slug = process.env.DEMO_SHOP_SLUG || 'barber-demo';
let checks = 0;
async function request(query, variables = {}, token) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
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
  const catalog = await request('{ barbershops { id slug state address { city } businessHours { dayOfWeek } services { id price durationMinutes } professionals { id } } }');
  assert.equal(catalog.errors, undefined, JSON.stringify(catalog.errors));
  const shop = catalog.data.barbershops.find((row) => row.slug === slug);
  assert.ok(shop, 'Run seed:admin and seed:demo before this contract');
  assert.equal(shop.state, 'APPROVED');
  assert.equal(shop.address.city, 'Buenos Aires');
  assert.equal(shop.businessHours.length, 7);
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
  await mutate('bookingAvailability', availability, 'startTime', undefined, 'UNAUTHENTICATED');
  // The API derives endTime from the start time and lines; a sent endTime cannot shrink the held time.
  const shrunk = await mutate('updatebooking', { id: booking.id, endTime: '10:00' }, 'endTime', client.accessToken);
  assert.equal(shrunk.endTime, '10:30');
  const busy = await mutate('bookingAvailability', availability, 'startTime endTime professionalId', otherClient.accessToken);
  assert.deepEqual(busy.filter((range) => range.startTime === '10:00'), [{ startTime: '10:00', endTime: '10:30', professionalId }]);
  const busyUppercase = await mutate('bookingAvailability', { ...availability, professionalId: professionalId.toUpperCase() }, 'startTime endTime professionalId', otherClient.accessToken);
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
  await mutate('bookingAvailability', { ...availability, barbershopId: 'not-an-id' }, 'startTime', otherClient.accessToken, 'NOT_VALID_ID');
  // Nor can it stretch a booking, or make a booking without lines hold more than its start.
  const stretched = await mutate('updatebooking', { id: booking.id, endTime: '16:00' }, 'endTime', client.accessToken);
  assert.equal(stretched.endTime, '10:30');
  emptyBooking = await mutate('addbooking', { ...slot('14:30'), lines: [], endTime: '17:30' }, 'id endTime', otherClient.accessToken);
  assert.equal(emptyBooking.endTime, '14:30');
  const emptyRange = await mutate('bookingAvailability', availability, 'startTime endTime', otherClient.accessToken);
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
  const ordered = await mutate('bookingAvailability', availability, 'startTime', otherClient.accessToken);
  assert.deepEqual(ordered.map((range) => range.startTime).filter((time) => ['09:00', '10:00'].includes(time)), ['09:00', '10:00']);

  // Availability leaves out a booking only for its own client, so the booking page can offer its new time.
  const withoutOwn = await mutate('bookingAvailability', { ...availability, excludeBookingId: booking.id }, 'startTime', client.accessToken);
  assert.ok(!withoutOwn.some((range) => range.startTime === '10:00'), "A client's own booking does not block its reschedule");
  const notOthers = await mutate('bookingAvailability', { ...availability, excludeBookingId: booking.id }, 'startTime', otherClient.accessToken);
  assert.ok(notOthers.some((range) => range.startTime === '10:00'), "Another client's booking is never left out");
  await mutate('bookingAvailability', { ...availability, excludeBookingId: 'not-an-id' }, 'startTime', client.accessToken, 'NOT_VALID_ID');
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
  const freed = await mutate('bookingAvailability', availability, 'startTime', otherClient.accessToken);
  assert.ok(!freed.some((range) => range.startTime === '10:15'), 'Completed bookings no longer hold their time');

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
  for (const name of ['barbershops', 'addbooking', 'updateuser', 'bookingAvailability', 'reschedule_booking']) assert.ok(tools.some((tool) => tool.name === name));
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
  console.log(`HTTP contract passed: ${checks} operations plus scopes, embedded relations, booking state, availability and MCP assertions.`);
} finally {
  for (const [name, id] of [
    ['deletebooking', booking?.id], ['deletebooking', otherBooking?.id], ['deletebooking', emptyBooking?.id],
    ['deleteuser', client.user.id], ['deleteuser', otherClient?.user.id], ['deleteuser', otherOwner?.user.id],
  ]) {
    if (!id) continue;
    const result = await request(`mutation($id:ID!) { ${name}(id:$id) { id } }`, { id }, admin.accessToken);
    assert.equal(result.errors, undefined, `${name} cleanup: ${JSON.stringify(result.errors)}`);
  }
}
