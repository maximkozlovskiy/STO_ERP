import { test, expect, type Locator, type Page } from '@playwright/test';
import { apiCall, apiRequest, getToken } from './api-helpers';
import { weekdayOfNextMonth } from './work-days';

test.use({ storageState: 'e2e/.auth/admin.json', viewport: { width: 1280, height: 960 } });
test.describe.configure({ mode: 'serial' });

/**
 * Зміна багатоденного РУЧНОГО запису як ланцюжка (BR-CAL-020; рішення власника 2026-11-13,
 * TECH-DEBT (б) №92), через браузер:
 *  1. запис на 3 дні формою «+ Слот»; у «Дні» другого дня ручок внутрішніх меж немає, з другого
 *     дня форма показує межі всього ланцюжка; нові нормогодини — 4 частини, останній день новий;
 *  2. перетягування частини (другого дня) на годину пізніше зсуває весь ланцюжок.
 *
 * Запис — формою, перетягування — мишею; підйомник і години його філії — передумови й перевірки
 * через API. Дати — понеділок…четвер: найближчий понеділок від 16-го дня пн–чт наступного місяця
 * (`weekdayOfNextMonth`), щоб усі чотири дні були робочими й не збігались з датами інших спеків.
 */

const uid = Date.now().toString().slice(-6);
const NOTE = `000 E2E ланцюжок-зміна ${uid}`;

const DAY_MS = 86_400_000;
/** Понеділок і три наступні дні, 'YYYY-MM-DD'. */
const days = (): [string, string, string, string] => {
  let t = Date.parse(`${weekdayOfNextMonth(16)}T12:00:00Z`);
  while (new Date(t).getUTCDay() !== 1) t += DAY_MS;
  const at = (i: number) => new Date(t + i * DAY_MS).toISOString().slice(0, 10);
  return [at(0), at(1), at(2), at(3)];
};
const dmy = (ymd: string) => ymd.split('-').reverse().join('.');
const pad = (n: number) => String(n).padStart(2, '0');
const kyivLocal = (iso: string) =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(new Date(iso))
    .replace(' ', 'T');

interface SlotDto {
  id: string;
  liftId?: string | null;
  parentSlotId?: string | null;
  notes?: string | null;
  startAt: string;
  endAt: string;
  chainDays?: number;
  chainStartAt?: string;
  chainEndAt?: string;
}

const state: {
  token?: string;
  lift?: { id: string; name: string; branchId?: string };
  hours?: { start: number; end: number };
  anchorId?: string;
} = {};

async function api<T = unknown>(page: Page, method: string, path: string, body?: unknown) {
  return apiCall<T>(page, state.token ?? (await getToken(page)), method, path, body);
}

async function slotsOn(page: Page, date: string): Promise<SlotDto[]> {
  const res = await api<SlotDto[]>(page, 'GET', `/calendar/slots?date=${date}`);
  expect(res.status).toBe(200);
  return res.body;
}

/** Частини ланцюжка тесту за днями: [день, початок, кінець] за київським часом. */
async function chainParts(page: Page): Promise<[string, string, string][]> {
  const out: [string, string, string][] = [];
  for (const d of days()) {
    for (const s of (await slotsOn(page, d)).filter(x => x.notes === NOTE))
      out.push([d, kyivLocal(s.startAt).slice(11), kyivLocal(s.endAt).slice(11)]);
  }
  return out;
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

const chainBlock = (page: Page) =>
  page.locator(`[data-lift-id="${state.lift!.id}"] [data-calendar-slot]`, { hasText: NOTE });
const handles = (block: Locator) => block.locator('[data-part^="resize-"]');

const slotForm = (page: Page, title: RegExp) =>
  page
    .locator('div.rounded-xl')
    .filter({ has: page.locator('h3', { hasText: title }) })
    .last();
const field = (form: Locator, label: string | RegExp) =>
  form.locator('label', { hasText: label }).first().locator('..').locator('input');

test.describe('Зміна багатоденного ручного запису як ланцюжка — BR-CAL-020', () => {
  test.afterAll(async ({ request }) => {
    if (!state.token || !state.anchorId) return;
    const res = await apiRequest(
      request,
      state.token,
      'DELETE',
      `/calendar/slots/${state.anchorId}`,
    );
    expect.soft([200, 204, 404], 'DELETE ланцюжка').toContain(res.status);
  });

  test('запис на 3 дні; з другого дня форма — межі ланцюжка; новий кінець → 4 частини', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const [mon, tue, wed, thu] = days();
    await page.goto('/calendar');
    await expect(page.locator('h1:has-text("Календар")')).toBeVisible({ timeout: 30_000 });
    state.token = await getToken(page);

    // ── Передумови: підйомник, вільний усі чотири дні, і години його філії ──
    const lifts = await api<{ id: string; name: string; branchId?: string }[]>(
      page,
      'GET',
      '/lifts',
    );
    const busy = new Set<string | null | undefined>();
    for (const d of days()) for (const s of await slotsOn(page, d)) busy.add(s.liftId);
    const free = lifts.body.filter(l => !busy.has(l.id));
    state.lift = free.find(l => !l.name.startsWith('E2E')) ?? free[0];
    expect(state.lift, 'потрібен підйомник, вільний пн–чт').toBeTruthy();
    const wh = await api<{ workStartHour: number; workEndHour: number }>(
      page,
      'GET',
      `/settings/work-hours?branchId=${state.lift!.branchId}`,
    );
    expect(wh.status).toBe(200);
    const { workStartHour: open, workEndHour: close } = wh.body;
    state.hours = { start: open, end: close };
    const full = close - open;

    // ── Запис на 3 дні формою «+ Слот»: пн 2 год до закриття, вт цілий, ср 2 год ──
    await dayView(page, mon);
    await page.getByRole('button', { name: 'Слот', exact: true }).click();
    const create = slotForm(page, /Новий слот/);
    await expect(create).toBeVisible({ timeout: 10_000 });
    await create.getByLabel('Тип запису').selectOption({ label: 'Обслуговування' });
    await create.getByLabel(/Підйомник/).selectOption({ label: state.lift!.name });
    const startPopup = await openPicker(page, create, 'Початок');
    await startPopup.getByLabel('Година').selectOption(pad(close - 2));
    await startPopup.getByLabel('Хвилини').selectOption('00');
    await startPopup.getByRole('button', { name: 'Готово' }).click();
    await field(create, 'Норм-год').fill(String(4 + full));
    await field(create, 'Нотатки').fill(NOTE);
    await expect(create.getByTestId('slot-split-warning')).toContainText('Буде розбито на 3 дні');
    await create.getByRole('button', { name: 'Зберегти' }).click();
    await expect(create).toBeHidden({ timeout: 15_000 });

    expect(await chainParts(page)).toEqual([
      [mon, `${pad(close - 2)}:00`, `${pad(close)}:00`],
      [tue, `${pad(open)}:00`, `${pad(close)}:00`],
      [wed, `${pad(open)}:00`, `${pad(open + 2)}:00`],
    ]);
    state.anchorId = (await slotsOn(page, mon)).find(s => s.notes === NOTE)!.id;

    // ── «День» другого дня: ручок внутрішніх меж немає; форма — межі всього ланцюжка ──
    await dayView(page, tue);
    const middle = chainBlock(page);
    await expect(middle).toBeVisible({ timeout: 15_000 });
    await expect(handles(middle)).toHaveCount(0);
    await middle.locator('[data-part="content"]').click();
    const edit = slotForm(page, /Редагування слоту/);
    await expect(edit).toBeVisible({ timeout: 10_000 });
    await expect(field(edit, 'Початок')).toHaveValue(`${dmy(mon)} ${pad(close - 2)}:00`);
    await expect(field(edit, /^Кінець$/)).toHaveValue(`${dmy(wed)} ${pad(open + 2)}:00`);
    await expect(field(edit, 'Норм-год')).toHaveValue(String(4 + full));
    await expect(edit.getByTestId('slot-split-warning')).toContainText('Буде розбито на 3 дні');

    // Новий кінець — чт: ще цілий день (ср) і 2 год четверга.
    await field(edit, 'Норм-год').fill(String(4 + 2 * full));
    await expect(field(edit, /^Кінець$/)).toHaveValue(`${dmy(thu)} ${pad(open + 2)}:00`);
    await expect(edit.getByTestId('slot-split-warning')).toContainText('Буде розбито на 4 дні');
    await page.screenshot({ path: test.info().outputPath('chain_edit_form.png') });
    await edit.getByRole('button', { name: 'Оновити', exact: true }).click();
    await expect(edit).toBeHidden({ timeout: 15_000 });

    expect(await chainParts(page)).toEqual([
      [mon, `${pad(close - 2)}:00`, `${pad(close)}:00`],
      [tue, `${pad(open)}:00`, `${pad(close)}:00`],
      [wed, `${pad(open)}:00`, `${pad(close)}:00`],
      [thu, `${pad(open)}:00`, `${pad(open + 2)}:00`],
    ]);
    const last = (await slotsOn(page, thu)).find(s => s.notes === NOTE)!;
    expect(last).toMatchObject({ parentSlotId: state.anchorId, chainDays: 4 });

    // Останній день — лише ручка кінця.
    await dayView(page, thu);
    await expect(chainBlock(page)).toBeVisible({ timeout: 15_000 });
    await expect(handles(chainBlock(page))).toHaveCount(1);
    await expect(chainBlock(page).locator('[data-part="resize-end"]')).toHaveCount(1);
  });

  test('перетягування частини другого дня на годину пізніше зсуває весь ланцюжок', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    test.skip(!state.anchorId, 'ланцюжок не створено');
    const [mon, tue, wed, thu] = days();
    const { start: open, end: close } = state.hours!;
    const full = close - open;

    await dayView(page, tue);
    const block = chainBlock(page);
    await expect(block).toBeVisible({ timeout: 15_000 });
    await block.scrollIntoViewIfNeeded();
    // Блок вівторка — цілий робочий день: година — його ширина / кількість годин.
    const box = (await block.boundingBox())!;
    const x = box.x + Math.min(20, box.width / 2);
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 4, y, { steps: 4 });
    await page.mouse.move(x + box.width / full, y, { steps: 16 });
    await page.mouse.up();

    await expect
      .poll(() => chainParts(page), { timeout: 15_000 })
      .toEqual([
        [mon, `${pad(close - 1)}:00`, `${pad(close)}:00`],
        [tue, `${pad(open)}:00`, `${pad(close)}:00`],
        [wed, `${pad(open)}:00`, `${pad(close)}:00`],
        [thu, `${pad(open)}:00`, `${pad(open + 3)}:00`],
      ]);
    const parts = (await Promise.all([mon, tue, wed, thu].map(d => slotsOn(page, d))))
      .flat()
      .filter(s => s.notes === NOTE);
    // Продовження не відірвались від якоря: усі — частини того самого ланцюжка.
    expect(parts.map(s => s.parentSlotId ?? s.id)).toEqual(Array(4).fill(state.anchorId));
    await page.screenshot({ path: test.info().outputPath('chain_edit_dragged.png') });
  });
});
