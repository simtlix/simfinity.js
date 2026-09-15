import { test, expect } from '@playwright/test';

const endpoint = process.env.GRAPHQL_ENDPOINT || 'http://localhost:4400/graphql';
const shopSlug = process.env.DEMO_SHOP_SLUG || 'barber-demo';

test('home loads and shows hero', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Encontrá tu/i })).toBeVisible();
});

test('search page renders', async ({ page }) => {
  await page.goto('/search');
  await expect(page.getByRole('heading', { name: /Resultados de búsqueda/i })).toBeVisible();
});

test('client logs in and books a real appointment', async ({ page, request }) => {
  const shops = await request.post(endpoint, { data: { query: '{ barbershops { id slug } }' } });
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

test('shop detail fits a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/b/${shopSlug}`);
  await expect(page.getByText('Corte clásico', { exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
