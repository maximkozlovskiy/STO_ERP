import { test, expect, type Page } from '@playwright/test';
import { apiCall, apiRequest, getToken } from './api-helpers';
import { ensureVehicleModel } from './vehicle-directory';
import { createEmployeeViaUi } from './employee-ui';
import { loginViaForm } from './fixtures';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/**
 * «Зберегти як послугу» (BR-WO-036, docs/objects/work-order.md), через браузер:
 *  1. наряд А з роботою (3 год при нормі 1,5) і товаром (2 шт) — створено й заповнено в інтерфейсі;
 *  2. сторінка наряду А → «Зберегти як послугу» → послуга з роботою ×2 і товаром 2 шт, без ціни;
 *  3. новий наряд Б → «Послуга» → та сама робота на 3 год і той самий товар 2 шт у картці;
 *  4. приймальня (створена на сторінці «Співробітники») кнопки на сторінці наряду не бачить
 *     (`POST /services` — лише OWNER / ADMIN), на 390 px кнопка власника в межах екрана.
 * Передумови через API — робота, товар, клієнт з авто. Прибирання: наряди, послуга, товар, робота,
 * авто → гараж → клієнт, приймальня.
 */

const uid = `${Date.now().toString().slice(-6)}${process.pid % 1000}`;
const PREFIX = `000 E2E TST-SVC ${uid}`;
const CLIENT = `${PREFIX} клієнт`;
const WORK = `${PREFIX} робота`;
const GOOD = `${PREFIX} товар`;
const SERVICE = `${PREFIX} послуга`;
const PLATE = `SV${uid.slice(-5)}`;
// Пароль — лише в пам'яті прогону.
const RECEPTION_LOGIN = {
  email: `e2e-tst-svc-rec-${uid}@sto.local`,
  password: `E2e-${Math.random().toString(36).slice(2, 10)}`,
};

const state: {
  token?: string;
  workId?: string;
  goodId?: string;
  mechanicId?: string;
  warehouseId?: string;
  cpId?: string;
  garageId?: string;
  vehicleId?: string;
  woIds: string[];
  serviceId?: string;
  receptionId?: string;
} = { woIds: [] };

async function api<T = unknown>(page: Page, method: string, path: string, body?: unknown) {
  return apiCall<T>(page, state.token ?? (await getToken(page)), method, path, body);
}

/** Новий наряд клієнта тесту через «Наряд» → картка наряду відкрита. */
async function createWo(page: Page, description: string) {
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
  await woModal.getByPlaceholder('Заміна масла, колодок...').fill(description);
  await woModal.getByRole('button', { name: 'Створити наряд' }).click();
  await expect(woModal).toBeHidden({ timeout: 20_000 });
  const list = await api<{ items: Array<{ id: string; number: string }> }>(
    page,
    'GET',
    `/work-orders?counterpartyId=${state.cpId}&limit=1&sortBy=createdAt&sortDir=desc`,
  );
  const wo = list.body.items[0]!;
  state.woIds.push(wo.id);
  const card = page.getByRole('dialog').filter({ hasText: wo.number });
  await expect(card).toBeVisible({ timeout: 20_000 });
  return { ...wo, card };
}

test.describe('«Зберегти як послугу» → «Послуга» в новому наряді (BR-WO-036)', () => {
  test.afterAll(async ({ request }) => {
    const token = state.token;
    if (!token) return;
    for (const id of state.woIds) {
      const res = await apiRequest(request, token, 'DELETE', `/work-orders/${id}`);
      expect.soft([200, 204, 404], 'DELETE наряду').toContain(res.status);
    }
    if (state.serviceId) {
      const res = await apiRequest(request, token, 'DELETE', `/services/${state.serviceId}`);
      expect.soft(res.status, 'DELETE послуги').toBeLessThan(300);
    }
    if (state.goodId) {
      const res = await apiRequest(request, token, 'DELETE', `/goods/${state.goodId}`);
      expect.soft(res.status, 'DELETE товару').toBeLessThan(300);
    }
    if (state.workId) {
      const res = await apiRequest(request, token, 'DELETE', `/works/${state.workId}`);
      expect.soft(res.status, 'DELETE роботи').toBeLessThan(300);
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
    if (state.receptionId) {
      const res = await apiRequest(request, token, 'DELETE', `/employees/${state.receptionId}`);
      expect.soft(res.status, 'DELETE приймальні').toBeLessThan(300);
    }
  });

  // guards: BR-WO-036
  test('наряд → «Зберегти як послугу» → новий наряд «Послуга» додає ті самі роботу й товар', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await page.goto('/work-orders');
    await expect(page.getByRole('button', { name: /^Наряд$/ }).first()).toBeVisible({
      timeout: 30_000,
    });
    state.token = await getToken(page);

    // ── Передумови через API ─────────────────────────────────────────────
    const cats = await api<Array<{ id: string }> | { items: Array<{ id: string }> }>(
      page,
      'GET',
      '/work-categories',
    );
    const catList = Array.isArray(cats.body) ? cats.body : cats.body.items;
    const work = await api<{ id: string }>(page, 'POST', '/works', {
      categoryId: catList[0]!.id,
      name: WORK,
      normoHours: 1.5,
      price: 600,
    });
    expect(work.status, JSON.stringify(work.body)).toBe(201);
    state.workId = work.body.id;
    const good = await api<{ id: string }>(page, 'POST', '/goods', {
      name: GOOD,
      sku: `E2E-SVC-${uid}`,
      salePrice: 200,
    });
    expect(good.status, JSON.stringify(good.body)).toBe(201);
    state.goodId = good.body.id;
    const mechanics = await api<{ items: Array<{ id: string }> }>(
      page,
      'GET',
      '/employees?role=MECHANIC&sortBy=createdAt&sortDir=asc&limit=1',
    );
    state.mechanicId = mechanics.body.items[0]!.id;
    const warehouses = await api<Array<{ id: string; isMain: boolean }>>(
      page,
      'GET',
      '/warehouses',
    );
    state.warehouseId = (warehouses.body.find(w => w.isMain) ?? warehouses.body[0])!.id;
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
      { name: '000 E2E гараж' },
    );
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

    // ── Наряд А: робота 3 год (норма 1,5) і товар 2 шт — через картку ────
    const woA = await createWo(page, '000 E2E послуга — наряд А');
    const works = woA.card.getByTestId('wo-works-section');
    await works.getByRole('button', { name: 'Додати', exact: true }).click();
    const workRow = woA.card.locator('tr', { has: page.getByTitle('Зберегти рядок') });
    await workRow.getByRole('combobox', { name: 'Робота' }).fill(WORK);
    await page
      .getByRole('option', { name: new RegExp(WORK) })
      .first()
      .click();
    await workRow.getByRole('combobox', { name: 'Виконавець' }).selectOption(state.mechanicId);
    await workRow.getByPlaceholder('0').first().fill('3');
    await workRow.getByTitle('Зберегти рядок').click();

    await woA.card.getByRole('button', { name: 'Додати' }).last().click();
    await woA.card.getByRole('combobox', { name: 'Товар' }).last().fill(GOOD);
    await page
      .getByRole('option', { name: new RegExp(GOOD) })
      .first()
      .click();
    const partRow = woA.card.locator('tr', { has: page.getByTitle('Зберегти рядок') });
    await partRow.locator('select').first().selectOption(state.warehouseId);
    await partRow.getByPlaceholder('0').first().fill('2');
    await partRow.getByTitle('Зберегти рядок').click();
    await woA.card.getByRole('button', { name: 'Зберегти зміни' }).click();
    await expect(woA.card).toBeHidden({ timeout: 20_000 });
    const savedA = await api<{
      lines: Array<{ workId: string; normoHours: number }>;
      parts: Array<{ goodId: string; quantity: number }>;
    }>(page, 'GET', `/work-orders/${woA.id}`);
    expect(savedA.body.lines).toEqual([
      expect.objectContaining({ workId: state.workId, normoHours: 3 }),
    ]);
    expect(savedA.body.parts).toEqual([
      expect.objectContaining({ goodId: state.goodId, quantity: 2 }),
    ]);

    // ── Сторінка наряду А → «Зберегти як послугу» ────────────────────────
    await page.goto(`/work-orders/${woA.id}`);
    await page.getByRole('button', { name: 'Зберегти як послугу' }).click();
    const dialog = page.getByRole('dialog').filter({ hasText: 'Назва послуги' });
    await expect(dialog.getByLabel('Назва послуги')).toHaveValue(`Наряд ${woA.number}`);
    await dialog.getByLabel('Назва послуги').fill(SERVICE);
    await dialog.screenshot({ path: test.info().outputPath('svc_e2e_dialog.png') });
    await dialog.getByRole('button', { name: 'Зберегти', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText(`Послугу «${SERVICE}» збережено`)).toBeVisible({
      timeout: 10_000,
    });

    const services = await api<{
      items: Array<{
        id: string;
        name: string;
        description: string | null;
        price: number | null;
        works: Array<{ workId: string; quantity: number }>;
        goods: Array<{ goodId: string; quantity: number }>;
      }>;
    }>(page, 'GET', `/services?q=${encodeURIComponent(SERVICE)}`);
    expect(services.body.items).toHaveLength(1);
    const svc = services.body.items[0]!;
    state.serviceId = svc.id;
    expect(svc).toMatchObject({
      description: `Створено з наряду ${woA.number}`,
      price: null,
      works: [expect.objectContaining({ workId: state.workId, quantity: 2 })],
      goods: [expect.objectContaining({ goodId: state.goodId, quantity: 2 })],
    });

    // Посилання з повідомлення — каталог послуг, відфільтрований на нову послугу.
    await page.getByRole('button', { name: 'Відкрити в каталозі' }).click();
    await expect(page).toHaveURL(/\/catalog\/?\?tab=services&q=/);
    await expect(page.getByText(SERVICE).first()).toBeVisible({ timeout: 30_000 });

    // ── Наряд Б: «Послуга» → та сама робота (3 год) і товар (2 шт) ───────
    const woB = await createWo(page, '000 E2E послуга — наряд Б');
    await woB.card.getByTestId('wo-works-section').getByRole('button', { name: 'Послуга' }).click();
    const picker = page.getByRole('dialog').filter({ hasText: 'Оберіть комплексну послугу' });
    await picker.getByPlaceholder('Пошук послуги...').fill(SERVICE);
    await picker.getByRole('button', { name: new RegExp(SERVICE) }).click();
    await expect(picker).toBeHidden({ timeout: 10_000 });
    const appliedWork = woB.card.getByTestId('wo-works-section').locator('tr', { hasText: WORK });
    await expect(appliedWork).toBeVisible({ timeout: 15_000 });
    await expect(appliedWork.locator('td').nth(2)).toHaveText('3');
    const appliedPart = woB.card.locator('tr', { hasText: GOOD });
    await expect(appliedPart).toBeVisible();
    await expect(appliedPart).toContainText('2');
    await woB.card.screenshot({ path: test.info().outputPath('svc_e2e_applied.png') });
  });

  // guards: BR-WO-036
  test('приймальня кнопки не бачить; у власника на 390 px кнопка в межах екрана', async ({
    page,
    browser,
  }) => {
    test.setTimeout(150_000);
    const woA = state.woIds[0]!;
    await createEmployeeViaUi(page, {
      onCreated: id => {
        state.receptionId = id;
      },
      firstName: 'Приймальня',
      lastName: `${PREFIX} приймальня`,
      role: 'RECEPTIONIST',
      login: RECEPTION_LOGIN,
    });
    const { ctx, page: rp } = await loginViaForm(browser, RECEPTION_LOGIN);
    await rp.goto(`/work-orders/${woA}`);
    await expect(rp.getByRole('button', { name: 'Дублювати' })).toBeVisible({ timeout: 30_000 });
    await expect(rp.getByRole('button', { name: 'Зберегти як послугу' })).toHaveCount(0);
    await ctx.close();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/work-orders/${woA}`);
    const button = page.getByRole('button', { name: 'Зберегти як послугу' });
    await expect(button).toBeVisible({ timeout: 30_000 });
    const box = (await button.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await button.click();
    const dialog = page.getByRole('dialog').filter({ hasText: 'Назва послуги' });
    await expect(dialog.getByRole('button', { name: 'Зберегти', exact: true })).toBeInViewport();
    // Знімок — після анімації появи вікна (лише для звіту, перевірки вище).
    await page.waitForTimeout(400);
    await page.screenshot({ path: test.info().outputPath('svc_e2e_390.png') });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});
