import { test, expect, type Page } from '@playwright/test';
import { API } from './api-url';
import { clearDateFilter } from './fixtures';

// E2E для «Зведення по табличних частинах і виконавці в боковій панелі списків»
// (рішення власника 2026-10-13, BR-WO-009 / BR-WO-010):
//   1. Наряди — клік по рядку показує панель зі «Зведенням» (числа відповідають рядкам,
//      створеним через API) і з блоком «Виконавці».
//   2. Складські документи — нова бокова панель за стандартом списків: клік показує панель
//      зі зведенням; олівець відкриває документ; з вимкненою панеллю клік відкриває картку.
//
// Дані створюються через API у beforeAll і прибираються в afterAll.

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

async function apiCall(page: Page, method: string, path: string, body?: Record<string, unknown>) {
  const token = await page.evaluate(
    () =>
      sessionStorage.getItem('sto_access_token') ?? localStorage.getItem('sto_e2e_access_token'),
  );
  return page.evaluate(
    async ({ token, method, path, body, api }) => {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (body) headers['Content-Type'] = 'application/json';
      const r = await fetch(`${api}${path}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!r.ok) return { __error: r.status, body: await r.text().catch(() => '') };
      const text = await r.text();
      return text ? JSON.parse(text) : null;
    },
    { token, method, path, body: body ?? null, api: API },
  );
}

const first = (res: unknown): { id: string } | undefined => {
  const r = res as { items?: Array<{ id: string }> } | Array<{ id: string }> | null;
  return Array.isArray(r) ? r[0] : r?.items?.[0];
};
const isV4Uuid = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);

/** Блок «Зведення» відкритої панелі та сама панель (вміст вкладки). */
const summary = (page: Page) => page.getByTestId('lines-summary');
const dialog = (page: Page) => page.locator('[role="dialog"]');

// ─── 1. Наряди ────────────────────────────────────────────────────────────────

test.describe('Зведення в боковій панелі — наряди', () => {
  let wo: { id: string; number: string } | null = null;
  let executorName = '';

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/work-orders');
    await expect(p.locator('h1:has-text("Наряди")')).toBeVisible({ timeout: 30_000 });

    const cpId = first(await apiCall(p, 'GET', '/counterparties?type=CLIENT&limit=1'))?.id;
    const branches = await apiCall(p, 'GET', '/branches');
    const branchList: Array<{ id: string }> = Array.isArray(branches)
      ? branches
      : (branches?.items ?? []);
    const branchId = branchList.find(b => isV4Uuid(b.id))?.id ?? branchList[0]?.id;
    const garageId = first(await apiCall(p, 'GET', `/counterparties/${cpId}/garages`))?.id;
    const vehicleId = first(
      await apiCall(p, 'GET', `/vehicles?customerGarageId=${garageId}&limit=1`),
    )?.id;
    const workId = first(await apiCall(p, 'GET', '/works?limit=1'))?.id;
    const employeeId = first(
      await apiCall(p, 'GET', '/employees?limit=1&role=MECHANIC&sortBy=createdAt&sortDir=asc'),
    )?.id;
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

    const created = await apiCall(p, 'POST', '/work-orders', {
      counterpartyId: cpId,
      branchId,
      vehicleId,
      description: 'E2E lines-summary',
    });
    expect(created?.id, `POST /work-orders: ${JSON.stringify(created)}`).toBeTruthy();
    wo = { id: created.id, number: created.number };

    // Два рядки ТІЄЇ САМОЇ роботи на одного виконавця: 1,5 + 2 = 3,5 н-год.
    // Очікуване зведення: 2 позиції, 1 різна робота, 3,5 н-год; виконавець — 2 роботи, 3,5 н-год.
    for (const normoHours of [1.5, 2]) {
      const line = await apiCall(p, 'POST', `/work-orders/${wo.id}/lines`, {
        workId,
        employeeId,
        normoHours,
        price: 100,
      });
      expect(line && !line.__error, `POST lines: ${JSON.stringify(line)}`).toBeTruthy();
    }

    const apiSummary = await apiCall(p, 'GET', `/work-orders/${wo.id}/lines-summary`);
    expect(apiSummary.executors, 'ендпоінт зведення має повернути виконавця').toHaveLength(1);
    executorName = apiSummary.executors[0].name;
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    if (!wo) return;
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/work-orders');
    await expect(p.locator('h1:has-text("Наряди")')).toBeVisible({ timeout: 30_000 });
    await apiCall(p, 'DELETE', `/work-orders/${wo.id}`);
    await ctx.close();
  });

  test('клік по рядку → панель зі «Зведенням» (роботи, нормо-години) і виконавцем', async ({
    page,
  }) => {
    expect(wo, 'beforeAll має створити наряд').toBeTruthy();
    await page.addInitScript(() => {
      localStorage.setItem('sto_detail_panel_work-orders', 'true');
    });
    await page.goto('/work-orders');
    await expect(page.locator('h1:has-text("Наряди")')).toBeVisible({ timeout: 20_000 });
    await page.getByPlaceholder('Пошук за номером або клієнтом...').fill(wo!.number);

    const row = page.locator(`table tbody tr:has-text("${wo!.number}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.locator('td').nth(2).click();

    await expect(summary(page)).toBeVisible({ timeout: 10_000 });
    await expect(summary(page).getByText('Зведення', { exact: true })).toBeVisible();
    const works = page.getByTestId('lines-summary-works');
    await expect(works).toContainText('Роботи');
    await expect(works).toContainText('2 позиції · 3,5 н-год (різних робіт: 1)');
    // Товарів у наряді немає — порожня таблиця у зведення не потрапляє.
    await expect(page.getByTestId('lines-summary-goods')).toHaveCount(0);

    await expect(summary(page).getByText('Виконавці', { exact: true })).toBeVisible();
    const executors = page.getByTestId('lines-summary-executors');
    await expect(executors).toContainText('2 роботи · 3,5 н-год');
    expect(executorName, 'у seed-працівника є ім’я').not.toBe('');
    await expect(executors).toContainText(executorName);

    // Панель, а не картка: модалка наряду не відкрилась.
    await expect(dialog(page)).toHaveCount(0);
  });
});

// ─── 2. Складські документи ───────────────────────────────────────────────────

test.describe('Зведення в боковій панелі — складські документи', () => {
  let doc: { id: string; number: string } | null = null;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/stock-documents');
    await expect(p.locator('h1:has-text("Склад")')).toBeVisible({ timeout: 30_000 });

    const warehouses = await apiCall(p, 'GET', '/warehouses?limit=1');
    const wh = (Array.isArray(warehouses) ? warehouses[0] : warehouses?.items?.[0]) as
      { id: string; branchId?: string } | undefined;
    const branches = await apiCall(p, 'GET', '/branches');
    const branchId =
      wh?.branchId ?? (Array.isArray(branches) ? branches[0]?.id : branches?.items?.[0]?.id);
    const goodId = first(await apiCall(p, 'GET', '/goods?limit=1'))?.id;
    expect({ wh: wh?.id, branchId, goodId }, 'seed має містити склад, філію і товар').toEqual({
      wh: expect.any(String),
      branchId: expect.any(String),
      goodId: expect.any(String),
    });

    // Той самий товар у двох рядках: 2 + 1,5 = 3,5 од.; 1 найменування, 2 рядки.
    const created = await apiCall(p, 'POST', '/stock-documents', {
      type: 'RECEIPT',
      warehouseId: wh!.id,
      branchId,
      notes: 'E2E lines-summary',
      lines: [
        { goodId, quantity: 2, price: 100 },
        { goodId, quantity: 1.5, price: 100 },
      ],
    });
    expect(created?.id, `POST /stock-documents: ${JSON.stringify(created)}`).toBeTruthy();
    doc = { id: created.id, number: created.number };
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    if (!doc) return;
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await p.goto('/stock-documents');
    await expect(p.locator('h1:has-text("Склад")')).toBeVisible({ timeout: 30_000 });
    await apiCall(p, 'DELETE', `/stock-documents/${doc.id}`);
    await ctx.close();
  });

  async function gotoDocs(page: Page, panelEnabled: boolean) {
    await page.addInitScript(enabled => {
      localStorage.setItem('sto_detail_panel_stock-documents', String(enabled));
    }, panelEnabled);
    await page.goto('/stock-documents');
    await expect(page.locator('h1:has-text("Склад")')).toBeVisible({ timeout: 20_000 });
    await clearDateFilter(page);
    await page.getByPlaceholder('Пошук за номером або приміткою…').fill(doc!.number);
    const row = page.locator(`table tbody tr:has-text("${doc!.number}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    return row;
  }

  test('панель увімкнена: клік по рядку → панель зі зведенням, картка не відкривається', async ({
    page,
  }) => {
    expect(doc, 'beforeAll має створити документ').toBeTruthy();
    const row = await gotoDocs(page, true);
    await expect(page.getByRole('button', { name: 'Сховати бокову панель' })).toBeVisible();

    await row.locator('td').nth(1).click();

    await expect(summary(page)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('lines-summary-goods')).toContainText(
      '1 найменування · 3,5 од. · 2 рядки',
    );
    await expect(page.getByTestId('lines-summary-executors')).toHaveCount(0);
    // Заголовок панелі — номер документа; поля шапки — зі схеми.
    await expect(page.locator('h2', { hasText: doc!.number })).toBeVisible();
    const panel = summary(page).locator('xpath=..');
    await expect(panel.getByText('Склад-джерело')).toBeVisible();
    await expect(panel.getByText('Оприбуткування', { exact: true })).toBeVisible();
    await expect(panel.getByText('Чернетка', { exact: true })).toBeVisible();
    await expect(dialog(page)).toHaveCount(0);

    // «Відкрити документ» у панелі → картка редагування.
    await panel.getByRole('button', { name: 'Відкрити документ' }).click();
    await expect(dialog(page).first()).toBeVisible({ timeout: 10_000 });
    await expect(dialog(page).first()).toContainText(doc!.number);
  });

  test('олівець у рядку відкриває документ і з увімкненою панеллю', async ({ page }) => {
    expect(doc, 'beforeAll має створити документ').toBeTruthy();
    const row = await gotoDocs(page, true);

    await row.hover();
    await row.locator('button[title="Відкрити документ"]').click();

    await expect(dialog(page).first()).toBeVisible({ timeout: 10_000 });
    await expect(dialog(page).first()).toContainText(doc!.number);
    // Олівець не вибирає рядок у панель.
    await expect(summary(page)).toHaveCount(0);
  });

  test('панель вимкнена: клік по рядку одразу відкриває картку, панелі немає', async ({ page }) => {
    expect(doc, 'beforeAll має створити документ').toBeTruthy();
    const row = await gotoDocs(page, false);
    await expect(page.getByRole('button', { name: 'Показати бокову панель' })).toBeVisible();

    await row.locator('td').nth(1).click();

    await expect(dialog(page).first()).toBeVisible({ timeout: 10_000 });
    await expect(dialog(page).first()).toContainText(doc!.number);
    await expect(summary(page)).toHaveCount(0);
  });
});
