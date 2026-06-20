import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/admin.json' });

// ─────────────────────────────────────────────────────────────────────────────
// Recently added features in /work-orders:
// 1. Status filter pills — ВСІ 10 FSM-статусів (DRAFT → ESTIMATE → APPROVED →
//    IN_PROGRESS → ON_HOLD → COMPLETED → INVOICED → PAID → ARCHIVED → CANCELLED)
//    плюс «Всі» рендеряться як rounded-pill buttons підряд (commit 57b9d4b9 —
//    замінили dropdown "Інші" на повний FSM-порядок).
// 2. "Виставити рахунок" button — appears in WO edit modal when status is
//    COMPLETED or INVOICED (CreateWorkOrderModal.tsx canInvoice).
// 3. LinkedDocumentsPanel — rendered as the "Документи" tab of the WO edit
//    modal AND as a side popup from the list when the row shows
//    invoice/payment/calendar/warranty count badges.
// ─────────────────────────────────────────────────────────────────────────────

// ─── 1. FSM status pills (commit 57b9d4b9: dropdown "Інші" → pills) ──────────

test.describe('Наряди — FSM статус-pills', () => {
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

  // Bug #426 follow-up: commit 57b9d4b9 видалив <select> «Інші» і замість нього
  // показує всі 10 FSM-статусів як pills. Тести оновлені під новий UI.
  test('всі pills "Всі" + 10 FSM-статусів присутні підряд', async ({ page }) => {
    // STATUS_TABS визначений у page.tsx (10 статусів + «Всі»). Перевіряємо що всі
    // потрібні buttons рендеряться у DOM (видимість дозволена з overflow-wrap).
    const expectedLabels = [
      'Всі',
      'Чернетка',
      'Кошторис',
      'Затверджено',
      'В роботі',
      'Призупинено',
      'Виконано',
      'Виставлено',
      'Оплачено',
      'Архів',
      'Скасовано',
    ];
    for (const label of expectedLabels) {
      // exact: true щоб не зловити "Виставити рахунок" як "Виставлено".
      await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible({
        timeout: 8_000,
      });
    }
  });

  test('FSM порядок pills збігається з backend WO_STATUS_LABELS (DRAFT → CANCELLED)', async ({
    page,
  }) => {
    // Контракт-перевірка: FSM-порядок pills не повинен дрейфувати від
    // backend WO_STATUS_LABELS. Беремо text content усіх status buttons
    // після pill «Всі» і порівнюємо з канонічним порядком.
    const allLabels = await page
      .locator('div.flex.gap-1\\.5.flex-wrap.items-center >> button')
      .allTextContents();

    const fsmOrder = [
      'Всі',
      'Чернетка',
      'Кошторис',
      'Затверджено',
      'В роботі',
      'Призупинено',
      'Виконано',
      'Виставлено',
      'Оплачено',
      'Архів',
      'Скасовано',
    ];

    // Перевіряємо що FSM-послідовність присутня як підпослідовність allLabels.
    // (allLabels може містити додаткові buttons «Мої наряди», «Видалені», тощо.)
    const indices = fsmOrder.map(label => allLabels.indexOf(label));
    indices.forEach((idx, i) => {
      expect(idx, `pill "${fsmOrder[i]}" не знайдено`).toBeGreaterThanOrEqual(0);
    });
    // Кожен наступний індекс має бути більший за попередній.
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1]!);
    }
  });

  test('клік "Скасовано" — фільтрує таблицю (pill стає active)', async ({ page }) => {
    const cancelledPill = page.getByRole('button', { name: 'Скасовано', exact: true });
    await expect(cancelledPill).toBeVisible({ timeout: 10_000 });
    await cancelledPill.click();

    // Active pill = bg-primary text-primary-foreground (page.tsx STATUS_TABS map).
    // Чекаємо коли клас з'явиться (signal що setStatusFilter('CANCELLED') відпрацював).
    await expect(cancelledPill).toHaveClass(/bg-primary/, { timeout: 5_000 });

    // Чекаємо коли refetch завершиться. Може бути або з рядками таблиці,
    // або empty-state — обидва є валідним станом. Чекаємо <table> (завжди present),
    // потім перевіряємо що pill лишається active (filter не відкочено через помилку).
    await expect(page.locator('table').first()).toBeVisible({ timeout: 15_000 });
    await expect(cancelledPill).toHaveClass(/bg-primary/);
  });

  test('клік "Архів" — pill стає active (bg-primary)', async ({ page }) => {
    const pill = page.getByRole('button', { name: 'Архів', exact: true });
    await expect(pill).toBeVisible({ timeout: 10_000 });
    await pill.click();
    await expect(pill).toHaveClass(/bg-primary/, { timeout: 5_000 });
  });

  test('клік "Призупинено" — pill стає active (bg-primary)', async ({ page }) => {
    const pill = page.getByRole('button', { name: 'Призупинено', exact: true });
    await expect(pill).toBeVisible({ timeout: 10_000 });
    await pill.click();
    await expect(pill).toHaveClass(/bg-primary/, { timeout: 5_000 });
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

    // Seed містить 8 DRAFT нарядів — фільтр Чернетка має показати рядки
    const firstRow = realRowLocator(page).first();
    await expect(firstRow).toBeVisible({ timeout: 15_000 });

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

    // Seed містить >=1 INVOICED наряд (PAID також valid candidate, але тест шукає
    // ['COMPLETED','INVOICED'] для canInvoice). Якщо foundRow=false — це регресія,
    // не seed-проблема: жорсткий fail замість silent skip.
    expect(foundRow, 'Очікувано COMPLETED або INVOICED наряд у seed').toBe(true);

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
    // Seed містить наряди — жорсткий експект замість silent skip
    const firstRow = realRowLocator(page).first();
    await expect(firstRow).toBeVisible({ timeout: 15_000 });

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
    // Seed містить наряди — жорсткий експект замість silent skip
    const firstRow = realRowLocator(page).first();
    await expect(firstRow).toBeVisible({ timeout: 15_000 });

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
    // Seed містить наряди — жорсткий експект замість silent skip
    const firstRow = realRowLocator(page).first();
    await expect(firstRow).toBeVisible({ timeout: 15_000 });

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

// ─── 4. plannedHours / actualHours fields in WO edit modal ───────────────────

test.describe('Наряд — поля "Планових год." / "Фактичних год."', () => {
  test('поля Планових та Фактичних годин присутні в edit-mode модалці', async ({ page }) => {
    await page.goto('/work-orders');
    await expect(page).toHaveURL(/\/work-orders/, { timeout: 15_000 });

    await page.locator('table').first().waitFor({ state: 'visible', timeout: 20_000 });
    await clearDateFilters(page);
    await page.waitForTimeout(500);

    // Seed містить наряди — жорсткий експект замість silent skip
    const firstRow = realRowLocator(page).first();
    await expect(firstRow).toBeVisible({ timeout: 15_000 });

    await firstRow.hover();
    const editBtn = firstRow.locator('button[title="Відкрити наряд"]').first();
    await expect(editBtn).toBeVisible({ timeout: 5_000 });
    await editBtn.click();

    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 15_000 });

    // plannedHours/actualHours inputs rendered in CreateWorkOrderModal.tsx
    // as number inputs with placeholder "0" near the status picker section.
    const plannedInput = modal.locator('input[placeholder="0"]').first();
    await expect(plannedInput).toBeVisible({ timeout: 10_000 });

    // Both inputs must be present (plannedHours + actualHours).
    const hourInputs = modal.locator('input[placeholder="0"]');
    const count = await hourInputs.count();
    expect(count).toBeGreaterThanOrEqual(2);

    await page.keyboard.press('Escape');
  });

  test('зміна Планових год. — поле приймає числове значення', async ({ page }) => {
    await page.goto('/work-orders');
    await expect(page).toHaveURL(/\/work-orders/, { timeout: 15_000 });

    await page.locator('table').first().waitFor({ state: 'visible', timeout: 20_000 });
    await clearDateFilters(page);
    await page.waitForTimeout(500);

    // Find DRAFT/ESTIMATE/APPROVED row (editable statuses only).
    let foundRow = false;
    for (const statusLabel of ['Чернетка', 'Кошторис', 'Затверджено']) {
      const pill = page.getByRole('button', { name: statusLabel, exact: true });
      if (!(await pill.isVisible({ timeout: 3_000 }).catch(() => false))) continue;
      await pill.click();
      await page.waitForTimeout(600);
      const row = realRowLocator(page).first();
      const ok = await row
        .waitFor({ state: 'visible', timeout: 5_000 })
        .then(() => true)
        .catch(() => false);
      if (!ok) continue;
      foundRow = true;
      await row.hover();
      const btn = row.locator('button[title="Відкрити наряд"]').first();
      await expect(btn).toBeVisible({ timeout: 5_000 });
      await btn.click();
      break;
    }

    // Seed містить DRAFT+ESTIMATE+APPROVED — foundRow має бути true
    expect(foundRow, 'Очікувано хоча б один DRAFT/ESTIMATE/APPROVED наряд у seed').toBe(true);

    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 15_000 });

    const plannedInput = modal.locator('input[placeholder="0"]').first();
    await expect(plannedInput).toBeVisible({ timeout: 10_000 });
    await expect(plannedInput).toBeEnabled();

    // Clear and fill with a test value.
    await plannedInput.click();
    await plannedInput.fill('3.5');
    await expect(plannedInput).toHaveValue('3.5');

    await page.keyboard.press('Escape');
  });
});
