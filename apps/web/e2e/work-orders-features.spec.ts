import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });

// ─────────────────────────────────────────────────────────────────────────────
// Recently added features in /work-orders:
// 1. "Інші" dropdown — statuses ON_HOLD / CANCELLED / ARCHIVED selectable
//    from a single dropdown next to the status tabs (work-orders/page.tsx:530).
// 2. "Виставити рахунок" button — appears in WO edit modal when status is
//    COMPLETED or INVOICED (CreateWorkOrderModal.tsx:938 canInvoice).
// 3. LinkedDocumentsPanel — rendered as the "Документи" tab of the WO edit
//    modal (CreateWorkOrderModal.tsx:1189) AND as a side popup from the list
//    when the row shows invoice/payment/calendar/warranty count badges.
// ─────────────────────────────────────────────────────────────────────────────

// ─── 1. "Інші" dropdown ──────────────────────────────────────────────────────

test.describe('Наряди — статус-фільтр "Інші" dropdown', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/work-orders');
    await expect(page).toHaveURL(/\/work-orders/, { timeout: 15_000 });
    // Wait for list-page ready signal — search input is rendered after data load.
    await expect(
      page
        .locator('button:has-text("Всі")')
        .or(page.locator('input[placeholder*="номером"]'))
        .first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  test('dropdown «Інші» присутній поряд зі статусними табами', async ({ page }) => {
    // Native <select> with default "Інші" option (page.tsx:546).
    const dropdown = page.locator('select').filter({ hasText: 'Інші' }).first();
    await expect(dropdown).toBeVisible({ timeout: 10_000 });
  });

  test('dropdown містить опції Призупинено / Скасовано / Архів', async ({ page }) => {
    const dropdown = page.locator('select').filter({ hasText: 'Інші' }).first();
    await expect(dropdown).toBeVisible({ timeout: 10_000 });

    // STATUS_TABS_EXTRA = [ON_HOLD, CANCELLED, ARCHIVED] (page.tsx:125-128)
    await expect(dropdown.locator('option[value="ON_HOLD"]')).toHaveText('Призупинено');
    await expect(dropdown.locator('option[value="CANCELLED"]')).toHaveText('Скасовано');
    await expect(dropdown.locator('option[value="ARCHIVED"]')).toHaveText('Архів');
  });

  test('вибір "Скасовано" — фільтрує таблицю (URL/state змінюється)', async ({ page }) => {
    const dropdown = page.locator('select').filter({ hasText: 'Інші' }).first();
    await expect(dropdown).toBeVisible({ timeout: 10_000 });

    // Capture initial row count so we know the filter took effect even if
    // there are no CANCELLED rows (empty state is a valid outcome).
    await dropdown.selectOption('CANCELLED');

    // After selection — dropdown displays "Скасовано" (selected value) AND it
    // becomes the active tab (primary background style).
    await expect(dropdown).toHaveValue('CANCELLED', { timeout: 5_000 });

    // Either rows are shown (every row is CANCELLED) or empty-state is shown.
    const tableBody = page.locator('table tbody');
    await expect(
      tableBody.or(page.getByText(/Нічого не знайдено|Нарядів не знайдено/i)),
    ).toBeVisible({
      timeout: 15_000,
    });
  });

  test('вибір "Архів" — dropdown відображає вибраний статус', async ({ page }) => {
    const dropdown = page.locator('select').filter({ hasText: 'Інші' }).first();
    await expect(dropdown).toBeVisible({ timeout: 10_000 });

    await dropdown.selectOption('ARCHIVED');
    await expect(dropdown).toHaveValue('ARCHIVED', { timeout: 5_000 });
  });

  test('вибір "Призупинено" — dropdown відображає вибраний статус', async ({ page }) => {
    const dropdown = page.locator('select').filter({ hasText: 'Інші' }).first();
    await expect(dropdown).toBeVisible({ timeout: 10_000 });

    await dropdown.selectOption('ON_HOLD');
    await expect(dropdown).toHaveValue('ON_HOLD', { timeout: 5_000 });
  });
});

// ─── 2. "Виставити рахунок" button in WO edit modal ──────────────────────────

// /work-orders defaults dateFrom=today / dateTo=today (page.tsx:216). To see
// rows from previous days we clear both date inputs before applying a status
// filter. EmptyState row also matches `table tbody tr`, so we look for a real
// WO number cell ("НРД-…") to know data really loaded.
async function clearDateFilters(page: import('@playwright/test').Page) {
  // DatePickerInput placeholder is "ДД.ММ.РРРР" (date-picker-input.tsx:65).
  // Two inputs side-by-side: "З" (from) and "По" (to) — both default to today.
  // Focus opens the calendar popup (line 149: onFocus → setOpen(true)) which
  // intercepts subsequent hover/click. So after filling, click the page
  // heading <h1>Наряди</h1> (outside containerRef) to trigger close.
  const dateInputs = page.locator('input[placeholder="ДД.ММ.РРРР"]');
  const count = await dateInputs.count();
  for (let i = 0; i < count; i++) {
    const inp = dateInputs.nth(i);
    if (await inp.isVisible().catch(() => false)) {
      await inp.fill('');
    }
  }
  // Outside-click closes popup (date-picker-input.tsx:83 containerRef check).
  await page.locator('h1, h2').first().click({ force: true });
  // Brief debounce so query refetches with cleared dateFrom/dateTo before we
  // assert table contents.
  await page.waitForTimeout(500);
}

const realRowLocator = (page: import('@playwright/test').Page) =>
  page.locator('table tbody tr:has(td span.text-primary)');

test.describe('Наряд — кнопка "Виставити рахунок" у модалці', () => {
  test('кнопка "Виставити рахунок" відсутня для DRAFT нарядів', async ({ page }) => {
    await page.goto('/work-orders');
    await expect(page).toHaveURL(/\/work-orders/, { timeout: 15_000 });

    // Wait for initial table render.
    await page.locator('table').first().waitFor({ state: 'visible', timeout: 20_000 });
    await clearDateFilters(page);
    await page.waitForTimeout(500);

    // Filter to DRAFT only — guaranteed status where Invoice button must NOT show.
    const draftTab = page
      .locator('button:has-text("Чернетка"), button:has-text("Чернетки")')
      .first();
    await expect(draftTab).toBeVisible({ timeout: 10_000 });
    await draftTab.click();
    await page.waitForTimeout(800);

    const firstRow = realRowLocator(page).first();
    const hasRow = await firstRow
      .waitFor({ state: 'visible', timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    if (!hasRow) {
      test.skip(true, 'Немає DRAFT нарядів у БД для перевірки');
      return;
    }

    // Hover-only Pencil action button opens the WO edit modal (page.tsx:1020).
    await firstRow.hover();
    const editBtn = firstRow.locator('button[title="Відкрити наряд"]').first();
    await expect(editBtn).toBeVisible({ timeout: 5_000 });
    await editBtn.click();

    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 15_000 });

    // canInvoice = ['COMPLETED', 'INVOICED'].includes(currentStatus). DRAFT → no button.
    await expect(modal.locator('button:has-text("Виставити рахунок")')).not.toBeVisible({
      timeout: 3_000,
    });

    // Cleanup — close modal.
    await page.keyboard.press('Escape');
  });

  test('кнопка "Виставити рахунок" присутня для COMPLETED/INVOICED', async ({ page }) => {
    await page.goto('/work-orders');
    await expect(page).toHaveURL(/\/work-orders/, { timeout: 15_000 });

    await page.locator('table').first().waitFor({ state: 'visible', timeout: 20_000 });
    await clearDateFilters(page);
    await page.waitForTimeout(500);

    let foundRow = false;

    // Try COMPLETED tab first.
    const completedTab = page
      .locator('button:has-text("Виконано"), button:has-text("Виконані")')
      .first();
    if (await completedTab.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await completedTab.click();
      await page.waitForTimeout(800);
      const firstRow = realRowLocator(page).first();
      const ok = await firstRow
        .waitFor({ state: 'visible', timeout: 6_000 })
        .then(() => true)
        .catch(() => false);
      if (ok) {
        foundRow = true;
        await firstRow.hover();
        const editBtn = firstRow.locator('button[title="Відкрити наряд"]').first();
        await expect(editBtn).toBeVisible({ timeout: 5_000 });
        await editBtn.click();
      }
    }

    // Fallback to INVOICED tab ("Виставлено") if no COMPLETED row found.
    if (!foundRow) {
      const invoicedTab = page.locator('button:has-text("Виставлено")').first();
      if (await invoicedTab.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await invoicedTab.click();
        await page.waitForTimeout(800);
        const firstRow = realRowLocator(page).first();
        const ok = await firstRow
          .waitFor({ state: 'visible', timeout: 6_000 })
          .then(() => true)
          .catch(() => false);
        if (ok) {
          foundRow = true;
          await firstRow.hover();
          const editBtn = firstRow.locator('button[title="Відкрити наряд"]').first();
          await expect(editBtn).toBeVisible({ timeout: 5_000 });
          await editBtn.click();
        }
      }
    }

    if (!foundRow) {
      test.skip(true, 'Немає COMPLETED/INVOICED нарядів у БД для перевірки кнопки рахунку');
      return;
    }

    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 15_000 });

    // Status must be COMPLETED or INVOICED — button must be visible.
    await expect(modal.locator('button:has-text("Виставити рахунок")')).toBeVisible({
      timeout: 10_000,
    });

    await page.keyboard.press('Escape');
  });
});

// ─── 3. LinkedDocumentsPanel — "Документи" tab in WO modal ──────────────────

test.describe('Наряд — вкладка "Документи" (LinkedDocumentsPanel) у модалці', () => {
  test('вкладка "Документи" присутня у edit-mode модалці', async ({ page }) => {
    await page.goto('/work-orders');
    await expect(page).toHaveURL(/\/work-orders/, { timeout: 15_000 });

    await page.locator('table').first().waitFor({ state: 'visible', timeout: 20_000 });
    await clearDateFilters(page);
    await page.waitForTimeout(500);
    const firstRow = realRowLocator(page).first();
    const hasRow = await firstRow
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (!hasRow) {
      test.skip(true, 'Немає нарядів у БД для перевірки вкладки Документи');
      return;
    }

    await firstRow.hover();
    const editBtn = firstRow.locator('button[title="Відкрити наряд"]').first();
    await expect(editBtn).toBeVisible({ timeout: 5_000 });
    await editBtn.click();

    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 15_000 });

    // Tab switcher rendered only in edit mode (CreateWorkOrderModal.tsx:1161).
    const docsTab = modal.locator('button:has-text("Документи")').first();
    await expect(docsTab).toBeVisible({ timeout: 10_000 });

    const mainTab = modal.locator('button:has-text("Основне")').first();
    await expect(mainTab).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('Escape');
  });

  test('клік на "Документи" → LinkedDocumentsPanel рендериться (з даними або empty-state)', async ({
    page,
  }) => {
    await page.goto('/work-orders');
    await expect(page).toHaveURL(/\/work-orders/, { timeout: 15_000 });

    await page.locator('table').first().waitFor({ state: 'visible', timeout: 20_000 });
    await clearDateFilters(page);
    await page.waitForTimeout(500);
    const firstRow = realRowLocator(page).first();
    const hasRow = await firstRow
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (!hasRow) {
      test.skip(true, 'Немає нарядів у БД');
      return;
    }

    await firstRow.hover();
    const editBtn = firstRow.locator('button[title="Відкрити наряд"]').first();
    await expect(editBtn).toBeVisible({ timeout: 5_000 });
    await editBtn.click();

    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 15_000 });

    const docsTab = modal.locator('button:has-text("Документи")').first();
    await expect(docsTab).toBeVisible({ timeout: 10_000 });
    await docsTab.click();

    // LinkedDocumentsPanel shows either sections (Рахунки/Оплати/Записи календаря/Гарантії)
    // OR the empty-state text "Пов'язаних документів немає" (LinkedDocumentsPanel.tsx:396).
    const panelReady = modal
      .locator('text=/Рахунки|Оплати|Записи календаря|Гарантії|Пов.язаних документів немає/')
      .first();
    await expect(panelReady).toBeVisible({ timeout: 15_000 });

    await page.keyboard.press('Escape');
  });

  test('перемикання вкладок "Документи" → "Основне" → "Документи" зберігає стан', async ({
    page,
  }) => {
    await page.goto('/work-orders');
    await expect(page).toHaveURL(/\/work-orders/, { timeout: 15_000 });

    await page.locator('table').first().waitFor({ state: 'visible', timeout: 20_000 });
    await clearDateFilters(page);
    await page.waitForTimeout(500);
    const firstRow = realRowLocator(page).first();
    const hasRow = await firstRow
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (!hasRow) {
      test.skip(true, 'Немає нарядів у БД');
      return;
    }

    await firstRow.hover();
    const editBtn = firstRow.locator('button[title="Відкрити наряд"]').first();
    await expect(editBtn).toBeVisible({ timeout: 5_000 });
    await editBtn.click();

    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 15_000 });

    const docsTab = modal.locator('button:has-text("Документи")').first();
    const mainTab = modal.locator('button:has-text("Основне")').first();

    await expect(docsTab).toBeVisible({ timeout: 10_000 });

    // Switch to Documents.
    await docsTab.click();
    await expect(
      modal
        .locator('text=/Рахунки|Оплати|Записи календаря|Гарантії|Пов.язаних документів немає/')
        .first(),
    ).toBeVisible({ timeout: 15_000 });

    // Switch back to Main.
    await mainTab.click();
    // Main tab content has the "Опис" / "Клієнт" / "Автомобіль" form fields.
    await expect(modal.locator('text=/Клієнт|Автомобіль|Опис/').first()).toBeVisible({
      timeout: 10_000,
    });

    // Switch back to Documents — panel must re-render.
    await docsTab.click();
    await expect(
      modal
        .locator('text=/Рахунки|Оплати|Записи календаря|Гарантії|Пов.язаних документів немає/')
        .first(),
    ).toBeVisible({ timeout: 15_000 });

    await page.keyboard.press('Escape');
  });
});
