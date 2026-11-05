// `<LinkedDocRef>` — номер пов'язаного документа: посилання для ролі з доступом (`nav.canOpen`),
// звичайний текст без нього (техборг §15 п. 4; Bugs #900, #914 — номер вів на 403).
//
// Mutation-verify: прибрати перевірку `nav.canOpen(kind)` → падає «без доступу — текст»;
// `OPEN.purchaseOrder` веде в `toWorkOrder` → падає «кожен вид — свій перехід».

import { render, screen, fireEvent } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { LinkedDocKind } from '@/lib/nav';

const nav = vi.hoisted(() => ({
  allowed: new Set<string>(),
  toWorkOrder: vi.fn(),
  toCounterparty: vi.fn(),
  toInvoice: vi.fn(),
  toPurchaseOrder: vi.fn(),
  toStockDocument: vi.fn(),
  toSupplierReturn: vi.fn(),
  toPurchaseList: vi.fn(),
  toCalendarDay: vi.fn(),
  toWarranty: vi.fn(),
  canOpen: (kind: string) => nav.allowed.has(kind),
}));
vi.mock('@/lib/linked-nav', () => ({ useLinkedNav: () => nav }));

import { LinkedDocRef } from '../LinkedDocRef';

const METHOD: Record<LinkedDocKind, keyof typeof nav> = {
  workOrder: 'toWorkOrder',
  counterparty: 'toCounterparty',
  invoice: 'toInvoice',
  purchaseOrder: 'toPurchaseOrder',
  stockDocument: 'toStockDocument',
  supplierReturn: 'toSupplierReturn',
  purchaseList: 'toPurchaseList',
  calendarDay: 'toCalendarDay',
  warranty: 'toWarranty',
};

describe('LinkedDocRef', () => {
  beforeEach(() => {
    nav.allowed = new Set();
    for (const m of Object.values(METHOD)) (nav[m] as ReturnType<typeof vi.fn>).mockReset();
  });

  it('без доступу — текст, не кнопка', () => {
    render(<LinkedDocRef kind="workOrder" id="wo-1" label="НРД-1" textClassName="plain" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('НРД-1')).toHaveClass('plain');
  });

  it.each(Object.entries(METHOD) as Array<[LinkedDocKind, keyof typeof nav]>)(
    'кожен вид — свій перехід: %s → %s',
    (kind, method) => {
      nav.allowed = new Set([kind]);
      render(<LinkedDocRef kind={kind} id="doc-1" label="№1" />);
      fireEvent.click(screen.getByRole('button', { name: '№1' }));
      expect(nav[method]).toHaveBeenCalledWith('doc-1');
      const others = Object.values(METHOD).filter(m => m !== method);
      for (const m of others) expect(nav[m]).not.toHaveBeenCalled();
    },
  );

  it('типовий вигляд посилання; aria-label і title — з пропів', () => {
    nav.allowed = new Set(['invoice']);
    render(
      <LinkedDocRef kind="invoice" id="i1" label="РФ-1" title="t" aria-label="Відкрити РФ-1" />,
    );
    const btn = screen.getByRole('button', { name: 'Відкрити РФ-1' });
    expect(btn).toHaveClass('text-primary', 'hover:underline');
    expect(btn).toHaveAttribute('title', 't');
    expect(btn).toHaveAttribute('type', 'button');
  });

  it('stopPropagation — клік не доходить до рядка; без нього — доходить', () => {
    nav.allowed = new Set(['workOrder']);
    const onRow = vi.fn();
    const { rerender } = render(
      <div role="presentation" onClick={onRow}>
        <LinkedDocRef kind="workOrder" id="wo-1" label="НРД-1" stopPropagation />
      </div>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onRow).not.toHaveBeenCalled();
    rerender(
      <div role="presentation" onClick={onRow}>
        <LinkedDocRef kind="workOrder" id="wo-1" label="НРД-1" />
      </div>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onRow).toHaveBeenCalledTimes(1);
  });
});
