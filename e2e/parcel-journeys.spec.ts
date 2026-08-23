import { expect, test, type Page } from '@playwright/test';

const browserErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Swiss Delivery Tracker' })).toBeVisible();
  // This control is rendered only after the client repository has loaded, so
  // it is also a stable signal that hydration and the first effect completed.
  await expect(page.getByRole('button', { name: 'Search & filters' })).toBeVisible();
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? []).toEqual([]);
});

test('finds, filters, and opens a parcel', async ({ page }) => {
  const search = page.getByRole('searchbox', { name: 'Search parcels' });
  await expect(search).toBeHidden();
  await page.getByRole('button', { name: 'Search & filters' }).click();
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  await search.fill('birthday');
  await expect(
    page.getByRole('region', { name: 'Needs attention' }).getByText('Birthday gift 🎁'),
  ).toBeVisible();
  await expect(page.locator('.parcel-sections').getByText('Coffee beans ☕')).toHaveCount(0);
  await expect(page.getByText('1 shown')).toBeVisible();

  await search.fill('');
  await page.getByLabel('Status').selectOption('delivered');
  await expect(page.getByText('Coffee beans ☕')).toBeVisible();
  await page.getByText('Coffee beans ☕').click();
  await expect(page.getByRole('dialog', { name: 'Coffee beans ☕' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Tracking history' }))
    .toHaveAttribute('aria-label', 'Tracking history');
});

test('carefully deletes an active parcel from its detail screen', async ({ page }) => {
  await page.getByRole('button', { name: /^New sneakers 👟 —/ }).click();
  const detail = page.getByRole('dialog', { name: 'New sneakers 👟' });
  await detail.getByLabel('Parcel actions', { exact: true }).click();
  await page.getByRole('button', { name: 'Delete permanently' }).click();

  let confirmation = page.getByRole('dialog', {
    name: /permanently delete new sneakers/i,
  });
  await expect(confirmation).toContainText('cannot be undone');
  await expect(confirmation.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await confirmation.getByRole('button', { name: 'Cancel' }).click();
  await expect(detail).toBeVisible();

  await detail.getByLabel('Parcel actions', { exact: true }).click();
  await page.getByRole('button', { name: 'Delete permanently' }).click();
  confirmation = page.getByRole('dialog', { name: /permanently delete new sneakers/i });
  await confirmation.getByRole('button', { name: 'Delete permanently' }).click();

  await expect(page.getByRole('status')).toContainText('New sneakers 👟 permanently deleted');
  await expect(detail).toBeHidden();
});

test('adds a parcel from tracking text', async ({ page }) => {
  await page.getByRole('button', { name: 'Add a parcel' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add a parcel' });
  await sheet.getByLabel("What's inside?").fill('Fondue set');
  await sheet.getByLabel('Tracking number or link').fill('Track 99.34.111111.22222222');
  await expect(sheet.getByText('Swiss Post will sync automatically.')).toBeVisible();
  await sheet.getByRole('button', { name: 'Add parcel' }).click();

  await expect(page.getByText('Fondue set')).toBeVisible();
  await expect(sheet).toBeHidden();
});

test('keeps invalid tracking input safely in the add sheet', async ({ page }) => {
  await page.getByRole('button', { name: 'Add a parcel' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add a parcel' });
  await sheet.getByLabel('Tracking number or link').fill('hello there');

  await expect(sheet.getByText(/couldn't find a tracking number/i)).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Add parcel' })).toBeDisabled();
  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth);
});
