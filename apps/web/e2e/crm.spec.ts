import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });

// ─── Список контрагентів ─────────────────────────────────────────────────────

test.describe('CRM — список контрагентів', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/crm');
    await expect(page).toHaveURL(/\/crm/, { timeout: 15_000 });
    // Чекати кнопку додавання — стабільний індикатор готовності UI.
    // Після commit 3785721/c3cd333 add-button перейменовано: "Додати"/"+ Контрагент" → "Контрагент".
    await page
      .locator('button:has-text("Контрагент"):not(:has-text("Контрагенти"))')
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 });
  });

  test('сторінка завантажується', async ({ page }) => {
    await expect(page.locator('nextjs-portal, [data-nextjs-dialog]')).not.toBeVisible();
  });

  test('таблиця або empty state відображається', async ({ page }) => {
    await expect(
      page
        .locator('table, [role="table"]')
        .or(page.getByText(/Нічого не знайдено|Контрагентів не знайдено|немає контрагентів/i))
        .first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('пошук по контрагентах — input присутній', async ({ page }) => {
    const searchInput = page
      .locator('input[placeholder*="Пошук"], input[placeholder*="пошук"], input[type="search"]')
      .first();
    await expect(searchInput).toBeVisible({ timeout: 10_000 });
  });

  test('фільтр по типу контрагента присутній', async ({ page }) => {
    // Select або кнопки: Клієнт / Постачальник / Всі
    const typeFilter = page
      .locator(
        'select, button:has-text("Клієнт"), button:has-text("Постачальник"), [data-testid="type-filter"]',
      )
      .first();
    await expect(typeFilter).toBeVisible({ timeout: 10_000 });
  });

  test('кнопка "Контрагент" (додати) присутня', async ({ page }) => {
    // CRM page: add-button renamed to single-noun "Контрагент" (commit 3785721/c3cd333).
    // Exclude the "Контрагенти" page header.
    await expect(
      page.locator('button:has-text("Контрагент"):not(:has-text("Контрагенти"))').first(),
    ).toBeVisible({
      timeout: 10_000,
    });
  });
});

// ─── Пошук ───────────────────────────────────────────────────────────────────

test.describe('CRM — пошук', () => {
  test('пошук фільтрує результати', async ({ page }) => {
    await page.goto('/crm');
    await page.waitForLoadState('domcontentloaded');

    const searchInput = page
      .locator('input[placeholder*="Пошук"], input[placeholder*="пошук"]')
      .first();
    if (!(await searchInput.isVisible({ timeout: 5_000 }))) return;

    // Введення рядка що точно не співпадає → empty state або менше результатів
    await searchInput.fill('zzz_not_existing_xyz_123');
    await page.waitForTimeout(600); // debounce

    // Після введення неіснуючого рядка: таблиця порожня АБО показує "Нічого не знайдено"
    await page.waitForTimeout(700); // debounce 300ms + мережа
    const rows = page.locator('table tbody tr');
    const emptyText = page.getByText(/Нічого не знайдено/i);
    const rowCount = await rows.count();
    const hasEmptyState = await emptyText.isVisible().catch(() => false);
    expect(
      rowCount === 0 || hasEmptyState,
      `Очікувався порожній результат після пошуку 'zzz_not_existing_xyz_123', але знайдено ${rowCount} рядків`,
    ).toBe(true);
  });
});

// ─── Картка контрагента ─────────────────────────────────────────────────────

test.describe('CRM — картка контрагента', () => {
  test('картка відкривається та має таби', async ({ page }) => {
    await page.goto('/crm');
    await page.waitForLoadState('domcontentloaded');

    const firstRow = page.locator('table tbody tr').first();
    if (!(await firstRow.isVisible({ timeout: 5_000 }))) return;

    await firstRow.click();
    await page.waitForLoadState('domcontentloaded');

    await expect(page).toHaveURL(/\/crm\/[a-z0-9-]+/, { timeout: 10_000 });

    // Таби: Загальна інформація, Гаражі та авто, Взаєморозрахунки, Наряди
    const tabs = page.locator('[role="tab"], button[data-state]');
    await expect(tabs.first()).toBeVisible({ timeout: 10_000 });
  });

  test('картка показує баланс контрагента', async ({ page }) => {
    await page.goto('/crm');
    await page.waitForLoadState('domcontentloaded');

    const firstRow = page.locator('table tbody tr').first();
    if (!(await firstRow.isVisible({ timeout: 5_000 }))) return;

    await firstRow.click();
    await page.waitForLoadState('domcontentloaded');

    // Баланс у картці (може бути в DetailPanel або окремій секції)
    const balanceEl = page.locator('text=/баланс|Balance|грн|₴/i').first();
    await expect(balanceEl).toBeVisible({ timeout: 10_000 });
  });
});
