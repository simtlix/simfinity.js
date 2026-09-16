import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

// Real HTTP requests: shared expected results plus an explicit FK boundary check.
// Use a disposable database. Fixture users/catalog remain available for diagnosis.
const endpoint = process.env.GRAPHQL_ENDPOINT;
assert.ok(endpoint, 'Set GRAPHQL_ENDPOINT to a disposable Barber API');
const prefix = `parity-${randomUUID()}`;
const results = [];
const health = await fetch(new URL('/health', endpoint), { signal: AbortSignal.timeout(30_000) });
assert.equal(health.status, 200);
const { database } = await health.json();
assert.ok(['mongodb', 'postgresql'].includes(database), 'Expected a Barber API');
let requests = 0;
const literal = JSON.stringify;
async function request(query, variables = {}, token) {
  requests++;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 200, `GraphQL HTTP ${response.status}`);
  return response.json();
}
async function execute(query, variables, token) {
  const result = await request(query, variables, token);
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  return result;
}
async function check(name, run) {
  try {
    await run();
    results.push({ name, passed: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
    console.error(`FAIL ${name}: ${error.message}`);
  }
}
const introspection = await execute('{ __type(name:"Mutation") { fields { name args { name type { name kind ofType { name kind ofType { name kind } } } } } } }');
const fields = introspection.data.__type.fields;
const typeName = (type) => type.kind === 'NON_NULL' ? `${typeName(type.ofType)}!`
  : type.kind === 'LIST' ? `[${typeName(type.ofType)}]` : type.name;
async function mutate(name, input, selection, token, rejected = false) {
  const field = fields.find((entry) => entry.name === name);
  assert.ok(field, name);
  const arg = field.args.find((entry) => entry.name === 'input');
  const response = await request(`mutation($input:${typeName(arg.type)}) { ${name}(input:$input) { ${selection} } }`, { input }, token);
  if (rejected) {
    assert.equal(response.errors?.length, 1, `${name} must reject the invalid operation`);
    const error = response.errors[0];
    assert.deepEqual(error.path, [name], 'The rejection must come from the mutation resolver');
    if (rejected.code) assert.equal(error.extensions?.code, rejected.code);
    if (rejected.message) assert.equal(error.message, rejected.message);
    return response;
  }
  assert.equal(response.errors, undefined, `${name}: ${JSON.stringify(response.errors)}`);
  return response.data[name];
}
const authSelection = 'accessToken user { id }';
const admin = await mutate('login', { email: 'admin@demo.com', password: 'demo1234' }, authSelection);
const owner = await mutate('registerOwner', { email: `${prefix}-owner@example.test`, name: 'Parity owner', password: 'demo1234' }, authSelection);
const outsider = await mutate('registerOwner', { email: `${prefix}-outsider@example.test`, name: 'Other owner', password: 'demo1234' }, authSelection);
const client = await mutate('register', { email: `${prefix}-client@example.test`, name: 'Parity client', password: 'demo1234' }, authSelection);
const fixture = [
  { key: 'A', price: 10, durationMinutes: 15, isActive: true, priceType: 'FIXED', description: null },
  { key: 'B', price: 20, durationMinutes: 30, isActive: true, priceType: 'FIXED', description: 'clip' },
  { key: 'C', price: 40, durationMinutes: 60, isActive: false, priceType: 'STARTING_AT', description: 'color' },
  { key: 'D', price: 30, durationMinutes: 45, isActive: true, priceType: 'STARTING_AT', description: 'beard' },
  { key: 'E', price: 0, durationMinutes: 0, isActive: true, priceType: 'FIXED', description: null },
  { key: 'F', price: 99, durationMinutes: 90, isActive: true, priceType: 'FIXED', description: 'private' },
];
const shopSelection = 'id name slug state address { city street number } contactInfo { phone email } businessHours { dayOfWeek openTime closeTime isClosed } services { id name price barbershop { id } }';
const shops = [];
for (const [index, keys, city, actor] of [[0, ['A', 'B', 'C'], 'Cordoba', owner], [1, ['D', 'E'], 'Rosario', owner], [2, ['F'], 'Cordoba', outsider]]) {
  const shop = await mutate('addbarbershop', {
    name: `${prefix}-shop-${index}`, slug: `${prefix}-shop-${index}`, owner: { id: actor.user.id },
    slotDurationMinutes: (index + 1) * 15,
    address: { city, street: 'Initial street', number: '123' }, contactInfo: { phone: '123', email: 'demo@example.test' },
    businessHours: [{ dayOfWeek: 1, openTime: '09:00', closeTime: '18:00', isClosed: false }],
    services: { added: fixture.filter((item) => keys.includes(item.key)).map(({ key, ...item }) => ({ ...item, name: `${prefix}-${key}` })) },
  }, shopSelection, actor.accessToken);
  shops.push(shop);
  if (index < 2) {
    await mutate('submitforreview_barbershop', { id: shop.id }, 'id state', actor.accessToken);
    await mutate('approve_barbershop', { id: shop.id }, 'id state', admin.accessToken);
  }
}
const services = Object.fromEntries(shops.flatMap((shop) => shop.services.map((service) => [service.name.slice(prefix.length + 1), service])));
const rootFilter = `name:{operator:LIKE,value:${literal(`${prefix}-`)}}`;
const shopFilter = `slug:{operator:LIKE,value:${literal(`${prefix}-shop-`)}}`;
const names = (rows) => rows.map((row) => row.name.slice(prefix.length + 1));
const condition = (field, operator, value) => `{field:${literal(field)},operator:${operator},value:${literal(value)}}`;
async function list(filter = '', token = admin.accessToken, pagination = '', order = 'name', direction = 'ASC') {
  return execute(`{services(${rootFilter},${filter} sort:{terms:[{field:${literal(order)},order:${direction}},{field:"name",order:ASC}]} ${pagination}){name price durationMinutes isActive priceType}}`, {}, token);
}
await check('nested create persists embedded objects, lists and referenced children', async () => {
  for (const shop of shops) {
    assert.equal(shop.address.street, 'Initial street');
    assert.equal(shop.businessHours[0].isClosed, false);
    for (const service of shop.services) assert.equal(service.barbershop.id, shop.id);
    const read = await execute(`query($id:ID!){barbershop(id:$id){${shopSelection}}}`, { id: shop.id }, admin.accessToken);
    assert.deepEqual(read.data.barbershop.services.map((s) => s.id).sort(), shop.services.map((s) => s.id).sort());
  }
});
const filters = [
  ['EQ numeric', 'price:{operator:EQ,value:20}', ['B']],
  ['NE numeric', 'price:{operator:NE,value:20}', ['A', 'C', 'D', 'E', 'F']],
  ['LT numeric', 'price:{operator:LT,value:20}', ['A', 'E']],
  ['LTE numeric', 'price:{operator:LTE,value:20}', ['A', 'B', 'E']],
  ['GT numeric', 'price:{operator:GT,value:30}', ['C', 'F']],
  ['GTE numeric', 'price:{operator:GTE,value:30}', ['C', 'D', 'F']],
  ['BTW inclusive', 'price:{operator:BTW,value:[10,30]}', ['A', 'B', 'D']],
  ['IN numeric', 'price:{operator:IN,value:[0,40]}', ['C', 'E']],
  ['NIN numeric', 'price:{operator:NIN,value:[0,40]}', ['A', 'B', 'D', 'F']],
  ['empty IN', 'price:{operator:IN,value:[]}', []],
  ['empty NIN', 'price:{operator:NIN,value:[]}', ['A', 'B', 'C', 'D', 'E', 'F']],
  ['explicit null', 'description:{value:null}', ['A', 'E']],
  ['not null', 'description:{operator:NE,value:null}', ['B', 'C', 'D', 'F']],
  ['false boolean', 'isActive:{value:false}', ['C']],
  ['zero numeric', 'price:{value:0}', ['E']],
  ['enum filter', 'priceType:{value:"STARTING_AT"}', ['C', 'D']],
  ['LIKE literal', 'description:{operator:LIKE,value:"lip"}', ['B']],
  ['two scalar filters', 'isActive:{value:true},price:{operator:BTW,value:[10,30]}', ['A', 'B', 'D']],
  ['AND and nested OR with scalar filters', 'isActive:{value:true},AND:[{conditions:[{field:"price",operator:GTE,value:10}],OR:[{conditions:[{field:"priceType",value:"FIXED"}]},{conditions:[{field:"durationMinutes",operator:GTE,value:40}]}]}]', ['A', 'B', 'D', 'F']],
  ['nested OR/AND', 'OR:[{conditions:[{field:"price",value:0}]},{AND:[{conditions:[{field:"price",operator:GTE,value:20}]},{conditions:[{field:"price",operator:LTE,value:40},{field:"isActive",value:true}]}]}]', ['B', 'D', 'E']],
  ['reference ID', `barbershop:{terms:[{path:"id",value:${literal(shops[0].id)}}]}`, ['A', 'B', 'C']],
  ['reference to embedded scalar', 'barbershop:{terms:[{path:"address.city",value:"Cordoba"}]}', ['A', 'B', 'C', 'F']],
  ['same-path bounded relation terms', 'barbershop:{terms:[{path:"slotDurationMinutes",operator:GTE,value:20},{path:"slotDurationMinutes",operator:LTE,value:40}]}', ['D', 'E']],
  ['logical relation path', `AND:[{conditions:[${condition('barbershop.id', 'EQ', shops[1].id)}]}]`, ['D', 'E']],
];
for (const [name, filter, expected] of filters) await check(`filter: ${name}`, async () => {
  assert.deepEqual(names((await list(filter)).data.services), expected);
});
await check('pagination, ordering and pre-pagination total count', async () => {
  const result = await list('isActive:{value:true}', admin.accessToken, ',pagination:{page:2,size:2,count:true}', 'price', 'DESC');
  assert.deepEqual(names(result.data.services), ['B', 'A']);
  assert.equal(result.extensions.count, 5);
});
await check('empty result omits zero count extension', async () => {
  const result = await list('price:{operator:LT,value:0}', admin.accessToken, ',pagination:{page:1,size:2,count:true}');
  assert.deepEqual(result.data.services, []);
  assert.equal(result.extensions?.count, undefined);
});
const facts = '[{operation:COUNT,factName:"total",path:"id"},{operation:SUM,factName:"sum",path:"price"},{operation:AVG,factName:"avg",path:"price"},{operation:MIN,factName:"min",path:"price"},{operation:MAX,factName:"max",path:"price"}]';
const expectedFacts = (keys) => {
  const values = fixture.filter((row) => keys.includes(row.key)).map((row) => row.price);
  return { total: values.length, sum: values.reduce((a, b) => a + b, 0), avg: values.reduce((a, b) => a + b, 0) / values.length, min: Math.min(...values), max: Math.max(...values) };
};
for (const [name, filter, keys] of filters) await check(`aggregate with ${name}`, async () => {
  const result = await execute(`{services_aggregate(${rootFilter},${filter},aggregation:{groupId:"priceType",facts:${facts}},sort:{terms:[{field:"groupId",order:ASC}]}){groupId facts}}`, {}, admin.accessToken);
  const groups = ['FIXED', 'STARTING_AT'].map((groupId) => {
    const members = fixture.filter((row) => keys.includes(row.key) && row.priceType === groupId).map((row) => row.key);
    return members.length ? { groupId, facts: expectedFacts(members) } : null;
  }).filter(Boolean);
  assert.deepEqual(result.data.services_aggregate, groups);
});
await check('aggregate sorts facts then paginates groups', async () => {
  const result = await execute(`{services_aggregate(${rootFilter},isActive:{value:true},aggregation:{groupId:"priceType",facts:${facts}},sort:{terms:[{field:"sum",order:DESC},{field:"groupId",order:ASC}]},pagination:{page:2,size:1}){groupId facts}}`, {}, admin.accessToken);
  assert.deepEqual(result.data.services_aggregate, [{ groupId: 'STARTING_AT', facts: expectedFacts(['D']) }]);
});
await check('aggregate groups through a reference and an embedded path', async () => {
  const result = await execute(`{services_aggregate(${rootFilter},aggregation:{groupId:"barbershop.address.city",facts:${facts}},sort:{terms:[{field:"groupId",order:ASC}]}){groupId facts}}`, {}, admin.accessToken);
  assert.deepEqual(result.data.services_aggregate, [{ groupId: 'Cordoba', facts: expectedFacts(['A', 'B', 'C', 'F']) }, { groupId: 'Rosario', facts: expectedFacts(['D', 'E']) }]);
});
await check('one-to-many filter preserves joined rows and count', async () => {
  const result = await execute(`{barbershops(${shopFilter},services:{terms:[{path:"price",operator:GTE,value:20}]},sort:{terms:[{field:"slug",order:ASC}]},pagination:{page:1,size:10,count:true}){slug}}`, {}, admin.accessToken);
  assert.deepEqual(result.data.barbershops.map((row) => row.slug.slice(prefix.length + 1)), ['shop-0', 'shop-0', 'shop-1', 'shop-2']);
  assert.equal(result.extensions.count, 4);
});
await check('one-to-many aggregation filters before grouping', async () => {
  const result = await execute(`{barbershops_aggregate(${shopFilter},services:{terms:[{path:"price",operator:GTE,value:20}]},aggregation:{groupId:"address.city",facts:[{operation:COUNT,factName:"total",path:"services.id"},{operation:SUM,factName:"sum",path:"services.price"}]},sort:{terms:[{field:"groupId",order:ASC}]}){groupId facts}}`, {}, admin.accessToken);
  assert.deepEqual(result.data.barbershops_aggregate, [{ groupId: 'Cordoba', facts: { total: 3, sum: 159 } }, { groupId: 'Rosario', facts: { total: 1, sum: 30 } }]);
});
for (const [role, token, keys] of [['anonymous', null, ['A', 'B', 'C', 'D', 'E']], ['client', client.accessToken, ['A', 'B', 'C', 'D', 'E']], ['owner', owner.accessToken, ['A', 'B', 'C', 'D', 'E']], ['other owner', outsider.accessToken, ['F']]]) {
  await check(`scope + scalar/logical filters: ${role}`, async () => {
    const result = await list('OR:[{conditions:[{field:"price",operator:LTE,value:20}]},{conditions:[{field:"price",operator:GTE,value:90}]}]', token);
    assert.deepEqual(names(result.data.services), keys.filter((key) => ['A', 'B', 'E', 'F'].includes(key)));
  });
  await check(`scope + requested relation filter: ${role}`, async () => {
    const result = await list(`barbershop:{terms:[{path:"id",value:${literal(shops[0].id)}}]}`, token);
    assert.deepEqual(names(result.data.services), keys.filter((key) => ['A', 'B', 'C'].includes(key)));
  });
  await check(`scope + filtered aggregation: ${role}`, async () => {
    const result = await execute(`{services_aggregate(${rootFilter},barbershop:{terms:[{path:"id",value:${literal(shops[0].id)}}]},aggregation:{groupId:"priceType",facts:${facts}},sort:{terms:[{field:"groupId",order:ASC}]}){groupId facts}}`, {}, token);
    assert.deepEqual(result.data.services_aggregate, role === 'other owner' ? [] : [{ groupId: 'FIXED', facts: expectedFacts(['A', 'B']) }, { groupId: 'STARTING_AT', facts: expectedFacts(['C']) }]);
  });
}
const readShop = async () => (await execute(`query($id:ID!){barbershop(id:$id){${shopSelection}}}`, { id: shops[0].id }, admin.accessToken)).data.barbershop;
await check('client ID scope intersects requested list and single-record IDs', async () => {
  const read = await execute(`query($id:ID!){user(id:$id){id} users(id:{value:${literal(outsider.user.id)}}){id}}`, { id: outsider.user.id }, client.accessToken);
  assert.deepEqual(read.data, { user: null, users: [] });
});
await check('public state scope intersects requested state in lists and aggregates', async () => {
  const read = await execute(`{barbershops(${shopFilter},state:{value:"DRAFT"}){id} barbershops_aggregate(${shopFilter},state:{value:"DRAFT"},aggregation:{groupId:"state",facts:[{operation:COUNT,factName:"total",path:"id"}]}){groupId facts}}`);
  assert.deepEqual(read.data, { barbershops: [], barbershops_aggregate: [] });
});
for (const [filter, code] of [
  ['price:{operator:IN,value:[null,10]}', 'INVALID_FILTER_VALUE'],
  ['AND:[{conditions:[{field:"notAField",value:1}]}]', 'INVALID_FILTER_FIELD'],
  ['AND:[{conditions:[{field:"barbershop.name",path:"slug",value:"x"}]}]', 'AMBIGUOUS_FILTER_FIELD'],
]) await check(`invalid filter rejects with ${code}`, async () => {
  const result = await request(`{services(${rootFilter},${filter}){id}}`, {}, admin.accessToken);
  assert.equal(result.errors?.[0]?.extensions?.code, code);
});
await check('nested object update merges fields and preserves omitted arrays', async () => {
  await mutate('updatebarbershop', { id: shops[0].id, address: { city: 'Mendoza' } }, 'id', owner.accessToken);
  const read = await readShop();
  assert.deepEqual(read.address, { city: 'Mendoza', street: 'Initial street', number: '123' });
  assert.deepEqual(read.businessHours, shops[0].businessHours);
});
await check('nested array replaces values, including false and zero', async () => {
  const hours = [{ dayOfWeek: 0, openTime: '00:00', closeTime: '12:00', isClosed: false }];
  await mutate('updatebarbershop', { id: shops[0].id, businessHours: hours }, 'id', owner.accessToken);
  assert.deepEqual((await readShop()).businessHours, hours);
});
for (const value of [[], null]) await check(`embedded array clear ${JSON.stringify(value)} remains distinct`, async () => {
  await mutate('updatebarbershop', { id: shops[0].id, businessHours: value }, 'id', owner.accessToken);
  assert.deepEqual((await readShop()).businessHours, value);
});
await check('embedded object null is persisted', async () => {
  await mutate('updatebarbershop', { id: shops[0].id, contactInfo: null }, 'id', owner.accessToken);
  assert.equal((await readShop()).contactInfo, null);
});
await check('one-to-many added, updated and deleted share one parent mutation', async () => {
  await mutate('updatebarbershop', { id: shops[0].id, services: { added: [{ name: `${prefix}-G`, price: 7 }], updated: [{ id: services.A.id, price: 11 }], deleted: [services.B.id] } }, 'id', owner.accessToken);
  const read = await readShop();
  assert.deepEqual(names(read.services).sort(), ['A', 'C', 'G']);
  assert.equal(read.services.find((s) => s.id === services.A.id).price, 11);
  for (const row of read.services) assert.equal(row.barbershop.id, shops[0].id);
  assert.equal((await execute('query($id:ID!){service(id:$id){id}}', { id: services.B.id }, admin.accessToken)).data.service, null);
});
let professional;
await check('nested referenced child with embedded references (many-to-many)', async () => {
  const result = await mutate('updatebarbershop', { id: shops[0].id, professionals: { added: [{ name: `${prefix}-professional`, isActive: true, services: [{ service: { id: services.A.id } }, { service: { id: services.C.id } }] }] } }, 'id professionals { id name services { service { id name } } }', owner.accessToken);
  professional = result.professionals.find((p) => p.name === `${prefix}-professional`);
  assert.deepEqual(professional.services.map((row) => row.service.id), [services.A.id, services.C.id]);
});
await check('embedded references can be replaced, queried and cleared', async () => {
  assert.ok(professional);
  await mutate('updateprofessional', { id: professional.id, services: [{ service: { id: services.C.id } }] }, 'id', owner.accessToken);
  const read = await execute('query($id:ID!){professional(id:$id){services{service{id}}}}', { id: professional.id }, admin.accessToken);
  assert.deepEqual(read.data.professional.services, [{ service: { id: services.C.id } }]);
  const queried = await execute(`{professionals(name:{value:${literal(`${prefix}-professional`)}},services:{terms:[{path:"service.name",value:${literal(`${prefix}-C`)}}]}){id}}`, {}, admin.accessToken);
  assert.deepEqual(queried.data.professionals, [{ id: professional.id }]);
  await mutate('updateprofessional', { id: professional.id, services: [] }, 'id', owner.accessToken);
  assert.deepEqual((await execute('query($id:ID!){professional(id:$id){services{service{id}}}}', { id: professional.id }, admin.accessToken)).data.professional.services, []);
});
const invalidBundle = { name: `${prefix}-invalid-bundle`, price: 999, services: [{ service: { id: services.C.id } }] };
const bundleRejection = { message: 'Bundle price must be less than the sum of service prices (MVP rule)' };
await check('nested create rolls back parent and valid sibling after child controller failure', async () => {
  await mutate('addbarbershop', { name: `${prefix}-rollback`, slug: `${prefix}-rollback`, owner: { id: owner.user.id }, services: { added: [{ name: `${prefix}-rollback-service`, price: 5 }] }, bundles: { added: [invalidBundle] } }, 'id', owner.accessToken, bundleRejection);
  const read = await execute(`{barbershops(slug:{value:${literal(`${prefix}-rollback`)}}){id} services(name:{value:${literal(`${prefix}-rollback-service`)}}){id}}`, {}, admin.accessToken);
  assert.deepEqual(read.data, { barbershops: [], services: [] });
});
await check('nested update rolls back parent changes and new children', async () => {
  const before = await readShop();
  await mutate('updatebarbershop', { id: shops[0].id, name: 'Must roll back', services: { added: [{ name: `${prefix}-rollback-update`, price: 5 }] }, bundles: { added: [invalidBundle] } }, 'id', owner.accessToken, bundleRejection);
  assert.deepEqual(await readShop(), before);
});
await check('unauthorized nested update fails without changing parent or child', async () => {
  const before = await readShop();
  const response = await mutate('updatebarbershop', { id: shops[0].id, address: { city: 'Attack' }, services: { updated: [{ id: services.A.id, price: 999 }] } }, 'id', outsider.accessToken, { code: 'FORBIDDEN' });
  assert.equal(response.errors[0].extensions.code, 'FORBIDDEN');
  assert.deepEqual(await readShop(), before);
});
let booking;
const bookingSelection = 'id notes totalPrice startTime endTime lines { price durationMinutes service { id } }';
const readBooking = async () => (await execute(`query($id:ID!){booking(id:$id){${bookingSelection}}}`, { id: booking.id }, admin.accessToken)).data.booking;
await check('nested booking create executes hooks and derives totals', async () => {
  booking = await mutate('addbooking', { barbershop: { id: shops[0].id }, scheduledDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10), startTime: '10:00', lines: [{ service: { id: services.A.id }, price: 11, durationMinutes: 15 }, { service: { id: services.C.id }, price: 40, durationMinutes: 60 }] }, bookingSelection, client.accessToken);
  assert.equal(booking.totalPrice, 51);
  assert.equal(booking.endTime, '11:15');
  assert.deepEqual(await readBooking(), booking);
});
await check('omitted booking lines survive a partial update', async () => {
  await mutate('updatebooking', { id: booking.id, notes: 'Keep lines' }, 'id', owner.accessToken);
  const read = await readBooking();
  assert.deepEqual(read.lines, booking.lines);
  assert.equal(read.totalPrice, 51);
});
await check('booking line replacement updates references and derived values', async () => {
  await mutate('updatebooking', { id: booking.id, lines: [{ service: { id: services.A.id }, price: 0, durationMinutes: 0 }] }, 'id', owner.accessToken);
  const read = await readBooking();
  assert.equal(read.totalPrice, 0);
  assert.equal(read.endTime, '10:00');
  assert.deepEqual(read.lines, [{ price: 0, durationMinutes: 0, service: { id: services.A.id } }]);
});
for (const value of [[], null]) await check(`booking lines ${JSON.stringify(value)} clear totals and preserve shape`, async () => {
  await mutate('updatebooking', { id: booking.id, lines: value }, 'id', owner.accessToken);
  const read = await readBooking();
  assert.deepEqual(read.lines, value);
  assert.equal(read.totalPrice, 0);
  assert.equal(read.endTime, '10:00');
});
await check('owner scope preserves user OR in booking queries and aggregates', async () => {
  const filter = `OR:[{conditions:[{field:"id",value:${literal(booking.id)}},{field:"totalPrice",operator:GT,value:1000}]}]`;
  const result = await execute(`{bookings(${filter}){id} bookings_aggregate(${filter},aggregation:{groupId:"state",facts:[{operation:COUNT,factName:"total",path:"id"}]}){groupId facts}}`, {}, owner.accessToken);
  assert.deepEqual(result.data, { bookings: [], bookings_aggregate: [] });
});
await check('client scope preserves requested booking client in list and aggregate', async () => {
  const filter = `client:{terms:[{path:"id",value:${literal(outsider.user.id)}}]}`;
  const result = await execute(`{bookings(${filter}){id} bookings_aggregate(${filter},aggregation:{groupId:"state",facts:[{operation:COUNT,factName:"total",path:"id"}]}){groupId facts}}`, {}, client.accessToken);
  assert.deepEqual(result.data, { bookings: [], bookings_aggregate: [] });
});
await check('user relation scope preserves requested favorite owner', async () => {
  await mutate('addfavorite', { user: { id: client.user.id }, barbershop: { id: shops[0].id } }, 'id', client.accessToken);
  const result = await execute(`{favorites(user:{terms:[{path:"id",value:${literal(outsider.user.id)}}]}){id}}`, {}, client.accessToken);
  assert.deepEqual(result.data.favorites, []);
});
await check('missing embedded reference follows explicit database integrity guarantees', async () => {
  const missingId = services.A.id.length === 24 ? '000000000000000000000001' : '00000000-0000-0000-0000-000000000001';
  const before = await readBooking();
  const input = { id: booking.id, notes: 'Missing reference', lines: [{ service: { id: missingId }, price: 123, durationMinutes: 45 }] };
  if (database === 'postgresql') {
    await mutate('updatebooking', input, 'id', owner.accessToken, { code: 'REFERENCE_CONSTRAINT_VIOLATION', message: 'Reference constraint violated' });
    assert.deepEqual(await readBooking(), before);
  } else {
    await mutate('updatebooking', input, 'id', owner.accessToken);
    const read = await readBooking();
    assert.deepEqual(read.lines, [{ price: 123, durationMinutes: 45, service: null }]);
    assert.equal(read.totalPrice, 123);
    assert.equal(read.endTime, '10:45');
    await mutate('updatebooking', { id: booking.id, notes: before.notes, lines: before.lines }, 'id', owner.accessToken);
  }
});
const report = {
  endpoint, database, requests,
  passed: results.filter((r) => r.passed).length, failed: results.filter((r) => !r.passed).length,
  referenceIntegrity: database === 'postgresql' ? 'Missing reference rejected; transaction rolled back' : 'Missing reference accepted; read resolves to null (no foreign key)',
  results,
};
if (process.env.CONTRACT_REPORT) await writeFile(process.env.CONTRACT_REPORT, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Query/mutation HTTP contract: ${report.passed}/${results.length} checks passed; ${requests} requests.`);
process.exitCode = report.failed ? 1 : 0;
