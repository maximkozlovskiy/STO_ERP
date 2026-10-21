import { test, expect, type Page } from '@playwright/test';
import { apiCall, apiRequest, getToken } from './api-helpers';

/**
 * Стек шарів Escape (техборг §15.12): кожен Escape закриває рівно ОДИН верхній шар — вікно вибору,
 * меню, діалог, картку, запит «Є незбережені зміни», — а вікно під ним лишається з усім введеним.
 *
 * У браузері React рендерить між слухачами однієї події, тож колишні прапорці «вкладене відкрито»
 * в jsdom не відтворювались (GOTCHAS 2026-10-12) — ця поведінка перевіряється лише тут.
 *
 * Наряд створюється через UI; клієнт, авто й товар (довідники) — через API.
 */

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

const uid = Date.now().toString().slice(-6);
const CLIENT = `000 E2E Escape клієнт ${uid}`;
const PLATE = `ES${uid.slice(-5)}`;
const GOOD = `000 E2E Escape фільтр ${uid}`;

const state: {
  token?: string;
  cpId?: string;
  garageId?: string;
  vehicleId?: string;
  goodId?: string;
  warehouse?: { id: string; name: string };
  wo?: { id: string; number: string };
} = {};

async function api<T = unknown>(page: Page, method: string, path: string, body?: unknown) {
  return apiCall<T>(page, state.token!, method, path, body);
}

const dirtyPrompt = (page: Page) =>
  page.getByRole('dialog').filter({ hasText: 'Є незбережені зміни' });

async function openNewWorkOrder(page: Page) {
  await page.goto('/work-orders');
  await page
    .getByRole('button', { name: /^Наряд$/ })
    .first()
    .click();
  const card = page.getByRole('dialog').filter({ hasText: 'Новий наряд' });
  await expect(card).toBeVisible({ timeout: 20_000 });
  return card;
}

async function openWoCard(page: Page, number: string) {
  await page.goto('/work-orders');
  const row = page.locator('table tbody tr', { hasText: number }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.hover();
  await row.getByTitle('Відкрити наряд').click();
  const card = page.getByRole('dialog').filter({ hasText: number });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText(GOOD).first()).toBeVisible({ timeout: 20_000 });
  return card;
}

test.describe('Escape у вкладених вікнах закриває лише верхнє', () => {
  test.afterAll(async ({ request }) => {
    const token = state.token;
    if (!token) return;
    if (state.wo) {
      const del = await apiRequest(request, token, 'DELETE', `/work-orders/${state.wo.id}`);
      expect.soft([200, 204, 404], `DELETE наряду ${state.wo.number}`).toContain(del.status);
    }
    if (state.goodId) {
      const res = await apiRequest(request, token, 'DELETE', `/goods/${state.goodId}`);
      expect.soft(res.status, 'DELETE товару').toBeLessThan(300);
    }
    if (state.vehicleId) {
      const res = await apiRequest(request, token, 'DELETE', `/vehicles/${state.vehicleId}`);
      expect.soft(res.status, 'DELETE авто').toBeLessThan(300);
    }
    if (state.garageId) {
      const res = await apiRequest(
        request,
        token,
        'DELETE',
        `/counterparties/${state.cpId}/garages/${state.garageId}`,
      );
      expect.soft(res.status, 'DELETE гаража').toBeLessThan(300);
    }
    if (state.cpId) {
      const res = await apiRequest(request, token, 'DELETE', `/counterparties/${state.cpId}`);
      expect.soft(res.status, 'DELETE клієнта').toBeLessThan(300);
    }
  });

  test('новий наряд: вибір клієнта, потім запит «Є незбережені зміни» — по одному шару', async ({
    page,
  }) => {
    const card = await openNewWorkOrder(page);
    const description = card.getByPlaceholder('Заміна масла, колодок...');
    await description.fill('000 E2E Escape — не зберігати');

    await card.getByRole('button', { name: 'Обрати' }).first().click();
    const picker = page.getByRole('dialog', { name: 'Оберіть клієнта' });
    await expect(picker).toBeVisible({ timeout: 10_000 });
    await picker.getByRole('textbox').first().fill('000 E2E');

    await page.keyboard.press('Escape');
    await expect(picker).toBeHidden();
    await expect(dirtyPrompt(page)).toBeHidden();
    await expect(card).toBeVisible();
    await expect(description).toHaveValue('000 E2E Escape — не зберігати');

    // Картка з уведеним — запит; Escape у запиті закриває лише його.
    await page.keyboard.press('Escape');
    await expect(dirtyPrompt(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dirtyPrompt(page)).toBeHidden();
    await expect(card).toBeVisible();
    await expect(description).toHaveValue('000 E2E Escape — не зберігати');

    await page.keyboard.press('Escape');
    await dirtyPrompt(page).getByRole('button', { name: 'Покинути' }).click();
    await expect(card).toBeHidden();
  });

  test('картка наряду: меню статусу й «До списку купівлі» закриваються окремо від картки', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.goto('/work-orders');
    state.token = await getToken(page);

    const cp = await api<{ id: string }>(page, 'POST', '/counterparties', {
      type: 'CLIENT',
      companyName: CLIENT,
    });
    expect(cp.status).toBe(201);
    state.cpId = cp.body.id;
    const garage = await api<{ id: string }>(
      page,
      'POST',
      `/counterparties/${state.cpId}/garages`,
      {
        name: '000 E2E Escape гараж',
      },
    );
    expect(garage.status).toBe(201);
    state.garageId = garage.body.id;
    const vehicle = await api<{ id: string }>(page, 'POST', '/vehicles', {
      customerGarageId: garage.body.id,
      make: 'Toyota',
      model: 'Corolla',
      licensePlate: PLATE,
    });
    expect(vehicle.status).toBe(201);
    state.vehicleId = vehicle.body.id;
    const good = await api<{ id: string }>(page, 'POST', '/goods', {
      name: GOOD,
      sku: `E2E-ESC-${uid}`,
      salePrice: 300,
      purchasePrice: 120,
    });
    expect(good.status).toBe(201);
    state.goodId = good.body.id;
    const warehouses = await api<Array<{ id: string; name: string; isMain: boolean }>>(
      page,
      'GET',
      '/warehouses',
    );
    state.warehouse = warehouses.body.find(w => w.isMain) ?? warehouses.body[0];

    // Наряд через UI: клієнт, авто, опис → «Створити наряд», у картці — рядок товару без залишку.
    const newCard = await openNewWorkOrder(page);
    await newCard.getByRole('combobox', { name: 'Клієнт' }).fill(CLIENT);
    await page.getByRole('option', { name: new RegExp(CLIENT) }).click();
    const vehicleSelect = newCard
      .locator('label', { hasText: 'Автомобіль' })
      .locator('..')
      .locator('select');
    await expect(vehicleSelect.locator('option', { hasText: PLATE })).toHaveCount(1, {
      timeout: 10_000,
    });
    await vehicleSelect.selectOption({ label: `Toyota Corolla (${PLATE})` });
    await newCard.getByPlaceholder('Заміна масла, колодок...').fill('000 E2E Escape — наряд');
    await newCard.getByRole('button', { name: 'Створити наряд' }).click();
    await expect(newCard).toBeHidden({ timeout: 20_000 });
    const list = await api<{ items: Array<{ id: string; number: string }> }>(
      page,
      'GET',
      `/work-orders?counterpartyId=${state.cpId}&limit=1&sortBy=createdAt&sortDir=desc`,
    );
    state.wo = list.body.items[0]!;
    const created = page.getByRole('dialog').filter({ hasText: state.wo.number });
    await expect(created).toBeVisible({ timeout: 20_000 });
    await created.getByRole('button', { name: 'Додати' }).last().click();
    await created.getByRole('combobox', { name: 'Товар' }).last().fill(GOOD);
    await page
      .getByRole('option', { name: new RegExp(GOOD) })
      .first()
      .click();
    const inputRow = created.locator('tr', { has: page.getByTitle('Зберегти рядок') });
    await inputRow.locator('select').first().selectOption({ label: state.warehouse!.name });
    await inputRow.getByPlaceholder('0').first().fill('1');
    await inputRow.getByTitle('Зберегти рядок').click();
    await created.getByRole('button', { name: 'Зберегти зміни' }).click();
    await expect(created).toBeHidden({ timeout: 20_000 });

    // Меню статусу — шар над карткою.
    const card = await openWoCard(page, state.wo.number);
    await card.getByRole('button', { name: 'Чернетка', exact: true }).click();
    const statusMenu = card
      .locator('div.absolute.top-full')
      .filter({ has: page.locator('button') });
    await expect(statusMenu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(statusMenu).toBeHidden();
    await expect(card).toBeVisible();

    // «До списку купівлі» (діалог над карткою): Escape закриває лише діалог.
    await card.getByRole('button', { name: 'До списку купівлі' }).click();
    const addToList = page.getByRole('dialog').filter({ hasText: 'Куди додати' });
    await expect(addToList.getByLabel(`Кількість для ${GOOD}`)).toHaveValue('1');
    await page.keyboard.press('Escape');
    await expect(addToList).toBeHidden();
    await expect(card).toBeVisible();

    // Нічого не змінено — наступний Escape закриває саму картку, без запиту.
    await page.keyboard.press('Escape');
    await expect(card).toBeHidden();
    await expect(dirtyPrompt(page)).toBeHidden();
  });

  test('сторінка наряду: «+ Запчастина» → картка товару — кожен Escape знімає один шар', async ({
    page,
  }) => {
    test.skip(!state.wo, 'наряд не створено попереднім тестом');
    await page.goto(`/work-orders/${state.wo!.id}`);
    await page.getByRole('button', { name: '+ Запчастина' }).click();
    const addPart = page.getByRole('dialog', { name: 'Додати запчастину' });
    await expect(addPart).toBeVisible({ timeout: 20_000 });
    await addPart.getByPlaceholder('Назва, артикул, штрих-код...').fill(GOOD);
    await page
      .getByRole('option', { name: new RegExp(GOOD) })
      .first()
      .click();

    await addPart.getByRole('button', { name: 'Відкрити картку' }).click();
    const goodCard = page.getByRole('dialog', { name: 'Редагування товару' });
    await expect(goodCard).toBeVisible({ timeout: 20_000 });

    await page.keyboard.press('Escape');
    await expect(goodCard).toBeHidden();
    await expect(addPart).toBeVisible();
    await expect(dirtyPrompt(page)).toBeHidden();

    // Обраний товар — незбережена зміна: запит, і Escape у ньому закриває лише запит.
    await page.keyboard.press('Escape');
    await expect(dirtyPrompt(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dirtyPrompt(page)).toBeHidden();
    await expect(addPart).toBeVisible();

    await page.keyboard.press('Escape');
    await dirtyPrompt(page).getByRole('button', { name: 'Покинути' }).click();
    await expect(addPart).toBeHidden();
    const parts = await api<{ parts: unknown[] }>(page, 'GET', `/work-orders/${state.wo!.id}`);
    expect(parts.body.parts).toHaveLength(1);
  });
});
