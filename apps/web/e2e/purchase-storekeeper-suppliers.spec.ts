import { test, expect, type Browser, type Page, type Response } from '@playwright/test';
import { apiCall, apiRequest, getToken } from './api-helpers';
import { createEmployeeViaUi } from './employee-ui';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/**
 * BR-CP-014 — комірник читає постачальників (рішення власника 2026-10-18), через браузер:
 *  1. комірник створює список купівлі й ручну позицію, у «Позиції» → «Постачальник і ціна» обирає
 *     постачальника — позиція отримує його, без жодного 403;
 *  2. у картці замовлення постачальнику шукає постачальника — другим рядком ЄДРПОУ, «Відкрити
 *     картку» недоступна;
 *  3. у відповідях `GET /counterparties` комірнику — лише постачальники й лише поля вибору (клієнта
 *     тесту, телефонів, e-mail, балансу немає).
 *
 * За правилом власника документи — через інтерфейс (список купівлі й позиція — комірником).
 * Комірник (працівник із входом) — сторінкою «Співробітники» (рішення власника 2026-10-19);
 * постачальник і клієнт — передумови через API; товар — наявний.
 */

const uid = Date.now().toString().slice(-6);
const TAG = `000 E2E Комірник ${uid}`;
const SUPPLIER = `${TAG} Постачальник`;
const CLIENT = `${TAG} Клієнт`;
const EDRPOU = `9${uid}9`;
// Пароль — лише в пам'яті прогону.
const LOGIN = {
  email: `e2e-store-${uid}@sto.local`,
  password: `E2e-${Math.random().toString(36).slice(2, 10)}`,
};
const ALLOWED_FIELDS = ['companyName', 'edrpou', 'firstName', 'id', 'lastName', 'type'];

const state: {
  token?: string;
  supplierId?: string;
  clientId?: string;
  employeeId?: string;
  good?: { id: string; name: string };
  listId?: string;
  listNumber?: string;
} = {};

async function api<T = unknown>(page: Page, method: string, path: string, body?: unknown) {
  return apiCall<T>(page, state.token ?? (await getToken(page)), method, path, body);
}

async function loginAs(browser: Browser) {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(LOGIN.email);
  await page.getByLabel('Пароль').fill(LOGIN.password);
  await page.getByRole('button', { name: 'Увійти' }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
  return { ctx, page };
}

/** Стежить за мережею комірника: 403 і тіла `GET /counterparties` (списків). */
function watch(page: Page) {
  const forbidden: string[] = [];
  const lists: Record<string, unknown>[] = [];
  page.on('response', (r: Response) => {
    const url = r.url();
    if (r.status() === 403) forbidden.push(`${r.request().method()} ${url}`);
    if (/\/api\/v1\/counterparties(\?|$)/.test(url) && r.status() === 200) {
      void r
        .json()
        .then((b: { items?: Record<string, unknown>[] }) => lists.push(...(b.items ?? [])))
        .catch(() => {});
    }
  });
  return { forbidden, lists };
}

test.describe('Комірник обирає постачальника — BR-CP-014', () => {
  test.afterAll(async ({ request }) => {
    const token = state.token;
    if (!token) return;
    const del = async (path: string, label: string) => {
      const res = await apiRequest(request, token, 'DELETE', path);
      expect.soft([200, 204, 404], label).toContain(res.status);
    };
    if (state.listId) {
      // Позиція — OPEN, тож список можна скасувати й видалити.
      await apiRequest(request, token, 'POST', `/purchase-lists/${state.listId}/cancel`);
      await del(`/purchase-lists/${state.listId}`, 'DELETE списку');
    }
    if (state.employeeId) await del(`/employees/${state.employeeId}`, 'DELETE комірника');
    if (state.supplierId) await del(`/counterparties/${state.supplierId}`, 'DELETE постачальника');
    if (state.clientId) await del(`/counterparties/${state.clientId}`, 'DELETE клієнта');
  });

  test('передумови: постачальник, клієнт, комірник із входом, наявний товар', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/purchase-orders');
    await expect(page.locator('h1:has-text("Купівля")')).toBeVisible({ timeout: 30_000 });
    state.token = await getToken(page);

    const supplier = await api<{ id: string }>(page, 'POST', '/counterparties', {
      type: 'SUPPLIER',
      companyName: SUPPLIER,
      edrpou: EDRPOU,
      phone: '+380671112233',
    });
    expect(supplier.status, JSON.stringify(supplier.body)).toBe(201);
    state.supplierId = supplier.body.id;
    const client = await api<{ id: string }>(page, 'POST', '/counterparties', {
      type: 'CLIENT',
      companyName: CLIENT,
      phone: '+380671112244',
    });
    expect(client.status).toBe(201);
    state.clientId = client.body.id;
    // Комірник із входом — формою «Новий співробітник».
    await createEmployeeViaUi(page, {
      onCreated: id => {
        state.employeeId = id;
      },
      firstName: 'Комірник',
      lastName: TAG,
      role: 'STOREKEEPER',
      login: LOGIN,
    });
    const goods = await api<{ items: { id: string; name: string }[] }>(
      page,
      'GET',
      '/goods?limit=1',
    );
    expect(goods.body.items.length, 'потрібен хоч один товар').toBeGreaterThan(0);
    state.good = goods.body.items[0];
  });

  // guards: BR-CP-014
  test('комірник: список і позиція через інтерфейс, «Постачальник і ціна» — постачальник обраний', async ({
    page,
    browser,
  }) => {
    test.setTimeout(180_000);
    test.skip(!state.employeeId, 'передумов немає');
    // Сторінка адміністратора — лише для перевірок через API.
    await page.goto('/purchase-orders');
    const { ctx, page: sp } = await loginAs(browser);
    const net = watch(sp);

    // ── Список купівлі й ручна позиція ─────────────────────────────────────
    await sp.goto('/purchase-orders?tab=procurement&view=lists');
    await sp.getByRole('button', { name: 'Новий список' }).first().click();
    const create = sp.getByRole('dialog').filter({ hasText: 'Новий список' });
    await expect(create).toBeVisible({ timeout: 15_000 });
    await create.locator('input').first().fill(TAG);
    await create.getByRole('button', { name: 'Новий список' }).click();
    const detail = sp.getByRole('dialog').filter({ hasText: 'Список купівлі' });
    await expect(detail).toBeVisible({ timeout: 15_000 });
    const lists = await api<{ items: { id: string; number: string }[] }>(
      page,
      'GET',
      `/purchase-lists?q=${encodeURIComponent(TAG)}&limit=5`,
    );
    expect(lists.body.items).toHaveLength(1);
    state.listId = lists.body.items[0].id;
    state.listNumber = lists.body.items[0].number;

    await detail.getByRole('button', { name: 'Додати позицію' }).click();
    // Фільтр — за полем кількості: поле пошуку товару після вибору стає підписом.
    const add = sp.getByRole('dialog').filter({ hasText: 'Кількість (базові од.)' });
    await expect(add).toBeVisible({ timeout: 10_000 });
    await add.getByPlaceholder('Пошук товару...').fill(state.good!.name.slice(0, 20));
    await sp
      .getByRole('option', {
        name: new RegExp(state.good!.name.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      })
      .first()
      .click();
    await add.getByRole('button', { name: 'Додати позицію' }).click();
    await expect(add).toBeHidden({ timeout: 15_000 });
    await expect(detail.getByText(state.good!.name).first()).toBeVisible({ timeout: 15_000 });
    await sp.keyboard.press('Escape');

    // ── «Позиції» → «Постачальник і ціна» ──────────────────────────────────
    await sp.goto('/purchase-orders?tab=procurement&view=items');
    const listFilter = sp.getByRole('combobox', { name: 'Список' });
    await expect(listFilter.locator('option', { hasText: state.listNumber! })).toHaveCount(1, {
      timeout: 15_000,
    });
    await listFilter.selectOption({ label: state.listNumber! });
    const supplierFilter = sp.getByRole('combobox', { name: 'Постачальник' }).first();
    await expect(supplierFilter.locator('option', { hasText: SUPPLIER })).toHaveCount(1, {
      timeout: 15_000,
    });
    await expect(supplierFilter.locator('option', { hasText: CLIENT })).toHaveCount(0);
    await sp.getByLabel(`Вибрати ${state.good!.name}`).first().check();
    await sp.getByRole('button', { name: /Постачальник і ціна/ }).click();
    const dialog = sp.getByRole('dialog').filter({ hasText: 'Постачальник і ціна' });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await dialog.getByRole('combobox', { name: 'Постачальник' }).selectOption({ label: SUPPLIER });
    await expect(dialog.getByText(/недоступний для вашої ролі/)).toHaveCount(0);
    await sp.screenshot({ path: test.info().outputPath('cp14_items_supplier_dialog.png') });
    await dialog.getByRole('button', { name: 'Зберегти' }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect
      .poll(
        async () =>
          (
            await api<{ items: { supplierId: string | null }[] }>(
              page,
              'GET',
              `/purchase-list-items?listId=${state.listId}&limit=10`,
            )
          ).body.items.map(i => i.supplierId),
        { timeout: 15_000 },
      )
      .toEqual([state.supplierId]);
    await expect(sp.locator('table tbody tr', { hasText: SUPPLIER }).first()).toBeVisible({
      timeout: 15_000,
    });
    await sp.screenshot({ path: test.info().outputPath('cp14_items_supplier_set.png') });

    expect(net.forbidden, 'запити з 403 під комірником').toEqual([]);
    expect(net.lists.length, 'комірник отримав постачальників').toBeGreaterThan(0);
    for (const cp of net.lists) {
      expect(Object.keys(cp).sort()).toEqual(ALLOWED_FIELDS);
      expect(['SUPPLIER', 'BOTH']).toContain(cp.type);
    }
    expect(net.lists.find(cp => cp.id === state.clientId)).toBeUndefined();
    await ctx.close();
  });

  // guards: BR-CP-014
  test('комірник: картка замовлення — пошук постачальника з ЄДРПОУ, без 403', async ({
    browser,
  }) => {
    test.setTimeout(150_000);
    test.skip(!state.employeeId, 'передумов немає');
    const { ctx, page: sp } = await loginAs(browser);
    const net = watch(sp);
    await sp.goto('/purchase-orders');
    await sp
      .getByRole('button', { name: /^Замовлення$/ })
      .first()
      .click();
    const modal = sp.getByRole('dialog').filter({ hasText: 'Нове замовлення' });
    await expect(modal).toBeVisible({ timeout: 15_000 });
    const input = modal.getByPlaceholder('Пошук постачальника…');
    await input.fill(uid);
    const option = sp.getByRole('option', { name: new RegExp(SUPPLIER) });
    await expect(option).toBeVisible({ timeout: 15_000 });
    await expect(option).toContainText(EDRPOU);
    await sp.screenshot({ path: test.info().outputPath('cp14_po_supplier_search.png') });
    await option.click();
    const field = modal.locator('div', { has: sp.getByText(SUPPLIER, { exact: true }) }).last();
    await expect(field).toBeVisible({ timeout: 10_000 });
    await expect(field.getByRole('button', { name: 'Відкрити картку' })).toBeDisabled();

    expect(net.forbidden, 'запити з 403 під комірником').toEqual([]);
    for (const cp of net.lists) expect(Object.keys(cp).sort()).toEqual(ALLOWED_FIELDS);
    expect(net.lists.find(cp => cp.id === state.supplierId)).toBeTruthy();
    await ctx.close();
  });
});
