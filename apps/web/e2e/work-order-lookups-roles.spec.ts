import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';
import { loginViaForm } from './fixtures';
import { API } from './api-url';
import { createEmployeeViaUi } from './employee-ui';
import { ensureVehicleModel } from './vehicle-directory';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/**
 * Рішення власника 2026-10-16 (друге) на справжньому наряді, через браузер:
 *  1. приймальня відкриває й редагує картку наряду — без 403, ПДВ організації (employee.md,
 *     «Звуження й приймальня»);
 *  2. механік отримує мінімум: `GET /employees` — лише id та ім'я, договори — id, номер і тип
 *     (перевірка відповідей у мережі);
 *  3. виконавець рядка роботи поза списком активних механіків (адміністратор) — у картці його
 *     ім'я недоступною опцією, на сторінці наряду — ім'я (BR-WO-018);
 *  4. механік у відпустці (статус — через картку співробітника): форма запису календаря
 *     відповідає «Механік у відпустці», перетягування — «Механіка знято: … у відпустці»
 *     (BR-CAL-012).
 *
 * За правилом власника документи — через інтерфейс: НАРЯД створюється в списку нарядів, рядок
 * роботи — у картці, ЗАПИСИ календаря — формою «+ Слот», переміщення — мишею, статус механіка —
 * карткою співробітника, ПРАЦІВНИКИ (механік із входом і закріпленням за підйомником, адміністратор,
 * приймальня з входом) — сторінкою «Співробітники» (рішення власника 2026-10-19). Клієнт, авто й
 * договір — передумови через API. Рядок із виконавцем-адміністратором — теж через API: інтерфейс
 * такого виконавця обрати вже не дає (це й перевіряється), а такі рядки лишились у старих нарядах.
 */

const uid = Date.now().toString().slice(-6);
const TAG = `000 TST ${uid}`;
const CLIENT = `${TAG} Клієнт картки`;
const MECH = { first: 'Механік', last: `${TAG} Відпустка` };
const MECH_NAME = `${MECH.last} ${MECH.first}`;
const ADMIN = { first: 'Адмін', last: `${TAG} Виконавець` };
const ADMIN_NAME = `${ADMIN.last} ${ADMIN.first}`;
const RECEPTION = { first: 'Приймальня', last: TAG };
// Паролі — лише в пам'яті прогону.
const pwd = () => `E2e-${Math.random().toString(36).slice(2, 10)}`;
const MECH_LOGIN = { email: `e2e-tst-mech-${uid}@sto.local`, password: pwd() };
const RECEPTION_LOGIN = { email: `e2e-tst-rec-${uid}@sto.local`, password: pwd() };

const pad = (n: number) => String(n).padStart(2, '0');
function targetDate(): string {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv' }).format(new Date());
  const [y, m] = today.split('-').map(Number);
  const next = new Date(Date.UTC(y, m, 13)); // 13-те число наступного місяця
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-13`;
}

async function getToken(page: Page): Promise<string> {
  const token = await page.evaluate(
    () =>
      sessionStorage.getItem('sto_access_token') ?? localStorage.getItem('sto_e2e_access_token'),
  );
  expect(token, 'access token має бути у storage').toBeTruthy();
  return token as string;
}

/** Запит до API від імені сторінки, з повтором на 429 (ліміт 200 запитів/хв на IP). */
async function api<T = unknown>(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  for (let attempt = 0; ; attempt++) {
    const res = await page.evaluate(
      async ({ token, API, method, path, body }) => {
        const r = await fetch(`${API}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        const text = await r.text();
        let parsed: unknown = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = text;
        }
        return { status: r.status, body: parsed as never };
      },
      { token: state.token!, API, method, path, body },
    );
    if (res.status !== 429 || attempt >= 12) return res as { status: number; body: T };
    await page.waitForTimeout(5_000);
  }
}

interface SlotDto {
  id: string;
  liftId?: string | null;
  employeeId?: string | null;
  workOrderId?: string | null;
  counterpartyId?: string | null;
  startAt: string;
}

const state: {
  token?: string;
  cpId?: string;
  vehicleId?: string;
  garageId?: string;
  plate?: string;
  contractId?: string;
  woId?: string;
  woNumber?: string;
  workId?: string;
  workName?: string;
  mechId?: string;
  adminId?: string;
  receptionId?: string;
  liftA?: { id: string; name: string };
  liftB?: { id: string; name: string };
  slotIds: string[];
} = { slotIds: [] };

// Bug #966: форм-логін у свіжому контексті мусить ставити ті самі E2E-прапорці, що й
// setup-auth.ts (skip-refresh), інакше refresh-on-mount у кількапотоковому прогоні ловить
// 429 і кидає щойно залогінену сесію на /login. Делегуємо спільному хелперу.
async function loginAs(browser: Browser, login: { email: string; password: string }) {
  return loginViaForm(browser, login);
}

/** Відкриває картку наряду тесту зі списку нарядів (наведення на рядок → «Відкрити наряд»). */
async function openWoCard(page: Page, mechanic = false): Promise<Locator> {
  await page.goto('/work-orders');
  if (mechanic) {
    // Механіку список відкривається на «Мої наряди» — наряд тесту не його, фільтр вимикаємо.
    const mine = page.getByRole('button', { name: 'Мої наряди' });
    await expect(mine).toBeVisible({ timeout: 30_000 });
    await mine.click();
  }
  const row = page.locator('table tbody tr', { hasText: state.woNumber! }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.hover();
  await row.getByTitle('Відкрити наряд').click();
  const card = page.getByRole('dialog').filter({ hasText: state.woNumber! });
  await expect(card).toBeVisible({ timeout: 30_000 });
  // Картка завантажилась — у ній рядок з роботою тесту (а не слово з чужих даних).
  await expect(card).toContainText(state.workName!);
  return card;
}

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
  const res = await api<SlotDto[]>(page, 'GET', `/calendar/slots?date=${date}`);
  expect(res.status).toBe(200);
  return res.body;
}

test.describe('Картка наряду — довідники за ролями, виконавець поза списком, відпустка', () => {
  test.afterAll(async ({ browser }) => {
    if (!state.token) return;
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const page = await ctx.newPage();
    await page.goto('/calendar');
    const day = await api<SlotDto[]>(page, 'GET', `/calendar/slots?date=${targetDate()}`);
    for (const s of Array.isArray(day.body) ? day.body : []) {
      const ours =
        (state.woId && s.workOrderId === state.woId) ||
        (state.cpId && s.counterpartyId === state.cpId);
      if (ours && !state.slotIds.includes(s.id)) state.slotIds.push(s.id);
    }
    for (const id of state.slotIds) {
      const res = await api(page, 'DELETE', `/calendar/slots/${id}`);
      expect.soft([200, 204, 404], `DELETE слота ${id}`).toContain(res.status);
    }
    const del = async (path: string, label: string) => {
      const res = await api(page, 'DELETE', path);
      expect.soft([200, 204, 404], label).toContain(res.status);
    };
    if (state.woId) await del(`/work-orders/${state.woId}`, 'DELETE наряду');
    if (state.vehicleId) await del(`/vehicles/${state.vehicleId}`, 'DELETE авто');
    // Гараж — до клієнта: гараж видаленого клієнта API вже не видаляє (404 на батьківському).
    if (state.cpId && state.garageId)
      await del(`/counterparties/${state.cpId}/garages/${state.garageId}`, 'DELETE гаража');
    if (state.cpId && state.contractId)
      await del(`/counterparties/${state.cpId}/contracts/${state.contractId}`, 'DELETE договору');
    if (state.cpId) await del(`/counterparties/${state.cpId}`, 'DELETE клієнта');
    for (const id of [state.mechId, state.adminId, state.receptionId])
      if (id) await del(`/employees/${id}`, `DELETE працівника ${id}`);
    await ctx.close();
  });

  test('передумови; наряд і рядок роботи через інтерфейс', async ({ page }) => {
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
    expect(cp.status, JSON.stringify(cp.body)).toBe(201);
    state.cpId = cp.body.id;
    const garage = await api<{ id: string }>(
      page,
      'POST',
      `/counterparties/${state.cpId}/garages`,
      {
        name: `${TAG} гараж`,
      },
    );
    expect(garage.status).toBe(201);
    state.garageId = garage.body.id;
    state.plate = `TST${uid.slice(-5)}`;
    const vehicle = await api<{ id: string }>(page, 'POST', '/vehicles', {
      customerGarageId: garage.body.id,
      ...(await ensureVehicleModel(
        (method, url, data) => api(page, method, url, data),
        'Toyota',
        'Corolla',
      )),
      licensePlate: state.plate,
    });
    expect(vehicle.status).toBe(201);
    state.vehicleId = vehicle.body.id;
    const contract = await api<{ id: string }>(
      page,
      'POST',
      `/counterparties/${state.cpId}/contracts`,
      {
        number: `ДГ-${uid}`,
        contractType: 'SALE',
        startDate: '2026-01-01',
        isPrimary: true,
      },
    );
    expect(contract.status, JSON.stringify(contract.body)).toBe(201);
    state.contractId = contract.body.id;

    // Підйомники довідника, а не тимчасові інших спеків («000 E2E …»): паралельний
    // work-order-line-executor ставив свій першим, цей спек закріплював за ним свого механіка —
    // і обидва падали (там «єдиний механік» ставав другим, тут підйомник зникав посеред тесту).
    const lifts = await api<{ id: string; name: string }[]>(page, 'GET', '/lifts');
    const own = lifts.body.filter(l => !l.name.startsWith('000 E2E'));
    expect(own.length, 'потрібні два підйомники довідника').toBeGreaterThanOrEqual(2);
    [state.liftA, state.liftB] = own;
    // ── Працівники — сторінкою «Співробітники» ───────────────────────────
    await createEmployeeViaUi(page, {
      onCreated: id => {
        state.mechId = id;
      },
      firstName: MECH.first,
      lastName: MECH.last,
      login: MECH_LOGIN,
      liftNames: [state.liftA!.name],
    });
    const mech = await api<{ liftIds: string[] }>(page, 'GET', `/employees/${state.mechId}`);
    expect(mech.body.liftIds, 'механік закріплений за підйомником A').toEqual([state.liftA!.id]);
    await createEmployeeViaUi(page, {
      onCreated: id => {
        state.adminId = id;
      },
      firstName: ADMIN.first,
      lastName: ADMIN.last,
      role: 'ADMIN',
    });
    await createEmployeeViaUi(page, {
      onCreated: id => {
        state.receptionId = id;
      },
      firstName: RECEPTION.first,
      lastName: RECEPTION.last,
      role: 'RECEPTIONIST',
      login: RECEPTION_LOGIN,
    });
    // Робота — з довідника, але не тимчасова робота іншого спеку («000 E2E …»): паралельний
    // прогін ставив її першою за назвою, а потім видаляв (тест падав на чужих даних).
    const works = await api<{ items: { id: string; name: string }[] }>(
      page,
      'GET',
      '/works?limit=100',
    );
    const work = works.body.items.find(w => !w.name.startsWith('000 E2E'));
    expect(work, 'потрібна хоч одна робота довідника (не з тестових даних)').toBeTruthy();
    state.workId = work!.id;
    state.workName = work!.name;

    // ── Наряд — через інтерфейс ───────────────────────────────────────────
    // Картка наряду читає довідники при монтуванні сторінки — сторінка нарядів після створення
    // працівників, щоб механік тесту був у довіднику.
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
    await woModal.getByPlaceholder('Заміна масла, колодок...').fill(`${TAG} довідники картки`);
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
    const card = page.getByRole('dialog').filter({ hasText: state.woNumber });
    await expect(card).toBeVisible({ timeout: 20_000 });

    // ── Рядок роботи з механіком тесту — у картці ─────────────────────────
    await card.getByRole('button', { name: 'Додати', exact: true }).first().click();
    const inputRow = card.locator('tr').filter({ has: page.getByTitle('Зберегти рядок') });
    await expect(inputRow).toBeVisible({ timeout: 5_000 });
    await inputRow.getByRole('combobox', { name: 'Робота' }).fill(state.workName!);
    await page
      .getByRole('option', { name: new RegExp(state.workName!) })
      .first()
      .click();
    const executor = inputRow.getByRole('combobox', { name: 'Виконавець' });
    // Новий рядок: лише активні механіки — адміністратора тесту серед них немає.
    await expect(executor.locator('option', { hasText: MECH_NAME })).toHaveCount(1, {
      timeout: 10_000,
    });
    await expect(executor.locator('option', { hasText: ADMIN_NAME })).toHaveCount(0);
    await executor.selectOption({ label: MECH_NAME });
    await inputRow.getByTitle('Зберегти рядок').click();
    await card.getByRole('button', { name: 'Зберегти зміни', exact: true }).click();
    await expect
      .poll(
        async () =>
          (
            await api<{ lines: { employeeId: string }[] }>(
              page,
              'GET',
              `/work-orders/${state.woId}`,
            )
          ).body.lines.map(l => l.employeeId),
        { timeout: 20_000 },
      )
      .toEqual([state.mechId]);

    // Рядок із виконавцем-адміністратором — дані зі старих нарядів (UI такого вже не створює).
    const legacy = await api(page, 'POST', `/work-orders/${state.woId}/lines`, {
      workId: state.workId,
      employeeId: state.adminId,
      normoHours: 1,
      price: 100,
    });
    expect(legacy.status, JSON.stringify(legacy.body)).toBe(201);
  });

  test('приймальня відкриває й редагує картку наряду — без 403, ПДВ організації', async ({
    page,
    browser,
  }) => {
    test.setTimeout(150_000);
    test.skip(!state.woNumber, 'наряд не створено');
    await page.goto('/work-orders');
    const org = await api<{ vatMode: string }>(page, 'GET', '/settings/organisation');
    expect(org.status).toBe(200);

    const { ctx, page: rp } = await loginAs(browser, RECEPTION_LOGIN);
    const forbidden: string[] = [];
    const orgBodies: Record<string, unknown>[] = [];
    rp.on('response', async r => {
      if (r.status() === 403) forbidden.push(`${r.request().method()} ${r.url()}`);
      if (/\/api\/v1\/settings\/organisation$/.test(r.url()) && r.status() === 200)
        orgBodies.push((await r.json().catch(() => ({}))) as Record<string, unknown>);
    });
    rp.on('console', m => {
      if (m.type() === 'error' && m.text().includes('403')) forbidden.push(`console: ${m.text()}`);
    });
    const card = await openWoCard(rp);
    await rp.waitForLoadState('networkidle');

    // Налаштування — звужена форма картки: ПДВ організації без решти полів.
    expect(orgBodies.length, 'GET /settings/organisation відповів 200').toBeGreaterThan(0);
    expect(Object.keys(orgBodies[0]).sort()).toEqual([
      'currency',
      'defaultVatRateId',
      'language',
      'recalcActualHoursFromLines',
      'recalcPlannedHoursFromLines',
      'syncCalendarSlotWithPlannedHours',
      'vatMode',
    ]);
    expect(orgBodies[0].vatMode).toBe(org.body.vatMode);
    if (org.body.vatMode !== 'NONE') {
      // ПДВ організації: рядок ПДВ у підсумку картки є (раніше — 403 і підсумок без ПДВ).
      await expect(card.getByTestId('vat-totals-vat')).toBeVisible({ timeout: 15_000 });
      await expect(card.getByTestId('vat-totals-vat')).not.toHaveText(/ПДВ\s*0,00/);
    }

    // Редагування: опис наряду.
    const desc = card.getByPlaceholder('Заміна масла, колодок...');
    await desc.fill(`${TAG} відредаговано приймальнею`);
    await card.getByRole('button', { name: 'Зберегти зміни', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await api<{ description?: string }>(page, 'GET', `/work-orders/${state.woId}`)).body
            .description,
        { timeout: 20_000 },
      )
      .toBe(`${TAG} відредаговано приймальнею`);
    await rp.screenshot({ path: test.info().outputPath('c14_reception_card.png') });
    expect(forbidden, 'запити з 403 під приймальнею').toEqual([]);
    await ctx.close();
  });

  test('механік: у відповідях працівників і договорів — лише мінімальні поля', async ({
    browser,
  }) => {
    test.setTimeout(150_000);
    test.skip(!state.woNumber, 'наряд не створено');
    const { ctx, page: mp } = await loginAs(browser, MECH_LOGIN);
    const employees: Record<string, unknown>[] = [];
    const contracts: Record<string, unknown>[] = [];
    mp.on('response', async r => {
      if (r.status() !== 200) return;
      const url = r.url();
      if (/\/api\/v1\/employees(\?|$)/.test(url)) {
        const body = (await r.json().catch(() => null)) as { items?: unknown[] } | null;
        employees.push(...((body?.items ?? []) as Record<string, unknown>[]));
      }
      if (/\/api\/v1\/counterparties\/[^/]+\/contracts(\?|$)/.test(url)) {
        const body = (await r.json().catch(() => null)) as unknown[] | null;
        contracts.push(...((body ?? []) as Record<string, unknown>[]));
      }
    });
    const card = await openWoCard(mp, true);
    await mp.waitForLoadState('networkidle');

    expect(employees.length, 'механік отримав довідник механіків').toBeGreaterThan(0);
    for (const e of employees)
      expect(Object.keys(e).sort()).toEqual(['firstName', 'id', 'lastName']);
    expect(employees.find(e => e.id === state.mechId)).toBeTruthy();
    expect(contracts.length, 'механік отримав договори клієнта').toBeGreaterThan(0);
    for (const c of contracts)
      expect(Object.keys(c).sort()).toEqual(['contractType', 'id', 'number']);
    // Виконавець-адміністратор — ім'ям у рядку картки (BR-WO-018).
    await expect(card.locator('tr', { hasText: ADMIN_NAME })).toHaveCount(1);
    await mp.screenshot({ path: test.info().outputPath('c14_mechanic_card.png') });
    await ctx.close();
  });

  test('виконавець-адміністратор: у картці — недоступна опція з ім’ям, на сторінці — ім’я', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    test.skip(!state.woNumber, 'наряд не створено');
    const card = await openWoCard(page);
    const row = card.locator('tr', { hasText: ADMIN_NAME });
    await expect(row).toHaveCount(1, { timeout: 15_000 });
    await row.getByRole('button', { name: 'Редагувати роботу' }).click();
    const executor = card.getByRole('combobox', { name: 'Виконавець' });
    await expect(executor).toBeVisible();
    await expect(executor.locator('option:checked')).toHaveText(`${ADMIN_NAME} (недоступний)`);
    await expect(executor.locator(`option[value="${state.adminId}"]`)).toBeDisabled();
    await expect(
      card.getByText(
        'Не активний механік (не механік, звільнений чи у відпустці) — оберіть іншого',
      ),
    ).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('c14_executor_unavailable_card.png') });
    await card.getByTitle('Скасувати').first().click();
    await card.getByRole('button', { name: 'Закрити' }).last().click();

    await page.goto(`/work-orders/${state.woId}`);
    await expect(page.getByText(state.woNumber!).first()).toBeVisible({ timeout: 30_000 });
    const pageLine = page.getByText(new RegExp(`${ADMIN_NAME} ·`));
    await expect(pageLine).toBeVisible({ timeout: 15_000 });
    await pageLine.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath('c14_executor_page.png') });
  });

  test('механік у відпустці: форма запису — «Механік у відпустці», перетягування — тост', async ({
    page,
    browser,
  }) => {
    test.setTimeout(240_000);
    test.skip(!state.woNumber, 'наряд не створено');
    const date = targetDate();
    const { liftA, liftB } = state as Required<typeof state>;

    // ── Запис 1 з механіком (поки активний) на підйомнику A — формою «+ Слот» ──
    await page.goto(`/calendar?view=day&date=${date}`);
    await expect(page.locator('h1:has-text("Календар")')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Слот', exact: true }).click();
    let form = slotForm(page, /Новий слот/);
    await expect(form).toBeVisible({ timeout: 10_000 });
    await form.getByLabel(/Підйомник/).selectOption({ label: liftA.name });
    await pickStart(page, form, '10');
    await form.locator('label', { hasText: 'Норм-год' }).locator('..').locator('input').fill('1');
    await form.getByPlaceholder('Пошук наряду…').fill(state.woNumber!);
    await page.getByRole('option', { name: new RegExp(state.woNumber!) }).click();
    let mechSelect = form.getByLabel('Механік');
    await expect(mechSelect.locator('option', { hasText: MECH_NAME })).toHaveCount(1, {
      timeout: 10_000,
    });
    await mechSelect.selectOption({ label: MECH_NAME });
    await form.getByRole('button', { name: 'Зберегти', exact: true }).click();
    await expect(form).toBeHidden({ timeout: 15_000 });
    const created = (await daySlots(page, date)).filter(s => s.workOrderId === state.woId);
    state.slotIds.push(...created.map(s => s.id));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ liftId: liftA.id, employeeId: state.mechId });

    // ── Запис 2: механіка обрано, поки він активний; форма лишається відкритою ──
    await page.getByRole('button', { name: 'Слот', exact: true }).click();
    form = slotForm(page, /Новий слот/);
    await expect(form).toBeVisible({ timeout: 10_000 });
    await form.getByLabel(/Підйомник/).selectOption({ label: liftA.name });
    await pickStart(page, form, '14');
    await form.locator('label', { hasText: 'Норм-год' }).locator('..').locator('input').fill('1');
    await form.getByPlaceholder('Пошук клієнта…').fill(CLIENT);
    await page.getByRole('option', { name: new RegExp(CLIENT) }).click();
    mechSelect = form.getByLabel('Механік');
    await expect(mechSelect.locator('option', { hasText: MECH_NAME })).toHaveCount(1, {
      timeout: 10_000,
    });
    await mechSelect.selectOption({ label: MECH_NAME });

    // ── Тим часом у другій вкладці — статус «У відпустці» карткою співробітника ──
    const ctx2 = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const ep = await ctx2.newPage();
    await ep.goto('/employees');
    const search = ep.locator('input[placeholder*="Пошук"]').first();
    await expect(search).toBeVisible({ timeout: 30_000 });
    await search.fill(MECH.last);
    const empRow = ep.locator('table tbody tr', { hasText: MECH.last }).first();
    await expect(empRow).toBeVisible({ timeout: 15_000 });
    await empRow.hover();
    await empRow.getByTitle('Редагувати').click();
    const empModal = ep.getByRole('dialog').filter({ hasText: MECH.last });
    await expect(empModal).toBeVisible({ timeout: 10_000 });
    await empModal.getByLabel('Статус').selectOption('ON_LEAVE');
    await empModal.getByRole('button', { name: 'Зберегти' }).click();
    await expect(empModal).toBeHidden({ timeout: 15_000 });
    await expect
      .poll(
        async () =>
          (await api<{ status: string }>(page, 'GET', `/employees/${state.mechId}`)).body.status,
      )
      .toBe('ON_LEAVE');
    await ctx2.close();

    // ── Збереження запису 2 → сервер: «Механік у відпустці» ─────────────────
    await form.getByRole('button', { name: 'Зберегти', exact: true }).click();
    await expect(form.getByText('Механік у відпустці')).toBeVisible({ timeout: 15_000 });
    await expect(form.getByText('не закріплений за цим підйомником')).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('c14_slot_form_on_leave.png') });
    // Запис 2 (клієнт без наряду) не створено: на дату лише запис 1 наряду.
    expect(
      (await daySlots(page, date)).filter(
        s => s.counterpartyId === state.cpId && s.workOrderId !== state.woId,
      ),
    ).toEqual([]);
    await form.getByRole('button', { name: 'Скасувати' }).click();
    await expect(form).toBeHidden({ timeout: 10_000 });

    // Тост помилки форми (6 с) зникає до перетягування — щоб на знімку був лише тост переміщення.
    await expect(page.getByText('Механік у відпустці', { exact: true })).toHaveCount(0, {
      timeout: 15_000,
    });

    // ── Перетягування запису 1 на підйомник B → «Механіка знято: … у відпустці» ──
    const block = page.locator('[data-calendar-slot]', { hasText: state.woNumber! });
    await expect(block).toBeVisible({ timeout: 15_000 });
    const from = (await block.boundingBox())!;
    const rowB = (await page.locator(`[data-lift-id="${liftB.id}"]`).boundingBox())!;
    const x = from.x + Math.min(20, from.width / 2);
    await page.mouse.move(x, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, from.y + from.height / 2 + 12, { steps: 4 });
    await page.mouse.move(x, rowB.y + rowB.height / 2, { steps: 12 });
    await page.mouse.up();

    await expect(page.getByText(`Механіка знято: ${MECH_NAME} у відпустці`)).toBeVisible({
      timeout: 15_000,
    });
    // Знімок — після анімації появи тосту (toBeVisible не зважає на прозорість).
    await page.waitForTimeout(600);
    await page.screenshot({ path: test.info().outputPath('c14_drag_on_leave.png') });
    await expect(page.getByText(/Механіка знято: .*не закріплений/)).toHaveCount(0);
    await expect
      .poll(async () => (await daySlots(page, date)).find(s => s.id === created[0].id))
      .toMatchObject({ liftId: liftB.id, employeeId: null });
  });
});
