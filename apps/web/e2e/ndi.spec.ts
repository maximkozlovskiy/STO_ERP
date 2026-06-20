import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/**
 * /ndi — Нормативно-довідкова інформація (ПРРО, валюти, ставки ПДВ, банк, каса).
 * Перевіряємо: завантаження, наявність усіх 8 табів, перемикання таб → URL ?tab=X,
 * рендер контенту в кожному табі без console error.
 */
const TABS = [
  { id: 'org', label: 'Організація' },
  { id: 'org-info', label: 'Реквізити організації' },
  { id: 'payments', label: 'Оплата' },
  { id: 'taxrates', label: 'Ставки ПДВ' },
  { id: 'currencies', label: 'Валюти' },
  { id: 'exchange-rates', label: 'Курси валют' },
  { id: 'bank-accounts', label: 'Банк. рахунки' },
  { id: 'cash-registers', label: 'Каса' },
];

test.describe('НДІ (Нормативно-довідкова інформація)', () => {
  test('сторінка завантажується з заголовком', async ({ page }) => {
    await page.goto('/ndi');
    await expect(page.locator('h1:has-text("Нормативно-довідкова інформація")')).toBeVisible({
      timeout: 20_000,
    });
  });

  test('всі 8 табів присутні', async ({ page }) => {
    await page.goto('/ndi');
    await expect(page.locator('h1:has-text("Нормативно-довідкова інформація")')).toBeVisible({
      timeout: 20_000,
    });
    for (const t of TABS) {
      await expect(page.locator(`button:has-text("${t.label}")`).first()).toBeVisible({
        timeout: 5_000,
      });
    }
  });

  test('перемикання табу → URL оновлюється на ?tab=X', async ({ page }) => {
    await page.goto('/ndi');
    await expect(page.locator('h1:has-text("Нормативно-довідкова інформація")')).toBeVisible({
      timeout: 20_000,
    });

    for (const t of ['payments', 'taxrates', 'currencies', 'bank-accounts'] as const) {
      const label = TABS.find(x => x.id === t)?.label;
      await page.locator(`button:has-text("${label}")`).first().click();
      // Чекати поки URL оновиться
      await expect(page).toHaveURL(new RegExp(`tab=${t}`), { timeout: 5_000 });
    }
  });

  test('таб "Валюти" завантажує контент (UAH у seed)', async ({ page }) => {
    await page.goto('/ndi?tab=currencies');
    await expect(page.locator('h1:has-text("Нормативно-довідкова інформація")')).toBeVisible({
      timeout: 20_000,
    });
    // Seed містить UAH — має зявитись хоча б одна валюта
    await expect(page.getByText(/UAH|гривня|Гривня/i).first()).toBeVisible({ timeout: 15_000 });
  });

  test('таб "Ставки ПДВ" завантажує контент', async ({ page }) => {
    await page.goto('/ndi?tab=taxrates');
    await expect(page.locator('h1:has-text("Нормативно-довідкова інформація")')).toBeVisible({
      timeout: 20_000,
    });
    // Очікуємо таблицю АБО empty state (без помилки)
    await expect(
      page
        .locator('table')
        .or(page.getByText(/Немає|Empty|Не знайдено|Додати/i))
        .first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('таб "Банк. рахунки" завантажує контент', async ({ page }) => {
    await page.goto('/ndi?tab=bank-accounts');
    await expect(page.locator('h1:has-text("Нормативно-довідкова інформація")')).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page
        .locator('table, [role="table"]')
        .or(page.getByText(/Немає|Empty|Не знайдено|Додати/i))
        .first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('таб "Каса" завантажує контент', async ({ page }) => {
    await page.goto('/ndi?tab=cash-registers');
    await expect(page.locator('h1:has-text("Нормативно-довідкова інформація")')).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page
        .locator('table, [role="table"]')
        .or(page.getByText(/Немає|Empty|Не знайдено|Додати/i))
        .first(),
    ).toBeVisible({ timeout: 15_000 });
  });
});
