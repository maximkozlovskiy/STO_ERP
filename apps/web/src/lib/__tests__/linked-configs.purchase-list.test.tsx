// Вкладка «Документи» картки списку купівлі й вікно лічильників таблиці (BR-PL-020):
// `purchaseListLinkedConfig` читає `GET /purchase-lists/:id/linked-documents` і показує наряди,
// замовлення постачальнику (сума у валюті замовлення) та обʼєднані в список списки.
//
// Mutation-verify: ключ `workOrder` замість `workOrders` → «ключі секцій» падає (секція порожня
// завжди); `₴` замість символу валюти замовлення → «сума у валюті» падає; перехід без
// `canOpen` → «приймальня» падає.

import { describe, it, expect, vi } from 'vitest';
import { ClipboardList, ListChecks, ShoppingCart } from 'lucide-react';
import { purchaseListLinkedConfig } from '../linked-configs';
import type { LinkedNav } from '../linked-nav';

function makeNav() {
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
  } satisfies LinkedNav;
}

const sectionOf = (config: ReturnType<typeof purchaseListLinkedConfig>, key: string) => {
  const s = config.sections.find(x => x.key === key);
  if (!s) throw new Error(`section ${key} not found`);
  return s;
};

describe('purchaseListLinkedConfig (BR-PL-020)', () => {
  // guards: BR-PL-020
  it('шлях і ключі секцій — як у відповіді linked-documents', () => {
    const config = purchaseListLinkedConfig(makeNav());
    expect(config.fetchPath('list-1')).toBe('/purchase-lists/list-1/linked-documents');
    expect(config.sections.map(s => [s.key, s.icon])).toEqual([
      ['workOrders', ClipboardList],
      ['purchaseOrders', ShoppingCart],
      ['purchaseLists', ListChecks],
    ]);
    expect(config.sections.map(s => s.title)).toEqual([
      'Наряди',
      'Замовлення постачальнику',
      'Обʼєднані списки',
    ]);
  });

  // guards: BR-PL-020
  it('замовлення — сума у валюті замовлення; без символу — гривня', () => {
    const s = sectionOf(purchaseListLinkedConfig(makeNav()), 'purchaseOrders');
    const usd = s.mapRow({
      id: 'po-1',
      number: 'ЗП-1',
      status: 'ORDERED',
      totalAmount: 1250.5,
      currencySymbol: '$',
    } as never);
    expect(usd.secondary).toMatch(/^1\s250,50 \$$/);
    const uah = s.mapRow({
      id: 'po-2',
      number: 'ЗП-2',
      status: 'DRAFT',
      totalAmount: 10,
      currencySymbol: null,
    } as never);
    expect(uah.secondary).toBe('10,00 ₴');
  });

  it('переходи: наряд → сторінка наряду, замовлення → картка замовлення, список → картка списку', () => {
    const nav = makeNav();
    const config = purchaseListLinkedConfig(nav);
    sectionOf(config, 'workOrders')
      .mapRow({ id: 'wo-1', number: 'НРД-1', status: 'APPROVED' } as never)
      .navigate?.();
    sectionOf(config, 'purchaseOrders')
      .mapRow({ id: 'po-1', number: 'ЗП-1', status: 'DRAFT', totalAmount: 1 } as never)
      .navigate?.();
    sectionOf(config, 'purchaseLists')
      .mapRow({
        id: 'pl-2',
        number: 'СК-2',
        status: 'CLOSED',
        createdAt: '2026-10-30T10:00:00.000Z',
      } as never)
      .navigate?.();
    expect(nav.toWorkOrder).toHaveBeenCalledWith('wo-1');
    expect(nav.toPurchaseOrder).toHaveBeenCalledWith('po-1');
    expect(nav.toPurchaseList).toHaveBeenCalledWith('pl-2');
  });

  // guards: BR-PL-020
  it('приймальня: замовлення без переходу (картка замовлення їй закрита) і без суми (§2.1)', () => {
    const nav = makeNav();
    const s = sectionOf(
      purchaseListLinkedConfig(nav, { canOpenPurchaseOrders: false }),
      'purchaseOrders',
    );
    const row = s.mapRow({
      id: 'po-1',
      number: 'ЗП-1',
      status: 'ORDERED',
      totalAmount: null,
      currencySymbol: '₴',
    } as never);
    expect(row.navigate).toBeUndefined();
    expect(row.secondary).toBeUndefined();
    expect(row.preview.rows.map(r => r.label)).toEqual(['Статус']);
  });
});
