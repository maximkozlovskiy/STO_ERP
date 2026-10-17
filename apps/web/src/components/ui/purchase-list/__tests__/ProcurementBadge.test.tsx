// Стан товару наряду в закупівлі: «у списку», «замовлено (статус)», «прибуло N, зарезервовано M»,
// «нестача N»; нічого немає й нестачі немає — бейджа немає.

import { render, screen } from '@testing-library/react';
import { it, expect } from 'vitest';
import { ProcurementBadge } from '../ProcurementBadge';
import type { PurchaseListItem } from '@/hooks/api/usePurchaseLists';

const item = (over: Partial<PurchaseListItem>): PurchaseListItem =>
  ({
    id: 'i',
    status: 'OPEN',
    listNumber: 'СК-1',
    purchaseOrderNumber: null,
    purchaseOrderStatus: null,
    receivedQty: 0,
    reservedQty: 0,
    ...over,
  }) as PurchaseListItem;

it('усі стани одним рядком чипів', () => {
  render(
    <ProcurementBadge
      items={[
        item({ id: 'a', status: 'OPEN', listNumber: 'СК-1' }),
        item({
          id: 'b',
          status: 'ORDERED',
          purchaseOrderNumber: 'ЗП-2',
          purchaseOrderStatus: 'PARTIAL',
          receivedQty: 1,
          reservedQty: 1,
        }),
      ]}
      shortage={2}
      unit="шт"
    />,
  );
  const badge = screen.getByTestId('procurement-badge');
  expect(badge).toHaveTextContent('у списку СК-1');
  expect(badge).toHaveTextContent('замовлено ЗП-2 (Частково)');
  expect(badge).toHaveTextContent('прибуло 1 шт, зарезервовано 1 шт');
  expect(badge).toHaveTextContent('нестача 2 шт');
});

it('отримано повністю (RECEIVED) — лише «прибуло, зарезервовано»', () => {
  render(
    <ProcurementBadge
      items={[item({ status: 'RECEIVED', receivedQty: 1, reservedQty: 1 })]}
      shortage={0}
    />,
  );
  expect(screen.getByTestId('procurement-badge')).toHaveTextContent('прибуло 1, зарезервовано 1');
});

it('немає позицій і нестачі — бейджа немає', () => {
  const { container } = render(<ProcurementBadge items={[]} shortage={0} />);
  expect(container).toBeEmptyDOMElement();
});
