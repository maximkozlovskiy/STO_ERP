import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';
import { apiCall, apiRequest, getToken } from './api-helpers';
import { createEmployeeViaUi } from './employee-ui';
import { ensureVehicleModel } from './vehicle-directory';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/**
 * Товари під замовлення у постачальника — «Управління купівлями» (docs/objects/purchase-list.md,
 * рішення власника 2026-10-17), через браузер:
 *  1. два наряди з товаром без залишку (створено й заповнено в інтерфейсі); з картки першого —
 *     «До списку купівлі» (новий список), другий — з вкладки «Нестача» в той самий список;
 *  2. «Позиції» → «Створити замовлення» (одне на постачальника й склад);
 *  3. картка замовлення: «Замовлено» → «Оприбуткувати все» → «Підтвердити прийом»;
 *  4. у картці першого наряду — «прибуло 1 шт, зарезервовано 1 шт» (базова одиниця, Bug #886); «В роботу» резерву не подвоює;
 *  5. скасування другого наряду знімає його резерв;
 *  6. приймальня бачить лише «Управління купівлями», позиції — без масових дій (BR-PL-015).
 *
 * Документи (наряди, список, замовлення, приймання) і приймальня з входом (сторінка
 * «Співробітники», рішення власника 2026-10-19) — через інтерфейс; клієнт з авто, постачальник
 * і товар — передумови через API. Замовлення, отримане й список із отриманими позиціями лишаються
 * в базі навмисно (фінансовий і складський слід); наряди й клієнта прибираємо.
 */

const uid = Date.now().toString().slice(-6);
const CLIENT = `000 E2E Купівля клієнт ${uid}`;
const PLATE = `PL${uid.slice(-5)}`;
const SUPPLIER = `000 E2E Постачальник ${uid}`;
const GOOD = `000 E2E Фільтр купівля ${uid}`;
const LIST_NAME = `000 E2E список ${uid}`;
// Пароль — лише в пам'яті прогону.
const RECEPTION_LOGIN = {
  email: `e2e-tst-pl-rec-${uid}@sto.local`,
  password: `E2e-${Math.random().toString(36).slice(2, 10)}`,
};

interface WoRef {
  id: string;
  number: string;
}
interface ProcurementDto {
  items: Array<{
    status: string;
    reservedQty: number;
    receivedQty: number;
    purchaseOrderId: string | null;
    listId: string;
  }>;
  shortage: Array<{ workOrderPartId: string; shortage: number }>;
}

const state: {
  token?: string;
  cpId?: string;
  garageId?: string;
  vehicleId?: string;
  supplierId?: string;
  goodId?: string;
  warehouse?: { id: string; name: string };
  woA?: WoRef;
  woB?: WoRef;
  poId?: string;
  poNumber?: string;
  receptionId?: string;
} = {};

async function loginAs(browser: Browser, login: { email: string; password: string }) {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(login.email);
  await page.getByLabel('Пароль').fill(login.password);
  await page.getByRole('button', { name: 'Увійти' }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 30_000 });
  return { ctx, page };
}

async function api<T = unknown>(page: Page, method: string, path: string, body?: unknown) {
  return apiCall<T>(page, state.token ?? (await getToken(page)), method, path, body);
}

/** Зарезервовано на складі по товару тесту (агрегат StockItem.reserved). */
async function reservedOnStock(page: Page): Promise<number> {
  const res = await api<Array<{ reserved: number }> | { items: Array<{ reserved: number }> }>(
    page,
    'GET',
    `/stock-items?goodId=${state.goodId}&warehouseId=${state.warehouse!.id}`,
  );
  const rows = Array.isArray(res.body) ? res.body : res.body.items;
  return rows.reduce((s, r) => s + Number(r.reserved), 0);
}

async function procurementOf(page: Page, woId: string): Promise<ProcurementDto> {
  const res = await api<ProcurementDto>(page, 'GET', `/purchase-list-items/by-work-order/${woId}`);
  expect(res.status).toBe(200);
  return res.body;
}

async function openWoCard(page: Page, number: string): Promise<Locator> {
  await page.goto('/work-orders');
  const row = page.locator('table tbody tr', { hasText: number }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.hover();
  await row.getByTitle('Відкрити наряд').click();
  const card = page.getByRole('dialog').filter({ hasText: number });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText(GOOD).first()).toBeVisible({ timeout: 20_000 });
  return card;
}

/** Новий наряд у списку нарядів + рядок товару в його картці («Додати» → «Зберегти зміни»). */
async function createWoWithPart(page: Page, description: string): Promise<WoRef> {
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
  await woModal.getByPlaceholder('Заміна масла, колодок...').fill(description);
  await woModal.getByRole('button', { name: 'Створити наряд' }).click();
  await expect(woModal).toBeHidden({ timeout: 20_000 });

  const list = await api<{ items: WoRef[] }>(
    page,
    'GET',
    `/work-orders?counterpartyId=${state.cpId}&limit=10&sortBy=createdAt&sortDir=desc`,
  );
  const wo = list.body.items[0]!;
  const card = page.getByRole('dialog').filter({ hasText: wo.number });
  await expect(card).toBeVisible({ timeout: 20_000 });

  await card.getByRole('button', { name: 'Додати' }).last().click();
  await card.getByRole('combobox', { name: 'Товар' }).last().fill(GOOD);
  await page
    .getByRole('option', { name: new RegExp(GOOD) })
    .first()
    .click();
  const inputRow = card.locator('tr', { has: page.getByTitle('Зберегти рядок') });
  await inputRow.locator('select').first().selectOption(state.warehouse!.id);
  await inputRow.getByPlaceholder('0').first().fill('1');
  await inputRow.getByTitle('Зберегти рядок').click();
  await card.getByRole('button', { name: 'Зберегти зміни' }).click();
  await expect(card).toBeHidden({ timeout: 20_000 });

  const fresh = await api<{ parts: Array<{ goodId: string; quantity: number }> }>(
    page,
    'GET',
    `/work-orders/${wo.id}`,
  );
  expect(fresh.body.parts).toEqual([
    expect.objectContaining({ goodId: state.goodId, quantity: 1 }),
  ]);
  return { id: wo.id, number: wo.number };
}

test.describe('Управління купівлями — від нестачі в наряді до резерву отриманого', () => {
  test.afterAll(async ({ request }) => {
    const token = state.token;
    if (!token) return;
    // Замовлення, що не дійшло до приймання (тест упав раніше), — прибрати: чернетку видалити,
    // замовлене скасувати (позиції повертаються, BR-PL-010). Отримане лишається слідом.
    if (state.poId) {
      const po = await apiRequest<{ status: string }>(
        request,
        token,
        'GET',
        `/purchase-orders/${state.poId}`,
      );
      if (po.body?.status === 'DRAFT') {
        const del = await apiRequest(request, token, 'DELETE', `/purchase-orders/${state.poId}`);
        expect.soft(del.status, 'DELETE чернетки замовлення').toBeLessThan(300);
      } else if (po.body?.status === 'ORDERED' || po.body?.status === 'PARTIAL') {
        const res = await apiRequest(
          request,
          token,
          'POST',
          `/purchase-orders/${state.poId}/transition`,
          { status: 'CANCELLED' },
        );
        expect.soft(res.status, 'скасування замовлення').toBeLessThan(300);
      }
    }
    // Наряди: «В роботі» → «Призупинено» → «Скасовано» (видаляти можна лише чернетку чи
    // скасований), далі видалення; потім авто → гараж → клієнт.
    for (const wo of [state.woA, state.woB]) {
      if (!wo) continue;
      const cur = await apiRequest<{ status: string }>(
        request,
        token,
        'GET',
        `/work-orders/${wo.id}`,
      );
      const path: Record<string, string[]> = {
        IN_PROGRESS: ['ON_HOLD', 'CANCELLED'],
        ON_HOLD: ['CANCELLED'],
        APPROVED: ['CANCELLED'],
        ESTIMATE: ['CANCELLED'],
      };
      for (const status of path[cur.body?.status] ?? []) {
        await apiRequest(request, token, 'POST', `/work-orders/${wo.id}/transition`, { status });
      }
      const del = await apiRequest(request, token, 'DELETE', `/work-orders/${wo.id}`);
      expect.soft([200, 204, 404], `DELETE наряду ${wo.number}`).toContain(del.status);
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
    if (state.receptionId) {
      const res = await apiRequest(request, token, 'DELETE', `/employees/${state.receptionId}`);
      expect.soft(res.status, 'DELETE приймальні').toBeLessThan(300);
    }
  });

  test('1. наряди з товаром без залишку → «До списку купівлі» з картки й з «Нестачі»', async ({
    page,
  }) => {
    test.setTimeout(240_000);
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
    expect(cp.status).toBe(201);
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
    const supplier = await api<{ id: string }>(page, 'POST', '/counterparties', {
      type: 'SUPPLIER',
      companyName: SUPPLIER,
    });
    expect(supplier.status).toBe(201);
    state.supplierId = supplier.body.id;
    const good = await api<{ id: string }>(page, 'POST', '/goods', {
      name: GOOD,
      sku: `E2E-PL-${uid}`,
      salePrice: 300,
      purchasePrice: 120,
      preferredSupplierId: state.supplierId,
    });
    expect(good.status).toBe(201);
    state.goodId = good.body.id;
    const warehouses = await api<Array<{ id: string; name: string; isMain: boolean }>>(
      page,
      'GET',
      '/warehouses',
    );
    state.warehouse = warehouses.body.find(w => w.isMain) ?? warehouses.body[0];

    // ── Два наряди через інтерфейс ────────────────────────────────────────
    state.woA = await createWoWithPart(page, '000 E2E купівля — наряд А');
    state.woB = await createWoWithPart(page, '000 E2E купівля — наряд Б');

    // ── Картка наряду А: нестача → «До списку купівлі» (новий список) ─────
    const card = await openWoCard(page, state.woA.number);
    const row = card.locator('tr', { hasText: GOOD }).first();
    await expect(row.getByTestId('procurement-badge')).toContainText('нестача 1 шт', {
      timeout: 15_000,
    });
    await card.getByRole('button', { name: 'До списку купівлі' }).click();
    const dialog = page.getByRole('dialog').filter({ hasText: 'Куди додати' });
    await expect(dialog.getByLabel(`Кількість для ${GOOD}`)).toHaveValue('1');
    await dialog.getByLabel('Назва нового списку').fill(LIST_NAME);
    await dialog.getByRole('button', { name: 'Додати до списку' }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(row.getByTestId('procurement-badge')).toContainText('у списку СК-', {
      timeout: 15_000,
    });
    // Escape над діалогом закрив би й картку — картка лишилась відкритою.
    await expect(card).toBeVisible();
    await row.screenshot({ path: test.info().outputPath('pl_e2e_card_in_list.png') });

    const a = await procurementOf(page, state.woA.id);
    expect(a.items).toEqual([expect.objectContaining({ status: 'OPEN' })]);
    const listId = a.items[0]!.listId;

    // ── Вкладка «Нестача»: наряд Б → у той самий список ───────────────────
    await page.goto('/purchase-orders?tab=procurement&view=shortage');
    const shortageRow = page.getByTestId('shortage-row').filter({ hasText: state.woB.number });
    await expect(shortageRow).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByTestId('shortage-row').filter({ hasText: state.woA.number }),
    ).toHaveCount(0);
    await shortageRow.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'До списку купівлі (1)' }).click();
    const dialog2 = page.getByRole('dialog').filter({ hasText: 'Куди додати' });
    await dialog2.getByLabel('Наявний відкритий список').check();
    await dialog2.getByLabel('Список', { exact: true }).selectOption({ value: listId });
    await dialog2.getByRole('button', { name: 'Додати до списку' }).click();
    await expect(dialog2).toBeHidden({ timeout: 15_000 });
    const b = await procurementOf(page, state.woB.id);
    expect(b.items).toEqual([expect.objectContaining({ status: 'OPEN', listId })]);
  });

  test('2. «Позиції» → «Створити замовлення» постачальнику товару', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/purchase-orders?tab=procurement&view=items');
    await page.getByLabel('Товар, артикул, код').fill(GOOD);
    const rows = page.getByTestId('purchase-list-item-row').filter({ hasText: GOOD });
    await expect(rows).toHaveCount(2, { timeout: 30_000 });
    await expect(rows.first()).toContainText(SUPPLIER);
    for (const r of await rows.all()) await r.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Створити замовлення' }).click();
    await page.getByRole('button', { name: 'Так' }).click();
    await expect(page.getByText(/Створено замовлення: /)).toBeVisible({ timeout: 15_000 });

    const a = await procurementOf(page, state.woA!.id);
    const b = await procurementOf(page, state.woB!.id);
    expect(a.items[0]).toMatchObject({ status: 'ORDERED' });
    expect(b.items[0]!.purchaseOrderId).toBe(a.items[0]!.purchaseOrderId);
    state.poId = a.items[0]!.purchaseOrderId!;
    const po = await api<{
      number: string;
      status: string;
      lines: Array<{ goodId: string; quantity: number; price: number }>;
    }>(page, 'GET', `/purchase-orders/${state.poId}`);
    expect(po.body.status).toBe('DRAFT');
    expect(po.body.lines).toEqual([
      expect.objectContaining({ goodId: state.goodId, quantity: 2, price: 120 }),
    ]);
    state.poNumber = po.body.number;
  });

  test('3. замовлення: «Замовлено» → «Оприбуткувати все» → «Підтвердити прийом»', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    // На 1280px шапка картки замовлення виходить за край — статус недосяжний (див. звіт).
    await page.setViewportSize({ width: 1680, height: 950 });
    await page.goto(`/purchase-orders?open=${state.poId}`);
    const modal = page.getByRole('dialog').filter({ hasText: state.poNumber! });
    await expect(modal).toBeVisible({ timeout: 30_000 });
    await modal
      .getByRole('button', { name: /Замовлено/ })
      .first()
      .click();
    await expect(modal.getByRole('button', { name: 'Оприбуткувати' })).toBeVisible({
      timeout: 15_000,
    });
    await modal.getByRole('button', { name: 'Оприбуткувати' }).click();
    await modal.getByRole('button', { name: 'Оприбуткувати все' }).click();
    await modal.getByRole('button', { name: 'Підтвердити прийом' }).click();
    await expect
      .poll(
        async () =>
          (await api<{ status: string }>(page, 'GET', `/purchase-orders/${state.poId}`)).body
            .status,
        {
          timeout: 20_000,
        },
      )
      .toBe('RECEIVED');

    // Отримане одразу зарезервовано під обидва наряди (BR-PL-011).
    const a = await procurementOf(page, state.woA!.id);
    const b = await procurementOf(page, state.woB!.id);
    expect(a.items[0]).toMatchObject({ status: 'RECEIVED', receivedQty: 1, reservedQty: 1 });
    expect(b.items[0]).toMatchObject({ status: 'RECEIVED', receivedQty: 1, reservedQty: 1 });
    expect(await reservedOnStock(page)).toBe(2);
  });

  test('4. картка наряду А: «прибуло 1, зарезервовано 1»; «В роботу» без подвійного резерву', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const card = await openWoCard(page, state.woA!.number);
    const row = card.locator('tr', { hasText: GOOD }).first();
    await expect(row.getByTestId('procurement-badge')).toContainText(
      'прибуло 1 шт, зарезервовано 1 шт',
      {
        timeout: 15_000,
      },
    );
    await expect(row.getByTestId('procurement-badge')).not.toContainText('нестача');
    await row.screenshot({ path: test.info().outputPath('pl_e2e_card_reserved.png') });

    // Чернетка → Кошторис → Затверджено → В роботі — кнопкою наступного кроку статусу.
    for (const next of ['Кошторис', 'Затверджено', 'В роботі']) {
      await card
        .getByRole('button', { name: new RegExp(`^${next}$`) })
        .last()
        .click();
      await expect
        .poll(
          async () =>
            (await api<{ status: string }>(page, 'GET', `/work-orders/${state.woA!.id}`)).body
              .status,
          {
            timeout: 15_000,
          },
        )
        .toBe({ Кошторис: 'ESTIMATE', Затверджено: 'APPROVED', 'В роботі': 'IN_PROGRESS' }[next]);
    }
    expect(await reservedOnStock(page)).toBe(2);
    const a = await procurementOf(page, state.woA!.id);
    expect(a.shortage).toEqual([]);
  });

  test('5. скасування наряду Б знімає його резерв', async ({ page }) => {
    test.setTimeout(120_000);
    const card = await openWoCard(page, state.woB!.number);
    await card.getByRole('button', { name: 'Чернетка' }).first().click();
    await card.getByRole('button', { name: 'Скасувати' }).first().click();
    // BR-WO-025: скасування в картці — після підтвердження.
    await page.getByRole('button', { name: 'Так, скасувати' }).click();
    await expect
      .poll(
        async () =>
          (await api<{ status: string }>(page, 'GET', `/work-orders/${state.woB!.id}`)).body.status,
        {
          timeout: 15_000,
        },
      )
      .toBe('CANCELLED');
    expect(await reservedOnStock(page)).toBe(1);
  });

  test('6. приймальня: лише «Управління купівлями», позиції — без масових дій', async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);
    // Приймальня з входом — формою «Новий співробітник».
    await createEmployeeViaUi(page, {
      onCreated: id => {
        state.receptionId = id;
      },
      firstName: 'Приймальня',
      lastName: `000 E2E купівля ${uid}`,
      role: 'RECEPTIONIST',
      login: RECEPTION_LOGIN,
    });

    const { ctx, page: rp } = await loginAs(browser, RECEPTION_LOGIN);
    const forbidden: string[] = [];
    rp.on('response', r => {
      if (r.status() === 403) forbidden.push(`${r.request().method()} ${r.url()}`);
    });
    // Пряма адреса вкладки замовлень відкриває приймальні лише «Управління купівлями».
    await rp.goto('/purchase-orders?tab=orders');
    await expect(rp.getByText('Управління купівлями').first()).toBeVisible({ timeout: 30_000 });
    await expect(rp.getByRole('button', { name: 'Замовлення постачальникам' })).toHaveCount(0);
    await expect(rp.getByRole('button', { name: 'Повернення постачальнику' })).toHaveCount(0);

    await rp.getByRole('tab', { name: 'Позиції' }).click();
    await rp.getByLabel('Товар, артикул, код').fill(GOOD);
    await rp
      .getByRole('group', { name: 'Статус' })
      .getByRole('button', { name: 'Всі', exact: true })
      .click();
    const rows = rp.getByTestId('purchase-list-item-row').filter({ hasText: GOOD });
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });
    await expect(rows.first().getByRole('checkbox')).toHaveCount(0);
    await expect(rp.getByRole('button', { name: 'Зняти резерв' })).toHaveCount(0);
    await rp.screenshot({ path: test.info().outputPath('pl_e2e_reception_items.png') });
    // Наведення на «Купівля» в меню не підтягує список замовлень, закритий приймальні (403).
    await rp.getByRole('link', { name: 'Купівля' }).first().hover();
    await rp.waitForLoadState('networkidle');
    expect(forbidden, 'приймальня не отримує 403 на своїй вкладці').toEqual([]);
    await ctx.close();
  });
});
