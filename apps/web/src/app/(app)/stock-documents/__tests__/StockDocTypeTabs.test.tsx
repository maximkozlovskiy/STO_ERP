// BR-SDOC-007: таб-бар типів на вкладці «Документи складу» будується з
// `Object.keys(STOCK_DOC_TYPE_LABELS)` (`@sto/shared`), а не з переліку у page.tsx.
//
// Правило — про АВТОМАТИЧНЕ підхоплення: новий тип, доданий у shared, має з'явитись
// вкладкою без жодної правки сторінки. Тест із чотирма нинішніми типами цього не
// доводить (захардкоджений список дав би той самий DOM), тому тут у мапу підкладено
// п'ятий, якого у page.tsx гарантовано немає, — `INVENTORY_COUNT`.
//
// Mutation-verify: замінити у page.tsx `Object.keys(STOCK_DOC_TYPE_LABELS)` на літерал
// з чотирьох типів (окремо для TYPE_FILTERS і для VALID_TYPES) → відповідний кейс падає.

import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';

const NEW_TYPE = 'INVENTORY_COUNT';
const NEW_TYPE_LABEL = 'Інвентаризація';

// Нового типу немає ні у page.tsx, ні у каталозі перекладів → назва береться з мапи shared
// (enumLabel: i18n → fallbackMap), тобто вкладка з'являється лише якщо сторінка читає ключі мапи.
vi.mock('@sto/shared', async importOriginal => {
  const actual = await importOriginal<typeof import('@sto/shared')>();
  return {
    ...actual,
    STOCK_DOC_TYPE_LABELS: { ...actual.STOCK_DOC_TYPE_LABELS, INVENTORY_COUNT: 'Інвентаризація' },
  };
});

const replaceMock = vi.fn();
let currentSearch = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(currentSearch),
  usePathname: () => '/stock-documents',
}));

vi.mock('@/lib/auth', () => ({
  useRequireAuth: () => ({ employee: { id: 'e1', role: 'OWNER' } }),
  useAuth: () => ({ employee: { id: 'e1', role: 'OWNER' } }),
}));

vi.mock('@/lib/api-client', () => ({
  apiFetch: () => Promise.resolve({}),
}));

const useStockDocumentsMock = vi.fn();
vi.mock('@/hooks/api/useStockDocuments', async importOriginal => {
  const actual = await importOriginal<typeof import('@/hooks/api/useStockDocuments')>();
  return {
    ...actual,
    useStockDocuments: (filters: Record<string, unknown>) => {
      useStockDocumentsMock(filters);
      return { data: { items: [], total: 0, page: 1, limit: 20 }, isLoading: false };
    },
  };
});

// Сусідні вкладки й модалка створення до правила не стосуються — заглушки.
vi.mock('../../inventory/InventoryTab', () => ({ InventoryTab: () => null }));
vi.mock('../StockMovementsTab', () => ({ StockMovementsTab: () => null }));
vi.mock('@/components/ui/StockDocumentCreateModal', () => ({
  StockDocumentCreateModal: () => null,
}));

import StockDocumentsPage from '../page';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <StockDocumentsPage />
    </QueryClientProvider>,
  );
}

describe('Таб-бар типів складського документа (BR-SDOC-007)', () => {
  beforeEach(() => {
    replaceMock.mockReset();
    useStockDocumentsMock.mockReset();
    currentSearch = '';
  });

  // guards: BR-SDOC-007
  it('тип, доданий у STOCK_DOC_TYPE_LABELS, стає вкладкою без правки сторінки', async () => {
    renderPage();

    // Нинішні типи на місці…
    expect(await screen.findByRole('button', { name: 'Оприбуткування' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Переміщення' })).toBeInTheDocument();
    // …і новий, якого сторінка «не знає», теж.
    expect(screen.getByRole('button', { name: NEW_TYPE_LABEL })).toBeInTheDocument();
  });

  // guards: BR-SDOC-007
  it('клік по вкладці нового типу ставить його у URL (?type=…)', async () => {
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: NEW_TYPE_LABEL }));

    expect(replaceMock).toHaveBeenCalledWith(`?type=${NEW_TYPE}`, { scroll: false });
  });

  // guards: BR-SDOC-007
  it('?type=<новий тип> з URL приймається фільтром і йде у запит списку', async () => {
    currentSearch = `type=${NEW_TYPE}`;
    renderPage();

    // findAll: з активним типом його назву несе ще й кнопка «додати документ».
    await screen.findAllByRole('button', { name: NEW_TYPE_LABEL });
    expect(useStockDocumentsMock).toHaveBeenCalledWith(expect.objectContaining({ type: NEW_TYPE }));
  });

  it('невідомий ?type= відкидається — список запитується без фільтра типу', async () => {
    currentSearch = 'type=NO_SUCH_TYPE';
    renderPage();

    await screen.findByRole('button', { name: NEW_TYPE_LABEL });
    expect(useStockDocumentsMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: undefined }),
    );
  });
});
