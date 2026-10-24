import { test, expect, type Page } from '@playwright/test';
import { apiCall, apiRequest, getToken } from './api-helpers';
import { ensureVehicleModel } from './vehicle-directory';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/**
 * BR-WO-032 (рішення власника 2026-10-24): посилання на кошторис має дату згорання, його можна
 * відкликати й видати нове. Наскрізне: наряд створюється в картці, «Поділитись» показує панель
 * посилання з датою, кошторис за посиланням відкривається без входу; «Відкликати» — та сама адреса
 * показує «Посилання не дійсне»; «Згенерувати нове» — нова адреса працює.
 *
 * Прострочення тут не перевіряється: сервер E2E живе за справжнім годинником, а термін — 30 днів;
 * межу терміну стереже `work-orders.share-expiry.spec.ts` (фейковий годинник).
 *
 * Передумови через API — клієнт, гараж, авто. Прибирання: наряд (через «Скасовано»), авто, гараж,
 * клієнт. Публічний кошторис має ліміт 20 запитів/хв з IP: тут три відкриття сторінки
 * (у dev-збірці кожне — два запити), тож `--repeat-each` цього спеку впирається в 429.
 */

const uid = `${Date.now().toString().slice(-6)}${process.pid % 1000}`;
const CLIENT = `000 E2E TST-SHARE ${uid} клієнт`;
const PLATE = `SH${uid.slice(-5)}`;
const INVALID = 'Посилання не дійсне або термін дії минув';

const state: {
  token?: string;
  cpId?: string;
  garageId?: string;
  vehicleId?: string;
  woId?: string;
} = {};

async function api<T = unknown>(page: Page, method: string, path: string, body?: unknown) {
  return apiCall<T>(page, state.token ?? (await getToken(page)), method, path, body);
}

/** Кошторис за адресою — у вікні без входу (клієнт, якому надіслали посилання). */
async function openAsClient(page: Page, url: string) {
  const ctx = await page.context().browser()!.newContext();
  const client = await ctx.newPage();
  await client.goto(url);
  return { client, close: () => ctx.close() };
}

test.describe('Посилання на кошторис — відкликання й нове посилання (BR-WO-032)', () => {
  test.afterAll(async ({ request }) => {
    const token = state.token;
    if (!token) return;
    if (state.woId) {
      // «Кошторис» видаляється лише через «Скасовано».
      await apiRequest(request, token, 'POST', `/work-orders/${state.woId}/transition`, {
        status: 'CANCELLED',
      });
      const res = await apiRequest(request, token, 'DELETE', `/work-orders/${state.woId}`);
      expect.soft([200, 204, 404], 'DELETE наряду').toContain(res.status);
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

  // guards: BR-WO-032
  test('«Поділитись» → кошторис відкривається; «Відкликати» → недійсне; «Згенерувати нове» → нове працює', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.goto('/work-orders');
    await expect(page.getByRole('button', { name: /^Наряд$/ }).first()).toBeVisible({
      timeout: 30_000,
    });
    state.token = await getToken(page);

    // ── Передумови через API: клієнт з авто ──────────────────────────────
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
      { name: '000 E2E гараж' },
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

    // ── Наряд — через інтерфейс ──────────────────────────────────────────
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
    await woModal
      .getByPlaceholder('Заміна масла, колодок...')
      .fill('000 E2E посилання на кошторис');
    await woModal.getByRole('button', { name: 'Створити наряд' }).click();
    await expect(woModal).toBeHidden({ timeout: 20_000 });

    const list = await api<{ items: Array<{ id: string; number: string }> }>(
      page,
      'GET',
      `/work-orders?counterpartyId=${state.cpId}&limit=1&sortBy=createdAt&sortDir=desc`,
    );
    state.woId = list.body.items[0]!.id;
    const card = page.getByRole('dialog').filter({ hasText: list.body.items[0]!.number });
    await expect(card).toBeVisible({ timeout: 20_000 });

    // Чернетка → Кошторис кнопкою статусу: клієнтові надсилають кошторис. Заразом наряд не стає
    // «донором» для estimate-share.spec.ts, який клонує першу ж чернетку (з нашим клієнтом і авто).
    await card
      .getByRole('button', { name: /^Кошторис$/ })
      .last()
      .click();
    await expect
      .poll(
        async () =>
          (await api<{ status: string }>(page, 'GET', `/work-orders/${state.woId}`)).body.status,
        { timeout: 15_000 },
      )
      .toBe('ESTIMATE');

    // ── «Поділитись»: панель з адресою й датою згорання ──────────────────
    await card.getByRole('button', { name: 'Поділитись' }).click();
    const panel = page.getByTestId('wo-share-link-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByTestId('wo-share-expires')).toHaveText(
      /^Діє до \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}$/,
    );
    const linkBox = panel.getByRole('textbox', { name: 'Посилання на кошторис для клієнта' });
    const firstUrl = await linkBox.inputValue();
    expect(firstUrl).toMatch(/\/estimate\/[0-9a-f]{32}$/);
    await panel.screenshot({ path: test.info().outputPath('wo032_share_panel.png') });

    // Термін — 30 днів від видачі (точну межу стереже api-спек із фейковим годинником).
    const issued = await api<{ token: string; expiresAt: string }>(
      page,
      'POST',
      `/work-orders/${state.woId}/share-token`,
    );
    expect(firstUrl.endsWith(issued.body.token), 'повторний POST — той самий чинний токен').toBe(
      true,
    );
    const days = (Date.parse(issued.body.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);

    const first = await openAsClient(page, firstUrl);
    try {
      await expect(first.client.getByRole('heading', { name: /Кошторис/ })).toBeVisible({
        timeout: 30_000,
      });

      // ── «Відкликати»: та сама адреса — «недійсне» ───────────────────────
      await panel.getByRole('button', { name: 'Відкликати' }).click();
      await expect(panel.getByRole('status')).toContainText('Посилання відкликано');
      await expect(linkBox).toBeHidden();
      await first.client.reload();
      await expect(first.client.getByText(INVALID)).toBeVisible({ timeout: 30_000 });
      await first.client.screenshot({ path: test.info().outputPath('wo032_revoked_public.png') });
    } finally {
      await first.close();
    }

    // ── «Згенерувати нове»: нова адреса працює (що стара не оживає — api-спек) ───
    await panel.getByRole('button', { name: 'Згенерувати нове' }).click();
    await expect(linkBox).toBeVisible({ timeout: 15_000 });
    const secondUrl = await linkBox.inputValue();
    expect(secondUrl).not.toBe(firstUrl);

    const second = await openAsClient(page, secondUrl);
    try {
      await expect(second.client.getByRole('heading', { name: /Кошторис/ })).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await second.close();
    }

    // Escape закриває лише панель, картка лишається.
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(card).toBeVisible();
  });
});
