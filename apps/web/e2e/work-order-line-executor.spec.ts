import { test, expect, type Page } from '@playwright/test';
import { apiCall, apiRequest, getToken } from './api-helpers';
import { createEmployeeViaUi } from './employee-ui';
import { ensureVehicleModel } from './vehicle-directory';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/**
 * BR-WO-030 (рішення власника 2026-10-22): виконавець нової роботи наряду — механік запису
 * календаря, інакше єдиний механік підйомника наряду. Тут — гілка «запису немає, на підйомнику
 * рівно один механік»: свій підйомник, за яким закріплено лише тестового механіка.
 *
 * Через інтерфейс: механік (сторінка «Співробітники», закріплення за підйомником), наряд із
 * підйомником, робота в картці наряду («Додати») і у вікні «+ Робота» на сторінці наряду. Передумови
 * через API — підйомник, робота, клієнт з авто. Прибирання: наряд, механік, підйомник, робота,
 * авто → гараж → клієнт.
 */

// pid воркера: паралельні повтори (--repeat-each) в одну секунду інакше давали однакові назви
// підйомника й механіка — і два чекбокси з тим самим підписом у формі співробітника.
const uid = `${Date.now().toString().slice(-6)}${process.pid % 1000}`;
const PREFIX = `000 E2E TST-EXE ${uid}`;
const CLIENT = `${PREFIX} клієнт`;
const LIFT = `${PREFIX} підйомник`;
const WORK = `${PREFIX} робота`;
const MECH_LAST = `${PREFIX} механік`;
const PLATE = `EX${uid.slice(-5)}`;

const state: {
  token?: string;
  liftId?: string;
  workId?: string;
  employeeId?: string;
  cpId?: string;
  garageId?: string;
  vehicleId?: string;
  woId?: string;
  woNumber?: string;
} = {};

async function api<T = unknown>(page: Page, method: string, path: string, body?: unknown) {
  return apiCall<T>(page, state.token ?? (await getToken(page)), method, path, body);
}

test.describe('Виконавець нової роботи — механік підйомника (BR-WO-030)', () => {
  test.afterAll(async ({ request }) => {
    const token = state.token;
    if (!token) return;
    // Наряд — першим: механіка з рядком живого наряду сервер не видаляє.
    if (state.woId) {
      const res = await apiRequest(request, token, 'DELETE', `/work-orders/${state.woId}`);
      expect.soft([200, 204, 404], 'DELETE наряду').toContain(res.status);
    }
    if (state.employeeId) {
      const res = await apiRequest(request, token, 'DELETE', `/employees/${state.employeeId}`);
      expect.soft(res.status, 'DELETE механіка').toBeLessThan(300);
    }
    if (state.liftId) {
      const res = await apiRequest(request, token, 'DELETE', `/lifts/${state.liftId}`);
      expect.soft(res.status, 'DELETE підйомника').toBeLessThan(300);
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
  });

  // guards: BR-WO-030
  test('підйомник з одним механіком: «Додати» роботу й «+ Робота» — виконавець підставився', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await page.goto('/work-orders');
    await expect(page.getByRole('button', { name: /^Наряд$/ }).first()).toBeVisible({
      timeout: 30_000,
    });
    state.token = await getToken(page);

    // ── Передумови через API: підйомник, робота, клієнт з авто ───────────
    const zones = await api<Array<{ id: string }> | { items: Array<{ id: string }> }>(
      page,
      'GET',
      '/zones',
    );
    const zoneList = Array.isArray(zones.body) ? zones.body : zones.body.items;
    expect(zoneList.length, 'в організації є зона').toBeGreaterThan(0);
    const lift = await api<{ id: string }>(page, 'POST', '/lifts', {
      zoneId: zoneList[0]!.id,
      name: LIFT,
      type: 'TWO_POST',
    });
    expect(lift.status, JSON.stringify(lift.body)).toBe(201);
    state.liftId = lift.body.id;

    const cats = await api<Array<{ id: string }> | { items: Array<{ id: string }> }>(
      page,
      'GET',
      '/work-categories',
    );
    const catList = Array.isArray(cats.body) ? cats.body : cats.body.items;
    expect(catList.length, 'є категорія робіт').toBeGreaterThan(0);
    const work = await api<{ id: string }>(page, 'POST', '/works', {
      categoryId: catList[0]!.id,
      name: WORK,
      normoHours: 1.5,
      price: 600,
    });
    expect(work.status, JSON.stringify(work.body)).toBe(201);
    state.workId = work.body.id;

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

    // ── Механік, закріплений за підйомником, — сторінкою «Співробітники» ─
    await createEmployeeViaUi(page, {
      onCreated: id => {
        state.employeeId = id;
      },
      firstName: 'Тест',
      lastName: MECH_LAST,
      liftNames: [LIFT],
    });
    const onLift = await api<{ items: Array<{ id: string }> }>(
      page,
      'GET',
      `/employees?liftId=${state.liftId}&role=MECHANIC&limit=200`,
    );
    expect(
      onLift.body.items.map(m => m.id),
      'на підйомнику рівно один механік',
    ).toEqual([state.employeeId]);

    // ── Наряд із підйомником — через інтерфейс ──────────────────────────
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
    const liftSelect = woModal.getByTestId('wo-lift').locator('select');
    await expect(liftSelect.locator('option', { hasText: LIFT })).toHaveCount(1, {
      timeout: 15_000,
    });
    await liftSelect.selectOption(state.liftId);
    await woModal.getByPlaceholder('Заміна масла, колодок...').fill('000 E2E виконавець роботи');
    await woModal.getByRole('button', { name: 'Створити наряд' }).click();
    await expect(woModal).toBeHidden({ timeout: 20_000 });

    const list = await api<{ items: Array<{ id: string; number: string }> }>(
      page,
      'GET',
      `/work-orders?counterpartyId=${state.cpId}&limit=1&sortBy=createdAt&sortDir=desc`,
    );
    state.woId = list.body.items[0]!.id;
    state.woNumber = list.body.items[0]!.number;
    const card = page.getByRole('dialog').filter({ hasText: state.woNumber });
    await expect(card).toBeVisible({ timeout: 20_000 });

    // ── Картка: «Додати» роботу пошуком → виконавець — механік підйомника ─
    const works = card.getByTestId('wo-works-section');
    await works.getByRole('button', { name: 'Додати', exact: true }).click();
    const inputRow = card.locator('tr', { has: page.getByTitle('Зберегти рядок') });
    await inputRow.getByRole('combobox', { name: 'Робота' }).fill(WORK);
    await page
      .getByRole('option', { name: new RegExp(WORK) })
      .first()
      .click();
    const executor = inputRow.getByRole('combobox', { name: 'Виконавець' });
    await expect(executor).toHaveValue(state.employeeId!, { timeout: 15_000 });
    await inputRow.screenshot({ path: test.info().outputPath('wo030_card_row.png') });
    await inputRow.getByTitle('Зберегти рядок').click();
    await card.getByRole('button', { name: 'Зберегти зміни' }).click();
    await expect(card).toBeHidden({ timeout: 20_000 });
    const fresh = await api<{ lines: Array<{ workId: string; employeeId: string }> }>(
      page,
      'GET',
      `/work-orders/${state.woId}`,
    );
    expect(fresh.body.lines).toEqual([
      expect.objectContaining({ workId: state.workId, employeeId: state.employeeId }),
    ]);

    // ── «+ Робота» на сторінці наряду: той самий механік ─────────────────
    await page.goto(`/work-orders/${state.woId}`);
    await page.getByRole('button', { name: '+ Робота' }).click();
    const addModal = page.getByRole('dialog').filter({ hasText: 'Додати роботу' });
    await expect(addModal).toBeVisible({ timeout: 15_000 });
    // Робота — пошуком на сервері (довідник більший за 200 робіт), виконавець — список.
    await addModal.getByPlaceholder('Пошук роботи...').fill(WORK);
    await page
      .getByRole('option', { name: new RegExp(WORK) })
      .first()
      .click();
    await expect(addModal.getByText(WORK, { exact: true })).toBeVisible();
    const executorSelect = addModal.locator('select').first();
    await expect(executorSelect).toHaveValue(state.employeeId!, { timeout: 15_000 });
    await addModal.screenshot({ path: test.info().outputPath('wo030_add_line.png') });
    await page.keyboard.press('Escape');
  });
});
