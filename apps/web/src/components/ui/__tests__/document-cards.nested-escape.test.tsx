/**
 * Escape над карткою документа закриває лише верхній шар (QA цикл 3, наживо 2026-10-21):
 * - Bug #931 — вікно вибору («Оберіть постачальника», «Оберіть замовлення») над карткою: Escape
 *   закривав картку з усім введеним, вікно вибору лишалось;
 * - Bug #932 — меню статусу й «Зберегти як» без власного Escape: закривалась картка;
 * - Bug #933 — підтвердження переходу («Провести») над карткою складського документа: Escape
 *   закривав і його, і картку.
 * Той самий механізм, що Bug #923 / #924 у картці наряду.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { StockDocumentCreateModal } from '../StockDocumentCreateModal';
import { SupplierPaymentCreateModal } from '../SupplierPaymentCreateModal';
import { stockDocStatusLabel } from '@/i18n/enumLabel';
import { renderWithQueryClient } from '../../../__tests__/query-utils';

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

async function pressEscape(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard('{Escape}');
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

const DOC = 'sd-1';

function mockStockApi(status = 'DRAFT') {
  apiFetchMock.mockImplementation((path: string) => {
    if (path === '/branches') return Promise.resolve([{ id: 'b1', name: 'Філія №1' }]);
    if (path === '/warehouses') {
      return Promise.resolve([{ id: 'w1', name: 'Склад №1', deletedAt: null }]);
    }
    if (path === `/stock-documents/${DOC}?withDeleted=true`) {
      return Promise.resolve({
        id: DOC,
        number: 'ПРХ-000001',
        status,
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
}

describe('StockDocumentCreateModal — шари над карткою й Escape (Bug #931, #932)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    mockStockApi();
  });

  it('Escape у вікні вибору замовлення закриває лише його', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<StockDocumentCreateModal open onClose={onClose} onSaved={vi.fn()} />);
    await user.click((await screen.findAllByRole('button', { name: 'Обрати' }))[0]!);
    await screen.findByRole('dialog', { name: /Оберіть замовлення/ });

    await pressEscape(user);

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /Оберіть замовлення/ })).toBeNull(),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: /складський документ/ })).toBeTruthy();
  });

  it('Escape у меню статусу й «Зберегти як» закриває лише меню', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <StockDocumentCreateModal open stockDocumentId={DOC} onClose={onClose} onSaved={vi.fn()} />,
    );
    await screen.findByText('Фільтр');

    await user.click(screen.getByRole('button', { name: /Зберегти як/ }));
    expect(screen.getByRole('button', { name: 'Excel (.xlsx)' })).toBeTruthy();
    await pressEscape(user);
    expect(screen.queryByRole('button', { name: 'Excel (.xlsx)' })).toBeNull();

    const menuItems = () =>
      screen.queryAllByRole('button').filter(b => b.className.includes('text-left'));
    await user.click(screen.getByRole('button', { name: 'Чернетка' }));
    await waitFor(() => expect(menuItems().length).toBeGreaterThan(0));
    await pressEscape(user);
    expect(menuItems()).toHaveLength(0);

    expect(onClose).not.toHaveBeenCalled();
  });

  /** Діалог підтвердження переходу — той, у якому питання про документ. */
  const confirmDialog = () =>
    screen.queryAllByRole('dialog').find(d => /Бажаєте/.test(d.textContent ?? ''));
  const statusMenuItems = () =>
    screen.queryAllByRole('button').filter(b => b.className.includes('text-left'));
  const transitionCalls = () =>
    apiFetchMock.mock.calls.filter(([p]) => p === `/stock-documents/${DOC}/transition`);

  async function openDoc(status = 'DRAFT') {
    mockStockApi(status);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <StockDocumentCreateModal open stockDocumentId={DOC} onClose={onClose} onSaved={vi.fn()} />,
    );
    await screen.findByText('Фільтр');
    return { onClose, user };
  }

  // Bug #933: картка перевіряла лише прапорець вікон вибору, а не підтвердження — Escape у «Бажаєте
  // підтвердити документ?» закривав і діалог, і картку (зі змінами — питання «Є незбережені зміни»).
  it('Escape у підтвердженні проведення закриває лише його — картка лишається', async () => {
    const { onClose, user } = await openDoc();
    await user.click(screen.getByRole('button', { name: 'Чернетка' }));
    await waitFor(() => expect(statusMenuItems().length).toBeGreaterThan(0));
    await user.click(statusMenuItems().find(b => b.textContent === 'Підтвердити')!);
    await waitFor(() => expect(confirmDialog()).toBeTruthy());

    await pressEscape(user);

    await waitFor(() => expect(confirmDialog()).toBeUndefined());
    expect(transitionCalls()).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Складський документ' })).toBeTruthy();

    // Контроль: підтвердження закрито — наступний Escape закриває картку.
    await pressEscape(user);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // Стрілка ◀/▶ лежить у контейнері меню: клік по ній при відкритому меню лишав його відкритим під
  // підтвердженням, і перший Escape закривав сховане меню, а не діалог.
  it('стрілка переходу при відкритому меню закриває меню — Escape іде в підтвердження', async () => {
    const { onClose, user } = await openDoc();
    await user.click(screen.getByRole('button', { name: 'Чернетка' }));
    await waitFor(() => expect(statusMenuItems().length).toBeGreaterThan(0));
    await user.click(screen.getByRole('button', { name: stockDocStatusLabel('CONFIRMED') }));
    await waitFor(() => expect(confirmDialog()).toBeTruthy());
    expect(statusMenuItems()).toHaveLength(0);

    await pressEscape(user);

    await waitFor(() => expect(confirmDialog()).toBeUndefined());
    expect(onClose).not.toHaveBeenCalled();
  });

  // Проведений документ переходів не має — меню не рендериться, і Escape не має «ковтатись»
  // перехоплювачем невидимого меню: він закриває картку.
  it('проведений документ: клік по статусу без меню не забирає Escape у картки', async () => {
    const { onClose, user } = await openDoc('CONFIRMED');
    await user.click(screen.getByRole('button', { name: stockDocStatusLabel('CONFIRMED') }));
    expect(statusMenuItems()).toHaveLength(0);

    await pressEscape(user);

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('SupplierPaymentCreateModal — Escape у вікні вибору постачальника (Bug #931)', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({ items: [] });
  });

  it('закриває лише вікно вибору, картка оплати лишається', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithQueryClient(<SupplierPaymentCreateModal open onClose={onClose} onSaved={vi.fn()} />);
    await user.click((await screen.findAllByRole('button', { name: 'Обрати' }))[0]!);
    await screen.findByRole('dialog', { name: /Оберіть постачальника/ });

    await pressEscape(user);

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /Оберіть постачальника/ })).toBeNull(),
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
