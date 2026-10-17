import { test, expect, type Locator, type Page } from '@playwright/test';
import { apiCall, apiRequest, getToken } from './api-helpers';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/**
 * Наряд сам потрапляє в календар (BR-WO-020) і планові дати не в минулому, у робочих годинах
 * (BR-WO-019) — рішення власника 2026-10-16, через браузер:
 *  1. наряд із плановими датами й підйомником, створений у списку нарядів, має запис у виді «День»;
 *     у пікері минулі дні недоступні, сьогодні — лише години від поточної;
 *  2. зміна дат і підйомника в картці наряду переносить запис;
 *  3. стерті дати прибирають запис;
 *  4. наряд, створений із форми запису календаря, має рівно один запис.
 *
 * За правилом власника документи — через інтерфейс (наряди — у списку й картці, запис — формою
 * «+ Слот»). Клієнт і авто — передумови через API. Дата — 19-те число наступного місяця.
 */

const uid = Date.now().toString().slice(-6);
const CLIENT = `000 E2E Наряд у календарі ${uid}`;
const PLATE = `WC${uid.slice(-5)}`;

const pad = (n: number) => String(n).padStart(2, '0');
const kyivNow = () => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Europe/Kyiv',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date())
      .map(x => [x.type, x.value]),
  );
  return { ymd: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
};
function targetDate(): string {
  const [y, m] = kyivNow().ymd.split('-').map(Number);
  const next = new Date(Date.UTC(y, m, 19)); // m — 1-based, тож це наступний місяць
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-19`;
}
const kyivHHMM = (iso: string) =>
  new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));

/** Запит до API від імені користувача сторінки (токен — збережений першим тестом). */
async function api<T = unknown>(page: Page, method: string, path: string, body?: unknown) {
  return apiCall<T>(page, state.token ?? (await getToken(page)), method, path, body);
}

interface SlotDto {
  id: string;
  liftId?: string | null;
  workOrderId?: string | null;
  parentSlotId?: string | null;
  startAt: string;
  endAt: string;
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
  wo2Id?: string;
  wo2Number?: string;
  anchorId?: string;
} = {};

async function woSlots(page: Page, woId: string): Promise<SlotDto[]> {
  const res = await api<SlotDto[]>(page, 'GET', `/calendar/slots?date=${targetDate()}`);
  expect(res.status).toBe(200);
  return res.body.filter(s => s.workOrderId === woId);
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

async function pickPlannedStart(page: Page, card: Locator, hour: string, nextMonth: boolean) {
  const popup = await openPicker(page, card, 'Дата та час початку');
  if (nextMonth) {
    await popup.getByRole('button', { name: /next|наступн/i }).click();
    await popup.locator(`[data-day="${targetDate()}"] button`).click();
  }
  await popup.getByLabel('Година').selectOption(hour);
  await popup.getByLabel('Хвилини').selectOption('00');
  await popup.getByRole('button', { name: 'Готово' }).click();
  await expect(popup).toBeHidden();
}

const plannedHoursInput = (card: Locator) =>
  card.locator('label', { hasText: 'Нормогодин' }).first().locator('..').locator('input');

async function openWoCard(page: Page, number: string): Promise<Locator> {
  await page.goto('/work-orders');
  const row = page.locator('table tbody tr', { hasText: number }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.hover();
  await row.getByTitle('Відкрити наряд').click();
  const card = page.getByRole('dialog').filter({ hasText: number });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.locator('label', { hasText: 'Дата та час початку' }).first()).toBeVisible();
  return card;
}

async function dayView(page: Page) {
  await page.goto(`/calendar?view=day&date=${targetDate()}`);
  await expect(page.locator('h1:has-text("Календар")')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(`[data-lift-id="${state.liftA!.id}"]`)).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('Наряд у календарі — BR-WO-019 / BR-WO-020', () => {
  // Прибирання — запитами з Node (фікстура `request`) токеном першого тесту: сторінка й
  // завантаження `/work-orders` для цього не потрібні.
  test.afterAll(async ({ request }) => {
    const token = state.token;
    if (!token) return;
    // Наряди (DRAFT) — разом із записами календаря (BR-WO-017); далі авто → гараж → клієнт.
    for (const id of [state.woId, state.wo2Id]) {
      if (!id) continue;
      const res = await apiRequest(request, token, 'DELETE', `/work-orders/${id}`);
      expect.soft([200, 204, 404], `DELETE наряду ${id}`).toContain(res.status);
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

  test('наряд із плановими датами й підйомником через інтерфейс → запис у виді «День»', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.goto('/work-orders');
    await expect(page.getByRole('button', { name: /^Наряд$/ }).first()).toBeVisible({
      timeout: 30_000,
    });
    state.token = await getToken(page);

    // ── Передумови через API ─────────────────────────────────────────────
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

    // ── Наряд — через інтерфейс ───────────────────────────────────────────
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

    // BR-WO-019: у пікері минулі дні недоступні, сьогодні — лише години від поточної.
    const now = kyivNow();
    const yesterday = new Date(`${now.ymd}T12:00:00Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const popup = await openPicker(page, woModal, 'Дата та час початку');
    const yCell = popup.locator(`[data-day="${yesterday.toISOString().slice(0, 10)}"]`);
    if ((await yCell.count()) > 0) await expect(yCell).toHaveAttribute('data-disabled', 'true');
    const todayCell = popup.locator(`[data-day="${now.ymd}"]`);
    if ((await todayCell.getAttribute('data-disabled')) !== 'true') {
      await todayCell.locator('button').click();
      const hours = await popup
        .getByLabel('Година')
        .locator('option:not([disabled])')
        .evaluateAll(os => os.map(o => Number((o as HTMLOptionElement).value)));
      expect(Math.min(...hours), 'сьогодні — години не раніше поточної').toBeGreaterThanOrEqual(
        now.hour,
      );
    }
    await page.screenshot({ path: test.info().outputPath('c15_e2e_picker_past.png') });
    await popup.getByRole('button', { name: 'Готово' }).click();
    await pickPlannedStart(page, woModal, '11', true);
    // Автокінець за нормогодинами: 11:00 + 2 год.
    await plannedHoursInput(woModal).fill('2');
    await expect(
      woModal
        .locator('label', { hasText: 'Дата та час завершення' })
        .first()
        .locator('..')
        .locator('input'),
    ).toHaveValue(new RegExp(`${targetDate().split('-').reverse().join('.')} 13:00`));
    await woModal.getByPlaceholder('Заміна масла, колодок...').fill('000 E2E наряд у календарі');
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

    // ── Запис календаря: рівно один, підйомник A, 11:00–13:00 ──────────────
    const slots = await woSlots(page, state.woId);
    expect(slots).toHaveLength(1);
    expect(slots[0].liftId).toBe(state.liftA!.id);
    expect([kyivHHMM(slots[0].startAt), kyivHHMM(slots[0].endAt)]).toEqual(['11:00', '13:00']);
    state.anchorId = slots[0].id;

    await dayView(page);
    await expect(
      page.locator(`[data-lift-id="${state.liftA!.id}"] [data-calendar-slot]`, {
        hasText: state.woNumber,
      }),
    ).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: test.info().outputPath('c15_e2e_created_day.png') });
  });

  test('зміна дат і підйомника в картці наряду → запис переїхав', async ({ page }) => {
    test.setTimeout(150_000);
    test.skip(!state.woNumber, 'наряд не створено');
    const card = await openWoCard(page, state.woNumber!);
    await card.getByLabel('Підйомник').selectOption({ label: state.liftB!.name });
    await pickPlannedStart(page, card, '15', false);
    await plannedHoursInput(card).fill('2');
    await card.getByRole('button', { name: 'Зберегти зміни' }).click();
    await expect(card).toBeHidden({ timeout: 20_000 });

    await expect
      .poll(async () => (await woSlots(page, state.woId!)).map(s => s.liftId))
      .toEqual([state.liftB!.id]);
    const [slot] = await woSlots(page, state.woId!);
    expect(slot.id, 'той самий запис переїхав, а не новий').toBe(state.anchorId);
    expect([kyivHHMM(slot.startAt), kyivHHMM(slot.endAt)]).toEqual(['15:00', '17:00']);

    await dayView(page);
    await expect(
      page.locator(`[data-lift-id="${state.liftB!.id}"] [data-calendar-slot]`, {
        hasText: state.woNumber!,
      }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.locator(`[data-lift-id="${state.liftA!.id}"] [data-calendar-slot]`, {
        hasText: state.woNumber!,
      }),
    ).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('c15_e2e_moved_day.png') });
  });

  test('стерті планові дати → запис наряду зник із календаря', async ({ page }) => {
    test.setTimeout(150_000);
    test.skip(!state.woNumber, 'наряд не створено');
    const card = await openWoCard(page, state.woNumber!);
    await card
      .getByRole('button', { name: 'Очистити дату: Дата та час завершення' })
      .first()
      .click();
    await card.getByRole('button', { name: 'Очистити дату: Дата та час початку' }).first().click();
    await card.getByRole('button', { name: 'Зберегти зміни' }).click();
    await expect(card).toBeHidden({ timeout: 20_000 });

    await expect.poll(async () => (await woSlots(page, state.woId!)).length).toBe(0);
    await dayView(page);
    await expect(page.locator('[data-calendar-slot]', { hasText: state.woNumber! })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('c15_e2e_cleared_day.png') });
  });

  test('наряд, створений із форми запису календаря, має рівно один запис', async ({ page }) => {
    test.setTimeout(180_000);
    test.skip(!state.cpId, 'клієнта не створено');
    await dayView(page);
    await page.getByRole('button', { name: 'Слот', exact: true }).click();
    const form = page
      .locator('div.rounded-xl')
      .filter({ has: page.locator('h3', { hasText: /Новий слот/ }) })
      .last();
    await expect(form).toBeVisible({ timeout: 10_000 });
    await form.getByLabel(/Підйомник/).selectOption({ label: state.liftA!.name });
    const popup = await openPicker(page, form, 'Початок');
    await popup.getByLabel('Година').selectOption('09');
    await popup.getByLabel('Хвилини').selectOption('00');
    await popup.getByRole('button', { name: 'Готово' }).click();
    await form.locator('label', { hasText: 'Норм-год' }).locator('..').locator('input').fill('1');
    await form.getByPlaceholder('Пошук клієнта…').fill(CLIENT);
    await page.getByRole('option', { name: new RegExp(CLIENT) }).click();
    await expect(
      form.locator('select', { has: page.locator(`option:has-text("${PLATE}")`) }),
    ).toHaveCount(1, { timeout: 10_000 });

    // «+» біля поля «Наряд» — картка нового наряду з датами й підйомником запису.
    await form.getByTitle('Новий наряд').click();
    const woModal = page.getByRole('dialog').filter({ hasText: 'Новий наряд' });
    await expect(woModal).toBeVisible({ timeout: 20_000 });
    await woModal.getByRole('button', { name: 'Створити наряд' }).click();
    await expect(woModal).toBeHidden({ timeout: 20_000 });
    // Форма запису закривається сама: запис наряду створив сервер.
    await expect(form).toBeHidden({ timeout: 15_000 });

    const list = await api<{ items: { id: string; number: string }[] }>(
      page,
      'GET',
      `/work-orders?counterpartyId=${state.cpId}&limit=5`,
    );
    const wo2 = list.body.items.find(w => w.id !== state.woId);
    expect(wo2, 'наряд із форми запису створено').toBeTruthy();
    state.wo2Id = wo2!.id;
    state.wo2Number = wo2!.number;
    const slots = await woSlots(page, state.wo2Id);
    expect(slots, 'рівно один запис наряду — без дубля').toHaveLength(1);
    expect(slots[0].liftId).toBe(state.liftA!.id);
    expect([kyivHHMM(slots[0].startAt), kyivHHMM(slots[0].endAt)]).toEqual(['09:00', '10:00']);
    await expect(page.locator('[data-calendar-slot]', { hasText: state.wo2Number })).toHaveCount(
      1,
      { timeout: 15_000 },
    );
    await page.screenshot({ path: test.info().outputPath('c15_e2e_from_slot_form.png') });
  });
});
