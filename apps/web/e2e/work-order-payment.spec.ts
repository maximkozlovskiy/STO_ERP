import { test, expect, type Page } from '@playwright/test';
import { apiCall } from './api-helpers';
import { ensureVehicleModel } from './vehicle-directory';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/**
 * Оплата наряду з документа наряду (рішення власника 2026-10-15): аванс до «Виконано», оплата
 * після; рахунок наряду — дзеркало наряду.
 *
 *   1. аванс у «В роботі» → «Сплачено» наряду росте, статус той самий (BR-PAY-020);
 *   2. завершення → оплата залишку → «Оплачено» без рахунку (BR-PAY-005, BR-WO-016);
 *   3. акт на повністю оплаченому наряді → рахунок-чернетка зі сплаченим = сума (BR-INV-020);
 *   4. оплата рахунку наряду зі сторінки «Рахунки» → «Сплачено» наряду росте (BR-PAY-021);
 *   5. скасування наряду з оплатою → «спершу сторнуйте оплату» (BR-WO-014).
 *
 * Спек створює власні дані й не покладається на вміст dev-бази: касу «000 E2E Каса оплата
 * наряду …», спосіб оплати з цією касою за замовчуванням, клієнта з гаражем і авто, категорію й
 * роботу каталогу. Виконавець рядка — поточний користувач (співробітник, яким увійшли). Оплати й
 * наряди лишаються в базі навмисно (фінансовий слід); спосіб оплати, касу й роботу прибираємо.
 */

async function getToken(page: Page): Promise<string> {
  const token = await page.evaluate(
    () =>
      sessionStorage.getItem('sto_access_token') ?? localStorage.getItem('sto_e2e_access_token'),
  );
  expect(token, 'access token має бути у storage').toBeTruthy();
  return token as string;
}

// Спільний хелпер: повтор на 429 і ключ ідемпотентності POST (каса й оплати без нього — 400).
const api = <T = unknown>(
  page: Page,
  token: string,
  method: string,
  path: string,
  body?: unknown,
) => apiCall<T>(page, token, method, path, body);

/** Список із відповіді: `{ items }` або масив. */
const listOf = <T>(b: unknown): T[] =>
  Array.isArray(b) ? (b as T[]) : (((b as { items?: T[] } | null)?.items ?? []) as T[]);

interface WorkOrderDto {
  id: string;
  number: string;
  status: string;
  totalAmount: number;
  paidAmount: number;
}

const stamp = Date.now();
const ctx = {
  registerId: '',
  methodId: '',
  methodCode: `wop_e2e_${stamp}`,
  clientId: '',
  vehicleId: '',
  branchId: '',
  employeeId: '',
  categoryId: '',
  workId: '',
};

async function getWo(page: Page, token: string, id: string): Promise<WorkOrderDto> {
  const res = await api<WorkOrderDto>(page, token, 'GET', `/work-orders/${id}`);
  expect(res.status, `читання наряду: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body;
}

async function transition(page: Page, token: string, id: string, status: string) {
  const res = await api(page, token, 'POST', `/work-orders/${id}/transition`, { status });
  expect(res.status, `перехід у ${status}: ${JSON.stringify(res.body)}`).toBe(201);
}

/** Наряд клієнта спеку з однією роботою (1 год × 1000), доведений до `upTo`. */
async function createWorkOrder(
  page: Page,
  token: string,
  upTo: 'DRAFT' | 'APPROVED' | 'IN_PROGRESS' | 'COMPLETED',
): Promise<WorkOrderDto> {
  const wo = await api<WorkOrderDto>(page, token, 'POST', '/work-orders', {
    counterpartyId: ctx.clientId,
    branchId: ctx.branchId,
    vehicleId: ctx.vehicleId,
    description: `E2E оплата наряду ${stamp}`,
  });
  expect(wo.status, `створення наряду: ${JSON.stringify(wo.body)}`).toBe(201);
  const line = await api(page, token, 'POST', `/work-orders/${wo.body.id}/lines`, {
    workId: ctx.workId,
    employeeId: ctx.employeeId,
    normoHours: 1,
    price: 1000,
  });
  expect(line.status, `рядок роботи: ${JSON.stringify(line.body)}`).toBe(201);
  const path = ['ESTIMATE', 'APPROVED', 'IN_PROGRESS', 'COMPLETED'];
  for (const s of path.slice(0, upTo === 'DRAFT' ? 0 : path.indexOf(upTo) + 1)) {
    await transition(page, token, wo.body.id, s);
  }
  return getWo(page, token, wo.body.id);
}

/** Оплата через API — коли сам крок оплати не предмет тесту. */
async function payViaApi(page: Page, token: string, workOrderId: string, amount: number) {
  const res = await api(page, token, 'POST', '/payments', {
    counterpartyId: ctx.clientId,
    workOrderId,
    amount,
    method: ctx.methodCode,
    sourceType: 'CASH_REGISTER',
    cashRegisterId: ctx.registerId,
  });
  expect(res.status, `оплата наряду: ${JSON.stringify(res.body)}`).toBe(201);
}

async function openWorkOrderPage(page: Page, wo: WorkOrderDto) {
  await page.goto(`/work-orders/${wo.id}`);
  await expect(page.locator('h1', { hasText: wo.number })).toBeVisible({ timeout: 20_000 });
}

/** «Оплатити» на сторінці наряду: вікно з заголовком, спосіб спеку (його каса — за замовчуванням). */
async function payFromWorkOrderPage(page: Page, title: string, amount?: number) {
  await page.getByRole('button', { name: 'Оплатити', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: title });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await dialog.getByLabel('Метод оплати').selectOption(ctx.methodCode);
  await expect(dialog.getByLabel(/^Каса/)).toHaveValue(ctx.registerId);
  if (amount !== undefined) await dialog.getByLabel('Сума, ₴').fill(String(amount));
  await dialog.getByRole('button', { name: 'Підтвердити оплату' }).click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });
}

test.describe('Оплата наряду з документа наряду', () => {
  test.beforeAll(async ({ browser }) => {
    const bctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await bctx.newPage();
    await p.goto('/work-orders');
    const token = await getToken(p);

    const [currencies, branches, employees] = await Promise.all([
      api(p, token, 'GET', '/currencies'),
      api(p, token, 'GET', '/branches'),
      api(p, token, 'GET', '/employees?limit=1&role=MECHANIC&sortBy=createdAt&sortDir=asc'),
    ]);
    const uah = listOf<{ id: string; code: string }>(currencies.body).find(c => c.code === 'UAH');
    ctx.branchId = listOf<{ id: string }>(branches.body)[0]?.id ?? '';
    ctx.employeeId = listOf<{ id: string }>(employees.body)[0]?.id ?? '';
    expect(ctx.branchId && ctx.employeeId && uah?.id, 'філія, співробітник, гривня').toBeTruthy();

    // «000» на початку: каси в полі вікна — перші 200 за назвою.
    const reg = await api<{ id: string }>(p, token, 'POST', '/cash-registers', {
      name: `000 E2E Каса оплата наряду ${stamp}`,
      currencyId: uah!.id,
      branchId: ctx.branchId,
    });
    expect(reg.status, `каса: ${JSON.stringify(reg.body)}`).toBe(201);
    ctx.registerId = reg.body.id;

    const method = await api<{ id: string }>(p, token, 'POST', '/payment-methods', {
      code: ctx.methodCode,
      name: `000 E2E Оплата наряду ${stamp}`,
      sortOrder: 999,
      requiresFiscal: false,
      defaultSourceType: 'CASH_REGISTER',
      defaultCashRegisterId: ctx.registerId,
    });
    expect(method.status, `спосіб оплати: ${JSON.stringify(method.body)}`).toBe(201);
    ctx.methodId = method.body.id;

    const client = await api<{ id: string }>(p, token, 'POST', '/counterparties', {
      type: 'CLIENT',
      companyName: `E2E Клієнт оплата наряду ${stamp}`,
    });
    expect(client.status, `клієнт: ${JSON.stringify(client.body)}`).toBe(201);
    ctx.clientId = client.body.id;
    const garage = await api<{ id: string }>(
      p,
      token,
      'POST',
      `/counterparties/${ctx.clientId}/garages`,
      { name: 'E2E гараж' },
    );
    expect(garage.status, `гараж: ${JSON.stringify(garage.body)}`).toBe(201);
    const vehicle = await api<{ id: string }>(p, token, 'POST', '/vehicles', {
      customerGarageId: garage.body.id,
      ...(await ensureVehicleModel(
        (method, url, data) => api(p, token, method, url, data),
        'Toyota',
        'Corolla',
      )),
      licensePlate: `E2E${String(stamp).slice(-5)}`,
    });
    expect(vehicle.status, `авто: ${JSON.stringify(vehicle.body)}`).toBe(201);
    ctx.vehicleId = vehicle.body.id;

    const category = await api<{ id: string }>(p, token, 'POST', '/work-categories', {
      name: `E2E оплата наряду ${stamp}`,
    });
    expect(category.status, `категорія робіт: ${JSON.stringify(category.body)}`).toBe(201);
    ctx.categoryId = category.body.id;
    const work = await api<{ id: string }>(p, token, 'POST', '/works', {
      categoryId: ctx.categoryId,
      name: `E2E робота оплата наряду ${stamp}`,
      normoHours: 1,
      price: 1000,
    });
    expect(work.status, `робота: ${JSON.stringify(work.body)}`).toBe(201);
    ctx.workId = work.body.id;
    await bctx.close();
  });

  test.afterAll(async ({ browser }) => {
    const bctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await bctx.newPage();
    await p.goto('/work-orders');
    const token = await getToken(p);
    if (ctx.methodId) await api(p, token, 'DELETE', `/payment-methods/${ctx.methodId}`);
    if (ctx.workId) await api(p, token, 'DELETE', `/works/${ctx.workId}`);
    if (ctx.categoryId) await api(p, token, 'DELETE', `/work-categories/${ctx.categoryId}`);
    if (ctx.registerId) await api(p, token, 'DELETE', `/cash-registers/${ctx.registerId}`);
    await bctx.close();
  });

  let woId = '';

  // guards: BR-PAY-020
  test('аванс у «В роботі»: «Сплачено» росте, статус той самий, залишок зменшився', async ({
    page,
  }) => {
    await page.goto('/work-orders');
    const token = await getToken(page);
    const wo = await createWorkOrder(page, token, 'IN_PROGRESS');
    woId = wo.id;

    await openWorkOrderPage(page, wo);
    await payFromWorkOrderPage(page, `Аванс за нарядом ${wo.number}`, 400);

    await expect
      .poll(async () => (await getWo(page, token, wo.id)).paidAmount, { timeout: 10_000 })
      .toBe(400);
    const after = await getWo(page, token, wo.id);
    expect(after.status).toBe('IN_PROGRESS');
    // Сторінка перечитала наряд: залишок = «Разом» − аванс.
    await expect(page.getByTestId('wo-totals-remaining')).toContainText(
      (after.totalAmount - 400).toLocaleString('uk-UA', { minimumFractionDigits: 2 }),
    );
  });

  // guards: BR-PAY-005, BR-WO-016
  test('завершення → оплата залишку з «Виконано» → «Оплачено» без рахунку', async ({ page }) => {
    expect(woId, 'попередній тест мав створити наряд з авансом').toBeTruthy();
    await page.goto('/work-orders');
    const token = await getToken(page);
    await transition(page, token, woId, 'COMPLETED');
    const wo = await getWo(page, token, woId);
    expect(wo.status).toBe('COMPLETED');

    await openWorkOrderPage(page, wo);
    // Порожня сума = залишок.
    await payFromWorkOrderPage(page, `Оплата наряду ${wo.number}`);

    await expect
      .poll(async () => (await getWo(page, token, woId)).status, { timeout: 10_000 })
      .toBe('PAID');
    const paid = await getWo(page, token, woId);
    expect(paid.paidAmount).toBeCloseTo(paid.totalAmount, 2);
    const invoice = await api(page, token, 'GET', `/invoices/from-work-order/${woId}/find`);
    expect(invoice.body, 'рахунок не створюється').toBeNull();
    // Статус на сторінці — з сервера; «Оплатити» більше немає.
    await expect(page.locator('h1', { hasText: wo.number }).locator('..')).toContainText(
      'Оплачено',
    );
    await expect(page.getByRole('button', { name: 'Оплатити', exact: true })).toHaveCount(0);
  });

  // guards: BR-INV-020
  test('акт на повністю оплаченому наряді → рахунок-чернетка зі сплаченим = сума', async ({
    page,
  }) => {
    await page.goto('/work-orders');
    const token = await getToken(page);
    const wo = await createWorkOrder(page, token, 'COMPLETED');
    const act = await api(page, token, 'POST', `/completion-acts/from-work-order/${wo.id}`);
    expect(act.status, `акт: ${JSON.stringify(act.body)}`).toBe(201);
    await payViaApi(page, token, wo.id, wo.totalAmount);
    expect((await getWo(page, token, wo.id)).status).toBe('PAID');

    await openWorkOrderPage(page, wo);
    await page.getByRole('button', { name: 'Позначити як підписано' }).click();

    await expect
      .poll(
        async () =>
          (
            await api<{ id: string } | null>(
              page,
              token,
              'GET',
              `/invoices/from-work-order/${wo.id}/find`,
            )
          ).body?.id ?? null,
        { timeout: 15_000, message: 'підписання акта створює рахунок і для оплаченого наряду' },
      )
      .not.toBeNull();
    const found = await api<{ id: string }>(
      page,
      token,
      'GET',
      `/invoices/from-work-order/${wo.id}/find`,
    );
    const invoice = await api<{ status: string; amount: number; paidAmount: number }>(
      page,
      token,
      'GET',
      `/invoices/${found.body.id}`,
    );
    expect(invoice.body.status).toBe('DRAFT');
    expect(invoice.body.paidAmount).toBeCloseTo(invoice.body.amount, 2);
    expect((await getWo(page, token, wo.id)).status).toBe('PAID');
  });

  // guards: BR-PAY-021
  test('оплата рахунку наряду зі сторінки «Рахунки» → «Сплачено» наряду росте', async ({
    page,
  }) => {
    await page.goto('/work-orders');
    const token = await getToken(page);
    const wo = await createWorkOrder(page, token, 'COMPLETED');
    const created = await api<{ id: string; number: string }>(
      page,
      token,
      'POST',
      `/invoices/from-work-order/${wo.id}`,
    );
    expect(created.status, `рахунок: ${JSON.stringify(created.body)}`).toBe(201);
    const sent = await api(page, token, 'POST', `/invoices/${created.body.id}/transition`, {
      status: 'SENT',
    });
    expect(sent.status, `відправка рахунку: ${JSON.stringify(sent.body)}`).toBe(201);

    await page.goto('/invoices');
    await expect(page.locator('h1:has-text("Рахунки")')).toBeVisible({ timeout: 20_000 });
    await page.locator('input[placeholder*="Пошук"]').first().fill(created.body.number);
    const row = page.locator(`table tbody tr:has-text("${created.body.number}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByText(created.body.number).first().click();
    await page.getByRole('button', { name: 'Оплатити' }).first().click();
    const dialog = page.getByRole('dialog', {
      name: `Реєстрація оплати по рахунку ${created.body.number}`,
    });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByLabel('Метод оплати').selectOption(ctx.methodCode);
    await dialog.getByLabel('Сума, ₴').fill('100');
    await dialog.getByRole('button', { name: 'Підтвердити оплату' }).click();
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    await expect
      .poll(async () => (await getWo(page, token, wo.id)).paidAmount, { timeout: 10_000 })
      .toBe(100);
    const invoice = await api<{ status: string; paidAmount: number }>(
      page,
      token,
      'GET',
      `/invoices/${created.body.id}`,
    );
    expect(invoice.body).toMatchObject({ status: 'PARTIALLY_PAID', paidAmount: 100 });
  });

  // guards: BR-WO-014
  test('скасування наряду з авансом → «спершу сторнуйте оплату», статус не змінився', async ({
    page,
  }) => {
    await page.goto('/work-orders');
    const token = await getToken(page);
    const wo = await createWorkOrder(page, token, 'APPROVED');
    await payViaApi(page, token, wo.id, 100);

    await openWorkOrderPage(page, wo);
    await page.getByRole('button', { name: 'Скасувати', exact: true }).click();
    // BR-WO-025: підтвердження скасування — той самий текст, що в картці наряду.
    await page.getByRole('button', { name: 'Так, скасувати', exact: true }).click();

    await expect(page.getByText(/спершу сторнуйте оплату/).first()).toBeVisible({
      timeout: 10_000,
    });
    expect((await getWo(page, token, wo.id)).status).toBe('APPROVED');
  });
});
