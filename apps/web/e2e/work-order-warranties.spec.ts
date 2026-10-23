import { test, expect, type Page } from '@playwright/test';
import { apiCall, apiRequest, getToken } from './api-helpers';
import { WARRANTY_EXPIRING_DAYS } from '@sto/shared';
import { ensureVehicleModel } from './vehicle-directory';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/**
 * Вкладка «Гарантії» в розділі «Наряди» (BR-WAR-001…005, рішення власника 2026-10-22), через
 * браузер на справжніх нарядах:
 *  1. наряд створено в списку нарядів, робота й статуси до «Виконано» — на сторінці наряду →
 *     гарантія з'являється на вкладці «Гарантії» (номер наряду, клієнт / авто, дата, стан);
 *  2. фільтр стану: свій стан — рядок є, «Закінчилась» — рядка немає;
 *  3. «Звернення»: вікно з нарядами клієнта, обрано другий наряд → стан «Звернення», кнопки більше
 *     немає, звернення записане на обраний наряд;
 *  4. «Пов'язані документи» наряду в списку нарядів: перехід до гарантії → вкладка «Гарантії» з
 *     гарантією в бічній панелі.
 *
 * Клієнт, гараж і авто — передумови через API; наряди, робота, статуси, звернення — інтерфейсом.
 * Прибирання: наряди (завершений — спершу «Скасовано», це сторнує борг), авто, гараж, клієнт.
 * Гарантії видалених нарядів список не показує (BR-WAR-001).
 */

const uid = Date.now().toString().slice(-6);
const CLIENT = `000 E2E TST-WAR ${uid}`;
const PLATE = `WR${uid.slice(-5)}`;

interface WarrantyRow {
  id: string;
  workOrderId: string;
  workOrderNumber: string;
  expiresAt: string;
  state: string;
  claimWoId: string | null;
}

const state: {
  token?: string;
  cpId?: string;
  garageId?: string;
  vehicleId?: string;
  warrantyDays?: number;
  wo: Partial<Record<'done' | 'claim', { id: string; number: string }>>;
} = { wo: {} };

const api = async <T = unknown>(page: Page, method: string, path: string, body?: unknown) =>
  apiCall<T>(page, state.token ?? (await getToken(page)), method, path, body);

const STATE_LABEL: Record<string, string> = {
  ACTIVE: 'Діє',
  EXPIRING: 'Закінчується',
  EXPIRED: 'Закінчилась',
  CLAIMED: 'Звернення',
};

const ddmmyyyy = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
};

/** Гарантія клієнта спеку з API (той самий список, що читає вкладка). */
async function clientWarranties(page: Page): Promise<WarrantyRow[]> {
  const res = await api<{ items: WarrantyRow[] }>(
    page,
    'GET',
    `/warranties?q=${encodeURIComponent(CLIENT)}&limit=20`,
  );
  expect(res.status).toBe(200);
  return res.body.items;
}

/** Наряд через список нарядів (кнопка «Наряд»), клієнт і авто спеку. */
async function createWorkOrder(page: Page, key: 'done' | 'claim') {
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
  await woModal.getByPlaceholder('Заміна масла, колодок...').fill(`000 E2E TST-WAR ${key}`);
  await woModal.getByRole('button', { name: 'Створити наряд' }).click();
  await expect(woModal).toBeHidden({ timeout: 20_000 });

  const list = await api<{ items: { id: string; number: string }[] }>(
    page,
    'GET',
    `/work-orders?counterpartyId=${state.cpId}&limit=20&sortBy=createdAt&sortDir=desc`,
  );
  const known = new Set(Object.values(state.wo).map(w => w!.id));
  const created = list.body.items.filter(w => !known.has(w.id));
  expect(created, `наряд ${key} створено`).toHaveLength(1);
  state.wo[key] = created[0];
  const card = page.getByRole('dialog').filter({ hasText: created[0].number });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByRole('button', { name: 'Закрити' }).last().click();
  await expect(card).toBeHidden({ timeout: 10_000 });
}

/** Вкладка «Гарантії» з пошуком за клієнтом спеку. */
async function openWarrantiesTab(page: Page) {
  await page.goto('/work-orders');
  await page.getByRole('tab', { name: 'Гарантії' }).click();
  await expect(page).toHaveURL(/tab=warranties/);
  await page.getByRole('textbox', { name: /Пошук: № наряду/ }).fill(CLIENT);
}

const warrantyRow = (page: Page) =>
  page.locator('table tbody tr', { hasText: state.wo.done!.number });

test.describe('Наряди → вкладка «Гарантії» (BR-WAR-001…005)', () => {
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const page = await ctx.newPage();
    await page.goto('/work-orders');
    state.token = await getToken(page);

    const settings = await api<{ defaultWarrantyDays: number }>(
      page,
      'GET',
      '/settings/organisation',
    );
    expect(settings.status).toBe(200);
    state.warrantyDays = settings.body.defaultWarrantyDays;
    expect(
      state.warrantyDays,
      'гарантія створюється сама: defaultWarrantyDays > 0',
    ).toBeGreaterThan(0);

    const cp = await api<{ id: string }>(page, 'POST', '/counterparties', {
      type: 'CLIENT',
      companyName: CLIENT,
    });
    expect(cp.status, `клієнт: ${JSON.stringify(cp.body)}`).toBe(201);
    state.cpId = cp.body.id;
    const garage = await api<{ id: string }>(
      page,
      'POST',
      `/counterparties/${state.cpId}/garages`,
      {
        name: '000 E2E TST-WAR гараж',
      },
    );
    expect(garage.status).toBe(201);
    state.garageId = garage.body.id;
    const vehicle = await api<{ id: string }>(page, 'POST', '/vehicles', {
      customerGarageId: state.garageId,
      ...(await ensureVehicleModel(
        (method, url, data) => api(page, method, url, data),
        'Toyota',
        'Corolla',
      )),
      licensePlate: PLATE,
    });
    expect(vehicle.status).toBe(201);
    state.vehicleId = vehicle.body.id;
    await ctx.close();
  });

  test.afterAll(async ({ request }) => {
    const token = state.token;
    if (!token) return;
    for (const wo of Object.values(state.wo)) {
      if (!wo) continue;
      const cur = await apiRequest<{ status: string }>(
        request,
        token,
        'GET',
        `/work-orders/${wo.id}`,
      );
      // «Виконано» → «Скасовано» сторнує борг клієнта; потім наряд можна видалити.
      if (cur.body?.status === 'COMPLETED') {
        const tr = await apiRequest(request, token, 'POST', `/work-orders/${wo.id}/transition`, {
          status: 'CANCELLED',
        });
        expect.soft(tr.status, `скасування ${wo.number}`).toBeLessThan(300);
      }
      const res = await apiRequest(request, token, 'DELETE', `/work-orders/${wo.id}`);
      expect.soft([200, 204, 404], `DELETE наряду ${wo.number}`).toContain(res.status);
    }
    if (state.vehicleId) {
      const res = await apiRequest(request, token, 'DELETE', `/vehicles/${state.vehicleId}`);
      expect.soft(res.status, 'DELETE авто').toBeLessThan(300);
    }
    // Гараж — до клієнта: гараж видаленого клієнта API вже не видаляє.
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

  // guards: BR-WAR-001, BR-WAR-002, BR-WAR-005
  test('наряд до «Виконано» інтерфейсом → гарантія на вкладці «Гарантії»', async ({ page }) => {
    test.setTimeout(240_000);
    await createWorkOrder(page, 'done');
    const wo = state.wo.done!;

    // Робота з виконавцем: «Виконано» з нульовою сумою сервер не приймає. Виконавець — найстаріший
    // механік (не тимчасовий «000 TST …» іншого тесту).
    await page.goto(`/work-orders/${wo.id}`);
    const mechs = await api<{ items: { firstName: string; lastName: string }[] }>(
      page,
      'GET',
      '/employees?limit=1&role=MECHANIC&sortBy=createdAt&sortDir=asc',
    );
    const mech = mechs.body.items[0];
    expect(mech, 'у базі є механік').toBeTruthy();
    await page.getByRole('button', { name: '+ Робота' }).click();
    const addLine = page.getByRole('dialog', { name: 'Додати роботу' });
    await expect(addLine).toBeVisible({ timeout: 10_000 });
    // Робота — пошуком на сервері (довідник може бути більшим за 200), виконавець — список.
    const works = await api<{ items: { name: string }[] }>(page, 'GET', '/works?limit=1');
    const workName = works.body.items[0]!.name;
    await addLine.getByPlaceholder('Пошук роботи...').fill(workName);
    await page.getByRole('option', { name: workName }).first().click();
    await addLine
      .locator('select')
      .first()
      .selectOption({ label: `${mech.lastName} ${mech.firstName}` });
    await addLine.locator('label', { hasText: 'Ціна' }).locator('..').locator('input').fill('100');
    await addLine.getByRole('button', { name: 'Додати', exact: true }).click();
    await expect(addLine).toBeHidden({ timeout: 15_000 });

    for (const [label, status] of [
      ['Кошторис', 'ESTIMATE'],
      ['Затвердити', 'APPROVED'],
      ['В роботу', 'IN_PROGRESS'],
      ['Виконано', 'COMPLETED'],
    ] as const) {
      await page.getByRole('button', { name: label, exact: true }).click();
      const ask = page.getByRole('dialog').filter({ hasText: 'Перевести наряд у статус' });
      await ask.getByRole('button', { name: 'Так', exact: true }).click();
      await expect(ask).toBeHidden({ timeout: 10_000 });
      await expect
        .poll(
          async () =>
            (await api<{ status: string }>(page, 'GET', `/work-orders/${wo.id}`)).body.status,
          {
            timeout: 15_000,
          },
        )
        .toBe(status);
    }

    // Гарантію створює подія завершення — чекаємо її в API, потім дивимось вкладку.
    await expect
      .poll(async () => (await clientWarranties(page)).length, { timeout: 15_000 })
      .toBe(1);
    const [w] = await clientWarranties(page);
    expect(w.workOrderId).toBe(wo.id);
    // Поріг «закінчується» — WARRANTY_EXPIRING_DAYS (14, BR-WAR-002), не 30.
    const expected = state.warrantyDays! <= WARRANTY_EXPIRING_DAYS ? 'EXPIRING' : 'ACTIVE';
    expect(w.state).toBe(expected);

    await openWarrantiesTab(page);
    const row = warrantyRow(page);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByRole('link', { name: wo.number })).toHaveAttribute(
      'href',
      new RegExp(`/work-orders/${wo.id}/?$`),
    );
    await expect(row).toContainText(CLIENT);
    await expect(row).toContainText(`Toyota Corolla (${PLATE})`);
    await expect(row).toContainText(ddmmyyyy(w.expiresAt));
    await expect(row).toContainText(STATE_LABEL[expected]);
    await page.screenshot({ path: test.info().outputPath('war_tab_row.png') });
  });

  // guards: BR-WAR-002, BR-WAR-005
  test('фільтр стану: свій стан — рядок є, «Закінчилась» — рядка немає', async ({ page }) => {
    test.skip(!state.wo.done, 'наряд не створено');
    await page.goto('/work-orders');
    const [w] = await clientWarranties(page);
    await openWarrantiesTab(page);
    await expect(warrantyRow(page)).toBeVisible({ timeout: 15_000 });

    // Стан — кнопками окремим рядком над пошуком (стандарт списку, 2026-10-22).
    const states = page.getByRole('group', { name: 'Стан' });
    await states.getByRole('button', { name: STATE_LABEL[w.state], exact: true }).click();
    await expect(warrantyRow(page)).toBeVisible({ timeout: 15_000 });
    await states.getByRole('button', { name: STATE_LABEL.EXPIRED, exact: true }).click();
    await expect(page.getByText('Гарантій не знайдено')).toBeVisible({ timeout: 15_000 });
    await expect(warrantyRow(page)).toHaveCount(0);
  });

  // guards: BR-WAR-004, BR-WAR-005
  test('«Звернення»: вибір наряду клієнта → стан «Звернення», повторного звернення немає', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    test.skip(!state.wo.done, 'наряд не створено');
    await createWorkOrder(page, 'claim');
    const claimWo = state.wo.claim!;

    await openWarrantiesTab(page);
    const row = warrantyRow(page);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByRole('button', { name: 'Звернення' }).click();
    const dialog = page.getByRole('dialog', { name: 'Звернення за гарантією' });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    const select = dialog.getByRole('combobox', { name: 'Наряд-звернення' });
    await expect(select.locator('option', { hasText: claimWo.number })).toHaveCount(1, {
      timeout: 15_000,
    });
    await select.selectOption({ value: claimWo.id });
    await dialog.getByRole('button', { name: 'Записати звернення' }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // Список перечитано: стан «Звернення», дії більше немає.
    await expect(row).toContainText('Звернення', { timeout: 15_000 });
    await expect(row.getByRole('button', { name: 'Звернення' })).toHaveCount(0);
    const [w] = await clientWarranties(page);
    expect(w.state).toBe('CLAIMED');
    expect(w.claimWoId).toBe(claimWo.id);
    // BR-WAR-004: друге звернення сервер відхиляє.
    const again = await api<{ message: string }>(page, 'POST', `/warranties/${w.id}/claim`, {
      claimWoId: claimWo.id,
    });
    expect(again.status).toBe(400);
    await page.screenshot({ path: test.info().outputPath('war_claimed.png') });
  });

  // guards: BR-WAR-005
  test('«Пов’язані документи» наряду → вкладка «Гарантії» з гарантією в панелі', async ({
    page,
  }) => {
    test.skip(!state.wo.done, 'наряд не створено');
    const wo = state.wo.done!;
    await page.goto('/work-orders');
    await page.getByPlaceholder('Пошук за номером або клієнтом...').fill(wo.number);
    // Список нарядів типово відібраний на сьогодні — наряд створено сьогодні.
    const woRow = page.locator('table tbody tr', { hasText: wo.number }).first();
    await expect(woRow).toBeVisible({ timeout: 20_000 });
    await woRow.getByTitle(/^Гарантії: /).click();
    const popup = page.getByRole('dialog', { name: "Пов'язані документи наряду" });
    await expect(popup).toBeVisible({ timeout: 10_000 });
    await popup.getByRole('button', { name: /^Перейти до документа: Гарантія/ }).click();

    await expect(page).toHaveURL(/\/work-orders\/?\?tab=warranties$/, { timeout: 15_000 });
    await expect(page.getByRole('tab', { name: 'Гарантії' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('heading', { level: 2, name: wo.number })).toBeVisible({
      timeout: 15_000,
    });
    await page.screenshot({ path: test.info().outputPath('war_linked_panel.png') });
  });
});
