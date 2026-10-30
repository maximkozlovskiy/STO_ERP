import { test, expect, type Locator, type Page } from '@playwright/test';
import { apiCall, apiRequest, getToken } from './api-helpers';
import { loginViaForm } from './fixtures';
import { createEmployeeViaUi } from './employee-ui';
import { ensureVehicleModel } from './vehicle-directory';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/**
 * Автоматизація через інтерфейс (docs/objects/automation.md, блок 4; US-AUT-1, 2, 3, 4, 5, 6):
 *  1. правило «Наряд → В роботі → SMS клієнту» створюється в картці правила; наряд, переведений
 *     кнопками статусу в «В роботі», дає запис у журналі правила (у dev без SMS-провайдера —
 *     «пропущено» з причиною, це норма); перегляд тексту — без порожніх місць;
 *  2. правило «Затверджено → задача механіку + сповіщення» → задача в механіка (автор
 *     «Автоматизація»), сповіщення в його дзвіночку з переходом у документ;
 *  3. «Надіслати тест» з картки правила;
 *  4. згода на маркетинг і бажаний канал у картці контрагента зберігаються.
 *
 * Документи, правила й згода — через інтерфейс; через API — лише клієнт з авто (передумова) і
 * прибирання. Подія перевіряється в журналі спрацювань, а не доставкою: тест не залежить від тихих
 * годин і від провайдерів dev-бази.
 */

const uid = `${Date.now().toString().slice(-6)}${process.pid % 1000}`;
const TAG = `000 E2E ${uid}`;
const CLIENT = `${TAG} авто клієнт`;
const PLATE = `AU${uid.slice(-5)}`;
const RULE_A = `${TAG} в роботі — SMS`;
const RULE_B = `${TAG} затверджено — задача`;
const BODY_A =
  'Вітаємо, {{clientName}}! Авто {{vehicle}} в роботі. {{branchName}}[[, тел. {{branchPhone}}]]';
const MECH = { first: 'Механік', last: `${TAG} Авто` };
const MECH_NAME = `${MECH.last} ${MECH.first}`;
// Пароль — лише в пам'яті прогону.
const MECH_LOGIN = {
  email: `e2e-aut-mech-${uid}@sto.local`,
  password: `E2e-${Math.random().toString(36).slice(2, 10)}`,
};

const state: {
  token?: string;
  cpId?: string;
  garageId?: string;
  vehicleId?: string;
  mechId?: string;
  ruleA?: string;
  ruleB?: string;
  wo?: { id: string; number: string };
} = {};

async function api<T = unknown>(page: Page, method: string, path: string, body?: unknown) {
  return apiCall<T>(page, state.token ?? (await getToken(page)), method, path, body);
}

const isPost = (path: string) => (r: { url(): string; request(): { method(): string } }) =>
  r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(path);

async function openNewRuleCard(page: Page): Promise<Locator> {
  await page.goto('/settings/automation');
  await expect(page.getByRole('heading', { name: 'Автоматизація' })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Правило', exact: true }).click();
  const card = page.getByRole('dialog').filter({ hasText: 'Нове правило' });
  await expect(card.getByTestId('automation-rule-card')).toBeVisible({ timeout: 15_000 });
  return card;
}

async function saveNewRule(page: Page, card: Locator): Promise<string> {
  const created = page.waitForResponse(isPost('/automation/rules'), { timeout: 20_000 });
  await card.getByRole('button', { name: 'Створити', exact: true }).click();
  const res = await created;
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function openRuleCard(page: Page, id: string): Promise<Locator> {
  await page.goto(`/settings/automation?open=${id}`);
  const card = page.getByRole('dialog').filter({ has: page.getByTestId('automation-rule-card') });
  await expect(card.getByTestId('automation-rule-card')).toBeVisible({ timeout: 30_000 });
  return card;
}

test.describe('Автоматизація — правила, журнал, дзвіночок, згода (через інтерфейс)', () => {
  test.afterAll(async ({ request }) => {
    const token = state.token;
    if (!token) return;
    const call = (method: string, path: string, body?: unknown) =>
      apiRequest(request, token, method, path, body);
    const soft = async (method: string, path: string, label: string) => {
      const res = await call(method, path);
      expect
        .soft([200, 201, 204, 404], `${label}: ${JSON.stringify(res.body)}`)
        .toContain(res.status);
    };
    // Правила — першими: далі прибирання змінює статус наряду, і правило не має спрацювати знову.
    for (const id of [state.ruleA, state.ruleB])
      if (id) await soft('DELETE', `/automation/rules/${id}`, 'DELETE правила');
    if (state.wo) {
      const tasks = await apiRequest<{ items: { id: string }[] }>(
        request,
        token,
        'GET',
        `/tasks?workOrderId=${state.wo.id}&includeOpen=true&limit=50&page=1`,
      );
      for (const t of tasks.body?.items ?? [])
        await soft('DELETE', `/tasks/${t.id}`, 'DELETE задачі');
      // «В роботі» не скасовується напряму: → «Призупинено» → «Скасовано», далі видалення.
      for (const status of ['ON_HOLD', 'CANCELLED'])
        await call('POST', `/work-orders/${state.wo.id}/transition`, { status });
      await soft('DELETE', `/work-orders/${state.wo.id}`, 'DELETE наряду');
    }
    if (state.vehicleId) await soft('DELETE', `/vehicles/${state.vehicleId}`, 'DELETE авто');
    if (state.garageId)
      await soft(
        'DELETE',
        `/counterparties/${state.cpId}/garages/${state.garageId}`,
        'DELETE гаража',
      );
    if (state.cpId) await soft('DELETE', `/counterparties/${state.cpId}`, 'DELETE клієнта');
    if (state.mechId) await soft('DELETE', `/employees/${state.mechId}`, 'DELETE механіка');
  });

  test('1. правила створюються в картці: «В роботі → SMS» і «Затверджено → задача + сповіщення»', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await page.goto('/settings/automation');
    await expect(page.getByRole('heading', { name: 'Автоматизація' })).toBeVisible({
      timeout: 30_000,
    });
    state.token = await getToken(page);

    // ── Передумови через API: клієнт з телефоном і авто ──────────────────
    const cp = await api<{ id: string }>(page, 'POST', '/counterparties', {
      type: 'CLIENT',
      companyName: CLIENT,
      phone: '+380671112233',
    });
    expect(cp.status, JSON.stringify(cp.body)).toBe(201);
    state.cpId = cp.body.id;
    const garage = await api<{ id: string }>(
      page,
      'POST',
      `/counterparties/${state.cpId}/garages`,
      {
        name: '000 E2E гараж',
      },
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

    // Механік із входом — сторінкою «Співробітники».
    await createEmployeeViaUi(page, {
      onCreated: id => {
        state.mechId = id;
      },
      firstName: MECH.first,
      lastName: MECH.last,
      login: MECH_LOGIN,
    });

    // ── Правило A: Наряд → В роботі → SMS клієнту ────────────────────────
    let card = await openNewRuleCard(page);
    await card.getByLabel('Назва правила').fill(RULE_A);
    await card.getByRole('checkbox', { name: 'В роботі' }).check();
    await card.getByRole('tab', { name: /^Дії/ }).click();
    await card.locator('[data-add-action="client_message"]').click();
    await card.getByLabel(/Свій перелік/).check();
    // Стрілка списку — всередині поля, а не біля правого краю картки (Bug #1006).
    const addChannel = card.getByTestId('add-channel');
    const selectBox = await addChannel.getByRole('combobox').boundingBox();
    const chevronBox = await addChannel.locator('svg').first().boundingBox();
    expect(selectBox && chevronBox).toBeTruthy();
    expect(chevronBox!.x + chevronBox!.width).toBeLessThanOrEqual(selectBox!.x + selectBox!.width);
    await card.getByRole('combobox', { name: 'Додати канал' }).selectOption('SMS');
    await card.getByRole('button', { name: 'Прибрати канал Telegram-бот' }).click();
    await expect(card.getByTestId('action-0-channels').locator('[data-channel]')).toHaveCount(1);
    await card.getByLabel(/^Текст повідомлення/).fill(BODY_A);
    // Перегляд з прикладовими даними — без порожніх місць і без фрагмента з порожнім телефоном.
    await card.getByRole('button', { name: 'Перегляд' }).click();
    const preview = card.getByTestId('template-preview');
    await expect(preview).toContainText('Авто Toyota Camry (AA1234BB) в роботі. Головна філія');
    await expect(preview).not.toContainText('{{');
    await expect(preview).not.toContainText('тел.');
    await card.screenshot({ path: test.info().outputPath('aut_rule_a_actions.png') });
    state.ruleA = await saveNewRule(page, card);
    const ruleA = await api<{ actions: Array<Record<string, unknown>>; toStatuses: string[] }>(
      page,
      'GET',
      `/automation/rules/${state.ruleA}`,
    );
    expect(ruleA.body.toStatuses).toEqual(['IN_PROGRESS']);
    expect(ruleA.body.actions[0]).toMatchObject({
      type: 'client_message',
      channels: ['SMS'],
      template: { body: BODY_A },
    });
    await page.keyboard.press('Escape');

    // ── Правило B: Затверджено → задача механіку + сповіщення ─────────────
    card = await openNewRuleCard(page);
    await card.getByLabel('Назва правила').fill(RULE_B);
    await card.getByRole('checkbox', { name: 'Затверджено' }).check();
    await card.getByRole('tab', { name: /^Дії/ }).click();
    await card.locator('[data-add-action="create_task"]').click();
    await card.getByLabel(/^Назва задачі/).fill('{{documentNumber}}: підготувати пост');
    await card.getByLabel('Конкретний працівник').check();
    const assignee = card.getByRole('combobox', { name: 'Конкретний працівник' });
    await expect(assignee.locator('option', { hasText: MECH_NAME })).toHaveCount(1, {
      timeout: 15_000,
    });
    await assignee.selectOption({ label: MECH_NAME });
    await card.locator('[data-add-action="employee_notification"]').click();
    const notify = card.getByTestId('action-1');
    await notify.getByLabel(/Відповідальний з документа/).uncheck();
    await notify.getByRole('combobox', { name: 'Додати працівника…' }).selectOption({
      label: MECH_NAME,
    });
    await notify.getByLabel(/^Заголовок сповіщення/).fill('Наряд {{documentNumber}} затверджено');
    await card.screenshot({ path: test.info().outputPath('aut_rule_b_actions.png') });
    state.ruleB = await saveNewRule(page, card);
    await page.keyboard.press('Escape');

    // Список: обидва правила, увімкнені.
    await page.goto('/settings/automation');
    await page.getByPlaceholder('Пошук за назвою…').fill(TAG);
    await expect(page.locator('[data-rule-id]')).toHaveCount(2, { timeout: 15_000 });
    await page.screenshot({ path: test.info().outputPath('aut_rules_list.png') });
  });

  test('2. наряд «Затверджено» → «В роботі»: журнал правила, задача механіку', async ({ page }) => {
    test.setTimeout(240_000);
    test.skip(!state.ruleA || !state.ruleB, 'правила не створено');
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
    await expect(vehicleSelect.locator('option', { hasText: PLATE })).toHaveCount(1, {
      timeout: 10_000,
    });
    await vehicleSelect.selectOption({ label: `Toyota Corolla (${PLATE})` });
    await woModal.getByPlaceholder('Заміна масла, колодок...').fill(`${TAG} автоматизація`);
    await woModal.getByRole('button', { name: 'Створити наряд' }).click();
    await expect(woModal).toBeHidden({ timeout: 20_000 });
    const list = await api<{ items: Array<{ id: string; number: string }> }>(
      page,
      'GET',
      `/work-orders?counterpartyId=${state.cpId}&limit=1&sortBy=createdAt&sortDir=desc`,
    );
    state.wo = list.body.items[0]!;
    const card = page.getByRole('dialog').filter({ hasText: state.wo.number });
    await expect(card).toBeVisible({ timeout: 20_000 });

    for (const next of ['Кошторис', 'Затверджено', 'В роботі']) {
      await card
        .getByRole('button', { name: new RegExp(`^${next}$`) })
        .last()
        .click();
      await expect
        .poll(
          async () =>
            (await api<{ status: string }>(page, 'GET', `/work-orders/${state.wo!.id}`)).body
              .status,
          { timeout: 15_000 },
        )
        .toBe({ Кошторис: 'ESTIMATE', Затверджено: 'APPROVED', 'В роботі': 'IN_PROGRESS' }[next]);
    }

    // Подія → спрацювання правила A (outbox обробляється раз на 10 с).
    type Run = { documentId: string; status: string; actionResults: Array<{ reason?: string }> };
    await expect
      .poll(
        async () =>
          (
            await api<{ items: Run[] }>(page, 'GET', `/automation/runs?ruleId=${state.ruleA}`)
          ).body.items.filter(r => r.documentId === state.wo!.id).length,
        { timeout: 90_000, intervals: [2_000, 3_000] },
      )
      .toBe(1);

    // Журнал правила в картці: рядок спрацювання з подією й результатом дії (без сирого коду).
    const ruleCard = await openRuleCard(page, state.ruleA!);
    await ruleCard.getByRole('tab', { name: /^Журнал/ }).click();
    const journal = ruleCard.getByTestId('automation-journal');
    const run = journal.locator('[data-run-id]').first();
    await expect(run).toBeVisible({ timeout: 20_000 });
    await expect(run).toContainText('В роботі');
    await expect(run).toContainText('Повідомити клієнта');
    const reason = await run.locator('[data-reason]').first().getAttribute('data-reason');
    if (reason) await expect(run).not.toContainText(reason);
    await ruleCard.screenshot({ path: test.info().outputPath('aut_rule_a_journal.png') });

    // Правило B: задача механіку від «Автоматизації», прив'язана до наряду.
    type Task = { id: string; assigneeId: string; createdByName: string; title: string };
    await expect
      .poll(
        async () =>
          (
            await api<{ items: Task[] }>(
              page,
              'GET',
              `/tasks?workOrderId=${state.wo!.id}&includeOpen=true&limit=20&page=1`,
            )
          ).body.items.filter(t => t.assigneeId === state.mechId).length,
        { timeout: 90_000, intervals: [2_000, 3_000] },
      )
      .toBe(1);
  });

  test('3. механік: задача в «Моїх задачах», сповіщення в дзвіночку з переходом у документ', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    test.skip(!state.wo || !state.mechId, 'немає наряду чи механіка');
    const { ctx, page } = await loginViaForm(browser, MECH_LOGIN);
    try {
      await page.goto('/tasks');
      const row = page.locator('tr[data-task-id]', { hasText: state.wo!.number });
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(row).toContainText('підготувати пост');

      const bell = page.getByTestId('notification-center').first();
      await expect(bell.getByTestId('notification-badge')).toBeVisible({ timeout: 45_000 });
      await bell.locator('button').first().click();
      const item = page
        .locator('[data-notification-id]')
        .filter({ hasText: `Наряд ${state.wo!.number} затверджено` });
      await expect(item).toBeVisible({ timeout: 15_000 });
      await expect(item).toHaveAttribute('data-unread', 'true');
      await page.screenshot({ path: test.info().outputPath('aut_mechanic_bell.png') });
      await item.click();
      // Статичний експорт — адреса з кінцевою косою: `/work-orders/?open=…`.
      await expect(page).toHaveURL(new RegExp(`/work-orders/?\\?open=${state.wo!.id}`), {
        timeout: 20_000,
      });

      // Телефон (390 px): дзвіночок — у меню після аватара й імені, панель не виходить за
      // правий край (Bug #1003: «100vw − 5rem» давало 52 px за межею екрана).
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto('/tasks');
      await page.getByRole('button', { name: 'Відкрити меню' }).click();
      const mobileBell = page.locator('[data-testid="notification-center"]:visible');
      await mobileBell.locator('button').first().click();
      const panel = mobileBell.getByTestId('notification-panel');
      await expect(panel.locator('[data-notification-id]').first()).toBeVisible({
        timeout: 15_000,
      });
      const box = await panel.boundingBox();
      expect(box, 'панель сповіщень видима').not.toBeNull();
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
      await page.screenshot({ path: test.info().outputPath('aut_mechanic_bell_390.png') });
    } finally {
      await ctx.close();
    }
  });

  test('4. «Надіслати тест» з картки правила — результат дій і запис «тест» у журналі', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    test.skip(!state.ruleA || !state.wo, 'немає правила чи наряду');
    const card = await openRuleCard(page, state.ruleA!);
    await card.getByRole('tab', { name: /^Дії/ }).click();
    await card.getByRole('button', { name: 'Надіслати тест' }).click();
    const testModal = page.getByRole('dialog').filter({ has: page.getByTestId('automation-test') });
    await expect(testModal).toBeVisible({ timeout: 10_000 });
    await testModal.getByRole('combobox', { name: 'Документ для тесту' }).fill(state.wo!.number);
    await page.getByRole('option', { name: new RegExp(state.wo!.number) }).click();
    const sent = page.waitForResponse(isPost(`/automation/rules/${state.ruleA}/test`), {
      timeout: 20_000,
    });
    await testModal.getByRole('button', { name: 'Надіслати', exact: true }).click();
    const res = await sent;
    // Тест іде тому, хто тестує: без телефону / email / підписки сервер відповідає 400 з поясненням.
    if (res.status() === 201 || res.status() === 200) {
      await expect(testModal.getByTestId('automation-test-result')).toContainText(
        'Повідомити клієнта',
      );
    } else {
      expect(res.status()).toBe(400);
      await expect(testModal.getByRole('alert')).toBeVisible();
    }
    await testModal.screenshot({ path: test.info().outputPath('aut_send_test.png') });
  });

  test('5. картка контрагента: згода на маркетинг і бажаний канал зберігаються', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    test.skip(!state.cpId, 'немає клієнта');
    await page.goto(`/counterparties?open=${state.cpId}`);
    const card = page.getByRole('dialog').filter({ has: page.getByTestId('counterparty-tabs') });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card
      .getByTestId('counterparty-tabs')
      .getByRole('button', { name: /Повідомлення/ })
      .click();
    const block = card.getByTestId('counterparty-messaging');
    await expect(block).toBeVisible({ timeout: 15_000 });

    const patched = (field: string) =>
      page.waitForResponse(
        r =>
          r.request().method() === 'PATCH' &&
          new URL(r.url()).pathname.endsWith(`/counterparties/${state.cpId}`) &&
          (r.request().postData() ?? '').includes(field),
        { timeout: 15_000 },
      );
    let wait = patched('marketingConsent');
    await block.getByRole('switch', { name: 'Згода на маркетинг' }).click();
    expect((await wait).status()).toBe(200);
    await expect(block.getByTestId('consent-changed')).toContainText('Змінено');
    wait = patched('preferredChannel');
    await block.getByLabel('Бажаний канал').selectOption('VIBER');
    expect((await wait).status()).toBe(200);
    await card.screenshot({ path: test.info().outputPath('aut_counterparty_consent.png') });

    // Після перезавантаження — те саме з сервера.
    await page.reload();
    const again = page.getByRole('dialog').filter({ has: page.getByTestId('counterparty-tabs') });
    await again
      .getByTestId('counterparty-tabs')
      .getByRole('button', { name: /Повідомлення/ })
      .click();
    const block2 = again.getByTestId('counterparty-messaging');
    await expect(block2.getByRole('switch', { name: 'Згода на маркетинг' })).toHaveAttribute(
      'aria-checked',
      'true',
      { timeout: 15_000 },
    );
    await expect(block2.getByLabel('Бажаний канал')).toHaveValue('VIBER');
    await expect(block2.getByRole('switch', { name: 'Не надсилати службові' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });
});
