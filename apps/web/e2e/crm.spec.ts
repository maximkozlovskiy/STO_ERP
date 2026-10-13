import { test, expect, type Page } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });

// ─── Список контрагентів ─────────────────────────────────────────────────────

test.describe('CRM — список контрагентів', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/counterparties');
    await expect(page).toHaveURL(/\/counterparties/, { timeout: 15_000 });
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
    await page.goto('/counterparties');
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
  // Стандарт списків (2026-10-13): клік по рядку показує бокову панель, повторний клік ховає;
  // у картку — олівцем або кнопкою «Відкрити картку» в панелі; з вимкненою панеллю клік
  // одразу відкриває картку.
  //
  // До цього обидва тести клікали по рядку й чекали переходу на `/counterparties/<id>`, якого
  // список ніколи не робив, і проходили лише завдяки `if (!(await firstRow.isVisible())) return`
  // (isVisible не чекає — тест виходив до завантаження таблиці).
  async function gotoList(page: Page, panelEnabled: boolean) {
    await page.addInitScript(enabled => {
      localStorage.setItem('sto_detail_panel_crm', String(enabled));
    }, panelEnabled);
    await page.goto('/counterparties');
    // Рядок контрагента — той, що має олівець (порожній стан і видалені рядки його не мають).
    const firstRow = page
      .locator('table tbody tr')
      .filter({ has: page.getByTitle('Редагувати') })
      .first();
    await expect(firstRow, 'seed має містити контрагентів').toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByRole('button', {
        name: panelEnabled ? 'Сховати бокову панель' : 'Показати бокову панель',
      }),
    ).toBeVisible();
    return firstRow;
  }
  const openCardBtn = (page: Page) => page.getByRole('button', { name: 'Відкрити картку' });

  test('клік по рядку показує панель із балансом, повторний клік ховає; картка не відкривається', async ({
    page,
  }) => {
    const firstRow = await gotoList(page, true);

    await firstRow.locator('td').nth(1).click();
    // Панель показує рядок: кнопка «Відкрити картку» і поле «Баланс» зі схеми панелі.
    await expect(openCardBtn(page)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Баланс', { exact: true }).first()).toBeVisible();
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    await expect(page).toHaveURL(/\/counterparties\/?(\?.*)?$/);

    await firstRow.locator('td').nth(1).click();
    await expect(openCardBtn(page)).toHaveCount(0, { timeout: 5_000 });
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  });

  test('картка відкривається олівцем і кнопкою панелі', async ({ page }) => {
    const firstRow = await gotoList(page, true);

    // Олівець: картка одразу, рядок у панель не вибирається.
    await firstRow.hover();
    await firstRow.getByTitle('Редагувати').click();
    await expect(page.locator('[role="dialog"]').first()).toBeVisible({ timeout: 10_000 });
    await expect(openCardBtn(page)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('[role="dialog"]')).toHaveCount(0, { timeout: 5_000 });

    // Кнопка панелі: клік по рядку → панель → «Відкрити картку».
    await firstRow.locator('td').nth(1).click();
    await openCardBtn(page).click();
    await expect(page.locator('[role="dialog"]').first()).toBeVisible({ timeout: 10_000 });
  });

  test('панель вимкнена: клік по рядку одразу відкриває картку', async ({ page }) => {
    const firstRow = await gotoList(page, false);

    await firstRow.locator('td').nth(1).click();

    await expect(page.locator('[role="dialog"]').first()).toBeVisible({ timeout: 10_000 });
    await expect(openCardBtn(page)).toHaveCount(0);
  });
});
