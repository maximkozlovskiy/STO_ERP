import { test, expect, type Page } from '@playwright/test';
import { apiCall, apiRequest, getToken } from './api-helpers';
import { ensureVehicleModel } from './vehicle-directory';

/**
 * Навігація (UX-огляд 2026-10-29, частина 3):
 *   · картка наряду — в адресі `?open=<id>`: посилання відкриває її, «Назад» у браузері закриває;
 *   · клік по номеру наряду в рядку відкриває картку (решта рядка — бічна панель, як раніше);
 *   · картки дашборду «В роботі» / «Очікують» ведуть у список зі статусами картки, без типового
 *     періоду «сьогодні».
 *
 * Наряд створюється через UI; клієнт і авто (довідники) — через API.
 */

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

const uid = Date.now().toString().slice(-6);
const CLIENT = `000 E2E Картка-адреса ${uid}`;
const PLATE = `UC${uid.slice(-5)}`;

const state: {
  token?: string;
  cpId?: string;
  garageId?: string;
  vehicleId?: string;
  wo?: { id: string; number: string };
} = {};

async function api<T = unknown>(page: Page, method: string, path: string, body?: unknown) {
  return apiCall<T>(page, state.token!, method, path, body);
}

const woCard = (page: Page) => page.getByRole('dialog').filter({ hasText: state.wo!.number });

test.describe('картка в адресі й переходи з дашборду', () => {
  test.afterAll(async ({ request }) => {
    const token = state.token;
    if (!token) return;
    if (state.wo) {
      const del = await apiRequest(request, token, 'DELETE', `/work-orders/${state.wo.id}`);
      expect.soft([200, 204, 404], `DELETE наряду ${state.wo.number}`).toContain(del.status);
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

  test('наряд через UI; клік по номеру — картка в адресі, «Назад» закриває картку', async ({
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
        name: '000 E2E Картка-адреса гараж',
      },
    );
    expect(garage.status).toBe(201);
    state.garageId = garage.body.id;
    const vehicle = await api<{ id: string }>(page, 'POST', '/vehicles', {
      customerGarageId: garage.body.id,
      ...(await ensureVehicleModel(
        (method, url, data) => api(page, method, url, data),
        'Toyota',
        'Corolla',
      )),
      licensePlate: PLATE,
    });
    expect(vehicle.status).toBe(201);
    state.vehicleId = vehicle.body.id;

    // Новий наряд — через форму.
    await page
      .getByRole('button', { name: /^Наряд$/ })
      .first()
      .click();
    const newCard = page.getByRole('dialog').filter({ hasText: 'Новий наряд' });
    await expect(newCard).toBeVisible({ timeout: 20_000 });
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
    await newCard.getByPlaceholder('Заміна масла, колодок...').fill('000 E2E картка в адресі');
    await newCard.getByRole('button', { name: 'Створити наряд' }).click();
    await expect(newCard).toBeHidden({ timeout: 20_000 });
    const list = await api<{ items: Array<{ id: string; number: string }> }>(
      page,
      'GET',
      `/work-orders?counterpartyId=${state.cpId}&limit=1&sortBy=createdAt&sortDir=desc`,
    );
    state.wo = list.body.items[0]!;

    // Створений наряд відкривається карткою — вона вже в адресі. Закриваємо й ідемо до списку.
    await expect(woCard(page)).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(new RegExp(`open=${state.wo.id}`));
    await page.keyboard.press('Escape');
    await expect(woCard(page)).toBeHidden();
    await expect(page).not.toHaveURL(/open=/);

    // Клік по номеру в рядку → картка, адреса з open; «Назад» → картки немає, сторінка та сама.
    const link = page.getByRole('link', { name: state.wo.number, exact: true });
    await expect(link).toBeVisible({ timeout: 30_000 });
    await link.click();
    await expect(woCard(page)).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(new RegExp(`/work-orders/?\\?(.*&)?open=${state.wo.id}`));
    await page.goBack();
    await expect(woCard(page)).toBeHidden({ timeout: 10_000 });
    await expect(page).toHaveURL(/\/work-orders\/?$/);
    await expect(link).toBeVisible();
  });

  // Рішення власника 2026-10-29: «Назад» при незбережених змінах питає, як і «×».
  test('змінене поле → «Назад» → запит «Є незбережені зміни»; «Скасувати» лишає картку з open', async ({
    page,
  }) => {
    test.skip(!state.wo, 'наряд не створено попереднім тестом');
    await page.goto('/work-orders');
    const link = page.getByRole('link', { name: state.wo!.number, exact: true });
    await expect(link).toBeVisible({ timeout: 30_000 });
    await link.click();
    const card = woCard(page);
    await expect(card).toBeVisible({ timeout: 30_000 });
    const description = card.getByPlaceholder('Заміна масла, колодок...');
    await expect(description).toBeVisible({ timeout: 20_000 });
    await description.fill('000 E2E картка в адресі — змінено, не зберігати');

    await page.goBack();
    const prompt = page.getByRole('dialog').filter({ hasText: 'Є незбережені зміни' });
    await expect(prompt).toBeVisible({ timeout: 10_000 });
    await expect(card).toBeVisible();
    await prompt.getByRole('button', { name: 'Скасувати' }).click();
    await expect(prompt).toBeHidden();
    await expect(card).toBeVisible();
    await expect(description).toHaveValue('000 E2E картка в адресі — змінено, не зберігати');
    await expect(page).toHaveURL(new RegExp(`open=${state.wo!.id}`));

    // «Покинути» — картка закривається одним кроком назад, сторінка списку та сама.
    await page.goBack();
    await prompt.getByRole('button', { name: 'Покинути' }).click();
    await expect(card).toBeHidden({ timeout: 10_000 });
    await expect(page).toHaveURL(/\/work-orders\/?$/);
    await expect(link).toBeVisible();
  });

  test('посилання ?open=<id> відкриває картку; закриття лишає на списку', async ({ page }) => {
    test.skip(!state.wo, 'наряд не створено попереднім тестом');
    await page.goto(`/work-orders?open=${state.wo!.id}`);
    await expect(woCard(page)).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press('Escape');
    await expect(woCard(page)).toBeHidden();
    await expect(page).toHaveURL(/\/work-orders\/?$/);
  });

  test('дашборд: «Очікують» → список зі статусами картки (наш чорновик у ньому), «В роботі» — інший набір', async ({
    page,
  }) => {
    test.skip(!state.wo, 'наряд не створено попереднім тестом');
    await page.goto('/dashboard');
    const listRequest = page.waitForRequest(
      r => r.url().includes('/work-orders?') && r.url().includes('statuses='),
    );
    await page.getByRole('link').filter({ hasText: 'Очікують' }).click();
    const req = new URL((await listRequest).url());
    expect(req.searchParams.get('statuses')).toBe('DRAFT,ESTIMATE,APPROVED');
    expect(req.searchParams.get('dateFrom')).toBeNull();
    await expect(page.getByTestId('wo-status-group-filter')).toHaveText(
      /Статус: Чернетка, Кошторис, Затверджено/,
    );
    await expect(page.getByRole('link', { name: state.wo!.number, exact: true })).toBeVisible({
      timeout: 30_000,
    });

    await page.goto('/dashboard');
    const inWork = page.waitForRequest(
      r => r.url().includes('/work-orders?') && r.url().includes('statuses='),
    );
    await page.getByRole('link').filter({ hasText: 'В роботі' }).click();
    expect(new URL((await inWork).url()).searchParams.get('statuses')).toBe('IN_PROGRESS,ON_HOLD');
    await expect(page.getByTestId('wo-status-group-filter')).toBeVisible();
    await expect(page.getByRole('link', { name: state.wo!.number, exact: true })).toHaveCount(0);
  });
});
