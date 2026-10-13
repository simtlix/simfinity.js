import SimfinityClient from '@simtlix/simfinity-js-client';

const endpoint = process.env.GRAPHQL_ENDPOINT || 'http://localhost:4400/graphql';
let token;
const client = new SimfinityClient(endpoint, { prepareHeaders(headers) { if (token) headers.Authorization = `Bearer ${token}`; } });
await client.init();
async function auth(operation, email, name) {
  const input = { email, password: 'demo1234', ...(name ? { name } : {}) };
  const result = await client.execute(`mutation($input: ${operation === 'login' ? 'LoginInput' : 'RegisterInput'}!) { ${operation}(input: $input) { accessToken user { id email role } } }`, { input });
  if (result.errors?.length) throw new Error(result.errors[0].message);
  const payload = result.data[operation]; token = payload.accessToken; return payload.user;
}
for (const [operation, email, name] of [['registerOwner', 'propietario@demo.com', 'Demo Owner'], ['register', 'cliente@demo.com', 'Demo Client']]) {
  try { await auth(operation, email, name); } catch { await auth('login', email); }
}
const owner = await auth('login', 'propietario@demo.com');
const slug = process.env.DEMO_SHOP_SLUG || 'barber-demo';
const shopFields = 'id state owner { id } services { id } professionals { id }';
// Look the shop up by slug on the server: an unfiltered list returns at most 100 shops, so the demo
// shop would be missed once more shops exist. Its owner sees it in any state.
const findShop = async (fields) => (await client.find('barbershop').where('slug', 'EQ', slug).fields(fields).exec())[0];
const takenSlug = () => new Error(`The shop ${slug} belongs to another account; set DEMO_SHOP_SLUG to another slug`);
let shop = await findShop(shopFields);
const created = !shop;
if (shop && shop.owner?.id !== owner.id) throw takenSlug();
if (!shop) {
  // Owners see other owners' shops only once they are APPROVED, so ask as the admin, who sees every
  // state, whether another account's unpublished shop already holds the slug.
  await auth('login', 'admin@demo.com');
  const existing = await findShop('id owner { id }');
  await auth('login', 'propietario@demo.com');
  if (existing) throw takenSlug();
  shop = await client.add('barbershop', {
    name: 'Simfinity Barber Demo', slug, owner: { id: owner.id },
    description: 'Simfinity database example', address: { city: 'Buenos Aires', country: 'Argentina', street: 'Demo', number: '123' },
    timezone: 'America/Argentina/Buenos_Aires', slotDurationMinutes: 30, bufferMinutes: 0, minAdvanceHours: 0, maxAdvanceDays: 90,
    businessHours: Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, openTime: '09:00', closeTime: '18:00', isClosed: false })),
  }, shopFields);
}
// A run that stopped part way left the shop without its service, professional or approval; finish it.
const pending = [];
let serviceId = shop.services?.[0]?.id;
if (!serviceId) {
  serviceId = (await client.add('service', { name: 'Corte clásico', price: 25, durationMinutes: 30, priceType: 'FIXED', isActive: true, barbershop: { id: shop.id } }, 'id')).id;
  pending.push('service');
}
if (!shop.professionals?.length) {
  await client.add('professional', { name: 'Alex Demo', isActive: true, barbershop: { id: shop.id }, services: [{ service: { id: serviceId } }] }, 'id');
  pending.push('professional');
}
async function transition(action) {
  const result = await client.execute(`mutation { ${action}_barbershop(input: { id: "${shop.id}" }) { id state } }`);
  if (result.errors?.length) throw new Error(result.errors[0].message);
  pending.push(action);
  return result.data[`${action}_barbershop`].state;
}
let { state } = shop;
if (state === 'DRAFT') state = await transition('submitforreview');
if (state === 'PENDING_REVIEW') {
  await auth('login', 'admin@demo.com');
  state = await transition('approve');
}
if (state !== 'APPROVED') throw new Error(`The demo shop ${slug} is ${state}; an admin must make it APPROVED again`);
if (created) console.log(`Demo ready: ${shop.id}`);
else if (pending.length) console.log(`Demo finished (${pending.join(', ')}): ${shop.id}`);
else console.log(`Demo already ready: ${shop.id}`);
console.log('Accounts admin@demo.com, propietario@demo.com, cliente@demo.com — password demo1234');
