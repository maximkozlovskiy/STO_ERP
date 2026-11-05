import { test, expect, type Locator, type Page } from '@playwright/test';
import { apiCall, apiRequest, getToken } from './api-helpers';
import { ensureVehicleModel } from './vehicle-directory';

// Вище за типові 720 px: попап пікера відкривається лише вниз (як у work-order-calendar-record).
test.use({ storageState: 'e2e/.auth/admin.json', viewport: { width: 1280, height: 960 } });
test.describe.configure({ mode: 'serial' });

/**
 * Вихідні філії в планових датах наряду й розбитті запису по днях (рішення власника 2026-10-30,
 * BR-WO-019, BR-CAL-016), через браузер: у картці нового наряду вихідний день у пікері
 * недоступний, автокінець за нормогодинами переходить через вихідний на наступний робочий день,
 * а запис календаря наряду має відрізки лише в робочі дні.
 *
 * Наряд — через інтерфейс (список нарядів → «Наряд»), клієнт і авто — передумови через API.
 * Робочі дні — з `GET /settings/work-hours` основної філії (сід і dev — пн–сб): дата — перший
 * вихідний наступного місяця, перед яким робочий день. Філія без вихідних — тест пропускається.
 */

const uid = Date.now().toString().slice(-6);
const CLIENT = `000 E2E Вихідні філії ${uid}`;
const PLATE = `WF${uid.slice(-5)}`;
const DAY_MS = 86_400_000;

const ymdOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const isoDay = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay() || 7;
const dmy = (ymd: string) => ymd.split('-').reverse().join('.');
const pad = (n: number) => String(n).padStart(2, '0');
const kyivYmd = (iso: string) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(new Date(iso));
const kyivHHMM = (iso: string) =>
  new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));

interface WorkHours {
  workStartHour: number;
  workEndHour: number;
  workDays?: number[];
}
interface SlotDto {
  id: string;
  liftId?: string | null;
  workOrderId?: string | null;
  startAt: string;
  endAt: string;
}

const state: {
  token?: string;
  cpId?: string;
  garageId?: string;
  vehicleId?: string;
  woId?: string;
  hours?: WorkHours;
  /** Робочий день перед вихідним, вихідний і наступний робочий день. */
  before?: string;
  off?: string;
  after?: string;
  lift?: { id: string; name: string };
} = {};

async function api<T = unknown>(page: Page, method: string, path: string, body?: unknown) {
  return apiCall<T>(page, state.token ?? (await getToken(page)), method, path, body);
}

/** Перший вихідний наступного місяця (з 2-го числа), перед яким робочий день. */
function pickDates(workDays: number[]): { before: string; off: string; after: string } | null {
  const work = new Set(workDays);
  if (work.size === 0 || work.size === 7) return null;
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(new Date());
  const [y, m] = today.split('-').map(Number) as [number, number];
  for (let d = 2; d <= 20; d++) {
    const t = Date.UTC(y, m, d); // m — 1-based, тож це наступний місяць
    if (work.has(isoDay(ymdOf(t))) || !work.has(isoDay(ymdOf(t - DAY_MS)))) continue;
    let a = t + DAY_MS;
    while (!work.has(isoDay(ymdOf(a)))) a += DAY_MS;
    return { before: ymdOf(t - DAY_MS), off: ymdOf(t), after: ymdOf(a) };
  }
  return null;
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

const field = (scope: Locator, label: string) =>
  scope.locator('label', { hasText: label }).first().locator('..').locator('input');

test.describe('Вихідні філії — планові дати наряду й запис календаря (BR-WO-019, BR-CAL-016)', () => {
  test.afterAll(async ({ request }) => {
    const token = state.token;
    if (!token) return;
    // Наряд (DRAFT) — разом із записами календаря (BR-WO-017); далі авто → гараж → клієнт.
    if (state.woId) {
      const res = await apiRequest(request, token, 'DELETE', `/work-orders/${state.woId}`);
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

  // guards: BR-WO-019, BR-CAL-016
  test('картка наряду: вихідний недоступний, автокінець і запис календаря — через вихідний', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.goto('/work-orders');
    await expect(page.getByRole('button', { name: /^Наряд$/ }).first()).toBeVisible({
      timeout: 30_000,
    });
    state.token = await getToken(page);

    // ── Робочі дні основної філії → дати ─────────────────────────────────
    const wh = await api<WorkHours>(page, 'GET', '/settings/work-hours');
    expect(wh.status).toBe(200);
    expect(Array.isArray(wh.body.workDays), 'GET /settings/work-hours віддає workDays').toBe(true);
    state.hours = wh.body;
    const dates = pickDates(wh.body.workDays ?? []);
    test.skip(!dates, 'основна філія без вихідних — перевіряти нічого');
    Object.assign(state, dates);
    const { before, off, after } = state as Required<typeof state>;
    const startHour = wh.body.workEndHour - 1; // за годину до закриття
    const endHourExpected = wh.body.workStartHour + 2; // 1 год у день «до» + 2 год у день «після»

    // ── Передумови через API: клієнт, гараж, авто; підйомник, вільний на ці дні ──
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
    const range = await api<SlotDto[]>(page, 'GET', `/calendar/slots?from=${before}&to=${after}`);
    expect(range.status).toBe(200);
    const busy = new Set(range.body.map(s => s.liftId));
    const free = lifts.body.filter(l => !l.name.startsWith('000 E2E') && !busy.has(l.id));
    expect(free.length, 'потрібен підйомник, вільний на ці дні').toBeGreaterThanOrEqual(1);
    state.lift = free[0];

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
    await woModal.getByLabel('Підйомник').selectOption({ label: state.lift.name });

    // BR-WO-019: вихідний у пікері недоступний, робочі дні поруч — доступні.
    const popup = await openPicker(page, woModal, 'Дата та час початку');
    await popup.getByRole('button', { name: /next|наступн/i }).click();
    await expect(popup.locator(`[data-day="${off}"]`)).toHaveAttribute('data-disabled', 'true');
    await expect(popup.locator(`[data-day="${off}"] button`)).toBeDisabled();
    await expect(popup.locator(`[data-day="${before}"]`)).not.toHaveAttribute('data-disabled');
    await page.screenshot({ path: test.info().outputPath('wd_e2e_picker_day_off.png') });
    await popup.locator(`[data-day="${before}"] button`).click();
    await popup.getByLabel('Година').selectOption(pad(startHour));
    await popup.getByLabel('Хвилини').selectOption('00');
    await popup.getByRole('button', { name: 'Готово' }).click();
    await expect(popup).toBeHidden();

    // Автокінець: 1 год до закриття + 2 год — у наступний РОБОЧИЙ день, не у вихідний.
    await field(woModal, 'Нормогодин').fill('3');
    await expect(field(woModal, 'Дата та час завершення')).toHaveValue(
      `${dmy(after)} ${pad(endHourExpected)}:00`,
    );
    await page.screenshot({ path: test.info().outputPath('wd_e2e_autoend.png') });
    await woModal.getByPlaceholder('Заміна масла, колодок...').fill('000 E2E наряд через вихідний');
    await woModal.getByRole('button', { name: 'Створити наряд' }).click();
    await expect(woModal).toBeHidden({ timeout: 20_000 });

    const list = await api<{ items: { id: string; number: string }[] }>(
      page,
      'GET',
      `/work-orders?counterpartyId=${state.cpId}&limit=5`,
    );
    expect(list.body.items).toHaveLength(1);
    state.woId = list.body.items[0]!.id;
    const woNumber = list.body.items[0]!.number;
    const woCard = page.getByRole('dialog').filter({ hasText: woNumber });
    await expect(woCard).toBeVisible({ timeout: 20_000 });
    await woCard.getByRole('button', { name: 'Закрити' }).last().click();
    await expect(woCard).toBeHidden({ timeout: 10_000 });

    // ── BR-CAL-016: запис наряду — день «до» і день «після», вихідного немає ──
    const slots = (
      await api<SlotDto[]>(page, 'GET', `/calendar/slots?from=${before}&to=${after}`)
    ).body
      .filter(s => s.workOrderId === state.woId)
      .sort((a, b) => a.startAt.localeCompare(b.startAt));
    expect(slots.map(s => [kyivYmd(s.startAt), kyivHHMM(s.startAt), kyivHHMM(s.endAt)])).toEqual([
      [before, `${pad(startHour)}:00`, `${pad(wh.body.workEndHour)}:00`],
      [after, `${pad(wh.body.workStartHour)}:00`, `${pad(endHourExpected)}:00`],
    ]);

    // Вид «День»: у вихідний блоку наряду немає, у наступний робочий — є.
    const block = page.locator(`[data-lift-id="${state.lift.id}"] [data-calendar-slot]`, {
      hasText: woNumber,
    });
    await page.goto(`/calendar?view=day&date=${off}`);
    await expect(page.locator('h1:has-text("Календар")')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(`[data-lift-id="${state.lift.id}"]`)).toBeVisible({
      timeout: 15_000,
    });
    await expect(block).toHaveCount(0);
    await page.goto(`/calendar?view=day&date=${after}`);
    await expect(block).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: test.info().outputPath('wd_e2e_day_after.png') });
  });
});
