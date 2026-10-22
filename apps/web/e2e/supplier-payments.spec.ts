import { test, expect, type Page } from '@playwright/test';
import {
  API,
  apiCall,
  createCounterparty,
  createPlainRegister,
  deleteRegister,
  getBalance,
  getToken,
  historyRow,
  openCashCard,
  pickInCard,
} from './cash-desk.helpers';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/**
 * Оплати постачальникам — після рішення власника 2026-10-14 окремої сторінки немає:
 *   - «Графік оплат» — вкладка сторінки «Купівля» (/purchase-orders?tab=schedule);
 *   - оплату постачальнику вносять у касі (/cash → «Видати» → «Оплата постачальнику») або з
 *     картки замовлення («Оплатити»);
 *   - старі адреси /supplier-payments і /supplier-payments/<id> ведуть на графік оплат.
 * Документ SupplierPayment і його API лишились: FSM DRAFT → CONFIRMED | CANCELLED перевіряємо
 * через API, як і раніше.
 *
 * Тести з міткою [контракт] спираються на нову поведінку бекенда (BR-CASH-016…022): каса сама
 * створює й проводить оплату постачальнику. До злиття з бекендом вони можуть бути червоними.
 *
 * Тест сам сідить касу (currencyId + branchId), бо seed її не містить.
 */

/** Сідить постачальника + касу (currency+branch). Повертає { supplierId, cashRegisterId }. */
async function seedSupplierAndCash(page: Page, token: string) {
  return page.evaluate(
    async ({ token, API }) => {
      const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const [cpRes, curRes, brRes] = await Promise.all([
        fetch(`${API}/counterparties?types=SUPPLIER,BOTH&limit=1`, { headers: auth }),
        fetch(`${API}/currencies`, { headers: auth }),
        fetch(`${API}/branches`, { headers: auth }),
      ]);
      const cpData = await cpRes.json();
      const curData = await curRes.json();
      const brData = await brRes.json();
      const supplierId = cpData.items?.[0]?.id;
      const currencies = (curData.items ?? curData) as Array<{ id: string; code: string }>;
      // Base currency, not just the first one: a second currency in the org silently changes base amounts.
      const currencyId = (currencies.find(c => c.code === 'UAH') ?? currencies[0])?.id;
      const branchId = (brData.items ?? brData)?.[0]?.id;

      // create a cash register for this test run
      const crRes = await fetch(`${API}/cash-registers`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ name: `E2E Каса ${Date.now()}`, currencyId, branchId }),
      });
      const cr = crRes.ok ? await crRes.json() : null;
      // Fund the register so cash-out on confirm() has available balance.
      // Backend correctly rejects paying out more cash than available
      // ("Недостатньо готівки в касі"), so a fresh 0-balance register must be
      // topped up before any SUPPLIER_PAYMENT confirm that draws from CASH_REGISTER.
      if (cr?.id) {
        // Касова операція без Idempotency-Key — 400 (рішення власника 2026-10-22): без ключа
        // поповнення мовчки не проходило, і confirm() падав на «Недостатньо готівки».
        const fund = await fetch(`${API}/cash-registers/${cr.id}/operations`, {
          method: 'POST',
          headers: { ...auth, 'Idempotency-Key': crypto.randomUUID() },
          body: JSON.stringify({
            direction: 'IN',
            amount: 100000,
            reason: 'MANUAL_IN',
            notes: 'E2E seed funding',
          }),
        });
        if (!fund.ok) throw new Error(`Поповнення E2E-каси: ${fund.status}`);
      }
      return { supplierId, cashRegisterId: cr?.id, cashRegisterOk: crRes.ok };
    },
    { token, API },
  );
}

/** Чи є в графіку оплат хоч один борг — за даними API, не за тим, що встигло намалюватись. */
async function scheduleHasDebts(page: Page, token: string): Promise<boolean> {
  const day = (offset: number) =>
    new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(
      new Date(Date.now() + offset * 86_400_000),
    );
  const res = await apiCall<{ suppliers?: unknown[] }>(
    page,
    token,
    'GET',
    `/supplier-payments/schedule?from=${day(0)}&to=${day(19)}`,
  );
  return (res.body.suppliers ?? []).length > 0;
}

test.describe('Оплати постачальникам', () => {
  // Каси, засіяні FSM-тестами нижче: без прибирання кожен прогін лишав у базі по «E2E Каса N»,
  // а список кас віддає лише 200 штук — після ~200 прогонів картка каси не знаходила нову касу.
  const seededRegisterIds: string[] = [];

  test.afterAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/cash');
    const token = await getToken(p);
    for (const id of seededRegisterIds) await deleteRegister(p, token, id);
    await ctx.close();
  });

  // ─── Сторінки більше немає ──────────────────────────────────────────────────
  test('стара адреса /supplier-payments веде на «Графік оплат» у «Купівлі»', async ({ page }) => {
    await page.goto('/supplier-payments');
    await expect(page).toHaveURL(/\/purchase-orders\/?\?tab=schedule$/, { timeout: 20_000 });
    await expect(page.locator('h1:has-text("Купівля")')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: 'Графік оплат' })).toBeVisible();
  });

  test('стара адреса картки оплати веде туди ж', async ({ page }) => {
    await page.goto('/supplier-payments/11111111-1111-4111-8111-111111111111');
    await expect(page).toHaveURL(/\/purchase-orders\/?\?tab=schedule$/, { timeout: 20_000 });
    await expect(page.locator('h1:has-text("Купівля")')).toBeVisible({ timeout: 20_000 });
  });

  // ─── Графік оплат у «Купівлі» ───────────────────────────────────────────────
  test('«Купівля» → вкладка «Графік оплат»: шахматка або порожній стан', async ({ page }) => {
    await page.goto('/purchase-orders');
    await expect(page.locator('h1:has-text("Купівля")')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Графік оплат' }).click();
    await expect(page).toHaveURL(/tab=schedule/);

    // Після завантаження — або шахматка з колонками, або порожній стан (боргів немає).
    const table = page.locator('th:has-text("Протерміновані")');
    const empty = page.getByText('Немає запланованих оплат');
    await expect(table.or(empty)).toBeVisible({ timeout: 30_000 });

    // Повернення на список замовлень: графік зникає, вкладка в адресі міняється.
    await page.getByRole('button', { name: 'Замовлення постачальникам' }).click();
    await expect(page).toHaveURL(/tab=orders/);
    await expect(table.or(empty)).toHaveCount(0);
  });

  test('графік: шахматка має колонки й рядок «Разом»', async ({ page }) => {
    await page.goto('/purchase-orders?tab=schedule');
    await expect(page.locator('h1:has-text("Купівля")')).toBeVisible({ timeout: 20_000 });
    const token = await getToken(page);
    test.skip(!(await scheduleHasDebts(page, token)), 'Немає боргів — шахматка порожня');

    await expect(page.locator('th:has-text("Протерміновані")')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('th:has-text("Планові")')).toBeVisible();
    await expect(page.locator('td:has-text("Разом:")')).toBeVisible();
  });

  test('графік: клік по клітинці → панель документів, рядок відкриває картку замовлення', async ({
    page,
  }) => {
    await page.goto('/purchase-orders?tab=schedule');
    await expect(page.locator('h1:has-text("Купівля")')).toBeVisible({ timeout: 20_000 });
    const token = await getToken(page);
    test.skip(!(await scheduleHasDebts(page, token)), 'Немає боргів для drill-down');

    // Клікабельні лише клітинки із сумою (role=button).
    const cell = page.locator('td[role="button"]').first();
    await expect(cell).toBeVisible({ timeout: 30_000 });
    await cell.click();
    await expect(page.getByText(/^Документи:/)).toBeVisible({ timeout: 10_000 });
    const docsHeader = page.locator('th:has-text("№")');
    const noDocs = page.getByText('Немає документів');
    await expect(docsHeader.or(noDocs)).toBeVisible({ timeout: 10_000 });

    // Перехід із графіка до документа не веде на прибрані сторінки оплат.
    await expect(page).toHaveURL(/\/purchase-orders\/?\?tab=schedule/);
    await page.getByLabel('Закрити').click();
    await expect(page.getByText(/^Документи:/)).toBeHidden();
  });

  // ─── Документ «Оплата постачальнику»: FSM через API ─────────────────────────
  test('FSM DRAFT→CONFIRMED пише settlement SUPPLIER_PAYMENT → борг постачальнику підіймається до 0', async ({
    page,
  }) => {
    await page.goto('/purchase-orders');
    await expect(page.locator('h1:has-text("Купівля")')).toBeVisible({ timeout: 20_000 });
    const token = await getToken(page);
    const seed = await seedSupplierAndCash(page, token);
    if (seed.cashRegisterId) seededRegisterIds.push(seed.cashRegisterId);
    expect(seed.supplierId).toBeTruthy();
    expect(seed.cashRegisterId).toBeTruthy();

    const balanceBefore = await getBalance(page, token, seed.supplierId);

    // create draft
    const sp = await page.evaluate(
      async ({ token, API, supplierId, cashRegisterId }) => {
        const r = await fetch(`${API}/supplier-payments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            supplierId,
            sourceType: 'CASH_REGISTER',
            cashRegisterId,
            amount: 200,
            method: 'cash',
          }),
        });
        return r.json();
      },
      { token, API, supplierId: seed.supplierId, cashRegisterId: seed.cashRegisterId },
    );
    expect(sp.id).toBeTruthy();

    // DRAFT не змінює баланс
    const balanceAfterDraft = await getBalance(page, token, seed.supplierId);
    expect(balanceAfterDraft, 'DRAFT не пише settlement').toBeCloseTo(balanceBefore, 2);

    // confirm
    const confirmed = await page.evaluate(
      async ({ token, API, id }) => {
        const r = await fetch(`${API}/supplier-payments/${id}/confirm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: '{}',
        });
        return { status: r.status, body: r.ok ? await r.json() : await r.text() };
      },
      { token, API, id: sp.id },
    );
    expect(confirmed.status, `confirm response: ${JSON.stringify(confirmed.body)}`).toBe(200);
    expect(confirmed.body.status).toBe('CONFIRMED');

    // SUPPLIER_PAYMENT підіймає баланс на суму (BALANCE_SIGN[SUPPLIER_PAYMENT] = +1;
    // баланс постачальника від'ємний = «ми винні», оплата зменшує борг → баланс росте до 0)
    const balanceAfterConfirm = await getBalance(page, token, seed.supplierId);
    expect(balanceAfterConfirm, 'SUPPLIER_PAYMENT підіймає баланс на 200').toBeCloseTo(
      balanceBefore + 200,
      2,
    );

    // settlement transaction має documentType=SupplierPayment
    const hasTxn = await page.evaluate(
      async ({ token, API, supplierId, id }) => {
        const r = await fetch(`${API}/counterparties/${supplierId}/transactions?page=1&limit=50`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const d = await r.json();
        const items = d.items ?? d;
        return items.some(
          (t: { type: string; documentType?: string; documentId?: string }) =>
            t.type === 'SUPPLIER_PAYMENT' &&
            t.documentType === 'SupplierPayment' &&
            t.documentId === id,
        );
      },
      { token, API, supplierId: seed.supplierId, id: sp.id },
    );
    expect(hasTxn, 'settlement PAYMENT з documentType=SupplierPayment має існувати').toBeTruthy();

    // CONFIRMED не можна видалити
    const delStatus = await page.evaluate(
      async ({ token, API, id }) => {
        const r = await fetch(`${API}/supplier-payments/${id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        });
        return r.status;
      },
      { token, API, id: sp.id },
    );
    expect(delStatus, 'CONFIRMED оплату не можна видалити').toBeGreaterThanOrEqual(400);
    expect(delStatus).toBeLessThan(500);
  });

  test('guard: BANK_ACCOUNT без bankAccountId → 400', async ({ page }) => {
    await page.goto('/purchase-orders');
    await expect(page.locator('h1:has-text("Купівля")')).toBeVisible({ timeout: 20_000 });
    const token = await getToken(page);
    const seed = await seedSupplierAndCash(page, token);
    if (seed.cashRegisterId) seededRegisterIds.push(seed.cashRegisterId);
    expect(seed.supplierId).toBeTruthy();

    const status = await page.evaluate(
      async ({ token, API, supplierId }) => {
        const r = await fetch(`${API}/supplier-payments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            supplierId,
            sourceType: 'BANK_ACCOUNT',
            amount: 50,
            method: 'transfer',
          }),
        });
        return r.status;
      },
      { token, API, supplierId: seed.supplierId },
    );
    expect(status, 'BANK_ACCOUNT без bankAccountId має віддати 400').toBe(400);
  });

  test('FSM DRAFT→CANCELLED через API не пише settlement + cleanup', async ({ page }) => {
    await page.goto('/purchase-orders');
    await expect(page.locator('h1:has-text("Купівля")')).toBeVisible({ timeout: 20_000 });
    const token = await getToken(page);
    const seed = await seedSupplierAndCash(page, token);
    if (seed.cashRegisterId) seededRegisterIds.push(seed.cashRegisterId);
    expect(seed.supplierId).toBeTruthy();
    expect(seed.cashRegisterId).toBeTruthy();

    const balanceBefore = await getBalance(page, token, seed.supplierId);

    const sp = await page.evaluate(
      async ({ token, API, supplierId, cashRegisterId }) => {
        const r = await fetch(`${API}/supplier-payments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            supplierId,
            sourceType: 'CASH_REGISTER',
            cashRegisterId,
            amount: 77,
            method: 'cash',
          }),
        });
        return r.json();
      },
      { token, API, supplierId: seed.supplierId, cashRegisterId: seed.cashRegisterId },
    );
    expect(sp.id).toBeTruthy();

    const cancelStatus = await page.evaluate(
      async ({ token, API, id }) => {
        const r = await fetch(`${API}/supplier-payments/${id}/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: '{}',
        });
        return r.status;
      },
      { token, API, id: sp.id },
    );
    expect(cancelStatus).toBe(200);

    // CANCELLED не пише settlement — баланс не змінився
    const balanceAfter = await getBalance(page, token, seed.supplierId);
    expect(balanceAfter, 'CANCELLED не пише settlement').toBeCloseTo(balanceBefore, 2);

    // cleanup
    await page.evaluate(
      async ({ token, API, id }) => {
        await fetch(`${API}/supplier-payments/${id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {});
      },
      { token, API, id: sp.id },
    );
  });

  // ─── Оплата постачальнику в касі ────────────────────────────────────────────
  test.describe('каса: оплата постачальнику й повернення від нього', () => {
    const stamp = Date.now();
    // «000» на початку: список кас віддає перші 200 за назвою, а в dev-базі сотні старих
    // «E2E Каса N» — без цього нова каса не потрапляла б у селектор картки.
    const registerName = `000 E2E Каса постач ${stamp}`;
    const supplierName = `E2E Постачальник каси ${stamp}`;
    let registerId = '';
    let supplierId = '';

    test.beforeAll(async ({ browser }) => {
      const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
      const p = await ctx.newPage();
      await p.goto('/cash');
      const token = await getToken(p);
      // Видача більша за залишок відхиляється («Недостатньо готівки в касі») — касу поповнюємо.
      registerId = await createPlainRegister(p, token, registerName, 50_000);
      supplierId = await createCounterparty(p, token, 'SUPPLIER', supplierName);
      await ctx.close();
    });

    test.afterAll(async ({ browser }) => {
      const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
      const p = await ctx.newPage();
      await p.goto('/cash');
      const token = await getToken(p);
      if (registerId) await deleteRegister(p, token, registerId);
      // Контрагент із рухом по розрахунках може не видалятись — відмову ігноруємо.
      if (supplierId) await apiCall(p, token, 'DELETE', `/counterparties/${supplierId}`);
      await ctx.close();
    });

    test('«Видати» → «Оплата постачальнику»: контрагент обов’язковий, клієнтів у переліку немає', async ({
      page,
    }) => {
      await page.goto('/cash');
      await expect(page.locator('h1:has-text("Каса")')).toBeVisible({ timeout: 20_000 });
      const dialog = await openCashCard(page, registerId, 'Видати');
      await dialog.getByLabel('Привід').selectOption('SUPPLIER_PAYMENT');
      await dialog.getByLabel(/^Сума/).fill('100');
      await dialog.getByRole('button', { name: 'Видати', exact: true }).click();
      await expect(dialog.getByText('Для цього приводу вкажіть контрагента')).toBeVisible();

      // Пікер просить лише постачальників (SUPPLIER, BOTH).
      const list = page.waitForRequest(
        r => r.url().includes('/counterparties?') && r.url().includes('types=SUPPLIER'),
      );
      await dialog
        .locator('label')
        .filter({ hasText: /^Контрагент/ })
        .locator('..')
        .getByRole('button', { name: 'Обрати' })
        .click();
      const url = new URL((await list).url());
      expect(url.searchParams.getAll('types')).toEqual(['SUPPLIER', 'BOTH']);
    });

    // [контракт] каса створює й одразу проводить оплату постачальнику.
    test('[контракт] оплата постачальнику з каси: борг меншає, оплата проведена', async ({
      page,
    }) => {
      await page.goto('/cash');
      await expect(page.locator('h1:has-text("Каса")')).toBeVisible({ timeout: 20_000 });
      const token = await getToken(page);
      const before = await getBalance(page, token, supplierId);

      const dialog = await openCashCard(page, registerId, 'Видати');
      await dialog.getByLabel('Привід').selectOption('SUPPLIER_PAYMENT');
      await dialog.getByLabel(/^Сума/).fill('1200');
      await pickInCard(page, dialog, /^Контрагент/, 'Оберіть постачальника', supplierName);
      const created = page.waitForResponse(
        r => r.request().method() === 'POST' && r.url().includes(`/${registerId}/operations`),
      );
      await dialog.getByRole('button', { name: 'Видати', exact: true }).click();
      expect((await created).status(), 'операцію прийнято').toBe(201);
      await expect(dialog).toBeHidden({ timeout: 10_000 });

      const row = historyRow(page, supplierName);
      await expect(row).toBeVisible({ timeout: 15_000 });
      await expect(row).toContainText('Оплата постачальнику');

      // SUPPLIER_PAYMENT підіймає баланс постачальника на суму (оплата зменшує наш борг).
      await expect
        .poll(async () => (await getBalance(page, token, supplierId)) - before, {
          timeout: 10_000,
          message: 'оплата постачальнику має підняти його баланс на 1200',
        })
        .toBeCloseTo(1200, 2);

      // Оплата — проведений документ, а не чернетка, яку нема де провести.
      const payments = await apiCall<{ items: { amount: number; status: string }[] }>(
        page,
        token,
        'GET',
        `/supplier-payments?supplierId=${supplierId}&limit=10`,
      );
      expect(payments.body.items.map(p => `${p.status}:${Number(p.amount)}`)).toContain(
        'CONFIRMED:1200',
      );
    });

    // [контракт] гроші, які постачальник повернув нам: баланс рухається у зворотний бік.
    test('[контракт] повернення від постачальника: внесення зменшує його баланс', async ({
      page,
    }) => {
      await page.goto('/cash');
      await expect(page.locator('h1:has-text("Каса")')).toBeVisible({ timeout: 20_000 });
      const token = await getToken(page);
      const before = await getBalance(page, token, supplierId);

      const dialog = await openCashCard(page, registerId, 'Внести');
      await dialog.getByLabel('Привід').selectOption('SUPPLIER_REFUND_IN');
      await dialog.getByLabel(/^Сума/).fill('200');
      await pickInCard(page, dialog, /^Контрагент/, 'Оберіть постачальника', supplierName);
      const created = page.waitForResponse(
        r => r.request().method() === 'POST' && r.url().includes(`/${registerId}/operations`),
      );
      await dialog.getByRole('button', { name: 'Внести', exact: true }).click();
      expect((await created).status(), 'операцію прийнято').toBe(201);
      await expect(dialog).toBeHidden({ timeout: 10_000 });

      await expect(
        page.locator('table tbody tr').filter({ hasText: 'Повернення від постачальника' }).first(),
      ).toContainText(supplierName, { timeout: 15_000 });
      await expect
        .poll(async () => (await getBalance(page, token, supplierId)) - before, {
          timeout: 10_000,
          message: 'повернення від постачальника має зменшити його баланс на 200',
        })
        .toBeCloseTo(-200, 2);
    });

    // [контракт] приводи звіряються з напрямом на сервері, а не лише в картці.
    test('[контракт] привід видачі в запиті на внесення → 400', async ({ page }) => {
      await page.goto('/cash');
      await expect(page.locator('h1:has-text("Каса")')).toBeVisible({ timeout: 20_000 });
      const token = await getToken(page);
      const res = await apiCall(page, token, 'POST', `/cash-registers/${registerId}/operations`, {
        direction: 'IN',
        reason: 'SUPPLIER_PAYMENT',
        amount: 10,
        counterpartyId: supplierId,
      });
      expect(res.status).toBe(400);
      const noCounterparty = await apiCall(
        page,
        token,
        'POST',
        `/cash-registers/${registerId}/operations`,
        { direction: 'OUT', reason: 'SUPPLIER_PAYMENT', amount: 10 },
      );
      expect(noCounterparty.status, 'контрагент обов’язковий і на сервері').toBe(400);
    });
  });
});
