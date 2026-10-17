// Нумерація списку купівлі (BR-PL-001): тип документа PURCHASE_LIST у «Налаштування → Нумерація»
// має людський підпис, а не сирий код (префікс «СК» змінюється тут).

import { render, screen } from '@testing-library/react';
import { vi, it, expect } from 'vitest';

vi.mock('@/lib/api-client', () => ({
  apiFetch: () =>
    Promise.resolve([
      {
        id: 'c1',
        documentType: 'PURCHASE_LIST',
        prefix: 'СК',
        includeDate: true,
        separator: '-',
        padding: 6,
        currentSeq: 3,
        resetPeriod: 'YEARLY',
      },
    ]),
}));

import NumbersTab from '../NumbersTab';

// guards: BR-PL-001
it('PURCHASE_LIST показано як «Список купівлі» з префіксом СК', async () => {
  render(<NumbersTab />);
  expect(await screen.findByText('Список купівлі')).toBeInTheDocument();
  expect(screen.queryByText('PURCHASE_LIST')).not.toBeInTheDocument();
  expect(screen.getByDisplayValue('СК')).toBeInTheDocument();
});
