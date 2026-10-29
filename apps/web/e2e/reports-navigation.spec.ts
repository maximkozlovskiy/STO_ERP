import { test, expect, type Page } from '@playwright/test';
import { apiCall, apiRequest, getToken } from './api-helpers';
import { ensureVehicleModel } from './vehicle-directory';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/**
 * Звіти — зручність (огляд звітів 2026-10-29), через браузер:
 *  1. швидкий період «Минулий місяць» ставить у «З / По» перший і останній день минулого
 *     київського місяця, кнопка підсвічена;
 *  2. рядок механіка у звіті «Наряди» веде до його нарядів: сторінка нарядів із фільтром
 *     «Виконавець: …» і періодом звіту, наряд механіка в списку; «×» знімає фільтр.
 *
 * Наряд і робота з виконавцем — інтерфейсом (список нарядів → «Наряд», сторінка наряду →
 * «+ Робота»). Передумови через API: клієнт із гаражем і авто, категорія й робота каталогу.
 * Прибирання: наряд (чернетка) — видалення, далі робота, категорія, авто, гараж — до клієнта, клієнт.
 */

const uid = Date.now().toString().slice(-6);
const CLIENT = `000 E2E TST-RPTNAV ${uid}`;
const PLATE = `RN${uid.slice(-5)}`;
const WORK = `000 E2E TST-RPTNAV робота ${uid}`;
const KYIV_YMD = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' });

const state: {
  token?: string;
  categoryId?: string;
  workId?: string;
  cpId?: string;
  garageId?: string;
  vehicleId?: string;
  wo?: { id: string; number: string };
  mech?: { firstName: string; lastName: string };
} = {};

const api = async <T = unknown>(page: Page, method: string, path: string, body?: unknown) =>
  apiCall<T>(page, state.token ?? (await getToken(page)), method, path, body);

/** `YYYY-MM-DD` → як показує поле дати (`ДД.ММ.РРРР`). */
const shown = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.${ymd.slice(0, 4)}`;

test.describe('Звіти — швидкі періоди й переходи з рядків', () => {
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const page = await ctx.newPage();
    await page.goto('/work-orders');
    state.token = await getToken(page);

    const cp = await api<{ id: string }>(page, 'POST', '/counterparties', {
      type: 'CLIENT',
      companyName: CLIENT,
    });
    expect(cp.status, `клієнт: ${JSON.stringify(cp.body)}`).toBe(201);
    state.cpId = cp.body.id;
    const garage = await api<{ id: string }>(
      page,
      'POST',
      `/counterparties/${state.cpId}/garages`,
      {
        name: '000 E2E TST-RPTNAV гараж',
      },
    );
    expect(garage.status).toBe(201);
    state.garageId = garage.body.id;
    const vehicle = await api<{ id: string }>(page, 'POST', '/vehicles', {
      customerGarageId: state.garageId,
      ...(await ensureVehicleModel(
        (method, url, data) => api(page, method, url, data),
        'Toyota',
        'Corolla',
      )),
      licensePlate: PLATE,
    });
    expect(vehicle.status).toBe(201);
    state.vehicleId = vehicle.body.id;

    const category = await api<{ id: string }>(page, 'POST', '/work-categories', {
      name: `000 E2E TST-RPTNAV ${uid}`,
    });
    expect(category.status, `категорія робіт: ${JSON.stringify(category.body)}`).toBe(201);
    state.categoryId = category.body.id;
    const work = await api<{ id: string }>(page, 'POST', '/works', {
      categoryId: state.categoryId,
      name: WORK,
      normoHours: 1,
      price: 100,
    });
    expect(work.status, `робота: ${JSON.stringify(work.body)}`).toBe(201);
    state.workId = work.body.id;

    // Виконавець — найстаріший механік (не тимчасовий «000 TST …» іншого тесту).
    const mechs = await api<{ items: { firstName: string; lastName: string }[] }>(
      page,
      'GET',
      '/employees?limit=1&role=MECHANIC&sortBy=createdAt&sortDir=asc',
    );
    state.mech = mechs.body.items[0];
    expect(state.mech, 'у базі є механік').toBeTruthy();
    await ctx.close();
  });

  test.afterAll(async ({ request }) => {
    const token = state.token;
    if (!token) return;
    const del = async (path: string, what: string) => {
      const res = await apiRequest(request, token, 'DELETE', path);
      expect
        .soft([200, 204, 404], `DELETE ${what}: ${JSON.stringify(res.body)}`)
        .toContain(res.status);
    };
    if (state.wo) await del(`/work-orders/${state.wo.id}`, `наряду ${state.wo.number}`);
    if (state.workId) await del(`/works/${state.workId}`, 'роботи');
    if (state.categoryId) await del(`/work-categories/${state.categoryId}`, 'категорії робіт');
    if (state.vehicleId) await del(`/vehicles/${state.vehicleId}`, 'авто');
    // Гараж — до клієнта: гараж видаленого клієнта API вже не видаляє.
    if (state.garageId)
      await del(`/counterparties/${state.cpId}/garages/${state.garageId}`, 'гаража');
    if (state.cpId) await del(`/counterparties/${state.cpId}`, 'клієнта');
  });

  test('«Минулий місяць» ставить межі минулого київського місяця', async ({ page }) => {
    await page.goto('/reports?tab=revenue');
    const periods = page.getByTestId('report-quick-periods');
    await expect(periods).toBeVisible({ timeout: 20_000 });
    await periods.getByRole('button', { name: 'Минулий місяць' }).click();

    const today = KYIV_YMD.format(new Date());
    const y = Number(today.slice(0, 4));
    const m = Number(today.slice(5, 7));
    const py = m === 1 ? y - 1 : y;
    const pm = m === 1 ? 12 : m - 1;
    const last = new Date(Date.UTC(py, pm, 0)).getUTCDate();
    const mm = String(pm).padStart(2, '0');
    const dates = page.getByPlaceholder('ДД.ММ.РРРР');
    await expect(dates.nth(0)).toHaveValue(shown(`${py}-${mm}-01`));
    await expect(dates.nth(1)).toHaveValue(shown(`${py}-${mm}-${String(last).padStart(2, '0')}`));
    await expect(periods.getByRole('button', { name: 'Минулий місяць' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(periods.getByRole('button', { name: 'Рік' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  test('рядок механіка у звіті «Наряди» відкриває його наряди за період звіту', async ({
    page,
  }) => {
    // ── Наряд інтерфейсом: список нарядів → «Наряд» → клієнт, авто, опис ──
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
    await woModal.getByPlaceholder('Заміна масла, колодок...').fill(`000 E2E TST-RPTNAV ${uid}`);
    await woModal.getByRole('button', { name: 'Створити наряд' }).click();
    await expect(woModal).toBeHidden({ timeout: 20_000 });

    const list = await api<{ items: { id: string; number: string }[] }>(
      page,
      'GET',
      `/work-orders?counterpartyId=${state.cpId}&limit=5&sortBy=createdAt&sortDir=desc`,
    );
    expect(list.body.items, 'наряд створено').toHaveLength(1);
    state.wo = list.body.items[0]!;
    const card = page.getByRole('dialog').filter({ hasText: state.wo.number });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.getByRole('button', { name: 'Закрити' }).last().click();
    await expect(card).toBeHidden({ timeout: 10_000 });

    // ── Робота з виконавцем-механіком на сторінці наряду ──
    const mech = state.mech!;
    await page.goto(`/work-orders/${state.wo.id}`);
    await page.getByRole('button', { name: '+ Робота' }).click();
    const addLine = page.getByRole('dialog', { name: 'Додати роботу' });
    await expect(addLine).toBeVisible({ timeout: 10_000 });
    await addLine.getByPlaceholder('Пошук роботи...').fill(WORK);
    await page
      .getByRole('option', { name: new RegExp(WORK) })
      .first()
      .click();
    await expect(addLine.getByText(WORK, { exact: true })).toBeVisible();
    await addLine
      .locator('select')
      .first()
      .selectOption({ label: `${mech.lastName} ${mech.firstName}` });
    await addLine.locator('label', { hasText: 'Ціна' }).locator('..').locator('input').fill('100');
    await addLine.getByRole('button', { name: 'Додати', exact: true }).click();
    await expect(addLine).toBeHidden({ timeout: 15_000 });

    // ── Звіт «Наряди» за цей місяць → клік по рядку механіка ──
    await page.goto('/reports?tab=work-orders');
    const periods = page.getByTestId('report-quick-periods');
    await expect(periods).toBeVisible({ timeout: 20_000 });
    await periods.getByRole('button', { name: 'Цей місяць' }).click();
    const row = page.getByTestId('report-wo-row').filter({ hasText: mech.lastName }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();

    // ── Наряди з фільтром виконавця й періодом звіту ──
    await page.waitForURL(/\/work-orders\/?$/, { timeout: 20_000 });
    const chip = page.getByTestId('wo-executor-filter');
    await expect(chip).toContainText(mech.lastName, { timeout: 20_000 });
    const today = KYIV_YMD.format(new Date());
    const dates = page.getByPlaceholder('ДД.ММ.РРРР');
    await expect(dates.nth(0)).toHaveValue(shown(`${today.slice(0, 7)}-01`));
    await expect(dates.nth(1)).toHaveValue(shown(today));
    await expect(page.locator('tr').filter({ hasText: state.wo.number })).toHaveCount(1, {
      timeout: 20_000,
    });

    await chip.click();
    await expect(chip).toBeHidden();
  });
});
