import { test, expect, type Page } from '@playwright/test';
import { clearDateFilter } from './fixtures';

// Єдиний стандарт списків (рішення власника 2026-10-13):
//   1) клік по рядку: панель увімкнена → показує панель, повторний клік ховає; панель вимкнена →
//      відкриває документ; олівець і кнопка «Відкрити …» у панелі відкривають документ завжди;
//   2) у фільтрі дат кожну межу можна зняти кнопкою «Очистити дату»;
//   3) документ, позначений на видалення, відкривається карткою лише на перегляд.
//
// Unit-тести тримають правило по кожному списку; тут — наскрізна перевірка на живому застосунку.

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

const API = 'http://localhost:3000/api/v1';

async function api<T>(page: Page, method: string, path: string, body?: unknown): Promise<T> {
  // sessionStorage доступний лише після навігації на origin застосунку.
  const token = (await page.evaluate(() => sessionStorage.getItem('sto_access_token'))) ?? '';
  return page.evaluate(
    async ({ api, token, method, path, body }) => {
      const r = await fetch(`${api}${path}`, {
        method,
        // Content-Type лише з тілом: сервер відхиляє порожнє тіло з типом application/json.
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${text}`);
      return (text ? JSON.parse(text) : null) as T;
    },
    { api: API, token, method, path, body },
  );
}

/** Сторінка списку завантажена й авторизована (токен уже в sessionStorage). */
async function openForApi(page: Page, url: string, heading: string) {
  await page.goto(url);
  await expect(page.locator(`h1:has-text("${heading}")`)).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem('sto_access_token')), {
      timeout: 15_000,
    })
    .toBeTruthy();
}

const dialogs = (page: Page) => page.locator('[role="dialog"]');

// ─── 1. Рахунки: стандарт кліку по рядку ─────────────────────────────────────

test.describe('Рахунки — стандарт кліку по рядку', () => {
  let inv: { id: string; number: string } | null = null;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await openForApi(p, '/invoices', 'Рахунки');
    const cps = await api<{ items: { id: string }[] }>(
      p,
      'GET',
      '/counterparties?types=CLIENT,BOTH&limit=1',
    );
    const cpId = cps.items[0]?.id;
    expect(cpId, 'seed має містити клієнта').toBeTruthy();
    inv = await api(p, 'POST', '/invoices', { counterpartyId: cpId, amount: 150 });
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    if (!inv) return;
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await openForApi(p, '/invoices', 'Рахунки');
    await api(p, 'DELETE', `/invoices/${inv.id}`);
    await ctx.close();
  });

  async function gotoInvoices(page: Page, panelEnabled: boolean) {
    await page.addInitScript(enabled => {
      localStorage.setItem('sto_detail_panel_invoices', String(enabled));
    }, panelEnabled);
    await page.goto('/invoices');
    await expect(page.locator('h1:has-text("Рахунки")')).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByRole('button', {
        name: panelEnabled ? 'Сховати бокову панель' : 'Показати бокову панель',
      }),
    ).toBeVisible();
    await page.locator('input[placeholder*="Пошук"]').first().fill(inv!.number);
    const row = page.locator(`table tbody tr:has-text("${inv!.number}")`).first();
    await expect(row, 'рахунок, створений сьогодні, видно під типовим фільтром дат').toBeVisible({
      timeout: 15_000,
    });
    return row;
  }
  const panelTitle = (page: Page) => page.locator('h2', { hasText: inv!.number });
  // Кнопка панелі має видимий текст; олівець у рядку — лише title.
  const panelOpenBtn = (page: Page) => page.getByText('Відкрити документ', { exact: true });

  test('панель увімкнена: клік показує панель, повторний клік ховає; картка не відкривається', async ({
    page,
  }) => {
    expect(inv, 'beforeAll має створити рахунок').toBeTruthy();
    const row = await gotoInvoices(page, true);

    await row.getByText(inv!.number).first().click();
    await expect(panelTitle(page)).toBeVisible({ timeout: 10_000 });
    await expect(panelOpenBtn(page)).toBeVisible();
    await expect(row).toHaveClass(/bg-primary\/5/);
    await expect(dialogs(page)).toHaveCount(0);

    await row.getByText(inv!.number).first().click();
    await expect(panelOpenBtn(page)).toHaveCount(0, { timeout: 5_000 });
    await expect(row).not.toHaveClass(/bg-primary\/5/);
    await expect(dialogs(page)).toHaveCount(0);
  });

  test('кнопка «Відкрити документ» у панелі відкриває картку рахунку', async ({ page }) => {
    expect(inv, 'beforeAll має створити рахунок').toBeTruthy();
    const row = await gotoInvoices(page, true);

    await row.getByText(inv!.number).first().click();
    await panelOpenBtn(page).click();

    const card = dialogs(page).first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.locator('h2:has-text("Рахунок-фактура")')).toBeVisible();
    await expect(card).toContainText(inv!.number);
  });

  test('олівець відкриває картку і з увімкненою панеллю, рядок не вибирає', async ({ page }) => {
    expect(inv, 'beforeAll має створити рахунок').toBeTruthy();
    const row = await gotoInvoices(page, true);

    await row.hover();
    await row.getByTitle('Відкрити документ').click();

    const card = dialogs(page).first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText(inv!.number);
    await expect(panelOpenBtn(page)).toHaveCount(0);
    await expect(row).not.toHaveClass(/bg-primary\/5/);
  });

  test('панель вимкнена: клік по рядку одразу відкриває картку', async ({ page }) => {
    expect(inv, 'beforeAll має створити рахунок').toBeTruthy();
    const row = await gotoInvoices(page, false);

    await row.getByText(inv!.number).first().click();

    const card = dialogs(page).first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText(inv!.number);
    await expect(panelOpenBtn(page)).toHaveCount(0);
  });
});

// ─── 2. Фільтр дат: кнопка очищення ──────────────────────────────────────────

test.describe('Фільтр дат списку — кнопка «Очистити дату»', () => {
  test('рахунки: кожна межа знімається окремо, список перезапитується без неї', async ({
    page,
  }) => {
    await page.goto('/invoices');
    await expect(page.locator('h1:has-text("Рахунки")')).toBeVisible({ timeout: 20_000 });
    const from = page.getByLabel('З', { exact: true });
    const to = page.getByLabel('По', { exact: true });
    // Типовий фільтр — сьогодні в обох межах.
    await expect(from).toHaveValue(/^\d{2}\.\d{2}\.\d{4}$/);
    await expect(to).toHaveValue(/^\d{2}\.\d{2}\.\d{4}$/);
    const clear = page.getByRole('button', { name: 'Очистити дату' });
    await expect(clear).toHaveCount(2);

    // Знімаємо «З»: запит списку йде без dateFrom, але ще з dateTo.
    const withoutFrom = page.waitForRequest(r => {
      const u = new URL(r.url());
      return (
        u.pathname.endsWith('/invoices') &&
        !u.searchParams.has('dateFrom') &&
        u.searchParams.has('dateTo')
      );
    });
    await clear.first().click();
    await withoutFrom;
    await expect(from).toHaveValue('');
    await expect(from).toBeFocused();
    await expect(to).toHaveValue(/^\d{2}\.\d{2}\.\d{4}$/);
    // Очищення календар не відкриває.
    await expect(page.locator('.rdp-root')).toHaveCount(0);
    await expect(clear).toHaveCount(1);

    // Знімаємо «По»: запит без обох меж.
    const withoutBoth = page.waitForRequest(r => {
      const u = new URL(r.url());
      return (
        u.pathname.endsWith('/invoices') &&
        !u.searchParams.has('dateFrom') &&
        !u.searchParams.has('dateTo')
      );
    });
    await clear.first().click();
    await withoutBoth;
    await expect(to).toHaveValue('');
    await expect(clear).toHaveCount(0);
  });

  test('помічник clearDateFilter справді знімає обидві межі', async ({ page }) => {
    await page.goto('/work-orders');
    await expect(page.locator('h1:has-text("Наряди")')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByLabel('З', { exact: true })).toHaveValue(/^\d{2}\.\d{2}\.\d{4}$/);

    await clearDateFilter(page);

    await expect(page.getByLabel('З', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('По', { exact: true })).toHaveValue('');
  });
});

// ─── 3. Складський документ, позначений на видалення, — лише перегляд ────────

test.describe('Складський документ, позначений на видалення, — картка лише на перегляд', () => {
  let doc: { id: string; number: string } | null = null;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await openForApi(p, '/stock-documents', 'Склад');
    const whs = await api<{ id: string; branchId: string }[]>(p, 'GET', '/warehouses?limit=1');
    expect(whs[0], 'seed має містити склад').toBeTruthy();
    doc = await api(p, 'POST', '/stock-documents', {
      type: 'WRITEOFF',
      warehouseId: whs[0].id,
      branchId: whs[0].branchId,
      notes: 'E2E — видалений документ лише на перегляд',
    });
    // Позначаємо на видалення одразу: тест відкриває вже видалений документ.
    await api(p, 'DELETE', `/stock-documents/${doc!.id}`);
    await ctx.close();
  });
  // Прибирати нічого: документ уже позначено на видалення в beforeAll.

  test('олівець видаленого рядка відкриває картку зі смугою, без збереження й переходів', async ({
    page,
  }) => {
    expect(doc, 'beforeAll має створити й видалити документ').toBeTruthy();
    await page.addInitScript(() => {
      localStorage.setItem('sto_detail_panel_stock-documents', 'true');
    });
    await page.goto('/stock-documents');
    await expect(page.locator('h1:has-text("Склад")')).toBeVisible({ timeout: 20_000 });
    await page.getByTitle('Показати видалені').click();
    await page.getByPlaceholder('Пошук за номером або приміткою…').fill(doc!.number);
    const row = page.locator(`table tbody tr:has-text("${doc!.number}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText('видалено');

    await row.hover();
    await row.getByTitle('Відкрити документ').click();

    const card = dialogs(page).first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    // Документ завантажився (а не «не знайдено») і позначений як лише на перегляд.
    await expect(card).toContainText(doc!.number);
    const banner = card.getByRole('status').filter({ hasText: 'Документ позначено на видалення' });
    await expect(banner).toHaveText('Документ позначено на видалення — лише перегляд');
    await expect(card.getByRole('button', { name: 'Зберегти зміни' })).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Підтвердити', exact: true })).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Скасувати', exact: true })).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Додати', exact: true })).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'Імпорт XLSX' })).toHaveCount(0);
    await expect(card.getByPlaceholder('Додаткова інформація…')).toBeDisabled();
    // Друк і закриття лишаються.
    await expect(card.getByRole('button', { name: 'Друк' })).toBeVisible();
    await card.getByRole('button', { name: 'Закрити' }).last().click();
    await expect(dialogs(page)).toHaveCount(0, { timeout: 5_000 });
  });

  test('кнопка «Відкрити документ» у панелі видаленого рядка відкриває ту саму картку', async ({
    page,
  }) => {
    expect(doc, 'beforeAll має створити й видалити документ').toBeTruthy();
    await page.addInitScript(() => {
      localStorage.setItem('sto_detail_panel_stock-documents', 'true');
    });
    await page.goto('/stock-documents');
    await expect(page.locator('h1:has-text("Склад")')).toBeVisible({ timeout: 20_000 });
    await page.getByTitle('Показати видалені').click();
    await page.getByPlaceholder('Пошук за номером або приміткою…').fill(doc!.number);
    const row = page.locator(`table tbody tr:has-text("${doc!.number}")`).first();
    await expect(row).toBeVisible({ timeout: 15_000 });

    await row.locator('td').nth(1).click();
    await page.getByText('Відкрити документ', { exact: true }).click();

    const card = dialogs(page).first();
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText(doc!.number);
    await expect(
      card.getByRole('status').filter({ hasText: 'Документ позначено на видалення' }),
    ).toBeVisible();
  });
});

// ─── 4. Сторінка наряду: серверного друку для чернетки й видаленого немає ──────
//
// BR-WO-013: наряд-замовлення («Друк наряду», «Зберегти PDF») друкується лише від «Виконано» —
// у чернетки цих кнопок немає. Видалити можна лише чернетку чи скасований наряд, тож у
// видаленого їх теж немає; «Друк» (window.print) лишається завжди. Гейти кнопок (статус і
// видалений наряд) стереже компонентний тест `WorkOrderPrintButtons.test.tsx`, друк від
// «Виконано» — `work-order-print.spec.ts`.

test.describe('Сторінка наряду, позначеного на видалення, — без серверного друку', () => {
  let wo: { id: string; number: string } | null = null;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await openForApi(p, '/work-orders', 'Наряди');
    const branches = await api<{ id: string }[]>(p, 'GET', '/branches');
    const cps = await api<{ items: { id: string }[] }>(
      p,
      'GET',
      '/counterparties?type=CLIENT&limit=20',
    );
    // Наряд потребує авто клієнта: беремо першого клієнта, у якого воно є.
    for (const cp of cps.items) {
      const garages = await api<{ id: string }[]>(p, 'GET', `/counterparties/${cp.id}/garages`);
      if (!garages[0]) continue;
      const vehicles = await api<{ id: string }[] | { items: { id: string }[] }>(
        p,
        'GET',
        `/vehicles?customerGarageId=${garages[0].id}&limit=1`,
      );
      const vehicleId = (Array.isArray(vehicles) ? vehicles : vehicles.items)[0]?.id;
      if (!vehicleId) continue;
      wo = await api(p, 'POST', '/work-orders', {
        counterpartyId: cp.id,
        branchId: branches[0]!.id,
        vehicleId,
        description: 'E2E — сторінка видаленого наряду без PDF',
      });
      break;
    }
    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    if (!wo) return;
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const p = await ctx.newPage();
    await openForApi(p, '/work-orders', 'Наряди');
    // Якщо тест упав до видалення — прибираємо; уже видалений дає 404, і це не помилка.
    await api(p, 'DELETE', `/work-orders/${wo.id}`).catch(() => undefined);
    await ctx.close();
  });

  test('чернетка: «Друк» є, наряд-замовлення немає; після видалення — смуга, «Друк» є', async ({
    page,
  }) => {
    expect(wo, 'beforeAll має створити наряд (у seed є клієнт з авто)').toBeTruthy();
    const pdf = page.getByRole('button', { name: /^(Друк наряду|Зберегти PDF)$/ });
    const print = page.getByRole('button', { name: 'Друк', exact: true });
    const banner = page.getByTestId('deleted-document-banner');

    await page.goto(`/work-orders/${wo!.id}`);
    await expect(page.locator(`h1:has-text("${wo!.number}")`)).toBeVisible({ timeout: 30_000 });
    await expect(print).toBeVisible();
    await expect(pdf).toHaveCount(0);
    await expect(banner).toHaveCount(0);

    await api(page, 'DELETE', `/work-orders/${wo!.id}`);
    await page.reload();

    await expect(page.locator(`h1:has-text("${wo!.number}")`)).toBeVisible({ timeout: 30_000 });
    await expect(banner).toHaveText('Документ позначено на видалення — лише перегляд');
    await expect(print).toBeVisible();
    await expect(pdf).toHaveCount(0);
    // Зникають усі дії, що змінюють наряд.
    for (const name of ['Редагувати', 'Дублювати', 'Скасувати', '+ Робота', '+ Запчастина']) {
      await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
    }
  });
});
