import { test, expect, type Page } from '@playwright/test';
import { apiCall, apiRequest, getToken } from './api-helpers';
import { ensureVehicleModel } from './vehicle-directory';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/**
 * Сторно безготівкової оплати клієнта (BR-PAY-024, BR-BANK-040, рішення власника 2026-10-22),
 * через браузер:
 *  1. наряд створено в списку нарядів, робота й статуси до «Виконано» — на сторінці наряду; повна
 *     оплата на власний банківський рахунок спеку вікном «Оплатити» → «Оплачено»; «Сторнувати» з
 *     «Пов'язаних документів» наряду в списку → сплачено 0, «Виставлено», оплата позначена
 *     «Сторновано», дії більше немає; далі «Скасувати» на сторінці наряду (BR-WO-031) — попередження
 *     про склад, борг і рахунок, наряд «Скасовано», живої гарантії наряду немає (Bug #945);
 *  2. вхідний платіж, внесений і рознесений на клієнта вікном «Новий платіж» → «Сторнувати
 *     оплату» на рядку → рядок «Не рознесено» з причиною, оплата сторнована.
 *
 * Передумови через API (інтерфейс їх не дає в межах сценарію): власний гривневий банківський
 * рахунок (знаходимо або створюємо — без накопичення), спосіб оплати з цим рахунком за
 * замовчуванням, клієнт із гаражем і авто, категорія й робота каталогу. Прибирання: наряд —
 * «Скасовано» й видалення (оплату сторновано; якщо тест упав раніше — сторно маршрутом API),
 * платіж виписки (ручний, нерознесений), спосіб оплати, авто,
 * робота й категорія, гараж — до клієнта, клієнт. Сторновані оплати лишаються — фінансовий слід.
 */

const uid = Date.now().toString().slice(-6);
const CLIENT = `000 E2E TST-REV ${uid}`;
const PLATE = `RV${uid.slice(-5)}`;
const OWN_ACCOUNT = '000 E2E Банк UAH (сторно оплати)';
const METHOD_CODE = `rev_e2e_${uid}`;
const REASON = 'E2E: оплату внесено помилково';
const WORK = `000 E2E TST-REV робота ${uid}`;

const state: {
  token?: string;
  accountId?: string;
  methodId?: string;
  categoryId?: string;
  workId?: string;
  cpId?: string;
  garageId?: string;
  vehicleId?: string;
  wo?: { id: string; number: string };
  bankTxId?: string;
} = {};

const api = async <T = unknown>(page: Page, method: string, path: string, body?: unknown) =>
  apiCall<T>(page, state.token ?? (await getToken(page)), method, path, body);

interface WoDto {
  id: string;
  number: string;
  status: string;
  paidAmount: number;
  totalAmount: number;
}

const getWo = async (page: Page, id: string) =>
  (await api<WoDto>(page, 'GET', `/work-orders/${id}`)).body;

/** Наряд у списку нарядів (кнопка «Наряд»), клієнт і авто спеку; робота й статуси — на сторінці. */
async function createCompletedWorkOrder(page: Page): Promise<{ id: string; number: string }> {
  await page.goto('/work-orders');
  await page
    .getByRole('button', { name: /^Наряд$/ })
    .first()
    .click();
  const woModal = page.getByRole('dialog').filter({ hasText: 'Новий наряд' });
  await expect(woModal).toBeVisible({ timeout: 20_000 });
  await woModal.getByRole('combobox', { name: 'Клієнт' }).fill(CLIENT);
  await page.getByRole('option', { name: new RegExp(CLIENT) }).click();
  const vehicleSelect = woModal
    .locator('label', { hasText: 'Автомобіль' })
    .locator('..')
    .locator('select');
  await expect(vehicleSelect.locator('option', { hasText: PLATE })).toHaveCount(1, {
    timeout: 10_000,
  });
  await vehicleSelect.selectOption({ label: `Toyota Corolla (${PLATE})` });
  await woModal.getByPlaceholder('Заміна масла, колодок...').fill(`000 E2E TST-REV ${uid}`);
  await woModal.getByRole('button', { name: 'Створити наряд' }).click();
  await expect(woModal).toBeHidden({ timeout: 20_000 });

  const list = await api<{ items: { id: string; number: string }[] }>(
    page,
    'GET',
    `/work-orders?counterpartyId=${state.cpId}&limit=5&sortBy=createdAt&sortDir=desc`,
  );
  expect(list.body.items, 'наряд створено').toHaveLength(1);
  const wo = list.body.items[0]!;
  const card = page.getByRole('dialog').filter({ hasText: wo.number });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByRole('button', { name: 'Закрити' }).last().click();
  await expect(card).toBeHidden({ timeout: 10_000 });

  // Робота з виконавцем — найстарішим механіком (не тимчасовим «000 TST …» іншого тесту).
  await page.goto(`/work-orders/${wo.id}`);
  const mechs = await api<{ items: { firstName: string; lastName: string }[] }>(
    page,
    'GET',
    '/employees?limit=1&role=MECHANIC&sortBy=createdAt&sortDir=asc',
  );
  const mech = mechs.body.items[0];
  expect(mech, 'у базі є механік').toBeTruthy();
  await page.getByRole('button', { name: '+ Робота' }).click();
  const addLine = page.getByRole('dialog', { name: 'Додати роботу' });
  await expect(addLine).toBeVisible({ timeout: 10_000 });
  // Робота — пошуком на сервері (робота каталогу спеку), виконавець — список.
  await addLine.getByPlaceholder('Пошук роботи...').fill(WORK);
  await page
    .getByRole('option', { name: new RegExp(WORK) })
    .first()
    .click();
  await expect(addLine.getByText(WORK, { exact: true })).toBeVisible();
  await addLine
    .locator('select')
    .first()
    .selectOption({ label: `${mech!.lastName} ${mech!.firstName}` });
  await addLine.locator('label', { hasText: 'Ціна' }).locator('..').locator('input').fill('100');
  await addLine.getByRole('button', { name: 'Додати', exact: true }).click();
  await expect(addLine).toBeHidden({ timeout: 15_000 });

  for (const [label, status] of [
    ['Кошторис', 'ESTIMATE'],
    ['Затвердити', 'APPROVED'],
    ['В роботу', 'IN_PROGRESS'],
    ['Виконано', 'COMPLETED'],
  ] as const) {
    await page.getByRole('button', { name: label, exact: true }).click();
    const ask = page.getByRole('dialog').filter({ hasText: 'Перевести наряд у статус' });
    await ask.getByRole('button', { name: 'Так', exact: true }).click();
    await expect(ask).toBeHidden({ timeout: 10_000 });
    await expect
      .poll(async () => (await getWo(page, wo.id)).status, { timeout: 15_000 })
      .toBe(status);
  }
  return wo;
}

/** Картка сторно: причина → «Сторнувати» → «Так, сторнувати»; чекаємо відповідь маршруту. */
async function reverseInCard(page: Page, paymentHint: string) {
  const dialog = page.getByRole('dialog', { name: 'Сторно оплати', exact: true });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByRole('region', { name: 'Що сторнується' })).toContainText(paymentHint);
  // Без причини запит не йде.
  await dialog.getByRole('button', { name: 'Сторнувати', exact: true }).click();
  await expect(dialog.getByText('Вкажіть причину сторно')).toBeVisible();
  await dialog.getByLabel(/^Причина сторно/).fill(REASON);
  await dialog.getByRole('button', { name: 'Сторнувати', exact: true }).click();
  const reversed = page.waitForResponse(
    r => /\/payments\/[^/]+\/reverse$/.test(r.url()) && r.request().method() === 'POST',
    { timeout: 15_000 },
  );
  await dialog.getByRole('button', { name: 'Так, сторнувати' }).click();
  const res = await reversed;
  expect(res.status(), 'сторно проведено').toBeLessThan(300);
  expect(res.request().headers()['idempotency-key'], 'ключ ідемпотентності').toBeTruthy();
  await expect(dialog).toBeHidden({ timeout: 10_000 });
  return (await res.json()) as { id: string; reversedAt: string | null; reversalReason?: string };
}

test.describe('Сторно безготівкової оплати (BR-PAY-024)', () => {
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const page = await ctx.newPage();
    await page.goto('/work-orders');
    state.token = await getToken(page);

    // Власний гривневий рахунок спеку: наявний із цією назвою або новий.
    const accounts = await api<
      { items?: { id: string; name: string }[] } | { id: string; name: string }[]
    >(page, 'GET', '/bank-accounts');
    const list = Array.isArray(accounts.body) ? accounts.body : (accounts.body.items ?? []);
    state.accountId = list.find(a => a.name === OWN_ACCOUNT)?.id;
    if (!state.accountId) {
      const currencies = await api<{ items?: { id: string; code: string }[] }>(
        page,
        'GET',
        '/currencies',
      );
      const curList = Array.isArray(currencies.body)
        ? (currencies.body as { id: string; code: string }[])
        : (currencies.body.items ?? []);
      const uah = curList.find(c => c.code === 'UAH');
      const acc = await api<{ id: string }>(page, 'POST', '/bank-accounts', {
        name: OWN_ACCOUNT,
        ibanUA: `UA${String(Date.now()).slice(-9).padStart(27, '0')}`,
        currencyId: uah?.id,
      });
      expect(acc.status, `рахунок: ${JSON.stringify(acc.body)}`).toBe(201);
      state.accountId = acc.body.id;
    }

    const method = await api<{ id: string }>(page, 'POST', '/payment-methods', {
      code: METHOD_CODE,
      name: `000 E2E TST-REV Банк ${uid}`,
      sortOrder: 999,
      requiresFiscal: false,
      defaultSourceType: 'BANK_ACCOUNT',
      defaultBankAccountId: state.accountId,
    });
    expect(method.status, `спосіб оплати: ${JSON.stringify(method.body)}`).toBe(201);
    state.methodId = method.body.id;

    const cp = await api<{ id: string }>(page, 'POST', '/counterparties', {
      type: 'CLIENT',
      companyName: CLIENT,
    });
    expect(cp.status, `клієнт: ${JSON.stringify(cp.body)}`).toBe(201);
    state.cpId = cp.body.id;
    const garage = await api<{ id: string }>(
      page,
      'POST',
      `/counterparties/${state.cpId}/garages`,
      { name: '000 E2E TST-REV гараж' },
    );
    expect(garage.status).toBe(201);
    state.garageId = garage.body.id;
    const vehicle = await api<{ id: string }>(page, 'POST', '/vehicles', {
      customerGarageId: state.garageId,
      ...(await ensureVehicleModel(
        (method, url, data) => api(page, method, url, data),
        'Toyota',
        'Corolla',
      )),
      licensePlate: PLATE,
    });
    expect(vehicle.status).toBe(201);
    state.vehicleId = vehicle.body.id;

    // Робота каталогу — довідник, не документ; рядок наряду з нею додається інтерфейсом.
    const category = await api<{ id: string }>(page, 'POST', '/work-categories', {
      name: `000 E2E TST-REV ${uid}`,
    });
    expect(category.status, `категорія робіт: ${JSON.stringify(category.body)}`).toBe(201);
    state.categoryId = category.body.id;
    const work = await api<{ id: string }>(page, 'POST', '/works', {
      categoryId: state.categoryId,
      name: WORK,
      normoHours: 1,
      price: 100,
    });
    expect(work.status, `робота: ${JSON.stringify(work.body)}`).toBe(201);
    state.workId = work.body.id;
    await ctx.close();
  });

  test.afterAll(async ({ request }) => {
    const token = state.token;
    if (!token) return;
    if (state.wo) {
      // Тест упав до сторно — оплата ще чинна, і наряд не скасувати: сторнуємо маршрутом API.
      const linked = await apiRequest<{ payments: { id: string; reversedAt: string | null }[] }>(
        request,
        token,
        'GET',
        `/work-orders/${state.wo.id}/linked-documents`,
      );
      for (const p of linked.body?.payments ?? []) {
        if (p.reversedAt) continue;
        const rev = await apiRequest(request, token, 'POST', `/payments/${p.id}/reverse`, {
          reason: 'E2E: прибирання',
        });
        expect
          .soft(rev.status, `сторно оплати при прибиранні: ${JSON.stringify(rev.body)}`)
          .toBeLessThan(300);
      }
      const cur = await apiRequest<{ status: string }>(
        request,
        token,
        'GET',
        `/work-orders/${state.wo.id}`,
      );
      if (cur.body?.status && cur.body.status !== 'CANCELLED') {
        const tr = await apiRequest(
          request,
          token,
          'POST',
          `/work-orders/${state.wo.id}/transition`,
          {
            status: 'CANCELLED',
          },
        );
        expect
          .soft(tr.status, `скасування ${state.wo.number}: ${JSON.stringify(tr.body)}`)
          .toBeLessThan(300);
      }
      const del = await apiRequest(request, token, 'DELETE', `/work-orders/${state.wo.id}`);
      expect.soft([200, 204, 404], `DELETE наряду ${state.wo.number}`).toContain(del.status);
    }
    if (state.bankTxId) {
      const del = await apiRequest(
        request,
        token,
        'DELETE',
        `/bank-statements/transactions/${state.bankTxId}`,
      );
      expect
        .soft(del.status, `DELETE платежу виписки: ${JSON.stringify(del.body)}`)
        .toBeLessThan(300);
    }
    if (state.methodId) {
      const del = await apiRequest(request, token, 'DELETE', `/payment-methods/${state.methodId}`);
      expect.soft(del.status, 'DELETE способу оплати').toBeLessThan(300);
    }
    if (state.workId) {
      const del = await apiRequest(request, token, 'DELETE', `/works/${state.workId}`);
      expect.soft(del.status, 'DELETE роботи').toBeLessThan(300);
    }
    if (state.categoryId) {
      const del = await apiRequest(
        request,
        token,
        'DELETE',
        `/work-categories/${state.categoryId}`,
      );
      expect.soft(del.status, 'DELETE категорії робіт').toBeLessThan(300);
    }
    if (state.vehicleId) {
      const del = await apiRequest(request, token, 'DELETE', `/vehicles/${state.vehicleId}`);
      expect.soft(del.status, 'DELETE авто').toBeLessThan(300);
    }
    // Гараж — до клієнта: гараж видаленого клієнта API вже не видаляє.
    if (state.garageId) {
      const del = await apiRequest(
        request,
        token,
        'DELETE',
        `/counterparties/${state.cpId}/garages/${state.garageId}`,
      );
      expect.soft(del.status, 'DELETE гаража').toBeLessThan(300);
    }
    if (state.cpId) {
      const del = await apiRequest(request, token, 'DELETE', `/counterparties/${state.cpId}`);
      expect.soft(del.status, `DELETE клієнта: ${JSON.stringify(del.body)}`).toBeLessThan(300);
    }
  });

  // guards: BR-PAY-024, BR-WO-031
  test('наряд оплачено на банківський рахунок → «Сторнувати» з «Пов’язаних документів» → «Виставлено» → «Скасовано»', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    state.wo = await createCompletedWorkOrder(page);
    const wo = state.wo;

    // Оплата вікном «Оплатити» на сторінці наряду: спосіб спеку, його рахунок — за замовчуванням.
    await page.getByRole('button', { name: 'Оплатити', exact: true }).click();
    const pay = page.getByRole('dialog', { name: `Оплата наряду ${wo.number}` });
    await expect(pay).toBeVisible({ timeout: 10_000 });
    await pay.getByLabel('Метод оплати').selectOption(METHOD_CODE);
    await expect(pay.getByLabel(/^Рахунок/)).toHaveValue(state.accountId!);
    // Порожня сума — увесь залишок: наряд «Оплачено».
    await pay.getByRole('button', { name: 'Підтвердити оплату' }).click();
    await expect(pay).toBeHidden({ timeout: 10_000 });
    await expect
      .poll(async () => (await getWo(page, wo.id)).status, { timeout: 15_000 })
      .toBe('PAID');
    const total = Number((await getWo(page, wo.id)).totalAmount);
    const totalText = total.toLocaleString('uk-UA', { minimumFractionDigits: 2 });

    // «Пов'язані документи» наряду в списку нарядів.
    await page.goto('/work-orders');
    await page.getByPlaceholder('Пошук за номером або клієнтом...').fill(wo.number);
    const woRow = page.locator('table tbody tr', { hasText: wo.number }).first();
    await expect(woRow).toBeVisible({ timeout: 20_000 });
    await woRow.getByTitle(/^Оплати: /).click();
    const popup = page.getByRole('dialog', { name: "Пов'язані документи наряду" });
    await expect(popup).toBeVisible({ timeout: 10_000 });
    await popup
      .getByRole('button', { name: new RegExp(`^Сторнувати оплату ${totalText} ₴`) })
      .click();

    const body = await reverseInCard(page, `${totalText} ₴`);
    expect(body.reversedAt).toBeTruthy();
    expect(body.reversalReason).toBe(REASON);

    // Панель перечитана: оплата «Сторновано», дії більше немає; попап лишився відкритим.
    await expect(popup.getByText('Сторновано')).toBeVisible({ timeout: 10_000 });
    await expect(popup.getByRole('button', { name: /^Сторнувати оплату/ })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('rev_wo_linked.png') });

    const after = await getWo(page, wo.id);
    expect(after.status).toBe('INVOICED');
    expect(Number(after.paidAmount)).toBe(0);
    // Стан на сторінці наряду: «Сплачено» 0.
    await page.goto(`/work-orders/${wo.id}`);
    await expect(page.getByTestId('wo-totals-remaining')).toContainText(totalText, {
      timeout: 20_000,
    });

    // BR-WO-031: «Виставлено» без оплати скасовується зі сторінки наряду.
    await page.getByRole('button', { name: 'Скасувати', exact: true }).first().click();
    const ask = page.getByRole('dialog').filter({ hasText: 'Перевести наряд у статус' });
    await expect(ask).toContainText('рахунок наряду — скасовано');
    await ask.getByRole('button', { name: 'Так, скасувати' }).click();
    await expect(ask).toBeHidden({ timeout: 10_000 });
    await expect
      .poll(async () => (await getWo(page, wo.id)).status, { timeout: 15_000 })
      .toBe('CANCELLED');
    // Bug #945: гарантія скасованого наряду не лишається «Активною».
    const warranties = await api<{ items: { workOrderId: string }[] }>(
      page,
      'GET',
      `/warranties?q=${encodeURIComponent(wo.number)}`,
    );
    expect(warranties.body.items.filter(w => w.workOrderId === wo.id)).toHaveLength(0);
  });

  // guards: BR-PAY-024, BR-BANK-040
  test('рознесений вхідний платіж → «Сторнувати оплату» → рядок «Не рознесено» з причиною', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.goto('/bank-statements?direction=IN');
    await expect(page.locator('h1:has-text("Банківські платежі")')).toBeVisible({
      timeout: 20_000,
    });
    const purpose = `000 E2E TST-REV вхідний ${uid}`;

    // Внесення з рознесенням «Оплата послуг» на клієнта спеку — одним кроком (BR-BANK-041).
    await page.getByRole('button', { name: 'Новий платіж' }).click();
    const create = page.getByRole('dialog', { name: 'Новий банківський платіж' });
    await expect(create).toBeVisible({ timeout: 8_000 });
    await create.getByLabel(/Банківський рахунок/).selectOption(state.accountId!);
    await create.getByLabel(/^Сума/).fill('250');
    await create.getByLabel('Призначення платежу').fill(purpose);
    await create.getByLabel('Рознести як').selectOption('SERVICE');
    await create.getByRole('button', { name: 'Обрати' }).first().click();
    const picker = page.getByRole('dialog', { name: 'Оберіть контрагента' });
    await expect(picker).toBeVisible({ timeout: 8_000 });
    await picker.getByPlaceholder('Пошук...').fill(CLIENT);
    await picker.getByRole('button', { name: new RegExp(CLIENT) }).click();
    await expect(picker).toBeHidden({ timeout: 8_000 });
    const created = page.waitForResponse(
      r => r.url().endsWith('/bank-statements/transactions') && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await create.getByRole('button', { name: 'Внести й рознести' }).click();
    const res = await created;
    expect(res.status(), 'платіж внесено й рознесено').toBeLessThan(300);
    const tx = (await res.json()) as { id: string; status: string; paymentId: string | null };
    expect(tx).toMatchObject({ status: 'MATCHED' });
    expect(tx.paymentId).toBeTruthy();
    state.bankTxId = tx.id;
    await expect(create).toBeHidden({ timeout: 8_000 });

    await page.getByPlaceholder(/Пошук за контрагентом/).fill(purpose);
    const row = page.locator('table tbody tr').filter({ hasText: purpose });
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    await expect(row).toContainText('Рознесено');
    // Рознесення вхідного знімає лише сторно оплати.
    await expect(row.getByRole('button', { name: 'Зняти рознесення' })).toHaveCount(0);
    await row.getByRole('button', { name: 'Сторнувати оплату' }).click();

    const body = await reverseInCard(page, '250,00 ₴');
    expect(body.id).toBe(tx.paymentId);

    await expect(row).toContainText('Не рознесено', { timeout: 15_000 });
    await expect(row).toContainText(`Рознесення скасовано: ${REASON}`);
    await expect(row.getByRole('button', { name: 'Сторнувати оплату' })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Рознести' })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('rev_bank_row.png') });

    const fresh = await api<{
      items: {
        id: string;
        status: string;
        paymentId: string | null;
        unmatchReason: string | null;
      }[];
    }>(page, 'GET', `/bank-statements/transactions?q=${encodeURIComponent(purpose)}&limit=5`);
    expect(fresh.body.items.find(i => i.id === tx.id)).toMatchObject({
      status: 'UNMATCHED',
      paymentId: null,
      unmatchReason: REASON,
    });
  });
});
