import { test, expect, type Locator, type Page } from '@playwright/test';
import { apiCall, apiRequest, getToken } from './api-helpers';

// Висока сторінка: у dev-базі підйомників багато, обидва рядки тесту мають бути на екрані разом.
test.use({ storageState: 'e2e/.auth/admin.json', viewport: { width: 1280, height: 1400 } });
test.describe.configure({ mode: 'serial' });

/**
 * Рішення власника 2026-10-18 на справжніх нарядах, через браузер:
 *  1. BR-WO-028 — перев'язка запису у формі на наряд із датами: запис стає на дати й підйомник
 *     нового наряду, попередній наряд утрачає дати (картка — порожні поля);
 *  2. BR-WO-028 — перев'язка на наряд без дат: наряд отримує дати й підйомник запису;
 *  3. BR-WO-026 — «Видалити» у формі запису наряду: підтвердження попереджає, дати наряду стерто
 *     (картка — порожні поля), записів наряду немає;
 *  4. BR-WO-027 — запис наряду «В роботі» не перетягується й не розтягується (без ручок, тягнення
 *     мишею нічого не змінює), у формі час і підйомник недоступні з підказкою.
 *
 * Документи — через інтерфейс: НАРЯДИ створюються в списку нарядів, статуси — на сторінці наряду,
 * ЗАПИСИ — формою запису. Клієнт і авто — передумови через API. Дата — 27-ме наступного місяця.
 */

const uid = Date.now().toString().slice(-6);
const CLIENT = `000 E2E Перев'язка запису ${uid}`;
const PLATE = `WL${uid.slice(-5)}`;

const pad = (n: number) => String(n).padStart(2, '0');
const kyivToday = () =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(new Date());
function targetDate(): string {
  const [y, m] = kyivToday().split('-').map(Number);
  const next = new Date(Date.UTC(y, m, 27)); // m — 1-based, тож це наступний місяць
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-27`;
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
  startAt: string;
  endAt: string;
}
interface WoDto {
  status: string;
  liftId: string | null;
  plannedAt: string | null;
  dueDate: string | null;
}
type WoKey = 'withDates' | 'target' | 'noDates' | 'locked';

const state: {
  token?: string;
  cpId?: string;
  garageId?: string;
  vehicleId?: string;
  liftA?: { id: string; name: string };
  liftB?: { id: string; name: string };
  wo: Partial<Record<WoKey, { id: string; number: string }>>;
  recordId?: string;
} = { wo: {} };

async function api<T = unknown>(page: Page, method: string, path: string, body?: unknown) {
  return apiCall<T>(page, state.token ?? (await getToken(page)), method, path, body);
}

async function daySlots(page: Page): Promise<SlotDto[]> {
  const res = await api<SlotDto[]>(page, 'GET', `/calendar/slots?date=${targetDate()}`);
  expect(res.status).toBe(200);
  return res.body;
}
const slotsOf = async (page: Page, key: WoKey) =>
  (await daySlots(page)).filter(s => s.workOrderId === state.wo[key]!.id);
/** Наряд — «статус, підйомник, початок–кінець» одним значенням. */
const woShape = async (page: Page, key: WoKey) => {
  const wo = (await api<WoDto>(page, 'GET', `/work-orders/${state.wo[key]!.id}`)).body;
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

const woBlock = (page: Page, key: WoKey) =>
  page.locator('[data-calendar-slot]', { hasText: state.wo[key]!.number });

const slotForm = (page: Page) =>
  page
    .locator('div.rounded-xl')
    .filter({ has: page.locator('h3', { hasText: /Редагування слоту/ }) })
    .last();

async function openRecord(page: Page, key: WoKey): Promise<Locator> {
  const block = woBlock(page, key);
  await expect(block).toBeVisible({ timeout: 15_000 });
  await block.locator('span', { hasText: state.wo[key]!.number }).first().click();
  const form = slotForm(page);
  await expect(form).toBeVisible({ timeout: 10_000 });
  return form;
}

/** Наряд через список нарядів; з `start` — планові дати (`hours` нормогодин) і підйомник. */
async function createWorkOrder(
  page: Page,
  key: WoKey,
  plan?: { lift: { name: string }; start: string; hours: string },
) {
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
  if (plan) {
    await woModal.getByLabel('Підйомник').selectOption({ label: plan.lift.name });
    const popup = await openPicker(page, woModal, 'Дата та час початку');
    await popup.getByRole('button', { name: /next|наступн/i }).click();
    await popup.locator(`[data-day="${targetDate()}"] button`).click();
    await popup.getByLabel('Година').selectOption(plan.start);
    await popup.getByLabel('Хвилини').selectOption('00');
    await popup.getByRole('button', { name: 'Готово' }).click();
    await woModal
      .locator('label', { hasText: 'Нормогодин' })
      .first()
      .locator('..')
      .locator('input')
      .fill(plan.hours);
  }
  await woModal.getByPlaceholder('Заміна масла, колодок...').fill(`000 E2E ${key}`);
  await woModal.getByRole('button', { name: 'Створити наряд' }).click();
  await expect(woModal).toBeHidden({ timeout: 20_000 });

  const list = await api<{ items: { id: string; number: string }[] }>(
    page,
    'GET',
    `/work-orders?counterpartyId=${state.cpId}&limit=20&sortBy=createdAt&sortDir=desc`,
  );
  const known = new Set(Object.values(state.wo).map(w => w!.id));
  const created = list.body.items.filter(w => !known.has(w.id));
  expect(created, `наряд ${key} створено`).toHaveLength(1);
  state.wo[key] = created[0];
  const card = page.getByRole('dialog').filter({ hasText: created[0].number });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByRole('button', { name: 'Закрити' }).last().click();
  await expect(card).toBeHidden({ timeout: 10_000 });
}

/** Перев'язати відкритий запис на наряд `key` у полі «Наряд» форми і зберегти. */
async function relinkTo(page: Page, form: Locator, key: WoKey) {
  const number = state.wo[key]!.number;
  // Обраний наряд показано текстом — спершу «×» поля «Наряд» (останнє «Очистити» форми).
  await form.getByRole('button', { name: 'Очистити', exact: true }).last().click();
  await form.getByPlaceholder('Пошук наряду…').fill(number);
  await page.getByRole('option', { name: new RegExp(number) }).click();
  await form.getByRole('button', { name: 'Оновити', exact: true }).click();
  await expect(form).toBeHidden({ timeout: 15_000 });
}

/** Картка наряду зі списку нарядів (та сама, що відкривається з календаря). */
async function openCard(page: Page, key: WoKey) {
  const number = state.wo[key]!.number;
  await page.goto('/work-orders');
  const row = page.locator('table tbody tr', { hasText: number }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.hover();
  await row.getByTitle('Відкрити наряд').click();
  const card = page.getByRole('dialog').filter({ hasText: number });
  await expect(card).toBeVisible({ timeout: 30_000 });
  return card;
}

test.describe('Запис наряду: перевʼязка BR-WO-028, видалення BR-WO-026, статус BR-WO-027', () => {
  test.afterAll(async ({ request }) => {
    const token = state.token;
    if (!token) return;
    // Наряди — разом із записами календаря (BR-WO-017); «В роботі» спершу скасувати.
    for (const wo of Object.values(state.wo)) {
      if (!wo) continue;
      const cur = await apiRequest<{ status: string }>(
        request,
        token,
        'GET',
        `/work-orders/${wo.id}`,
      );
      if (cur.body?.status === 'IN_PROGRESS') {
        for (const status of ['ON_HOLD', 'CANCELLED']) {
          const tr = await apiRequest(request, token, 'POST', `/work-orders/${wo.id}/transition`, {
            status,
          });
          expect.soft(tr.status, `перехід ${status}`).toBeLessThan(300);
        }
      }
      const res = await apiRequest(request, token, 'DELETE', `/work-orders/${wo.id}`);
      expect.soft([200, 204, 404], `DELETE наряду ${wo.number}`).toContain(res.status);
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

  test('передумови; чотири наряди через список нарядів', async ({ page }) => {
    test.setTimeout(300_000);
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

    await createWorkOrder(page, 'withDates', { lift: state.liftA!, start: '11', hours: '2' });
    await createWorkOrder(page, 'target', { lift: state.liftB!, start: '14', hours: '1' });
    await createWorkOrder(page, 'noDates');
    await createWorkOrder(page, 'locked', { lift: state.liftA!, start: '08', hours: '1' });

    const [record] = await slotsOf(page, 'withDates');
    state.recordId = record.id;
    expect(await slotsOf(page, 'target')).toHaveLength(1);
    expect(await woShape(page, 'noDates')).toMatchObject({ start: null, end: null });
  });

  // guards: BR-WO-028
  test('перевʼязка на наряд із датами → запис на його дати й підйомник, попередній без дат', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    test.skip(!state.recordId, 'передумови не створено');
    await dayView(page);
    const form = await openRecord(page, 'withDates');
    await relinkTo(page, form, 'target');

    await expect
      .poll(() => slotsOf(page, 'target'), { timeout: 15_000 })
      .toEqual([expect.objectContaining({ id: state.recordId, liftId: state.liftB!.id })]);
    const [slot] = await slotsOf(page, 'target');
    expect([kyivHHMM(slot.startAt), kyivHHMM(slot.endAt)]).toEqual(['14:00', '15:00']);
    expect(await slotsOf(page, 'withDates')).toEqual([]);
    expect(await woShape(page, 'withDates')).toMatchObject({ start: null, end: null });
    await expect(woBlock(page, 'target')).toBeVisible({ timeout: 15_000 });
    await expect(woBlock(page, 'withDates')).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('wo28_relink_with_dates.png') });
  });

  // guards: BR-WO-028
  test('перевʼязка на наряд без дат → наряд отримав дати й підйомник запису', async ({ page }) => {
    test.setTimeout(150_000);
    test.skip(!state.recordId, 'передумови не створено');
    await dayView(page);
    const form = await openRecord(page, 'target');
    await relinkTo(page, form, 'noDates');

    await expect
      .poll(() => woShape(page, 'noDates'), { timeout: 15_000 })
      .toEqual({ status: 'DRAFT', liftId: state.liftB!.id, start: '14:00', end: '15:00' });
    expect((await slotsOf(page, 'noDates')).map(s => s.id)).toEqual([state.recordId]);
    expect(await woShape(page, 'target')).toMatchObject({ start: null, end: null });
    await page.screenshot({ path: test.info().outputPath('wo28_relink_no_dates.png') });
  });

  // guards: BR-WO-026
  test('«Видалити» запису наряду → попередження, записів немає, дати в картці наряду порожні', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    test.skip(!state.recordId, 'передумови не створено');
    await dayView(page);
    const form = await openRecord(page, 'noDates');
    await form.getByRole('button', { name: /Видалити/ }).click();
    const ask = page.getByRole('dialog').filter({ hasText: 'Видалити слот?' });
    await expect(ask).toContainText(
      `Запис наряду ${state.wo.noDates!.number} буде видалено з календаря`,
    );
    await expect(ask).toContainText('планові дати наряду — стерто');
    await page.screenshot({ path: test.info().outputPath('wo26_delete_confirm.png') });
    await ask.getByRole('button', { name: 'Так', exact: true }).click();
    await expect(form).toBeHidden({ timeout: 15_000 });

    await expect.poll(() => slotsOf(page, 'noDates'), { timeout: 15_000 }).toEqual([]);
    expect(await woShape(page, 'noDates')).toMatchObject({ start: null, end: null });

    // Картка наряду — планові дати порожні.
    const card = await openCard(page, 'noDates');
    const field = (label: string) =>
      card.locator('label', { hasText: label }).first().locator('..').locator('input');
    await expect(field('Дата та час початку')).toHaveValue('', { timeout: 15_000 });
    await expect(field('Дата та час завершення')).toHaveValue('');
    await page.screenshot({ path: test.info().outputPath('wo26_card_no_dates.png') });
  });

  // guards: BR-WO-028
  test('«+ Слот» з нарядом без дат → наряд отримав час форми; вдруге (дати вже є) — другого запису немає (Bug #905)', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    test.skip(!state.recordId, 'передумови не створено');
    await dayView(page);

    /** Новий запис формою «+ Слот»: підйомник, початок `hour`:00 на 1 год, клієнт, авто, наряд. */
    async function newRecord(lift: { name: string }, hour: string) {
      await page.getByRole('button', { name: /Слот/ }).first().click();
      const form = page
        .locator('div.rounded-xl')
        .filter({ has: page.locator('h3', { hasText: /Новий слот/ }) })
        .last();
      await expect(form).toBeVisible({ timeout: 10_000 });
      await form.getByLabel(/Підйомник/).selectOption({ label: lift.name });
      const popup = await openPicker(page, form, 'Початок');
      // Пікер відкривається на поточному місяці, дата тесту — наступного.
      const day = popup.locator(`[data-day="${targetDate()}"] button`);
      if ((await day.count()) === 0)
        await popup.getByRole('button', { name: /next|наступн/i }).click();
      await day.click();
      await popup.getByLabel('Година').selectOption(hour);
      await popup.getByLabel('Хвилини').selectOption('00');
      await popup.getByRole('button', { name: 'Готово' }).click();
      await form
        .locator('label', { hasText: 'Норм-год' })
        .first()
        .locator('..')
        .locator('input')
        .fill('1');
      await form
        .getByPlaceholder(/клієнт/i)
        .first()
        .fill(CLIENT);
      await page
        .getByRole('option', { name: new RegExp(CLIENT) })
        .first()
        .click();
      const vehicle = form
        .locator('select')
        .filter({ has: page.locator('option', { hasText: PLATE }) });
      await expect(vehicle).toHaveCount(1, { timeout: 10_000 });
      await vehicle.selectOption({ label: `Toyota Corolla ${PLATE}` });
      await form.getByPlaceholder('Пошук наряду…').fill(state.wo.noDates!.number);
      await page.getByRole('option', { name: new RegExp(state.wo.noDates!.number) }).click();
      await form.getByRole('button', { name: 'Зберегти', exact: true }).click();
      await expect(form).toBeHidden({ timeout: 15_000 });
    }

    await newRecord(state.liftA!, '13');
    await expect
      .poll(() => woShape(page, 'noDates'), { timeout: 15_000 })
      .toEqual({ status: 'DRAFT', liftId: state.liftA!.id, start: '13:00', end: '14:00' });
    const [first] = await slotsOf(page, 'noDates');
    expect(first).toMatchObject({ liftId: state.liftA!.id });

    // Наряд уже має дати: запис форми на 15:00 підйомника B — це той самий запис наряду.
    await newRecord(state.liftB!, '15');
    await expect(page.getByText('запис стоїть на датах і підйомнику наряду')).toBeVisible({
      timeout: 10_000,
    });
    expect((await slotsOf(page, 'noDates')).map(s => [s.id, s.liftId])).toEqual([
      [first.id, state.liftA!.id],
    ]);
    expect(await woShape(page, 'noDates')).toMatchObject({ start: '13:00', end: '14:00' });
    await expect(woBlock(page, 'noDates')).toHaveCount(1);
    await page.screenshot({ path: test.info().outputPath('wo28_new_record_for_wo.png') });
  });

  // guards: BR-WO-027
  test('наряд «В роботі»: запис не тягнеться й не розтягується, у формі час і підйомник недоступні', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    test.skip(!state.wo.locked, 'передумови не створено');
    await page.goto(`/work-orders/${state.wo.locked!.id}`);
    for (const [label, status] of [
      ['Кошторис', 'ESTIMATE'],
      ['Затвердити', 'APPROVED'],
      ['В роботу', 'IN_PROGRESS'],
    ] as const) {
      await page.getByRole('button', { name: label, exact: true }).click();
      const ask = page.getByRole('dialog').filter({ hasText: 'Перевести наряд у статус' });
      await ask.getByRole('button', { name: 'Так', exact: true }).click();
      await expect(ask).toBeHidden({ timeout: 10_000 });
      await expect
        .poll(async () => (await woShape(page, 'locked')).status, { timeout: 15_000 })
        .toBe(status);
    }
    const before = await woShape(page, 'locked');
    expect(before).toMatchObject({ start: '08:00', end: '09:00' });

    await dayView(page);
    const block = woBlock(page, 'locked');
    await expect(block).toBeVisible({ timeout: 15_000 });
    await expect(block).toHaveAttribute('data-time-locked', 'true');
    await expect(block.locator('[data-part^="resize-"]')).toHaveCount(0);
    await expect(block).toHaveAttribute(
      'title',
      /Наряд «В роботі»: час і підйомник запису не змінюються/,
    );

    // Спроба перетягнути мишею на 2 години пізніше й у рядок підйомника B — нічого не змінюється.
    const from = (await block.boundingBox())!;
    const rowB = (await page.locator(`[data-lift-id="${state.liftB!.id}"]`).boundingBox())!;
    const x = from.x + Math.min(20, from.width / 2);
    await page.mouse.move(x, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(x + 40, from.y + from.height / 2 + 12, { steps: 4 });
    await page.mouse.move(x + 2 * from.width, rowB.y + rowB.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(800);
    expect(await woShape(page, 'locked')).toEqual(before);
    const [slot] = await slotsOf(page, 'locked');
    expect([slot.liftId, kyivHHMM(slot.startAt)]).toEqual([state.liftA!.id, '08:00']);

    const form = await openRecord(page, 'locked');
    await expect(form.getByTestId('slot-wo-time-locked')).toContainText('«В роботі»');
    await expect(form.getByLabel(/Підйомник/)).toBeDisabled();
    await expect(
      form.locator('label', { hasText: 'Початок' }).first().locator('..').locator('input'),
    ).toBeDisabled();
    await expect(form.getByLabel('Механік')).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath('wo27_in_progress_form.png') });

    // Примітка змінюється й у нередагованому статусі — «Оновити» без відмови, наряд той самий.
    const notes = form.locator('label', { hasText: 'Нотатки' }).locator('..').locator('input');
    await notes.fill('000 E2E примітка в роботі');
    await form.getByRole('button', { name: 'Оновити', exact: true }).click();
    await expect(form).toBeHidden({ timeout: 15_000 });
    expect(await woShape(page, 'locked')).toEqual(before);
    const notesNow = await api<{ calendarSlots: { id: string; notes: string | null }[] }>(
      page,
      'GET',
      `/work-orders/${state.wo.locked!.id}/linked-documents`,
    );
    expect(notesNow.body.calendarSlots.map(s => s.notes)).toEqual(['000 E2E примітка в роботі']);
  });
});
