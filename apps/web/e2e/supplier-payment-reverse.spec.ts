import { test, expect, type Locator, type Page } from '@playwright/test';
import { apiCall, createCounterparty, getBalance, getToken } from './cash-desk.helpers';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/**
 * Сторно банківської оплати постачальнику (BR-SUPPAY-017, рішення власника 2026-11-06, TECH-DEBT (б)
 * №90): у вкладці «Оплати постачальникам» проведену банківську оплату сторнують дією «Сторнувати» з
 * причиною — статус «Сторновано», борг постачальнику повертається, «сплачено» замовлення назад.
 * Оплату, на яку рознесено рядок банківської виписки, сервер не сторнує, доки рознесення не знято, —
 * пояснення видно у вікні; після зняття та сама спроба проходить.
 *
 * Документи під перевіркою — оплата і її сторно — через інтерфейс. Передумови, яких UI не дає швидко
 * (постачальник, замовлення в «Замовлено», рядок виписки й його рознесення), — через API. Тест
 * створює свої дані сам (банківський рахунок у гривні — наявний або новий): CI — чиста база.
 */

const stamp = Date.now();
const SUPPLIER = `000 E2E Постачальник сторно ${stamp}`;
const REASON = 'E2E: оплачено не тому постачальнику';

let supplierId = '';
let goodId = '';
let warehouseId = '';
let bankAccount = { id: '', name: '' };
const orderIds: string[] = [];
const bankRowIds: string[] = [];

interface Po {
  id: string;
  number: string;
}

interface Paid {
  id: string;
  number: string;
}

async function createOrderedPo(page: Page, token: string): Promise<Po> {
  const res = await apiCall<Po>(page, token, 'POST', '/purchase-orders', {
    supplierId,
    warehouseId,
    lines: [{ goodId, quantity: 1, price: 100 }],
  });
  expect(res.status, `замовлення: ${JSON.stringify(res.body)}`).toBe(201);
  orderIds.push(res.body.id);
  const t = await apiCall(page, token, 'POST', `/purchase-orders/${res.body.id}/transition`, {
    status: 'ORDERED',
  });
  expect(t.status, `перехід у «Замовлено»: ${JSON.stringify(t.body)}`).toBeLessThan(300);
  return res.body;
}

/** «Оплатити» в картці замовлення з банківського рахунку — документ оплати через інтерфейс. */
async function payByBank(page: Page, po: Po, amount: string): Promise<Paid> {
  await page.goto(`/purchase-orders?open=${po.id}`);
  const card = page.getByRole('dialog').filter({ hasText: po.number }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.locator('tbody tr').first()).toBeVisible({ timeout: 15_000 });
  await card.getByRole('button', { name: 'Оплатити' }).click();
  const pay = page.getByRole('dialog').filter({ hasText: 'Оплата постачальнику' });
  await expect(pay).toBeVisible({ timeout: 10_000 });
  await pay.getByRole('combobox', { name: /^Джерело коштів/ }).selectOption('BANK_ACCOUNT');
  await pay
    .getByRole('combobox', { name: /^Банківський рахунок/ })
    .selectOption({ label: bankAccount.name });
  await pay.getByRole('textbox', { name: /^Сума/ }).fill(amount);
  const answered = page.waitForResponse(
    r => r.request().method() === 'POST' && r.url().includes('/supplier-payments/pay'),
  );
  await pay.getByRole('button', { name: 'Оплатити' }).click();
  const res = await answered;
  expect(res.status(), `оплата: ${await res.text()}`).toBe(201);
  await expect(pay).toBeHidden({ timeout: 10_000 });
  return (await res.json()) as Paid;
}

/** Вкладка «Оплати постачальникам», фільтр «Всі» — рядок оплати за номером. */
async function paymentRow(page: Page, number: string): Promise<Locator> {
  await page.goto('/purchase-orders?tab=payments');
  const group = page.getByRole('group', { name: 'Статус' });
  await group.getByRole('button', { name: 'Всі' }).click({ timeout: 30_000 });
  const row = page.locator('tbody tr').filter({ hasText: number });
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  return row;
}

async function openReversal(page: Page, number: string): Promise<Locator> {
  await page.getByRole('button', { name: `Сторнувати оплату ${number}` }).click();
  const dialog = page.getByRole('dialog', { name: 'Сторно оплати постачальнику' });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  return dialog;
}

async function submitReversal(page: Page, dialog: Locator, id: string) {
  await dialog.getByRole('button', { name: 'Сторнувати' }).click();
  const answered = page.waitForResponse(
    r => r.request().method() === 'POST' && r.url().includes(`/supplier-payments/${id}/reverse`),
  );
  await dialog.getByRole('button', { name: 'Так, сторнувати' }).click();
  return answered;
}

async function paymentState(page: Page, token: string, id: string) {
  const res = await apiCall<{ status: string }>(page, token, 'GET', `/supplier-payments/${id}`);
  return res.body.status;
}

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const p = await ctx.newPage();
  await p.goto('/purchase-orders');
  const token = await getToken(p);
  supplierId = await createCounterparty(p, token, 'SUPPLIER', SUPPLIER);
  const [goods, warehouses, currencies, accounts] = await Promise.all([
    apiCall<{ items: { id: string }[] }>(p, token, 'GET', '/goods?limit=1'),
    apiCall<{ id: string }[] | { items: { id: string }[] }>(p, token, 'GET', '/warehouses'),
    apiCall<{ id: string; code: string }[] | { items: { id: string; code: string }[] }>(
      p,
      token,
      'GET',
      '/currencies',
    ),
    apiCall<
      | { id: string; name: string; currencyId: string }[]
      | { items: { id: string; name: string; currencyId: string }[] }
    >(p, token, 'GET', '/bank-accounts'),
  ]);
  const list = <T>(b: T[] | { items: T[] }) => (Array.isArray(b) ? b : b.items);
  goodId = goods.body.items[0]?.id ?? '';
  warehouseId = list(warehouses.body)[0]?.id ?? '';
  expect(goodId && warehouseId, 'seed: товар і склад').toBeTruthy();
  // Замовлення без валюти — у гривні; оплата за ним — лише з рахунку тієї самої валюти.
  const uah = list(currencies.body).find(c => c.code === 'UAH');
  expect(uah, 'seed: гривня').toBeTruthy();
  const existing = list(accounts.body).find(a => a.currencyId === uah!.id);
  if (existing) {
    bankAccount = { id: existing.id, name: existing.name };
  } else {
    const name = `000 E2E Рахунок сторно ${stamp}`;
    const created = await apiCall<{ id: string }>(p, token, 'POST', '/bank-accounts', {
      name,
      ibanUA: `UA${String(stamp).slice(-9).padStart(27, '0')}`,
      currencyId: uah!.id,
    });
    expect(created.status, `рахунок: ${JSON.stringify(created.body)}`).toBe(201);
    bankAccount = { id: created.body.id, name };
  }
  await ctx.close();
});

test.afterAll(async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const p = await ctx.newPage();
  await p.goto('/purchase-orders');
  const token = await getToken(p);
  // Рядок виписки: зняти рознесення (якщо лишилось) і видалити — він внесений вручну.
  for (const id of bankRowIds) {
    await apiCall(p, token, 'POST', `/bank-statements/transactions/${id}/unreconcile`, {
      reason: 'E2E: прибирання',
    });
    const del = await apiCall(p, token, 'DELETE', `/bank-statements/transactions/${id}`);
    expect.soft(del.status, `рядок виписки ${id}`).toBeLessThan(300);
  }
  // Оплати, що лишились проведеними (тест упав посередині), — сторно, щоб борг постачальника = 0.
  const left = await apiCall<{ items: { id: string; status: string }[] }>(
    p,
    token,
    'GET',
    `/supplier-payments?supplierId=${supplierId}&limit=50`,
  );
  for (const sp of left.body.items?.filter(x => x.status === 'CONFIRMED') ?? []) {
    const r = await apiCall(p, token, 'POST', `/supplier-payments/${sp.id}/reverse`, {
      reason: 'E2E: прибирання',
    });
    expect.soft(r.status, `сторно ${sp.id}`).toBeLessThan(300);
  }
  // Сплачені замовлення лишили проводки — видалення може відмовити; це не падіння прогону.
  for (const id of orderIds) {
    const r = await apiCall(p, token, 'DELETE', `/purchase-orders/${id}`);
    expect.soft(r.status, `замовлення ${id}`).toBeLessThan(500);
  }
  if (supplierId) {
    const r = await apiCall(p, token, 'DELETE', `/counterparties/${supplierId}`);
    expect.soft(r.status, 'постачальник').toBeLessThan(500);
  }
  await ctx.close();
});

test('«Сторнувати» проведену банківську оплату: «Сторновано», борг і «сплачено» назад', async ({
  page,
}) => {
  await page.goto('/purchase-orders');
  const token = await getToken(page);
  const po = await createOrderedPo(page, token);
  const before = await getBalance(page, token, supplierId);

  const sp = await payByBank(page, po, '100');
  expect(await getBalance(page, token, supplierId)).toBeCloseTo(before + 100, 2);

  const row = await paymentRow(page, sp.number);
  await expect(row).toContainText('Проведено');
  const dialog = await openReversal(page, sp.number);
  await expect(dialog.getByRole('note')).toContainText('борг постачальнику зросте на цю суму');
  await dialog.getByLabel(/^Причина сторно/).fill(REASON);
  const res = await submitReversal(page, dialog, sp.id);
  expect(res.request().headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  expect(res.status(), await res.text()).toBe(200);
  await expect(dialog).toBeHidden({ timeout: 10_000 });

  await expect(row).toContainText('Сторновано', { timeout: 10_000 });
  await expect(page.getByRole('button', { name: `Сторнувати оплату ${sp.number}` })).toHaveCount(0);
  expect(await getBalance(page, token, supplierId)).toBeCloseTo(before, 2);
  const order = await apiCall<{ paidAmount: number | string }>(
    page,
    token,
    'GET',
    `/purchase-orders/${po.id}`,
  );
  expect(Number(order.body.paidAmount)).toBe(0);
});

test('рядок виписки рознесено на оплату: «спершу зніміть рознесення», після зняття — сторно', async ({
  page,
}) => {
  await page.goto('/purchase-orders');
  const token = await getToken(page);
  const po = await createOrderedPo(page, token);
  const sp = await payByBank(page, po, '100');

  // Передумова: вихідний рядок виписки на ту саму суму й рахунок, прив'язаний до оплати (BR-BANK-027).
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' });
  const line = await apiCall<{ id: string }>(page, token, 'POST', '/bank-statements/transactions', {
    bankAccountId: bankAccount.id,
    direction: 'OUT',
    amount: 100,
    operationDate: today,
    purpose: `000 E2E сторно ${stamp}`,
  });
  expect(line.status, `рядок виписки: ${JSON.stringify(line.body)}`).toBeLessThan(300);
  bankRowIds.push(line.body.id);
  const linked = await apiCall(
    page,
    token,
    'POST',
    `/bank-statements/transactions/${line.body.id}/reconcile`,
    { type: 'SUPPLIER_PAYMENT', supplierPaymentId: sp.id },
  );
  expect(linked.status, `прив'язка: ${JSON.stringify(linked.body)}`).toBeLessThan(300);

  await paymentRow(page, sp.number);
  const dialog = await openReversal(page, sp.number);
  await dialog.getByLabel(/^Причина сторно/).fill(REASON);
  const refused = await submitReversal(page, dialog, sp.id);
  expect(refused.status()).toBe(400);
  await expect(dialog.getByRole('alert')).toContainText('спершу зніміть рознесення рядка', {
    timeout: 10_000,
  });
  await expect(dialog).toBeVisible();
  expect(await paymentState(page, token, sp.id)).toBe('CONFIRMED');

  // Рознесення знято — та сама спроба у тому ж вікні проходить.
  const undo = await apiCall(
    page,
    token,
    'POST',
    `/bank-statements/transactions/${line.body.id}/unreconcile`,
    { reason: 'E2E: не та оплата' },
  );
  expect(undo.status, `зняття рознесення: ${JSON.stringify(undo.body)}`).toBeLessThan(300);
  const retried = await submitReversal(page, dialog, sp.id);
  expect(retried.status(), await retried.text()).toBe(200);
  await expect(dialog).toBeHidden({ timeout: 10_000 });
  expect(await paymentState(page, token, sp.id)).toBe('REVERSED');
});
