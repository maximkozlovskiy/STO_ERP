// Regression-guard для вкладки «Рухи» складу (StockMovementsTab).
//
// Bug #738: колір/знак рядка руху фарбувався за ТИПОМ (INCOMING/OUTGOING Set-и), а не за
// знаком записаної кількості. Знак розходився з набором: RESERVATION зберігається ДОДАТНІМ
// (createMovement вимагає qty>0), але тип був у OUTGOING → додатнє число фарбувалось червоним
// (виглядало як витрата); RESERVATION_RELEASE (від'ємне) і TRANSFER не класифікувались зовсім
// → від'ємне число лишалось нейтральним. Фікс: колір СТРОГО за знаком `m.quantity`
// (>0 → text-success, <0 → text-destructive, =0 → нейтральний), самоузгоджено з displayed-числом.
//
// Mutation-verify: якщо повернути type-based Set-и (RESERVATION у OUTGOING) — кейс
// «RESERVATION (+5) зелений» впаде (стане text-destructive). Кейс «RESERVATION_RELEASE (−5)
// червоний» впаде під старою логікою (був би нейтральний).

import { render, screen } from '@testing-library/react';
import { vi, it, expect, describe } from 'vitest';
import { StockMovementsTab } from '../StockMovementsTab';

vi.mock('@/lib/format', () => ({
  fmtMoney: (v: number) => String(v),
  fmtDateTime: (v: string) => v,
}));

vi.mock('@/hooks/api/useInfrastructure', () => ({
  useWarehouses: () => ({ data: [{ id: 'w1', name: 'Головний' }] }),
}));

const mkMovement = (over: Partial<Record<string, unknown>>) => ({
  id: 'm-' + String(over.type) + String(over.quantity),
  type: 'RECEIPT',
  quantity: 0,
  price: null,
  goodId: 'g1',
  goodName: 'Олива',
  goodSku: 'OIL-1',
  warehouseId: 'w1',
  warehouseName: 'Головний',
  documentType: null,
  documentId: null,
  notes: null,
  createdAt: '2026-09-10 10:00',
  ...over,
});

// Знакова конвенція backend createMovement:
//   RECEIPT/OPENING_BALANCE/RETURN/RESERVATION → qty > 0
//   WRITEOFF/RESERVATION_RELEASE → qty < 0
//   TRANSFER → парні (out<0, in>0)
const MOVEMENTS = [
  mkMovement({ type: 'RECEIPT', quantity: 10 }),
  mkMovement({ type: 'RETURN', quantity: 3 }),
  mkMovement({ type: 'RESERVATION', quantity: 5 }), // ДОДАТНЄ → має бути зелене
  mkMovement({ type: 'WRITEOFF', quantity: -4 }),
  mkMovement({ type: 'RESERVATION_RELEASE', quantity: -5 }), // ВІД'ЄМНЕ → має бути червоне
  mkMovement({ type: 'TRANSFER', quantity: -2 }), // out-нога → червона
  mkMovement({ type: 'TRANSFER', quantity: 2 }), // in-нога → зелена
];

vi.mock('@/hooks/api/useInventory', () => ({
  useStockMovements: () => ({
    data: { items: MOVEMENTS, total: MOVEMENTS.length, page: 1, limit: 50 },
    isLoading: false,
    isFetching: false,
  }),
}));

// Повертає className комірки «Кількість» для рядка з заданим текстом кількості.
function qtyCellClass(qtyText: string): string {
  const cell = screen.getByText(qtyText);
  return cell.className;
}

describe('StockMovementsTab — колір/знак за quantity (Bug #738)', () => {
  it('додатні рухи (RECEIPT/RETURN/RESERVATION/TRANSFER-in) — text-success', () => {
    render(<StockMovementsTab />);
    // Кожне додатне число зафарбоване зеленим, не червоним.
    for (const q of ['10', '3', '5', '2']) {
      const cls = qtyCellClass(q);
      expect(cls).toContain('text-success');
      expect(cls).not.toContain('text-destructive');
    }
  });

  it("від'ємні рухи (WRITEOFF/RESERVATION_RELEASE/TRANSFER-out) — text-destructive", () => {
    render(<StockMovementsTab />);
    for (const q of ['-4', '-5', '-2']) {
      const cls = qtyCellClass(q);
      expect(cls).toContain('text-destructive');
      expect(cls).not.toContain('text-success');
    }
  });

  it('RETURN показує людський лейбл, не сирий enum', () => {
    render(<StockMovementsTab />);
    // «Повернення» присутнє двічі: у <option> фільтра типів + як Badge у рядку RETURN.
    // Головне — сирий 'RETURN' НЕ рендериться (лейбл є, не enum-код).
    expect(screen.getAllByText('Повернення').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('RETURN')).not.toBeInTheDocument();
  });
});
