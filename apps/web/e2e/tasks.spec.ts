import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';
import { apiCall, apiRequest, getToken } from './api-helpers';
import { loginViaForm } from './fixtures';
import { createEmployeeViaUi } from './employee-ui';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/**
 * Задачі співробітникам (docs/objects/task.md) — сценарій власника 2026-10-26 через браузер:
 *  1. керівник (адміністратор) ставить задачу механіку на сторінці «Задачі» — із початком і
 *     терміном (BR-TASK-001, BR-TASK-004);
 *  2. механік (свій вхід) бачить у «Мої задачі» лише свої задачі (BR-TASK-002) і задачу — у смузі
 *     «Задачі» календаря; бере в роботу, коментує, завершує (BR-TASK-003, BR-TASK-008);
 *  3. керівник бачить статус «Виконана» й коментар механіка;
 *  4. запис календаря на той самий час, підйомник і механіка зберігається без конфлікту —
 *     задача не займає час (BR-TASK-007).
 *
 * Документи — через інтерфейс: задача — формою «Задача», статуси й коментар — карткою задачі,
 * запис календаря — формою «+ Слот», механік (з входом і підйомником) — сторінкою «Співробітники».
 * Через API — лише передумова «чужа задача» (задача іншому працівнику) і прибирання.
 */

const uid = Date.now().toString().slice(-6);
const TAG = `000 E2E ${uid}`;
const TITLE = `${TAG} Перевірити гальма`;
const FOREIGN_TITLE = `${TAG} Чужа задача`;
const COMMENT = `${TAG} гальма в нормі`;
const MEETING_NOTE = `${TAG} нарада`;
const MECH = { first: 'Механік', last: `${TAG} Задачі` };
const MECH_NAME = `${MECH.last} ${MECH.first}`;
// Пароль — лише в пам'яті прогону.
const MECH_LOGIN = {
  email: `e2e-task-mech-${uid}@sto.local`,
  password: `E2e-${Math.random().toString(36).slice(2, 10)}`,
};

const pad = (n: number) => String(n).padStart(2, '0');
/** 19-те число наступного місяця (Київ): день без чужих записів цього спеку й у майбутньому. */
function targetDate(): string {
  const ymd = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(new Date());
  const [y, m] = ymd.split('-').map(Number);
  const next = new Date(Date.UTC(y, m, 19));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-19`;
}
const kyivHHMM = (iso: string) =>
  new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));

interface TaskDto {
  id: string;
  title: string;
  status: string;
  assigneeId: string;
  startAt: string | null;
  dueAt: string | null;
}
interface SlotDto {
  id: string;
  liftId?: string | null;
  employeeId?: string | null;
  startAt: string;
  endAt: string;
  notes?: string | null;
}

const state: {
  token?: string;
  mechId?: string;
  taskId?: string;
  foreignTaskId?: string;
  slotId?: string;
  lift?: { id: string; name: string };
} = {};

async function api<T = unknown>(page: Page, method: string, path: string, body?: unknown) {
  return apiCall<T>(page, state.token ?? (await getToken(page)), method, path, body);
}

/** Попап пікера дати-часу поля `label` у `scope`: наступний місяць, день `date`, година `hour`. */
async function pickDateTime(page: Page, scope: Locator, label: string, date: string, hour: string) {
  await scope.locator('label', { hasText: label }).first().locator('..').locator('input').click();
  const popup = page
    .locator('div.shadow-lg')
    .filter({ has: page.getByRole('button', { name: 'Готово' }) });
  await expect(popup).toBeVisible({ timeout: 5_000 });
  await popup.getByRole('button', { name: /next|наступн/i }).click();
  await popup.locator(`[data-day="${date}"] button`).click();
  await popup.getByLabel('Година').selectOption(hour);
  await popup.getByLabel('Хвилини').selectOption('00');
  await popup.getByRole('button', { name: 'Готово' }).click();
  await expect(popup).toBeHidden();
}

async function openTaskCard(page: Page, title: string): Promise<Locator> {
  const card = page.getByRole('dialog').filter({ hasText: title });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.getByTestId('task-card')).toBeVisible({ timeout: 15_000 });
  return card;
}

async function mechanicPage(browser: Browser) {
  return loginViaForm(browser, MECH_LOGIN);
}

test.describe('Задачі співробітникам — керівник ставить, механік виконує', () => {
  // Прибирання з Node токеном адміністратора: коментарі (append-only, не йдуть за задачею) →
  // задачі → запис календаря → механік.
  test.afterAll(async ({ request }) => {
    const token = state.token;
    if (!token) return;
    const del = async (path: string, label: string) => {
      const res = await apiRequest(request, token, 'DELETE', path);
      expect.soft([200, 204, 404], `${label}: ${JSON.stringify(res.body)}`).toContain(res.status);
    };
    for (const id of [state.taskId, state.foreignTaskId]) {
      if (!id) continue;
      const comments = await apiRequest<{ items: { id: string }[] }>(
        request,
        token,
        'GET',
        `/comments?entityType=Task&entityId=${id}`,
      );
      for (const c of comments.body?.items ?? [])
        await del(`/comments/${c.id}`, 'DELETE коментаря');
      await del(`/tasks/${id}`, 'DELETE задачі');
    }
    if (state.slotId) await del(`/calendar/slots/${state.slotId}`, 'DELETE запису');
    if (state.mechId) await del(`/employees/${state.mechId}`, 'DELETE механіка');
  });

  test('керівник ставить задачу механіку через форму «Задача»', async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto('/tasks');
    await expect(page.getByRole('heading', { name: 'Задачі' })).toBeVisible({ timeout: 30_000 });
    state.token = await getToken(page);

    // Підйомник довідника, вільний 14:00–16:00 цільового дня — для запису в кроці 4.
    const lifts = await api<{ id: string; name: string }[]>(page, 'GET', '/lifts');
    const day = await api<SlotDto[]>(page, 'GET', `/calendar/slots?date=${targetDate()}`);
    const busy = (liftId: string) =>
      day.body.some(
        s => s.liftId === liftId && kyivHHMM(s.startAt) < '16:00' && kyivHHMM(s.endAt) > '14:00',
      );
    state.lift = lifts.body.filter(l => !l.name.startsWith('000 E2E')).find(l => !busy(l.id));
    expect(state.lift, 'потрібен підйомник, вільний 14:00–16:00').toBeTruthy();

    // Механік із входом і підйомником — сторінкою «Співробітники».
    await createEmployeeViaUi(page, {
      onCreated: id => {
        state.mechId = id;
      },
      firstName: MECH.first,
      lastName: MECH.last,
      login: MECH_LOGIN,
      liftNames: [state.lift!.name],
    });

    // Передумова «чужа задача» — задача адміністратору; механік її бачити не має.
    const me = await api<{ id: string }>(page, 'GET', '/auth/me');
    const foreign = await api<TaskDto>(page, 'POST', '/tasks', {
      title: FOREIGN_TITLE,
      assigneeId: me.body.id,
    });
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(201);
    state.foreignTaskId = foreign.body.id;

    // ── Задача — формою «Задача» на сторінці «Задачі» ──────────────────────
    await page.goto('/tasks');
    await page.getByRole('button', { name: 'Задача', exact: true }).click();
    const modal = page.getByRole('dialog').filter({ hasText: 'Нова задача' });
    await expect(modal).toBeVisible({ timeout: 10_000 });
    await modal.getByLabel('Що зробити').fill(TITLE);
    const assignee = modal.getByLabel('Виконавець');
    await expect(assignee.locator('option', { hasText: MECH_NAME })).toHaveCount(1, {
      timeout: 15_000,
    });
    await assignee.selectOption({ label: MECH_NAME });
    await modal.getByLabel('Пріоритет').selectOption({ label: 'Високий' });
    await pickDateTime(page, modal, 'Початок', targetDate(), '14');
    await pickDateTime(page, modal, 'Термін', targetDate(), '15');
    await page.screenshot({ path: test.info().outputPath('tasks_e2e_create_form.png') });

    const created = page.waitForResponse(
      r => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/tasks'),
    );
    await modal.getByRole('button', { name: 'Поставити задачу' }).click();
    const res = await created;
    expect(res.status(), await res.text()).toBe(201);
    const task = (await res.json()) as TaskDto;
    state.taskId = task.id;
    await expect(modal).toBeHidden({ timeout: 15_000 });
    expect(task).toMatchObject({ assigneeId: state.mechId, status: 'NEW' });
    expect([kyivHHMM(task.startAt!), kyivHHMM(task.dueAt!)]).toEqual(['14:00', '15:00']);

    const row = page.locator(`tr[data-task-id="${task.id}"]`);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toContainText(MECH_NAME);
    await expect(row).toContainText('Нова');
  });

  test('механік: «Мої задачі», календар, «Взяти в роботу», коментар, «Виконано»', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    test.skip(!state.taskId, 'задачу не створено');
    const { ctx, page } = await mechanicPage(browser);
    try {
      await page.goto('/tasks');
      const mine = page.getByRole('button', { name: 'Мої задачі' });
      await expect(mine).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
      await expect(page.locator(`tr[data-task-id="${state.taskId}"]`)).toBeVisible({
        timeout: 15_000,
      });
      // Механік не ставить задач і не бачить чужих — навіть без «Мої задачі» (BR-TASK-002).
      await expect(page.getByRole('button', { name: 'Задача', exact: true })).toHaveCount(0);
      await mine.click();
      await expect(mine).toHaveAttribute('aria-pressed', 'false');
      await expect(page.locator(`tr[data-task-id="${state.taskId}"]`)).toBeVisible();
      await expect(page.getByText(FOREIGN_TITLE)).toHaveCount(0);

      // Календар, вид «День»: задача — у смузі «Задачі», а не в рядку підйомника.
      await page.goto(`/calendar?view=day&date=${targetDate()}`);
      const strip = page.getByTestId('calendar-task-strip');
      await expect(strip).toBeVisible({ timeout: 30_000 });
      const block = strip.locator(`[data-task-id="${state.taskId}"]`);
      await expect(block).toBeVisible();
      await expect(page.locator('[data-lift-id] [data-task-id]')).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath('tasks_e2e_mechanic_day.png') });

      // Картка задачі зі смуги: лише перегляд полів, статус і коментарі.
      await block.click();
      const card = await openTaskCard(page, TITLE);
      await expect(card.getByLabel('Що зробити')).toHaveCount(0);
      await expect(card.locator('[data-action="CANCELLED"]')).toHaveCount(0);
      await card.locator('[data-action="IN_PROGRESS"]').click();
      await expect(card.getByText('В роботі').first()).toBeVisible({ timeout: 15_000 });

      await card.getByPlaceholder(/Напишіть коментар/).fill(COMMENT);
      await card.getByRole('button', { name: 'Надіслати' }).click();
      await expect(card.getByTestId('comment').filter({ hasText: COMMENT })).toBeVisible({
        timeout: 15_000,
      });

      await card.locator('[data-action="DONE"]').click();
      await expect(card.getByText('Виконана').first()).toBeVisible({ timeout: 15_000 });
      // Повернути виконану в роботу може лише керівник (BR-TASK-003).
      await expect(card.locator('[data-action="IN_PROGRESS"]')).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath('tasks_e2e_mechanic_done.png') });
      // «Закрити» — і хрестик шапки, і кнопка підвалу картки; натискаємо кнопку підвалу.
      await card.getByRole('button', { name: 'Закрити', exact: true }).last().click();
      await expect(card).toBeHidden();
      // Смуга перечитана: блок задачі — у кольорі «виконана».
      await expect(strip.locator(`[data-task-id="${state.taskId}"]`)).toHaveAttribute(
        'data-tone',
        'done',
        { timeout: 15_000 },
      );
    } finally {
      await ctx.close();
    }
  });

  test('керівник бачить статус «Виконана» і коментар механіка', async ({ page }) => {
    test.setTimeout(120_000);
    test.skip(!state.taskId, 'задачу не створено');
    await page.goto('/tasks');
    const row = page.locator(`tr[data-task-id="${state.taskId}"]`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText('Виконана');
    await row.click();
    const card = await openTaskCard(page, TITLE);
    await expect(card.getByTestId('comment').filter({ hasText: COMMENT })).toBeVisible({
      timeout: 15_000,
    });
    await expect(card.getByTestId('comment').filter({ hasText: COMMENT })).toContainText(
      MECH.first,
    );
    // Керівник може повернути виконану в роботу.
    await expect(card.locator('[data-action="IN_PROGRESS"]')).toBeVisible();
    await card.getByRole('button', { name: 'Скасувати', exact: true }).click();
    await expect(card).toBeHidden();
  });

  test('запис календаря на час задачі того самого механіка — без конфлікту (BR-TASK-007)', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    test.skip(!state.taskId || !state.lift, 'задачу не створено');
    await page.goto(`/calendar?view=day&date=${targetDate()}`);
    await expect(page.getByTestId('calendar-task-strip')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Слот', exact: true }).click();
    const form = page
      .locator('div.rounded-xl')
      .filter({ has: page.locator('h3', { hasText: /Новий слот/ }) })
      .last();
    await expect(form).toBeVisible({ timeout: 10_000 });
    await form.getByLabel('Тип запису').selectOption({ label: 'Нарада' });
    await form.getByLabel(/Підйомник/).selectOption({ label: state.lift!.name });
    const mechSelect = form.getByLabel('Механік');
    await expect(mechSelect.locator('option', { hasText: MECH_NAME })).toHaveCount(1, {
      timeout: 10_000,
    });
    await mechSelect.selectOption({ label: MECH_NAME });
    await form
      .locator('label', { hasText: 'Початок' })
      .first()
      .locator('..')
      .locator('input')
      .click();
    const popup = page
      .locator('div.shadow-lg')
      .filter({ has: page.getByRole('button', { name: 'Готово' }) });
    await expect(popup).toBeVisible({ timeout: 5_000 });
    await popup.getByLabel('Година').selectOption('14');
    await popup.getByLabel('Хвилини').selectOption('00');
    await popup.getByRole('button', { name: 'Готово' }).click();
    await form.locator('label', { hasText: 'Норм-год' }).locator('..').locator('input').fill('1');
    await form
      .locator('label', { hasText: 'Нотатки' })
      .locator('..')
      .locator('input')
      .fill(MEETING_NOTE);
    // Перевірка конфліктів форми не бачить задачі: попередження «зайнято» немає.
    await expect(form.getByText(/зайнят/i)).toHaveCount(0);
    await form.getByRole('button', { name: 'Зберегти' }).click();
    await expect(form).toBeHidden({ timeout: 15_000 });

    const day = await api<SlotDto[]>(page, 'GET', `/calendar/slots?date=${targetDate()}`);
    const slot = day.body.find(s => s.notes === MEETING_NOTE);
    expect(slot, 'запис збережено').toBeTruthy();
    state.slotId = slot!.id;
    expect(slot).toMatchObject({ liftId: state.lift!.id, employeeId: state.mechId });
    expect(kyivHHMM(slot!.startAt)).toBe('14:00');
    await expect(page.getByTestId('calendar-task-strip')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('tasks_e2e_slot_same_time.png') });
  });
});
