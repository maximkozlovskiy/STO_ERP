// «Назад» у браузері при незбережених змінах картки наряду (рішення власника 2026-10-29): той самий
// запит «Є незбережені зміни», що й «×». «Скасувати» — картка лишається, в адресі знову `open`;
// «Покинути» — картка закривається одним кроком назад до списку. Чиста форма — закриття без запиту.
//
// Картка — заглушка з НАСПРАВЖНІМ `useDirtyForm` і `DirtyConfirmDialog`: тест стереже зв'язку
// сторінка → `useUrlCard` → реєстр форм (`lib/dirty-guards.ts`) → вікно форми.
//
// Mutation-verify (2026-10-29): прибрати реєстрацію в `useDirtyForm` → падають обидва кейси
// «брудна форма» (картка закривається без запиту).
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import { useRouter } from 'next/navigation';
import { urlStore } from '@/__tests__/url-store';

vi.mock('next/navigation', async () =>
  (await import('@/__tests__/url-store')).navigationMock('/work-orders'),
);
vi.mock('@/lib/auth', () => ({
  useRequireAuth: () => ({ employee: { id: 'me', role: 'OWNER' } }),
  useAuth: () => ({ employee: { id: 'me', role: 'OWNER' } }),
}));
vi.mock('next/dynamic', async () => {
  const { useDirtyForm } = await import('@/hooks/useDirtyForm');
  const { DirtyConfirmDialog } = await import('@/components/ui/dirty-confirm-dialog');
  function Card(p: { open?: boolean; workOrderId?: string; onClose?: () => void }) {
    const dirty = useDirtyForm();
    if (!p.open || !p.workOrderId) return null;
    return (
      <div data-testid="wo-card">
        {p.workOrderId}
        <button type="button" onClick={dirty.markDirty}>
          змінити поле
        </button>
        <button
          type="button"
          onClick={async () => {
            if (await dirty.confirmClose()) p.onClose?.();
          }}
        >
          закрити картку
        </button>
        <DirtyConfirmDialog {...dirty.dialogProps} />
      </div>
    );
  }
  return { default: () => Card };
});
vi.mock('@/lib/api-client', () => ({
  apiFetch: (url: string) =>
    Promise.resolve(
      String(url).startsWith('/work-orders?') ? { items: [], total: 0, page: 1, limit: 20 } : {},
    ),
  apiBlobFetch: vi.fn(),
}));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));
vi.mock('@/hooks/api/useCash', () => ({
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
}));
vi.mock('@/components/ui/date-picker-input', () => ({ DatePickerInput: () => null }));

import WorkOrdersPage from '../page';

const WO = '44444444-4444-4444-8444-444444444444';

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <WorkOrdersPage />
    </QueryClientProvider>,
  );
}

/** Картка, відкрита з рядка (новий запис в історії), потім «Назад» у браузері. */
async function openCardThenBack(makeDirty: boolean) {
  urlStore.reset('');
  renderPage();
  // Відкриття з рядка = новий запис в історії з `open` (той самий router, що в `useUrlCard`).
  const router = useRouter();
  act(() => router.push(`/work-orders?open=${WO}`));
  expect(await screen.findByTestId('wo-card')).toHaveTextContent(WO);
  if (makeDirty) fireEvent.click(screen.getByRole('button', { name: 'змінити поле' }));
  act(() => router.back());
}

describe('картка наряду: «Назад» у браузері', () => {
  beforeEach(() => localStorage.clear());

  it('брудна форма: запит «Є незбережені зміни»; «Скасувати» — картка лишається, open в адресі', async () => {
    await openCardThenBack(true);
    expect(await screen.findByText('Є незбережені зміни')).toBeInTheDocument();
    expect(screen.getByTestId('wo-card')).toBeInTheDocument();
    await waitFor(() => expect(urlStore.search).toBe(`open=${WO}`));
    fireEvent.click(screen.getByRole('button', { name: 'Скасувати' }));
    await waitFor(() => expect(screen.queryByText('Є незбережені зміни')).toBeNull());
    expect(screen.getByTestId('wo-card')).toBeInTheDocument();
    expect(urlStore.search).toBe(`open=${WO}`);
  });

  it('брудна форма: «Покинути» — картка закрита, адреса списку', async () => {
    await openCardThenBack(true);
    fireEvent.click(await screen.findByRole('button', { name: 'Покинути' }));
    await waitFor(() => expect(screen.queryByTestId('wo-card')).toBeNull());
    expect(urlStore.search).toBe('');
  });

  it('чиста форма: «Назад» закриває картку без запиту', async () => {
    await openCardThenBack(false);
    await waitFor(() => expect(screen.queryByTestId('wo-card')).toBeNull());
    expect(screen.queryByText('Є незбережені зміни')).toBeNull();
  });
});
