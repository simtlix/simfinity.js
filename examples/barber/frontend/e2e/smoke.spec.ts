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
