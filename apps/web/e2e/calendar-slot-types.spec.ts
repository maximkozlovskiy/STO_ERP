import { test, expect, type Locator, type Page } from '@playwright/test';
import { apiCall, apiRequest, getToken } from './api-helpers';
import { ensureVehicleModel } from './vehicle-directory';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/**
 * Тип запису календаря (BR-CAL-003, рішення власника 2026-10-21), через браузер і з нарядом:
 *  1. «+ Слот» → «Тип запису: Перерва»: клієнта й наряду у формі немає, запис зберігається без
 *     них; у виді «День» блок показує «Перерва» і примітку;
 *  2. наряд, запланований у списку нарядів на той самий підйомник і час, отримує конфлікт —
 *     попередження в картці й відмову сервера; одразу після перерви — створюється;
 *  3. перерва відкривається з типом, який змінити не можна, і «Видалити» її прибирає.
 *
 * Документи — через інтерфейс (запис — формою «+ Слот», наряд — у списку нарядів). Клієнт і авто
 * — передумови через API. Дата — 23-тє число наступного місяця.
 */

const uid = Date.now().toString().slice(-6);
const CLIENT = `000 E2E Тип запису ${uid}`;
const PLATE = `ST${uid.slice(-5)}`;
const NOTE = `000 E2E перерва ${uid}`;

const pad = (n: number) => String(n).padStart(2, '0');
function targetDate(): string {
  const ymd = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(new Date());
  const [y, m] = ymd.split('-').map(Number);
  const next = new Date(Date.UTC(y, m, 23)); // m — 1-based, тож це наступний місяць
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-23`;
}
const kyivHHMM = (iso: string) =>
  new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));

interface SlotDto {
  id: string;
  liftId?: string | null;
  workOrderId?: string | null;
  counterpartyId?: string | null;
  startAt: string;
  endAt: string;
  notes?: string | null;
  type?: string;
}

const state: {
  token?: string;
  cpId?: string;
  garageId?: string;
  vehicleId?: string;
  lift?: { id: string; name: string };
  breakId?: string;
  woId?: string;
  woNumber?: string;
} = {};

async function api<T = unknown>(page: Page, method: string, path: string, body?: unknown) {
  return apiCall<T>(page, state.token ?? (await getToken(page)), method, path, body);
}

async function daySlots(page: Page): Promise<SlotDto[]> {
  const res = await api<SlotDto[]>(page, 'GET', `/calendar/slots?date=${targetDate()}`);
  expect(res.status).toBe(200);
  return res.body;
}

/** Попап пікера дати-часу, відкритий кліком по полю `label` у `scope`. */
async function openPicker(page: Page, scope: Locator, label: string): Promise<Locator> {
  await scope.locator('label', { hasText: label }).first().locator('..').locator('input').click();
  const popup = page
    .locator('div.shadow-lg')
    .filter({ has: page.getByRole('button', { name: 'Готово' }) });
  await expect(popup).toBeVisible({ timeout: 5_000 });
  return popup;
}

async function pickTime(popup: Locator, hour: string) {
  await popup.getByLabel('Година').selectOption(hour);
  await popup.getByLabel('Хвилини').selectOption('00');
  await popup.getByRole('button', { name: 'Готово' }).click();
  await expect(popup).toBeHidden();
}

async function dayView(page: Page) {
  await page.goto(`/calendar?view=day&date=${targetDate()}`);
  await expect(page.locator('h1:has-text("Календар")')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(`[data-lift-id="${state.lift!.id}"]`)).toBeVisible({
    timeout: 15_000,
  });
}

const liftBlocks = (page: Page) =>
  page.locator(`[data-lift-id="${state.lift!.id}"] [data-calendar-slot]`);

test.describe('Тип запису календаря — BR-CAL-003', () => {
  // Прибирання — запитами з Node токеном першого тесту: наряд разом із його записом (BR-WO-017),
  // перерва (якщо тест видалення не дійшов до кінця), далі авто → гараж → клієнт.
  test.afterAll(async ({ request }) => {
    const token = state.token;
    if (!token) return;
    if (state.woId) {
      const res = await apiRequest(request, token, 'DELETE', `/work-orders/${state.woId}`);
      expect.soft([200, 204, 404], 'DELETE наряду').toContain(res.status);
    }
    if (state.breakId) {
      const res = await apiRequest(request, token, 'DELETE', `/calendar/slots/${state.breakId}`);
      expect.soft([200, 204, 404], 'DELETE перерви').toContain(res.status);
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

  test('«Перерва» через «+ Слот» — без клієнта й наряду; у «Дні» назва типу й примітка', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.goto('/work-orders');
    await expect(page.getByRole('button', { name: /^Наряд$/ }).first()).toBeVisible({
      timeout: 30_000,
    });
    state.token = await getToken(page);

    // ── Передумови через API: клієнт з авто (для наряду) і вільний підйомник ──
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
    const lifts = await api<{ id: string; name: string }[]>(page, 'GET', '/lifts');
    const own = lifts.body.filter(l => !l.name.startsWith('E2E'));
    const pool = own.length > 0 ? own : lifts.body;
    // Підйомник, вільний 14:00–17:00 цього дня (залишки інших прогонів не заважають).
    const taken = await daySlots(page);
    const busyFrom14 = (liftId: string) =>
      taken.some(
        s => s.liftId === liftId && kyivHHMM(s.startAt) < '17:00' && kyivHHMM(s.endAt) > '14:00',
      );
    state.lift = pool.find(l => !busyFrom14(l.id));
    expect(state.lift, 'потрібен підйомник, вільний 14:00–17:00').toBeTruthy();

    // ── Перерва — формою «+ Слот» ─────────────────────────────────────────
    await dayView(page);
    await page.getByRole('button', { name: 'Слот', exact: true }).click();
    const form = page
      .locator('div.rounded-xl')
      .filter({ has: page.locator('h3', { hasText: /Новий слот/ }) })
      .last();
    await expect(form).toBeVisible({ timeout: 10_000 });
    const typeSelect = form.getByLabel('Тип запису');
    await expect(typeSelect).toHaveValue('WORK');
    await expect(form.locator('label', { hasText: 'Клієнт' })).toBeVisible();
    await typeSelect.selectOption({ label: 'Перерва' });
    // BR-CAL-003: службовий запис — без клієнта, авто й наряду.
    await expect(form.locator('label', { hasText: 'Клієнт' })).toHaveCount(0);
    await expect(form.locator('label', { hasText: 'Автомобіль' })).toHaveCount(0);
    await expect(form.getByPlaceholder('Пошук клієнта…')).toHaveCount(0);

    await form.getByLabel(/Підйомник/).selectOption({ label: state.lift!.name });
    await pickTime(await openPicker(page, form, 'Початок'), '14');
    await form.locator('label', { hasText: 'Норм-год' }).locator('..').locator('input').fill('1');
    await form.locator('label', { hasText: 'Нотатки' }).locator('..').locator('input').fill(NOTE);
    await page.screenshot({ path: test.info().outputPath('c3t_e2e_break_form.png') });
    const save = form.getByRole('button', { name: 'Зберегти' });
    await expect(save).toBeEnabled();
    await save.click();
    await expect(form).toBeHidden({ timeout: 15_000 });

    const created = (await daySlots(page)).filter(s => s.notes === NOTE);
    expect(created).toHaveLength(1);
    state.breakId = created[0].id;
    expect(created[0]).toMatchObject({
      type: 'BREAK',
      liftId: state.lift!.id,
      workOrderId: null,
      counterpartyId: null,
    });
    expect([kyivHHMM(created[0].startAt), kyivHHMM(created[0].endAt)]).toEqual(['14:00', '15:00']);

    const block = liftBlocks(page).filter({ hasText: NOTE });
    await expect(block).toBeVisible({ timeout: 15_000 });
    await expect(block.locator('[data-part="service-type"]')).toHaveText('Перерва');
    await page.screenshot({ path: test.info().outputPath('c3t_e2e_break_day.png') });
  });

  test('наряд на той самий підйомник і час — конфлікт; одразу після перерви — створюється', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    test.skip(!state.breakId, 'перерву не створено');
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
    await woModal.getByLabel('Підйомник').selectOption({ label: state.lift!.name });

    // 14:00–16:00 — перетин із перервою 14:00–15:00 на тому самому підйомнику.
    const startPopup = await openPicker(page, woModal, 'Дата та час початку');
    await startPopup.getByRole('button', { name: /next|наступн/i }).click();
    await startPopup.locator(`[data-day="${targetDate()}"] button`).click();
    await pickTime(startPopup, '14');
    await woModal
      .locator('label', { hasText: 'Нормогодин' })
      .first()
      .locator('..')
      .locator('input')
      .fill('2');
    await woModal.getByPlaceholder('Заміна масла, колодок...').fill('000 E2E наряд і перерва');
    await expect(woModal.getByText(/Підйомник зайнятий\./)).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: test.info().outputPath('c3t_e2e_wo_conflict.png') });
    await woModal.getByRole('button', { name: 'Створити наряд' }).click();
    await expect(page.getByText('Підйомник вже зайнятий на цей час').first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(woModal).toBeVisible();
    const none = await api<{ items: unknown[] }>(
      page,
      'GET',
      `/work-orders?counterpartyId=${state.cpId}&limit=5`,
    );
    expect(none.body.items, 'наряд на зайнятий підйомник не створено').toHaveLength(0);

    // 15:00–17:00 — дотик меж із перервою, не перетин (BR-CAL-006).
    await pickTime(await openPicker(page, woModal, 'Дата та час початку'), '15');
    // Новий початок не зсуває кінець сам — тривалість задають нормогодини (те саме значення
    // React не вважає зміною, тож спершу інше).
    const hoursInput = woModal
      .locator('label', { hasText: 'Нормогодин' })
      .first()
      .locator('..')
      .locator('input');
    await hoursInput.fill('1');
    await hoursInput.fill('2');
    await expect(woModal.getByText(/Підйомник зайнятий\./)).toHaveCount(0, { timeout: 10_000 });
    await woModal.getByRole('button', { name: 'Створити наряд' }).click();
    await expect(woModal).toBeHidden({ timeout: 20_000 });

    const list = await api<{ items: { id: string; number: string }[] }>(
      page,
      'GET',
      `/work-orders?counterpartyId=${state.cpId}&limit=5`,
    );
    expect(list.body.items).toHaveLength(1);
    state.woId = list.body.items[0].id;
    state.woNumber = list.body.items[0].number;
    const woCard = page.getByRole('dialog').filter({ hasText: state.woNumber });
    await expect(woCard).toBeVisible({ timeout: 20_000 });
    await woCard.getByRole('button', { name: 'Закрити' }).last().click();
    await expect(woCard).toBeHidden({ timeout: 10_000 });

    const woSlot = (await daySlots(page)).filter(s => s.workOrderId === state.woId);
    expect(woSlot).toHaveLength(1);
    expect(woSlot[0].liftId).toBe(state.lift!.id);
    expect([kyivHHMM(woSlot[0].startAt), kyivHHMM(woSlot[0].endAt)]).toEqual(['15:00', '17:00']);

    await dayView(page);
    await expect(liftBlocks(page).filter({ hasText: state.woNumber })).toBeVisible({
      timeout: 15_000,
    });
    await expect(liftBlocks(page).filter({ hasText: NOTE })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('c3t_e2e_break_and_wo_day.png') });
  });

  test('перерва відкривається з незмінним типом, «Видалити» її прибирає, наряд лишається', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    test.skip(!state.breakId, 'перерву не створено');
    await dayView(page);
    await liftBlocks(page).filter({ hasText: NOTE }).locator('[data-part="content"]').click();
    const form = page
      .locator('div.rounded-xl')
      .filter({ has: page.locator('h3', { hasText: /Редагування слоту/ }) })
      .last();
    await expect(form).toBeVisible({ timeout: 10_000 });
    const typeSelect = form.getByLabel('Тип запису');
    await expect(typeSelect).toHaveValue('BREAK');
    await expect(typeSelect).toBeDisabled();
    await expect(form.locator('label', { hasText: 'Клієнт' })).toHaveCount(0);

    await form.getByRole('button', { name: 'Видалити' }).click();
    const confirm = page.getByRole('dialog').filter({ hasText: 'Видалити слот?' });
    await expect(confirm).toBeVisible({ timeout: 8_000 });
    await confirm.getByRole('button', { name: 'Так' }).click();
    await expect(liftBlocks(page).filter({ hasText: NOTE })).toHaveCount(0, { timeout: 15_000 });

    const left = await daySlots(page);
    expect(left.some(s => s.id === state.breakId)).toBe(false);
    if (state.woId) expect(left.filter(s => s.workOrderId === state.woId)).toHaveLength(1);
    state.breakId = undefined;
    await page.screenshot({ path: test.info().outputPath('c3t_e2e_break_deleted.png') });
  });
});
