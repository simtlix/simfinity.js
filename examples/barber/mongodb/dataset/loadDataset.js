import SimfinityClient from '@simtlix/simfinity-js-client';
import { users, barbershops, sampleBookings, sampleReviews } from './dataset.js';

const ENDPOINT = process.env.GRAPHQL_ENDPOINT || 'http://localhost:4400/graphql';

function esc(str) {
  return (str || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Mutable token for prepareHeaders (login lives outside SimfinityClient). */
function createAuthClient() {
  const auth = { accessToken: null };
  const client = new SimfinityClient(ENDPOINT, {
    prepareHeaders(headers) {
      if (auth.accessToken) headers['Authorization'] = `Bearer ${auth.accessToken}`;
    },
  });
  return { auth, client };
}

async function gqlRegister(client, auth, user) {
  const res = await client.execute(
    `mutation R($i: RegisterInput!) { register(input: $i) { accessToken refreshToken user { id email name role } } }`,
    { i: { email: user.email, password: user.password, name: user.name, phone: user.phone } },
  );
  if (res.errors?.length) throw new Error(res.errors[0].message);
  const payload = res.data.register;
  auth.accessToken = payload.accessToken;
  return payload;
}

async function gqlLogin(client, auth, email, password) {
  const res = await client.execute(
    `mutation L($i: LoginInput!) { login(input: $i) { accessToken refreshToken user { id email name role } } }`,
    { i: { email, password } },
  );
  if (res.errors?.length) throw new Error(res.errors[0].message);
  const payload = res.data.login;
  auth.accessToken = payload.accessToken;
  return payload;
}

(async () => {
  console.log('=== Loading BarberBooking dataset ===\n');

  const { auth, client } = createAuthClient();
  await client.init();
  console.log('SimfinityClient initialized.\n');

  // ── 1. Register users ──
  console.log('--- Registering users ---');
  const userMap = {};

  for (const u of users) {
    try {
      const payload = await gqlRegister(client, auth, u);
      userMap[u.email] = payload;
      console.log(`  Registered: ${u.email}`);
    } catch {
      try {
        const payload = await gqlLogin(client, auth, u.email, u.password);
        userMap[u.email] = payload;
        console.log(`  Logged in:  ${u.email}`);
      } catch (e2) {
        console.error(`  FAILED: ${u.email}: ${e2.message}`);
      }
    }
  }

  const seededAdmin = await gqlLogin(client, auth, process.env.ADMIN_EMAIL || 'admin@demo.com', process.env.ADMIN_PASSWORD || 'demo1234');

  // ── 2. Update roles & avatars ──
  console.log('\n--- Updating user roles & avatars ---');
  for (const u of users) {
    const session = userMap[u.email];
    if (!session) continue;
    const updates = {};
    if (u.role !== 'CLIENT') updates.role = u.role;
    if (u.avatarUrl) updates.avatarUrl = u.avatarUrl;
    if (Object.keys(updates).length === 0) continue;
    try {
      auth.accessToken = seededAdmin.accessToken;
      await client.update('user', session.user.id, updates, 'id role avatarUrl');
      console.log(`  ${u.email} -> ${u.role}`);
    } catch (e) {
      console.log(`  Update failed ${u.email}: ${e.message}`);
    }
  }

  // Re-login to get tokens with updated roles
  console.log('\n--- Re-login ---');
  for (const u of users) {
    try {
      const payload = await gqlLogin(client, auth, u.email, u.password);
      userMap[u.email] = payload;
      console.log(`  ${u.email} -> ${payload.user.role}`);
    } catch (e) {
      console.log(`  Re-login failed: ${u.email}: ${e.message}`);
    }
  }

  // ── 3. Create barbershops ──
  console.log('\n--- Creating barbershops ---');
  const barbershopIds = {};

  for (const shop of barbershops) {
    const ownerAuth = userMap[shop.ownerEmail];
    if (!ownerAuth) { console.log(`  No auth for owner ${shop.ownerEmail}`); continue; }
    auth.accessToken = ownerAuth.accessToken;

    console.log(`  Creating: ${shop.name} (owner: ${shop.ownerEmail})`);

    const bhList = shop.businessHours.map(h =>
      `{ dayOfWeek: ${Number(h.dayOfWeek)}, openTime: "${h.openTime}", closeTime: "${h.closeTime}", isClosed: ${h.isClosed} }`
    ).join(', ');

    const addr = shop.address;
    const ci = shop.contactInfo;

    try {
      const response = await client._sendRequest(`mutation {
        addbarbershop(input: {
          name: "${esc(shop.name)}", slug: "${shop.slug}",
          description: "${esc(shop.description)}", logoUrl: "${shop.logoUrl}",
          coverImageUrl: "${shop.coverImageUrl}",
          address: { street: "${addr.street}", number: "${addr.number}", city: "${addr.city}", state: "${addr.state}", zip: "${addr.zip}", country: "${addr.country}" },
          contactInfo: { phone: "${ci.phone}", whatsapp: "${ci.whatsapp}", email: "${ci.email}" },
          timezone: "${shop.timezone}", slotDurationMinutes: ${shop.slotDurationMinutes},
          bufferMinutes: ${shop.bufferMinutes}, minAdvanceHours: ${shop.minAdvanceHours},
          maxAdvanceDays: ${shop.maxAdvanceDays}, cancellationPolicyHours: ${shop.cancellationPolicyHours},
          owner: { id: "${ownerAuth.user.id}" },
          businessHours: [${bhList}]
        }) { id name state }
      }`);
      if (response.errors?.length) throw new Error(response.errors[0].message);
      barbershopIds[shop.name] = response.data.addbarbershop.id;
      console.log(`    OK: ${response.data.addbarbershop.id}`);
    } catch (e) {
      console.log(`    FAILED: ${e.message}`);
      try {
        const existing = await client.find('barbershop').fields('id name').exec();
        const found = existing.find(b => b.name === shop.name);
        if (found) { barbershopIds[shop.name] = found.id; console.log(`    Found: ${found.id}`); }
      } catch {}
      continue;
    }

    const shopId = barbershopIds[shop.name];

    // Categories
    const categoryIds = {};
    for (const cat of shop.categories) {
      try {
        const result = await client.add('serviceCategory', {
          name: cat.name, sortOrder: cat.sortOrder, isActive: cat.isActive,
          barbershop: { id: shopId },
        }, 'id name');
        categoryIds[cat.name] = result.id;
        console.log(`    Category: ${cat.name}`);
      } catch (e) { console.log(`    Category err: ${e.message}`); }
    }

    // Services
    const serviceIds = {};
    for (const svc of shop.services) {
      try {
        const input = {
          name: svc.name, description: svc.description, price: svc.price,
          durationMinutes: svc.durationMinutes, imageUrl: svc.imageUrl,
          isActive: svc.isActive, sortOrder: svc.sortOrder,
          barbershop: { id: shopId },
        };
        if (categoryIds[svc.categoryName]) input.category = { id: categoryIds[svc.categoryName] };
        const result = await client.add('service', input, 'id name');
        serviceIds[svc.name] = result.id;
        console.log(`    Service: ${svc.name}`);
      } catch (e) { console.log(`    Service err: ${e.message}`); }
    }

    // Professionals (need raw mutation for nested services array)
    for (const pro of shop.professionals) {
      const svcList = pro.serviceNames.filter(sn => serviceIds[sn]).map(sn => `{ service: { id: "${serviceIds[sn]}" } }`).join(', ');
      try {
        const response = await client._sendRequest(`mutation {
          addprofessional(input: { name: "${esc(pro.name)}", photoUrl: "${pro.photoUrl}", bio: "${esc(pro.bio)}", isActive: ${pro.isActive}, barbershop: { id: "${shopId}" }, services: [${svcList}] }) { id name }
        }`);
        if (response.errors?.length) throw new Error(response.errors[0].message);
        console.log(`    Professional: ${pro.name}`);
      } catch (e) { console.log(`    Professional err: ${e.message}`); }
    }

    // Bundles (need raw mutation for nested services array)
    for (const bundle of shop.bundles) {
      const svcList2 = bundle.serviceNames.filter(sn => serviceIds[sn]).map(sn => `{ service: { id: "${serviceIds[sn]}" } }`).join(', ');
      try {
        const response = await client._sendRequest(`mutation {
          addbundle(input: { name: "${esc(bundle.name)}", description: "${esc(bundle.description)}", price: ${bundle.price}, isActive: ${bundle.isActive}, barbershop: { id: "${shopId}" }, services: [${svcList2}] }) { id name }
        }`);
        if (response.errors?.length) throw new Error(response.errors[0].message);
        console.log(`    Bundle: ${bundle.name}`);
      } catch (e) { console.log(`    Bundle err: ${e.message}`); }
    }
  }

  // ── 4. Submit & approve barbershops ──
  console.log('\n--- Approving barbershops ---');
  const adminAuth = userMap['admin@demo.com'];
  for (const shop of barbershops) {
    const shopId = barbershopIds[shop.name];
    if (!shopId) continue;

    const ownerAuth = userMap[shop.ownerEmail];
    if (ownerAuth) {
      auth.accessToken = ownerAuth.accessToken;
      try {
        await client.transition('barbershop', 'submitforreview', shopId, {}, 'id state');
        console.log(`  Submitted: ${shop.name}`);
      } catch (e) { console.log(`  Submit: ${e.message}`); }
    }

    if (adminAuth) {
      auth.accessToken = adminAuth.accessToken;
      try {
        await client.transition('barbershop', 'approve', shopId, {}, 'id state');
        console.log(`  Approved: ${shop.name}`);
      } catch (e) { console.log(`  Approve: ${e.message}`); }
    }
  }

  // ── 5. Create bookings ──
  console.log('\n--- Creating bookings ---');

  const clientAuth = userMap['cliente@demo.com'];
  let allServices = [];
  if (clientAuth) {
    auth.accessToken = clientAuth.accessToken;
    try {
      allServices = await client.find('service').fields('id name price durationMinutes barbershop { id }').exec();
    } catch {}
  }

  for (const booking of sampleBookings) {
    const shopId = barbershopIds[booking.barbershopName];
    if (!shopId) { console.log(`  Skip: ${booking.barbershopName}`); continue; }

    const bookingClientAuth = userMap[booking.clientEmail];
    if (!bookingClientAuth) { console.log(`  Skip: no auth for ${booking.clientEmail}`); continue; }
    auth.accessToken = bookingClientAuth.accessToken;

    const linesArr = booking.serviceNames
      .map(sn => allServices.find(s => s.name === sn && s.barbershop?.id === shopId))
      .filter(Boolean)
      .map(svc => `{ service: { id: "${svc.id}" }, price: ${svc.price}, durationMinutes: ${svc.durationMinutes} }`);

    try {
      const response = await client._sendRequest(`mutation {
        addbooking(input: { scheduledDate: "${booking.scheduledDate}", startTime: "${booking.startTime}", notes: "${esc(booking.notes)}", paymentMethod: ${booking.paymentMethod}, client: { id: "${bookingClientAuth.user.id}" }, barbershop: { id: "${shopId}" }, lines: [${linesArr.join(', ')}] }) { id confirmationCode state totalPrice }
      }`);
      if (response.errors?.length) throw new Error(response.errors[0].message);
      const b = response.data.addbooking;
      console.log(`  Booking: ${b.confirmationCode} $${b.totalPrice} (${b.state})`);
    } catch (e) { console.log(`  Booking err: ${e.message}`); }
  }

  // ── 6. Create reviews ──
  console.log('\n--- Creating reviews ---');
  for (const review of sampleReviews) {
    const shopId = barbershopIds[review.barbershopName];
    if (!shopId) continue;
    const reviewClientAuth = userMap[review.clientEmail];
    if (!reviewClientAuth) continue;
    auth.accessToken = reviewClientAuth.accessToken;
    try {
      const result = await client.add('review', {
        rating: review.rating,
        comment: review.comment,
        client: { id: reviewClientAuth.user.id },
        barbershop: { id: shopId },
      }, 'id rating');
      console.log(`  Review: ${review.barbershopName} ${result.rating}★`);
    } catch (e) { console.log(`  Review err: ${e.message}`); }
  }

  // ── 7. Create favorites ──
  console.log('\n--- Creating favorites ---');
  const favPairs = [
    { email: 'cliente@demo.com', shop: 'The Heritage Club' },
    { email: 'cliente@demo.com', shop: 'Barba Roja Studio' },
    { email: 'laura@demo.com', shop: 'El Noble Groomer' },
    { email: 'diego@demo.com', shop: 'The Heritage Club' },
  ];
  for (const fav of favPairs) {
    const favClientAuth = userMap[fav.email];
    const shopId = barbershopIds[fav.shop];
    if (!favClientAuth || !shopId) continue;
    auth.accessToken = favClientAuth.accessToken;
    try {
      await client.add('favorite', {
        user: { id: favClientAuth.user.id },
        barbershop: { id: shopId },
      }, 'id');
      console.log(`  Fav: ${fav.email} -> ${fav.shop}`);
    } catch (e) { console.log(`  Fav err: ${e.message}`); }
  }

  console.log('\n✓ Dataset loading complete.');
})();
