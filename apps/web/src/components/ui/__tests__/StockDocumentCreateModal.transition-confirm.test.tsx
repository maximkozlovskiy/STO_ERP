// Проведення складського документа незворотне (рухи складу), скасування — теж. Раніше питало
// лише окреме вікно перегляду на сторінці списку; його прибрано (олівець = «Відкрити документ»,
// рішення власника 2026-10-13), тож запит підтвердження переїхав у саму картку.
//
// Що ловить (мутацію не проганяв): прибрати `if (!(await confirm(…))) return;` з doTransition →
// падають кейси «відмова» (запит іде без підтвердження).

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';

import { StockDocumentCreateModal } from '../StockDocumentCreateModal';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));
vi.mock('@/components/ui/xlsx-import-button', () => ({ XlsxImportButton: () => null }));
vi.mock('@/components/ui/ExcelImportWizard', () => ({ ExcelImportWizard: () => null }));

const DOC = 'sd-1';
const TRANSITION = `/stock-documents/${DOC}/transition`;

const transitionCalls = () =>
  apiFetchMock.mock.calls.filter(([p]) => p === TRANSITION).map(([, init]) => init as RequestInit);

async function openCard(onSaved = vi.fn()) {
  render(
    <StockDocumentCreateModal open stockDocumentId={DOC} onClose={vi.fn()} onSaved={onSaved} />,
  );
  await screen.findByText('Фільтр');
  return onSaved;
}

/** Діалог підтвердження — той, у якому стоїть питання про документ. */
const confirmDialog = () =>
  screen.getAllByRole('dialog').find(d => /Бажаєте/.test(d.textContent ?? ''));
const openConfirmDialog = async () => {
  await waitFor(() => expect(confirmDialog()).toBeTruthy());
  return confirmDialog()!;
};

describe('StockDocumentCreateModal — перехід статусу питає підтвердження', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/branches') return Promise.resolve([{ id: 'b1', name: 'Філія №1' }]);
      if (path === '/warehouses') {
        return Promise.resolve([{ id: 'w1', name: 'Склад №1', deletedAt: null }]);
      }
      if (path === `/stock-documents/${DOC}?withDeleted=true`) {
        return Promise.resolve({
          id: DOC,
          number: 'ПРХ-000001',
          status: 'DRAFT',
          type: 'RECEIPT',
          branchId: 'b1',
          warehouseId: 'w1',
          documentDate: '2026-10-13',
          deletedAt: null,
          lines: [{ id: 'l1', goodId: 'g1', goodName: 'Фільтр', quantity: 1, price: 10 }],
        });
      }
      return Promise.resolve({ items: [] });
    });
  });

  it('«Підтвердити»: спершу питання з номером документа; згода → POST transition CONFIRMED', async () => {
    const user = userEvent.setup();
    const onSaved = await openCard();

    await user.click(screen.getByRole('button', { name: 'Підтвердити' }));

    const dialog = await openConfirmDialog();
    expect(dialog).toHaveTextContent('Бажаєте підтвердити документ ПРХ-000001?');
    // Доки не відповіли — запиту немає.
    expect(transitionCalls()).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: 'Так' }));

    await waitFor(() => expect(transitionCalls()).toHaveLength(1));
    expect(JSON.parse(transitionCalls()[0].body as string)).toEqual({ status: 'CONFIRMED' });
    expect(transitionCalls()[0].method).toBe('POST');
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it('«Підтвердити»: відмова → запиту немає, документ лишається чернеткою', async () => {
    const user = userEvent.setup();
    const onSaved = await openCard();

    await user.click(screen.getByRole('button', { name: 'Підтвердити' }));
    const dialog = await openConfirmDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Скасувати' }));

    await waitFor(() => expect(confirmDialog()).toBeUndefined());
    expect(transitionCalls()).toHaveLength(0);
    expect(onSaved).not.toHaveBeenCalled();
    // Картка і далі редагована чернетка.
    expect(screen.getByRole('button', { name: 'Зберегти зміни' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Підтвердити' })).toBeInTheDocument();
  });

  it('«Скасувати» документ: питання «скасувати»; відмова → запиту немає; згода → CANCELLED', async () => {
    const user = userEvent.setup();
    await openCard();
    // Доки діалогу немає, «Скасувати» на екрані одна — перехід статусу в підвалі картки.
    const cancelDoc = () => screen.getByRole('button', { name: 'Скасувати' });

    await user.click(cancelDoc());
    let dialog = await openConfirmDialog();
    expect(dialog).toHaveTextContent('Бажаєте скасувати документ ПРХ-000001?');
    await user.click(within(dialog).getByRole('button', { name: 'Скасувати' }));
    await waitFor(() => expect(confirmDialog()).toBeUndefined());
    expect(transitionCalls()).toHaveLength(0);

    await user.click(cancelDoc());
    dialog = await openConfirmDialog();
    await user.click(within(dialog).getByRole('button', { name: 'Так' }));

    await waitFor(() => expect(transitionCalls()).toHaveLength(1));
    expect(JSON.parse(transitionCalls()[0].body as string)).toEqual({ status: 'CANCELLED' });
  });
});
