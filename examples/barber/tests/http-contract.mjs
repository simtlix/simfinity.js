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
    assert.equal(result.errors?.[0]?.extensions?.code, 'FORBIDDEN', `${name} must be forbidden: ${JSON.stringify(result)}`);
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
  booking = await mutate('addbooking', {
    barbershop: { id: shop.id }, professional: { id: shop.professionals[0].id },
    scheduledDate: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), startTime: '10:00',
    lines: [{ service: { id: service.id }, price: 25, durationMinutes: 30 }],
  }, 'id state totalPrice endTime client { id } lines { service { id } }', client.accessToken);
  assert.equal(booking.state, 'CONFIRMED');
  assert.equal(booking.totalPrice, 25);
  assert.equal(booking.endTime, '10:30');
  assert.equal(booking.client.id, client.user.id);
  assert.equal(booking.lines[0].service.id, service.id);
  await mutate('complete_booking', { id: booking.id }, 'id', client.accessToken, true);
  const complete = await mutate('complete_booking', { id: booking.id }, 'id state', owner.accessToken);
  assert.equal(complete.state, 'COMPLETED');

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
  for (const name of ['barbershops', 'addbooking', 'updateuser']) assert.ok(tools.some((tool) => tool.name === name));
  const catalogTool = await rpc('tools/call', { name: 'barbershops', arguments: {} });
  assert.ok(!catalogTool.isError, JSON.stringify(catalogTool));
  const forbiddenTool = await rpc('tools/call', { name: 'updateuser', arguments: { input: { id: client.user.id, role: 'PLATFORM_ADMIN' } } });
  assert.equal(forbiddenTool.isError, true);
  console.log(`HTTP contract passed: ${checks} operations plus scopes, embedded relations, booking state and MCP assertions.`);
} finally {
  for (const [name, id] of [['deletebooking', booking?.id], ['deleteuser', client.user.id], ['deleteuser', otherOwner?.user.id]]) {
    if (!id) continue;
    const result = await request(`mutation($id:ID!) { ${name}(id:$id) { id } }`, { id }, admin.accessToken);
    assert.equal(result.errors, undefined, `${name} cleanup: ${JSON.stringify(result.errors)}`);
  }
}
