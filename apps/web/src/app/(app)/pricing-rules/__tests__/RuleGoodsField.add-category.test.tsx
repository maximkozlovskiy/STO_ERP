// «Додати всю категорію» у полі товарів правила (BR-GOOD-009, блок 4 №21).
//
// Що стережуть ці тести:
//  - товари категорії беруться з сервера (`/pricing-rules/category-goods`, усі з нащадками), а не
//    з показаної сторінки пікера; у список додаються лише нові, тост — «Додано N (уже були M)»;
//  - відмова сервера (категорія понад ліміт списку) — текст сервера тостом і під списком.
//
// Пікер замінено заглушкою з однією кнопкою: його власна поведінка — GoodPickerModal.*.test.tsx.
//
// Mutation-verify (2026-11-14): додавати всі `res.items` без відсіву наявних → кейс «лише нові»
// падає (дубль g1); тост без `already` → той самий кейс падає на тексті.

import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type { RuleGood } from '../types';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...a: unknown[]) => apiFetchMock(...a),
  apiMultipartFetch: vi.fn(),
}));
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('@/lib/toast', () => ({
  toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
}));
vi.mock('@/components/ui/GoodPickerModal', () => ({
  GoodPickerModal: ({
    open,
    onAddCategory,
  }: {
    open: boolean;
    onAddCategory?: (id: string) => Promise<void> | void;
  }) =>
    open ? (
      <button type="button" onClick={() => void onAddCategory?.('cat-1')}>
        stub-add-category
      </button>
    ) : null,
}));

import RuleGoodsField from '../RuleGoodsField';

const ref = (id: string): RuleGood => ({
  id,
  internalCode: null,
  name: `Товар ${id}`,
  sku: null,
  brandName: null,
});

let latest: RuleGood[] = [];
function Harness({ initial }: { initial: RuleGood[] }) {
  const [goods, setGoods] = useState(initial);
  latest = goods;
  return (
    <RuleGoodsField
      goods={goods}
      onChange={setGoods}
      load={{ status: 'ready' }}
      onRetry={vi.fn()}
    />
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
  latest = [];
});

// guards: BR-GOOD-009
describe('«Додати всю категорію» (№21)', () => {
  it('додає лише нові товари категорії з сервера; тост «Додано N (уже були M)»', async () => {
    apiFetchMock.mockResolvedValue({ items: [ref('g1'), ref('g2'), ref('g3')], total: 3 });
    const user = userEvent.setup();
    render(<Harness initial={[ref('g1')]} />);

    await user.click(screen.getByRole('button', { name: 'Додати товар' }));
    await user.click(screen.getByRole('button', { name: 'stub-add-category' }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Додано 2 (уже були 1)'));
    expect(apiFetchMock).toHaveBeenCalledWith('/pricing-rules/category-goods?goodCategoryId=cat-1');
    expect(latest.map(g => g.id)).toEqual(['g1', 'g2', 'g3']);
    expect(screen.getByRole('status')).toHaveTextContent('Додано 2 (уже були 1)');
  });

  it('порожня категорія — так і сказано, список той самий', async () => {
    apiFetchMock.mockResolvedValue({ items: [], total: 0 });
    const user = userEvent.setup();
    render(<Harness initial={[ref('g1')]} />);

    await user.click(screen.getByRole('button', { name: 'Додати товар' }));
    await user.click(screen.getByRole('button', { name: 'stub-add-category' }));

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith('У категорії немає товарів — список не змінився'),
    );
    expect(latest.map(g => g.id)).toEqual(['g1']);
  });

  it('відмова сервера (понад ліміт списку) — текст сервера тостом і під списком, список той самий', async () => {
    const msg = 'У категорії 5200 товарів, а список правила вміщує не більше 5000';
    apiFetchMock.mockRejectedValue(new Error(msg));
    const user = userEvent.setup();
    render(<Harness initial={[ref('g1')]} />);

    await user.click(screen.getByRole('button', { name: 'Додати товар' }));
    await user.click(screen.getByRole('button', { name: 'stub-add-category' }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(msg));
    expect(screen.getByRole('alert')).toHaveTextContent(msg);
    expect(latest.map(g => g.id)).toEqual(['g1']);
  });
});
