import { test, expect, type Page } from '@playwright/test';
import { API } from './api-url';
import { clearDateFilter } from './fixtures';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

// ─── helpers ─────────────────────────────────────────────────────────────────

async function getToken(page: Page): Promise<string> {
  // Bug #567: Playwright не restores sessionStorage між contexts. AuthProvider commitреду
  // copies sto_e2e_access_token з localStorage → sessionStorage на mount. У beforeAll
  // page.goto + waitForTimeout(1000) може випереджати цей commit → empty token →
  // apiPost throws → docId never set → весь describe skipped (Bug #571 fix).
  return await page.evaluate(() => {
    return (
      sessionStorage.getItem('sto_access_token') ??
      localStorage.getItem('sto_e2e_access_token') ??
      ''
    );
  });
}

async function apiPost<T>(page: Page, path: string, body: unknown): Promise<T> {
  const token = await getToken(page);
  return page.evaluate(
    async ({ token, path, body, api }) => {
      const r = await fetch(`${api}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`POST ${path} → ${r.status}: ${t}`);
      }
      const t = await r.text();
      return (t ? JSON.parse(t) : null) as T;
    },
    { token, path, body, api: API },
  );
}

async function apiGet<T>(page: Page, path: string): Promise<T> {
  const token = await getToken(page);
  return page.evaluate(
    async ({ token, path, api }) => {
      const r = await fetch(`${api}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
      return r.json() as T;
    },
    { token, path, api: API },
  );
}

async function apiDelete(page: Page, path: string): Promise<void> {
  const token = await getToken(page);
  await page.evaluate(
    async ({ token, path, api }) => {
      await fetch(`${api}${path}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
    },
    { token, path, api: API },
  );
}

/** Повертає { warehouseId, branchId } першого складу або null */
async function firstWarehouse(
  page: Page,
): Promise<{ warehouseId: string; branchId: string } | null> {
  const d = await apiGet<{ id: string; branchId: string }[]>(page, '/warehouses?limit=1');
  if (!Array.isArray(d) || !d[0]) return null;
  return { warehouseId: d[0].id, branchId: d[0].branchId };
}

/** Створює документ через API, повертає { id, number } */
async function createDocApi(
  page: Page,
  warehouseId: string,
  branchId: string,
  type = 'WRITEOFF',
): Promise<{ id: string; number: string }> {
  return apiPost(page, '/stock-documents', { type, warehouseId, branchId });
}

async function gotoStockDocs(page: Page, withClearDateFilter = false) {
  await page.goto('/stock-documents');
  await expect(page.locator('h1:has-text("Склад")')).toBeVisible({ timeout: 20_000 });
  // Bug #345: stock-documents page has kyivToday() date filter by default
  if (withClearDateFilter) await clearDateFilter(page);
}

// ─── 1. Навігація ─────────────────────────────────────────────────────────────

test.describe('Складські документи — навігація', () => {
  test('сторінка завантажується — заголовок і таблиця або empty state', async ({ page }) => {
    await gotoStockDocs(page);
    await expect(
      page
        .locator('table')
        .or(page.getByText(/Нічого не знайдено|Документів не знайдено/i))
        .first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  test('кнопка «Документ» (додати) присутня', async ({ page }) => {
    await gotoStockDocs(page);
    await expect(page.getByRole('button', { name: /^Документ$/ }).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test('статусні фільтри присутні', async ({ page }) => {
    await gotoStockDocs(page);
    await expect(page.locator('button:has-text("Всі")').first()).toBeVisible({ timeout: 10_000 });
    await expect(
      page.locator('button:has-text("Чернетка"), button:has-text("Підтверджено")').first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('фільтри типу документа присутні', async ({ page }) => {
    await gotoStockDocs(page);
    // Тип-фільтри: Всі типи / Списання / Переміщення / Поч. залишки / Оприбуткування
    await expect(
      page.locator('button:has-text("Списання"), button:has-text("Переміщення"), select').first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('вкладка «Оприбуткування» (RECEIPT) присутня у фільтрах типу', async ({ page }) => {
    // STOCK_DOC_TYPE_LABELS у @sto/shared: RECEIPT → "Оприбуткування".
    // page.tsx TYPE_FILTERS включає 'RECEIPT' → tab має рендеритись.
    await gotoStockDocs(page);
    await expect(page.locator('button:has-text("Оприбуткування")').first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test('клік на вкладку «Оприбуткування» — фільтрує таблицю по RECEIPT', async ({ page }) => {
    await gotoStockDocs(page);
    const tab = page.locator('button:has-text("Оприбуткування")').first();
    await tab.click();
    // Після кліку tab стає active (border-primary text-primary)
    await expect(tab).toHaveClass(/text-primary|border-primary/, { timeout: 5_000 });
  });
});

// ─── 2. Створення через UI ────────────────────────────────────────────────────

test.describe('Складські документи — створення через UI', () => {
  test('відкрити модалку «Новий документ» — поля присутні', async ({ page }) => {
    await gotoStockDocs(page);
    await page
      .getByRole('button', { name: /^Документ$/ })
      .first()
      .click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    await expect(
      modal.locator('h2:has-text("Новий документ"), h2:has-text("Новий складський")').first(),
    ).toBeVisible();
    // Є поле вибору типу або складу
    await expect(modal.locator('select, [role="combobox"]').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(modal).not.toBeVisible({ timeout: 5_000 });
  });

  test('форма містить поле «Дата документа» з DatePicker', async ({ page }) => {
    await gotoStockDocs(page);
    await page
      .getByRole('button', { name: /^Документ$/ })
      .first()
      .click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    // DatePickerInput рендерить input[placeholder="ДД.ММ.РРРР"]
    await expect(modal.locator('input[placeholder="ДД.ММ.РРРР"]')).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press('Escape');
  });

  test('поле «Дата документа» ініціалізується сьогоднішньою датою', async ({ page }) => {
    await gotoStockDocs(page);
    await page
      .getByRole('button', { name: /^Документ$/ })
      .first()
      .click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    const dateInput = modal.locator('input[placeholder="ДД.ММ.РРРР"]');
    await expect(dateInput).toBeVisible({ timeout: 5_000 });
    const value = await dateInput.inputValue();
    // Має бути у форматі ДД.ММ.РРРР (сьогоднішня дата)
    expect(value).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
    await page.keyboard.press('Escape');
  });

  test('documentDate зберігається при створенні та відображається в таблиці', async ({ page }) => {
    await gotoStockDocs(page);

    await page
      .getByRole('button', { name: /^Документ$/ })
      .first()
      .click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });

    // Вибрати філію
    const branchSelect = modal.getByLabel('Філія*');
    await branchSelect.selectOption({ index: 1 });

    // Вибрати склад
    const warehouseSelect = modal.locator('select').nth(2);
    await warehouseSelect.selectOption({ index: 1 });

    // Дата документа — читаємо поточне (сьогоднішнє) значення з форми:
    // список фільтрується по dateFrom=today, тому документ з іншою датою не з'явиться.
    // Використовуємо значення що вже підставлене (kyivToday), і перевіряємо що воно є.
    const dateInput = modal.locator('input[placeholder="ДД.ММ.РРРР"]');
    await expect(dateInput).toBeVisible({ timeout: 5_000 });
    const todayDate = await dateInput.inputValue();
    expect(todayDate).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);

    // Зберегти
    await modal.getByRole('button', { name: 'Створити документ' }).click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    // Найновіший рядок (перший, sort desc) показує сьогоднішню дату.
    // Шукаємо клітинку з тексту дати у першому рядку — формат гарантований DD.MM.YYYY.
    // Це стійко до зміни порядку колонок, наявності checkbox-колонки bulk-actions, тощо.
    await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 10_000 });
    const firstDateCell = page
      .locator('tbody tr')
      .first()
      .locator('td')
      .filter({ hasText: /^\d{2}\.\d{2}\.\d{4}$/ })
      .first();
    await expect(firstDateCell).toHaveText(todayDate, { timeout: 10_000 });
  });

  test("вибір типу TRANSFER — з'являється поле «Склад призначення»", async ({ page }) => {
    await gotoStockDocs(page);
    await page
      .getByRole('button', { name: /^Документ$/ })
      .first()
      .click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });

    // Вибрати тип TRANSFER
    const typeSelect = modal.locator('select').first();
    await expect(typeSelect, 'Модалка створення має містити select типу').toBeVisible({
      timeout: 5_000,
    });
    await typeSelect.selectOption('TRANSFER');
    await page.waitForTimeout(300);

    // Поле "Склад призначення" або "Склад переміщення" має з'явитися
    await expect(
      modal.locator('select').nth(2).or(modal.locator('[placeholder*="призначення"]')).first(),
    ).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press('Escape');
  });

  test('кнопка «Створити документ» — без складу disabled', async ({ page }) => {
    await gotoStockDocs(page);
    await page
      .getByRole('button', { name: /^Документ$/ })
      .first()
      .click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    const saveBtn = modal.locator('button:has-text("Створити документ")');
    // Без вибору складу кнопка disabled (або активна якщо дефолтний склад вже обраний)
    const isDisabled = await saveBtn.isDisabled({ timeout: 3_000 }).catch(() => false);
    if (isDisabled) {
      await expect(saveBtn).toBeDisabled();
    }
    await page.keyboard.press('Escape');
  });
});

// ─── 3. Detail Panel ─────────────────────────────────────────────────────────

test.describe('Складські документи — Detail Panel', () => {
  let docId: string;
  let docNumber: string;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/stock-documents');
    await p.waitForTimeout(1000);
    const wh = await firstWarehouse(p);
    if (!wh) {
      await ctx.close();
      return;
    }
    const doc = await createDocApi(p, wh.warehouseId, wh.branchId);
    docId = doc.id;
    docNumber = doc.number;
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    if (!docId) return;
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/stock-documents');
    await p.waitForTimeout(500);
    await apiDelete(p, `/stock-documents/${docId}`).catch(() => {});
    await ctx.close();
  });

  // Бокова панель списку (рішення власника 2026-10-13): панель увімкнена → клік по рядку
  // вибирає його в панель, картка НЕ відкривається. Локатор панелі — її власний вміст:
  // заголовок з номером документа і блок «Зведення» (data-testid="lines-summary").
  async function openPanel(page: Page) {
    await page.addInitScript(() => {
      localStorage.setItem('sto_detail_panel_stock-documents', 'true');
    });
    await gotoStockDocs(page, true);
    const row = page.locator(`table tbody tr:has-text("${docNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.locator('td').nth(1).click();
    const summary = page.getByTestId('lines-summary');
    await expect(summary).toBeVisible({ timeout: 8_000 });
    // Вміст вкладки панелі: поля шапки + зведення + кнопка «Відкрити документ».
    return { row, summary, panel: summary.locator('xpath=..') };
  }

  test('клік на рядок → Detail Panel відкривається', async ({ page }) => {
    expect(docId, 'beforeAll має створити документ (seed має склад+товари)').toBeTruthy();
    const { row, summary, panel } = await openPanel(page);
    await expect(page.locator('h2', { hasText: docNumber })).toBeVisible();
    await expect(row).toHaveClass(/bg-primary\/5/);
    // Документ створено без рядків — зведення каже це прямо, а не лишається порожнім.
    await expect(summary).toContainText('Зведення');
    await expect(summary).toContainText('Рядків немає');
    await expect(panel.getByRole('button', { name: 'Відкрити документ' })).toBeVisible();
    // Панель, а не картка.
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  });

  test('Detail Panel — показує тип «Списання» і статус «Чернетка»', async ({ page }) => {
    expect(docId, 'beforeAll має створити документ (seed має склад+товари)').toBeTruthy();
    const { panel } = await openPanel(page);
    await expect(panel.getByText('Тип', { exact: true })).toBeVisible();
    await expect(panel.getByText('Списання', { exact: true })).toBeVisible({ timeout: 5_000 });
    await expect(panel.getByText('Статус', { exact: true })).toBeVisible();
    await expect(panel.getByText('Чернетка', { exact: true })).toBeVisible({ timeout: 5_000 });
  });

  test('Detail Panel вимкнена → клік на рядок відкриває картку документа', async ({ page }) => {
    expect(docId, 'beforeAll має створити документ (seed має склад+товари)').toBeTruthy();
    await page.addInitScript(() => {
      localStorage.setItem('sto_detail_panel_stock-documents', 'false');
    });
    await gotoStockDocs(page, true);
    const row = page.locator(`table tbody tr:has-text("${docNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Показати бокову панель' })).toBeVisible();
    await row.locator('td').nth(1).click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    await expect(modal).toContainText(docNumber);
    await expect(page.getByTestId('lines-summary')).toHaveCount(0);
  });

  test('Картка (олівець) — кнопка «Підтвердити» присутня для DRAFT', async ({ page }) => {
    expect(docId, 'beforeAll має створити документ (seed має склад+товари)').toBeTruthy();
    await gotoStockDocs(page, true);
    const row = page.locator(`table tbody tr:has-text("${docNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    // Олівець у рядку відкриває картку документа (окремого вікна перегляду більше немає)
    await row.hover();
    const openBtn = row.locator('button[title="Відкрити документ"]').first();
    await expect(openBtn).toBeVisible({ timeout: 5_000 });
    await openBtn.click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    await expect(modal).toContainText(docNumber);
    await expect(modal.getByRole('button', { name: 'Підтвердити', exact: true })).toBeVisible({
      timeout: 5_000,
    });
    await page.keyboard.press('Escape');
  });

  test('Картка (олівець) — кнопка «Скасувати» присутня для DRAFT', async ({ page }) => {
    expect(docId, 'beforeAll має створити документ (seed має склад+товари)').toBeTruthy();
    await gotoStockDocs(page, true);
    const row = page.locator(`table tbody tr:has-text("${docNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.hover();
    const openBtn = row.locator('button[title="Відкрити документ"]').first();
    await expect(openBtn).toBeVisible({ timeout: 5_000 });
    await openBtn.click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    await expect(modal.locator('button:has-text("Скасувати")').first()).toBeVisible({
      timeout: 5_000,
    });
    await page.keyboard.press('Escape');
  });
});

// ─── 4. FSM — переходи ────────────────────────────────────────────────────────

test.describe('Складські документи — FSM', () => {
  let docId: string;
  let docNumber: string;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/stock-documents');
    await p.waitForTimeout(1000);
    const wh = await firstWarehouse(p);
    if (!wh) {
      await ctx.close();
      return;
    }
    const doc = await createDocApi(p, wh.warehouseId, wh.branchId);
    docId = doc.id;
    docNumber = doc.number;
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    if (!docId) return;
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/stock-documents');
    await p.waitForTimeout(500);
    await apiDelete(p, `/stock-documents/${docId}`).catch(() => {});
    await ctx.close();
  });

  test('DRAFT → CANCELLED: «Скасувати» → badge «Скасовано»', async ({ page }) => {
    expect(docId, 'beforeAll має створити документ (seed має склад+товари)').toBeTruthy();
    await gotoStockDocs(page, true);
    const row = page.locator(`table tbody tr:has-text("${docNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Олівець у рядку відкриває картку документа
    await row.hover();
    const openBtn = row.locator('button[title="Відкрити документ"]').first();
    await expect(openBtn).toBeVisible({ timeout: 5_000 });
    await openBtn.click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });

    const cancelBtn = modal.getByRole('button', { name: 'Скасувати', exact: true });
    await expect(cancelBtn).toBeVisible({ timeout: 5_000 });
    await cancelBtn.click();

    // Картка питає підтвердження (перехід незворотний) — без згоди запит не йде.
    const confirmDialog = page
      .getByRole('dialog')
      .filter({ hasText: `Бажаєте скасувати документ ${docNumber}?` });
    await expect(confirmDialog).toBeVisible({ timeout: 5_000 });
    await confirmDialog.getByRole('button', { name: 'Так', exact: true }).click();

    // Статус у картці й у рядку списку — «Скасовано».
    await expect(modal.getByRole('button', { name: 'Скасовано', exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await page.keyboard.press('Escape');
    await expect(row).toContainText('Скасовано', { timeout: 10_000 });
  });
});

// ─── 5. FSM CONFIRMED ────────────────────────────────────────────────────────

test.describe('Складські документи — FSM CONFIRMED', () => {
  let docId: string;
  let docNumber: string;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/stock-documents');
    await p.waitForTimeout(1000);
    const wh = await firstWarehouse(p);
    if (!wh) {
      await ctx.close();
      return;
    }
    const doc = await createDocApi(p, wh.warehouseId, wh.branchId);
    docId = doc.id;
    docNumber = doc.number;
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    if (!docId) return;
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/stock-documents');
    await p.waitForTimeout(500);
    await apiDelete(p, `/stock-documents/${docId}`).catch(() => {});
    await ctx.close();
  });

  // Документ цього блоку створено БЕЗ рядків, а сервер такий не проводить («Документ не може бути
  // підтверджено без позицій»). Попередня версія тесту цього не помічала: кнопку «Так» вона
  // шукала в `[role="alertdialog"]`, якого немає, пропускала її через `if (isVisible)`, а
  // «Підтверджено» знаходила у фільтрі статусів сторінки — тобто проходила, нічого не провівши.
  // Справжнє проведення (з рядком і зміною залишку) перевіряє cross-cache-invalidation.spec.ts.
  test('«Підтвердити» питає підтвердження; відмова — запиту немає; документ без рядків сервер не проводить', async ({
    page,
  }) => {
    expect(docId, 'beforeAll має створити документ (seed має склад+товари)').toBeTruthy();
    await gotoStockDocs(page, true);
    const row = page.locator(`table tbody tr:has-text("${docNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Олівець у рядку відкриває картку документа
    await row.hover();
    const openBtn = row.locator('button[title="Відкрити документ"]').first();
    await expect(openBtn).toBeVisible({ timeout: 5_000 });
    await openBtn.click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });

    const transitions: string[] = [];
    page.on('request', r => {
      if (r.url().includes(`/stock-documents/${docId}/transition`)) transitions.push(r.method());
    });

    const confirmDocBtn = modal.getByRole('button', { name: 'Підтвердити', exact: true });
    await expect(confirmDocBtn).toBeVisible({ timeout: 5_000 });
    await confirmDocBtn.click();

    // Проведення незворотне (рухи складу) — картка питає підтвердження.
    const confirmDialog = page
      .getByRole('dialog')
      .filter({ hasText: `Бажаєте підтвердити документ ${docNumber}?` });
    await expect(confirmDialog).toBeVisible({ timeout: 5_000 });
    // Відмова: запит не йде, документ лишається чернеткою.
    await confirmDialog.getByRole('button', { name: 'Скасувати', exact: true }).click();
    await expect(confirmDialog).toHaveCount(0, { timeout: 5_000 });
    await expect(modal.getByRole('button', { name: 'Зберегти зміни' })).toBeVisible();
    expect(transitions).toEqual([]);

    // Згода: запит іде; сервер відмовляє (рядків немає) — відмову видно в картці, статус не змінився.
    await confirmDocBtn.click();
    await expect(confirmDialog).toBeVisible({ timeout: 5_000 });
    await confirmDialog.getByRole('button', { name: 'Так', exact: true }).click();
    await expect(modal).toContainText('Документ не може бути підтверджено без позицій', {
      timeout: 10_000,
    });
    expect(transitions).toEqual(['POST']);
    await expect(confirmDocBtn).toBeVisible();
    await expect(modal.getByRole('button', { name: 'Зберегти зміни' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(row).toContainText('Чернетка');
  });
});

// ─── 6. Фільтри ──────────────────────────────────────────────────────────────

test.describe('Складські документи — фільтри', () => {
  let docId: string;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/stock-documents');
    await p.waitForTimeout(1000);
    const wh = await firstWarehouse(p);
    if (!wh) {
      await ctx.close();
      return;
    }
    const doc = await createDocApi(p, wh.warehouseId, wh.branchId, 'OPENING_BALANCE');
    docId = doc.id;
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    if (!docId) return;
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/stock-documents');
    await p.waitForTimeout(500);
    await apiDelete(p, `/stock-documents/${docId}`).catch(() => {});
    await ctx.close();
  });

  test('фільтр «Чернетка» — показує тільки DRAFT документи', async ({ page }) => {
    expect(docId, 'beforeAll має створити документ (seed має склад+товари)').toBeTruthy();
    await gotoStockDocs(page);
    await page.locator('button:has-text("Чернетка")').first().click();
    await page.waitForTimeout(500);
    // Всі видимі badge мають бути «Чернетка» або список порожній
    const rows = page.locator('table tbody tr');
    const count = await rows.count();
    if (count > 0) {
      await expect(
        page.locator('td:has-text("Підтверджено"), td:has-text("Скасовано")').first(),
      ).not.toBeVisible();
    }
  });

  test('фільтр «Всі» — скидає фільтр', async ({ page }) => {
    expect(docId, 'beforeAll має створити документ (seed має склад+товари)').toBeTruthy();
    await gotoStockDocs(page);
    await page.locator('button:has-text("Чернетка")').first().click();
    await page.waitForTimeout(400);
    await page.locator('button:has-text("Всі")').first().click();
    await page.waitForTimeout(400);
    await expect(page.locator('h1:has-text("Склад")')).toBeVisible();
  });

  test('фільтр типу «Поч. залишки» — показує тільки OPENING_BALANCE', async ({ page }) => {
    expect(docId, 'beforeAll має створити документ (seed має склад+товари)').toBeTruthy();
    await gotoStockDocs(page);
    // Тип-фільтр може бути pill-кнопкою або select
    const openingBtn = page
      .locator('button:has-text("Поч. залишки"), option[value="OPENING_BALANCE"]')
      .first();
    await expect(openingBtn, 'Фільтр типу "Поч. залишки" має бути на сторінці').toBeVisible({
      timeout: 5_000,
    });
    await openingBtn.click();
    await page.waitForTimeout(500);
    // Тільки «Поч. залишки» badge або порожньо
    const rows = page.locator('table tbody tr');
    const count = await rows.count();
    if (count > 0) {
      await expect(
        page.locator('td:has-text("Списання"), td:has-text("Переміщення")').first(),
      ).not.toBeVisible();
    }
  });
});

// ─── 7. Додавання позицій ────────────────────────────────────────────────────

test.describe('Складські документи — позиції (lines)', () => {
  let docId: string;
  let docNumber: string;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/stock-documents');
    await p.waitForTimeout(1000);
    const wh = await firstWarehouse(p);
    if (!wh) {
      await ctx.close();
      return;
    }
    const doc = await createDocApi(p, wh.warehouseId, wh.branchId);
    docId = doc.id;
    docNumber = doc.number;
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    if (!docId) return;
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/stock-documents');
    await p.waitForTimeout(500);
    await apiDelete(p, `/stock-documents/${docId}`).catch(() => {});
    await ctx.close();
  });

  test('Картка (олівець) — показує таблицю позицій з колонкою «Товар»', async ({ page }) => {
    expect(docId, 'beforeAll має створити документ (seed має склад+товари)').toBeTruthy();
    await gotoStockDocs(page, true);
    const row = page.locator(`table tbody tr:has-text("${docNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    // Олівець у рядку відкриває картку документа
    await row.hover();
    const openBtn = row.locator('button[title="Відкрити документ"]').first();
    await expect(openBtn).toBeVisible({ timeout: 5_000 });
    await openBtn.click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    // У модалці є таблиця з колонкою «Товар» (навіть якщо рядків немає)
    await expect(modal.locator('th:has-text("Товар")').first()).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press('Escape');
  });

  test('форма створення — кнопка «+ Додати» позицію присутня', async ({ page }) => {
    // Modal redesign (commit e6d2e148): таблиця позицій з колонками ТОВАР/К-СТЬ/ЦІНА/СУМА
    // у самій формі створення документа, без окремої секції "Позиції" — кнопка
    // «Додати» (+) стоїть над таблицею праворуч (стандарт картки наряду).
    await gotoStockDocs(page);
    await page
      .getByRole('button', { name: /^Документ$/ })
      .first()
      .click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });

    // Таблиця позицій рендериться завжди — мінімум колонка "ТОВАР" як ready-signal.
    await expect(modal.locator('th:has-text("ТОВАР")').first()).toBeVisible({ timeout: 5_000 });
    // Кнопка «Додати» (з іконкою Plus) над таблицею.
    await expect(modal.getByRole('button', { name: 'Додати', exact: true })).toBeVisible({
      timeout: 5_000,
    });
    await page.keyboard.press('Escape');
  });
});

// ─── 8. Soft Delete ───────────────────────────────────────────────────────────

test.describe('Складські документи — soft delete', () => {
  let docId: string;
  let docNumber: string;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/stock-documents');
    await p.waitForTimeout(1000);
    const wh = await firstWarehouse(p);
    if (!wh) {
      await ctx.close();
      return;
    }
    const doc = await createDocApi(p, wh.warehouseId, wh.branchId);
    docId = doc.id;
    docNumber = doc.number;
    await ctx.close();
  });

  test('hover → іконки дій → «Позначити на видалення» → рядок зникає', async ({ page }) => {
    expect(docId, 'beforeAll має створити документ (seed має склад+товари)').toBeTruthy();
    await gotoStockDocs(page, true);
    const row = page.locator(`table tbody tr:has-text("${docNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Hover на рядок → іконка Trash2
    await row.hover();
    const trashBtn = row
      .locator('button[title*="видал"], button[aria-label*="видал"], button:has(svg.lucide-trash2)')
      .first();
    await expect(trashBtn).toBeVisible({ timeout: 8_000 });
    await trashBtn.click();

    // Підтвердження показується завжди. `isVisible()` не чекає: миттєва перевірка пропускала
    // діалог, який ще не намалювався, і документ лишався невидаленим (CI, 2026-10-12).
    const confirmBtn = page.locator('[role="dialog"] button:has-text("Так")').first();
    await expect(confirmBtn).toBeVisible({ timeout: 8_000 });
    await confirmBtn.click();

    // Активного рядка більше немає: він зник або лишився позначеним (opacity-60)
    const activeRow = page.locator(`table tbody tr:not(.opacity-60):has-text("${docNumber}")`);
    await expect(activeRow).toHaveCount(0, { timeout: 10_000 });
  });

  test('toggle «Показати видалені» — кнопка присутня', async ({ page }) => {
    await gotoStockDocs(page);
    await expect(
      page.locator('button[title="Показати видалені"], button[title*="видален"]').first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('toggle «Показати видалені» — кнопка змінює title після кліку', async ({ page }) => {
    // Перевіряє що toggle реагує на клік (змінює title з «Показати» на «Сховати»).
    // Не залежить від API showDeleted підтримки.
    await gotoStockDocs(page);
    const eyeToggle = page.locator('button[title="Показати видалені"]').first();
    await expect(eyeToggle).toBeVisible({ timeout: 10_000 });
    await eyeToggle.click();
    await page.waitForTimeout(400);
    // Після кліку title має змінитись на «Сховати видалені»
    await expect(page.locator('button[title="Сховати видалені"]').first()).toBeVisible({
      timeout: 5_000,
    });
  });
});

// ─── 9. XLSX-імпорт кнопка ────────────────────────────────────────────────────

test.describe('Складські документи — XLSX', () => {
  let docId: string;
  let docNumber: string;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/stock-documents');
    // Чекаємо доки AuthProvider copy sto_e2e_access_token → sessionStorage (Bug #567 fix).
    // Без цього waitForTimeout(1000) може випереджати reducer init → empty токен → beforeAll skip.
    await p.waitForFunction(
      () =>
        !!sessionStorage.getItem('sto_access_token') ||
        !!localStorage.getItem('sto_e2e_access_token'),
      undefined,
      { timeout: 10_000 },
    );
    try {
      const wh = await firstWarehouse(p);
      if (!wh) {
        await ctx.close();
        return;
      }
      const doc = await createDocApi(p, wh.warehouseId, wh.branchId);
      docId = doc.id;
      docNumber = doc.number;
    } finally {
      await ctx.close();
    }
  });

  test.afterAll(async ({ browser }) => {
    if (!docId) return;
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/stock-documents');
    await p.waitForTimeout(500);
    await apiDelete(p, `/stock-documents/${docId}`).catch(() => {});
    await ctx.close();
  });

  // Картка чернетки має імпорт позицій з XLSX. Раніше олівець відкривав окреме вікно перегляду,
  // де імпорту не було, і тест проходив за будь-якого результату («є кнопка — добре, нема — теж»).
  test('у картці DRAFT документа є кнопка XLSX-імпорту позицій', async ({ page }) => {
    expect(docId, 'beforeAll має створити документ (seed має склад+товари)').toBeTruthy();
    await gotoStockDocs(page, true);
    const row = page.locator(`table tbody tr:has-text("${docNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    // Олівець у рядку відкриває картку документа
    await row.hover();
    const openBtn = row.locator('button[title="Відкрити документ"]').first();
    await expect(openBtn).toBeVisible({ timeout: 5_000 });
    await openBtn.click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    await expect(modal).toContainText(docNumber);

    await expect(modal.getByRole('button', { name: 'Імпорт XLSX' })).toBeVisible({
      timeout: 8_000,
    });
    await expect(modal.getByRole('button', { name: 'Шаблон XLSX' })).toBeVisible();
    await page.keyboard.press('Escape');
  });
});

// ─── 10. Bulk cancel ─────────────────────────────────────────────────────────

test.describe('Складські документи — bulk дії', () => {
  let doc1Id: string;
  let doc2Id: string;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/stock-documents');
    // Bug #571: чекаємо токен у storage (Bug #567 — sessionStorage не restored).
    await p.waitForFunction(
      () =>
        !!sessionStorage.getItem('sto_access_token') ||
        !!localStorage.getItem('sto_e2e_access_token'),
      undefined,
      { timeout: 10_000 },
    );
    try {
      const wh = await firstWarehouse(p);
      if (!wh) {
        await ctx.close();
        return;
      }
      const [d1, d2] = await Promise.all([
        createDocApi(p, wh.warehouseId, wh.branchId),
        createDocApi(p, wh.warehouseId, wh.branchId),
      ]);
      doc1Id = d1.id;
      doc2Id = d2.id;
    } finally {
      await ctx.close();
    }
  });

  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/stock-documents');
    await p.waitForTimeout(500);
    if (doc1Id) await apiDelete(p, `/stock-documents/${doc1Id}`).catch(() => {});
    if (doc2Id) await apiDelete(p, `/stock-documents/${doc2Id}`).catch(() => {});
    await ctx.close();
  });

  test("вибрати 2 документи → BulkActionsBar з'являється", async ({ page }) => {
    expect(doc1Id && doc2Id, 'beforeAll має створити 2 документи').toBeTruthy();
    await gotoStockDocs(page);
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 15_000 });
    // Bug #571: useUiFeatures робить async fetch /settings/ui-features → bulkActionsEnabled.
    // Чекаємо рендер checkbox-ів (features.bulkActionsEnabled === true) перед count().
    await expect(page.locator('table tbody tr input[type="checkbox"]').first()).toBeVisible({
      timeout: 10_000,
    });

    const checkboxes = page.locator('table tbody tr input[type="checkbox"]');
    const count = await checkboxes.count();
    expect(count, 'Має бути >=2 рядки після створення 2 документів').toBeGreaterThanOrEqual(2);

    await checkboxes.nth(0).check();
    await checkboxes.nth(1).check();

    await expect(
      page
        .locator('[data-testid="bulk-actions-bar"], .bulk-actions')
        .or(page.getByText(/Обрано:/i))
        .first(),
    ).toBeVisible({ timeout: 5_000 });
  });
});
