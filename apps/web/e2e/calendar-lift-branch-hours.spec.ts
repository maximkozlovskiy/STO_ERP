import { test, expect, type Locator, type Page } from '@playwright/test';
import { apiCall, apiRequest, getToken } from './api-helpers';
import { ensureVehicleModel } from './vehicle-directory';

test.use({ storageState: 'e2e/.auth/admin.json', viewport: { width: 1280, height: 960 } });
test.describe.configure({ mode: 'serial' });

/**
 * Зміна підйомника на підйомник ІНШОЇ філії зберігає нормогодини (BR-CAL-020; рішення власника
 * 2026-11-14, TECH-DEBT (б) №98), через браузер: ручний запис пт 17:00 на 4 нормогодини на
 * підйомнику філії пн–пт (09–18) — пт 17–18 і пн 09–12; у формі обрано підйомник філії пн–сб —
 * «Кінець» сб 12:00, ті самі 4 год, і сервер зберігає пт 17–18 + сб 09–12 (а не межі пт – пн, що
 * дали б 13 год із робочою суботою).
 *
 * Те саме в картці наряду (BR-WO-040): пт 17:00 + 3 нормогодини на підйомнику філії пн–пт — пн
 * 11:00; підйомник філії пн–сб — «Завершення» сб 11:00, нормогодини ті самі; збережений наряд і
 * його запис — за ними.
 *
 * Запис, наряд і їхня зміна — формою й карткою; передумови через API: дві філії (типові
 * налаштування — пн–пт 09:00–18:00, BR-CAL-017; другій — робоча субота), їхні зони й підйомники,
 * клієнт і авто. Дата — друга п'ятниця наступного місяця (перша — у work-order-lift-branch).
 */

const uid = Date.now().toString().slice(-6);
const NOTE = `000 E2E нормогодини-філія ${uid}`;
const BRANCH_A = `000 E2E Філія пн-пт ${uid}`;
const BRANCH_B = `000 E2E Філія пн-сб ${uid}`;
const LIFT_A = `000 E2E П-пн-пт ${uid}`;
const LIFT_B = `000 E2E П-пн-сб ${uid}`;
const CLIENT = `000 E2E Нормогодини філії ${uid}`;
const PLATE = `NH${uid.slice(-5)}`;
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

/** Друга п'ятниця наступного місяця, субота й понеділок після неї, 'YYYY-MM-DD'. */
function friSatMon(): [string, string, string] {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(new Date());
  const [y, m] = today.split('-').map(Number) as [number, number];
  let t = Date.UTC(y, m, 1); // m — 1-based, тож це 1-ше число наступного місяця
  while (new Date(t).getUTCDay() !== 5) t += DAY_MS;
  t += 7 * DAY_MS;
  return [ymdOf(t), ymdOf(t + DAY_MS), ymdOf(t + 3 * DAY_MS)];
}

interface SlotDto {
  id: string;
  liftId?: string | null;
  parentSlotId?: string | null;
  notes?: string | null;
  startAt: string;
  endAt: string;
}

const state: {
  token?: string;
  branchA?: string;
  branchB?: string;
  zoneA?: string;
  zoneB?: string;
  liftA?: string;
  liftB?: string;
  anchorId?: string;
  cpId?: string;
  garageId?: string;
  vehicleId?: string;
  woId?: string;
} = {};

async function api<T = unknown>(page: Page, method: string, path: string, body?: unknown) {
  return apiCall<T>(page, state.token ?? (await getToken(page)), method, path, body);
}

/** Частини запису тесту за днями: [день, підйомник, початок, кінець] за київським часом. */
async function parts(page: Page): Promise<[string, string | null | undefined, string, string][]> {
  const out: [string, string | null | undefined, string, string][] = [];
  for (const d of friSatMon()) {
    const res = await api<SlotDto[]>(page, 'GET', `/calendar/slots?date=${d}`);
    expect(res.status).toBe(200);
    for (const s of res.body.filter(x => x.notes === NOTE))
      out.push([d, s.liftId, kyivHHMM(s.startAt), kyivHHMM(s.endAt)]);
  }
  return out;
}

/** Філія з типовими налаштуваннями, її зона й підйомник; повертає id. */
async function branchWithLift(page: Page, branch: string, lift: string) {
  const b = await api<{ id: string }>(page, 'POST', '/branches', {
    name: branch,
    address: '000 E2E адреса',
  });
  expect(b.status).toBe(201);
  const zone = await api<{ id: string }>(page, 'POST', '/zones', {
    branchId: b.body.id,
    name: `000 E2E Зона ${branch}`,
    type: 'MECHANICAL',
  });
  expect(zone.status).toBe(201);
  const l = await api<{ id: string }>(page, 'POST', '/lifts', {
    zoneId: zone.body.id,
    name: lift,
    type: 'TWO_POST',
  });
  expect(l.status).toBe(201);
  return { branchId: b.body.id, zoneId: zone.body.id, liftId: l.body.id };
}

async function openPicker(page: Page, scope: Locator, label: string): Promise<Locator> {
  await scope.locator('label', { hasText: label }).first().locator('..').locator('input').click();
  const popup = page
    .locator('div.shadow-lg')
    .filter({ has: page.getByRole('button', { name: 'Готово' }) });
  await expect(popup).toBeVisible({ timeout: 5_000 });
  return popup;
}

const slotForm = (page: Page, title: RegExp) =>
  page
    .locator('div.rounded-xl')
    .filter({ has: page.locator('h3', { hasText: title }) })
    .last();
const field = (form: Locator, label: string | RegExp) =>
  form.locator('label', { hasText: label }).first().locator('..').locator('input');

test.describe('Підйомник іншої філії зберігає нормогодини — BR-CAL-020 (№98)', () => {
  test.afterAll(async ({ request }) => {
    const token = state.token;
    if (!token) return;
    const del = async (path: string, what: string) => {
      const res = await apiRequest(request, token, 'DELETE', path);
      expect.soft([200, 204, 404], `DELETE ${what}`).toContain(res.status);
    };
    // Наряд (DRAFT, разом із записом, BR-WO-017) → авто → гараж → клієнт; запис (увесь
    // ланцюжок) → підйомники → зони → філії.
    if (state.woId) await del(`/work-orders/${state.woId}`, 'наряду');
    if (state.vehicleId) await del(`/vehicles/${state.vehicleId}`, 'авто');
    if (state.garageId)
      await del(`/counterparties/${state.cpId}/garages/${state.garageId}`, 'гаража');
    if (state.cpId) await del(`/counterparties/${state.cpId}`, 'клієнта');
    if (state.anchorId) await del(`/calendar/slots/${state.anchorId}`, 'запису');
    if (state.liftA) await del(`/lifts/${state.liftA}`, 'підйомника А');
    if (state.liftB) await del(`/lifts/${state.liftB}`, 'підйомника Б');
    if (state.zoneA) await del(`/zones/${state.zoneA}`, 'зони А');
    if (state.zoneB) await del(`/zones/${state.zoneB}`, 'зони Б');
    if (state.branchA) await del(`/branches/${state.branchA}`, 'філії А');
    if (state.branchB) await del(`/branches/${state.branchB}`, 'філії Б');
  });

  // guards: BR-CAL-020
  test('запис пт 17:00 на 4 год (пт + пн) → підйомник філії пн–сб → пт + сб, ті самі 4 год', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const [fri, sat, mon] = friSatMon();
    await page.goto('/calendar');
    await expect(page.locator('h1:has-text("Календар")')).toBeVisible({ timeout: 30_000 });
    state.token = await getToken(page);

    // ── Передумови через API: філія пн–пт і філія пн–сб, кожна з зоною й підйомником ──
    const a = await branchWithLift(page, BRANCH_A, LIFT_A);
    Object.assign(state, { branchA: a.branchId, zoneA: a.zoneId, liftA: a.liftId });
    const b = await branchWithLift(page, BRANCH_B, LIFT_B);
    Object.assign(state, { branchB: b.branchId, zoneB: b.zoneId, liftB: b.liftId });
    const sixDays = await api(page, 'PATCH', `/settings/branch/${state.branchB}`, {
      workDays: [1, 2, 3, 4, 5, 6],
    });
    expect(sixDays.status).toBe(200);
    for (const [branchId, days] of [
      [state.branchA, [1, 2, 3, 4, 5]],
      [state.branchB, [1, 2, 3, 4, 5, 6]],
    ] as const) {
      const wh = await api<{ workStartHour: number; workEndHour: number; workDays: number[] }>(
        page,
        'GET',
        `/settings/work-hours?branchId=${branchId}`,
      );
      expect(wh.body).toMatchObject({ workStartHour: 9, workEndHour: 18, workDays: days });
    }

    // ── Запис формою «+ Слот»: пт 17:00, 4 нормогодини на підйомнику філії пн–пт ──
    await page.goto(`/calendar?view=day&date=${fri}`);
    await expect(page.locator('h1:has-text("Календар")')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Слот', exact: true }).click();
    const create = slotForm(page, /Новий слот/);
    await expect(create).toBeVisible({ timeout: 10_000 });
    await create.getByLabel('Тип запису').selectOption({ label: 'Обслуговування' });
    await create.getByLabel(/Підйомник/).selectOption({ label: LIFT_A });
    const startPopup = await openPicker(page, create, 'Початок');
    await startPopup.getByLabel('Година').selectOption('17');
    await startPopup.getByLabel('Хвилини').selectOption('00');
    await startPopup.getByRole('button', { name: 'Готово' }).click();
    await field(create, 'Норм-год').fill('4');
    await field(create, 'Нотатки').fill(NOTE);
    await expect(field(create, /^Кінець$/)).toHaveValue(`${dmy(mon)} 12:00`);
    await expect(create.getByTestId('slot-split-warning')).toContainText('Буде розбито на 2 дні');
    await create.getByRole('button', { name: 'Зберегти' }).click();
    await expect(create).toBeHidden({ timeout: 15_000 });

    expect(await parts(page)).toEqual([
      [fri, state.liftA, '17:00', '18:00'],
      [mon, state.liftA, '09:00', '12:00'],
    ]);
    state.anchorId = (await api<SlotDto[]>(page, 'GET', `/calendar/slots?date=${fri}`)).body.find(
      s => s.notes === NOTE,
    )!.id;

    // ── Форма запису: підйомник філії пн–сб — «Кінець» сб 12:00, ті самі 4 нормогодини ──
    await page.goto(`/calendar?view=day&date=${fri}`);
    const block = page.locator(`[data-lift-id="${state.liftA}"] [data-calendar-slot]`, {
      hasText: NOTE,
    });
    await expect(block).toBeVisible({ timeout: 20_000 });
    await block.locator('[data-part="content"]').click();
    const edit = slotForm(page, /Редагування слоту/);
    await expect(edit).toBeVisible({ timeout: 10_000 });
    await expect(field(edit, /^Кінець$/)).toHaveValue(`${dmy(mon)} 12:00`);
    await expect(field(edit, 'Норм-год')).toHaveValue('4');

    await edit.getByLabel(/Підйомник/).selectOption({ label: LIFT_B });
    await expect(field(edit, /^Кінець$/)).toHaveValue(`${dmy(sat)} 12:00`);
    await expect(field(edit, 'Норм-год')).toHaveValue('4');
    await expect(edit.getByTestId('slot-split-warning')).toContainText('Буде розбито на 2 дні');
    await page.screenshot({ path: test.info().outputPath('lift_branch_hours_form.png') });
    await edit.getByRole('button', { name: 'Оновити', exact: true }).click();
    await expect(edit).toBeHidden({ timeout: 15_000 });

    expect(await parts(page)).toEqual([
      [fri, state.liftB, '17:00', '18:00'],
      [sat, state.liftB, '09:00', '12:00'],
    ]);
  });

  // guards: BR-WO-040
  test('картка наряду: пт 17:00 + 3 год на філії пн–пт → підйомник філії пн–сб → сб 11:00', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    test.skip(!state.liftB, 'філії не створено');
    const [fri, sat, mon] = friSatMon();
    await page.goto('/work-orders');
    await expect(page.getByRole('button', { name: /^Наряд$/ }).first()).toBeVisible({
      timeout: 30_000,
    });

    // Запис попереднього тесту займає підйомник Б у ті самі пт і сб — прибрати (увесь ланцюжок).
    if (state.anchorId) {
      const del = await api(page, 'DELETE', `/calendar/slots/${state.anchorId}`);
      expect([200, 204]).toContain(del.status);
      state.anchorId = undefined;
    }

    // ── Передумови через API: клієнт, гараж, авто ──
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

    // ── Наряд — через картку: підйомник філії пн–пт, пт 17:00 + 3 нормогодини ──
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
    await woModal.getByLabel('Підйомник').selectOption({ label: LIFT_A });
    await expect(woModal.getByLabel(/^Філія/)).toHaveValue(state.branchA!);

    const popup = await openPicker(page, woModal, 'Дата та час початку');
    await popup.getByRole('button', { name: /next|наступн/i }).click();
    await popup.locator(`[data-day="${fri}"] button`).click();
    await popup.getByLabel('Година').selectOption('17');
    await popup.getByLabel('Хвилини').selectOption('00');
    await popup.getByRole('button', { name: 'Готово' }).click();
    await expect(popup).toBeHidden();
    const normo = field(woModal, 'Нормогодин').first();
    await normo.fill('3');
    const end = field(woModal, 'Дата та час завершення');
    await expect(end).toHaveValue(`${dmy(mon)} 11:00`);

    // №98: підйомник філії пн–сб — ті самі 3 нормогодини від пт 17:00 за її днями — сб 11:00.
    await woModal.getByLabel('Підйомник').selectOption({ label: LIFT_B });
    await expect(woModal.getByLabel(/^Філія/)).toHaveValue(state.branchB!);
    await expect(end).toHaveValue(`${dmy(sat)} 11:00`);
    await expect(normo).toHaveValue('3');
    await page.screenshot({ path: test.info().outputPath('lift_branch_hours_card.png') });
    await woModal
      .getByPlaceholder('Заміна масла, колодок...')
      .fill('000 E2E наряд нормогодин філії');
    await woModal.getByRole('button', { name: 'Створити наряд' }).click();
    await expect(woModal).toBeHidden({ timeout: 20_000 });

    const list = await api<{
      items: { id: string; branchId: string; dueDate: string; plannedHours: number | null }[];
    }>(page, 'GET', `/work-orders?counterpartyId=${state.cpId}&limit=5`);
    expect(list.body.items).toHaveLength(1);
    const created = list.body.items[0]!;
    state.woId = created.id;
    expect(created).toMatchObject({ branchId: state.branchB, plannedHours: 3 });
    expect([kyivYmd(created.dueDate), kyivHHMM(created.dueDate)]).toEqual([sat, '11:00']);
    const slots = (
      await api<(SlotDto & { workOrderId?: string | null })[]>(
        page,
        'GET',
        `/calendar/slots?from=${fri}&to=${mon}`,
      )
    ).body
      .filter(s => s.workOrderId === state.woId)
      .sort((a, b) => a.startAt.localeCompare(b.startAt));
    expect(
      slots.map(s => [s.liftId, kyivYmd(s.startAt), kyivHHMM(s.startAt), kyivHHMM(s.endAt)]),
    ).toEqual([
      [state.liftB, fri, '17:00', '18:00'],
      [state.liftB, sat, '09:00', '11:00'],
    ]);
  });
});
