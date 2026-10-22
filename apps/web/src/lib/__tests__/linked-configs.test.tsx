import { describe, it, expect, vi } from 'vitest';
import { Receipt, ClipboardList, ShoppingCart, User, Warehouse } from 'lucide-react';
import {
  workOrderLinkedConfig,
  invoiceLinkedConfig,
  purchaseOrderLinkedConfig,
  stockDocumentLinkedConfig,
  supplierReturnLinkedConfig,
  counterpartyLinkedConfig,
} from '../linked-configs';
import type { LinkedNav } from '../linked-nav';

// Мок-навігація: кожен метод — spy, щоб перевірити куди веде navigate().
function makeNav(): LinkedNav & Record<string, ReturnType<typeof vi.fn>> {
  return {
    toWorkOrder: vi.fn(),
    toCounterparty: vi.fn(),
    toInvoice: vi.fn(),
    toPurchaseOrder: vi.fn(),
    toStockDocument: vi.fn(),
    toSupplierReturn: vi.fn(),
    toPurchaseList: vi.fn(),
    toCalendarDay: vi.fn(),
    toWarranty: vi.fn(),
  } as LinkedNav & Record<string, ReturnType<typeof vi.fn>>;
}

// Хелпер: знайти секцію за key.
function section(config: ReturnType<typeof workOrderLinkedConfig>, key: string) {
  const s = config.sections.find(x => x.key === key);
  if (!s) throw new Error(`section "${key}" not found; keys=${config.sections.map(x => x.key)}`);
  return s;
}

const INV_ROW = {
  id: 'inv1',
  number: '001',
  status: 'PAID',
  amount: '1250.00',
  documentDate: '2026-01-15',
};
const PO_ROW = { id: 'po1', number: 'PO-1', status: 'CONFIRMED', totalAmount: '500.00' };
const WH_ROW = { id: 'wh1', name: 'Головний склад' };

describe('linked-configs — behaviour parity of parametrized builders', () => {
  // Запит власника 2026-10-13: «не бачу кнопки переходу» на записі календаря.
  it('work-order → запис календаря має перехід: календар на дні запису', () => {
    const nav = makeNav();
    const s = section(workOrderLinkedConfig(nav), 'calendarSlots');
    const mapped = s.mapRow({
      id: 'slot1',
      startAt: '2026-06-10T16:00:00.000Z',
      endAt: '2026-06-10T17:00:00.000Z',
      status: 'BOOKED',
      lift: { name: 'Пост 1' },
      notes: null,
    } as never);
    expect(mapped.navigate).toBeTypeOf('function');
    mapped.navigate?.();
    expect(nav.toCalendarDay).toHaveBeenCalledWith('2026-06-10T16:00:00.000Z');
  });

  const WARRANTY_ROW = {
    id: 'w1',
    description: 'Гарантія',
    expiresAt: '2026-11-08T00:00:00.000Z',
    createdAt: '2026-10-09T00:00:00.000Z',
    claimedAt: null,
  };

  it('work-order → оплата лишається без переходу (власної сторінки немає)', () => {
    const payment = section(workOrderLinkedConfig(makeNav()), 'payments').mapRow({
      id: 'p1',
      amount: 100,
      method: 'CASH',
      createdAt: '2026-06-10T10:00:00.000Z',
    } as never);
    expect(payment.navigate).toBeUndefined();
  });

  // guards: BR-WAR-005
  it('work-order → гарантія веде на вкладку «Гарантії» з відкритою гарантією', () => {
    const nav = makeNav();
    const warranty = section(
      workOrderLinkedConfig(nav, { canOpenWarranties: true }),
      'warranties',
    ).mapRow(WARRANTY_ROW as never);
    expect(warranty.navigate).toBeTypeOf('function');
    warranty.navigate?.();
    expect(nav.toWarranty).toHaveBeenCalledWith('w1');
  });

  // guards: BR-WAR-005
  it('work-order → гарантія без переходу для ролі без вкладки «Гарантії» (механік)', () => {
    const warranty = section(workOrderLinkedConfig(makeNav()), 'warranties').mapRow(
      WARRANTY_ROW as never,
    );
    expect(warranty.navigate).toBeUndefined();
  });

  describe('invoiceSection: secondary — DATE у наряді, AMOUNT у картці контрагента', () => {
    it('work-order → invoices secondary = дата документа (fmtDate)', () => {
      const s = section(workOrderLinkedConfig(makeNav()), 'invoices');
      expect(s.title).toBe('Рахунки');
      expect(s.icon).toBe(Receipt);
      const mapped = s.mapRow(INV_ROW as never);
      // 15.01.2026 — формат дати, НЕ сума з ₴.
      expect(mapped.secondary).toBe('15.01.2026');
      expect(mapped.secondary).not.toContain('₴');
    });

    it('counterparty → invoices secondary = сума з ₴ (не дата)', () => {
      const s = section(counterpartyLinkedConfig(makeNav()), 'invoices');
      const mapped = s.mapRow(INV_ROW as never);
      expect(mapped.secondary).toContain('₴');
      expect(mapped.secondary).not.toBe('15.01.2026');
    });

    it('navigate веде до toInvoice', () => {
      const nav = makeNav();
      const mapped = section(workOrderLinkedConfig(nav), 'invoices').mapRow(INV_ROW as never);
      mapped.navigate?.();
      expect(nav.toInvoice).toHaveBeenCalledWith('inv1');
    });
  });

  describe('warehouseSection: key/title розрізняє stock-document та supplier-return', () => {
    it('stock-document → key="warehouses" title="Склади"', () => {
      const config = stockDocumentLinkedConfig(makeNav());
      const s = section(config, 'warehouses');
      expect(s.title).toBe('Склади');
      expect(s.icon).toBe(Warehouse);
      // ключа "warehouse" (однина) тут бути НЕ повинно.
      expect(config.sections.some(x => x.key === 'warehouse')).toBe(false);
    });

    it('supplier-return → key="warehouse" title="Склад" (дефолти білдера)', () => {
      const config = supplierReturnLinkedConfig(makeNav());
      const s = section(config, 'warehouse');
      expect(s.title).toBe('Склад');
      // ключа "warehouses" (множина) тут бути НЕ повинно.
      expect(config.sections.some(x => x.key === 'warehouses')).toBe(false);
    });

    it('mapRow складу — read-only (без navigate)', () => {
      const s = section(supplierReturnLinkedConfig(makeNav()), 'warehouse');
      const mapped = s.mapRow(WH_ROW as never);
      expect(mapped.primary).toBe('Головний склад');
      expect(mapped.navigate).toBeUndefined();
    });
  });

  describe('purchaseOrderSourceSection: key/icon розрізняє single-FK та список', () => {
    it('supplier-return → дефолт key="purchaseOrder" icon=ClipboardList', () => {
      const s = section(supplierReturnLinkedConfig(makeNav()), 'purchaseOrder');
      expect(s.title).toBe('Замовлення постачальнику');
      expect(s.icon).toBe(ClipboardList);
    });

    it('stock-document → дефолт key="purchaseOrder" icon=ClipboardList', () => {
      const s = section(stockDocumentLinkedConfig(makeNav()), 'purchaseOrder');
      expect(s.icon).toBe(ClipboardList);
    });

    it('counterparty → key="purchaseOrders" icon=ShoppingCart (список)', () => {
      const config = counterpartyLinkedConfig(makeNav());
      const s = section(config, 'purchaseOrders');
      expect(s.icon).toBe(ShoppingCart);
      expect(s.icon).not.toBe(ClipboardList);
      // single-FK ключа тут бути НЕ повинно.
      expect(config.sections.some(x => x.key === 'purchaseOrder')).toBe(false);
    });

    it('navigate веде до toPurchaseOrder в обох випадках', () => {
      const nav1 = makeNav();
      section(supplierReturnLinkedConfig(nav1), 'purchaseOrder')
        .mapRow(PO_ROW as never)
        .navigate?.();
      expect(nav1.toPurchaseOrder).toHaveBeenCalledWith('po1');

      const nav2 = makeNav();
      section(counterpartyLinkedConfig(nav2), 'purchaseOrders')
        .mapRow(PO_ROW as never)
        .navigate?.();
      expect(nav2.toPurchaseOrder).toHaveBeenCalledWith('po1');
    });
  });

  describe('counterpartySection: спільний рядок, navigate до контрагента', () => {
    it('invoice-config містить секцію counterparty з icon=User', () => {
      const s = section(invoiceLinkedConfig(makeNav()), 'counterparty');
      expect(s.title).toBe('Контрагент');
      expect(s.icon).toBe(User);
    });
    it('purchase-order-config: counterparty navigate → toCounterparty', () => {
      const nav = makeNav();
      const mapped = section(purchaseOrderLinkedConfig(nav), 'counterparty').mapRow({
        id: 'cp1',
        firstName: 'Іван',
        lastName: 'Петренко',
        companyName: null,
        phone: '+380501112233',
      } as never);
      expect(mapped.secondary).toBe('+380501112233');
      mapped.navigate?.();
      expect(nav.toCounterparty).toHaveBeenCalledWith('cp1');
    });
  });

  // Сторінок оплат постачальникам немає: рядок оплати показує прев'ю, але нікуди не веде —
  // і в замовленні, і в картці контрагента. З `navigate` панель малювала б кнопку «Відкрити»
  // на адресу-перенаправлення.
  describe('оплати постачальнику — рядки без переходу', () => {
    const row = {
      id: 'sp1',
      number: 'ОПП-000007',
      amount: 1500,
      method: 'CASH',
      status: 'CONFIRMED',
      documentDate: '2026-10-14',
    };

    it.each([
      ['замовлення постачальнику', purchaseOrderLinkedConfig],
      ['картка контрагента', counterpartyLinkedConfig],
    ] as const)("%s: є прев'ю, немає navigate", (_name, factory) => {
      const nav = makeNav();
      const mapped = section(factory(nav), 'supplierPayments').mapRow(row);
      expect(mapped.navigate).toBeUndefined();
      expect(mapped.primary).toContain('ОПП-000007');
      expect(mapped.preview.title).toBe('Оплата ОПП-000007');
      expect(mapped.preview.rows.map(r => r.label)).toEqual(
        expect.arrayContaining(['Статус', 'Сума', 'Метод']),
      );
      for (const spy of Object.values(nav)) expect(spy).not.toHaveBeenCalled();
    });

    it('оплата клієнта в рахунку — теж рядок без переходу', () => {
      const mapped = section(invoiceLinkedConfig(makeNav()), 'payments').mapRow({
        id: 'p1',
        amount: 800,
        method: 'CASH',
        createdAt: '2026-10-14T09:00:00.000Z',
        notes: null,
      });
      expect(mapped.navigate).toBeUndefined();
    });

    const failedRow = {
      id: 'p9',
      amount: 800,
      method: 'CASH',
      createdAt: '2026-10-14T09:00:00.000Z',
      notes: null,
      fiscalStatus: 'FAILED',
    };

    it('оплата рахунку: позначка чека; FAILED + дозволена роль → дія «Повторити» на цей платіж', async () => {
      const retryFiscal = vi.fn().mockResolvedValue({});
      const mapped = section(invoiceLinkedConfig(makeNav(), { retryFiscal }), 'payments').mapRow(
        failedRow,
      );
      expect(mapped.badge?.label).toContain('Чек');
      expect(mapped.action?.label).toBe('Повторити');
      await mapped.action!.run();
      expect(retryFiscal).toHaveBeenCalledWith('p9');
    });

    it('без дозволеної ролі (retryFiscal не передано) або не FAILED — кнопки немає', () => {
      const noRole = section(invoiceLinkedConfig(makeNav()), 'payments').mapRow(failedRow);
      expect(noRole.action).toBeUndefined();
      expect(noRole.badge).toBeDefined();
      const done = section(
        invoiceLinkedConfig(makeNav(), { retryFiscal: vi.fn() }),
        'payments',
      ).mapRow({ ...failedRow, fiscalStatus: 'DONE' });
      expect(done.action).toBeUndefined();
      const none = section(
        invoiceLinkedConfig(makeNav(), { retryFiscal: vi.fn() }),
        'payments',
      ).mapRow({ ...failedRow, fiscalStatus: null });
      expect(none.badge).toBeUndefined();
    });
  });

  it.each([workOrderLinkedConfig, purchaseOrderLinkedConfig])(
    '%o → секція «Списки купівлі» веде у вкладку «Управління купівлями»',
    factory => {
      const nav = makeNav();
      const row = section(factory(nav), 'purchaseLists').mapRow({
        id: 'pl1',
        number: 'СК-2026-000001',
        status: 'OPEN',
        createdAt: '2026-10-17T08:00:00Z',
      });
      expect(row.primary).toContain('СК-2026-000001');
      row.navigate?.();
      expect(nav.toPurchaseList).toHaveBeenCalledWith('pl1');
    },
  );

  describe('fetchPath кожного конфіга — правильний endpoint', () => {
    it.each([
      [workOrderLinkedConfig, 'x', '/work-orders/x/linked-documents'],
      [invoiceLinkedConfig, 'x', '/invoices/x/linked-documents'],
      [purchaseOrderLinkedConfig, 'x', '/purchase-orders/x/linked-documents'],
      [stockDocumentLinkedConfig, 'x', '/stock-documents/x/linked-documents'],
      [supplierReturnLinkedConfig, 'x', '/supplier-returns/x/linked-documents'],
      [counterpartyLinkedConfig, 'x', '/counterparties/x/linked-documents'],
    ] as const)('%o', (factory, id, expected) => {
      expect(factory(makeNav()).fetchPath(id)).toBe(expected);
    });
  });
});
