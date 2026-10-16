import { test, expect, type Page } from '@playwright/test';
import { API } from './api-url';

// Стандарт (рішення власника 2026-10-14): картка документа, згорнута у вкладку, відновлюється
// кліком по вкладці — для наряду, рахунку, замовлення постачальнику і складського документа.
// Компонентний тест `RestoredDocumentModal.test.tsx` працює на заглушках карток; тут — справжні
// картки у справжній оболонці: вкладка з іншої сторінки відкриває САМЕ цей документ, повторне
// згортання лишає одну вкладку, фокус іде в картку (а не лишається на сторінці під нею),
// закриття прибирає вкладку.

test.use({ storageState: 'e2e/.auth/admin.json' });
test.describe.configure({ mode: 'serial' });

const TABS_KEY = 'sto_modal_tabs';

interface Created {
  id: string;
  number: string;
}

async function api<T>(page: Page, method: string, path: string, body?: unknown): Promise<T> {
  const res = await page.evaluate(
    async ({ url, method, body }) => {
      const token = sessionStorage.getItem('sto_access_token');
      // Content-Type лише з тілом: DELETE із заголовком JSON і без тіла сервер відхиляє (400).
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const r = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      return { ok: r.ok, status: r.status, text };
    },
    { url: `${API}${path}`, method, body },
  );
  expect(res.ok, `${method} ${path} → ${res.status}: ${res.text.slice(0, 300)}`).toBeTruthy();
  return (res.text ? JSON.parse(res.text) : null) as T;
}

interface Refs {
  clientId: string;
  supplierId: string;
  warehouseId: string;
  branchId: string;
  vehicleId: string;
}

async function loadRefs(page: Page): Promise<Refs> {
  const [clients, suppliers, warehouses, vehicles] = await Promise.all([
    api<{ items: { id: string }[] }>(page, 'GET', '/counterparties?types=CLIENT,BOTH&limit=1'),
    api<{ items: { id: string }[] }>(page, 'GET', '/counterparties?types=SUPPLIER,BOTH&limit=1'),
    api<{ id: string; branchId: string }[]>(page, 'GET', '/warehouses?limit=1'),
    api<{ items?: { id: string }[] } | { id: string }[]>(page, 'GET', '/vehicles?limit=1'),
  ]);
  const vehicleList = Array.isArray(vehicles) ? vehicles : (vehicles.items ?? []);
  const refs = {
    clientId: clients.items[0]?.id,
    supplierId: suppliers.items[0]?.id,
    warehouseId: warehouses[0]?.id,
    branchId: warehouses[0]?.branchId,
    vehicleId: vehicleList[0]?.id,
  };
  for (const [name, value] of Object.entries(refs)) {
    expect(value, `seed має містити ${name}`).toBeTruthy();
  }
  return refs as Refs;
}

interface CardCase {
  title: string;
  modalKey: string;
  idProp: string;
  /**
   * Сторінка агрегату (тут створюємо документ) та ІНША сторінка (тут клікаємо по вкладці).
   * Маршрути — літералами в `goto('…')`: за ними `scripts/affected-tests.py` вибирає цей спек,
   * коли змінюють картку відповідного агрегату.
   */
  openOwn: (page: Page) => Promise<unknown>;
  openOther: (page: Page) => Promise<unknown>;
  endpoint: string;
  payload: (refs: Refs) => Record<string, unknown>;
}

const CASES: CardCase[] = [
  {
    title: 'рахунок',
    modalKey: 'invoice',
    idProp: 'invoiceId',
    openOwn: page => page.goto('/invoices'),
    openOther: page => page.goto('/work-orders'),
    endpoint: '/invoices',
    payload: r => ({ counterpartyId: r.clientId, amount: 50 }),
  },
  {
    title: 'замовлення постачальнику',
    modalKey: 'purchase-order',
    idProp: 'purchaseOrderId',
    openOwn: page => page.goto('/purchase-orders'),
    openOther: page => page.goto('/invoices'),
    endpoint: '/purchase-orders',
    payload: r => ({ supplierId: r.supplierId, warehouseId: r.warehouseId }),
  },
  {
    title: 'складський документ',
    modalKey: 'stock-document',
    idProp: 'stockDocumentId',
    openOwn: page => page.goto('/stock-documents'),
    openOther: page => page.goto('/invoices'),
    endpoint: '/stock-documents',
    payload: r => ({
      type: 'WRITEOFF',
      warehouseId: r.warehouseId,
      branchId: r.branchId,
      lines: [],
    }),
  },
  {
    title: 'наряд',
    modalKey: 'work-order',
    idProp: 'workOrderId',
    openOwn: page => page.goto('/work-orders'),
    openOther: page => page.goto('/invoices'),
    endpoint: '/work-orders',
    payload: r => ({ branchId: r.branchId, vehicleId: r.vehicleId, counterpartyId: r.clientId }),
  },
];

const tabChip = (page: Page, label: string) => page.locator(`div.h-9 > div[title="${label}"]`);

test.describe('Картка документа, згорнута у вкладку', () => {
  for (const c of CASES) {
    test(`${c.title}: вкладка з іншої сторінки відкриває цей документ; згортання й закриття`, async ({
      page,
    }) => {
      await c.openOwn(page);
      await expect(page.locator('h1').first()).toBeVisible({ timeout: 20_000 });
      const refs = await loadRefs(page);
      const doc = await api<Created>(page, 'POST', c.endpoint, c.payload(refs));

      try {
        // Вкладка лежить у localStorage — як після «Згорнути у вкладку» в попередній сесії.
        await page.evaluate(({ key, tab }) => localStorage.setItem(key, JSON.stringify([tab])), {
          key: TABS_KEY,
          tab: {
            kind: 'modal',
            id: `e2e-${c.modalKey}`,
            label: doc.number,
            modalKey: c.modalKey,
            restoreProps: { [c.idProp]: doc.id },
          },
        });
        await c.openOther(page);
        await expect(page.locator('h1').first()).toBeVisible({ timeout: 20_000 });

        const chip = tabChip(page, doc.number);
        await expect(chip).toBeVisible({ timeout: 10_000 });
        await chip.click();

        // Відкрилась картка САМЕ цього документа: номер у шапці, і вона одна.
        const dialog = page.locator('[role="dialog"]');
        await expect(dialog).toHaveCount(1, { timeout: 15_000 });
        await expect(dialog.getByText(doc.number).first()).toBeVisible({ timeout: 15_000 });

        // Фокус у картці: без цього Tab ходив по сторінці під відкритою карткою.
        await expect
          .poll(() => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')))
          .toBe(true);

        // Повторне згортання: картка зникла, вкладка лишилась одна.
        await dialog.getByTitle('Згорнути у вкладку').click();
        await expect(dialog).toHaveCount(0);
        await expect(tabChip(page, doc.number)).toHaveCount(1);
        const stored = await page.evaluate(
          key => (JSON.parse(localStorage.getItem(key) ?? '[]') as unknown[]).length,
          TABS_KEY,
        );
        expect(stored, 'у localStorage одна вкладка, не дві').toBe(1);

        // Відновлюється ще раз, закриття прибирає вкладку.
        await chip.click();
        await expect(dialog).toHaveCount(1, { timeout: 15_000 });
        await expect(dialog.getByText(doc.number).first()).toBeVisible({ timeout: 15_000 });
        await dialog.getByTitle('Закрити').first().click();
        await expect(dialog).toHaveCount(0);
        await expect(tabChip(page, doc.number)).toHaveCount(0);
      } finally {
        await page.evaluate(key => localStorage.removeItem(key), TABS_KEY);
        await api(page, 'DELETE', `${c.endpoint}/${doc.id}`);
      }
    });
  }
});
