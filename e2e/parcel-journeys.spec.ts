import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Swiss Delivery Tracker' })).toBeVisible();
});

test('finds, filters, and opens a parcel', async ({ page }) => {
  await expect(page.getByRole('searchbox', { name: 'Search parcels' })).toBeHidden();
  await page.getByRole('button', { name: 'Search & filters' }).click();
  const search = page.getByRole('searchbox', { name: 'Search parcels' });
  await search.fill('birthday');
  await expect(page.getByText('Birthday gift 🎁')).toBeVisible();
  await expect(page.getByText('Coffee beans ☕')).toBeHidden();
  await expect(page.getByText('1 shown')).toBeVisible();

  await search.fill('');
  await page.getByLabel('Status').selectOption('delivered');
  await expect(page.getByText('Coffee beans ☕')).toBeVisible();
  await page.getByText('Coffee beans ☕').click();
  await expect(page.getByRole('dialog', { name: 'Coffee beans ☕' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Tracking history' }))
    .toHaveAttribute('aria-label', 'Tracking history');
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
