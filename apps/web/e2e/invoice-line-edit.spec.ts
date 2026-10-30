import { test, expect } from '@playwright/test';
import { apiCall, apiRequest, getToken } from './api-helpers';

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

/**
 * Рахунок — рядок чернетки правиться на місці (BR-INV-024, docs/objects/invoice.md), через браузер:
 * рахунок із рядком створюється в інтерфейсі, у картці чернетки кількість рядка 1 → 3, «Зберегти
 * зміни» — рядок той самий (id), сума рахунку перерахована сервером; повторне відкриття картки
 * показує нову кількість. Клієнт — передумова через API; рахунок і клієнта прибираємо.
 */

const uid = Date.now().toString().slice(-6);
const CLIENT = `000 E2E Рахунок рядок ${uid}`;
const LINE = `000 E2E позиція ${uid}`;

interface InvoiceDto {
  id: string;
  number: string;
  status: string;
  amount: number;
  lines: Array<{ id: string; description: string; quantity: number; priceWithVat: number }>;
}

const state: { token?: string; cpId?: string; invoiceId?: string } = {};

test.describe('Рахунок — кількість рядка чернетки на місці (BR-INV-024)', () => {
  test.afterAll(async ({ request }) => {
    const token = state.token;
    if (!token) return;
    if (state.invoiceId) {
      const res = await apiRequest(request, token, 'DELETE', `/invoices/${state.invoiceId}`);
      expect.soft([200, 204, 404], 'DELETE рахунку').toContain(res.status);
    }
    if (state.cpId) {
      const res = await apiRequest(request, token, 'DELETE', `/counterparties/${state.cpId}`);
      expect.soft(res.status, 'DELETE клієнта').toBeLessThan(300);
    }
  });

  // guards: BR-INV-024
  test('новий рахунок із рядком → кількість 1 → 3 у картці → той самий рядок, сума оновилась', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await page.goto('/invoices');
    await expect(page.getByRole('button', { name: /^Рахунок$/ }).first()).toBeVisible({
      timeout: 30_000,
    });
    state.token = await getToken(page);
    const cp = await apiCall<{ id: string }>(page, state.token, 'POST', '/counterparties', {
      type: 'CLIENT',
      companyName: CLIENT,
    });
    expect(cp.status).toBe(201);
    state.cpId = cp.body.id;

    // ── Новий рахунок через інтерфейс ──────────────────────────────────────
    await page
      .getByRole('button', { name: /^Рахунок$/ })
      .first()
      .click();
    const modal = page.getByRole('dialog').filter({ hasText: 'Новий рахунок' });
    await expect(modal).toBeVisible({ timeout: 15_000 });
    await modal.getByRole('button', { name: 'Обрати' }).first().click();
    const picker = page
      .getByRole('dialog')
      .filter({ has: page.getByPlaceholder("Ім'я, телефон, компанія...") });
    await picker.getByPlaceholder("Ім'я, телефон, компанія...").fill(CLIENT);
    await picker
      .getByRole('button', { name: new RegExp(CLIENT) })
      .first()
      .click();
    await expect(picker).toBeHidden({ timeout: 10_000 });
    await modal.getByRole('button', { name: 'Додати', exact: true }).click();
    await modal.getByPlaceholder('Опис позиції…').fill(LINE);
    await modal.getByPlaceholder('0.00').fill('100');
    await modal.getByPlaceholder('Опис позиції…').press('Enter');
    await modal.getByRole('button', { name: 'Створити рахунок' }).click();
    await expect(modal).toBeHidden({ timeout: 20_000 });

    const list = await apiCall<{ items: Array<{ id: string }> }>(
      page,
      state.token,
      'GET',
      `/invoices?counterpartyId=${state.cpId}&limit=5`,
    );
    expect(list.body.items).toHaveLength(1);
    state.invoiceId = list.body.items[0]!.id;
    const before = await apiCall<InvoiceDto>(
      page,
      state.token,
      'GET',
      `/invoices/${state.invoiceId}`,
    );
    expect(before.body.status).toBe('DRAFT');
    expect(before.body.lines).toEqual([
      expect.objectContaining({ description: LINE, quantity: 1 }),
    ]);
    const lineId = before.body.lines[0]!.id;
    const unitWithVat = before.body.lines[0]!.priceWithVat;

    // ── Картка чернетки: кількість рядка 1 → 3 ─────────────────────────────
    await page.goto(`/invoices?open=${state.invoiceId}`);
    const card = page.getByRole('dialog').filter({ hasText: before.body.number });
    const qty = card.getByLabel(`Кількість: ${LINE}`);
    await expect(qty).toHaveValue('1', { timeout: 30_000 });
    await qty.fill('3');
    // Сума рядка в картці — ще до збереження (прев'ю: сума з ПДВ × 3).
    const expected = (unitWithVat * 3).toFixed(2).replace('.', ',');
    await expect
      .poll(async () =>
        ((await card.getByTestId('invoice-line-sum').first().textContent()) ?? '').replace(
          /\s/g,
          '',
        ),
      )
      .toBe(expected);
    // «Разом» картки — теж нова сума (раніше мемо за `watch('lines')` лишало стару).
    await expect
      .poll(async () =>
        (
          (await card.getByText('Разом:').locator('xpath=ancestor::tr').textContent()) ?? ''
        ).replace(/\s/g, ''),
      )
      .toContain(expected);
    await card.screenshot({ path: test.info().outputPath('inv_e2e_line_edit.png') });
    await card.getByRole('button', { name: 'Зберегти зміни' }).click();
    await expect(card).toBeHidden({ timeout: 20_000 });

    const after = await apiCall<InvoiceDto>(
      page,
      state.token,
      'GET',
      `/invoices/${state.invoiceId}`,
    );
    expect(after.body.lines).toEqual([
      expect.objectContaining({ id: lineId, description: LINE, quantity: 3 }),
    ]);
    expect(after.body.amount).toBeCloseTo(unitWithVat * 3, 2);

    // Повторне відкриття — нова кількість.
    await page.goto(`/invoices?open=${state.invoiceId}`);
    await expect(
      page
        .getByRole('dialog')
        .filter({ hasText: before.body.number })
        .getByLabel(`Кількість: ${LINE}`),
    ).toHaveValue('3', { timeout: 30_000 });
  });
});
