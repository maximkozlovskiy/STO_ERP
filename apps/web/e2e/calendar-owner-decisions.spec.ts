import { test, expect, type Locator, type Page } from '@playwright/test';
import { apiCall, getToken } from './api-helpers';
import { createCounterparty } from './cash-desk.helpers';
import { createEmployeeViaUi } from './employee-ui';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/**
 * Календар — рішення власника 2026-10-16 на справжньому наряді, через браузер:
 *  1. механік відкриває картку наряду — довідники картки читаються без 403 (employee.md);
 *  2. перетягування запису з механіком на підйомник, за яким механік не закріплений, знімає
 *     механіка з повідомленням (BR-CAL-012);
 *  3. видалення наряду прибирає його запис із календаря й звільняє підйомник: у той самий час на
 *     тому самому підйомнику створюється новий запис (BR-WO-017, BR-CAL-011).
 *
 * За правилом власника документи — через інтерфейс: НАРЯД створюється й видаляється в списку
 * нарядів, ЗАПИСИ календаря — формою «+ Слот», переміщення — мишею, МЕХАНІК і його закріплення за
 * підйомником — сторінкою «Співробітники» (рішення власника 2026-10-19). Клієнт і авто — передумови
 * через API. Дата — 12-те число наступного місяця.
 */

const uid = Date.now().toString().slice(-6);
const CLIENT = `000 E2E Календар рішення ${uid}`;
const MECH_LAST = `000 E2E ${uid}`;
const MECH_NAME = `${MECH_LAST} Механік`;
// Пароль механіка — лише в пам'яті прогону.
const MECH_PASSWORD = `E2e-${Math.random().toString(36).slice(2, 10)}`;
const MECH_EMAIL = `e2e-mech-${uid}@sto.local`;

const pad = (n: number) => String(n).padStart(2, '0');
const kyivToday = () =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(new Date());
function targetDate(): string {
  const [y, m] = kyivToday().split('-').map(Number);
  const next = new Date(Date.UTC(y, m, 12)); // m — 1-based, тож це наступний місяць
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-12`;
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
  employeeId?: string | null;
  employeeName?: string | null;
  workOrderId?: string | null;
  counterpartyId?: string | null;
  startAt: string;
  endAt: string;
}

const state: {
  token?: string;
  cpId?: string;
  vehicleId?: string;
  plate?: string;
  woId?: string;
  woNumber?: string;
  employeeId?: string;
  liftA?: { id: string; name: string };
  liftB?: { id: string; name: string };
  slotIds: string[];
} = { slotIds: [] };

function slotForm(page: Page, title: RegExp): Locator {
  return page
    .locator('div.rounded-xl')
    .filter({ has: page.locator('h3', { hasText: title }) })
    .last();
}

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

async function daySlots(page: Page, date: string): Promise<SlotDto[]> {
  const res = await apiCall<SlotDto[]>(page, state.token!, 'GET', `/calendar/slots?date=${date}`);
  expect(res.status).toBe(200);
  return res.body;
}

test.describe('Календар — рішення власника 2026-10-16', () => {
  test.afterAll(async ({ browser }) => {
    if (!state.token) return;
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const page = await ctx.newPage();
    await page.goto('/calendar');
    const token = state.token;
    // Записи на дату — і ті, id яких тест не встиг зібрати (клієнт або наряд тесту).
    const day = await apiCall<SlotDto[]>(
      page,
      token,
      'GET',
      `/calendar/slots?date=${targetDate()}`,
    );
    for (const s of Array.isArray(day.body) ? day.body : []) {
      const ours =
        (state.woId && s.workOrderId === state.woId) ||
        (state.cpId && s.counterpartyId === state.cpId);
      if (ours && !state.slotIds.includes(s.id)) state.slotIds.push(s.id);
    }
    for (const id of state.slotIds) {
      const res = await apiCall(page, token, 'DELETE', `/calendar/slots/${id}`);
      // 404 — запис уже видалено разом із нарядом (BR-WO-017).
      expect.soft([200, 204, 404], `DELETE слота ${id}`).toContain(res.status);
    }
    if (state.woId) {
      const res = await apiCall(page, token, 'DELETE', `/work-orders/${state.woId}`);
      expect.soft([200, 204, 404], 'DELETE наряду').toContain(res.status);
    }
    if (state.vehicleId) {
      const res = await apiCall(page, token, 'DELETE', `/vehicles/${state.vehicleId}`);
      expect.soft(res.status, 'DELETE авто').toBeLessThan(300);
    }
    if (state.cpId) {
      const res = await apiCall(page, token, 'DELETE', `/counterparties/${state.cpId}`);
      expect.soft(res.status, 'DELETE клієнта').toBeLessThan(300);
    }
    if (state.employeeId) {
      const res = await apiCall(page, token, 'DELETE', `/employees/${state.employeeId}`);
      expect.soft(res.status, 'DELETE механіка').toBeLessThan(300);
    }
    await ctx.close();
  });

  test('передумови й наряд через інтерфейс; механік відкриває картку наряду без 403', async ({
    page,
    browser,
  }) => {
    test.setTimeout(180_000);
    await page.goto('/work-orders');
    await expect(page.getByRole('button', { name: /^Наряд$/ }).first()).toBeVisible({
      timeout: 30_000,
    });
    const token = await getToken(page);
    state.token = token;

    // ── Передумови через API: клієнт, авто ──
    state.cpId = await createCounterparty(page, token, 'CLIENT', CLIENT);
    const garage = await apiCall<{ id: string }>(
      page,
      token,
      'POST',
      `/counterparties/${state.cpId}/garages`,
      { name: '000 E2E гараж' },
    );
    expect(garage.status).toBe(201);
    state.plate = `E2E${uid.slice(-5)}`;
    const vehicle = await apiCall<{ id: string }>(page, token, 'POST', '/vehicles', {
      customerGarageId: garage.body.id,
      make: 'Toyota',
      model: 'Corolla',
      licensePlate: state.plate,
    });
    expect(vehicle.status).toBe(201);
    state.vehicleId = vehicle.body.id;

    const lifts = await apiCall<{ id: string; name: string }[]>(page, token, 'GET', '/lifts');
    expect(lifts.body.length, 'потрібні два підйомники').toBeGreaterThanOrEqual(2);
    [state.liftA, state.liftB] = lifts.body;

    // ── Механік із входом, закріплений за підйомником A, — сторінкою «Співробітники» ──
    state.employeeId = await createEmployeeViaUi(page, {
      firstName: 'Механік',
      lastName: MECH_LAST,
      login: { email: MECH_EMAIL, password: MECH_PASSWORD },
      liftNames: [state.liftA!.name],
    });
    const mech = await apiCall<{ liftIds: string[] }>(
      page,
      token,
      'GET',
      `/employees/${state.employeeId}`,
    );
    expect(mech.body.liftIds, 'механік закріплений за підйомником A').toEqual([state.liftA!.id]);

    // ── Наряд — через інтерфейс ───────────────────────────────────────────
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
    await expect(vehicleSelect.locator('option', { hasText: state.plate })).toHaveCount(1, {
      timeout: 10_000,
    });
    await vehicleSelect.selectOption({ label: `Toyota Corolla (${state.plate})` });
    await woModal.getByPlaceholder('Заміна масла, колодок...').fill('000 E2E рішення календаря');
    await woModal.getByRole('button', { name: 'Створити наряд' }).click();
    await expect(woModal).toBeHidden({ timeout: 20_000 });
    const list = await apiCall<{ items: { id: string; number: string }[] }>(
      page,
      token,
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

    // ── Механік входить і відкриває картку наряду ─────────────────────────
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const mp = await ctx.newPage();
    const forbidden: string[] = [];
    mp.on('response', r => {
      if (r.status() === 403) forbidden.push(`${r.request().method()} ${r.url()}`);
    });
    mp.on('console', m => {
      if (m.type() === 'error' && m.text().includes('403')) forbidden.push(`console: ${m.text()}`);
    });
    await mp.goto('/login');
    await mp.getByLabel('Email').fill(MECH_EMAIL);
    await mp.getByLabel('Пароль').fill(MECH_PASSWORD);
    await mp.getByRole('button', { name: 'Увійти' }).click();
    await expect(mp).not.toHaveURL(/\/login/, { timeout: 30_000 });
    await mp.goto('/work-orders');
    // Механіку список відкривається на «Мої наряди» — наряд тесту не його, фільтр вимикаємо.
    const mine = mp.getByRole('button', { name: 'Мої наряди' });
    await expect(mine).toBeVisible({ timeout: 30_000 });
    await mine.click();
    const row = mp.locator('table tbody tr', { hasText: state.woNumber }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.hover();
    await row.getByTitle('Відкрити наряд').click();
    const card = mp.getByRole('dialog').filter({ hasText: state.woNumber });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card).toContainText(CLIENT);
    // Довідники картки (механіки, налаштування, ставки ПДВ, договори) — без 403.
    await mp.waitForLoadState('networkidle');
    await mp.screenshot({ path: test.info().outputPath('cal13_mechanic_card.png') });
    expect(forbidden, 'запити з 403 під механіком').toEqual([]);
    await ctx.close();
  });

  test('перетягування запису з механіком на підйомник, де він не закріплений, знімає механіка', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    test.skip(!state.woNumber, 'наряд не створено');
    const date = targetDate();
    const { liftA, liftB } = state as Required<typeof state>;

    // ── Запис із нарядом і механіком на підйомнику A — формою «+ Слот» ──────
    await page.goto(`/calendar?view=day&date=${date}`);
    await expect(page.locator('h1:has-text("Календар")')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Слот', exact: true }).click();
    const form = slotForm(page, /Новий слот/);
    await expect(form).toBeVisible({ timeout: 10_000 });
    await form.getByLabel(/Підйомник/).selectOption({ label: liftA.name });
    await pickStart(page, form, '10');
    await form.locator('label', { hasText: 'Норм-год' }).locator('..').locator('input').fill('1');
    await form.getByPlaceholder('Пошук наряду…').fill(state.woNumber!);
    await page.getByRole('option', { name: new RegExp(state.woNumber!) }).click();
    const mechSelect = form.getByLabel('Механік');
    await expect(mechSelect.locator('option', { hasText: MECH_NAME })).toHaveCount(1, {
      timeout: 10_000,
    });
    await mechSelect.selectOption({ label: MECH_NAME });
    await form.getByRole('button', { name: 'Зберегти', exact: true }).click();
    await expect(form).toBeHidden({ timeout: 15_000 });
    const created = (await daySlots(page, date)).filter(s => s.workOrderId === state.woId);
    state.slotIds.push(...created.map(s => s.id));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ liftId: liftA.id, employeeId: state.employeeId });

    // ── Перетягування мишею в рядок підйомника B ──────────────────────────
    const block = page.locator('[data-calendar-slot]', { hasText: state.woNumber! });
    await expect(block.locator('[data-part="mechanic"]')).toHaveText(`Механік: ${MECH_NAME}`, {
      timeout: 15_000,
    });
    const from = (await block.boundingBox())!;
    const rowB = (await page.locator(`[data-lift-id="${liftB.id}"]`).boundingBox())!;
    const x = from.x + Math.min(20, from.width / 2);
    await page.mouse.move(x, from.y + from.height / 2);
    await page.mouse.down();
    // Кроками: dnd-kit починає перетягування після зсуву вказівника.
    await page.mouse.move(x, from.y + from.height / 2 + 12, { steps: 4 });
    await page.mouse.move(x, rowB.y + rowB.height / 2, { steps: 12 });
    await page.mouse.up();

    await expect(
      page.getByText(`Механіка знято: ${MECH_NAME} не закріплений за підйомником «${liftB.name}»`),
    ).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => (await daySlots(page, date)).find(s => s.id === created[0].id))
      .toMatchObject({ liftId: liftB.id, employeeId: null });
    const moved = page.locator('[data-calendar-slot]', { hasText: state.woNumber! });
    await expect(moved).toBeVisible({ timeout: 15_000 });
    await expect(moved.locator('[data-part="mechanic"]')).toHaveCount(0);
    const after = (await daySlots(page, date)).find(s => s.id === created[0].id)!;
    expect(kyivHHMM(after.startAt)).toBe('10:00');
    await page.screenshot({ path: test.info().outputPath('cal13_dnd_mechanic_dropped.png') });
  });

  test('видалення наряду в списку прибирає його запис із календаря й звільняє підйомник', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    test.skip(!state.woNumber, 'наряд не створено');
    const date = targetDate();
    const { liftB } = state as Required<typeof state>;
    const before = (
      await (async () => {
        await page.goto('/work-orders');
        return daySlots(page, date);
      })()
    ).filter(s => s.workOrderId === state.woId);
    expect(before, 'запис наряду перед видаленням').toHaveLength(1);
    expect(before[0].liftId).toBe(liftB.id);

    // ── Наряд — «Позначити на видалення» у списку ─────────────────────────
    const row = page.locator('table tbody tr', { hasText: state.woNumber! }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.hover();
    await row.getByTitle('Позначити на видалення').click();
    const confirmBtn = page.locator('[role="dialog"] button:has-text("Так")').first();
    await expect(confirmBtn).toBeVisible({ timeout: 8_000 });
    await confirmBtn.click();
    await expect(
      page.locator('table tbody tr:not(.opacity-60)', { hasText: state.woNumber! }),
    ).toHaveCount(0, { timeout: 15_000 });
    await expect
      .poll(async () => {
        const wo = await apiCall<{ deletedAt?: string | null }>(
          page,
          state.token!,
          'GET',
          `/work-orders/${state.woId}?withDeleted=true`,
        );
        return wo.status === 404 || !!wo.body?.deletedAt;
      })
      .toBe(true);

    // ── Календар: запису видаленого наряду немає ──────────────────────────
    await page.goto(`/calendar?view=day&date=${date}`);
    await expect(page.locator('h1:has-text("Календар")')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(`[data-lift-id="${liftB.id}"]`)).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-calendar-slot]', { hasText: state.woNumber! })).toHaveCount(0);
    expect((await daySlots(page, date)).filter(s => s.workOrderId === state.woId)).toEqual([]);

    // ── Новий запис у той самий час на тому самому підйомнику ──────────────
    await page.getByRole('button', { name: 'Слот', exact: true }).click();
    const form = slotForm(page, /Новий слот/);
    await expect(form).toBeVisible({ timeout: 10_000 });
    await form.getByLabel(/Підйомник/).selectOption({ label: liftB.name });
    await pickStart(page, form, '10');
    await form.locator('label', { hasText: 'Норм-год' }).locator('..').locator('input').fill('1');
    await form.getByPlaceholder('Пошук клієнта…').fill(CLIENT);
    await page.getByRole('option', { name: new RegExp(CLIENT) }).click();
    await form.getByRole('button', { name: 'Зберегти', exact: true }).click();
    await expect(form).toBeHidden({ timeout: 15_000 });
    const fresh = (await daySlots(page, date)).filter(s => s.counterpartyId === state.cpId);
    state.slotIds.push(...fresh.map(s => s.id));
    expect(fresh, 'новий запис на звільненому підйомнику').toHaveLength(1);
    expect(fresh[0].liftId).toBe(liftB.id);
    expect(kyivHHMM(fresh[0].startAt)).toBe('10:00');
    await page.screenshot({ path: test.info().outputPath('cal13_deleted_wo_new_slot.png') });
  });
});
