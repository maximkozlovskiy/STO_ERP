import { test, expect, type Page } from '@playwright/test';
import { API } from './api-url';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/**
 * Друк наряд-замовлення і рахунку з наряду (BR-WO-013): з картки наряду і зі сторінки наряду.
 *
 * Наскрізне, чого unit-тести не доводять: справжній серверний PDF через справжню вибірку Prisma
 * (реквізити організації з основним банківським рахунком), справжнє вікно друку браузера і
 * справжнє завантаження файла. Перевіряється, що PDF отримано (`%PDF`) — текст стиснутого PDF
 * із вбудованим шрифтом тут не читається, його зміст стережуть unit-тести.
 *
 * Свої дані: банківський рахунок «000 E2E Банк UAH (друк)» — наявний або створений (без
 * накопичення між прогонами), на час сценарію він основний рахунок організації, потім
 * повертається попередній; наряд «Виконано» з рахунком — прибираються наприкінці.
 */

const OWN_ACCOUNT = '000 E2E Банк UAH (друк)';

interface Fixture {
  woId: string;
  woNumber: string;
  invoiceId: string;
  prevBankAccountId: string | null;
}

let fx: Fixture | null = null;

async function getToken(page: Page): Promise<string> {
  const token = await page.evaluate(
    () =>
      sessionStorage.getItem('sto_access_token') ?? localStorage.getItem('sto_e2e_access_token'),
  );
  expect(token, 'access token має бути у storage').toBeTruthy();
  return token as string;
}

/** Виклик API зі сторінки; повертає статус і тіло (помилка — не виняток, її видно в expect). */
async function api(page: Page, method: string, path: string, body?: unknown) {
  const token = await getToken(page);
  return page.evaluate(
    async ({ token, API, method, path, body }) => {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (body !== null) headers['Content-Type'] = 'application/json';
      const res = await fetch(`${API}${path}`, {
        method,
        headers,
        ...(body !== null ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = text;
      }
      return { status: res.status, body: json as Record<string, unknown> | null };
    },
    { token, API, method, path, body: body ?? null },
  );
}

const items = (b: unknown): Array<Record<string, unknown>> => {
  const r = b as { items?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
  return Array.isArray(r) ? r : (r?.items ?? []);
};
const isV4 = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);

async function setUp(page: Page): Promise<Fixture> {
  // Власний банківський рахунок — основний рахунок організації на час сценарію.
  let account = items((await api(page, 'GET', '/bank-accounts')).body).find(
    a => a.name === OWN_ACCOUNT,
  );
  if (!account) {
    const uah = items((await api(page, 'GET', '/currencies')).body).find(c => c.code === 'UAH');
    const created = await api(page, 'POST', '/bank-accounts', {
      name: OWN_ACCOUNT,
      ibanUA: 'UA213223130000026007233566001',
      currencyId: uah?.id,
      bankName: 'E2E Банк',
      mfo: '322313',
    });
    expect(created.status, `POST /bank-accounts: ${JSON.stringify(created.body)}`).toBe(201);
    account = created.body!;
  }
  const org = await api(page, 'GET', '/settings/org-info');
  expect(org.status).toBe(200);
  const prevBankAccountId = (org.body?.bankAccountId as string | null) ?? null;
  const patched = await api(page, 'PATCH', '/settings/org-info', { bankAccountId: account.id });
  expect(patched.status, `PATCH /settings/org-info: ${JSON.stringify(patched.body)}`).toBe(200);

  // Наряд «Виконано» з роботою і рахунком.
  const cpId = items((await api(page, 'GET', '/counterparties?type=CLIENT&limit=1')).body)[0]?.id;
  const branchList = items((await api(page, 'GET', '/branches')).body);
  const branchId = (branchList.find(b => isV4(String(b.id))) ?? branchList[0])?.id;
  const garageId = items((await api(page, 'GET', `/counterparties/${cpId}/garages`)).body)[0]?.id;
  const vehicleId = items(
    (await api(page, 'GET', `/vehicles?customerGarageId=${garageId}&limit=1`)).body,
  )[0]?.id;
  const workId = items((await api(page, 'GET', '/works?limit=1')).body)[0]?.id;
  const employeeId = items(
    (await api(page, 'GET', '/employees?limit=1&role=MECHANIC&sortBy=createdAt&sortDir=asc')).body,
  )[0]?.id;
  expect(
    { cpId, branchId, vehicleId, workId, employeeId },
    'seed має містити клієнта з авто, філію, роботу і працівника',
  ).toEqual({
    cpId: expect.any(String),
    branchId: expect.any(String),
    vehicleId: expect.any(String),
    workId: expect.any(String),
    employeeId: expect.any(String),
  });

  const wo = await api(page, 'POST', '/work-orders', {
    counterpartyId: cpId,
    branchId,
    vehicleId,
    description: 'E2E друк наряд-замовлення',
  });
  expect(wo.status, `POST /work-orders: ${JSON.stringify(wo.body)}`).toBe(201);
  const woId = String(wo.body!.id);
  const line = await api(page, 'POST', `/work-orders/${woId}/lines`, {
    workId,
    employeeId,
    normoHours: 1,
    price: 100,
  });
  expect(line.status, `POST lines: ${JSON.stringify(line.body)}`).toBe(201);
  for (const status of ['ESTIMATE', 'APPROVED', 'IN_PROGRESS', 'COMPLETED']) {
    const t = await api(page, 'POST', `/work-orders/${woId}/transition`, { status });
    expect(t.status, `→ ${status}: ${JSON.stringify(t.body)}`).toBeLessThan(300);
  }
  const inv = await api(page, 'POST', `/invoices/from-work-order/${woId}`);
  expect(inv.status, `POST /invoices/from-work-order: ${JSON.stringify(inv.body)}`).toBe(201);

  return {
    woId,
    woNumber: String(wo.body!.number),
    invoiceId: String(inv.body!.id),
    prevBankAccountId,
  };
}

/**
 * Перехоплює відповіді на `pathEnd` і віддає браузеру без змін, запам'ятовуючи статус і перші
 * байти. `Response.body()` після того, як сторінка забрала тіло в Blob, Playwright віддає
 * порожнім — тому тіло читаємо на проході.
 */
async function capturePdf(page: Page, pathEnd: string) {
  const seen: Array<{ status: number; head: string }> = [];
  await page.route(
    url => url.pathname.endsWith(pathEnd),
    async route => {
      const res = await route.fetch();
      const body = await res.body();
      seen.push({ status: res.status(), head: body.subarray(0, 4).toString('latin1') });
      await route.fulfill({ response: res, body });
    },
  );
  return {
    /** Дочекатись однієї відповіді-PDF: 200 і тіло з `%PDF`. */
    expectPdf: async () => {
      await expect.poll(() => seen.length, { timeout: 30_000 }).toBeGreaterThan(0);
      expect(seen[0]).toEqual({ status: 200, head: '%PDF' });
      seen.length = 0;
    },
  };
}

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const p = await ctx.newPage();
  await p.goto('/work-orders');
  await expect(p.locator('h1:has-text("Наряди")')).toBeVisible({ timeout: 30_000 });
  fx = await setUp(p);
  await ctx.close();
});

test.afterAll(async ({ browser }) => {
  if (!fx) return;
  const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
  const p = await ctx.newPage();
  await p.goto('/work-orders');
  await expect(p.locator('h1:has-text("Наряди")')).toBeVisible({ timeout: 30_000 });
  // Чернетку рахунку видаляємо, наряд «Виконано» скасовуємо й видаляємо, основний рахунок
  // організації повертаємо.
  await api(p, 'DELETE', `/invoices/${fx.invoiceId}`);
  await api(p, 'POST', `/work-orders/${fx.woId}/transition`, { status: 'CANCELLED' });
  await api(p, 'DELETE', `/work-orders/${fx.woId}`);
  await api(p, 'PATCH', '/settings/org-info', { bankAccountId: fx.prevBankAccountId });
  await ctx.close();
});

test('картка наряду «Виконано»: «Друк наряду» відкриває вікно з PDF, «Зберегти PDF» — файл, «Друк рахунку» — PDF рахунку', async ({
  page,
}) => {
  expect(fx, 'beforeAll має створити наряд').toBeTruthy();
  const { woId, woNumber, invoiceId } = fx!;
  // Панель вимкнено: клік по олівцю відкриває картку наряду.
  await page.addInitScript(() => {
    localStorage.setItem('sto_detail_panel_work-orders', 'false');
  });
  await page.goto('/work-orders');
  await expect(page.locator('h1:has-text("Наряди")')).toBeVisible({ timeout: 20_000 });
  await page.getByPlaceholder('Пошук за номером або клієнтом...').fill(woNumber);
  const row = page.locator(`table tbody tr:has-text("${woNumber}")`).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.hover();
  await row.getByTitle('Відкрити наряд').click();
  const card = page.getByRole('dialog').filter({ hasText: woNumber });
  const printOrder = card.getByRole('button', { name: 'Друк наряду' });
  await expect(printOrder).toBeVisible({ timeout: 15_000 });
  // Друк кошторису в «Виконано» не пропонується.
  await expect(card.getByRole('button', { name: 'Друк', exact: true })).toHaveCount(0);

  // «Друк наряду»: вікно відкривається, PDF наряду приходить.
  const orderPdf = await capturePdf(page, `/work-orders/${woId}/pdf`);
  const invoicePdf = await capturePdf(page, `/invoices/${invoiceId}/pdf`);
  const popup = page.waitForEvent('popup');
  await printOrder.click();
  await orderPdf.expectPdf();
  await (await popup).close();

  // «Зберегти PDF»: завантаження файла з номером наряду.
  const download = page.waitForEvent('download');
  await card.getByRole('button', { name: 'Зберегти PDF' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`work-order-${woNumber}.pdf`);
  const stream = await file.createReadStream();
  const head: Buffer = await new Promise((resolve, reject) => {
    stream.once('data', chunk => resolve(Buffer.from(chunk as Buffer)));
    stream.once('error', reject);
  });
  stream.destroy();
  expect(head.subarray(0, 4).toString('latin1')).toBe('%PDF');

  // «Друк рахунку»: рахунок наряду є — PDF рахунку приходить.
  const printInvoice = card.getByRole('button', { name: 'Друк рахунку' });
  await expect(printInvoice).toBeVisible({ timeout: 10_000 });
  const invoicePopup = page.waitForEvent('popup');
  await printInvoice.click();
  await invoicePdf.expectPdf();
  await (await invoicePopup).close();
});

test('сторінка наряду «Виконано»: «Друк наряду» і «Друк рахунку» отримують PDF', async ({
  page,
}) => {
  expect(fx, 'beforeAll має створити наряд').toBeTruthy();
  const { woId, invoiceId } = fx!;
  await page.goto(`/work-orders/${woId}`);
  const printOrder = page.getByRole('button', { name: 'Друк наряду' });
  await expect(printOrder).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Зберегти PDF' })).toBeVisible();

  const orderPdf = await capturePdf(page, `/work-orders/${woId}/pdf`);
  const invoicePdf = await capturePdf(page, `/invoices/${invoiceId}/pdf`);
  const popup = page.waitForEvent('popup');
  await printOrder.click();
  await orderPdf.expectPdf();
  await (await popup).close();

  const printInvoice = page.getByRole('button', { name: 'Друк рахунку' });
  await expect(printInvoice).toBeVisible({ timeout: 10_000 });
  const invoicePopup = page.waitForEvent('popup');
  await printInvoice.click();
  await invoicePdf.expectPdf();
  await (await invoicePopup).close();
});
