import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

const uid = () => Date.now().toString().slice(-6);

test.describe('Правила ціноутворення — CRUD', () => {
  test('сторінка завантажується', async ({ page }) => {
    await page.goto('/pricing-rules');
    await expect(page.locator('h1:has-text("Ціноутворення"), h1:has-text("Правила")')).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page
        .locator('table')
        .or(page.getByText(/Нічого не знайдено|правил не знайдено/i))
        .first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  test('кнопка "Додати" присутня', async ({ page }) => {
    await page.goto('/pricing-rules');
    await expect(page.locator('h1:has-text("Ціноутворення"), h1:has-text("Правила")')).toBeVisible({
      timeout: 20_000,
    });
    // Add-button renamed to single noun "Правило" (commit 3785721/c3cd333).
    await expect(page.getByRole('button', { name: /^Правило$/ }).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('створити правило PERCENT → перевірити → видалити', async ({ page }) => {
    const ruleName = `E2E-Правило-${uid()}`;

    await page.goto('/pricing-rules');
    await expect(page.locator('h1:has-text("Ціноутворення"), h1:has-text("Правила")')).toBeVisible({
      timeout: 20_000,
    });
    // Add-button renamed to single noun "Правило".
    await page
      .getByRole('button', { name: /^Правило$/ })
      .first()
      .click();

    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    await expect(modal.locator('h2:has-text("Нове правило")')).toBeVisible();

    // Назва правила
    await modal.getByPlaceholder('Запчастини +35%').fill(ruleName);

    // Тип PERCENT (за замовчуванням)
    // Відсоток
    const pctInput = modal.locator('input[type="number"], spinbutton').first();
    if (await pctInput.isVisible({ timeout: 2_000 })) await pctInput.fill('20');

    const saveBtn = modal.locator('button:has-text("Зберегти"), button:has-text("Додати")').first();
    await expect(saveBtn).toBeEnabled({ timeout: 5_000 });
    await saveBtn.click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    // Перевірити в таблиці
    const searchInput = page.locator('input[placeholder*="Пошук"]').first();
    if (await searchInput.isVisible({ timeout: 3_000 })) {
      await searchInput.fill(ruleName);
      await page.waitForTimeout(400);
    }
    await expect(page.locator(`table tbody tr:has-text("${ruleName}")`).first()).toBeVisible({
      timeout: 15_000,
    });

    // Cleanup
    const row = page.locator(`table tbody tr:has-text("${ruleName}")`).first();
    await row.locator('button:has(svg.lucide-trash2)').first().click();
    const confirmBtn = page.locator('button:has-text("Помітити на видалення")').first();
    if (await confirmBtn.isVisible({ timeout: 3_000 })) await confirmBtn.click();
  });

  test('форма — Зберегти disabled без назви', async ({ page }) => {
    await page.goto('/pricing-rules');
    await expect(page.locator('h1:has-text("Ціноутворення"), h1:has-text("Правила")')).toBeVisible({
      timeout: 20_000,
    });
    await page
      .getByRole('button', { name: /^Правило$/ })
      .first()
      .click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    await expect(
      modal.locator('button:has-text("Зберегти"), button:has-text("Додати")').first(),
    ).toBeDisabled();
    await modal.getByRole('button', { name: 'Закрити' }).click();
    const leaveBtn = page.locator('button:has-text("Покинути")').first();
    if (await leaveBtn.isVisible({ timeout: 2_000 }).catch(() => false)) await leaveBtn.click();
    await expect(modal).not.toBeVisible({ timeout: 5_000 });
  });
});
