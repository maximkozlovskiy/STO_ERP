import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });

test('status badge tooltip appears on hover in work-orders list', async ({ page }) => {
  await page.goto('/work-orders');
  await expect(page).toHaveURL(/\/work-orders/, { timeout: 15_000 });

  // Wait for table rows with real data (skeleton rows have no status badge text)
  // Real status badge contains one of: Чернетка, Кошторис, В роботі, Виконано, etc.
  const realStatusBadge = page
    .locator('table tbody tr')
    .first()
    .locator('span.inline-flex.rounded-full')
    .first();
  await realStatusBadge.waitFor({ state: 'visible', timeout: 20_000 });
  await realStatusBadge.scrollIntoViewIfNeeded();

  // Move mouse away first so hover re-triggers onMouseEnter reliably even if
  // a previous test left the cursor over a sibling element. Playwright serializes
  // actions so no sleep is needed — hover() waits for actionability automatically.
  await page.mouse.move(0, 0);

  // Hover over the badge — Tooltip wraps the badge with onMouseEnter handler.
  // The badge itself is span.rounded-full; its parent is span.inline-flex (Tooltip wrapper).
  await realStatusBadge.hover();

  // Tooltip is rendered via createPortal into body — look for the fixed-positioned span
  // injected by Tooltip component (tooltip.tsx:36 — position: fixed).
  const tooltip = page.locator('body > span[style*="position: fixed"]');
  await expect(tooltip).toBeVisible({ timeout: 5_000 });
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
