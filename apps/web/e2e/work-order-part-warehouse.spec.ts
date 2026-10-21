import { test, expect, type Page } from '@playwright/test';
import { apiCall, apiRequest, getToken } from './api-helpers';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/**
 * BR-WO-029 (рішення власника 2026-10-21): склад рядка товару наряду показує вільну кількість
 * товару на кожному складі й підставляється сам. Тут — пункт «вільна є лише на одному складі»,
 * і цей склад НЕ основний, тож автовибір видно (без правила лишився б основний / порожньо).
 *
 * Через інтерфейс: прихід товару на склад (документ складу → «Підтвердити»), наряд і рядок товару
 * в картці наряду, вікно «+ Запчастина» на сторінці наряду. Передумови через API — склад, товар,
 * клієнт з авто. Прибирання: наряд, списання залишку (інакше склад не видалити), склад, товар,
 * авто → гараж → клієнт. Документ приходу лишається (складський слід).
 */

const uid = Date.now().toString().slice(-6);
const CLIENT = `000 E2E Склад рядка клієнт ${uid}`;
const PLATE = `WH${uid.slice(-5)}`;
const GOOD = `000 E2E Товар склад рядка ${uid}`;
const WAREHOUSE = `000 E2E Склад BR029 ${uid}`;
const RECEIVED = 3;

const state: {
  token?: string;
  branchId?: string;
  warehouseId?: string;
  goodId?: string;
  cpId?: string;
  garageId?: string;
  vehicleId?: string;
  woId?: string;
  woNumber?: string;
  receiptId?: string;
} = {};

async function api<T = unknown>(page: Page, method: string, path: string, body?: unknown) {
  return apiCall<T>(page, state.token ?? (await getToken(page)), method, path, body);
}

test.describe('Склад рядка товару наряду — вільна кількість і автовибір (BR-WO-029)', () => {
  test.afterAll(async ({ request }) => {
    const token = state.token;
    if (!token) return;
    if (state.woId) {
      const del = await apiRequest(request, token, 'DELETE', `/work-orders/${state.woId}`);
      expect.soft([200, 204, 404], 'DELETE наряду').toContain(del.status);
    }
    // Прихід, що не дійшов до проведення (тест упав раніше), — чернетку видалити.
    if (state.receiptId) {
      const doc = await apiRequest<{ status: string }>(
        request,
        token,
        'GET',
        `/stock-documents/${state.receiptId}`,
      );
      if (doc.body?.status === 'DRAFT') {
        const del = await apiRequest(
          request,
          token,
          'DELETE',
          `/stock-documents/${state.receiptId}`,
        );
        expect.soft(del.status, 'DELETE чернетки приходу').toBeLessThan(300);
      }
    }
    // Залишок тестового складу — списати, інакше склад не видаляється (err.warehouse.hasStock…).
    if (state.warehouseId && state.goodId && state.branchId) {
      const items = await apiRequest<
        Array<{ quantity: number }> | { items: { quantity: number }[] }
      >(
        request,
        token,
        'GET',
        `/stock-items?goodId=${state.goodId}&warehouseId=${state.warehouseId}`,
      );
      const rows = Array.isArray(items.body) ? items.body : (items.body?.items ?? []);
      const qty = rows.reduce((s, r) => s + Number(r.quantity), 0);
      if (qty > 0) {
        const wo = await apiRequest<{ id: string }>(request, token, 'POST', '/stock-documents', {
          type: 'WRITEOFF',
          branchId: state.branchId,
          warehouseId: state.warehouseId,
          notes: '000 E2E прибирання BR-WO-029',
          lines: [{ goodId: state.goodId, quantity: qty, price: 10 }],
        });
        expect.soft(wo.status, 'списання залишку').toBeLessThan(300);
        const conf = await apiRequest(
          request,
          token,
          'POST',
          `/stock-documents/${wo.body.id}/transition`,
          { status: 'CONFIRMED' },
        );
        expect.soft(conf.status, 'проведення списання').toBeLessThan(300);
      }
      const delWh = await apiRequest(request, token, 'DELETE', `/warehouses/${state.warehouseId}`);
      expect.soft(delWh.status, 'DELETE складу').toBeLessThan(300);
    }
    if (state.goodId) {
      const res = await apiRequest(request, token, 'DELETE', `/goods/${state.goodId}`);
      expect.soft(res.status, 'DELETE товару').toBeLessThan(300);
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

  test('товар із залишком лише на неосновному складі: склад підставився, у списку — кількість', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await page.goto('/stock-documents');
    await expect(page.getByRole('button', { name: /^Документ$/ }).first()).toBeVisible({
      timeout: 30_000,
    });
    state.token = await getToken(page);

    // ── Передумови через API ─────────────────────────────────────────────
    const warehouses = await api<Array<{ id: string; type: string; branchId: string }>>(
      page,
      'GET',
      '/warehouses',
    );
    // Будь-який наявний склад із переліку — сусід для перевірки «— 0» і джерело філії. Основного
    // склад у тесті не потребує: вільна лише на одному складі → він, хоч би який був основний.
    const other = warehouses.body.find(w => w.type !== 'TIRE_HOTEL');
    expect(other, 'в організації є склад').toBeTruthy();
    state.branchId = other!.branchId;
    const wh = await api<{ id: string }>(page, 'POST', '/warehouses', {
      name: WAREHOUSE,
      branchId: state.branchId,
    });
    expect(wh.status).toBe(201);
    state.warehouseId = wh.body.id;
    const good = await api<{ id: string }>(page, 'POST', '/goods', {
      name: GOOD,
      sku: `E2E-WH-${uid}`,
      salePrice: 250,
      purchasePrice: 100,
    });
    expect(good.status).toBe(201);
    state.goodId = good.body.id;
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
      make: 'Toyota',
      model: 'Corolla',
      licensePlate: PLATE,
    });
    expect(vehicle.status).toBe(201);
    state.vehicleId = vehicle.body.id;

    // ── Прихід на неосновний склад — документ складу через інтерфейс ─────
    await page.reload();
    await page
      .getByRole('button', { name: /^Документ$/ })
      .first()
      .click();
    const docModal = page.getByRole('dialog').filter({ hasText: 'Створити документ' });
    await expect(docModal).toBeVisible({ timeout: 15_000 });
    await docModal.getByLabel('Тип документа').selectOption('RECEIPT');
    await docModal.getByLabel('Філія').selectOption(state.branchId);
    await docModal.getByLabel(/^Склад\s*\*?$/).selectOption(state.warehouseId);
    await docModal.getByRole('button', { name: 'Додати', exact: true }).click();
    await docModal.getByRole('button', { name: 'Оберіть товар…' }).click();
    const goodPicker = page.getByRole('dialog').filter({ hasText: 'Оберіть товар' }).last();
    await goodPicker.getByPlaceholder('Назва, артикул / штрих-код…').fill(GOOD);
    await goodPicker.getByRole('button', { name: new RegExp(GOOD) }).click();
    const lineRow = docModal.locator('tr', { hasText: GOOD });
    await lineRow.locator('input[type="number"]').first().fill(String(RECEIVED));
    await lineRow.getByPlaceholder('0.00').fill('100');
    // «+» рядка введення — перша кнопка останньої комірки (перша кнопка рядка — вибір товару).
    await lineRow.locator('td').last().locator('button').first().click();
    await expect(docModal.locator('tbody tr', { hasText: GOOD })).toContainText(String(RECEIVED));
    await docModal.getByRole('button', { name: 'Створити документ' }).click();
    // Створений документ — чернетка в списку; відкрити й «Підтвердити» (залишок змінюється).
    await expect(docModal).toBeHidden({ timeout: 20_000 });
    const docRow = page.locator('table tbody tr', { hasText: WAREHOUSE }).first();
    await expect(docRow).toBeVisible({ timeout: 20_000 });
    const docNumber = (await docRow.locator('td').nth(1).innerText()).trim();
    const docs = await api<{ items: Array<{ id: string; number: string }> }>(
      page,
      'GET',
      `/stock-documents?q=${encodeURIComponent(docNumber)}&limit=5`,
    );
    state.receiptId = docs.body.items.find(d => d.number === docNumber)?.id;
    await docRow.hover();
    await docRow.getByRole('button', { name: 'Відкрити документ' }).click();
    const docCard = page.getByRole('dialog').filter({ hasText: docNumber });
    await expect(docCard).toBeVisible({ timeout: 20_000 });
    await docCard.getByRole('button', { name: 'Підтвердити' }).first().click();
    const ask = page.getByRole('dialog').filter({ hasText: 'Бажаєте підтвердити документ' });
    await ask.getByRole('button', { name: 'Так' }).click();
    await expect(ask).toBeHidden({ timeout: 20_000 });
    // Залишок — у базі; вільна кількість на тестовому складі = отримане (резерву немає).
    await expect
      .poll(
        async () =>
          (
            await api<Array<{ byWarehouse: Array<{ warehouseId: string; available: number }> }>>(
              page,
              'GET',
              `/goods/stock-totals?ids=${state.goodId}`,
            )
          ).body[0]?.byWarehouse,
        { timeout: 20_000 },
      )
      .toEqual([expect.objectContaining({ warehouseId: state.warehouseId, available: RECEIVED })]);
    await page.keyboard.press('Escape');

    // ── Наряд через список; рядок товару в картці ────────────────────────
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
    await woModal.getByPlaceholder('Заміна масла, колодок...').fill('000 E2E склад рядка товару');
    await woModal.getByRole('button', { name: 'Створити наряд' }).click();
    await expect(woModal).toBeHidden({ timeout: 20_000 });

    const list = await api<{ items: Array<{ id: string; number: string }> }>(
      page,
      'GET',
      `/work-orders?counterpartyId=${state.cpId}&limit=1&sortBy=createdAt&sortDir=desc`,
    );
    state.woId = list.body.items[0]!.id;
    state.woNumber = list.body.items[0]!.number;
    const card = page.getByRole('dialog').filter({ hasText: state.woNumber });
    await expect(card).toBeVisible({ timeout: 20_000 });

    await card.getByRole('button', { name: 'Додати' }).last().click();
    await card.getByRole('combobox', { name: 'Товар' }).last().fill(GOOD);
    await page
      .getByRole('option', { name: new RegExp(GOOD) })
      .first()
      .click();
    const inputRow = card.locator('tr', { has: page.getByTitle('Зберегти рядок') });
    const whSelect = inputRow.getByRole('combobox', { name: 'Склад' });
    // Склад підставився сам — неосновний, єдиний із вільним залишком.
    await expect(whSelect).toHaveValue(state.warehouseId, { timeout: 15_000 });
    await expect(whSelect.locator('option', { hasText: WAREHOUSE })).toHaveText(
      `${WAREHOUSE} — ${RECEIVED}`,
    );
    await expect(whSelect.locator(`option[value="${other!.id}"]`)).toContainText(' — 0');
    await inputRow.screenshot({ path: test.info().outputPath('wo029_card_row.png') });
    await inputRow.getByTitle('Зберегти рядок').click();
    await card.getByRole('button', { name: 'Зберегти зміни' }).click();
    await expect(card).toBeHidden({ timeout: 20_000 });
    const fresh = await api<{ parts: Array<{ goodId: string; warehouseId: string }> }>(
      page,
      'GET',
      `/work-orders/${state.woId}`,
    );
    expect(fresh.body.parts).toEqual([
      expect.objectContaining({ goodId: state.goodId, warehouseId: state.warehouseId }),
    ]);

    // ── «+ Запчастина» на сторінці наряду: той самий автовибір ───────────
    await page.goto(`/work-orders/${state.woId}`);
    await page.getByRole('button', { name: '+ Запчастина' }).click();
    const partModal = page.getByRole('dialog').filter({ hasText: 'Додати запчастину' });
    await expect(partModal).toBeVisible({ timeout: 15_000 });
    await partModal.getByPlaceholder('Назва, артикул, штрих-код...').fill(GOOD);
    await page
      .getByRole('option', { name: new RegExp(GOOD) })
      .first()
      .click();
    const partWh = partModal.getByRole('combobox', { name: 'Склад' });
    await expect(partWh).toHaveValue(state.warehouseId, { timeout: 15_000 });
    await expect(partWh.locator('option', { hasText: WAREHOUSE })).toHaveText(
      `${WAREHOUSE} — ${RECEIVED}`,
    );
    await expect(partModal.getByTestId('part-stock-indicator')).toHaveText(
      `Вільно: ${RECEIVED} шт`,
    );
    await partModal.screenshot({ path: test.info().outputPath('wo029_add_part.png') });
    await page.keyboard.press('Escape');
  });
});
