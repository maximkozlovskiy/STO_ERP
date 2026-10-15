import { test, expect, type Locator, type Page } from '@playwright/test';
import { apiCall as rawApiCall, createCounterparty, getToken } from './cash-desk.helpers';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/**
 * Календар, вид «Місяць» — картки записів (BR-CAL-009) на справжньому наряді.
 *
 * За правилом власника документи тестуються через браузер: НАРЯД створюється через інтерфейс
 * («Наряд» → картка), ЗАПИС календаря з цим нарядом — через «+ Слот» і вибір наряду у формі,
 * потім час запису редагується у формі. Клієнт і авто — лише передумови, їх створює API.
 * Дата — 10-те число наступного місяця: завжди в майбутньому, тож запис редагується.
 */

const uid = Date.now().toString().slice(-6);
const CLIENT = `000 E2E Календар місяць ${uid}`;

const pad = (n: number) => String(n).padStart(2, '0');
const kyivToday = () =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(new Date());
function targetDate(): string {
  const [y, m] = kyivToday().split('-').map(Number);
  const next = new Date(Date.UTC(y, m, 10)); // m — 1-based, тож це наступний місяць
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-10`;
}
const dmy = (iso: string) => iso.split('-').reverse().join('.');
/** Київський час HH:mm моменту ISO. */
const kyivHHMM = (iso: string) =>
  new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));

/**
 * Запит до API з повтором на 429. Ліміт API — 200 запитів/хв на IP, а вид «Місяць» робить
 * 32 запити за завантаження: поряд з іншими спеками ліміт вичерпується, і без повтору
 * прибирання в `afterAll` мовчки не видаляло запис — наступний прогін падав на «Підйомник
 * вже зайнятий».
 */
async function apiCall<T = unknown>(
  page: Page,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  for (let attempt = 0; ; attempt++) {
    const res = await rawApiCall<T>(page, token, method, path, body);
    if (res.status !== 429 || attempt >= 12) return res;
    await page.waitForTimeout(5_000);
  }
}

interface SlotDto {
  id: string;
  workOrderId?: string | null;
  workOrderStatus?: string | null;
  workOrderNumber?: string;
  startAt: string;
  endAt: string;
}

const state: {
  token?: string;
  cpId?: string;
  woId?: string;
  woNumber?: string;
  slotIds: string[];
} = { slotIds: [] };

/** Форма запису календаря (вбудована над сіткою) — за її заголовком. */
function slotForm(page: Page, title: RegExp): Locator {
  return page
    .locator('div.rounded-xl')
    .filter({ has: page.locator('h3', { hasText: title }) })
    .last();
}

/** Час «Початок» у формі запису: попап дати-часу → година й хвилина → «Готово». */
async function pickStart(page: Page, form: Locator, hour: string) {
  await form.locator('label', { hasText: 'Початок' }).locator('..').locator('input').click();
  const popup = page
    .locator('div.shadow-lg')
    .filter({ has: page.getByRole('button', { name: 'Готово' }) });
  await expect(popup).toBeVisible({ timeout: 5_000 });
  await popup.locator('select').nth(0).selectOption(hour);
  await popup.locator('select').nth(1).selectOption('00');
  await popup.getByRole('button', { name: 'Готово' }).click();
  await expect(popup).toBeHidden();
}

async function daySlots(page: Page, token: string, date: string): Promise<SlotDto[]> {
  const res = await apiCall<SlotDto[]>(page, token, 'GET', `/calendar/slots?date=${date}`);
  expect(res.status).toBe(200);
  return res.body;
}

test.describe('Календар «Місяць» — картки записів із нарядом (BR-CAL-009)', () => {
  test.afterAll(async ({ browser }) => {
    if (!state.token) return;
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const page = await ctx.newPage();
    await page.goto('/calendar');
    // Записи наряду шукаються й за датою: тест міг упасти між збереженням форми і збором id.
    if (state.woId) {
      const day = await apiCall<SlotDto[]>(
        page,
        state.token,
        'GET',
        `/calendar/slots?date=${targetDate()}`,
      );
      for (const s of Array.isArray(day.body) ? day.body : []) {
        if (s.workOrderId === state.woId && !state.slotIds.includes(s.id)) state.slotIds.push(s.id);
      }
    }
    // Статуси перевіряються: мовчазний збій прибирання лишав би записи в базі (так і було з
    // `crud-calendar-slot.spec.ts`, що видаляв `undefined`).
    for (const id of state.slotIds) {
      const res = await apiCall(page, state.token, 'DELETE', `/calendar/slots/${id}`);
      expect(res.status, `DELETE слота ${id}`).toBeLessThan(300);
    }
    // Наряд створено чернеткою, і його ніхто не переводив — чернетку можна видалити.
    if (state.woId) {
      const res = await apiCall(page, state.token, 'DELETE', `/work-orders/${state.woId}`);
      expect(res.status, 'DELETE наряду-чернетки').toBeLessThan(300);
    }
    if (state.cpId) {
      const res = await apiCall(page, state.token, 'DELETE', `/counterparties/${state.cpId}`);
      expect(res.status, 'DELETE клієнта').toBeLessThan(300);
    }
    await ctx.close();
  });

  test('наряд → запис через «+ Слот» → зміна часу → картка в місяці → легенда «?»', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const date = targetDate();

    // ── Передумови через API: клієнт і його авто ──────────────────────────────
    await page.goto('/work-orders');
    await expect(page.getByRole('button', { name: /^Наряд$/ }).first()).toBeVisible({
      timeout: 30_000,
    });
    const token = await getToken(page);
    state.token = token;
    state.cpId = await createCounterparty(page, token, 'CLIENT', CLIENT);
    const garage = await apiCall<{ id: string }>(
      page,
      token,
      'POST',
      `/counterparties/${state.cpId}/garages`,
      { name: '000 E2E гараж' },
    );
    expect(garage.status, `гараж: ${JSON.stringify(garage.body)}`).toBe(201);
    const plate = `E2E${uid.slice(-5)}`;
    const vehicle = await apiCall<{ id: string }>(page, token, 'POST', '/vehicles', {
      customerGarageId: garage.body.id,
      make: 'Toyota',
      model: 'Corolla',
      licensePlate: plate,
    });
    expect(vehicle.status, `авто: ${JSON.stringify(vehicle.body)}`).toBe(201);

    // ── 1. Наряд — через інтерфейс ───────────────────────────────────────────
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
    await expect(vehicleSelect.locator('option', { hasText: plate })).toHaveCount(1, {
      timeout: 10_000,
    });
    await vehicleSelect.selectOption({ label: `Toyota Corolla (${plate})` });
    await woModal.getByPlaceholder('Заміна масла, колодок...').fill('000 E2E запис календаря');
    await woModal.getByRole('button', { name: 'Створити наряд' }).click();
    await expect(woModal).toBeHidden({ timeout: 20_000 });

    const list = await apiCall<{ items: { id: string; number: string; status: string }[] }>(
      page,
      token,
      'GET',
      `/work-orders?counterpartyId=${state.cpId}&limit=5`,
    );
    expect(list.body.items, 'наряд, створений через інтерфейс').toHaveLength(1);
    const [wo] = list.body.items;
    state.woId = wo.id;
    state.woNumber = wo.number;
    expect(wo.status).toBe('DRAFT');
    // Після створення сторінка відкриває картку наряду — закриваємо її.
    const woCard = page.getByRole('dialog').filter({ hasText: wo.number });
    await expect(woCard).toBeVisible({ timeout: 20_000 });
    await woCard.getByRole('button', { name: 'Закрити' }).last().click();
    await expect(woCard).toBeHidden({ timeout: 10_000 });

    // ── 2. Запис календаря з цим нарядом — «+ Слот» у виді «День» ─────────────
    await page.goto(`/calendar?view=day&date=${date}`);
    await expect(page.locator('h1:has-text("Календар")')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Слот', exact: true }).click();
    const newForm = slotForm(page, /Новий слот/);
    await expect(newForm).toBeVisible({ timeout: 10_000 });
    await newForm
      .locator('label', { hasText: 'Підйомник' })
      .locator('..')
      .locator('select')
      .selectOption({ index: 1 });
    await pickStart(page, newForm, '14');
    await newForm
      .locator('label', { hasText: 'Норм-год' })
      .locator('..')
      .locator('input')
      .fill('1');
    await newForm.getByPlaceholder('Пошук наряду…').fill(wo.number);
    await page.getByRole('option', { name: new RegExp(wo.number) }).click();
    await newForm.getByRole('button', { name: 'Зберегти', exact: true }).click();
    await expect(newForm).toBeHidden({ timeout: 15_000 });

    const created = (await daySlots(page, token, date)).filter(s => s.workOrderId === wo.id);
    state.slotIds.push(...created.map(s => s.id));
    expect(created, 'запис календаря з нарядом').toHaveLength(1);
    expect(kyivHHMM(created[0].startAt)).toBe('14:00');
    expect(kyivHHMM(created[0].endAt)).toBe('15:00');

    // ── 3. Редагування запису: час 14:00 → 15:00 ─────────────────────────────
    const block = page.locator('[data-calendar-slot]', { hasText: wo.number });
    await expect(block).toBeVisible({ timeout: 15_000 });
    await block.locator('span', { hasText: wo.number }).click();
    const editForm = slotForm(page, /Редагування слоту/);
    await expect(editForm).toBeVisible({ timeout: 10_000 });
    await pickStart(page, editForm, '15');
    await editForm
      .locator('label', { hasText: 'Норм-год' })
      .locator('..')
      .locator('input')
      .fill('1');
    await editForm.getByRole('button', { name: 'Оновити', exact: true }).click();
    await expect(editForm).toBeHidden({ timeout: 15_000 });
    const edited = (await daySlots(page, token, date)).filter(s => s.workOrderId === wo.id);
    expect(edited).toHaveLength(1);
    expect(kyivHHMM(edited[0].startAt)).toBe('15:00');
    expect(kyivHHMM(edited[0].endAt)).toBe('16:00');

    // ── 3a. Вид «День»: підсумок дня за іконками і легенда «?» (BR-CAL-008) ──
    const dayRow = page.getByTestId('day-categories');
    await expect(dayRow).toBeVisible({ timeout: 10_000 });
    // Число — з тих самих денних записів, що їх віддає API (у dev-базі можуть бути й чужі).
    const drafts = (await daySlots(page, token, date)).filter(
      s => s.workOrderStatus === 'DRAFT',
    ).length;
    await expect(dayRow.getByRole('img', { name: `Чернетка: ${drafts}` })).toBeVisible();
    await page.getByRole('button', { name: 'Пояснення іконок календаря' }).click();
    const dayLegend = page.getByRole('dialog', { name: 'Що означають іконки' });
    await expect(dayLegend).toBeVisible();
    await expect(dayLegend).toContainText('Без наряду');
    await page.locator('h1', { hasText: 'Календар' }).click();
    await expect(dayLegend).toBeHidden();

    // ── 4. Вид «Місяць»: картка з номером наряду в потрібному дні ─────────────
    await page.getByRole('button', { name: 'Місяць', exact: true }).click();
    const cell = page.locator(`[data-date="${date}"]`);
    const card = cell.getByTestId('month-slot-card').filter({ hasText: wo.number });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toHaveAttribute('data-category', 'draft');
    await expect(card).toContainText('15:00');
    await expect(card).toContainText(CLIENT);

    // Клік по картці відкриває САМЕ цей запис на його дату — у тій самій формі.
    await card.click();
    const fromMonth = slotForm(page, /Редагування слоту/);
    await expect(fromMonth).toBeVisible({ timeout: 10_000 });
    await expect(
      fromMonth.locator('label', { hasText: 'Початок' }).locator('..').locator('input'),
    ).toHaveValue(`${dmy(date)} 15:00`);
    await expect(fromMonth).toContainText(wo.number);
    await expect(page).toHaveURL(new RegExp(`view=month.*date=${date}|date=${date}.*view=month`));
    await fromMonth.getByRole('button', { name: 'Скасувати', exact: true }).click();
    await expect(fromMonth).toBeHidden({ timeout: 10_000 });

    // ── 5. Легенда «?» ───────────────────────────────────────────────────────
    await page.getByRole('button', { name: 'Пояснення іконок календаря' }).click();
    const legend = page.getByRole('dialog', { name: 'Що означають іконки' });
    await expect(legend).toBeVisible();
    await expect(legend).toContainText('Прострочено');
    await expect(legend).toContainText('Чернетка');
    await page.keyboard.press('Escape');
    await expect(legend).toBeHidden();

    // ── 6. Дія клітинки «Відкрити день» → вид «День» на цю дату ──────────────
    await cell.hover();
    await cell.getByRole('button', { name: `Відкрити день ${dmy(date)}` }).click();
    await expect(page).toHaveURL(new RegExp(`date=${date}`));
    await expect(page).toHaveURL(/view=day/);
    await expect(page.locator('[data-calendar-slot]', { hasText: wo.number })).toBeVisible({
      timeout: 15_000,
    });
  });
});
