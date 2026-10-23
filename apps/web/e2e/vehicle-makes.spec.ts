import { test, expect, type Page } from '@playwright/test';
import { apiCall, getToken } from './api-helpers';
import { createCounterparty } from './cash-desk.helpers';
import {
  pickVehicleDirectory,
  searchVehicleDirectory,
  vehicleDirectoryField,
} from './vehicle-directory';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/**
 * Довідник «Контрагенти → Марки авто» (BR-VEH-006…013) через інтерфейс:
 * марки й модель додаються у вкладці → авто створюється у формі вибором із довідника → видалити
 * марку з авто не можна (400 з пропозицією злити) → «Злити в…» переносить авто до іншої марки,
 * разом із моделлю, і назва в авто змінюється. Клієнт і гараж — лише передумови через API.
 */
const uid = Date.now().toString().slice(-6);
const CLIENT = `000 E2E Марки авто ${uid}`;
const MAKE_A = `000 E2E Марка ${uid}`;
const MAKE_B = `000 E2E Ціль ${uid}`;
const MODEL = `000 E2E Модель ${uid}`;

interface Entry {
  id: string;
  name: string;
  deletedAt?: string | null;
}
interface VehicleDto {
  id: string;
  makeId: string;
  modelId: string;
  make: string;
  model: string;
}

const state: {
  token?: string;
  cpId?: string;
  garageId?: string;
  vehicleId?: string;
} = {};

const itemsOf = (body: unknown): Entry[] => (body as { items?: Entry[] } | null)?.items ?? [];

async function makesByName(page: Page): Promise<Map<string, Entry>> {
  const res = await apiCall(page, state.token!, 'GET', '/vehicle-makes?showDeleted=true');
  expect(res.status).toBe(200);
  return new Map(itemsOf(res.body).map(m => [m.name, m]));
}

async function openTab(page: Page) {
  await page.goto('/counterparties?tab=vehicle-makes');
  const tab = page.getByTestId('vehicle-makes-tab');
  await expect(tab).toBeVisible({ timeout: 30_000 });
  await tab.getByPlaceholder('Пошук марки').fill(uid);
  return tab;
}

async function addMake(page: Page, name: string) {
  const tab = page.getByTestId('vehicle-makes-tab');
  await tab.getByRole('button', { name: 'Марка', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Нова марка' });
  await dialog.getByLabel('Назва марки').fill(name);
  await dialog.getByRole('button', { name: 'Зберегти' }).click();
  await expect(dialog).toBeHidden();
  await expect(tab.getByRole('button', { name, exact: true })).toBeVisible();
}

test.describe('Марки авто — довідник через інтерфейс', () => {
  test.afterAll(async ({ browser }) => {
    if (!state.token) return;
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const page = await ctx.newPage();
    await page.goto('/dashboard');
    const call = (method: string, path: string) => apiCall(page, state.token!, method, path);
    // Авто гаража тесту — і тоді, коли тест упав до того, як запам'ятав id.
    if (state.garageId) {
      const list = await apiCall<{ id: string }[]>(
        page,
        state.token,
        'GET',
        `/vehicles?customerGarageId=${state.garageId}`,
      );
      for (const v of Array.isArray(list.body) ? list.body : []) {
        const res = await call('DELETE', `/vehicles/${v.id}`);
        expect.soft(res.status, 'DELETE авто').toBeLessThan(300);
      }
    }
    // Марки тесту: видалення марки без живих авто видаляє й її моделі (BR-VEH-009).
    const makes = await makesByName(page);
    for (const name of [MAKE_A, MAKE_B]) {
      const make = makes.get(name);
      if (make && !make.deletedAt) {
        const res = await call('DELETE', `/vehicle-makes/${make.id}`);
        expect.soft(res.status, `DELETE марки ${name}`).toBe(204);
      }
    }
    // Гараж — до клієнта.
    if (state.cpId && state.garageId) {
      const res = await call('DELETE', `/counterparties/${state.cpId}/garages/${state.garageId}`);
      expect.soft(res.status, 'DELETE гаража').toBeLessThan(300);
    }
    if (state.cpId) {
      const res = await call('DELETE', `/counterparties/${state.cpId}`);
      expect.soft(res.status, 'DELETE клієнта').toBeLessThan(300);
    }
    await ctx.close();
  });

  // guards: BR-VEH-006, BR-VEH-007, BR-VEH-008, BR-VEH-009, BR-VEH-010, BR-VEH-011
  test('марка й модель у вкладці → авто з вибору → видалення заблоковане → злиття переносить авто', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.goto('/counterparties');
    state.token = await getToken(page);
    state.cpId = await createCounterparty(page, state.token, 'CLIENT', CLIENT);
    const garage = await apiCall<{ id: string }>(
      page,
      state.token,
      'POST',
      `/counterparties/${state.cpId}/garages`,
      { name: '000 E2E гараж' },
    );
    expect(garage.status, `гараж: ${JSON.stringify(garage.body)}`).toBe(201);
    state.garageId = garage.body.id;

    // ── Вкладка: дві марки й модель першої ─────────────────────────────────────
    const tab = await openTab(page);
    await addMake(page, MAKE_A);
    await addMake(page, MAKE_B);
    await tab.getByRole('button', { name: MAKE_A, exact: true }).click();
    await expect(tab.getByText(`Моделі ${MAKE_A}`)).toBeVisible();
    await tab.getByRole('button', { name: 'Модель', exact: true }).click();
    const modelDialog = page.getByRole('dialog', { name: 'Нова модель' });
    await modelDialog.getByLabel('Назва моделі').fill(MODEL);
    await modelDialog.getByRole('button', { name: 'Зберегти' }).click();
    await expect(modelDialog).toBeHidden();
    await expect(tab.getByTestId('vehicle-model-row').filter({ hasText: MODEL })).toBeVisible();

    // ── Форма авто: лише вибір; модель — моделі обраної марки ────────────────
    await page.goto(`/vehicles/new?garageId=${state.garageId}`);
    await expect(page.locator('h1:has-text("Новий автомобіль")')).toBeVisible({ timeout: 20_000 });
    await expect(vehicleDirectoryField(page, 'model').getByRole('combobox')).toBeDisabled();
    await pickVehicleDirectory(page, page, 'make', MAKE_A);
    await searchVehicleDirectory(page, 'model', `модель ${uid}`, MODEL);
    await page
      .getByRole('button', { name: /Створити|Зберегти/ })
      .first()
      .click();
    await page.waitForURL(/\/vehicles\/[0-9a-f-]{36}\/?$/, { timeout: 15_000 });
    state.vehicleId = /\/vehicles\/([0-9a-f-]{36})/.exec(page.url())?.[1];
    await expect(page.locator('h1').first()).toContainText(`${MAKE_A} ${MODEL}`, {
      timeout: 20_000,
    });

    // ── Видалити марку з авто не можна: текст сервера і кнопка злиття ─────────
    const tab2 = await openTab(page);
    const rowA = tab2.getByTestId('vehicle-make-row').filter({ hasText: MAKE_A });
    await rowA.getByRole('button', { name: `Видалити: ${MAKE_A}` }).click();
    await page
      .getByRole('dialog', { name: 'Видалити марку?' })
      .getByRole('button', { name: 'Так' })
      .click();
    const alert = tab2.getByRole('alert');
    await expect(alert).toContainText('Злийте її з іншою маркою');

    // ── Злиття через кнопку в повідомленні ───────────────────────────────────
    await alert.getByRole('button', { name: 'Злити в…' }).click();
    const merge = page.getByRole('dialog', { name: 'Злити марку' });
    await merge.getByLabel('Марка, у яку злити').selectOption({ label: MAKE_B });
    await merge.getByRole('button', { name: 'Злити' }).click();
    await page
      .getByRole('dialog', { name: 'Злити марки?' })
      .getByRole('button', { name: 'Злити' })
      .click();
    await expect(merge).toBeHidden();
    await expect(tab2.getByRole('button', { name: MAKE_A, exact: true })).toHaveCount(0);
    await expect(tab2.getByText(`Моделі ${MAKE_B}`)).toBeVisible();
    await expect(tab2.getByTestId('vehicle-model-row').filter({ hasText: MODEL })).toBeVisible();

    // Авто тепер — марки B з тією ж моделлю, назва в авто оновлена (BR-VEH-010, 011).
    const makes = await makesByName(page);
    const vehicle = await apiCall<VehicleDto>(
      page,
      state.token,
      'GET',
      `/vehicles/${state.vehicleId}`,
    );
    expect(vehicle.status).toBe(200);
    expect(vehicle.body).toMatchObject({
      makeId: makes.get(MAKE_B)?.id,
      make: MAKE_B,
      model: MODEL,
    });
    expect(makes.get(MAKE_A)?.deletedAt).toBeTruthy();
  });
});
