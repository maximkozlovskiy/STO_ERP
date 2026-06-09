import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });

test('status badge tooltip appears on hover in work-orders list', async ({ page }) => {
  await page.goto('/work-orders');
  await expect(page).toHaveURL(/\/work-orders/, { timeout: 15_000 });

  // Wait for table rows to load
  await page.locator('table tbody tr').first().waitFor({ state: 'visible', timeout: 20_000 });

  // Find the first status badge
  const statusBadge = page
    .locator('table tbody tr')
    .first()
    .locator('[class*="rounded-full"]')
    .first();
  await statusBadge.waitFor({ state: 'visible', timeout: 15_000 });

  // Hover over the badge — tooltip should appear in document.body (portal)
  await statusBadge.hover();

  // Tooltip is rendered via createPortal into body — look for the fixed span
  const tooltip = page.locator('body > span[style*="position: fixed"]');
  await expect(tooltip).toBeVisible({ timeout: 3_000 });
  const text = await tooltip.textContent();
  expect(text?.length).toBeGreaterThan(10);
});

test('status tab tooltip appears on hover', async ({ page }) => {
  await page.goto('/work-orders');
  await expect(page).toHaveURL(/\/work-orders/, { timeout: 15_000 });

  // Hover over "В роботі" tab (has description)
  const tab = page.locator('button:has-text("В роботі")').first();
  await tab.waitFor({ state: 'visible', timeout: 10_000 });
  await tab.hover();

  const tooltip = page.locator('body > span[style*="position: fixed"]');
  await expect(tooltip).toBeVisible({ timeout: 3_000 });
  const text = await tooltip.textContent();
  expect(text).toContain('механік');
});
