import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fetchWithRateLimitRetry } from './rateLimitedFetch.mjs';

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
  const response = await fetchWithRateLimitRetry(endpoint, () => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  }));
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
// Ordinary fixture writes read their current revision; conflict tests pass an explicit observed version.
async function withVersion(id, input, token) {
  const read = await request('query($id:ID!){booking(id:$id){version}}', { id }, token);
  assert.equal(read.errors, undefined, JSON.stringify(read.errors));
  assert.ok(read.data.booking, `Missing booking fixture ${id}`);
  return { ...input, version: read.data.booking.version };
}
async function deleteRecord(name, id, token) {
  const protectedBooking = name === 'deletebooking';
  const variables = protectedBooking ? await withVersion(id, { id }, admin.accessToken) : { id };
  return request(`mutation($id:ID!${protectedBooking ? ',$version:RecordVersion!' : ''}) { ${name}(id:$id${protectedBooking ? ',version:$version' : ''}) { id } }`, variables, token);
}
async function mutate(name, input, selection, token, rejected = false) {
  if ((name === 'updatebooking' || name.endsWith('_booking')) && input.version == null) {
    // Admin reads fixture metadata only; the mutation still runs as its original actor.
    input = await withVersion(input.id, input, admin.accessToken);
  }
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
for (const [label, actor] of [['owner', owner], ['admin', admin]]) {
  await check(`a new ${label}-created shop starts in review and stays private`, async () => {
    const slug = `${prefix}-onboarding-${label}`;
    const created = await mutate('addbarbershop', { name: slug, slug, owner: { id: owner.user.id } }, 'id state', actor.accessToken);
    assert.equal(created.state, 'PENDING_REVIEW');
    const query = `query($id:ID!){barbershop(id:$id){id state} barbershops(slug:{value:${literal(slug)}}){id state}}`;
    for (const token of [undefined, client.accessToken, outsider.accessToken]) {
      assert.deepEqual((await execute(query, { id: created.id }, token)).data, { barbershop: null, barbershops: [] });
    }
    assert.deepEqual((await execute(query, { id: created.id }, owner.accessToken)).data, { barbershop: created, barbershops: [created] });
  });
}
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
await mutate('updatebarbershop', { id: shops[2].id, rejectionReason: 'Needs more detail' }, 'id', admin.accessToken);
for (const [label, filter, expected] of [
  ['IIN embedded city', 'AND:[{conditions:[{field:"address.city",operator:IIN,value:["cordoba","ROSARIO"]}]}]', [0, 1, 2]],
  ['IS_NOT_EMPTY rejection reason', 'rejectionReason:{operator:IS_NOT_EMPTY}', [2]],
  ['NONE expensive services', 'AND:[{NONE:[{path:"services",conditions:[{field:"price",operator:GTE,value:90}]}]}]', [0, 1]],
  ['ANY conditions on the same service', 'AND:[{ANY:[{path:"services",conditions:[{field:"price",operator:GTE,value:30},{field:"durationMinutes",operator:LTE,value:45}]}]}]', [1]],
]) {
  await check(`shop operator: ${label}`, async () => {
    const read = await execute(`{barbershops(${shopFilter},${filter},sort:{terms:[{field:"slug",order:ASC}]}){id} barbershops_aggregate(${shopFilter},${filter},aggregation:{groupId:"state",facts:[{operation:COUNT,factName:"total",path:"id"}]}){facts}}`, {}, admin.accessToken);
    assert.deepEqual(read.data.barbershops.map(({ id }) => id), expected.map((index) => shops[index].id));
    assert.equal(read.data.barbershops_aggregate.reduce((total, group) => total + group.facts.total, 0), expected.length);
  });
}
await mutate('updatebarbershop', { id: shops[2].id, rejectionReason: null }, 'id', admin.accessToken);
await check('open-on-day matches one business-hours row and requires an explicit open flag', async () => {
  const created = await mutate('addbarbershop', {
    name: `${prefix}-hours`, slug: `${prefix}-hours`, owner: { id: owner.user.id },
    businessHours: [{ dayOfWeek: 1, isClosed: true }, { dayOfWeek: 2, isClosed: false }, { dayOfWeek: 3 }],
  }, 'id', owner.accessToken);
  await mutate('approve_barbershop', { id: created.id }, 'id', admin.accessToken);
  for (const [day, expected] of [[1, []], [2, [created.id]], [3, []]]) {
    const read = await execute(`{barbershops(id:{value:${literal(created.id)}},AND:[{ANY:[{path:"businessHours",conditions:[{field:"dayOfWeek",operator:EQ,value:${day}},{field:"isClosed",operator:EQ,value:false}]}]}]){id}}`);
    assert.deepEqual(read.data.barbershops.map(({ id }) => id), expected);
  }
  const dotted = await execute(`{barbershops(id:{value:${literal(created.id)}},AND:[{conditions:[{field:"businessHours.dayOfWeek",operator:EQ,value:1},{field:"businessHours.isClosed",operator:EQ,value:false}]}]){id}}`);
  assert.deepEqual(dotted.data.barbershops, [{ id: created.id }], 'Dotted terms can match different embedded rows');
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
await check('one-to-many filter returns each matching shop once and counts roots', async () => {
  const result = await execute(`{barbershops(${shopFilter},services:{terms:[{path:"price",operator:GTE,value:20}]},sort:{terms:[{field:"slug",order:ASC}]},pagination:{page:1,size:10,count:true}){slug}}`, {}, admin.accessToken);
  assert.deepEqual(result.data.barbershops.map((row) => row.slug.slice(prefix.length + 1)), ['shop-0', 'shop-1', 'shop-2']);
  assert.equal(result.extensions.count, 3);
});
await check('one-to-many filter paginates distinct shops', async () => {
  const result = await execute(`{barbershops(${shopFilter},services:{terms:[{path:"price",operator:GTE,value:20}]},sort:{terms:[{field:"slug",order:ASC}]},pagination:{page:2,size:1,count:true}){slug}}`, {}, admin.accessToken);
  assert.deepEqual(result.data.barbershops.map((row) => row.slug.slice(prefix.length + 1)), ['shop-1']);
  assert.equal(result.extensions.count, 3);
});
await check('one-to-many terms must match the same service', async () => {
  // Shop 0 has a cheap short service and an expensive long service, but no expensive short service.
  const result = await execute(`{barbershops(${shopFilter},services:{terms:[{path:"price",operator:GTE,value:40},{path:"durationMinutes",operator:LTE,value:30}]}){id}}`, {}, admin.accessToken);
  assert.deepEqual(result.data.barbershops, []);
});
await check('filter-only collection aggregation counts shops once', async () => {
  const result = await execute(`{barbershops_aggregate(${shopFilter},services:{terms:[{path:"price",operator:GTE,value:20}]},aggregation:{groupId:"address.city",facts:[{operation:COUNT,factName:"total",path:"id"}]},sort:{terms:[{field:"groupId",order:ASC}]}){groupId facts}}`, {}, admin.accessToken);
  assert.deepEqual(result.data.barbershops_aggregate, [{ groupId: 'Cordoba', facts: { total: 2 } }, { groupId: 'Rosario', facts: { total: 1 } }]);
});
await check('one-to-many aggregation filters before grouping', async () => {
  const result = await execute(`{barbershops_aggregate(${shopFilter},services:{terms:[{path:"price",operator:GTE,value:20}]},aggregation:{groupId:"address.city",facts:[{operation:COUNT,factName:"total",path:"services.id"},{operation:SUM,factName:"sum",path:"services.price"}]},sort:{terms:[{field:"groupId",order:ASC}]}){groupId facts}}`, {}, admin.accessToken);
  assert.deepEqual(result.data.barbershops_aggregate, [{ groupId: 'Cordoba', facts: { total: 3, sum: 159 } }, { groupId: 'Rosario', facts: { total: 1, sum: 30 } }]);
});
for (const [role, token, expected] of [
  ['anonymous', null, ['shop-0', 'shop-1']],
  ['client', client.accessToken, ['shop-0', 'shop-1']],
  ['owner', owner.accessToken, ['shop-0', 'shop-1']],
  ['other owner', outsider.accessToken, ['shop-2']],
  ['admin', admin.accessToken, ['shop-0', 'shop-1', 'shop-2']],
]) await check(`collection filter intersects shop and service visibility: ${role}`, async () => {
  // The other owner can see approved shops, but their service scope exposes only their own catalog.
  const result = await execute(`{barbershops(${shopFilter},services:{terms:[{path:"price",operator:GTE,value:20}]},sort:{terms:[{field:"slug",order:ASC}]}){slug}}`, {}, token);
  assert.deepEqual(result.data.barbershops.map((row) => row.slug.slice(prefix.length + 1)), expected);
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
  const read = await execute(`{barbershops(${shopFilter},state:{value:"PENDING_REVIEW"}){id} barbershops_aggregate(${shopFilter},state:{value:"PENDING_REVIEW"},aggregation:{groupId:"state",facts:[{operation:COUNT,factName:"total",path:"id"}]}){groupId facts}}`);
  assert.deepEqual(read.data, { barbershops: [], barbershops_aggregate: [] });
});
// #53: owners see approved shops plus their own in any state, never another owner's unpublished shops.
await check('owner shop scope hides other owners\' unpublished shops in lists, reads by ID and aggregates', async () => {
  // shops[0] and shops[1] are the owner's APPROVED shops; shops[2] is the outsider's PENDING_REVIEW shop.
  const slugs = (rows) => rows.map((row) => row.slug.slice(prefix.length + 1));
  const query = `query($id:ID!){ barbershop(id:$id){ id state } barbershops(${shopFilter},sort:{terms:[{field:"slug",order:ASC}]}){ slug }
    pending: barbershops(${shopFilter},state:{value:"PENDING_REVIEW"}){ slug }
    barbershops_aggregate(${shopFilter},aggregation:{groupId:"state",facts:[{operation:COUNT,factName:"total",path:"id"}]},sort:{terms:[{field:"groupId",order:ASC}]}){ groupId facts } }`;
  const asOwner = (await execute(query, { id: shops[2].id }, owner.accessToken)).data;
  assert.equal(asOwner.barbershop, null);
  assert.deepEqual(slugs(asOwner.barbershops), ['shop-0', 'shop-1']);
  assert.deepEqual(asOwner.pending, []);
  assert.deepEqual(asOwner.barbershops_aggregate, [{ groupId: 'APPROVED', facts: { total: 2 } }]);
  // The outsider keeps its own pending shop and the public approved shops.
  const asOutsider = (await execute(query, { id: shops[2].id }, outsider.accessToken)).data;
  assert.deepEqual(asOutsider.barbershop, { id: shops[2].id, state: 'PENDING_REVIEW' });
  assert.deepEqual(slugs(asOutsider.barbershops), ['shop-0', 'shop-1', 'shop-2']);
  assert.deepEqual(slugs(asOutsider.pending), ['shop-2']);
  assert.deepEqual(asOutsider.barbershops_aggregate, [{ groupId: 'APPROVED', facts: { total: 2 } }, { groupId: 'PENDING_REVIEW', facts: { total: 1 } }]);
});
await check('a shop that leaves REJECTED drops its rejection reason before it is public again', async () => {
  // Its slug stays outside shopFilter, so the shop counts of the other checks do not change.
  const rejected = await mutate('addbarbershop', { name: `${prefix}-rejected`, slug: `${prefix}-rejected`, owner: { id: owner.user.id } }, 'id', owner.accessToken);
  const read = `query($id:ID!){ barbershop(id:$id){ state rejectionReason } }`;
  assert.deepEqual(await mutate('reject_barbershop', { id: rejected.id, rejectionReason: 'Missing business licence' }, 'state rejectionReason', admin.accessToken), { state: 'REJECTED', rejectionReason: 'Missing business licence' });
  assert.deepEqual((await execute(read, { id: rejected.id }, owner.accessToken)).data.barbershop, { state: 'REJECTED', rejectionReason: 'Missing business licence' });
  assert.deepEqual(await mutate('resubmit_barbershop', { id: rejected.id }, 'state rejectionReason', owner.accessToken), { state: 'PENDING_REVIEW', rejectionReason: null });
  await mutate('approve_barbershop', { id: rejected.id }, 'id', admin.accessToken);
  assert.deepEqual((await execute(read, { id: rejected.id })).data.barbershop, { state: 'APPROVED', rejectionReason: null });
});
await check('text searches ignore case and treat wildcards literally', async () => {
  // Keep this service outside rootFilter so it does not change the operator fixtures.
  const service = await mutate('addservice', { name: `${prefix} Corte Clásico 100%`, price: 5, durationMinutes: 15, barbershop: { id: shops[0].id } }, 'id', owner.accessToken);
  for (const [operator, value, expected] of [
    ['ILIKE', 'CORTE CLÁSICO', [service.id]],
    ['ILIKE', '100%', [service.id]],
    ['ILIKE', '10_%', []],
    ['LIKE', 'CORTE', []],
  ]) {
    const result = await execute(`{services(id:{value:${literal(service.id)}},name:{operator:${operator},value:${literal(value)}}){id}}`, {}, admin.accessToken);
    assert.deepEqual(result.data.services.map(({ id }) => id), expected);
  }
  await execute('mutation($id:ID!){deleteservice(id:$id){id}}', { id: service.id }, admin.accessToken);
});
await check('unanswered reviews include empty replies', async () => {
  const reviewInput = { rating: 4, barbershop: { id: shops[0].id }, client: { id: client.user.id } };
  const empty = await mutate('addreview', { ...reviewInput, reply: '' }, 'id', admin.accessToken);
  const answered = await mutate('addreview', { ...reviewInput, reply: 'Gracias' }, 'id', admin.accessToken);
  const query = (filter) => `{reviews(id:{operator:IN,value:${literal([empty.id, answered.id])}},reply:${filter}){id}}`;
  assert.deepEqual((await execute(query('{operator:IS_EMPTY}'), {}, owner.accessToken)).data.reviews, [{ id: empty.id }]);
  assert.deepEqual((await execute(query('{operator:EQ,value:null}'), {}, owner.accessToken)).data.reviews, []);
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
  // #130: the new shop's bundle lists shops[0]'s service C, so the bundle controller rejects it.
  await mutate('addbarbershop', { name: `${prefix}-rollback`, slug: `${prefix}-rollback`, owner: { id: owner.user.id }, services: { added: [{ name: `${prefix}-rollback-service`, price: 5 }] }, bundles: { added: [invalidBundle] } }, 'id', owner.accessToken, { code: 'INVALID_BUNDLE_SERVICE' });
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
  // Service C is inactive, so a client books the active service A twice (#61).
  booking = await mutate('addbooking', { barbershop: { id: shops[0].id }, scheduledDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10), startTime: '10:00', lines: [{ service: { id: services.A.id }, price: 11, durationMinutes: 15 }, { service: { id: services.A.id }, price: 11, durationMinutes: 15 }] }, bookingSelection, client.accessToken);
  assert.equal(booking.totalPrice, 22);
  assert.equal(booking.endTime, '10:30');
  assert.deepEqual(await readBooking(), booking);
});
// Independent schedule, so concurrency assertions do not change the query/operator fixtures.
const versionShop = await mutate('addbarbershop', { name: `${prefix}-versions`, slug: `${prefix}-versions`, owner: { id: owner.user.id } }, 'id', owner.accessToken);
await mutate('approve_barbershop', { id: versionShop.id }, 'id', admin.accessToken);
const versionFields = 'id version state scheduledDate startTime notes';
const versionDate = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
const versionBooking = (startTime) => mutate('addbooking', { barbershop: { id: versionShop.id }, scheduledDate: versionDate, startTime, lines: [] }, versionFields, client.accessToken);
const readVersionBooking = async (id) => (await execute(`query($id:ID!){booking(id:$id){${versionFields}}}`, { id }, owner.accessToken)).data.booking;
await check('accepted booking writes advance the version by one', async () => {
  const created = await versionBooking('07:00');
  assert.equal(created.version, 1);
  const edited = await mutate('updatebooking', { id: created.id, version: created.version, notes: 'Accepted' }, versionFields, owner.accessToken);
  assert.equal(edited.version, 2);
  const cancelled = await mutate('cancelbyclient_booking', { id: created.id, version: edited.version }, versionFields, client.accessToken);
  assert.equal(cancelled.version, 3);
  assert.deepEqual(await readVersionBooking(created.id), cancelled);
});
await check('a stale booking version is rejected and changes nothing', async () => {
  const created = await versionBooking('08:00');
  const saved = await mutate('updatebooking', { id: created.id, version: created.version, notes: 'Current' }, versionFields, owner.accessToken);
  const rejected = await mutate('updatebooking', { id: created.id, version: saved.version - 1, startTime: '08:30', notes: 'Stale' }, versionFields, owner.accessToken, { code: 'VERSION_CONFLICT' });
  assert.equal(rejected.errors[0].extensions.status, 409);
  assert.deepEqual(await readVersionBooking(created.id), saved);
});
await check('an owner edit after a client reschedule conflicts', async () => {
  const observed = await versionBooking('09:00');
  const moved = await mutate('reschedule_booking', { id: observed.id, version: observed.version, startTime: '09:30' }, versionFields, client.accessToken);
  assert.equal(moved.version, observed.version + 1);
  const rejected = await mutate('updatebooking', { id: observed.id, version: observed.version, scheduledDate: observed.scheduledDate, startTime: observed.startTime, notes: 'Owner stale form' }, versionFields, owner.accessToken, { code: 'VERSION_CONFLICT' });
  assert.equal(rejected.errors[0].extensions.status, 409);
  assert.deepEqual(await readVersionBooking(observed.id), moved);
});
await check('nested booking writes require the observed child version and roll back their parent on conflict', async () => {
  const created = await versionBooking('10:00');
  await mutate('updatebarbershop', { id: versionShop.id, bookings: { updated: [{ id: created.id, version: created.version, notes: 'Nested' }] } }, 'id', owner.accessToken);
  const saved = await readVersionBooking(created.id);
  assert.equal(saved.version, created.version + 1);
  const readParent = async () => (await execute('query($id:ID!){barbershop(id:$id){name}}', { id: versionShop.id }, owner.accessToken)).data.barbershop;
  const before = await readParent();
  for (const bookings of [
    { updated: [{ id: created.id, version: created.version, notes: 'Stale nested' }] },
    { deleted: [{ id: created.id, version: created.version }] },
  ]) {
    await mutate('updatebarbershop', { id: versionShop.id, name: 'Must roll back', bookings }, 'id', owner.accessToken, { code: 'VERSION_CONFLICT' });
    assert.deepEqual(await readParent(), before);
    assert.deepEqual(await readVersionBooking(created.id), saved);
  }
  await mutate('updatebarbershop', { id: versionShop.id, bookings: { deleted: [{ id: created.id, version: saved.version }] } }, 'id', owner.accessToken);
  assert.equal(await readVersionBooking(created.id), null);
});
await check('omitted booking lines survive a partial update', async () => {
  await mutate('updatebooking', { id: booking.id, notes: 'Keep lines' }, 'id', owner.accessToken);
  const read = await readBooking();
  assert.deepEqual(read.lines, booking.lines);
  assert.equal(read.totalPrice, 22);
});
await check('booking line replacement updates references and derives durations from the catalog', async () => {
  // Service A lasts 15 minutes in the catalog; the API replaces the client's 0 and ignores the sent endTime.
  await mutate('updatebooking', { id: booking.id, endTime: '10:00', lines: [{ service: { id: services.A.id }, price: 0, durationMinutes: 0 }] }, 'id', owner.accessToken);
  const read = await readBooking();
  assert.equal(read.totalPrice, 0);
  assert.equal(read.endTime, '10:15');
  assert.deepEqual(read.lines, [{ price: 0, durationMinutes: 15, service: { id: services.A.id } }]);
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
await check('owner booking scope shows a shop booking to its owner only, in lists, aggregates and reads by ID', async () => {
  // The owner branch restricts through barbershop.owner; the outsider owns another shop and is no client.
  const byId = `id:{operator:EQ,value:${literal(booking.id)}}`;
  const query = `{all:bookings{id} one:bookings(${byId}){id} bookings_aggregate(${byId},aggregation:{groupId:"barbershop.id",facts:[{operation:COUNT,factName:"total",path:"id"}]}){groupId facts} booking(id:${literal(booking.id)}){id barbershop{id}}}`;
  const own = (await execute(query, {}, owner.accessToken)).data;
  assert.ok(own.all.some((row) => row.id === booking.id), 'the owner lists the booking at their shop');
  assert.deepEqual(own.one, [{ id: booking.id }]);
  assert.deepEqual(own.bookings_aggregate.map((row) => [row.groupId, row.facts.total]), [[shops[0].id, 1]]);
  assert.deepEqual(own.booking, { id: booking.id, barbershop: { id: shops[0].id } });
  const other = (await execute(query, {}, outsider.accessToken)).data;
  assert.deepEqual(other, { all: [], one: [], bookings_aggregate: [], booking: null });
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
// #61 and #130: the API derives booking and bundle values from the catalog of the booking's shop.
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const derivedBookings = [];
const derivedSelection = 'id state totalPrice confirmationCode createdAt lines { price durationMinutes }';
const inputFields = async (mutation) => {
  const arg = fields.find((entry) => entry.name === mutation).args.find((entry) => entry.name === 'input');
  const type = await execute(`{ __type(name:${literal(typeName(arg.type).replace(/!$/, ''))}) { inputFields { name } } }`);
  return type.data.__type.inputFields.map((field) => field.name);
};
await check('clients cannot set booking totals, confirmation codes or creation times', async () => {
  // createdAt is read-only, so no generated booking input accepts it.
  for (const name of ['addbooking', 'updatebooking']) assert.ok(!(await inputFields(name)).includes('createdAt'), `${name} accepts createdAt`);
  const started = Date.now();
  const created = await mutate('addbooking', { barbershop: { id: shops[0].id }, scheduledDate: tomorrow, startTime: '13:00', totalPrice: 1, confirmationCode: 'AAAAAA', lines: [{ service: { id: services.A.id }, price: 0 }] }, derivedSelection, client.accessToken);
  derivedBookings.push(created.id);
  assert.deepEqual(created.lines, [{ price: 11, durationMinutes: 15 }]);
  assert.equal(created.totalPrice, 11);
  assert.notEqual(created.confirmationCode, 'AAAAAA');
  assert.ok(Math.abs(Date.parse(created.createdAt) - started) < 60_000, created.createdAt);
  for (const sent of [{ totalPrice: 0, confirmationCode: 'ZZZZZZ' }, { totalPrice: null, confirmationCode: null }]) {
    assert.deepEqual(await mutate('updatebooking', { id: created.id, ...sent }, derivedSelection, client.accessToken), created);
  }
  await mutate('addbooking', { barbershop: { id: shops[0].id }, scheduledDate: tomorrow, startTime: '14:00', lines: [{ service: { id: services.A.id }, price: -1 }] }, 'id', client.accessToken, { code: 'INVALID_BOOKING_LINE' });
});
await check("clients book only active services and bundles of the booking's shop", async () => {
  // F belongs to the outsider's shop, D to shops[1], and C is inactive.
  for (const service of [services.F, services.D, services.C]) {
    await mutate('addbooking', { barbershop: { id: shops[0].id }, scheduledDate: tomorrow, startTime: '15:00', lines: [{ service: { id: service.id }, price: 1 }] }, 'id', client.accessToken, { code: 'INVALID_BOOKING_LINE' });
  }
  const withdrawn = await mutate('addbundle', { name: `${prefix}-withdrawn`, price: 5, isActive: false, barbershop: { id: shops[0].id }, services: [{ service: { id: services.A.id } }] }, 'id', owner.accessToken);
  await mutate('addbooking', { barbershop: { id: shops[0].id }, scheduledDate: tomorrow, startTime: '15:00', lines: [{ bundle: { id: withdrawn.id } }] }, 'id', client.accessToken, { code: 'INVALID_BOOKING_LINE' });
  // The shop's owner still books an inactive service, and its client keeps it when rescheduling.
  const kept = await mutate('addbooking', { barbershop: { id: shops[0].id }, client: { id: client.user.id }, scheduledDate: tomorrow, startTime: '16:00', lines: [{ service: { id: services.C.id } }] }, 'id totalPrice endTime', owner.accessToken);
  derivedBookings.push(kept.id);
  assert.deepEqual([kept.totalPrice, kept.endTime], [40, '17:00']);
  const moved = await mutate('reschedule_booking', { id: kept.id, scheduledDate: tomorrow, startTime: '17:00', lines: [{ service: { id: services.C.id }, price: 40, durationMinutes: 60 }] }, 'totalPrice startTime endTime', client.accessToken);
  assert.deepEqual(moved, { totalPrice: 40, startTime: '17:00', endTime: '18:00' });
});
await check("a client's line keeps its price while its service stays, and the shop's owner only lowers prices", async () => {
  const discounted = await mutate('addbooking', { barbershop: { id: shops[0].id }, client: { id: client.user.id }, scheduledDate: tomorrow, startTime: '19:00', lines: [{ service: { id: services.A.id }, price: 4 }] }, 'id totalPrice', owner.accessToken);
  derivedBookings.push(discounted.id);
  assert.equal(discounted.totalPrice, 4);
  // The booking page resends catalog prices when the client reschedules.
  const moved = await mutate('reschedule_booking', { id: discounted.id, scheduledDate: tomorrow, startTime: '19:30', lines: [{ service: { id: services.A.id }, price: 11, durationMinutes: 15 }] }, 'totalPrice lines { price }', client.accessToken);
  assert.deepEqual(moved, { totalPrice: 4, lines: [{ price: 4 }] });
  const extended = await mutate('updatebooking', { id: discounted.id, lines: [{ service: { id: services.A.id }, price: 0 }, { service: { id: services.A.id }, price: 0 }] }, 'totalPrice lines { price }', client.accessToken);
  assert.deepEqual(extended, { totalPrice: 15, lines: [{ price: 4 }, { price: 11 }] });
  await mutate('addbooking', { barbershop: { id: shops[0].id }, client: { id: client.user.id }, scheduledDate: tomorrow, startTime: '20:30', lines: [{ service: { id: services.A.id }, price: 12 }] }, 'id', owner.accessToken, { code: 'INVALID_BOOKING_LINE' });
});
await check('clients cannot change or delete completed bookings', async () => {
  const done = await mutate('addbooking', { barbershop: { id: shops[0].id }, scheduledDate: tomorrow, startTime: '21:00', lines: [{ service: { id: services.A.id } }] }, 'id', client.accessToken);
  derivedBookings.push(done.id);
  await mutate('complete_booking', { id: done.id }, 'id', owner.accessToken);
  for (const input of [{ notes: 'Late note' }, { lines: [{ service: { id: services.A.id }, price: 0 }] }]) {
    await mutate('updatebooking', { id: done.id, ...input }, 'id', client.accessToken, { code: 'FORBIDDEN' });
  }
  const removed = await deleteRecord('deletebooking', done.id, client.accessToken);
  assert.equal(removed.errors?.[0]?.extensions?.code, 'FORBIDDEN', JSON.stringify(removed));
  // The shop's owner still edits the record.
  assert.equal((await mutate('updatebooking', { id: done.id, notes: 'Paid in cash' }, 'notes', owner.accessToken)).notes, 'Paid in cash');
  const read = await execute('query($id:ID!){booking(id:$id){state totalPrice notes}}', { id: done.id }, admin.accessToken);
  assert.deepEqual(read.data.booking, { state: 'COMPLETED', totalPrice: 11, notes: 'Paid in cash' });
});
await check("the shop's owner books through updatebarbershop with catalog totals and a server confirmation code", async () => {
  // A nested booking names no barbershop: the core links it to its parent shop.
  const added = (startTime, service, extra = {}) => ({ id: shops[0].id, bookings: { added: [{ client: { id: client.user.id }, scheduledDate: tomorrow, startTime, lines: [{ service: { id: service.id } }], ...extra }] } });
  await mutate('updatebarbershop', added('22:00', services.A, { totalPrice: 1, confirmationCode: 'NESTS1' }), 'id', owner.accessToken);
  const rows = (await execute(`{bookings(barbershop:{terms:[{path:"id",value:${literal(shops[0].id)}}]},scheduledDate:{value:${literal(tomorrow)}},startTime:{value:"22:00"}){id totalPrice confirmationCode lines{price durationMinutes}}}`, {}, admin.accessToken)).data.bookings;
  assert.equal(rows.length, 1);
  derivedBookings.push(rows[0].id);
  assert.deepEqual([rows[0].totalPrice, rows[0].lines], [11, [{ price: 11, durationMinutes: 15 }]]);
  assert.match(rows[0].confirmationCode, /^[A-HJ-NP-Z2-9]{6}$/);
  await mutate('updatebarbershop', added('23:00', services.D), 'id', owner.accessToken, { code: 'INVALID_BOOKING_LINE' });
});
await check("bundles count repeated services, bookings hold a bundle's current services, and bundles use only their shop's services", async () => {
  const H = await mutate('addservice', { name: `${prefix}-H`, price: 10, durationMinutes: 10, isActive: true, barbershop: { id: shops[0].id } }, 'id', owner.accessToken);
  const bundle = await mutate('addbundle', { name: `${prefix}-double-H`, price: 15, barbershop: { id: shops[0].id }, services: [{ service: { id: H.id } }, { service: { id: H.id } }] }, 'id totalDurationMinutes', owner.accessToken);
  assert.equal(bundle.totalDurationMinutes, 20);
  assert.equal((await mutate('updatebundle', { id: bundle.id, totalDurationMinutes: 1 }, 'totalDurationMinutes', owner.accessToken)).totalDurationMinutes, 20);
  // A booking holds the bundle's current services, even before the bundle is saved again.
  await mutate('updateservice', { id: H.id, durationMinutes: 25 }, 'id', owner.accessToken);
  const held = await mutate('addbooking', { barbershop: { id: shops[0].id }, scheduledDate: tomorrow, startTime: '08:00', lines: [{ bundle: { id: bundle.id }, price: 0, durationMinutes: 1 }] }, 'id endTime totalPrice lines { price durationMinutes }', client.accessToken);
  derivedBookings.push(held.id);
  assert.deepEqual([held.endTime, held.totalPrice, held.lines], ['08:50', 15, [{ price: 15, durationMinutes: 50 }]]);
  await mutate('addbundle', { name: `${prefix}-cross-shop`, price: 1, barbershop: { id: shops[0].id }, services: [{ service: { id: services.D.id } }] }, 'id', owner.accessToken, { code: 'INVALID_BUNDLE_SERVICE' });
  await mutate('updatebundle', { id: bundle.id, barbershop: { id: shops[1].id } }, 'id', owner.accessToken, { code: 'INVALID_BUNDLE_SERVICE' });
});
await check("a bundle's stored duration follows its services' durations, so it matches what a new booking of the bundle holds", async () => {
  const readTotal = async (id) => (await execute('query($id:ID!){bundle(id:$id){totalDurationMinutes}}', { id }, client.accessToken)).data.bundle.totalDurationMinutes;
  const addService = (name, durationMinutes) => mutate('addservice', { name: `${prefix}-${name}`, price: 10, durationMinutes, isActive: true, barbershop: { id: shops[0].id } }, 'id', owner.accessToken);
  const S = await addService('S', 10);
  const T = await addService('T', 20);
  const bundle = await mutate('addbundle', { name: `${prefix}-S-S-T`, price: 25, barbershop: { id: shops[0].id }, services: [{ service: { id: S.id } }, { service: { id: S.id } }, { service: { id: T.id } }] }, 'id totalDurationMinutes', owner.accessToken);
  assert.equal(bundle.totalDurationMinutes, 40);
  // The dashboard's service edit page saves only the service; the bundle's total follows (S counts twice).
  await mutate('updateservice', { id: S.id, durationMinutes: 25 }, 'id', owner.accessToken);
  assert.equal(await readTotal(bundle.id), 70);
  const held = await mutate('addbooking', { barbershop: { id: shops[0].id }, scheduledDate: tomorrow, startTime: '11:00', lines: [{ bundle: { id: bundle.id } }] }, 'id endTime lines { durationMinutes }', client.accessToken);
  derivedBookings.push(held.id);
  assert.deepEqual([held.endTime, held.lines], ['12:10', [{ durationMinutes: 70 }]]);
  // A service updated through its shop, and a cleared duration (counted as zero), count too.
  await mutate('updatebarbershop', { id: shops[0].id, services: { updated: [{ id: S.id, durationMinutes: 5 }] } }, 'id', owner.accessToken);
  assert.equal(await readTotal(bundle.id), 30);
  await mutate('updateservice', { id: T.id, durationMinutes: null }, 'id', owner.accessToken);
  assert.equal(await readTotal(bundle.id), 10);
  await mutate('updateservice', { id: T.id, durationMinutes: 20 }, 'id', owner.accessToken);
  assert.equal(await readTotal(bundle.id), 30);
  // MongoDB deletes a listed service, which then counts nothing; PostgreSQL's foreign key keeps it.
  const removed = await request('mutation($id:ID!){deleteservice(id:$id){id}}', { id: T.id }, owner.accessToken);
  if (database === 'postgresql') assert.equal(removed.errors?.[0]?.extensions?.code, 'REFERENCE_CONSTRAINT_VIOLATION', JSON.stringify(removed));
  else assert.equal(removed.errors, undefined, JSON.stringify(removed.errors));
  assert.equal(await readTotal(bundle.id), database === 'postgresql' ? 30 : 10);
});
// Later checks see only the bookings they create.
for (const id of derivedBookings) await deleteRecord('deletebooking', id, admin.accessToken);
const report = {
  endpoint, database, requests,
  passed: results.filter((r) => r.passed).length, failed: results.filter((r) => !r.passed).length,
  referenceIntegrity: database === 'postgresql' ? 'Missing reference rejected; transaction rolled back' : 'Missing reference accepted; read resolves to null (no foreign key)',
  results,
};
if (process.env.CONTRACT_REPORT) await writeFile(process.env.CONTRACT_REPORT, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Query/mutation HTTP contract: ${report.passed}/${results.length} checks passed; ${requests} requests.`);
process.exitCode = report.failed ? 1 : 0;
