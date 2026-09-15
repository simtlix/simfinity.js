import SimfinityClient from '@simtlix/simfinity-js-client';

const ENDPOINT = process.env.GRAPHQL_ENDPOINT || 'http://localhost:4400/graphql';

const auth = { accessToken: null };
const client = new SimfinityClient(ENDPOINT, {
  prepareHeaders(headers) {
    if (auth.accessToken) headers['Authorization'] = `Bearer ${auth.accessToken}`;
  },
});

const PAGE_SIZE = 500;

const deleteAllOfType = async (typeName) => {
  let totalDeleted = 0;
  let batch;

  do {
    try {
      batch = await client.find(typeName).fields('id').page(1, PAGE_SIZE).exec();
    } catch (e) {
      throw new Error(`Error fetching ${typeName}: ${e.message}`);
    }

    for (const item of batch) {
      try {
        await client.delete(typeName, item.id, 'id');
        totalDeleted++;
      } catch (e) {
        throw new Error(`Error deleting ${typeName} ${item.id}: ${e.message}`);
      }
    }
  } while (batch.length > 0);

  if (totalDeleted === 0) {
    console.log(`No ${typeName} to delete.`);
  } else {
    console.log(`Deleted ${totalDeleted} ${typeName}(s).`);
  }
};

(async () => {
  await client.init();
  console.log('Client initialized via introspection.\n');

  const adminEmail = process.env.ADMIN_EMAIL || 'admin@demo.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'demo1234';

  try {
    const res = await client.execute(
      `mutation L($i: LoginInput!) { login(input: $i) { accessToken user { id email role } } }`,
      { i: { email: adminEmail, password: adminPassword } },
    );
    if (res.errors?.length) throw new Error(res.errors[0].message);
    const login = res.data?.login;
    if (login?.accessToken) {
      auth.accessToken = login.accessToken;
      console.log(`Logged in as admin: ${login.user.email} (${login.user.role})\n`);
    }
  } catch (e) {
    console.error(`Admin login failed: ${e.message}`);
    throw new Error('Dataset deletion requires an authenticated admin');
  }

  console.log('Starting dataset deletion...');

  await deleteAllOfType('favorite');
  await deleteAllOfType('review');
  await deleteAllOfType('booking');
  await deleteAllOfType('notification');
  await deleteAllOfType('bundle');
  await deleteAllOfType('professional');
  await deleteAllOfType('service');
  await deleteAllOfType('serviceCategory');
  await deleteAllOfType('barbershop');

  console.log('\nDataset deletion complete.');
  console.log('Note: Users are not deleted. Remove them manually if needed.');
})();
