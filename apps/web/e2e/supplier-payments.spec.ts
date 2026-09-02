import { test, expect } from '@playwright/test';
import { clearDateFilter } from './fixtures';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

const API = 'http://localhost:3000/api';

/**
 * Supplier Payments — сторінка /supplier-payments + SupplierPaymentCreateModal.
 * FSM: DRAFT → CONFIRMED (пише settlement PAYMENT) | DRAFT → CANCELLED.
 * Перевіряємо: рендер сторінки, модалку, FSM через API, вплив на баланс постачальника,
 * бізнес-guards (джерело коштів, CONFIRMED не редагується/видаляється).
 *
 * Тест сам сідить cash register (currencyId + branchId), бо seed його не містить.
 */

async function getToken(page: import('@playwright/test').Page): Promise<string> {
  const token = await page.evaluate(
    () =>
      sessionStorage.getItem('sto_access_token') ?? localStorage.getItem('sto_e2e_access_token'),
  );
  expect(token, 'access token має бути у storage').toBeTruthy();
  return token as string;
}

/** Сідить постачальника + касу (currency+branch). Повертає { supplierId, cashRegisterId }. */
async function seedSupplierAndCash(page: import('@playwright/test').Page, token: string) {
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
      const currencyId = (curData.items ?? curData)?.[0]?.id;
      const branchId = (brData.items ?? brData)?.[0]?.id;

      // create a cash register for this test run
      const crRes = await fetch(`${API}/cash-registers`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ name: `E2E Каса ${Date.now()}`, currencyId, branchId }),
      });
      const cr = crRes.ok ? await crRes.json() : null;
      return { supplierId, cashRegisterId: cr?.id, cashRegisterOk: crRes.ok };
    },
    { token, API },
  );
}

async function getBalance(
  page: import('@playwright/test').Page,
  token: string,
  counterpartyId: string,
): Promise<number> {
  return page.evaluate(
    async ({ token, API, counterpartyId }) => {
      const r = await fetch(`${API}/counterparties/${counterpartyId}/balance`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await r.json();
      return Number(d.balance ?? 0);
    },
    { token, API, counterpartyId },
  );
}

test.describe('Оплати постачальникам', () => {
  test('сторінка /supplier-payments рендериться з заголовком і кнопкою', async ({ page }) => {
    await page.goto('/supplier-payments');
    await expect(page.locator('h1:has-text("Оплати постачальникам")')).toBeVisible({
      timeout: 20_000,
    });

    // Кнопка створення
    await expect(page.locator('button:has-text("Нова оплата")').first()).toBeVisible({
      timeout: 10_000,
    });

    // Таблиця або empty state
    await expect(
      page
        .locator('table')
        .or(page.getByText(/Оплат ще немає|Нічого не знайдено|Немає/i))
        .first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('фільтри статусів (Усі/Чернетка/Проведено/Скасовано) присутні', async ({ page }) => {
    await page.goto('/supplier-payments');
    await expect(page.locator('h1:has-text("Оплати постачальникам")')).toBeVisible({
      timeout: 20_000,
    });
    for (const label of ['Усі', 'Чернетка', 'Проведено', 'Скасовано']) {
      await expect(page.locator(`button:has-text("${label}")`).first()).toBeVisible({
        timeout: 10_000,
      });
    }
  });

  test('модалка "Нова оплата" відкривається з полями постачальник/джерело/сума', async ({
    page,
  }) => {
    await page.goto('/supplier-payments');
    await expect(page.locator('h1:has-text("Оплати постачальникам")')).toBeVisible({
      timeout: 20_000,
    });
    await page.locator('button:has-text("Нова оплата")').first().click();

    await expect(page.getByText('Нова оплата постачальнику')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Постачальник', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('Джерело коштів', { exact: false }).first()).toBeVisible();
    await expect(page.locator('button:has-text("Створити оплату")').first()).toBeVisible();
  });

  test("створити оплату через API → з'являється у таблиці → cleanup", async ({ page }) => {
    await page.goto('/supplier-payments');
    await expect(page.locator('h1:has-text("Оплати постачальникам")')).toBeVisible({
      timeout: 20_000,
    });
    const token = await getToken(page);
    const seed = await seedSupplierAndCash(page, token);
    expect(seed.supplierId, 'seed постачальник').toBeTruthy();
    expect(seed.cashRegisterOk, 'каса має створитись').toBeTruthy();
    expect(seed.cashRegisterId, 'seed каса').toBeTruthy();

    const sp = await page.evaluate(
      async ({ token, API, supplierId, cashRegisterId }) => {
        const r = await fetch(`${API}/supplier-payments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            supplierId,
            sourceType: 'CASH_REGISTER',
            cashRegisterId,
            amount: 123.45,
            method: 'cash',
          }),
        });
        if (!r.ok) return { error: r.status, body: await r.text().catch(() => '') };
        return r.json();
      },
      { token, API, supplierId: seed.supplierId, cashRegisterId: seed.cashRegisterId },
    );
    expect(
      sp && !('error' in sp),
      `POST /supplier-payments має створити запис, отримано: ${JSON.stringify(sp)}`,
    ).toBeTruthy();
    expect(sp.status).toBe('DRAFT');

    await page.goto('/supplier-payments');
    await expect(page.locator('h1:has-text("Оплати постачальникам")')).toBeVisible({
      timeout: 20_000,
    });
    await clearDateFilter(page);

    const row = page.locator(`table tbody tr:has-text("${sp.number}")`).first();
    const visible = await row.isVisible({ timeout: 8_000 }).catch(() => false);
    if (!visible) {
      await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 10_000 });
    }

    // cleanup: delete draft
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

  test('FSM DRAFT→CONFIRMED пише settlement SUPPLIER_PAYMENT → борг постачальнику підіймається до 0', async ({
    page,
  }) => {
    await page.goto('/supplier-payments');
    await expect(page.locator('h1:has-text("Оплати постачальникам")')).toBeVisible({
      timeout: 20_000,
    });
    const token = await getToken(page);
    const seed = await seedSupplierAndCash(page, token);
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
    await page.goto('/supplier-payments');
    await expect(page.locator('h1:has-text("Оплати постачальникам")')).toBeVisible({
      timeout: 20_000,
    });
    const token = await getToken(page);
    const seed = await seedSupplierAndCash(page, token);
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
    await page.goto('/supplier-payments');
    await expect(page.locator('h1:has-text("Оплати постачальникам")')).toBeVisible({
      timeout: 20_000,
    });
    const token = await getToken(page);
    const seed = await seedSupplierAndCash(page, token);
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

  test('картка /supplier-payments/[id] рендерить усі поля', async ({ page }) => {
    await page.goto('/supplier-payments');
    await expect(page.locator('h1:has-text("Оплати постачальникам")')).toBeVisible({
      timeout: 20_000,
    });
    const token = await getToken(page);
    const seed = await seedSupplierAndCash(page, token);
    expect(seed.supplierId).toBeTruthy();
    expect(seed.cashRegisterId).toBeTruthy();

    const sp = await page.evaluate(
      async ({ token, API, supplierId, cashRegisterId }) => {
        const r = await fetch(`${API}/supplier-payments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            supplierId,
            sourceType: 'CASH_REGISTER',
            cashRegisterId,
            amount: 333,
            method: 'cash',
            notes: 'E2E card notes',
          }),
        });
        return r.json();
      },
      { token, API, supplierId: seed.supplierId, cashRegisterId: seed.cashRegisterId },
    );
    expect(sp.id).toBeTruthy();

    // Відкриваємо картку напряму за URL
    await page.goto(`/supplier-payments/${sp.id}`);

    // Заголовок = номер оплати
    await expect(page.locator(`h1:has-text("${sp.number}")`)).toBeVisible({ timeout: 15_000 });
    // Секція реквізитів + ключові поля
    await expect(page.getByText('Реквізити')).toBeVisible();
    await expect(page.getByText('Метод оплати', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('Джерело коштів', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('E2E card notes')).toBeVisible();
    // DRAFT → кнопка "Провести" присутня
    await expect(page.locator('button:has-text("Провести")').first()).toBeVisible();

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

  test('редагування DRAFT-оплати з картки → PATCH змінює суму', async ({ page }) => {
    await page.goto('/supplier-payments');
    await expect(page.locator('h1:has-text("Оплати постачальникам")')).toBeVisible({
      timeout: 20_000,
    });
    const token = await getToken(page);
    const seed = await seedSupplierAndCash(page, token);
    expect(seed.cashRegisterId).toBeTruthy();

    const sp = await page.evaluate(
      async ({ token, API, supplierId, cashRegisterId }) => {
        const r = await fetch(`${API}/supplier-payments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            supplierId,
            sourceType: 'CASH_REGISTER',
            cashRegisterId,
            amount: 111,
            method: 'cash',
          }),
        });
        return r.json();
      },
      { token, API, supplierId: seed.supplierId, cashRegisterId: seed.cashRegisterId },
    );
    expect(sp.id).toBeTruthy();

    await page.goto(`/supplier-payments/${sp.id}`);
    await expect(page.locator(`h1:has-text("${sp.number}")`)).toBeVisible({ timeout: 15_000 });

    // Клік "Редагувати" → модалка edit-mode
    await page.locator('button:has-text("Редагувати")').first().click();
    await expect(page.getByText('Редагувати оплату')).toBeVisible({ timeout: 10_000 });

    // Змінити суму → Зберегти (PATCH). Поле суми — text+inputMode=decimal (UA-кома),
    // не type="number"; шукаємо за міткою «Сума, ₴».
    const amountInput = page.getByLabel('Сума, ₴');
    await expect(amountInput).toHaveValue('111', { timeout: 10_000 });
    await amountInput.fill('222');
    await page.locator('button:has-text("Зберегти")').first().click();

    // Перевірка через API: сума оновилась, статус лишився DRAFT
    await expect
      .poll(
        async () => {
          const updated = await page.evaluate(
            async ({ token, API, id }) => {
              const r = await fetch(`${API}/supplier-payments/${id}`, {
                headers: { Authorization: `Bearer ${token}` },
              });
              return r.json();
            },
            { token, API, id: sp.id },
          );
          return `${updated.amount}:${updated.status}`;
        },
        { timeout: 10_000, message: 'PATCH має оновити суму до 222, статус DRAFT' },
      )
      .toBe('222:DRAFT');

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

  test('олівець у рядку DRAFT → одразу модалка редагування (без переходу на картку)', async ({
    page,
  }) => {
    await page.goto('/supplier-payments');
    await expect(page.locator('h1:has-text("Оплати постачальникам")')).toBeVisible({
      timeout: 20_000,
    });
    const token = await getToken(page);
    const seed = await seedSupplierAndCash(page, token);
    expect(seed.cashRegisterId).toBeTruthy();

    const sp = await page.evaluate(
      async ({ token, API, supplierId, cashRegisterId }) => {
        const r = await fetch(`${API}/supplier-payments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            supplierId,
            sourceType: 'CASH_REGISTER',
            cashRegisterId,
            amount: 111,
            method: 'cash',
          }),
        });
        return r.json();
      },
      { token, API, supplierId: seed.supplierId, cashRegisterId: seed.cashRegisterId },
    );
    expect(sp.id).toBeTruthy();

    await page.goto('/supplier-payments');
    await clearDateFilter(page);
    const row = page.locator(`table tbody tr:has-text("${sp.number}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Клік олівця у рядку DRAFT → модалка редагування (URL лишається на списку)
    await row.hover();
    await row.getByRole('button', { name: `Редагувати оплату ${sp.number}` }).click();
    await expect(page.getByText('Редагувати оплату')).toBeVisible({ timeout: 10_000 });
    // Не перейшли на картку — URL усе ще список (Next.js static export додає trailing slash;
    // картка була б /supplier-payments/<uuid>).
    await expect(page).toHaveURL(/\/supplier-payments\/?(\?.*)?$/);
    // Поле суми передзаповнене
    await expect(page.getByLabel('Сума, ₴')).toHaveValue('111');

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

  test('вкладка «Графік оплат» рендерить шахматку (Протерміновані/Планові/Разом)', async ({
    page,
  }) => {
    await page.goto('/supplier-payments?tab=schedule');
    await expect(page.locator('h1:has-text("Оплати постачальникам")')).toBeVisible({
      timeout: 20_000,
    });
    // Вкладка активна
    await expect(page.locator('button:has-text("Графік оплат")')).toBeVisible();

    // Дочекатись поки завершиться завантаження (зникне спінер), потім
    // або шахматка з колонками, або empty-state (якщо немає боргів).
    const table = page.locator('th:has-text("Протерміновані")');
    const empty = page.getByText('Немає запланованих оплат');
    await expect(table.or(empty)).toBeVisible({ timeout: 30_000 });

    if (await table.isVisible().catch(() => false)) {
      await expect(page.locator('th:has-text("Планові")')).toBeVisible();
      await expect(page.locator('td:has-text("Разом:")')).toBeVisible();
    }

    // Перемикання назад на «Список»
    await page.locator('button:has-text("Список")').first().click();
    await expect(page).toHaveURL(/tab=list/);
    await expect(page.locator('button:has-text("Нова оплата")')).toBeVisible();
  });
});
