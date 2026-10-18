import { test, expect, type Locator, type Page } from '@playwright/test';
import { apiCall, apiRequest, getToken } from './api-helpers';

// Висока сторінка: у dev-базі підйомників багато, обидва рядки тесту мають бути на екрані разом.
test.use({ storageState: 'e2e/.auth/admin.json', viewport: { width: 1280, height: 1400 } });
test.describe.configure({ mode: 'serial' });

/**
 * Рішення власника 2026-10-18 на справжньому наряді, через браузер:
 *  1. BR-WO-023 — перетягування запису наряду у «Дні» на годину пізніше й на рядок іншого
 *     підйомника зсуває планові дати наряду (тривалість та сама) і змінює його підйомник; картка
 *     наряду показує ті самі дати, що й календар;
 *  2. відмова (зайнятий підйомник, поза робочими годинами) — тост із причиною, ні наряд, ні запис
 *     не змінились, блок на місці;
 *  3. BR-WO-022 — скасування наряду в картці прибирає його запис із календаря й звільняє підйомник:
 *     у той самий час на тому самому підйомнику стає новий запис.
 *
 * За правилом власника документи — через інтерфейс: НАРЯД створюється в списку нарядів і
 * скасовується в картці, ЗАПИСИ календаря — формою «+ Слот», переміщення — мишею. Клієнт і авто —
 * передумови через API. Дата — 24-те число наступного місяця (філія 08:00–18:00).
 */

const uid = Date.now().toString().slice(-6);
const CLIENT = `000 E2E Перетягування наряду ${uid}`;
const PLATE = `WD${uid.slice(-5)}`;

const pad = (n: number) => String(n).padStart(2, '0');
const kyivToday = () =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(new Date());
function targetDate(): string {
  const [y, m] = kyivToday().split('-').map(Number);
  const next = new Date(Date.UTC(y, m, 24)); // m — 1-based, тож це наступний місяць
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-24`;
}
const kyivHHMM = (iso: string) =>
  new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
const ddmmyyyy = (ymd: string) => ymd.split('-').reverse().join('.');

interface SlotDto {
  id: string;
  liftId?: string | null;
  workOrderId?: string | null;
  counterpartyId?: string | null;
  startAt: string;
  endAt: string;
}
interface WoDto {
  status: string;
  liftId: string | null;
  plannedAt: string | null;
  dueDate: string | null;
}

const state: {
  token?: string;
  cpId?: string;
  garageId?: string;
  vehicleId?: string;
  liftA?: { id: string; name: string };
  liftB?: { id: string; name: string };
  woId?: string;
  woNumber?: string;
  anchorId?: string;
  slotIds: string[];
} = { slotIds: [] };

async function api<T = unknown>(page: Page, method: string, path: string, body?: unknown) {
  return apiCall<T>(page, state.token ?? (await getToken(page)), method, path, body);
}

async function daySlots(page: Page): Promise<SlotDto[]> {
  const res = await api<SlotDto[]>(page, 'GET', `/calendar/slots?date=${targetDate()}`);
  expect(res.status).toBe(200);
  return res.body;
}
const woSlots = async (page: Page) =>
  (await daySlots(page)).filter(s => s.workOrderId === state.woId);
const woNow = async (page: Page) =>
  (await api<WoDto>(page, 'GET', `/work-orders/${state.woId}`)).body;
/** Наряд у вигляді «статус, підйомник, початок–кінець» — одним значенням для poll і порівнянь. */
const woShape = async (page: Page) => {
  const wo = await woNow(page);
  return {
    status: wo.status,
    liftId: wo.liftId,
    start: wo.plannedAt && kyivHHMM(wo.plannedAt),
    end: wo.dueDate && kyivHHMM(wo.dueDate),
  };
};

async function openPicker(page: Page, scope: Locator, label: string): Promise<Locator> {
  await scope.locator('label', { hasText: label }).first().locator('..').locator('input').click();
  const popup = page
    .locator('div.shadow-lg')
    .filter({ has: page.getByRole('button', { name: 'Готово' }) });
  await expect(popup).toBeVisible({ timeout: 5_000 });
  return popup;
}

async function dayView(page: Page) {
  await page.goto(`/calendar?view=day&date=${targetDate()}`);
  await expect(page.locator('h1:has-text("Календар")')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(`[data-lift-id="${state.liftA!.id}"]`)).toBeVisible({
    timeout: 15_000,
  });
}

const woBlock = (page: Page, liftId: string) =>
  page.locator(`[data-lift-id="${liftId}"] [data-calendar-slot]`, { hasText: state.woNumber! });

/**
 * Перетягує блок мишею: `hours` — зсув у годинах (ширина блоку — його тривалість), `toLiftId` —
 * рядок підйомника. Кроками: dnd-kit починає перетягування після зсуву вказівника.
 */
async function dragBlock(
  page: Page,
  block: Locator,
  hours: number,
  durationH: number,
  toLiftId: string,
) {
  const target = page.locator(`[data-lift-id="${toLiftId}"]`);
  await target.scrollIntoViewIfNeeded();
  await block.scrollIntoViewIfNeeded();
  const from = (await block.boundingBox())!;
  const row = (await target.boundingBox())!;
  const x = from.x + Math.min(20, from.width / 2);
  const y = from.y + from.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 4, y + 8, { steps: 4 });
  await page.mouse.move(x + (from.width / durationH) * hours, row.y + row.height / 2, {
    steps: 16,
  });
  await page.mouse.up();
}

/** Запис без наряду формою «+ Слот»: клієнт тесту, підйомник, початок, 1 нормогодина. */
async function plainSlot(page: Page, liftName: string, hour: string) {
  await page.getByRole('button', { name: 'Слот', exact: true }).click();
  const form = page
    .locator('div.rounded-xl')
    .filter({ has: page.locator('h3', { hasText: /Новий слот/ }) })
    .last();
  await expect(form).toBeVisible({ timeout: 10_000 });
  await form.getByLabel(/Підйомник/).selectOption({ label: liftName });
  const popup = await openPicker(page, form, 'Початок');
  await popup.getByLabel('Година').selectOption(hour);
  await popup.getByLabel('Хвилини').selectOption('00');
  await popup.getByRole('button', { name: 'Готово' }).click();
  await form.locator('label', { hasText: 'Норм-год' }).locator('..').locator('input').fill('1');
  await form.getByPlaceholder('Пошук клієнта…').fill(CLIENT);
  await page.getByRole('option', { name: new RegExp(CLIENT) }).click();
  await form.getByRole('button', { name: 'Зберегти', exact: true }).click();
  await expect(form).toBeHidden({ timeout: 15_000 });
  const created = (await daySlots(page)).filter(
    s => s.counterpartyId === state.cpId && !s.workOrderId && !state.slotIds.includes(s.id),
  );
  expect(created, 'запис без наряду створено').toHaveLength(1);
  state.slotIds.push(created[0].id);
  return created[0];
}

test.describe('Запис наряду в календарі — BR-WO-023 / BR-WO-022', () => {
  test.afterAll(async ({ request }) => {
    const token = state.token;
    if (!token) return;
    for (const id of state.slotIds) {
      const res = await apiRequest(request, token, 'DELETE', `/calendar/slots/${id}`);
      expect.soft([200, 204, 404], `DELETE запису ${id}`).toContain(res.status);
    }
    // Наряд (чернетка чи скасований) — разом із записами календаря (BR-WO-017).
    if (state.woId) {
      const res = await apiRequest(request, token, 'DELETE', `/work-orders/${state.woId}`);
      expect.soft([200, 204, 404], 'DELETE наряду').toContain(res.status);
    }
    if (state.vehicleId) {
      const res = await apiRequest(request, token, 'DELETE', `/vehicles/${state.vehicleId}`);
      expect.soft(res.status, 'DELETE авто').toBeLessThan(300);
    }
    // Гараж — до клієнта: гараж видаленого клієнта API вже не видаляє.
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

  test('передумови; наряд 11:00–13:00 на підйомнику A — через список нарядів', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/work-orders');
    await expect(page.getByRole('button', { name: /^Наряд$/ }).first()).toBeVisible({
      timeout: 30_000,
    });
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
      { name: '000 E2E гараж' },
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
    const lifts = await api<{ id: string; name: string }[]>(page, 'GET', '/lifts');
    const own = lifts.body.filter(l => !l.name.startsWith('E2E'));
    const pool = own.length >= 2 ? own : lifts.body;
    expect(pool.length, 'потрібні два підйомники').toBeGreaterThanOrEqual(2);
    [state.liftA, state.liftB] = pool;

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
    await woModal.getByLabel('Підйомник').selectOption({ label: state.liftA!.name });
    const popup = await openPicker(page, woModal, 'Дата та час початку');
    await popup.getByRole('button', { name: /next|наступн/i }).click();
    await popup.locator(`[data-day="${targetDate()}"] button`).click();
    await popup.getByLabel('Година').selectOption('11');
    await popup.getByLabel('Хвилини').selectOption('00');
    await popup.getByRole('button', { name: 'Готово' }).click();
    await woModal
      .locator('label', { hasText: 'Нормогодин' })
      .first()
      .locator('..')
      .locator('input')
      .fill('2');
    await woModal.getByPlaceholder('Заміна масла, колодок...').fill('000 E2E перетягування');
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
    const card = page.getByRole('dialog').filter({ hasText: state.woNumber });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.getByRole('button', { name: 'Закрити' }).last().click();
    await expect(card).toBeHidden({ timeout: 10_000 });

    const slots = await woSlots(page);
    expect(slots).toHaveLength(1);
    state.anchorId = slots[0].id;
    expect(await woShape(page)).toEqual({
      status: 'DRAFT',
      liftId: state.liftA!.id,
      start: '11:00',
      end: '13:00',
    });
  });

  // guards: BR-WO-023
  test('перетягування на годину пізніше й на підйомник B → дати й підйомник наряду змінились', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    test.skip(!state.woNumber, 'наряд не створено');
    await dayView(page);
    const block = woBlock(page, state.liftA!.id);
    await expect(block).toBeVisible({ timeout: 15_000 });
    await dragBlock(page, block, 1, 2, state.liftB!.id);

    await expect
      .poll(() => woShape(page), { timeout: 15_000 })
      .toEqual({ status: 'DRAFT', liftId: state.liftB!.id, start: '12:00', end: '14:00' });
    const [slot] = await woSlots(page);
    expect(slot.id, 'той самий запис переїхав').toBe(state.anchorId);
    expect([slot.liftId, kyivHHMM(slot.startAt), kyivHHMM(slot.endAt)]).toEqual([
      state.liftB!.id,
      '12:00',
      '14:00',
    ]);
    await expect(woBlock(page, state.liftB!.id)).toBeVisible({ timeout: 15_000 });
    await expect(woBlock(page, state.liftA!.id)).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('wo23_drag_moved_day.png') });

    // Картка наряду — ті самі дати й підйомник, що й календар.
    await page.goto('/work-orders');
    const row = page.locator('table tbody tr', { hasText: state.woNumber! }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.hover();
    await row.getByTitle('Відкрити наряд').click();
    const card = page.getByRole('dialog').filter({ hasText: state.woNumber! });
    await expect(card).toBeVisible({ timeout: 30_000 });
    const field = (label: string) =>
      card.locator('label', { hasText: label }).first().locator('..').locator('input');
    await expect(field('Дата та час початку')).toHaveValue(`${ddmmyyyy(targetDate())} 12:00`);
    await expect(field('Дата та час завершення')).toHaveValue(`${ddmmyyyy(targetDate())} 14:00`);
    await expect(card.getByLabel('Підйомник')).toHaveValue(state.liftB!.id);
    await page.screenshot({ path: test.info().outputPath('wo23_card_same_dates.png') });
  });

  // guards: BR-WO-023
  test('відмова: зайнятий підйомник і поза робочими годинами → тост, наряд і запис без змін', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    test.skip(!state.woNumber, 'наряд не створено');
    await dayView(page);
    // Звичайний запис без наряду на підйомнику A о 15:00 — формою «+ Слот».
    await plainSlot(page, state.liftA!.name, '15');
    const before = await woShape(page);

    // На підйомник A о 15:00–17:00 → перетин із записом 15:00–16:00.
    const block = woBlock(page, state.liftB!.id);
    await expect(block).toBeVisible({ timeout: 15_000 });
    await dragBlock(page, block, 3, 2, state.liftA!.id);
    await expect(page.getByText('Підйомник вже зайнятий на цей час').first()).toBeVisible({
      timeout: 15_000,
    });
    await page.waitForTimeout(600);
    await page.screenshot({ path: test.info().outputPath('wo23_refused_busy.png') });
    expect(await woShape(page)).toEqual(before);
    const [slot] = await woSlots(page);
    expect([slot.id, slot.liftId, kyivHHMM(slot.startAt)]).toEqual([
      state.anchorId,
      state.liftB!.id,
      '12:00',
    ]);
    await expect(woBlock(page, state.liftB!.id)).toBeVisible();

    // На 5 годин пізніше: 17:00–19:00 — завершення поза 08:00–18:00.
    await expect(page.getByText('Підйомник вже зайнятий на цей час')).toHaveCount(0, {
      timeout: 15_000,
    });
    await dragBlock(page, woBlock(page, state.liftB!.id), 5, 2, state.liftB!.id);
    await expect(page.getByText(/Плановий час має бути в робочих годинах/).first()).toBeVisible({
      timeout: 15_000,
    });
    await page.waitForTimeout(600);
    await page.screenshot({ path: test.info().outputPath('wo23_refused_hours.png') });
    expect(await woShape(page)).toEqual(before);
    expect((await woSlots(page)).map(s => kyivHHMM(s.startAt))).toEqual(['12:00']);
  });

  // guards: BR-WO-022
  test('скасування наряду в картці → запис зник, підйомник B вільний о 12:00', async ({ page }) => {
    test.setTimeout(180_000);
    test.skip(!state.woNumber, 'наряд не створено');
    await page.goto('/work-orders');
    const row = page.locator('table tbody tr', { hasText: state.woNumber! }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.hover();
    await row.getByTitle('Відкрити наряд').click();
    const card = page.getByRole('dialog').filter({ hasText: state.woNumber! });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.getByRole('button', { name: 'Чернетка' }).first().click();
    await card.getByRole('button', { name: 'Скасувати' }).first().click();
    const confirm = page.getByRole('button', { name: 'Так' });
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
    await expect
      .poll(async () => (await woNow(page)).status, { timeout: 15_000 })
      .toBe('CANCELLED');
    expect(await woSlots(page), 'записів скасованого наряду немає').toEqual([]);

    await dayView(page);
    await expect(page.locator('[data-calendar-slot]', { hasText: state.woNumber! })).toHaveCount(0);
    // Той самий час і підйомник — новий запис стає без «зайнято».
    const freed = await plainSlot(page, state.liftB!.name, '12');
    expect([freed.liftId, kyivHHMM(freed.startAt)]).toEqual([state.liftB!.id, '12:00']);
    await page.screenshot({ path: test.info().outputPath('wo22_cancel_frees_lift.png') });
  });
});
