// Сторінка наряду `/work-orders/[id]`: які запити вона шле — залежно від ролі й від того, чи наряд
// позначено на видалення.
//
// TECH-DEBT §11 п.8: акти виконаних робіт (`GET /completion-acts`) і рахунок наряду
// (`GET /invoices/from-work-order/:id/find`) сервер віддає лише COMPLETION_ACT_READ_ROLES /
// INVOICE_READ_ROLES — механік на кожне відкриття картки отримував два 403 у консолі. Огляд
// (`/inspection`, `/inspection/default-points`) не віддається бухгалтеру — так само.
// TECH-DEBT §8 L797: медіа (`GET /work-orders/:id/media`) ішло паралельно з нарядом, і для
// видаленого наряду сервер відповідав 404; коментарі видаленого наряду — теж 404.
//
// Mutation-verify:
//   - `canReadActs` → `true`                                  → «MECHANIC: акта…» падає;
//   - `canReadInvoice` → `true`                               → «MECHANIC: …рахунку» падає;
//   - `canReadInspection` / гейт default-points → `true`      → «ACCOUNTANT: огляду» падає;
//   - прибрати `role` із залежностей `load`                    → «роль прийшла пізніше» падає;
//   - `if (!woId || woDeleted) return;` → `if (!woId) return;` → «видалений наряд: медіа» падає;
//   - `{!isDeleted && <CommentsSection …/>}` → без умови     → «видалений наряд: коментарі» падає;
//   - гейти навпаки (запит лише для «чужих» ролей)           → кейси ADMIN падають.

import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, it, expect, describe, beforeEach } from 'vitest';

const WO_ID = '11111111-1111-4111-8111-111111111111';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: WO_ID }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => `/work-orders/${WO_ID}`,
  useSearchParams: () => new URLSearchParams(),
}));

let role: string | null = 'ADMIN';
vi.mock('@/lib/auth', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  useRequireAuth: () => undefined,
  useAuth: () => ({ employee: role ? { id: 'e1', role } : null }),
}));

const apiFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiBlobFetch: vi.fn(),
  apiMultipartFetch: vi.fn(),
}));
vi.mock('@/lib/ref-cache', () => ({ getCached: () => null, setCache: vi.fn() }));

import WorkOrderCardPage from '../PageClient';

const workOrder = (over: Record<string, unknown> = {}) => ({
  id: WO_ID,
  number: 'WO-0042',
  status: 'IN_PROGRESS',
  branchId: 'b1',
  vehicleId: 'v1',
  counterpartyId: 'c1',
  totalLabor: 0,
  totalActualLabor: 0,
  totalParts: 0,
  totalAmount: 0,
  paidAmount: 0,
  lines: [],
  parts: [],
  deletedAt: null,
  ...over,
});
let wo = workOrder();

const paths = () => apiFetchMock.mock.calls.map(c => String(c[0]));
const requested = (prefix: string) => paths().some(p => p.startsWith(prefix));

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = () => (
    <QueryClientProvider client={client}>
      <WorkOrderCardPage />
    </QueryClientProvider>
  );
  const r = render(ui());
  return { rerender: () => r.rerender(ui()) };
}

/** Наряд показано — перша хвиля запитів сторінки вже пішла. */
const woShown = () => screen.findByText(/WO-0042/, undefined, { timeout: 5000 });

beforeEach(() => {
  role = 'ADMIN';
  wo = workOrder();
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((path: string) => {
    if (path.startsWith(`/work-orders/${WO_ID}?`)) return Promise.resolve(wo);
    if (path === `/work-orders/${WO_ID}/inspection`) return Promise.resolve(null);
    if (path.endsWith('/inspection/default-points')) return Promise.resolve([]);
    if (path.startsWith('/invoices/from-work-order/')) return Promise.resolve(null);
    if (path.startsWith('/purchase-list-items/by-work-order/'))
      return Promise.resolve({ items: [], shortage: [] });
    if (path === '/warehouses') return Promise.resolve([]);
    return Promise.resolve({ items: [] });
  });
});

describe('сторінка наряду — запити за роллю (TECH-DEBT §11 п.8)', () => {
  it('MECHANIC: акта й рахунку не запитує (сервер дав би 403), огляд — так', async () => {
    role = 'MECHANIC';
    renderPage();
    await woShown();
    await waitFor(() => expect(requested(`/work-orders/${WO_ID}/media`)).toBe(true));

    expect(requested('/completion-acts')).toBe(false);
    expect(requested('/invoices/from-work-order/')).toBe(false);
    expect(requested(`/work-orders/${WO_ID}/inspection`)).toBe(true);
  });

  it('ADMIN: акт, рахунок і огляд запитуються', async () => {
    renderPage();
    await woShown();

    expect(paths()).toContain(`/completion-acts?workOrderId=${WO_ID}`);
    expect(paths()).toContain(`/invoices/from-work-order/${WO_ID}/find`);
    expect(paths()).toContain(`/work-orders/${WO_ID}/inspection`);
    expect(paths()).toContain(`/work-orders/${WO_ID}/inspection/default-points`);
  });

  it('ACCOUNTANT: акт і рахунок — так, огляду (і його точок) — ні', async () => {
    role = 'ACCOUNTANT';
    renderPage();
    await woShown();

    expect(paths()).toContain(`/completion-acts?workOrderId=${WO_ID}`);
    expect(paths()).toContain(`/invoices/from-work-order/${WO_ID}/find`);
    expect(requested(`/work-orders/${WO_ID}/inspection`)).toBe(false);
  });

  it('роль прийшла пізніше за перший рендер — акт і рахунок дозапитуються', async () => {
    role = null;
    const { rerender } = renderPage();
    await woShown();
    expect(requested('/completion-acts')).toBe(false);

    role = 'ADMIN';
    rerender();
    await waitFor(() => expect(paths()).toContain(`/completion-acts?workOrderId=${WO_ID}`));
    expect(paths()).toContain(`/invoices/from-work-order/${WO_ID}/find`);
  });
});

// Bug #986: гарантії наряду (`GET /warranties/by-work-order/:id`) сервер не віддає бухгалтеру —
// на виконаному наряді він отримував 403 у консолі; механіку віддає, але «+ Гарантія» і
// «Пред’явити» (POST) — ні.
// Mutation-verify: прибрати гейт `WARRANTY_BY_WO_READ_ROLES` → «ACCOUNTANT: гарантій…» падає;
// `readOnly={isDeleted}` без ролі → «MECHANIC: гарантії видно…» падає.
describe('сторінка наряду — гарантії за роллю (Bug #986)', () => {
  const activeWarranty = {
    id: 'w1',
    workOrderId: WO_ID,
    counterpartyId: 'c1',
    expiresAt: '2099-01-01T00:00:00.000Z',
    description: 'Гарантія тесту',
    claimedAt: null,
    isActive: true,
  };
  const withWarranty = () => {
    const base = apiFetchMock.getMockImplementation()!;
    apiFetchMock.mockImplementation((path: string, ...rest: unknown[]) =>
      path.startsWith('/warranties/by-work-order/')
        ? Promise.resolve({ items: [activeWarranty] })
        : base(path, ...rest),
    );
  };

  it('ACCOUNTANT: гарантій виконаного наряду не запитує (сервер дав би 403)', async () => {
    role = 'ACCOUNTANT';
    wo = workOrder({ status: 'COMPLETED' });
    renderPage();
    await woShown();
    await waitFor(() => expect(paths()).toContain(`/invoices/from-work-order/${WO_ID}/find`));
    await new Promise(r => setTimeout(r, 50));
    expect(requested('/warranties/by-work-order/')).toBe(false);
  });

  it('MECHANIC: гарантії видно, але без «+ Гарантія» і «Пред’явити»', async () => {
    role = 'MECHANIC';
    wo = workOrder({ status: 'COMPLETED' });
    withWarranty();
    renderPage();
    await woShown();
    expect(await screen.findByText('Гарантія тесту')).toBeInTheDocument();
    expect(screen.queryByText('Пред’явити')).toBeNull();
    expect(screen.queryByText('+ Гарантія')).toBeNull();
  });

  it('RECEPTIONIST (контроль): гарантії з «+ Гарантія» і «Пред’явити»', async () => {
    role = 'RECEPTIONIST';
    wo = workOrder({ status: 'COMPLETED' });
    withWarranty();
    renderPage();
    await woShown();
    expect(await screen.findByText('Гарантія тесту')).toBeInTheDocument();
    expect(screen.getByText('Пред’явити')).toBeInTheDocument();
    expect(screen.getByText('+ Гарантія')).toBeInTheDocument();
  });
});

describe('сторінка наряду — видалений наряд (TECH-DEBT §8 L797)', () => {
  it('звичайний наряд: медіа й коментарі запитуються після наряду', async () => {
    renderPage();
    await woShown();
    await waitFor(() => expect(paths()).toContain(`/work-orders/${WO_ID}/media`));
    expect(requested('/comments?')).toBe(true);
  });

  // guards: BR-WO-012
  it('видалений наряд: медіа й коментарів не запитує (сервер дав би 404)', async () => {
    wo = workOrder({ deletedAt: '2026-10-20T10:00:00.000Z', status: 'DRAFT' });
    renderPage();
    await woShown();
    // Перша хвиля (наряд, акт, рахунок, огляд) уже відпрацювала — дати ефектам шанс.
    await waitFor(() => expect(paths()).toContain(`/invoices/from-work-order/${WO_ID}/find`));
    await new Promise(r => setTimeout(r, 50));

    expect(requested(`/work-orders/${WO_ID}/media`)).toBe(false);
    expect(requested('/comments?')).toBe(false);
  });
});

// BR-WO-036: «Зберегти як послугу» — `POST /services` сервер дозволяє лише OWNER / ADMIN; іншим
// ролям кнопки немає (RECEPTIONIST колись зберігав шаблон, тепер — ні).
// Mutation-verify: прибрати гейт `SERVICE_WRITE_ROLES` → «RECEPTIONIST: кнопки немає» падає.
describe('сторінка наряду — «Зберегти як послугу» за роллю (BR-WO-036)', () => {
  const LINE = { id: 'l1', workId: 'w1', employeeId: 'e1', normoHours: 1, price: 100, amount: 100 };
  const withLine = (over: Record<string, unknown> = {}) => workOrder({ lines: [LINE], ...over });

  // guards: BR-WO-036
  it.each(['OWNER', 'ADMIN'])('%s: кнопка є', async r => {
    role = r;
    wo = withLine();
    renderPage();
    await woShown();
    expect(screen.getByRole('button', { name: 'Зберегти як послугу' })).toBeEnabled();
  });

  // guards: BR-WO-036
  it.each(['RECEPTIONIST', 'MECHANIC', 'ACCOUNTANT'])('%s: кнопки немає', async r => {
    role = r;
    wo = withLine();
    renderPage();
    await woShown();
    expect(screen.queryByRole('button', { name: 'Зберегти як послугу' })).toBeNull();
  });

  it('наряд без робіт і запчастин — кнопка неактивна', async () => {
    renderPage();
    await woShown();
    expect(screen.getByRole('button', { name: 'Зберегти як послугу' })).toBeDisabled();
  });

  // guards: BR-WO-012
  it('видалений наряд — кнопки немає', async () => {
    wo = withLine({ deletedAt: '2026-10-20T10:00:00.000Z' });
    renderPage();
    await woShown();
    expect(screen.queryByRole('button', { name: 'Зберегти як послугу' })).toBeNull();
  });
});
