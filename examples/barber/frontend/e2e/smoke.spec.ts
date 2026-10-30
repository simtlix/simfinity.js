import { test, expect } from '@playwright/test';

const endpoint = process.env.GRAPHQL_ENDPOINT || 'http://localhost:4400/graphql';
const shopSlug = process.env.DEMO_SHOP_SLUG || 'barber-demo';
// Filter by slug on the server: an unfiltered list returns at most 100 shops and could miss the demo shop.
const shopBySlug = (selection: string) => ({ query: `query($slug: QLFilter) { barbershops(slug: $slug) { ${selection} } }`, variables: { slug: { operator: 'EQ', value: shopSlug } } });

test('home loads and shows hero', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Encontrá tu/i })).toBeVisible();
});

test('search page renders', async ({ page }) => {
  await page.goto('/search');
  await expect(page.getByRole('heading', { name: /Resultados de búsqueda/i })).toBeVisible();
});

test('owner onboarding puts the shop in review with one create', async ({ page, request }) => {
  const slug = `e2e-onboarding-${Date.now()}`;
  const email = `${slug}@example.test`;
  const gql = async (query: string, token?: string) => {
    const response = await request.post(endpoint, { data: { query }, headers: token ? { authorization: `Bearer ${token}` } : {} });
    const result = await response.json();
    expect(result.errors).toBeUndefined();
    return result.data;
  };
  const { registerOwner: owner } = await gql(`mutation { registerOwner(input:{name:"Onboarding owner",email:"${email}",password:"demo1234"}){accessToken user{id}} }`);
  const { login: admin } = await gql('mutation { login(input:{email:"admin@demo.com",password:"demo1234"}){accessToken} }');
  try {
    await page.goto('/auth/login');
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Contraseña', { exact: true }).fill('demo1234');
    await page.getByRole('button', { name: 'Iniciar Sesión', exact: true }).click();
    await expect(page).not.toHaveURL(/auth\/login/);
    await page.goto('/onboarding/barbershop');
    await page.getByLabel('Nombre del Negocio').fill(slug);
    await page.getByRole('button', { name: /Siguiente Paso/ }).click();
    await page.getByLabel('Calle', { exact: false }).fill('San Martín');
    await page.getByLabel('Ciudad', { exact: false }).fill('Córdoba');
    await page.getByRole('button', { name: /Siguiente Paso/ }).click();
    await page.getByRole('button', { name: /Siguiente Paso/ }).click();
    const mutations: string[] = [];
    page.on('request', (req) => {
      if (req.url() === endpoint && req.method() === 'POST') {
        const query = req.postDataJSON()?.query as string | undefined;
        if (query?.includes('mutation')) mutations.push(query);
      }
    });
    await page.getByRole('button', { name: /Crear Barbería/ }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByText('Pendiente', { exact: true })).toBeVisible();
    expect(mutations.filter((query) => query.includes('addbarbershop'))).toHaveLength(1);
    expect(mutations.filter((query) => query.includes('submitforreview_barbershop'))).toHaveLength(0);
    const { barbershops } = await gql(`{barbershops(slug:{value:"${slug}"}){state}}`, owner.accessToken);
    expect(barbershops).toEqual([{ state: 'PENDING_REVIEW' }]);
  } finally {
    const { barbershops } = await gql(`{barbershops(slug:{value:"${slug}"}){id}}`, admin.accessToken);
    for (const shop of barbershops) await gql(`mutation { deletebarbershop(id:"${shop.id}"){id} }`, admin.accessToken);
    await gql(`mutation { deleteuser(id:"${owner.user.id}"){id} }`, admin.accessToken);
  }
});

test('admin dashboard counts more than one page of users', async ({ page, request }) => {
  test.setTimeout(60_000);
  const gql = async (query: string, token?: string) => {
    const response = await request.post(endpoint, {
      data: { query }, headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    const result = await response.json();
    expect(result.errors).toBeUndefined();
    return result.data;
  };
  const { login } = await gql('mutation { login(input:{email:"admin@demo.com",password:"demo1234"}) { accessToken } }');
  const prefix = `e2e-totals-${Date.now()}`;
  const ids: string[] = [];
  try {
    for (let offset = 0; offset < 105; offset += 15) {
      const fields = Array.from({ length: 15 }, (_, index) => {
        const email = `${prefix}-${offset + index}@example.test`;
        return `u${index}:adduser(input:{name:"Totals fixture",email:"${email}",role:CLIENT}){id}`;
      }).join('\n');
      const created = await gql(`mutation { ${fields} }`, login.accessToken);
      ids.push(...Object.values(created as Record<string, { id: string }>).map(({ id }) => id));
    }
    await page.goto('/auth/login');
    await page.getByLabel('Email', { exact: true }).fill('admin@demo.com');
    await page.getByLabel('Contraseña', { exact: true }).fill('demo1234');
    await page.getByRole('button', { name: 'Iniciar Sesión', exact: true }).click();
    await expect(page).not.toHaveURL(/auth\/login/);
    await page.goto('/admin');
    const total = page.getByText('Usuarios Totales', { exact: true }).locator('..').locator('span.font-headline');
    await expect.poll(async () => Number((await total.textContent())?.replace(/\D/g, ''))).toBeGreaterThan(100);
  } finally {
    if (ids.length) {
      await gql(`mutation { ${ids.map((id, index) => `u${index}:deleteuser(id:"${id}"){id}`).join('\n')} }`, login.accessToken);
    }
  }
});

test('owner totals and calendar include all bookings and respect the selected day', async ({ page, request }) => {
  test.setTimeout(90_000);
  const gql = async (query: string, token?: string) => {
    const response = await request.post(endpoint, { data: { query }, headers: token ? { authorization: `Bearer ${token}` } : {} });
    const result = await response.json();
    expect(result.errors).toBeUndefined();
    return result.data;
  };
  const { login: admin } = await gql('mutation { login(input:{email:"admin@demo.com",password:"demo1234"}) { accessToken } }');
  const prefix = `e2e-calendar-${Date.now()}`;
  const email = `${prefix}@example.test`;
  const { registerOwner: owner } = await gql(`mutation { registerOwner(input:{name:"Calendar owner",email:"${email}",password:"demo1234"}) { accessToken user { id } } }`);
  const ids: string[] = [];
  let shopId: string | undefined;
  let serviceId: string | undefined;
  try {
    const hours = Array.from({ length: 7 }, (_, dayOfWeek) => `{dayOfWeek:${dayOfWeek},openTime:"00:00",closeTime:"23:59",isClosed:false}`).join(',');
    const { addbarbershop: shop } = await gql(`mutation { addbarbershop(input:{name:"Calendar fixture",slug:"${prefix}",owner:{id:"${owner.user.id}"},slotDurationMinutes:5,bufferMinutes:0,maxAdvanceDays:30,businessHours:[${hours}]}) { id state } }`, owner.accessToken);
    shopId = shop.id;
    expect(shop.state).toBe('PENDING_REVIEW');
    await gql(`mutation { approve_barbershop(input:{id:"${shop.id}"}){id} }`, admin.accessToken);
    const { addservice: service } = await gql(`mutation { addservice(input:{name:"Calendar service",price:10,durationMinutes:5,barbershop:{id:"${shop.id}"}}){id} }`, owner.accessToken);
    serviceId = service.id;
    const dateAfter = (days: number) => {
      const date = new Date();
      date.setDate(date.getDate() + days);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    };
    for (let offset = 0; offset < 106; offset += 15) {
      const fields = Array.from({ length: Math.min(15, 106 - offset) }, (_, index) => {
        const number = offset + index;
        const minutes = 9 * 60 + (number % 105) * 5;
        const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
        return `b${index}:addbooking(input:{barbershop:{id:"${shop.id}"},scheduledDate:"${dateAfter(number === 105 ? 1 : 2)}",startTime:"${time}",lines:[{service:{id:"${service.id}"}}]}){id}`;
      }).join('\n');
      const created = await gql(`mutation { ${fields} }`, owner.accessToken);
      ids.push(...Object.values(created as Record<string, { id: string }>).map(({ id }) => id));
    }
    await page.goto('/auth/login');
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Contraseña', { exact: true }).fill('demo1234');
    await page.getByRole('button', { name: 'Iniciar Sesión', exact: true }).click();
    await expect(page).not.toHaveURL(/auth\/login/);
    await page.goto('/dashboard');
    const kpi = (label: string) => page.getByText(label, { exact: true }).locator('..').locator('span.font-headline');
    await expect(kpi('Turnos Atendidos')).toHaveText('106');
    await page.goto('/dashboard/bookings');
    await expect(kpi('Turnos Totales')).toHaveText('0');
    await page.getByRole('button', { name: 'chevron_right', exact: true }).click();
    await expect(kpi('Turnos Totales')).toHaveText('1');
    await page.getByRole('button', { name: 'chevron_right', exact: true }).click();
    await expect(kpi('Turnos Totales')).toHaveText('105');
  } finally {
    if (ids.length) await gql(`mutation { ${ids.map((id, index) => `b${index}:deletebooking(id:"${id}"){id}`).join('\n')} }`, admin.accessToken);
    if (serviceId) await gql(`mutation { deleteservice(id:"${serviceId}"){id} }`, admin.accessToken);
    if (shopId) await gql(`mutation { deletebarbershop(id:"${shopId}"){id} }`, admin.accessToken);
    await gql(`mutation { deleteuser(id:"${owner.user.id}"){id} }`, admin.accessToken);
  }
});

test('client logs in and books a real appointment', async ({ page, request }) => {
  const shops = await request.post(endpoint, { data: shopBySlug('id slug') });
  expect(shops.ok()).toBeTruthy();
  const shopResult = await shops.json();
  expect(shopResult.errors).toBeUndefined();
  const shop = shopResult.data.barbershops.find((item: { slug: string }) => item.slug === shopSlug);
  expect(shop).toBeTruthy();
  await page.goto('/auth/login');
  await page.getByLabel('Email', { exact: true }).fill('cliente@demo.com');
  await page.getByLabel('Contraseña', { exact: true }).fill('demo1234');
  await page.getByRole('button', { name: 'Iniciar Sesión', exact: true }).click();
  await expect(page).not.toHaveURL(/auth\/login/);
  await page.goto(`/book?barbershop=${shop.id}`);
  await page.getByText('Corte clásico', { exact: true }).click();
  await page.getByRole('button', { name: /Continuar/ }).click();
  await page.getByRole('button', { name: 'chevron_right', exact: true }).click();
  await page.getByRole('button', { name: '15', exact: true }).click();
  await page.getByRole('button', { name: /Continuar/ }).click();
  await page.getByText('Alex Demo', { exact: true }).click();
  await page.getByRole('button', { name: /Continuar/ }).click();
  await page.getByRole('button', { name: /^\d{2}:\d{2}$/ }).filter({ visible: true }).and(page.locator(':enabled')).first().click();
  await page.getByRole('button', { name: /Continuar/ }).click();
  const bookingResponse = page.waitForResponse(async (response) => response.url() === endpoint && response.request().postData()?.includes('addbooking') === true);
  await page.getByRole('button', { name: /Confirmar Reserva/ }).click();
  const result = await (await bookingResponse).json();
  expect(result.errors).toBeUndefined();
  expect(result.data.addbooking.id).toMatch(/^(?:[0-9a-f]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  await expect(page.getByRole('heading', { name: '¡Turno Confirmado!' })).toBeVisible();
  await page.screenshot({ path: 'test-results/booking-confirmed.png', fullPage: true });
});

test('client reschedules a booking in place and keeps it when the new time is taken', async ({ page, request }) => {
  const gql = async (query: string, variables: Record<string, unknown> = {}, token?: string) => {
    const response = await request.post(endpoint, { data: { query, variables }, headers: token ? { authorization: `Bearer ${token}` } : {} });
    expect(response.ok()).toBeTruthy();
    return response.json();
  };
  const auth = async (operation: 'login' | 'register', input: Record<string, string>) => {
    const type = operation === 'login' ? 'LoginInput' : 'RegisterInput';
    const result = await gql(`mutation($input: ${type}!) { ${operation}(input: $input) { accessToken user { id } } }`, { input: { password: 'demo1234', ...input } });
    expect(result.errors).toBeUndefined();
    return result.data[operation] as { accessToken: string; user: { id: string } };
  };
  const readBooking = async (id: string, token: string) =>
    (await gql('query($id: ID!) { booking(id: $id) { id state scheduledDate startTime } }', { id }, token)).data.booking;
  const client = await auth('login', { email: 'cliente@demo.com' });
  const admin = await auth('login', { email: 'admin@demo.com' });
  const { query: catalogQuery, variables: catalogVariables } = shopBySlug('id slug services { id name price } professionals { id name }');
  const catalog = await gql(catalogQuery, catalogVariables);
  const shop = catalog.data.barbershops.find((item: { slug: string }) => item.slug === shopSlug);
  const service = shop.services.find((item: { name: string }) => item.name === 'Corte clásico');
  const professional = shop.professionals.find((item: { name: string }) => item.name === 'Alex Demo');
  // The 16th of next month, as the calendar shows it (the booking test above uses the 15th).
  const today = new Date();
  const day = new Date(today.getFullYear(), today.getMonth() + 1, 16);
  const scheduledDate = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-16`;
  const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  const slot = (startTime: string) => ({
    barbershop: { id: shop.id }, professional: { id: professional.id }, scheduledDate, startTime,
    lines: [{ service: { id: service.id }, price: service.price, durationMinutes: 30 }],
  });
  const addbooking = 'mutation($input: bookingInput!) { addbooking(input: $input) { id startTime } }';
  const created: string[] = [];
  let rival: { accessToken: string; user: { id: string } } | undefined;
  try {
    let original: { id: string; startTime: string } | undefined;
    for (let minutes = 9 * 60; !original && minutes < 18 * 60; minutes += 30) {
      original = (await gql(addbooking, { input: slot(clock(minutes)) }, client.accessToken)).data?.addbooking ?? undefined;
    }
    expect(original).toBeTruthy();
    created.push(original!.id);

    await page.goto('/auth/login');
    await page.getByLabel('Email', { exact: true }).fill('cliente@demo.com');
    await page.getByLabel('Contraseña', { exact: true }).fill('demo1234');
    await page.getByRole('button', { name: 'Iniciar Sesión', exact: true }).click();
    await expect(page).not.toHaveURL(/auth\/login/);
    await page.goto(`/book?barbershop=${shop.id}&reschedule=${original!.id}&step=date`);
    await page.getByRole('button', { name: 'chevron_right', exact: true }).click();
    await page.getByRole('button', { name: '16', exact: true }).click();
    await page.getByRole('button', { name: /Continuar/ }).click();
    // Wait for the next step: a second click on the date step would push step=professional again.
    await expect(page).toHaveURL(/[?&]step=professional(&|$)/);
    await page.getByRole('button', { name: /Continuar/ }).click();
    const times = page.getByRole('button', { name: /^\d{2}:\d{2}$/ }).filter({ visible: true });
    const time = (value: string) => times.filter({ hasText: new RegExp(`^\\s*${value}\\s*$`) });
    // The booking being rescheduled does not block its own time.
    await expect(time(original!.startTime)).toHaveCount(1);
    const offered = (await times.allTextContents()).map((text) => text.trim()).filter((time) => time !== original!.startTime);
    expect(offered.length).toBeGreaterThan(1);

    // Another client takes the chosen time before the reschedule is confirmed.
    rival = await auth('register', { name: 'E2E rival', email: `e2e-rival-${Date.now()}@example.test` });
    const taken = (await gql(addbooking, { input: slot(offered[0]) }, rival.accessToken)).data.addbooking;
    created.push(taken.id);
    await time(offered[0]).click();
    await page.getByRole('button', { name: /Continuar/ }).click();
    const rejected = page.waitForResponse((response) => response.url() === endpoint && response.request().postData()?.includes('reschedule_booking') === true);
    await page.getByRole('button', { name: /Confirmar Reserva/ }).click();
    const rejection = await (await rejected).json();
    expect(rejection.errors?.[0]?.extensions?.code).toBe('BOOKING_SLOT_UNAVAILABLE');
    await expect(page.getByText(/Tu turno original no cambió\./)).toBeVisible();
    expect(await readBooking(original!.id, client.accessToken)).toEqual({ ...original, state: 'CONFIRMED', scheduledDate });

    // The page reloads the taken times; the next choice moves the same booking.
    await expect(time(original!.startTime)).toHaveCount(1);
    await expect(time(offered[0])).toHaveCount(0);
    await expect(page.getByText(offered[0], { exact: true })).toBeVisible();
    const next = (await times.allTextContents()).map((text) => text.trim()).find((time) => time !== original!.startTime);
    expect(next).toBeTruthy();
    await time(next!).click();
    await page.getByRole('button', { name: /Continuar/ }).click();
    const accepted = page.waitForResponse((response) => response.url() === endpoint && response.request().postData()?.includes('reschedule_booking') === true);
    await page.getByRole('button', { name: /Confirmar Reserva/ }).click();
    const result = await (await accepted).json();
    expect(result.errors).toBeUndefined();
    expect(result.data.reschedule_booking.id).toBe(original!.id);
    await expect(page.getByRole('heading', { name: '¡Turno Confirmado!' })).toBeVisible();
    expect(await readBooking(original!.id, client.accessToken)).toEqual({ id: original!.id, state: 'CONFIRMED', scheduledDate, startTime: next });

    // A shop can cancel while the reschedule page is open. Submission must not report confirmation.
    await page.goto(`/book?barbershop=${shop.id}&reschedule=${original!.id}&step=date`);
    await page.getByRole('button', { name: 'chevron_right', exact: true }).click();
    await page.getByRole('button', { name: '16', exact: true }).click();
    await page.getByRole('button', { name: /Continuar/ }).click();
    // Wait for the next step: a second click on the date step would push step=professional again.
    await expect(page).toHaveURL(/[?&]step=professional(&|$)/);
    await page.getByRole('button', { name: /Continuar/ }).click();
    await expect(times.first()).toBeVisible();
    const staleTime = (await times.allTextContents()).map((text) => text.trim()).find((value) => value !== next);
    expect(staleTime).toBeTruthy();
    await time(staleTime!).click();
    await page.getByRole('button', { name: /Continuar/ }).click();
    const cancellation = await gql('mutation($id: ID!) { cancelbyshop_booking(input: { id: $id }) { id state } }', { id: original!.id }, admin.accessToken);
    expect(cancellation.errors).toBeUndefined();
    const staleResponse = page.waitForResponse((response) => response.url() === endpoint && response.request().postData()?.includes('reschedule_booking') === true);
    await page.getByRole('button', { name: /Confirmar Reserva/ }).click();
    const staleResult = await (await staleResponse).json();
    expect(staleResult.errors?.[0]?.extensions?.code).toBe('BAD_REQUEST');
    await expect(page.getByText(/Este turno ya no está confirmado/)).toBeVisible();
    await expect(page.getByRole('heading', { name: '¡Turno Confirmado!' })).toHaveCount(0);
    expect(await readBooking(original!.id, client.accessToken)).toEqual({ id: original!.id, state: 'CANCELLED_BY_SHOP', scheduledDate, startTime: next });
  } finally {
    for (const id of created) await gql('mutation($id: ID!) { deletebooking(id: $id) { id } }', { id }, admin.accessToken);
    if (rival) await gql('mutation($id: ID!) { deleteuser(id: $id) { id } }', { id: rival.user.id }, admin.accessToken);
  }
});

test('shop detail fits a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/b/${shopSlug}`);
  await expect(page.getByText('Corte clásico', { exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

/** GraphQL over the test's request context, plus demo logins. */
const api = (request: import('@playwright/test').APIRequestContext) => {
  const gql = async (query: string, variables: Record<string, unknown> = {}, token?: string) => {
    const response = await request.post(endpoint, { data: { query, variables }, headers: token ? { authorization: `Bearer ${token}` } : {} });
    expect(response.ok()).toBeTruthy();
    return response.json();
  };
  const login = async (email: string) => {
    const result = await gql('mutation($input: LoginInput!) { login(input: $input) { accessToken user { id } } }', { input: { email, password: 'demo1234' } });
    expect(result.errors).toBeUndefined();
    return result.data.login as { accessToken: string; user: { id: string } };
  };
  return { gql, login };
};

test('the shop page and booking links offer only active bundles', async ({ page, request }) => {
  const { gql, login } = api(request);
  const owner = await login('propietario@demo.com');
  const admin = await login('admin@demo.com');
  const { query, variables } = shopBySlug('id slug services { id name }');
  const shop = (await gql(query, variables)).data.barbershops.find((item: { slug: string }) => item.slug === shopSlug);
  const service = shop.services.find((item: { name: string }) => item.name === 'Corte clásico');
  const name = `E2E withdrawn ${Date.now()}`;
  const added = await gql('mutation($input: bundleInput!) { addbundle(input: $input) { id } }', { input: { name, price: 1, isActive: false, barbershop: { id: shop.id }, services: [{ service: { id: service.id } }] } }, owner.accessToken);
  expect(added.errors).toBeUndefined();
  const bundleId = added.data.addbundle.id;
  try {
    await page.goto(`/b/${shopSlug}`);
    await page.getByRole('button', { name: 'Bundles', exact: true }).click();
    const card = page.locator('div.group').filter({ hasText: name });
    await expect(card.getByText('No disponible', { exact: true })).toBeVisible();
    await expect(page.locator(`a[href*="bundle=${bundleId}"]`)).toHaveCount(0);

    // A link to it does not select it, so the client never reaches a booking the API refuses.
    await page.goto('/auth/login');
    await page.getByLabel('Email', { exact: true }).fill('cliente@demo.com');
    await page.getByLabel('Contraseña', { exact: true }).fill('demo1234');
    await page.getByRole('button', { name: 'Iniciar Sesión', exact: true }).click();
    await expect(page).not.toHaveURL(/auth\/login/);
    await page.goto(`/book?barbershop=${shop.id}&bundle=${bundleId}`);
    await expect(page.getByText('Corte clásico', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(name, { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Continuar/ })).toBeDisabled();
  } finally {
    await gql('mutation($id: ID!) { deletebundle(id: $id) { id } }', { id: bundleId }, admin.accessToken);
  }
});

/**
 * Records a test creates, deleted after it in reverse order with a fresh request context, so a test that
 * times out (whose own context is already closed) leaves no long-named items to widen the shop page.
 */
const leftovers: { mutation: string; id: string }[] = [];
const removeAfterTest = (mutation: string, id: string) => { leftovers.push({ mutation, id }); };
test.afterEach(async ({ playwright }) => {
  if (!leftovers.length) return;
  const context = await playwright.request.newContext();
  try {
    const { gql, login } = api(context);
    const admin = await login('admin@demo.com');
    for (const { mutation, id } of leftovers.splice(0).reverse()) {
      await gql(`mutation($id: ID!) { ${mutation}(id: $id) { id } }`, { id }, admin.accessToken);
    }
  } finally {
    await context.dispose();
  }
});

/** Signs the demo client in on the page. */
const signInAsClient = async (page: import('@playwright/test').Page) => {
  await page.goto('/auth/login');
  await page.getByLabel('Email', { exact: true }).fill('cliente@demo.com');
  await page.getByLabel('Contraseña', { exact: true }).fill('demo1234');
  await page.getByRole('button', { name: 'Iniciar Sesión', exact: true }).click();
  await expect(page).not.toHaveURL(/auth\/login/);
};

/** A service or bundle card of the booking page, whose accessible name starts with the item's name. */
const catalogCard = (page: import('@playwright/test').Page, name: string) => page.getByRole('button', { name: new RegExp(`^${name}`) });

test('a reschedule shows and keeps the price the booking was made at after the owner changes it', async ({ page, request }) => {
  const { gql, login } = api(request);
  const client = await login('cliente@demo.com');
  const owner = await login('propietario@demo.com');
  const { query, variables } = shopBySlug('id slug professionals { id name }');
  const shop = (await gql(query, variables)).data.barbershops.find((item: { slug: string }) => item.slug === shopSlug);
  const professional = shop.professionals.find((item: { name: string }) => item.name === 'Alex Demo');
  // The 18th of next month (the other tests use the 15th to the 17th).
  const today = new Date();
  const day = new Date(today.getFullYear(), today.getMonth() + 1, 18);
  const scheduledDate = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-18`;
  const name = `E2E rp ${Date.now() % 100000}`;
  const added = await gql('mutation($input: serviceInput!) { addservice(input: $input) { id } }', { input: { name, price: 90, durationMinutes: 30, isActive: true, barbershop: { id: shop.id } } }, owner.accessToken);
  expect(added.errors).toBeUndefined();
  const serviceId = added.data.addservice.id;
  removeAfterTest('deleteservice', serviceId);
  let bookingId: string | undefined;
  {
    for (let minutes = 9 * 60; !bookingId && minutes < 18 * 60; minutes += 30) {
      const startTime = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
      const input = { barbershop: { id: shop.id }, professional: { id: professional.id }, scheduledDate, startTime, lines: [{ service: { id: serviceId } }] };
      bookingId = (await gql('mutation($input: bookingInput!) { addbooking(input: $input) { id } }', { input }, client.accessToken)).data?.addbooking?.id;
    }
    expect(bookingId).toBeTruthy();
    removeAfterTest('deletebooking', bookingId!);
    // The owner lowers the price after the client booked at 90.
    const repriced = await gql('mutation($input: serviceInputForUpdate!) { updateservice(input: $input) { price } }', { input: { id: serviceId, price: 40 } }, owner.accessToken);
    expect(repriced.errors).toBeUndefined();

    await signInAsClient(page);
    await page.goto(`/book?barbershop=${shop.id}&reschedule=${bookingId}`);
    // The API keeps the price of a line the booking already has, so the page previews 90, not 40.
    await expect(page.getByText('RESUMEN ESTIMADO', { exact: true }).locator('..')).toContainText('$90');
    await expect(catalogCard(page, name)).toContainText('$90');
    await page.getByRole('button', { name: /Continuar/ }).click();
    await page.getByRole('button', { name: 'chevron_right', exact: true }).click();
    await page.getByRole('button', { name: '18', exact: true }).click();
    await page.getByRole('button', { name: /Continuar/ }).click();
    // Wait for the next step: a second click on the date step would push step=professional again.
    await expect(page).toHaveURL(/[?&]step=professional(&|$)/);
    await page.getByRole('button', { name: /Continuar/ }).click();
    await page.getByRole('button', { name: /^\d{2}:\d{2}$/ }).filter({ visible: true }).and(page.locator(':enabled')).first().click();
    await page.getByRole('button', { name: /Continuar/ }).click();
    await expect(page.getByText('Total Final', { exact: true }).locator('xpath=following-sibling::p[1]')).toHaveText('$90,00');
    const rescheduled = page.waitForResponse((response) => response.url() === endpoint && response.request().postData()?.includes('reschedule_booking') === true);
    await page.getByRole('button', { name: /Confirmar Reserva/ }).click();
    const response = await rescheduled;
    expect(response.request().postDataJSON().variables.input.lines).toEqual([{ service: { id: serviceId }, price: 90, durationMinutes: 30 }]);
    const result = await response.json();
    expect(result.errors).toBeUndefined();
    await expect(page.getByRole('heading', { name: '¡Turno Confirmado!' })).toBeVisible();
    const stored = await gql('query($id: ID!) { booking(id: $id) { totalPrice lines { price } } }', { id: bookingId }, client.accessToken);
    expect(stored.data.booking).toEqual({ totalPrice: 90, lines: [{ price: 90 }] });
  }
});

test('an active bundle taken apart does not leave its inactive service selectable', async ({ page, request }) => {
  const { gql, login } = api(request);
  const owner = await login('propietario@demo.com');
  const { query, variables } = shopBySlug('id slug');
  const shop = (await gql(query, variables)).data.barbershops.find((item: { slug: string }) => item.slug === shopSlug);
  const stamp = Date.now() % 100000;
  const withdrawn = `E2E off ${stamp}`;
  const offered = `E2E on ${stamp}`;
  const bundleName = `E2E mix ${stamp}`;
  const serviceIds: string[] = [];
  let bundleId: string | undefined;
  {
    for (const [name, price, isActive] of [[withdrawn, 7, false], [offered, 11, true]] as const) {
      const added = await gql('mutation($input: serviceInput!) { addservice(input: $input) { id } }', { input: { name, price, durationMinutes: 15, isActive, barbershop: { id: shop.id } } }, owner.accessToken);
      expect(added.errors).toBeUndefined();
      serviceIds.push(added.data.addservice.id);
      removeAfterTest('deleteservice', added.data.addservice.id);
    }
    const bundle = await gql('mutation($input: bundleInput!) { addbundle(input: $input) { id } }', { input: { name: bundleName, price: 15, isActive: true, barbershop: { id: shop.id }, services: serviceIds.map((id) => ({ service: { id } })) } }, owner.accessToken);
    expect(bundle.errors).toBeUndefined();
    bundleId = bundle.data.addbundle.id;
    removeAfterTest('deletebundle', bundleId!);

    await signInAsClient(page);
    await page.goto(`/book?barbershop=${shop.id}`);
    const summary = page.getByText('RESUMEN ESTIMADO', { exact: true }).locator('..');
    const continueButton = page.getByRole('button', { name: /Continuar/ });
    await expect(catalogCard(page, offered)).toBeVisible();
    await expect(catalogCard(page, withdrawn)).toHaveCount(0);
    // The bundle is active, so the client books it with the inactive service in it.
    await catalogCard(page, bundleName).click();
    await expect(summary).toContainText('$15');
    // Unchecking the active service takes the bundle apart. The inactive service cannot be a line of its
    // own (the API answers INVALID_BOOKING_LINE), so nothing stays selected.
    await catalogCard(page, offered).click();
    await expect(catalogCard(page, withdrawn)).toHaveCount(0);
    await expect(summary).toHaveCount(0);
    await expect(continueButton).toBeDisabled();
    await catalogCard(page, offered).click();
    await expect(summary).toContainText('$11');
    await expect(summary).toContainText('1 servicio seleccionado');
    await expect(continueButton).toBeEnabled();
    // While the bundle is selected, its inactive service is not listed on its own either.
    await catalogCard(page, bundleName).click();
    await expect(summary).toContainText('$15');
    await expect(catalogCard(page, withdrawn)).toHaveCount(0);
  }
});

test('admin moderation lists a review that its shop flagged', async ({ page, request }) => {
  const { gql, login } = api(request);
  const client = await login('cliente@demo.com');
  const owner = await login('propietario@demo.com');
  const admin = await login('admin@demo.com');
  const { query, variables } = shopBySlug('id slug services { id name } professionals { id name }');
  const shop = (await gql(query, variables)).data.barbershops.find((item: { slug: string }) => item.slug === shopSlug);
  const service = shop.services.find((item: { name: string }) => item.name === 'Corte clásico');
  const professional = shop.professionals.find((item: { name: string }) => item.name === 'Alex Demo');
  // The 17th of next month (the tests above use the 15th and 16th).
  const today = new Date();
  const day = new Date(today.getFullYear(), today.getMonth() + 1, 17);
  const scheduledDate = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-17`;
  const comment = `E2E flagged review ${Date.now()}`;
  let bookingId: string | undefined;
  let reviewId: string | undefined;
  try {
    for (let minutes = 9 * 60; !bookingId && minutes < 18 * 60; minutes += 30) {
      const startTime = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
      const input = { barbershop: { id: shop.id }, professional: { id: professional.id }, scheduledDate, startTime, lines: [{ service: { id: service.id } }] };
      bookingId = (await gql('mutation($input: bookingInput!) { addbooking(input: $input) { id } }', { input }, client.accessToken)).data?.addbooking?.id;
    }
    expect(bookingId).toBeTruthy();
    expect((await gql('mutation($id: ID!) { complete_booking(input: { id: $id }) { id } }', { id: bookingId }, owner.accessToken)).errors).toBeUndefined();
    const review = await gql('mutation($input: reviewInput!) { addreview(input: $input) { id } }', { input: { rating: 2, comment, client: { id: client.user.id }, barbershop: { id: shop.id }, booking: { id: bookingId } } }, client.accessToken);
    expect(review.errors).toBeUndefined();
    reviewId = review.data.addreview.id;
    const flagged = await gql('mutation($input: reviewInputForUpdate!) { updatereview(input: $input) { isReported } }', { input: { id: reviewId, isReported: true } }, owner.accessToken);
    expect(flagged.errors).toBeUndefined();

    await page.goto('/auth/login/admin');
    await page.getByLabel('Email', { exact: true }).fill('admin@demo.com');
    await page.getByLabel('Contraseña', { exact: true }).fill('demo1234');
    await page.getByRole('button', { name: 'Acceso Admin', exact: true }).click();
    await expect(page).not.toHaveURL(/auth\/login/);
    await page.goto('/admin/reviews');
    await expect(page.getByText(comment)).toBeVisible();
    await expect(page.getByText('No hay reseñas reportadas pendientes.')).toHaveCount(0);
  } finally {
    if (reviewId) await gql('mutation($id: ID!) { deletereview(id: $id) { id } }', { id: reviewId }, admin.accessToken);
    if (bookingId) await gql('mutation($id: ID!) { deletebooking(id: $id) { id } }', { id: bookingId }, admin.accessToken);
  }
});
