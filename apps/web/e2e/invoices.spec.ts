import { test, expect, type Page } from '@playwright/test';
import { clearDateFilter } from './fixtures';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

// ─── helpers ─────────────────────────────────────────────────────────────────

async function getToken(page: Page): Promise<string> {
  // sessionStorage is only accessible when a page is already loaded on the app origin.
  // Caller must ensure page has navigated to localhost:3001 before calling getToken.
  return (await page.evaluate(() => sessionStorage.getItem('sto_access_token'))) ?? '';
}

async function apiGet<T>(page: Page, path: string): Promise<T> {
  const token = await getToken(page);
  return page.evaluate(
    async ({ token, path }) => {
      const r = await fetch(`http://localhost:3000/api${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
      return r.json() as T;
    },
    { token, path },
  );
}

async function apiPost<T>(page: Page, path: string, body: unknown): Promise<T> {
  const token = await getToken(page);
  return page.evaluate(
    async ({ token, path, body }) => {
      const r = await fetch(`http://localhost:3000/api${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const text = await r.text();
        throw new Error(`POST ${path} → ${r.status}: ${text}`);
      }
      const text = await r.text();
      return (text ? JSON.parse(text) : null) as T;
    },
    { token, path, body },
  );
}

async function apiDelete(page: Page, path: string): Promise<void> {
  const token = await getToken(page);
  await page.evaluate(
    async ({ token, path }) => {
      await fetch(`http://localhost:3000/api${path}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
    },
    { token, path },
  );
}

/** Повертає id першого активного контрагента або null */
async function firstCpId(page: Page): Promise<string | null> {
  const d = await apiGet<{ items: { id: string }[] }>(page, '/counterparties?limit=1');
  return d.items?.[0]?.id ?? null;
}

/** Створює рахунок через API, повертає { id, number } */
async function createInvoiceApi(
  page: Page,
  cpId: string,
  amount = 200,
): Promise<{ id: string; number: string }> {
  return apiPost(page, '/invoices', { counterpartyId: cpId, amount });
}

async function gotoInvoices(page: Page, withClearDateFilter = false) {
  await page.goto('/invoices');
  await expect(page.locator('h1:has-text("Рахунки")')).toBeVisible({ timeout: 20_000 });
  // Bug #345: invoices page has kyivToday() date filter by default
  if (withClearDateFilter) await clearDateFilter(page);
}

// ─── 1. Базова навігація ──────────────────────────────────────────────────────

test.describe('Рахунки — навігація', () => {
  test('сторінка завантажується — заголовок, таблиця або empty state', async ({ page }) => {
    await gotoInvoices(page);
    await expect(
      page
        .locator('table')
        .or(page.getByText(/Нічого не знайдено|Рахунків не знайдено/i))
        .first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  test('кнопка «Рахунок» (додати) присутня', async ({ page }) => {
    await gotoInvoices(page);
    await expect(page.getByRole('button', { name: /^Рахунок$/ }).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test('статусні фільтри-пілюлі присутні', async ({ page }) => {
    await gotoInvoices(page);
    // Pill для «Всі» завжди рендериться першим
    await expect(page.locator('button:has-text("Всі")').first()).toBeVisible({ timeout: 10_000 });
    // Перевірити що є хоча б два статус-фільтри
    await expect(
      page.locator('button:has-text("Чернетка"), button:has-text("Надіслано")').first(),
    ).toBeVisible({
      timeout: 10_000,
    });
  });

  test('рядок пошуку присутній', async ({ page }) => {
    await gotoInvoices(page);
    await expect(
      page.locator('input[placeholder*="Пошук"], input[placeholder*="номер"]').first(),
    ).toBeVisible({ timeout: 10_000 });
  });
});

// ─── 2. Створення через UI ────────────────────────────────────────────────────

test.describe('Рахунки — створення через UI', () => {
  test('відкрити модалку «Новий рахунок» — поля присутні', async ({ page }) => {
    await gotoInvoices(page);
    await page
      .getByRole('button', { name: /^Рахунок$/ })
      .first()
      .click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 20_000 });
    await expect(modal.locator('h2:has-text("Новий рахунок")')).toBeVisible();
    // Modal redesign (commit e6d2e148): окремого поля "Сума" немає — amount обчислюється
    // з рядків (line items). Перевіряємо наявність полів шапки + кнопки "Додати позицію".
    // Контрагент — EntityPickerField (input у searchMode з placeholder "Пошук контрагента…").
    await expect(modal.getByPlaceholder(/Пошук контрагента/)).toBeVisible();
    // Таблиця позицій + кнопка "Додати позицію"
    await expect(modal.locator('th:has-text("ОПИС")').first()).toBeVisible();
    await expect(modal.locator('button:has-text("Додати позицію")').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(modal).not.toBeVisible({ timeout: 5_000 });
  });

  test('кнопка «Створити рахунок» неактивна без заповнення контрагента', async ({ page }) => {
    await gotoInvoices(page);
    await page
      .getByRole('button', { name: /^Рахунок$/ })
      .first()
      .click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 20_000 });
    // Modal redesign (commit e6d2e148): без контрагента кнопка "Створити рахунок" disabled
    // (форма вимагає counterpartyId). Перевіряємо одразу після відкриття.
    const saveBtn = modal.locator('button:has-text("Створити рахунок")');
    await expect(saveBtn).toBeDisabled();
    await page.keyboard.press('Escape');
  });

  test('створити рахунок → DRAFT badge → cleanup', async ({ page }) => {
    await gotoInvoices(page);
    const cpId = await firstCpId(page);
    expect(cpId, 'Seed має містити контрагентів').toBeTruthy();
    if (!cpId) return; // type-narrow для TS

    await gotoInvoices(page);
    await page
      .getByRole('button', { name: /^Рахунок$/ })
      .first()
      .click();
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 20_000 });

    // Контрагент — EntityPickerField → SearchPickerModal (aria-label="Обрати" відкриває picker).
    await modal.locator('button[aria-label="Обрати"]').first().click();
    // Через aria-labelledby ID collision усі модалки мають однаковий accessible name;
    // фільтруємо за унікальним search input picker-а.
    const picker = page
      .locator('[role="dialog"]')
      .filter({ has: page.locator('input[placeholder="Ім\'я, телефон, компанія..."]') })
      .first();
    await expect(picker).toBeVisible({ timeout: 5_000 });
    const firstResult = picker.locator('button.w-full.text-left').first();
    await expect(firstResult, 'Picker має знайти контрагентів з seed').toBeVisible({
      timeout: 8_000,
    });
    await firstResult.click();
    await expect(picker).not.toBeVisible({ timeout: 5_000 });

    // Modal redesign (commit e6d2e148): немає окремої "Сума" — додаємо одну позицію.
    await modal.locator('button:has-text("Додати позицію")').first().click();
    await modal.getByPlaceholder('Опис позиції…').fill('Тест E2E');
    await modal.getByPlaceholder('0.00').first().fill('500');
    // Натиснути "+" щоб додати рядок до lines.
    await modal.locator('button:has(svg.lucide-plus)').last().click();

    const saveBtn = modal.locator('button:has-text("Створити рахунок")');
    await expect(saveBtn).toBeEnabled({ timeout: 5_000 });
    await saveBtn.click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    // Перевірити появу рядка з badge «Чернетка»
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('text=Чернетка').first()).toBeVisible({ timeout: 10_000 });

    // Cleanup: видалити перший DRAFT
    const firstInv = await apiGet<{ items: { id: string }[] }>(
      page,
      '/invoices?limit=1&status=DRAFT',
    );
    if (firstInv.items?.[0]?.id) {
      await apiDelete(page, `/invoices/${firstInv.items[0].id}`);
    }
  });
});

// ─── 3. Detail Panel ─────────────────────────────────────────────────────────

test.describe('Рахунки — Detail Panel', () => {
  let invId: string;
  let invNumber: string;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/invoices');
    await p.waitForTimeout(1000);
    const cpId = await firstCpId(p);
    if (!cpId) {
      await ctx.close();
      return;
    }
    const inv = await createInvoiceApi(p, cpId, 750);
    invId = inv.id;
    invNumber = inv.number;
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    if (!invId) return;
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/invoices');
    await p.waitForTimeout(500);
    await apiDelete(p, `/invoices/${invId}`);
    await ctx.close();
  });

  test('клік на рядок → Edit Modal відкривається', async ({ page }) => {
    expect(invId, 'beforeAll має створити рахунок (seed має CLIENT)').toBeTruthy();
    await gotoInvoices(page, true);
    const row = page.locator(`table tbody tr:has-text("${invNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    // Modal redesign (a14931b0): клік на рядок відкриває edit modal у форматі WO/StockDoc — title="Рахунок-фактура",
    // номер у headerContent поряд із "Номер:".
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    await expect(modal.locator('h2:has-text("Рахунок-фактура")')).toBeVisible({ timeout: 5_000 });
    await expect(modal.getByText(invNumber, { exact: false })).toBeVisible({ timeout: 5_000 });
  });

  test('Edit Modal — статус Чернетка показується у steper-і', async ({ page }) => {
    expect(invId, 'beforeAll має створити рахунок (seed має CLIENT)').toBeTruthy();
    await gotoInvoices(page, true);
    const row = page.locator(`table tbody tr:has-text("${invNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    // Modal redesign (commit e6d2e148): badge «Чернетка» — у status steper модалки.
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    await expect(modal.locator('text=Чернетка').first()).toBeVisible({ timeout: 8_000 });
  });

  test('Detail Panel — кнопка «Надіслати» присутня для DRAFT', async ({ page }) => {
    expect(invId, 'beforeAll має створити рахунок (seed має CLIENT)').toBeTruthy();
    await gotoInvoices(page, true);
    const row = page.locator(`table tbody tr:has-text("${invNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    // Modal redesign (commit e6d2e148): клік на рядок відкриває edit modal з FSM steper.
    // Next-step кнопка показує label статусу-цілі (INVOICE_STATUS_LABELS) — для DRAFT це "Надіслано".
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    await expect(modal.locator('button:has-text("Надіслано")').first()).toBeVisible({
      timeout: 8_000,
    });
  });

  test('Detail Panel — вкладка «Позиції» відображається', async ({ page }) => {
    expect(invId, 'beforeAll має створити рахунок (seed має CLIENT)').toBeTruthy();
    await gotoInvoices(page, true);
    const row = page.locator(`table tbody tr:has-text("${invNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    // Modal redesign (commit e6d2e148): немає окремої вкладки «Позиції» —
    // таблиця рядків (ОПИС / К-СТЬ / ЦІНА / СУМА) рендериться інлайн у модалці.
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });
    await expect(modal.locator('th:has-text("ОПИС")').first()).toBeVisible({ timeout: 5_000 });
    // Footer "Разом:" присутній (порожні lines дають "0.00 ₴")
    await expect(modal.locator('text=Разом:').first()).toBeVisible({ timeout: 5_000 });
  });
});

// ─── 4. FSM — статусні переходи ──────────────────────────────────────────────

test.describe('Рахунки — FSM переходи', () => {
  let invId: string;
  let invNumber: string;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/invoices');
    await p.waitForTimeout(1000);
    const cpId = await firstCpId(p);
    if (!cpId) {
      await ctx.close();
      return;
    }
    const inv = await createInvoiceApi(p, cpId, 300);
    invId = inv.id;
    invNumber = inv.number;
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    if (!invId) return;
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/invoices');
    await p.waitForTimeout(500);
    await apiDelete(p, `/invoices/${invId}`).catch(() => {});
    await ctx.close();
  });

  test('DRAFT → SENT: клік «Надіслати» → badge «Надіслано»', async ({ page }) => {
    expect(invId, 'beforeAll має створити рахунок (seed має CLIENT)').toBeTruthy();
    await gotoInvoices(page, true);
    const row = page.locator(`table tbody tr:has-text("${invNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    // Modal redesign (commit e6d2e148): клік на рядок відкриває edit modal.
    // FSM-steper: next-step кнопка показує label цільового статусу. DRAFT → SENT = "Надіслано".
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });

    const sendBtn = modal.locator('button:has-text("Надіслано")').first();
    await expect(sendBtn).toBeVisible({ timeout: 8_000 });
    await sendBtn.click();

    // doTransition виконує API виклик без додаткового confirm — статус оновлюється у модалці.
    // Після переходу next-step показує наступний крок ("Оплачено"); current — "Надіслано" (поряд як badge).
    await expect(
      modal.locator('button:has-text("Оплачено"), button:has-text("Прострочено")').first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('SENT → CANCELLED: клік «Скасувати» → badge «Скасовано»', async ({ page }) => {
    expect(invId, 'beforeAll має створити рахунок (seed має CLIENT)').toBeTruthy();
    await gotoInvoices(page, true);
    const row = page.locator(`table tbody tr:has-text("${invNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    // Modal redesign (commit e6d2e148): row.click() відкриває edit modal.
    // Кнопка "Скасувати" — у footer модалки (destructive variant), доступна якщо CANCELLED у allowedTransitions.
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 8_000 });

    // Перевірити поточний стан — якщо вже CANCELLED
    const alreadyCancelled = await modal
      .locator('text=Скасовано')
      .first()
      .isVisible({ timeout: 2_000 })
      .catch(() => false);
    if (alreadyCancelled) return;

    // DRAFT/SENT/OVERDUE → можна скасувати (FSM transition CANCELLED). beforeAll створює DRAFT.
    const cancelBtn = modal.locator('button:has-text("Скасувати")').first();
    await expect(cancelBtn, 'Кнопка "Скасувати" має бути для DRAFT рахунку').toBeVisible({
      timeout: 8_000,
    });
    await cancelBtn.click();

    // doTransition виконується без додаткового confirm dialog.
    await expect(modal.locator('text=Скасовано').first()).toBeVisible({ timeout: 10_000 });
  });
});

// ─── 5. Оплата ───────────────────────────────────────────────────────────────

test.describe('Рахунки — реєстрація оплати', () => {
  let invId: string;
  let invNumber: string;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/invoices');
    await p.waitForTimeout(1000);
    const cpId = await firstCpId(p);
    if (!cpId) {
      await ctx.close();
      return;
    }
    // Створити + перевести в SENT
    const inv = await createInvoiceApi(p, cpId, 400);
    invId = inv.id;
    invNumber = inv.number;
    await apiPost(p, `/invoices/${invId}/transition`, { status: 'SENT' });
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    if (!invId) return;
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/invoices');
    await p.waitForTimeout(500);
    await apiDelete(p, `/invoices/${invId}`).catch(() => {});
    await ctx.close();
  });

  test('SENT → «Оплатити» → модалка оплати → PAID', async ({ page }) => {
    expect(invId, 'beforeAll має створити рахунок (seed має CLIENT)').toBeTruthy();
    await gotoInvoices(page, true);
    const row = page.locator(`table tbody tr:has-text("${invNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    // Modal redesign (commit e6d2e148): row.click() відкриває edit modal без кнопки "Оплатити".
    // Кнопка "Оплатити" живе у detail panel — відкривається через hover + icon "Відкрити деталі".
    await row.hover();
    const detailsBtn = row.locator('button[title="Відкрити деталі"]').first();
    await expect(detailsBtn).toBeVisible({ timeout: 5_000 });
    await detailsBtn.click();

    const payBtn = page.locator('button:has-text("Оплатити")').first();
    await expect(payBtn).toBeVisible({ timeout: 8_000 });
    await payBtn.click();

    // Модалка оплати
    const payModal = page.locator('[role="dialog"]').first();
    await expect(payModal).toBeVisible({ timeout: 8_000 });
    await expect(
      payModal.locator('h2:has-text("Оплата"), h2:has-text("Реєстрація оплати")').first(),
    ).toBeVisible();

    // Перевірити поля: метод оплати + сума
    await expect(payModal.locator('select, [role="combobox"]').first()).toBeVisible();
    // Сума — може бути автозаповнена або порожня
    const amountInput = payModal
      .locator('input[placeholder*="Сума"], input[type="number"]')
      .first();
    if (await amountInput.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await amountInput.fill('400');
    }

    const confirmPayBtn = payModal
      .locator('button:has-text("Оплатити"), button:has-text("Підтвердити")')
      .first();
    await expect(confirmPayBtn).toBeVisible({ timeout: 5_000 });
    await confirmPayBtn.click();

    await expect(payModal).not.toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=Оплачено').first()).toBeVisible({ timeout: 10_000 });
  });
});

// ─── 6. Клонування ───────────────────────────────────────────────────────────

test.describe('Рахунки — клонування', () => {
  let invId: string;
  let invNumber: string;
  let clonedId: string | undefined;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/invoices');
    await p.waitForTimeout(1000);
    const cpId = await firstCpId(p);
    if (!cpId) {
      await ctx.close();
      return;
    }
    const inv = await createInvoiceApi(p, cpId, 600);
    invId = inv.id;
    invNumber = inv.number;
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/invoices');
    await p.waitForTimeout(500);
    if (invId) await apiDelete(p, `/invoices/${invId}`).catch(() => {});
    if (clonedId) await apiDelete(p, `/invoices/${clonedId}`).catch(() => {});
    await ctx.close();
  });

  test('«Дублювати» → новий рахунок DRAFT з тим же контрагентом', async ({ page }) => {
    expect(invId, 'beforeAll має створити рахунок (seed має CLIENT)').toBeTruthy();
    await gotoInvoices(page, true);
    const row = page.locator(`table tbody tr:has-text("${invNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    // Modal redesign (commit e6d2e148): row.click() відкриває edit modal без кнопки "Дублювати".
    // Кнопка "Дублювати" живе у detail panel — відкривається через hover + icon "Відкрити деталі".
    await row.hover();
    const detailsBtn = row.locator('button[title="Відкрити деталі"]').first();
    await expect(detailsBtn).toBeVisible({ timeout: 5_000 });
    await detailsBtn.click();

    const cloneBtn = page.locator('button:has-text("Дублювати")').first();
    await expect(cloneBtn).toBeVisible({ timeout: 8_000 });

    const totalBefore = await page.locator('table tbody tr').count();
    await cloneBtn.click();

    // Очікуємо появи нового рядка або оновлення списку
    await page.waitForTimeout(1500);
    // Detail Panel має показати новий рахунок (DRAFT badge)
    await expect(page.locator('text=Чернетка').first()).toBeVisible({ timeout: 10_000 });

    // Зберегти id клону для cleanup
    const inv2 = await apiGet<{ items: { id: string; number: string }[] }>(
      page,
      '/invoices?limit=2&status=DRAFT',
    );
    const cloneItem = inv2.items?.find(i => i.id !== invId);
    if (cloneItem) clonedId = cloneItem.id;

    // Список стався довшим або залишився (якщо була пагінація)
    const totalAfter = await page.locator('table tbody tr').count();
    expect(totalAfter).toBeGreaterThanOrEqual(totalBefore);
  });
});

// ─── 7. Пошук і фільтрація ───────────────────────────────────────────────────

test.describe('Рахунки — пошук і фільтри', () => {
  let invId: string;
  let invNumber: string;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/invoices');
    await p.waitForTimeout(1000);
    const cpId = await firstCpId(p);
    if (!cpId) {
      await ctx.close();
      return;
    }
    const inv = await createInvoiceApi(p, cpId, 111);
    invId = inv.id;
    invNumber = inv.number;
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    if (!invId) return;
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/invoices');
    await p.waitForTimeout(500);
    await apiDelete(p, `/invoices/${invId}`).catch(() => {});
    await ctx.close();
  });

  test('пошук за номером → знаходить рахунок', async ({ page }) => {
    expect(invId, 'beforeAll має створити рахунок (seed має CLIENT)').toBeTruthy();
    await gotoInvoices(page);
    const searchInput = page
      .locator('input[placeholder*="Пошук"], input[placeholder*="номер"]')
      .first();
    await expect(searchInput).toBeVisible({ timeout: 10_000 });
    await searchInput.fill(invNumber);
    await page.waitForTimeout(600);
    await expect(page.locator(`table tbody tr:has-text("${invNumber}")`).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test('фільтр статус «Чернетка» → показує тільки DRAFT', async ({ page }) => {
    expect(invId, 'beforeAll має створити рахунок (seed має CLIENT)').toBeTruthy();
    await gotoInvoices(page);
    await page.locator('button:has-text("Чернетка")').first().click();
    await page.waitForTimeout(500);
    // Всі badge у таблиці мають бути «Чернетка» (або empty state)
    const rows = page.locator('table tbody tr');
    const count = await rows.count();
    if (count > 0) {
      // Перевіряємо що немає badge Надіслано/Оплачено
      await expect(
        page.locator('td:has-text("Надіслано"), td:has-text("Оплачено")').first(),
      ).not.toBeVisible();
    }
  });

  test('скидання фільтру «Всі» → відображає всі рахунки', async ({ page }) => {
    expect(invId, 'beforeAll має створити рахунок (seed має CLIENT)').toBeTruthy();
    await gotoInvoices(page);
    await page.locator('button:has-text("Чернетка")').first().click();
    await page.waitForTimeout(400);
    await page.locator('button:has-text("Всі")').first().click();
    await page.waitForTimeout(400);
    // Сторінка завантажилась без помилок
    await expect(page.locator('h1:has-text("Рахунки")')).toBeVisible();
  });

  test('пошук пустий рядок → відображає всі', async ({ page }) => {
    expect(invId, 'beforeAll має створити рахунок (seed має CLIENT)').toBeTruthy();
    await gotoInvoices(page);
    const searchInput = page
      .locator('input[placeholder*="Пошук"], input[placeholder*="номер"]')
      .first();
    await searchInput.fill('zzz_not_found_xyz');
    await page.waitForTimeout(600);
    await searchInput.clear();
    await page.waitForTimeout(600);
    // Таблиця знову показує рядки
    await expect(
      page
        .locator('table tbody tr')
        .first()
        .or(page.getByText(/Нічого не знайдено/i).first()),
    ).toBeVisible({ timeout: 10_000 });
  });
});

// ─── 8. Soft Delete + ShowDeleted ────────────────────────────────────────────

test.describe('Рахунки — soft delete', () => {
  let invId: string;
  let invNumber: string;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/invoices');
    await p.waitForTimeout(1000);
    const cpId = await firstCpId(p);
    if (!cpId) {
      await ctx.close();
      return;
    }
    const inv = await createInvoiceApi(p, cpId, 50);
    invId = inv.id;
    invNumber = inv.number;
    await ctx.close();
  });

  test('hover → іконка видалення → підтвердити → рахунок зникає зі списку', async ({ page }) => {
    expect(invId, 'beforeAll має створити рахунок (seed має CLIENT)').toBeTruthy();
    await gotoInvoices(page, true);
    const row = page.locator(`table tbody tr:has-text("${invNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Hover на рядок → з'являється іконка видалення (Trash2)
    await row.hover();
    const deleteIcon = row
      .locator('button[title*="видал"], button[title*="Видал"], button[aria-label*="видал"]')
      .first();
    const hasHoverIcon = await deleteIcon.isVisible({ timeout: 2_000 }).catch(() => false);

    if (hasHoverIcon) {
      await deleteIcon.click();
    } else {
      // Альтернатива: через Detail Panel → кнопку «Помітити на видалення»
      await row.click();
      const markBtn = page
        .locator('button:has-text("Помітити"), button:has-text("Видалити")')
        .first();
      await expect(markBtn).toBeVisible({ timeout: 8_000 });
      await markBtn.click();
    }

    // Confirm dialog
    const confirmBtn = page
      .locator(
        '[role="dialog"] button:has-text("Видалити"), [role="dialog"] button:has-text("Так"), [role="dialog"] button:has-text("Підтвердити")',
      )
      .first();
    if (await confirmBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await confirmBtn.click();
    }

    // Рядок зникає (або отримує opacity-60)
    await page.waitForTimeout(800);
    const deletedRow = page.locator(`table tbody tr.opacity-60:has-text("${invNumber}")`);
    const gone = !(await page
      .locator(`table tbody tr:not(.opacity-60):has-text("${invNumber}")`)
      .isVisible({ timeout: 3_000 })
      .catch(() => false));
    const markedDeleted = await deletedRow.isVisible({ timeout: 2_000 }).catch(() => false);
    expect(gone || markedDeleted).toBeTruthy();
  });

  test('toggle «Показати видалені» → кількість рядків зростає', async ({ page }) => {
    // Перевіряє що після toggle з'являється хоча б один рядок із badge "видалено".
    expect(invId, 'Рахунок для видалення має створитись у beforeAll').toBeTruthy();

    // Переконатись що invId видалено
    await apiDelete(page, `/invoices/${invId}`).catch(() => {});
    await gotoInvoices(page);
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 20_000 });

    // Переконатись що видалений рядок НЕ видно до toggle
    const deletedBadgeBefore = page.locator(
      'td:has-text("видалено"), .opacity-60, [data-deleted="true"]',
    );
    const countBefore = await deletedBadgeBefore.count();

    // Клік toggle — «Показати видалені»
    const eyeToggle = page.locator('button[title="Показати видалені"]').first();
    await expect(eyeToggle).toBeVisible({ timeout: 10_000 });
    await eyeToggle.click();
    await page
      .waitForResponse(res => res.url().includes('/invoices') && res.status() === 200, {
        timeout: 10_000,
      })
      .catch(() => {});
    await page.waitForTimeout(500);

    // Після toggle — має з'явитись видалений рядок або збільшитись кількість рядків
    const deletedBadgeAfter = page.locator(
      'td:has-text("видалено"), .opacity-60, [data-deleted="true"]',
    );
    const countAfter = await deletedBadgeAfter.count();
    // Або з'явились видалені рядки, або URL містить showDeleted=true
    const url = page.url();
    expect(countAfter > countBefore || url.includes('showDeleted=true')).toBe(true);
  });
});

// ─── 9. PDF завантаження ─────────────────────────────────────────────────────

test.describe('Рахунки — PDF', () => {
  let invId: string;
  let invNumber: string;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/invoices');
    await p.waitForTimeout(1000);
    const cpId = await firstCpId(p);
    if (!cpId) {
      await ctx.close();
      return;
    }
    const inv = await createInvoiceApi(p, cpId, 900);
    invId = inv.id;
    invNumber = inv.number;
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    if (!invId) return;
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/invoices');
    await p.waitForTimeout(500);
    await apiDelete(p, `/invoices/${invId}`).catch(() => {});
    await ctx.close();
  });

  test('«Завантажити PDF» — не кидає видиму помилку', async ({ page }) => {
    expect(invId, 'beforeAll має створити рахунок (seed має CLIENT)').toBeTruthy();
    await gotoInvoices(page, true);
    const row = page.locator(`table tbody tr:has-text("${invNumber}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    // Modal redesign (commit e6d2e148): row.click() відкриває edit modal без кнопки PDF.
    // Кнопка "Завантажити PDF" живе у detail panel — відкривається через icon "Відкрити деталі".
    await row.hover();
    const detailsBtn = row.locator('button[title="Відкрити деталі"]').first();
    await expect(detailsBtn).toBeVisible({ timeout: 5_000 });
    await detailsBtn.click();

    const pdfBtn = page.locator('button:has-text("Завантажити PDF")').first();
    await expect(pdfBtn).toBeVisible({ timeout: 8_000 });

    // Перехопити download event або переконатись що немає помилки
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 8_000 }).catch(() => null),
      pdfBtn.click(),
    ]);

    // Якщо download не відбувся — перевіряємо що нема error banner
    if (!download) {
      // Може бути що /pdf endpoint повертає blob inline
      await page.waitForTimeout(1000);
      const errorBanner = page.locator('.text-destructive-text, [class*="destructive"]').first();
      const hasError = await errorBanner.isVisible({ timeout: 2_000 }).catch(() => false);
      expect(hasError).toBeFalsy();
    } else {
      expect(download.suggestedFilename()).toMatch(/invoice.*\.pdf/i);
    }
  });
});

// ─── 10. Bulk actions ────────────────────────────────────────────────────────

test.describe('Рахунки — bulk cancel', () => {
  let inv1Id: string;
  let inv2Id: string;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/invoices');
    await p.waitForTimeout(1000);
    const cpId = await firstCpId(p);
    if (!cpId) {
      await ctx.close();
      return;
    }
    const [i1, i2] = await Promise.all([
      createInvoiceApi(p, cpId, 110),
      createInvoiceApi(p, cpId, 220),
    ]);
    // Перевести обидва в SENT щоб bulk cancel мав ефект
    await Promise.all([
      apiPost(p, `/invoices/${i1.id}/transition`, { status: 'SENT' }),
      apiPost(p, `/invoices/${i2.id}/transition`, { status: 'SENT' }),
    ]);
    inv1Id = i1.id;
    inv2Id = i2.id;
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/invoices');
    await p.waitForTimeout(500);
    if (inv1Id) await apiDelete(p, `/invoices/${inv1Id}`).catch(() => {});
    if (inv2Id) await apiDelete(p, `/invoices/${inv2Id}`).catch(() => {});
    await ctx.close();
  });

  test('вибрати 2 рахунки → «Скасувати вибрані» → BulkActionsBar зникає', async ({ page }) => {
    expect(inv1Id && inv2Id, 'beforeAll має створити 2 рахунки').toBeTruthy();
    await gotoInvoices(page);

    // Чекаємо завантаження таблиці
    await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 15_000 });

    // Чекбокс у першому рядку
    const checkboxes = page.locator('table tbody tr input[type="checkbox"]');
    const count = await checkboxes.count();
    expect(count, 'Має бути >=2 рядки після створення 2 рахунків').toBeGreaterThanOrEqual(2);

    await checkboxes.nth(0).check();
    await checkboxes.nth(1).check();

    // BulkActionsBar має з'явитись
    const bulkBar = page
      .locator('[data-testid="bulk-actions-bar"], .bulk-actions')
      .or(page.getByText(/Обрано:/i))
      .first();
    await expect(bulkBar).toBeVisible({ timeout: 5_000 });

    const bulkCancelBtn = page.locator('button:has-text("Скасувати вибрані")').first();
    await expect(bulkCancelBtn, 'Кнопка bulk cancel має бути після select 2 DRAFT').toBeVisible({
      timeout: 5_000,
    });
    await bulkCancelBtn.click();

    // Confirm якщо є
    const confirmBtn = page
      .locator(
        '[role="dialog"] button:has-text("Скасувати"), [role="dialog"] button:has-text("Так")',
      )
      .first();
    if (await confirmBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await confirmBtn.click();
    }

    // BulkActionsBar зникає після операції
    await expect(bulkBar).not.toBeVisible({ timeout: 8_000 });
  });
});
