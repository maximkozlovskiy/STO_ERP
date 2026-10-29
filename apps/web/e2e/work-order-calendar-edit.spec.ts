import { test, expect, type Locator, type Page } from '@playwright/test';
import { apiCall, apiRequest, getToken } from './api-helpers';
import { ensureVehicleModel } from './vehicle-directory';

// Висока сторінка: у dev-базі підйомників багато, обидва рядки тесту мають бути на екрані разом.
test.use({ storageState: 'e2e/.auth/admin.json', viewport: { width: 1280, height: 1400 } });
test.describe.configure({ mode: 'serial' });

/**
 * Рішення власника 2026-10-18 на справжньому наряді, через браузер:
 *  1. BR-WO-024 — зміна меж запису наряду у «Дні» (тягнемо правий край) робить нові межі
 *     плановими датами наряду; відмова (зайнятий підйомник) — тост, ні наряд, ні запис не змінились;
 *  2. BR-WO-024 — час і підйомник у формі запису наряду змінюють наряд; картка показує те саме;
 *  3. BR-WO-025 — «Скасувати» з «Виконано»: сторінка й картка наряду спершу питають підтвердження з
 *     попередженням про повернення товарів і сторно боргу; «Ні» та Escape закривають лише
 *     підтвердження (картка лишається), «Так, скасувати» — скасовує.
 *
 * Документи — через інтерфейс: НАРЯД створюється в списку нарядів, його статуси й скасування — на
 * сторінці й у картці, ЗАПИСИ календаря — формою «+ Слот» і формою запису, межі — мишею. Клієнт і
 * авто — передумови через API. Дата — 25-те число наступного місяця (філія 08:00–18:00).
 */

const uid = Date.now().toString().slice(-6);
const CLIENT = `000 E2E Зміна запису наряду ${uid}`;
const PLATE = `WE${uid.slice(-5)}`;

const pad = (n: number) => String(n).padStart(2, '0');
const kyivToday = () =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(new Date());
function targetDate(): string {
  const [y, m] = kyivToday().split('-').map(Number);
  const next = new Date(Date.UTC(y, m, 25)); // m — 1-based, тож це наступний місяць
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-25`;
}
const kyivHHMM = (iso: string) =>
  new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
const ddmmyyyy = (ymd: string) => ymd.split('-').reverse().join('.');

const CANCEL_TITLE = 'Перевести наряд у статус "Скасовано"?';
const CANCEL_WARNING =
  'Наряд уже виконано: товари повернуться на склад, борг клієнта буде сторновано, а рахунок наряду — скасовано.';

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

const slotForm = (page: Page, title: RegExp) =>
  page
    .locator('div.rounded-xl')
    .filter({ has: page.locator('h3', { hasText: title }) })
    .last();

/** Тягне правий край блоку на `hours` годин (ширина блоку — його тривалість `durationH`). */
async function dragEndEdge(page: Page, block: Locator, hours: number, durationH: number) {
  await block.scrollIntoViewIfNeeded();
  const box = (await block.boundingBox())!;
  const edge = (await block.locator('[data-part="resize-end"]').boundingBox())!;
  const x = edge.x + edge.width / 2;
  const y = edge.y + edge.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + (box.width / durationH) * hours, y, { steps: 12 });
  await page.mouse.up();
}

/** Запис без наряду формою «+ Слот»: клієнт тесту, підйомник, початок, 1 нормогодина. */
async function plainSlot(page: Page, liftName: string, hour: string) {
  await page.getByRole('button', { name: 'Слот', exact: true }).click();
  const form = slotForm(page, /Новий слот/);
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

async function openCard(page: Page) {
  await page.goto('/work-orders');
  const row = page.locator('table tbody tr', { hasText: state.woNumber! }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.hover();
  await row.getByTitle('Відкрити наряд').click();
  const card = page.getByRole('dialog').filter({ hasText: state.woNumber! });
  await expect(card).toBeVisible({ timeout: 30_000 });
  return card;
}

test.describe('Запис наряду в календарі — BR-WO-024; скасування з підтвердженням — BR-WO-025', () => {
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
    await woModal.getByPlaceholder('Заміна масла, колодок...').fill('000 E2E зміна запису');
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

  // guards: BR-WO-024
  test('правий край запису на годину пізніше → завершення наряду 14:00, початок той самий', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    test.skip(!state.woNumber, 'наряд не створено');
    await dayView(page);
    const block = woBlock(page, state.liftA!.id);
    await expect(block).toBeVisible({ timeout: 15_000 });
    await dragEndEdge(page, block, 1, 2);

    await expect
      .poll(() => woShape(page), { timeout: 15_000 })
      .toEqual({ status: 'DRAFT', liftId: state.liftA!.id, start: '11:00', end: '14:00' });
    const [slot] = await woSlots(page);
    expect([slot.id, kyivHHMM(slot.startAt), kyivHHMM(slot.endAt)]).toEqual([
      state.anchorId,
      '11:00',
      '14:00',
    ]);
    await page.screenshot({ path: test.info().outputPath('wo24_resize_end.png') });
  });

  // guards: BR-WO-024
  test('відмова: правий край на зайнятий час → тост, наряд і запис без змін', async ({ page }) => {
    test.setTimeout(180_000);
    test.skip(!state.woNumber, 'наряд не створено');
    await dayView(page);
    // Звичайний запис без наряду на підйомнику A о 15:00 — формою «+ Слот».
    await plainSlot(page, state.liftA!.name, '15');
    const before = await woShape(page);

    // 11:00–14:00 → кінець 15:30 перетинає запис 15:00–16:00.
    const block = woBlock(page, state.liftA!.id);
    await expect(block).toBeVisible({ timeout: 15_000 });
    await dragEndEdge(page, block, 1.5, 3);
    await expect(page.getByText('Підйомник вже зайнятий на цей час').first()).toBeVisible({
      timeout: 15_000,
    });
    await page.waitForTimeout(600);
    await page.screenshot({ path: test.info().outputPath('wo24_resize_refused.png') });
    expect(await woShape(page)).toEqual(before);
    const [slot] = await woSlots(page);
    expect([slot.id, kyivHHMM(slot.startAt), kyivHHMM(slot.endAt)]).toEqual([
      state.anchorId,
      '11:00',
      '14:00',
    ]);
  });

  // guards: BR-WO-024
  test('форма запису наряду: початок 12:00, 2 год, підйомник B → наряд і картка — ті самі', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    test.skip(!state.woNumber, 'наряд не створено');
    await dayView(page);
    const block = woBlock(page, state.liftA!.id);
    await expect(block).toBeVisible({ timeout: 15_000 });
    await block.locator('span', { hasText: state.woNumber! }).first().click();
    const form = slotForm(page, /Редагування слоту/);
    await expect(form).toBeVisible({ timeout: 10_000 });
    await form.getByLabel(/Підйомник/).selectOption({ label: state.liftB!.name });
    const popup = await openPicker(page, form, 'Початок');
    await popup.getByLabel('Година').selectOption('12');
    await popup.getByLabel('Хвилини').selectOption('00');
    await popup.getByRole('button', { name: 'Готово' }).click();
    await form.locator('label', { hasText: 'Норм-год' }).locator('..').locator('input').fill('2');
    await form.getByRole('button', { name: 'Оновити', exact: true }).click();
    await expect(form).toBeHidden({ timeout: 15_000 });

    await expect
      .poll(() => woShape(page), { timeout: 15_000 })
      .toEqual({ status: 'DRAFT', liftId: state.liftB!.id, start: '12:00', end: '14:00' });
    const [slot] = await woSlots(page);
    expect([slot.id, slot.liftId, kyivHHMM(slot.startAt), kyivHHMM(slot.endAt)]).toEqual([
      state.anchorId,
      state.liftB!.id,
      '12:00',
      '14:00',
    ]);
    await expect(woBlock(page, state.liftB!.id)).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: test.info().outputPath('wo24_form_moved.png') });

    const card = await openCard(page);
    const field = (label: string) =>
      card.locator('label', { hasText: label }).first().locator('..').locator('input');
    await expect(field('Дата та час початку')).toHaveValue(`${ddmmyyyy(targetDate())} 12:00`);
    await expect(field('Дата та час завершення')).toHaveValue(`${ddmmyyyy(targetDate())} 14:00`);
    await expect(card.getByLabel('Підйомник')).toHaveValue(state.liftB!.id);
    await page.screenshot({ path: test.info().outputPath('wo24_card_same_dates.png') });
  });

  // guards: BR-WO-025
  test('«Скасувати» з «Виконано»: сторінка й картка — підтвердження з попередженням; Ні / Escape / Так', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    test.skip(!state.woNumber, 'наряд не створено');
    // Робота на сторінці наряду: «Виконано» з нульовою сумою сервер не приймає. Виконавець —
    // найстаріший механік (не тимчасовий «000 TST …» іншого тесту).
    await page.goto(`/work-orders/${state.woId}`);
    const mechs = await api<{ items: { firstName: string; lastName: string }[] }>(
      page,
      'GET',
      '/employees?limit=1&role=MECHANIC&sortBy=createdAt&sortDir=asc',
    );
    const mech = mechs.body.items[0];
    expect(mech, 'у dev-базі є механік').toBeTruthy();
    await page.getByRole('button', { name: '+ Робота' }).click();
    const addLine = page.getByRole('dialog', { name: 'Додати роботу' });
    await expect(addLine).toBeVisible({ timeout: 10_000 });
    // Робота — пошуком на сервері, виконавець — список.
    const works = await api<{ items: { name: string }[] }>(page, 'GET', '/works?limit=1');
    const workName = works.body.items[0]!.name;
    await addLine.getByPlaceholder('Пошук роботи...').fill(workName);
    await page.getByRole('option', { name: workName }).first().click();
    await addLine
      .locator('select')
      .first()
      .selectOption({ label: `${mech.lastName} ${mech.firstName}` });
    await addLine.locator('label', { hasText: 'Ціна' }).locator('..').locator('input').fill('100');
    await addLine.getByRole('button', { name: 'Додати', exact: true }).click();
    await expect(addLine).toBeHidden({ timeout: 15_000 });

    // Статуси до «Виконано» — кнопками переходів на сторінці наряду (кожен — з підтвердженням).
    for (const [label, status] of [
      ['Кошторис', 'ESTIMATE'],
      ['Затвердити', 'APPROVED'],
      ['В роботу', 'IN_PROGRESS'],
      ['Виконано', 'COMPLETED'],
    ] as const) {
      await page.getByRole('button', { name: label, exact: true }).click();
      const ask = page.getByRole('dialog').filter({ hasText: 'Перевести наряд у статус' });
      await ask.getByRole('button', { name: 'Так', exact: true }).click();
      await expect(ask).toBeHidden({ timeout: 10_000 });
      await expect.poll(async () => (await woNow(page)).status, { timeout: 15_000 }).toBe(status);
    }

    // Сторінка: «Скасувати» → підтвердження з попередженням; «Ні» — наряд не змінено.
    await page.getByRole('button', { name: 'Скасувати', exact: true }).click();
    const pageDialog = page.getByRole('dialog', { name: CANCEL_TITLE });
    await expect(pageDialog).toBeVisible({ timeout: 10_000 });
    await expect(pageDialog).toContainText(CANCEL_WARNING);
    await page.screenshot({ path: test.info().outputPath('wo25_page_confirm.png') });
    await pageDialog.getByRole('button', { name: 'Ні', exact: true }).click();
    await expect(pageDialog).toBeHidden({ timeout: 10_000 });
    expect((await woNow(page)).status).toBe('COMPLETED');

    // Картка: той самий текст; Escape закриває лише підтвердження.
    const card = await openCard(page);
    await card.getByRole('button', { name: 'Виконано' }).first().click();
    await card.getByRole('button', { name: 'Скасувати' }).first().click();
    const cardDialog = page.getByRole('dialog', { name: CANCEL_TITLE });
    await expect(cardDialog).toBeVisible({ timeout: 10_000 });
    await expect(cardDialog).toContainText(CANCEL_WARNING);
    await page.screenshot({ path: test.info().outputPath('wo25_card_confirm.png') });
    await page.keyboard.press('Escape');
    await expect(cardDialog).toBeHidden({ timeout: 10_000 });
    await expect(card, 'картка лишилась відкритою').toBeVisible();
    expect((await woNow(page)).status).toBe('COMPLETED');
    await page.screenshot({ path: test.info().outputPath('wo25_card_after_escape.png') });

    // «Так, скасувати» — наряд скасовано, запис календаря звільнено (BR-WO-022).
    // Кнопка в підвалі картки — «Скасувати наряд» (UX-огляд 2026-10-29: окремо від «Закрити»).
    await card.getByRole('button', { name: 'Скасувати наряд', exact: true }).click();
    await expect(cardDialog).toBeVisible({ timeout: 10_000 });
    await cardDialog.getByRole('button', { name: 'Так, скасувати' }).click();
    await expect
      .poll(async () => (await woNow(page)).status, { timeout: 15_000 })
      .toBe('CANCELLED');
    expect(await woSlots(page), 'записів скасованого наряду немає').toEqual([]);
  });
});
