import { test, expect, type Locator, type Page } from '@playwright/test';
import { apiCall, apiRequest, getToken } from './api-helpers';
import { weekdayOfNextMonth } from './work-days';

test.use({ storageState: 'e2e/.auth/admin.json', viewport: { width: 1280, height: 960 } });
test.describe.configure({ mode: 'serial' });

/**
 * Одноденний ручний запис ділиться на дні й при зміні (BR-CAL-020; рішення власника 2026-11-14,
 * TECH-DEBT (б) №96), через браузер: запис на 2 години до закриття формою «+ Слот» — одна частина;
 * у формі зміни нові нормогодини дають кінець наступного дня з підказкою «Буде розбито на 2 дні»,
 * «Оновити» — 2 частини (якір і продовження).
 *
 * Запис — формою, підйомник і години його філії — передумови й перевірки через API. Дата — 1-й
 * день пн–чт наступного місяця (`work-days.ts`), наступний день теж робочий.
 */

const uid = Date.now().toString().slice(-6);
const NOTE = `000 E2E одноденний-поділ ${uid}`;

const DAY_MS = 86_400_000;
/** День запису і наступний, 'YYYY-MM-DD'. */
const days = (): [string, string] => {
  const d = weekdayOfNextMonth(1);
  return [d, new Date(Date.parse(`${d}T12:00:00Z`) + DAY_MS).toISOString().slice(0, 10)];
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
}

const state: {
  token?: string;
  lift?: { id: string; name: string; branchId?: string };
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

/** Частини запису тесту: [день, початок, кінець, продовження?] за київським часом. */
async function parts(page: Page): Promise<[string, string, string, boolean][]> {
  const out: [string, string, string, boolean][] = [];
  for (const d of days())
    for (const s of (await slotsOn(page, d)).filter(x => x.notes === NOTE))
      out.push([d, kyivLocal(s.startAt).slice(11), kyivLocal(s.endAt).slice(11), !!s.parentSlotId]);
  return out;
}

const slotForm = (page: Page, title: RegExp) =>
  page
    .locator('div.rounded-xl')
    .filter({ has: page.locator('h3', { hasText: title }) })
    .last();
const field = (form: Locator, label: string | RegExp) =>
  form.locator('label', { hasText: label }).first().locator('..').locator('input');

test.describe('Одноденний ручний запис ділиться й при зміні — BR-CAL-020 (№96)', () => {
  test.afterAll(async ({ request }) => {
    if (!state.token || !state.anchorId) return;
    const res = await apiRequest(
      request,
      state.token,
      'DELETE',
      `/calendar/slots/${state.anchorId}`,
    );
    expect.soft([200, 204, 404], 'DELETE запису').toContain(res.status);
  });

  // guards: BR-CAL-020
  test('запис на 2 год до закриття; у формі кінець наступного дня → 2 частини', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const [day, next] = days();
    await page.goto('/calendar');
    await expect(page.locator('h1:has-text("Календар")')).toBeVisible({ timeout: 30_000 });
    state.token = await getToken(page);

    // ── Передумови: підйомник, вільний обидва дні, і години його філії ──
    const lifts = await api<{ id: string; name: string; branchId?: string }[]>(
      page,
      'GET',
      '/lifts',
    );
    const busy = new Set<string | null | undefined>();
    for (const d of days()) for (const s of await slotsOn(page, d)) busy.add(s.liftId);
    const free = lifts.body.filter(l => !busy.has(l.id) && !l.name.startsWith('000 E2E'));
    state.lift = free.find(l => !l.name.startsWith('E2E')) ?? free[0];
    expect(state.lift, 'потрібен підйомник, вільний обидва дні').toBeTruthy();
    const wh = await api<{ workStartHour: number; workEndHour: number }>(
      page,
      'GET',
      `/settings/work-hours?branchId=${state.lift!.branchId}`,
    );
    expect(wh.status).toBe(200);
    const { workStartHour: open, workEndHour: close } = wh.body;

    // ── Запис формою «+ Слот»: 2 год до закриття — одна частина ──
    await page.goto(`/calendar?view=day&date=${day}`);
    await expect(page.locator(`[data-lift-id="${state.lift!.id}"]`)).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole('button', { name: 'Слот', exact: true }).click();
    const create = slotForm(page, /Новий слот/);
    await expect(create).toBeVisible({ timeout: 10_000 });
    await create.getByLabel('Тип запису').selectOption({ label: 'Обслуговування' });
    await create.getByLabel(/Підйомник/).selectOption({ label: state.lift!.name });
    await field(create, 'Початок').click();
    const popup = page
      .locator('div.shadow-lg')
      .filter({ has: page.getByRole('button', { name: 'Готово' }) });
    await expect(popup).toBeVisible({ timeout: 5_000 });
    await popup.getByLabel('Година').selectOption(pad(close - 2));
    await popup.getByLabel('Хвилини').selectOption('00');
    await popup.getByRole('button', { name: 'Готово' }).click();
    await field(create, 'Норм-год').fill('2');
    await field(create, 'Нотатки').fill(NOTE);
    await expect(create.getByTestId('slot-split-warning')).toHaveCount(0);
    await create.getByRole('button', { name: 'Зберегти' }).click();
    await expect(create).toBeHidden({ timeout: 15_000 });
    expect(await parts(page)).toEqual([[day, `${pad(close - 2)}:00`, `${pad(close)}:00`, false]]);
    state.anchorId = (await slotsOn(page, day)).find(s => s.notes === NOTE)!.id;

    // ── Форма зміни: 4 нормогодини — кінець наступного дня, підказка «2 дні» ──
    const block = page.locator(`[data-lift-id="${state.lift!.id}"] [data-calendar-slot]`, {
      hasText: NOTE,
    });
    await expect(block).toBeVisible({ timeout: 15_000 });
    await block.locator('[data-part="content"]').click();
    const edit = slotForm(page, /Редагування слоту/);
    await expect(edit).toBeVisible({ timeout: 10_000 });
    await field(edit, 'Норм-год').fill('4');
    await expect(field(edit, /^Кінець$/)).toHaveValue(`${dmy(next)} ${pad(open + 2)}:00`);
    await expect(edit.getByTestId('slot-split-warning')).toContainText('Буде розбито на 2 дні');
    await page.screenshot({ path: test.info().outputPath('one_day_split_form.png') });
    await edit.getByRole('button', { name: 'Оновити', exact: true }).click();
    await expect(edit).toBeHidden({ timeout: 15_000 });

    // Якір лишився на своєму дні, продовження — наступного дня від відкриття.
    await expect
      .poll(() => parts(page), { timeout: 10_000 })
      .toEqual([
        [day, `${pad(close - 2)}:00`, `${pad(close)}:00`, false],
        [next, `${pad(open)}:00`, `${pad(open + 2)}:00`, true],
      ]);
    expect((await slotsOn(page, day)).find(s => s.notes === NOTE)!.id).toBe(state.anchorId);
    await page.goto(`/calendar?view=day&date=${next}`);
    await expect(block).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: test.info().outputPath('one_day_split_next_day.png') });
  });
});
