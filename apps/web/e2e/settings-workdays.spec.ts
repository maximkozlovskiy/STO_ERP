import { test, expect } from '@playwright/test';
import { apiCall, apiRequest, getToken } from './api-helpers';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/**
 * Робочі дні філії (рішення власника 2026-11-06, BR-CAL-017), через браузер: нова філія одразу
 * має налаштування (пн–пт, №84); на вкладці «Робочі дні» останній обраний день не знімається — без
 * жодного робочого дня зберегти не можна (№83). Філія — передумова через API (вкладка її не
 * створює), прибирається в `afterAll`.
 */

const uid = Date.now().toString().slice(-6);
const BRANCH = `000 E2E Робочі дні ${uid}`;
const state: { token?: string; branchId?: string } = {};

test.describe('Робочі дні філії — хоча б один день (BR-CAL-017)', () => {
  test.afterAll(async ({ request }) => {
    if (!state.token || !state.branchId) return;
    const res = await apiRequest(request, state.token, 'DELETE', `/branches/${state.branchId}`);
    expect.soft([200, 204, 404], 'DELETE філії').toContain(res.status);
  });

  test('останній день не знімається; збережено лише п’ятницю', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/settings?tab=workdays');
    await expect(page.getByText('Робочі дні').first()).toBeVisible({ timeout: 30_000 });
    state.token = await getToken(page);
    const created = await apiCall<{ id: string }>(page, state.token, 'POST', '/branches', {
      name: BRANCH,
      address: '000 E2E адреса',
    });
    expect(created.status).toBe(201);
    state.branchId = created.body.id;
    // №84: налаштування створено разом із філією — пн–пт.
    const initial = await apiCall<{ workDays: number[] }>(
      page,
      state.token,
      'GET',
      `/settings/branch/${state.branchId}`,
    );
    expect(initial.status).toBe(200);
    expect(initial.body.workDays).toEqual([1, 2, 3, 4, 5]);

    await page.reload();
    await page.getByLabel('Філія').selectOption({ label: BRANCH });
    const day = (name: string) => page.getByRole('button', { name, exact: true });
    await expect(day('Пн')).toHaveAttribute('aria-pressed', 'true', { timeout: 15_000 });
    for (const name of ['Пн', 'Вт', 'Ср', 'Чт']) await day(name).click();
    await expect(day('Пт')).toHaveAttribute('aria-pressed', 'true');
    await expect(day('Пт')).toHaveAttribute('aria-disabled', 'true');
    // `aria-disabled` — Playwright без `force` чекав би, доки кнопка «увімкнеться».
    await day('Пт').click({ force: true });
    await expect(day('Пт')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Має лишитися хоча б один робочий день')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('workdays_e2e_last_day.png') });

    await page.getByRole('button', { name: 'Зберегти', exact: true }).click();
    await expect
      .poll(
        async () =>
          (
            await apiCall<{ workDays: number[] }>(
              page,
              state.token!,
              'GET',
              `/settings/branch/${state.branchId}`,
            )
          ).body.workDays,
      )
      .toEqual([5]);
  });
});
