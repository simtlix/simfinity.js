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
const existing = (await client.find('barbershop').fields('id slug').exec()).find((shop) => shop.slug === (process.env.DEMO_SHOP_SLUG || 'barber-demo'));
if (existing) {
  console.log(`Demo already ready: ${existing.id}`);
} else {
  const shop = await client.add('barbershop', {
    name: 'Simfinity Barber Demo', slug: (process.env.DEMO_SHOP_SLUG || 'barber-demo'), owner: { id: owner.id },
    description: 'Simfinity database example', address: { city: 'Buenos Aires', country: 'Argentina', street: 'Demo', number: '123' },
    timezone: 'America/Argentina/Buenos_Aires', slotDurationMinutes: 30, bufferMinutes: 0, minAdvanceHours: 0, maxAdvanceDays: 90,
    businessHours: Array.from({ length: 7 }, (_, dayOfWeek) => ({ dayOfWeek, openTime: '09:00', closeTime: '18:00', isClosed: false })),
  }, 'id name state');
  const service = await client.add('service', { name: 'Corte clásico', price: 25, durationMinutes: 30, priceType: 'FIXED', isActive: true, barbershop: { id: shop.id } }, 'id name');
  await client.add('professional', { name: 'Alex Demo', isActive: true, barbershop: { id: shop.id }, services: [{ service: { id: service.id } }] }, 'id');
  for (const action of ['submitforreview', 'approve']) {
    if (action === 'approve') await auth('login', 'admin@demo.com');
    const result = await client.execute(`mutation { ${action}_barbershop(input: { id: "${shop.id}" }) { id state } }`);
    if (result.errors?.length) throw new Error(result.errors[0].message);
  }
  console.log(`Demo ready: ${shop.id}`);
}
console.log('Accounts admin@demo.com, propietario@demo.com, cliente@demo.com — password demo1234');
