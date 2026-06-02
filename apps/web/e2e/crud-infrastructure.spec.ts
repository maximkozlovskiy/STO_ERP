import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });

test.describe.configure({ mode: 'serial' });

const uid = () => Date.now().toString().slice(-6);

async function goToTab(page: import('@playwright/test').Page, tabName: string) {
  await page.goto('/infrastructure');
  await expect(page.locator(`button:has-text("${tabName}")`).first()).toBeVisible({
    timeout: 20_000,
  });
  await page.locator(`button:has-text("${tabName}")`).first().click();
  // Wait for the section header (h2 with the tab name) to appear — guarantees
  // that the tab content is mounted before we click "Додати". Without this the
  // "Додати" button may resolve in a stale section and open the wrong modal.
  await expect(page.locator(`h2:has-text("${tabName}")`).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('button:has-text("Додати")').first()).toBeVisible({ timeout: 10_000 });
}

// ─── Зони ─────────────────────────────────────────────────────────────────────

test.describe('Інфраструктура — CRUD зони', () => {
  test('створити зону → перевірити в таблиці → видалити', async ({ page }) => {
    const zoneName = `E2E-Зона-${uid()}`;

    await goToTab(page, 'Зони');
    await page.locator('button:has-text("Додати")').first().click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    await expect(modal.locator('h2:has-text("Нова зона")')).toBeVisible();

    await modal.locator('input[placeholder="Механічна зона А"]').fill(zoneName);

    const saveBtn = modal.locator('button:has-text("Зберегти")');
    await expect(saveBtn).toBeEnabled({ timeout: 5_000 });
    await saveBtn.click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    // Рядок з'явився в таблиці
    await expect(page.locator(`table tbody tr:has-text("${zoneName}")`).first()).toBeVisible({
      timeout: 15_000,
    });

    // Cleanup — soft delete
    const row = page.locator(`table tbody tr:has-text("${zoneName}")`).first();
    await row.locator('button:has(svg.lucide-trash2)').first().click();
    const confirmBtn = page.locator('button:has-text("Помітити на видалення")').first();
    if (await confirmBtn.isVisible({ timeout: 3_000 })) await confirmBtn.click();
  });

  test('зона — Зберегти disabled без назви', async ({ page }) => {
    await goToTab(page, 'Зони');
    await page.locator('button:has-text("Додати")').first().click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    await expect(modal.locator('button:has-text("Зберегти")')).toBeDisabled();
    await page.keyboard.press('Escape');
  });
});

// ─── Пости ────────────────────────────────────────────────────────────────────

test.describe('Інфраструктура — CRUD поста', () => {
  test('створити пост → перевірити в таблиці → видалити', async ({ page }) => {
    const postName = `E2E-Пост-${uid()}`;

    await goToTab(page, 'Пости');
    await page.locator('button:has-text("Додати")').first().click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });

    await modal.locator('input[placeholder="Пост №1"]').fill(postName);

    const saveBtn = modal.locator('button:has-text("Зберегти")');
    await expect(saveBtn).toBeEnabled({ timeout: 5_000 });
    await saveBtn.click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    await expect(page.locator(`table tbody tr:has-text("${postName}")`).first()).toBeVisible({
      timeout: 15_000,
    });

    const row = page.locator(`table tbody tr:has-text("${postName}")`).first();
    await row.locator('button:has(svg.lucide-trash2)').first().click();
    const confirmBtn = page.locator('button:has-text("Помітити на видалення")').first();
    if (await confirmBtn.isVisible({ timeout: 3_000 })) await confirmBtn.click();
  });
});

// ─── Склади ───────────────────────────────────────────────────────────────────

test.describe('Інфраструктура — CRUD складу', () => {
  test('створити склад → перевірити → видалити', async ({ page }) => {
    const warehouseName = `E2E-Склад-${uid()}`;

    await goToTab(page, 'Склади');
    await page.locator('button:has-text("Додати")').first().click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });

    await modal.locator('input[placeholder="Основний склад"]').fill(warehouseName);

    const saveBtn = modal.locator('button:has-text("Зберегти")');
    await expect(saveBtn).toBeEnabled({ timeout: 5_000 });
    await saveBtn.click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    await expect(page.locator(`table tbody tr:has-text("${warehouseName}")`).first()).toBeVisible({
      timeout: 15_000,
    });

    const row = page.locator(`table tbody tr:has-text("${warehouseName}")`).first();
    await row.locator('button:has(svg.lucide-trash2)').first().click();
    const confirmBtn = page.locator('button:has-text("Помітити на видалення")').first();
    if (await confirmBtn.isVisible({ timeout: 3_000 })) await confirmBtn.click();
  });
});
