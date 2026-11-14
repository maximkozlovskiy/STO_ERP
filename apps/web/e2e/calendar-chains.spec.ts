import { test, expect, type Locator, type Page } from '@playwright/test';
import { apiCall, apiRequest, getToken } from './api-helpers';
import { ensureVehicleModel } from './vehicle-directory';
import { weekdayOfNextMonth } from './work-days';

test.use({ storageState: 'e2e/.auth/admin.json', viewport: { width: 1280, height: 960 } });
test.describe.configure({ mode: 'serial' });

/**
 * Ланцюжки записів календаря (рішення власника 2026-10-30 / 2026-11-06), через браузер:
 *  1. ручний запис «+ Слот» на більше годин, ніж лишилось до закриття, ділиться на робочі дні —
 *     форма показує всі частини (№72, BR-CAL-007); видалення з ДРУГОГО дня питає «Видалити всі
 *     2 дні?» і прибирає весь ланцюжок (№60, BR-CAL-019);
 *  2. відв'язка наряду в формі запису («×» поля «Наряд») питає підтвердження, запис зникає з
 *     календаря, а наряд зберігає планові дати (№67, BR-WO-028).
 *
 * Документи — через інтерфейс (запис — формою «+ Слот», наряд — у списку нарядів); клієнт, авто й
 * години філії підйомника — передумови й перевірки через API. Дата — 14-й день пн–чт наступного
 * місяця (`weekdayOfNextMonth`): і він, і наступний — робочі.
 */

const uid = Date.now().toString().slice(-6);
const CLIENT = `000 E2E Ланцюжки ${uid}`;
const PLATE = `LC${uid.slice(-5)}`;
const NOTE = `000 E2E ланцюжок ${uid}`;

const targetDate = () => weekdayOfNextMonth(14);
const nextDate = () => {
  const d = new Date(`${targetDate()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
const dmy = (ymd: string) => ymd.split('-').reverse().join('.');
const kyivHHMM = (iso: string) =>
  new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
const pad = (n: number) => String(n).padStart(2, '0');

interface SlotDto {
  id: string;
  liftId?: string | null;
  workOrderId?: string | null;
  parentSlotId?: string | null;
  notes?: string | null;
  startAt: string;
  endAt: string;
  chainDays?: number;
}

const state: {
  token?: string;
  cpId?: string;
  garageId?: string;
  vehicleId?: string;
  lift?: { id: string; name: string; branchId?: string };
  hours?: { start: number; end: number };
  chainIds?: string[];
  wo?: { id: string; number: string };
} = {};

async function api<T = unknown>(page: Page, method: string, path: string, body?: unknown) {
  return apiCall<T>(page, state.token ?? (await getToken(page)), method, path, body);
}

async function slotsOn(page: Page, date: string): Promise<SlotDto[]> {
  const res = await api<SlotDto[]>(page, 'GET', `/calendar/slots?date=${date}`);
  expect(res.status).toBe(200);
  return res.body;
}

async function openPicker(page: Page, scope: Locator, label: string): Promise<Locator> {
  await scope.locator('label', { hasText: label }).first().locator('..').locator('input').click();
  const popup = page
    .locator('div.shadow-lg')
    .filter({ has: page.getByRole('button', { name: 'Готово' }) });
  await expect(popup).toBeVisible({ timeout: 5_000 });
  return popup;
}

async function dayView(page: Page, date: string) {
  await page.goto(`/calendar?view=day&date=${date}`);
  await expect(page.locator('h1:has-text("Календар")')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(`[data-lift-id="${state.lift!.id}"]`)).toBeVisible({
    timeout: 15_000,
  });
}

const liftBlocks = (page: Page) =>
  page.locator(`[data-lift-id="${state.lift!.id}"] [data-calendar-slot]`);

const slotForm = (page: Page, title: RegExp) =>
  page
    .locator('div.rounded-xl')
    .filter({ has: page.locator('h3', { hasText: title }) })
    .last();

test.describe('Ланцюжки записів календаря — BR-CAL-019, BR-WO-028', () => {
  // Прибирання — запитами з Node токеном першого тесту: ланцюжок (якщо тест видалення не дійшов
  // до кінця), наряд разом із записами (BR-WO-017), далі авто → гараж → клієнт.
  test.afterAll(async ({ request }) => {
    const token = state.token;
    if (!token) return;
    if (state.chainIds?.length) {
      const res = await apiRequest(
        request,
        token,
        'DELETE',
        `/calendar/slots/${state.chainIds[0]}`,
      );
      expect.soft([200, 204, 404], 'DELETE ланцюжка').toContain(res.status);
    }
    if (state.wo) {
      const res = await apiRequest(request, token, 'DELETE', `/work-orders/${state.wo.id}`);
      expect.soft([200, 204, 404], 'DELETE наряду').toContain(res.status);
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

  test('ручний запис на 2 дні через «+ Слот»; з другого дня — «Видалити всі 2 дні?»', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.goto('/calendar');
    await expect(page.locator('h1:has-text("Календар")')).toBeVisible({ timeout: 30_000 });
    state.token = await getToken(page);

    // ── Передумови: підйомник, вільний обидва дні, і години його філії ──
    const lifts = await api<{ id: string; name: string; branchId?: string }[]>(
      page,
      'GET',
      '/lifts',
    );
    const busy = new Set(
      [...(await slotsOn(page, targetDate())), ...(await slotsOn(page, nextDate()))].map(
        s => s.liftId,
      ),
    );
    const own = lifts.body.filter(l => !/^(000 )?E2E/.test(l.name) && !busy.has(l.id));
    state.lift = own[0] ?? lifts.body.find(l => !busy.has(l.id));
    expect(state.lift, 'потрібен підйомник, вільний обидва дні').toBeTruthy();
    expect(state.lift!.branchId, 'GET /lifts віддає філію підйомника (BR-CAL-017)').toBeTruthy();
    const wh = await api<{ workStartHour: number; workEndHour: number }>(
      page,
      'GET',
      `/settings/work-hours?branchId=${state.lift!.branchId}`,
    );
    expect(wh.status).toBe(200);
    state.hours = { start: wh.body.workStartHour, end: wh.body.workEndHour };
    // Початок за 2 год до закриття, 4 нормогодини: 2 год сьогодні, 2 год завтра від відкриття.
    const startHour = state.hours.end - 2;
    const endNext = `${pad(state.hours.start + 2)}:00`;

    // ── Запис — формою «+ Слот» (службовий тип — без клієнта) ─────────────
    await dayView(page, targetDate());
    await page.getByRole('button', { name: 'Слот', exact: true }).click();
    const form = slotForm(page, /Новий слот/);
    await expect(form).toBeVisible({ timeout: 10_000 });
    await form.getByLabel('Тип запису').selectOption({ label: 'Обслуговування' });
    await form.getByLabel(/Підйомник/).selectOption({ label: state.lift!.name });
    const startPopup = await openPicker(page, form, 'Початок');
    await startPopup.getByLabel('Година').selectOption(pad(startHour));
    await startPopup.getByLabel('Хвилини').selectOption('00');
    await startPopup.getByRole('button', { name: 'Готово' }).click();
    await form.locator('label', { hasText: 'Норм-год' }).locator('..').locator('input').fill('4');
    await form.locator('label', { hasText: 'Нотатки' }).locator('..').locator('input').fill(NOTE);

    // №72: «Кінець» — на наступному робочому дні, підказка — обидві частини.
    await expect(
      // Точний підпис: «Норм-год (авто кінець)» теж містить «кінець».
      form
        .locator('label', { hasText: /^Кінець$/ })
        .first()
        .locator('..')
        .locator('input'),
    ).toHaveValue(`${dmy(nextDate())} ${endNext}`);
    await expect(form.getByTestId('slot-split-warning')).toContainText('Буде розбито на 2 дні');
    await page.screenshot({ path: test.info().outputPath('chain_e2e_form.png') });
    await form.getByRole('button', { name: 'Зберегти' }).click();
    await expect(form).toBeHidden({ timeout: 15_000 });

    const anchor = (await slotsOn(page, targetDate())).filter(s => s.notes === NOTE);
    const cont = (await slotsOn(page, nextDate())).filter(s => s.notes === NOTE);
    expect(anchor).toHaveLength(1);
    expect(cont).toHaveLength(1);
    state.chainIds = [anchor[0].id, cont[0].id];
    expect(cont[0].parentSlotId).toBe(anchor[0].id);
    expect(cont[0].chainDays).toBe(2);
    expect([kyivHHMM(anchor[0].startAt), kyivHHMM(anchor[0].endAt)]).toEqual([
      `${pad(startHour)}:00`,
      `${pad(state.hours.end)}:00`,
    ]);
    expect(kyivHHMM(cont[0].endAt)).toBe(endNext);

    // ── №60: видалення з другого дня — увесь ланцюжок ────────────────────
    await dayView(page, nextDate());
    await liftBlocks(page).filter({ hasText: NOTE }).locator('[data-part="content"]').click();
    const edit = slotForm(page, /Редагування слоту/);
    await expect(edit).toBeVisible({ timeout: 10_000 });
    await edit.getByRole('button', { name: 'Видалити' }).click();
    const confirm = page.getByRole('dialog').filter({ hasText: 'Видалити всі 2 дні?' });
    await expect(confirm).toBeVisible({ timeout: 8_000 });
    await page.screenshot({ path: test.info().outputPath('chain_e2e_delete_confirm.png') });
    await confirm.getByRole('button', { name: 'Так' }).click();
    await expect(liftBlocks(page).filter({ hasText: NOTE })).toHaveCount(0, { timeout: 15_000 });

    expect((await slotsOn(page, targetDate())).some(s => s.notes === NOTE)).toBe(false);
    expect((await slotsOn(page, nextDate())).some(s => s.notes === NOTE)).toBe(false);
    state.chainIds = undefined;
  });

  test("відв'язка наряду у формі запису → підтвердження, запис зник, дати наряду лишились", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    test.skip(!state.lift, 'підйомник не обрано');
    await page.goto('/work-orders');
    await expect(page.getByRole('button', { name: /^Наряд$/ }).first()).toBeVisible({
      timeout: 30_000,
    });

    // ── Передумови через API: клієнт з авто ──────────────────────────────
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

    // ── Наряд із датами й підйомником — у списку нарядів ─────────────────
    const startHour = state.hours!.start + 2;
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
    const popup = await openPicker(page, woModal, 'Дата та час початку');
    await popup.getByRole('button', { name: /next|наступн/i }).click();
    await popup.locator(`[data-day="${targetDate()}"] button`).click();
    await popup.getByLabel('Година').selectOption(pad(startHour));
    await popup.getByLabel('Хвилини').selectOption('00');
    await popup.getByRole('button', { name: 'Готово' }).click();
    await woModal
      .locator('label', { hasText: 'Нормогодин' })
      .first()
      .locator('..')
      .locator('input')
      .fill('2');
    await woModal.getByPlaceholder('Заміна масла, колодок...').fill(`000 E2E відвʼязка ${uid}`);
    await woModal.getByRole('button', { name: 'Створити наряд' }).click();
    await expect(woModal).toBeHidden({ timeout: 20_000 });
    const list = await api<{ items: { id: string; number: string }[] }>(
      page,
      'GET',
      `/work-orders?counterpartyId=${state.cpId}&limit=5`,
    );
    expect(list.body.items).toHaveLength(1);
    state.wo = list.body.items[0];
    const woCard = page.getByRole('dialog').filter({ hasText: state.wo.number });
    await expect(woCard).toBeVisible({ timeout: 20_000 });
    await woCard.getByRole('button', { name: 'Закрити' }).last().click();
    await expect(woCard).toBeHidden({ timeout: 10_000 });
    const before = await api<{ plannedAt: string | null; dueDate: string | null }>(
      page,
      'GET',
      `/work-orders/${state.wo.id}`,
    );
    expect(before.body.plannedAt).toBeTruthy();

    // ── Відв'язка у формі запису ─────────────────────────────────────────
    await dayView(page, targetDate());
    const block = liftBlocks(page).filter({ hasText: state.wo.number });
    await expect(block).toBeVisible({ timeout: 15_000 });
    await block.locator('[data-part="content"]').click();
    const form = slotForm(page, /Редагування слоту/);
    await expect(form).toBeVisible({ timeout: 10_000 });
    // «×» поля «Наряд» — останнє «Очистити» форми.
    await form.getByRole('button', { name: 'Очистити', exact: true }).last().click();
    await form.getByRole('button', { name: 'Оновити', exact: true }).click();
    const confirm = page.getByRole('dialog').filter({ hasText: "Відв'язати наряд від запису?" });
    await expect(confirm).toBeVisible({ timeout: 8_000 });
    await page.screenshot({ path: test.info().outputPath('chain_e2e_unlink_confirm.png') });
    await confirm.getByRole('button', { name: 'Так' }).click();
    await expect(form).toBeHidden({ timeout: 15_000 });
    await expect(block).toHaveCount(0, { timeout: 15_000 });
    expect((await slotsOn(page, targetDate())).some(s => s.workOrderId === state.wo!.id)).toBe(
      false,
    );

    // Наряд зберіг планові дати — у картці наряду.
    await page.goto('/work-orders');
    const row = page.locator('table tbody tr', { hasText: state.wo.number }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.hover();
    await row.getByTitle('Відкрити наряд').click();
    const card = page.getByRole('dialog').filter({ hasText: state.wo.number });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(
      card
        .locator('label', { hasText: 'Дата та час початку' })
        .first()
        .locator('..')
        .locator('input'),
    ).toHaveValue(`${dmy(targetDate())} ${pad(startHour)}:00`);
    await page.screenshot({ path: test.info().outputPath('chain_e2e_unlinked_card.png') });
    const after = await api<{ plannedAt: string | null; dueDate: string | null }>(
      page,
      'GET',
      `/work-orders/${state.wo.id}`,
    );
    expect(after.body).toMatchObject({
      plannedAt: before.body.plannedAt,
      dueDate: before.body.dueDate,
    });
  });
});
