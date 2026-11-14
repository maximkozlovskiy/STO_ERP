import { test, expect, type Locator, type Page } from '@playwright/test';
import { apiCall, apiRequest, getToken } from './api-helpers';
import { ensureVehicleModel } from './vehicle-directory';

// Вище за типові 720 px: попап пікера відкривається лише вниз (як у work-order-days-off).
test.use({ storageState: 'e2e/.auth/admin.json', viewport: { width: 1280, height: 960 } });
test.describe.configure({ mode: 'serial' });

/**
 * Філія наряду — філія його підйомника (BR-WO-040; рішення власника 2026-11-14, TECH-DEBT (б) №95),
 * через браузер: у картці нового наряду підйомник іншої філії ставить її в поле «Філія» з
 * підказкою, автокінець за нормогодинами — за її днями й годинами, а збережений наряд і його запис
 * календаря — у цій філії й за її днями.
 *
 * Наряд — через інтерфейс (список нарядів → «Наряд»). Передумови через API: друга філія (типові
 * налаштування — пн–пт 09:00–18:00, BR-CAL-017), її зона й підйомник, клієнт і авто. Дата — перша
 * п'ятниця наступного місяця: залишок запису переходить на понеділок, а не на суботу.
 */

const uid = Date.now().toString().slice(-6);
const CLIENT = `000 E2E Філія підйомника ${uid}`;
const BRANCH = `000 E2E Філія ${uid}`;
const LIFT = `000 E2E П-філія ${uid}`;
const PLATE = `LB${uid.slice(-5)}`;
const DAY_MS = 86_400_000;

const ymdOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const dmy = (ymd: string) => ymd.split('-').reverse().join('.');
const kyivYmd = (iso: string) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(new Date(iso));
const kyivHHMM = (iso: string) =>
  new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));

/** Перша п'ятниця наступного місяця і понеділок після неї, 'YYYY-MM-DD'. */
function friMon(): [string, string] {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(new Date());
  const [y, m] = today.split('-').map(Number) as [number, number];
  let t = Date.UTC(y, m, 1); // m — 1-based, тож це 1-ше число наступного місяця
  while (new Date(t).getUTCDay() !== 5) t += DAY_MS;
  return [ymdOf(t), ymdOf(t + 3 * DAY_MS)];
}

interface SlotDto {
  id: string;
  workOrderId?: string | null;
  liftId?: string | null;
  startAt: string;
  endAt: string;
}

const state: {
  token?: string;
  branchId?: string;
  zoneId?: string;
  liftId?: string;
  cpId?: string;
  garageId?: string;
  vehicleId?: string;
  woId?: string;
} = {};

async function api<T = unknown>(page: Page, method: string, path: string, body?: unknown) {
  return apiCall<T>(page, state.token ?? (await getToken(page)), method, path, body);
}

const field = (scope: Locator, label: string) =>
  scope.locator('label', { hasText: label }).first().locator('..').locator('input');

test.describe('Філія наряду з підйомника — BR-WO-040 (№95)', () => {
  test.afterAll(async ({ request }) => {
    const token = state.token;
    if (!token) return;
    const del = async (path: string, what: string) => {
      const res = await apiRequest(request, token, 'DELETE', path);
      expect.soft([200, 204, 404], `DELETE ${what}`).toContain(res.status);
    };
    // Наряд (DRAFT) — разом із записами календаря (BR-WO-017); далі авто → гараж → клієнт;
    // підйомник → зона → філія.
    if (state.woId) await del(`/work-orders/${state.woId}`, 'наряду');
    if (state.vehicleId) await del(`/vehicles/${state.vehicleId}`, 'авто');
    if (state.garageId)
      await del(`/counterparties/${state.cpId}/garages/${state.garageId}`, 'гаража');
    if (state.cpId) await del(`/counterparties/${state.cpId}`, 'клієнта');
    if (state.liftId) await del(`/lifts/${state.liftId}`, 'підйомника');
    if (state.zoneId) await del(`/zones/${state.zoneId}`, 'зони');
    if (state.branchId) await del(`/branches/${state.branchId}`, 'філії');
  });

  // guards: BR-WO-040
  test('картка: підйомник іншої філії — її філія, підказка, запис за її днями', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const [fri, mon] = friMon();
    await page.goto('/work-orders');
    await expect(page.getByRole('button', { name: /^Наряд$/ }).first()).toBeVisible({
      timeout: 30_000,
    });
    state.token = await getToken(page);

    // ── Передумови через API: філія, зона, підйомник; клієнт, гараж, авто ──
    const branch = await api<{ id: string }>(page, 'POST', '/branches', {
      name: BRANCH,
      address: '000 E2E адреса',
    });
    expect(branch.status).toBe(201);
    state.branchId = branch.body.id;
    const settings = await api<{ workDays: number[] }>(
      page,
      'GET',
      `/settings/branch/${state.branchId}`,
    );
    expect(settings.body.workDays, 'нова філія — пн–пт (BR-CAL-017)').toEqual([1, 2, 3, 4, 5]);
    const zone = await api<{ id: string }>(page, 'POST', '/zones', {
      branchId: state.branchId,
      name: `000 E2E Зона ${uid}`,
      type: 'MECHANICAL',
    });
    expect(zone.status).toBe(201);
    state.zoneId = zone.body.id;
    const lift = await api<{ id: string }>(page, 'POST', '/lifts', {
      zoneId: state.zoneId,
      name: LIFT,
      type: 'TWO_POST',
    });
    expect(lift.status).toBe(201);
    state.liftId = lift.body.id;
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

    // ── Наряд — через інтерфейс ───────────────────────────────────────────
    await page.reload();
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
    const branchSelect = woModal.getByLabel(/^Філія/);
    const before = await branchSelect.inputValue();
    expect(before, 'картка відкрилась з іншою філією').not.toBe(state.branchId);

    // BR-WO-040: підйомник іншої філії — «Філія» стає його філією, з підказкою.
    await woModal.getByLabel('Підйомник').selectOption({ label: LIFT });
    await expect(branchSelect).toHaveValue(state.branchId!);
    await expect(woModal.getByTestId('wo-branch-from-lift')).toHaveText(
      `Філію змінено на філію підйомника «${BRANCH}»`,
    );

    // Пт 17:00 + 3 нормогодини: години й дні нової філії (09–18, пн–пт) — до пн 11:00.
    await field(woModal, 'Дата та час початку').click();
    const popup = page
      .locator('div.shadow-lg')
      .filter({ has: page.getByRole('button', { name: 'Готово' }) });
    await expect(popup).toBeVisible({ timeout: 5_000 });
    await popup.getByRole('button', { name: /next|наступн/i }).click();
    await popup.locator(`[data-day="${fri}"] button`).click();
    await popup.getByLabel('Година').selectOption('17');
    await popup.getByLabel('Хвилини').selectOption('00');
    await popup.getByRole('button', { name: 'Готово' }).click();
    await expect(popup).toBeHidden();
    await field(woModal, 'Нормогодин').fill('3');
    await expect(field(woModal, 'Дата та час завершення')).toHaveValue(`${dmy(mon)} 11:00`);
    await page.screenshot({ path: test.info().outputPath('lift_branch_card.png') });
    await woModal
      .getByPlaceholder('Заміна масла, колодок...')
      .fill('000 E2E наряд філії підйомника');
    await woModal.getByRole('button', { name: 'Створити наряд' }).click();
    await expect(woModal).toBeHidden({ timeout: 20_000 });

    const list = await api<{ items: { id: string; number: string; branchId: string }[] }>(
      page,
      'GET',
      `/work-orders?counterpartyId=${state.cpId}&limit=5`,
    );
    expect(list.body.items).toHaveLength(1);
    state.woId = list.body.items[0]!.id;
    expect(list.body.items[0]!.branchId).toBe(state.branchId);
    const woCard = page.getByRole('dialog').filter({ hasText: list.body.items[0]!.number });
    await expect(woCard).toBeVisible({ timeout: 20_000 });
    await expect(woCard.getByLabel(/^Філія/)).toHaveValue(state.branchId!);
    await woCard.getByRole('button', { name: 'Закрити' }).last().click();
    await expect(woCard).toBeHidden({ timeout: 10_000 });

    // ── Запис календаря наряду — пт до закриття філії й пн від відкриття, без суботи ──
    const slots = (await api<SlotDto[]>(page, 'GET', `/calendar/slots?from=${fri}&to=${mon}`)).body
      .filter(s => s.workOrderId === state.woId)
      .sort((a, b) => a.startAt.localeCompare(b.startAt));
    expect(
      slots.map(s => [s.liftId, kyivYmd(s.startAt), kyivHHMM(s.startAt), kyivHHMM(s.endAt)]),
    ).toEqual([
      [state.liftId, fri, '17:00', '18:00'],
      [state.liftId, mon, '09:00', '11:00'],
    ]);
  });
});
