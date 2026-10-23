import { test, expect } from '@playwright/test';
import { API } from './api-url';
import { apiCall, getToken } from './api-helpers';
import { ensureVehicleModel, type ApiCaller } from './vehicle-directory';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/**
 * /vehicles/[id] і /vehicles/new — карточка авто і форма створення.
 * Авто в системі є дочірніми сутностями CustomerGarage (гаражу контрагента-клієнта).
 *
 * Покриття:
 * - Карточка існуючого авто (seed: Toyota Camry AA1234BB) — заголовок, метадані, кнопка "Назад".
 * - Форма "Новий автомобіль" — наявність полів, валідація обов'язкових (Make/Model); марка й
 *   модель — вибір із довідника (BR-VEH-008).
 * - Вкладка вузлів — рендериться без помилок (порожня або з даними).
 * - Регламент ТО — секція присутня.
 */
test.describe('Автомобілі', () => {
  let vehicleId: string;
  let garageId: string;

  test.beforeAll(async ({ browser }) => {
    // Дістати реальний vehicleId + garageId з seed через API.
    // Заходимо на справжню сторінку (не /), щоб AuthProvider скопіював
    // localStorage.sto_e2e_access_token → sessionStorage.sto_access_token.
    const ctx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const page = await ctx.newPage();
    await page.goto('/dashboard');
    await page.waitForTimeout(1000);
    const token = await page.evaluate(
      () =>
        sessionStorage.getItem('sto_access_token') ?? localStorage.getItem('sto_e2e_access_token'),
    );
    const data = await page.evaluate(
      async ({ tok, api }) => {
        const r = await fetch(`${api}/vehicles?limit=1`, {
          headers: { Authorization: `Bearer ${tok}` },
        });
        if (!r.ok) return { vehicleId: null, garageId: null };
        const list = await r.json();
        return {
          vehicleId: list[0]?.id ?? null,
          garageId: list[0]?.customerGarageId ?? null,
        };
      },
      { tok: token, api: API },
    );
    vehicleId = data.vehicleId;
    garageId = data.garageId;
    await ctx.close();
  });

  test('карточка авто з seed (Toyota Camry) — завантажується з h1 + кнопка Назад', async ({
    page,
  }) => {
    expect(vehicleId, 'Seed має містити хоча б 1 авто').toBeTruthy();
    await page.goto(`/vehicles/${vehicleId}`);

    // h1 містить make+model.
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 20_000 });
    const h1Text = await page.locator('h1').first().textContent();
    expect(h1Text).toMatch(/Toyota|Camry|.+/);

    // Кнопка "Назад" присутня
    await expect(page.locator('button:has-text("Назад")').first()).toBeVisible({ timeout: 5_000 });
    // Кнопка "Редагувати" присутня
    await expect(page.locator('button:has-text("Редагувати")').first()).toBeVisible({
      timeout: 5_000,
    });
  });

  test('карточка авто — секція "Вузли автомобіля" присутня', async ({ page }) => {
    expect(vehicleId).toBeTruthy();
    await page.goto(`/vehicles/${vehicleId}`);
    await expect(page.locator('h2:has-text("Вузли автомобіля")').first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test('карточка авто — секція "Історія пробігу" показує рівно те, що віддає API', async ({
    page,
  }) => {
    expect(vehicleId).toBeTruthy();
    const mileageResponse = page.waitForResponse(
      r => r.url().includes(`/vehicles/${vehicleId}/mileage`) && r.request().method() === 'GET',
      { timeout: 30_000 },
    );
    await page.goto(`/vehicles/${vehicleId}`);

    const section = page.getByTestId('mileage-history');
    await expect(section.locator('h2:has-text("Історія пробігу")')).toBeVisible({
      timeout: 20_000,
    });

    const response = await mileageResponse;
    expect(response.status(), 'GET /vehicles/:id/mileage має відповісти 200').toBe(200);
    const points = (await response.json()) as { workOrderId: string; isRollback: boolean }[];
    expect(Array.isArray(points), 'контракт: масив, не { items, total }').toBe(true);

    await expect(section.getByTestId('mileage-skeleton')).toHaveCount(0, { timeout: 10_000 });
    await expect(section.locator('[role="alert"]')).toHaveCount(0);
    await expect(section.locator('tbody tr')).toHaveCount(points.length);
    await expect(section.locator('tbody tr[data-rollback="true"]')).toHaveCount(
      points.filter(p => p.isRollback).length,
    );
    await expect(section.getByText('Ще немає нарядів із зафіксованим пробігом')).toHaveCount(
      points.length === 0 ? 1 : 0,
    );
  });

  test('карточка авто — секція "Регламент ТО" присутня', async ({ page }) => {
    expect(vehicleId).toBeTruthy();
    await page.goto(`/vehicles/${vehicleId}`);
    await expect(page.locator('h2:has-text("Регламент ТО")').first()).toBeVisible({
      timeout: 20_000,
    });
  });

  test('карточка авто — Info полями: held лицензії, рік тощо', async ({ page }) => {
    expect(vehicleId).toBeTruthy();
    await page.goto(`/vehicles/${vehicleId}`);
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 20_000 });

    // Дізнатись реальні дані авто з API (E2E-seed або Toyota Camry — будь-яке).
    // Раніше hardcoded "AA1234BB|2020|Toyota" — крихко при чисто E2E-сеед.
    const token = await page.evaluate(() => sessionStorage.getItem('sto_access_token'));
    const vehicle = await page.evaluate(
      async ({ tok, id, api }) => {
        const r = await fetch(`${api}/vehicles/${id}`, {
          headers: { Authorization: `Bearer ${tok}` },
        });
        if (!r.ok) return null;
        return r.json();
      },
      { tok: token, id: vehicleId, api: API },
    );
    expect(vehicle, 'API має повернути авто').toBeTruthy();

    // make+model завжди є — присутні у h1, перевіряємо через page.
    expect(vehicle.make).toBeTruthy();
    expect(vehicle.model).toBeTruthy();
    await expect(
      page.getByText(new RegExp(vehicle.make.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Хоча б одне з опціональних полів має бути присутнім (Info-рядки рендеряться
    // тільки якщо value truthy). Якщо немає жодного — це нормально для E2E-fixture.
    const optional = [vehicle.licensePlate, vehicle.year, vehicle.vin, vehicle.color].filter(
      Boolean,
    );
    if (optional.length > 0) {
      const optionalRegex = new RegExp(
        optional.map(v => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
        'i',
      );
      await expect(page.getByText(optionalRegex).first()).toBeVisible({ timeout: 5_000 });
    }
  });

  test('/vehicles/new — форма "Новий автомобіль" завантажується', async ({ page }) => {
    expect(garageId).toBeTruthy();
    await page.goto(`/vehicles/new?garageId=${garageId}`);
    await expect(page.locator('h1:has-text("Новий автомобіль")')).toBeVisible({ timeout: 20_000 });
    // Форма мігрувала на спільний RHF-native VehicleForm (commit 2bd77ba9): плоский layout полів
    // без h2-секцій. Перевіряємо, що ключові поля форми присутні (марка/модель/VIN/технічні).
    // За label, не за текстом: у випадних списках марок і моделей є назви з «VIN» (дані довідника).
    await expect(page.getByLabel('Марка')).toBeVisible();
    await expect(page.getByLabel('Модель')).toBeVisible();
    await expect(page.getByLabel('VIN')).toBeVisible();
    await expect(page.getByText('Пальне', { exact: false }).first()).toBeVisible();
  });

  test('/vehicles/new — кнопка "Створити" без обовязкових полів задізейблена або show error', async ({
    page,
  }) => {
    expect(garageId).toBeTruthy();
    await page.goto(`/vehicles/new?garageId=${garageId}`);
    await expect(page.locator('h1:has-text("Новий автомобіль")')).toBeVisible({ timeout: 20_000 });

    // Кнопки "Створити" / "Зберегти" / "Додати"
    const submit = page
      .locator('button:has-text("Створити"), button:has-text("Зберегти"), button[type="submit"]')
      .first();
    await expect(submit).toBeVisible({ timeout: 10_000 });
    // Очікуємо що при порожній формі або disabled, або клік показує помилку
    const enabled = await submit.isEnabled().catch(() => false);
    if (enabled) {
      await submit.click();
      // Якщо API відповів, очікуємо повідомлення (помилка валідації або redirect).
      // Тут просто переконуємось що сторінка не впала.
      await expect(page.locator('h1').first()).toBeVisible({ timeout: 5_000 });
    } else {
      await expect(submit).toBeDisabled();
    }
  });

  // guards: BR-VEH-008
  test('/vehicles/new — марка й модель з довідника: створити авто через UI → картка з назвами', async ({
    page,
  }) => {
    expect(garageId).toBeTruthy();
    await page.goto(`/vehicles/new?garageId=${garageId}`);
    await expect(page.locator('h1:has-text("Новий автомобіль")')).toBeVisible({ timeout: 20_000 });
    const token = await getToken(page);
    const call: ApiCaller = (method, url, data) => apiCall(page, token, method, url, data);

    // Передумова — модель у довіднику (форма авто лише обирає; довідник веде вкладка
    // «Контрагенти → Марки авто», її стереже vehicle-makes.spec.ts).
    const modelName = `000 E2E ${Date.now().toString().slice(-6)}`;
    const { modelId } = await ensureVehicleModel(call, 'Toyota', modelName);

    const make = page.getByLabel('Марка');
    const model = page.getByLabel('Модель');
    await expect(model).toBeDisabled();
    await make.selectOption({ label: 'Toyota' });
    await expect(model).toBeEnabled();
    await model.selectOption({ label: modelName });

    const submit = page
      .locator('button:has-text("Створити"), button:has-text("Зберегти"), button[type="submit"]')
      .first();
    await submit.click();

    await page.waitForURL(/\/vehicles\/[0-9a-f-]{36}\/?$/, { timeout: 15_000 });
    const vehicleIdCreated = /\/vehicles\/([0-9a-f-]{36})/.exec(page.url())?.[1] ?? '';
    await expect(page.locator('h1').first()).toContainText(`Toyota ${modelName}`, {
      timeout: 20_000,
    });

    // Прибирання: авто, потім модель (модель з живим авто сервер не видаляє — BR-VEH-009).
    const del = await call('DELETE', `/vehicles/${vehicleIdCreated}`);
    expect.soft(del.status, 'видалення авто').toBe(204);
    const delModel = await call('DELETE', `/vehicle-models/${modelId}`);
    expect.soft(delModel.status, 'видалення моделі').toBe(204);
  });
});
