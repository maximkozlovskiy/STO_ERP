import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  apiCall,
  createCounterparty,
  createPlainRegister,
  deleteRegister,
  getToken,
} from './cash-desk.helpers';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/**
 * Етап Г2 «постачальники» (рішення власника 2026-10-30, TECH-DEBT (б) №34, №36, №38, №5):
 *   - «Оплатити» в картці замовлення — ОДНА дія (`POST /supplier-payments/pay` з ключем): проведена
 *     оплата, жодної скасованої (Bug #1020: confirm без ключа падав, і web скасовував щойно створену);
 *     відмова (каса в мінус) не лишає документа;
 *   - «Оплатити» лише на «Замовлено» / «Частково» / «Отримано» — на чернетці кнопки немає;
 *   - вкладка «Оплати постачальникам» → «Чернетки» → «Провести» / «Скасувати»;
 *   - повтор прийому з тим самим ключем не приймає товар удруге.
 *
 * Документ під перевіркою (оплата, прийом) — через інтерфейс. Передумови, яких UI не дає швидко
 * (постачальник, каса з грошима, замовлення в «Замовлено»), і стара чернетка оплати (вікно оплати
 * чернеток більше не створює) — через API.
 */

const stamp = Date.now();
const SUPPLIER = `000 E2E Постачальник Г2 ${stamp}`;
const REGISTER = `000 E2E Каса Г2 ${stamp}`;

let supplierId = '';
let registerId = '';
let goodId = '';
let warehouseId = '';
const orderIds: string[] = [];
const draftIds: string[] = [];

interface Po {
  id: string;
  number: string;
  lines: { id: string }[];
}

async function createOrder(page: Page, token: string, status: 'DRAFT' | 'ORDERED'): Promise<Po> {
  const res = await apiCall<Po>(page, token, 'POST', '/purchase-orders', {
    supplierId,
    warehouseId,
    lines: [{ goodId, quantity: 5, price: 100 }],
  });
  expect(res.status, `замовлення: ${JSON.stringify(res.body)}`).toBe(201);
  orderIds.push(res.body.id);
  if (status === 'ORDERED') {
    const t = await apiCall(page, token, 'POST', `/purchase-orders/${res.body.id}/transition`, {
      status: 'ORDERED',
    });
    expect(t.status, `перехід у «Замовлено»: ${JSON.stringify(t.body)}`).toBeLessThan(300);
  }
  return (await apiCall<Po>(page, token, 'GET', `/purchase-orders/${res.body.id}`)).body;
}

async function paymentsOf(page: Page, token: string, poId: string) {
  const res = await apiCall<{ items: { status: string; amount: number }[] }>(
    page,
    token,
    'GET',
    `/supplier-payments?purchaseOrderId=${poId}&limit=50`,
  );
  return res.body.items.map(p => `${p.status}:${Number(p.amount)}`);
}

async function openOrderCard(page: Page, po: Po): Promise<Locator> {
  await page.goto(`/purchase-orders?open=${po.id}`);
  const card = page.getByRole('dialog').filter({ hasText: po.number }).first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  // Документ завантажено (до того картка без дій, Bug #844): рядок товару на місці.
  await expect(card.locator('tbody tr').first()).toBeVisible({ timeout: 15_000 });
  return card;
}

async function openPayment(page: Page, card: Locator): Promise<Locator> {
  await card.getByRole('button', { name: 'Оплатити' }).click();
  const pay = page.getByRole('dialog').filter({ hasText: 'Оплата постачальнику' });
  await expect(pay).toBeVisible({ timeout: 10_000 });
  await pay.getByRole('combobox', { name: /^Каса/ }).selectOption({ label: REGISTER });
  return pay;
}

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const p = await ctx.newPage();
  await p.goto('/purchase-orders');
  const token = await getToken(p);
  supplierId = await createCounterparty(p, token, 'SUPPLIER', SUPPLIER);
  registerId = await createPlainRegister(p, token, REGISTER, 1_000);
  const [goods, warehouses] = await Promise.all([
    apiCall<{ items: { id: string }[] }>(p, token, 'GET', '/goods?limit=1'),
    apiCall<{ id: string }[] | { items: { id: string }[] }>(p, token, 'GET', '/warehouses'),
  ]);
  goodId = goods.body.items[0]?.id ?? '';
  const whs = Array.isArray(warehouses.body) ? warehouses.body : warehouses.body.items;
  warehouseId = whs[0]?.id ?? '';
  expect(goodId && warehouseId, 'seed: товар і склад').toBeTruthy();
  await ctx.close();
});

test.afterAll(async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const p = await ctx.newPage();
  await p.goto('/purchase-orders');
  const token = await getToken(p);
  // Проведені оплати й прийняті замовлення лишають проводки — їх не видалити; чернетки — так.
  for (const id of draftIds) {
    const r = await apiCall(p, token, 'DELETE', `/supplier-payments/${id}`);
    expect.soft(r.status, `чернетка оплати ${id}`).toBeLessThan(500);
  }
  for (const id of orderIds) await apiCall(p, token, 'DELETE', `/purchase-orders/${id}`);
  if (registerId) await deleteRegister(p, token, registerId);
  if (supplierId) await apiCall(p, token, 'DELETE', `/counterparties/${supplierId}`);
  await ctx.close();
});

test('«Оплатити» в картці «Замовлено»: одна проведена оплата з ключем, скасованих немає', async ({
  page,
}) => {
  await page.goto('/purchase-orders');
  const token = await getToken(page);
  const po = await createOrder(page, token, 'ORDERED');
  const card = await openOrderCard(page, po);
  const pay = await openPayment(page, card);
  await pay.getByRole('textbox', { name: /^Сума/ }).fill('150');

  const sent = page.waitForRequest(
    r => r.method() === 'POST' && r.url().includes('/supplier-payments/pay'),
  );
  const answered = page.waitForResponse(
    r => r.request().method() === 'POST' && r.url().includes('/supplier-payments/pay'),
  );
  await pay.getByRole('button', { name: 'Оплатити' }).click();
  expect((await sent).headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  expect((await answered).status()).toBe(201);
  await expect(pay).toBeHidden({ timeout: 10_000 });

  // Bug #1020: раніше тут лежала СКАСОВАНА оплата з витраченим номером.
  expect(await paymentsOf(page, token, po.id)).toEqual(['CONFIRMED:150']);
});

test('відмова (у касі менше, ніж сума): текст у вікні, документа не лишається', async ({
  page,
}) => {
  await page.goto('/purchase-orders');
  const token = await getToken(page);
  const po = await createOrder(page, token, 'ORDERED');
  const card = await openOrderCard(page, po);
  const pay = await openPayment(page, card);
  await pay.getByRole('textbox', { name: /^Сума/ }).fill('5000');

  await pay.getByRole('button', { name: 'Оплатити' }).click();
  await expect(pay.getByRole('alert')).toContainText(/Недостатньо готівки/, { timeout: 10_000 });
  await expect(pay).toBeVisible();
  expect(await paymentsOf(page, token, po.id)).toEqual([]);
});

test('чернетка замовлення: «Оплатити» в картці немає', async ({ page }) => {
  await page.goto('/purchase-orders');
  const token = await getToken(page);
  const po = await createOrder(page, token, 'DRAFT');
  const card = await openOrderCard(page, po);
  await expect(card.getByRole('button', { name: 'Зберегти зміни' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Оплатити' })).toHaveCount(0);
});

test('«Оплати постачальникам» → «Чернетки»: стару чернетку провести, другу скасувати', async ({
  page,
}) => {
  await page.goto('/purchase-orders');
  const token = await getToken(page);
  const po = await createOrder(page, token, 'ORDERED');
  // Стара чернетка — так оплати створювались до 2026-10-30 (create без проведення).
  const draft = async (amount: number) => {
    const r = await apiCall<{ id: string; number: string }>(
      page,
      token,
      'POST',
      '/supplier-payments',
      {
        supplierId,
        sourceType: 'CASH_REGISTER',
        cashRegisterId: registerId,
        purchaseOrderId: po.id,
        amount,
        method: 'cash',
      },
    );
    expect(r.status, `чернетка: ${JSON.stringify(r.body)}`).toBe(201);
    draftIds.push(r.body.id);
    return r.body;
  };
  const toPost = await draft(70);
  const toCancel = await draft(30);

  await page.goto('/purchase-orders?tab=payments');
  const group = page.getByRole('group', { name: 'Статус' });
  await expect(group.getByRole('button', { name: 'Чернетки' })).toHaveAttribute(
    'aria-pressed',
    'true',
    { timeout: 30_000 },
  );

  // «Провести»
  await page.getByRole('button', { name: `Провести оплату ${toPost.number}` }).click();
  const confirmDialog = page.getByRole('dialog').filter({ hasText: toPost.number });
  const confirmReq = page.waitForRequest(
    r => r.method() === 'POST' && r.url().includes(`/supplier-payments/${toPost.id}/confirm`),
  );
  await confirmDialog.getByRole('button', { name: 'Провести' }).click();
  expect((await confirmReq).headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  await expect(page.getByRole('cell', { name: toPost.number })).toHaveCount(0, { timeout: 10_000 });

  // «Скасувати»
  await page.getByRole('button', { name: `Скасувати чернетку ${toCancel.number}` }).click();
  await page
    .getByRole('dialog')
    .filter({ hasText: toCancel.number })
    .getByRole('button', { name: 'Скасувати чернетку' })
    .click();
  await expect(page.getByRole('cell', { name: toCancel.number })).toHaveCount(0, {
    timeout: 10_000,
  });

  expect((await paymentsOf(page, token, po.id)).sort()).toEqual(['CANCELLED:30', 'CONFIRMED:70']);
});

test('повтор прийому з тим самим ключем: товар прийнято раз', async ({ page }) => {
  await page.goto('/purchase-orders');
  const token = await getToken(page);
  const po = await createOrder(page, token, 'ORDERED');
  const card = await openOrderCard(page, po);

  await card.getByRole('button', { name: 'Оприбуткувати' }).click();
  await card
    .getByPlaceholder(/^макс\./)
    .first()
    .fill('1');
  const sent = page.waitForRequest(
    r => r.method() === 'POST' && r.url().includes(`/purchase-orders/${po.id}/receive`),
  );
  await card.getByRole('button', { name: 'Підтвердити прийом' }).click();
  const req = await sent;
  const key = req.headers()['idempotency-key'];
  expect(key).toMatch(/^[0-9a-f-]{36}$/);
  await expect(card.getByRole('button', { name: 'Підтвердити прийом' })).toHaveCount(0, {
    timeout: 10_000,
  });

  // Той самий запит ще раз — як повтор після обриву відповіді: сервер віддає збережену відповідь.
  const replay = await page.evaluate(
    async ({ url, body, key, token }) => {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body,
      });
      return r.status;
    },
    { url: req.url(), body: req.postData() ?? '{}', key, token },
  );
  expect(replay).toBeLessThan(300);

  const fresh = await apiCall<{ lines: { receivedQty: number }[] }>(
    page,
    token,
    'GET',
    `/purchase-orders/${po.id}`,
  );
  expect(fresh.body.lines.map(l => Number(l.receivedQty))).toEqual([1]);
});
