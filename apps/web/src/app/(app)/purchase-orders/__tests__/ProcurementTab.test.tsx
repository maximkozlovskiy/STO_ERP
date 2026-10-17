// «Управління купівлями»: види «Нестача / Позиції / Списки» за `?view=`, `?list=` відкриває
// «Списки», а редагування (масові дії, об'єднання) — лише власнику, адміністратору, комірнику
// (BR-PL-015). Самі види — заглушки з пропсами; їх логіку стережуть свої тести й E2E.

import { render, screen, fireEvent } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

let search = '';
const replaceMock = vi.fn((url: string) => {
  search = url.replace(/^\?/, '');
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search),
}));

let role = 'OWNER';
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ employee: { id: 'e1', role } }) }));

vi.mock('../procurement/ShortageView', () => ({
  ShortageView: () => <div data-testid="view-shortage" />,
}));
vi.mock('../procurement/ItemsView', () => ({
  ItemsView: ({ canWrite }: { canWrite: boolean }) => (
    <div data-testid="view-items" data-can-write={String(canWrite)} />
  ),
}));
vi.mock('../procurement/ListsView', () => ({
  ListsView: ({ canWrite, openListId }: { canWrite: boolean; openListId: string | null }) => (
    <div data-testid="view-lists" data-can-write={String(canWrite)} data-open={openListId ?? ''} />
  ),
}));

import { ProcurementTab } from '../ProcurementTab';

describe('ProcurementTab', () => {
  beforeEach(() => {
    search = '';
    role = 'OWNER';
    replaceMock.mockClear();
  });

  it('за замовчуванням — «Нестача»; клік по виду пише view і прибирає list', () => {
    search = 'tab=procurement&list=abc';
    const { rerender } = render(<ProcurementTab />);
    expect(screen.getByTestId('view-lists')).toHaveAttribute('data-open', 'abc');

    fireEvent.click(screen.getByRole('tab', { name: 'Позиції' }));
    const params = new URLSearchParams(replaceMock.mock.calls[0]![0].replace(/^\?/, ''));
    expect(params.get('view')).toBe('items');
    expect(params.get('list')).toBeNull();
    expect(params.get('tab')).toBe('procurement');

    search = '';
    rerender(<ProcurementTab />);
    expect(screen.getByTestId('view-shortage')).toBeInTheDocument();
  });

  // guards: BR-PL-015
  it.each([
    ['OWNER', 'true'],
    ['STOREKEEPER', 'true'],
    ['RECEPTIONIST', 'false'],
  ])('%s: редагування позицій і списків — %s', (r, canWrite) => {
    role = r;
    search = 'view=items';
    const { unmount } = render(<ProcurementTab />);
    expect(screen.getByTestId('view-items')).toHaveAttribute('data-can-write', canWrite);
    unmount();
    search = 'view=lists';
    render(<ProcurementTab />);
    expect(screen.getByTestId('view-lists')).toHaveAttribute('data-can-write', canWrite);
  });
});
