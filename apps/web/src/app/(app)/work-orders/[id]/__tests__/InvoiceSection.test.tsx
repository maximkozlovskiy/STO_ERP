// Regression-guard для InvoiceSection — slot у картці наряду що рендерить
// існуючий рахунок або кнопку "Виставити рахунок" (commit 523190f2).
//
// Bugs guarded:
//   #510 (MEDIUM) — нова UI секція з кількома conditional-render-блоками
//                    мала жити без component-test. Кожен з гейтів легко
//                    зламати рефактором: WO_INVOICEABLE_STATUSES, DRAFT-only
//                    кнопка "Оновити з наряду", INVOICE_STATUS_LABELS lookup,
//                    PDF download wire, empty state, повний shape state.

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, it, expect, describe, beforeAll, beforeEach, afterAll } from 'vitest';

import { InvoiceSection, type InvoiceRef } from '../InvoiceSection';

// jsdom не визначає URL.createObjectURL / revokeObjectURL — стабимо ГЛОБАЛЬНО
// (на весь тест-файл), бо InvoiceSection викликає revoke у setTimeout(..., 100)
// що часто резолвиться ПІСЛЯ teardown індивідуального тесту → uncaught error.
const origCreateObjectURL = (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
const origRevokeObjectURL = (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
beforeAll(() => {
  URL.createObjectURL = vi.fn(() => 'blob:fake-url') as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
});
afterAll(() => {
  (URL as unknown as { createObjectURL?: unknown }).createObjectURL = origCreateObjectURL;
  (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL = origRevokeObjectURL;
});

// ─── Hook & module mocks ─────────────────────────────────────────────────────

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushMock,
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
}));

const apiFetchMock = vi.fn();
const apiBlobFetchMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  apiBlobFetch: (...args: unknown[]) => apiBlobFetchMock(...args),
}));

/// Роль користувача: «Друк рахунку» — лише INVOICE_PRINT_ROLES (гейт усередині InvoiceSection).
let role: string | undefined = 'RECEPTIONIST';
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ employee: role ? { role } : null }),
}));

// useUiFeatures повертає `toastEnabled` — компонент пускає toast лише якщо true.
// Для component-test вимикаємо toast щоб не залежати від toast-mount.
vi.mock('@/hooks/useUiFeatures', () => ({
  useUiFeatures: () => ({
    toastEnabled: false,
    unsavedGuardEnabled: false,
    stockIndicatorEnabled: false,
    commandPaletteEnabled: false,
    keyboardShortcutsEnabled: false,
    savedFiltersEnabled: false,
    inlineEditEnabled: false,
    syncIndicatorEnabled: false,
    notificationCenterEnabled: false,
    bulkActionsEnabled: false,
  }),
}));

// useBaseCurrency читає org базову валюту через useQuery — стабимо, щоб не потрібен
// QueryClientProvider у component-test (мультивалюта Фаза 3).
vi.mock('@/hooks/api/useCash', () => ({
  useBaseCurrency: () => ({ data: { code: 'UAH', symbol: '₴' } }),
}));

// ─── Shared fixtures ─────────────────────────────────────────────────────────

const WO_ID = '11111111-1111-4111-8111-111111111111';
const INV_ID = '22222222-2222-4222-8222-222222222222';

const draftInvoice: InvoiceRef = {
  id: INV_ID,
  number: 'INV-2026-0001',
  status: 'DRAFT',
  amount: 1250.5,
  documentDate: '2026-01-15T00:00:00.000Z',
};

beforeEach(() => {
  role = 'RECEPTIONIST';
  apiFetchMock.mockReset();
  apiBlobFetchMock.mockReset();
  pushMock.mockClear();
});

// ─── Bug #510 ────────────────────────────────────────────────────────────────

describe('InvoiceSection — gating', () => {
  it('не рендериться поки invoiceRef=undefined (ще завантажується)', () => {
    const { container } = render(
      <InvoiceSection
        workOrderId={WO_ID}
        workOrderStatus="COMPLETED"
        invoiceRef={undefined}
        onChange={vi.fn()}
      />,
    );
    // Section повністю прихована до моменту першого fetch — інакше empty state
    // мерехтить між загрузкою і наявним інвойсом.
    expect(container.firstChild).toBeNull();
  });

  it('не рендериться для не-invoiceable статусу (IN_PROGRESS)', () => {
    const { container } = render(
      <InvoiceSection
        workOrderId={WO_ID}
        workOrderStatus="IN_PROGRESS"
        invoiceRef={null}
        onChange={vi.fn()}
      />,
    );
    // WO_INVOICEABLE_STATUSES = ['COMPLETED', 'INVOICED'] — IN_PROGRESS поза whitelist.
    expect(container.firstChild).toBeNull();
  });

  it('рендериться для invoiceable статусу INVOICED', () => {
    render(
      <InvoiceSection
        workOrderId={WO_ID}
        workOrderStatus="INVOICED"
        invoiceRef={null}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('Рахунок')).toBeInTheDocument();
  });
});

describe('InvoiceSection — empty state (invoiceRef=null)', () => {
  it('показує empty-state і кнопку "Виставити рахунок" коли рахунку немає', () => {
    render(
      <InvoiceSection
        workOrderId={WO_ID}
        workOrderStatus="COMPLETED"
        invoiceRef={null}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('Рахунок не виставлено')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Виставити рахунок' })).toBeInTheDocument();
  });

  it('клік "Виставити рахунок" — POST /invoices/from-work-order/:id + onChange отримує повний 5-полевий shape', async () => {
    // Bug #509: backend повертає 5 полів — onChange має зберегти всі.
    apiFetchMock.mockResolvedValueOnce({
      id: INV_ID,
      number: 'INV-2026-0001',
      status: 'DRAFT',
      amount: 1250.5,
      documentDate: '2026-01-15T00:00:00.000Z',
    });
    const onChange = vi.fn();
    render(
      <InvoiceSection
        workOrderId={WO_ID}
        workOrderStatus="COMPLETED"
        invoiceRef={null}
        onChange={onChange}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Виставити рахунок' }));

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(`/invoices/from-work-order/${WO_ID}`, {
        method: 'POST',
      }),
    );
    expect(onChange).toHaveBeenCalledWith({
      id: INV_ID,
      number: 'INV-2026-0001',
      status: 'DRAFT',
      amount: 1250.5,
      documentDate: '2026-01-15T00:00:00.000Z',
    });
  });
});

// TECH-DEBT (б) №51: «Виставити рахунок» — у статусах, де сервер рахунок приймає
// (WO_INVOICE_CREATABLE_STATUSES); «Оновити з наряду» — де приймає refresh (WO_INVOICEABLE_STATUSES).
// Mutation-verify: гейт кнопки створення на WO_INVOICEABLE_STATUSES → червоніє PAID; без гейта
// статусу → червоніє ARCHIVED.
describe('InvoiceSection — статуси наряду для дій (BR-WO-037)', () => {
  // guards: BR-WO-037
  it.each(['COMPLETED', 'INVOICED', 'PAID'])(
    'наряд %s без рахунку → «Виставити рахунок» є',
    status => {
      render(
        <InvoiceSection
          workOrderId={WO_ID}
          workOrderStatus={status}
          invoiceRef={null}
          onChange={vi.fn()}
        />,
      );
      expect(screen.getByRole('button', { name: 'Виставити рахунок' })).toBeInTheDocument();
    },
  );

  // guards: BR-WO-037
  it('наряд «Архів» без рахунку → «Виставити рахунок» сховано (сервер відхиляє), порожній стан є', () => {
    render(
      <InvoiceSection
        workOrderId={WO_ID}
        workOrderStatus="ARCHIVED"
        invoiceRef={null}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('Рахунок не виставлено')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Виставити рахунок' })).not.toBeInTheDocument();
  });

  // guards: BR-WO-037
  it.each(['PAID', 'ARCHIVED'])(
    'наряд %s з чернеткою рахунку → «Оновити з наряду» сховано (refresh лише «Виконано» / «Виставлено»)',
    status => {
      render(
        <InvoiceSection
          workOrderId={WO_ID}
          workOrderStatus={status}
          invoiceRef={draftInvoice}
          onChange={vi.fn()}
        />,
      );
      expect(screen.queryByRole('button', { name: 'Оновити з наряду' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'PDF рахунку' })).toBeInTheDocument();
    },
  );
});

describe('InvoiceSection — DRAFT invoice present', () => {
  it('показує номер, badge "Чернетка", суму, дату і кнопку "Оновити з наряду"', () => {
    render(
      <InvoiceSection
        workOrderId={WO_ID}
        workOrderStatus="COMPLETED"
        invoiceRef={draftInvoice}
        onChange={vi.fn()}
      />,
    );

    // Номер
    expect(screen.getByText('Рахунок № INV-2026-0001')).toBeInTheDocument();
    // Український label з INVOICE_STATUS_LABELS — критично для FE↔BE symmetry (Bug #401).
    expect(screen.getByText('Чернетка')).toBeInTheDocument();
    // Сума з символом гривні (fmtMoney повертає форматовану суму).
    expect(screen.getByText(/₴/)).toBeInTheDocument();
    // DRAFT-only кнопка
    expect(screen.getByRole('button', { name: 'Оновити з наряду' })).toBeInTheDocument();
    // PDF + Open invoices завжди є
    expect(screen.getByRole('button', { name: 'PDF рахунку' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Відкрити рахунки ↗' })).toBeInTheDocument();
    // "Виставити рахунок" приховано бо рахунок існує
    expect(screen.queryByRole('button', { name: 'Виставити рахунок' })).not.toBeInTheDocument();
  });

  it('клік "Оновити з наряду" — POST /invoices/from-work-order/:id/refresh + onChange отримує новий shape', async () => {
    apiFetchMock.mockResolvedValueOnce({
      id: INV_ID,
      number: 'INV-2026-0001',
      status: 'DRAFT',
      amount: 2000,
      documentDate: '2026-01-15T00:00:00.000Z',
    });
    const onChange = vi.fn();
    render(
      <InvoiceSection
        workOrderId={WO_ID}
        workOrderStatus="COMPLETED"
        invoiceRef={draftInvoice}
        onChange={onChange}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Оновити з наряду' }));

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(`/invoices/from-work-order/${WO_ID}/refresh`, {
        method: 'POST',
      }),
    );
    expect(onChange).toHaveBeenCalledWith({
      id: INV_ID,
      number: 'INV-2026-0001',
      status: 'DRAFT',
      amount: 2000,
      documentDate: '2026-01-15T00:00:00.000Z',
    });
  });
});

describe('InvoiceSection — PAID invoice', () => {
  it('показує badge "Оплачено" БЕЗ кнопки "Оновити з наряду" (refresh лише для DRAFT)', () => {
    render(
      <InvoiceSection
        workOrderId={WO_ID}
        workOrderStatus="INVOICED"
        invoiceRef={{ ...draftInvoice, status: 'PAID' }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('Оплачено')).toBeInTheDocument();
    // CRITICAL: refresh кнопка ховається для non-DRAFT — інакше можна затерти
    // надіслані / оплачені рядки. Це частина бізнес-правила Invoice FSM.
    expect(screen.queryByRole('button', { name: 'Оновити з наряду' })).not.toBeInTheDocument();
  });
});

describe('InvoiceSection — PDF download wire', () => {
  it('клік "PDF рахунку" — apiBlobFetch /invoices/:id/pdf + filename використовує номер', async () => {
    const blob = new Blob(['PDF'], { type: 'application/pdf' });
    apiBlobFetchMock.mockResolvedValueOnce(blob);

    // URL.createObjectURL/revokeObjectURL застабовано глобально у beforeAll.
    // Перехоплюємо anchor click щоб jsdom не намагався реально клікнути.
    const anchorClickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});

    try {
      render(
        <InvoiceSection
          workOrderId={WO_ID}
          workOrderStatus="COMPLETED"
          invoiceRef={draftInvoice}
          onChange={vi.fn()}
        />,
      );

      await userEvent.click(screen.getByRole('button', { name: 'PDF рахунку' }));

      await waitFor(() => expect(apiBlobFetchMock).toHaveBeenCalledWith(`/invoices/${INV_ID}/pdf`));
      expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
      expect(anchorClickSpy).toHaveBeenCalled();
    } finally {
      anchorClickSpy.mockRestore();
    }
  });

  it('клік "Відкрити рахунки ↗" — router.push("/invoices")', async () => {
    render(
      <InvoiceSection
        workOrderId={WO_ID}
        workOrderStatus="COMPLETED"
        invoiceRef={draftInvoice}
        onChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Відкрити рахунки ↗' }));
    expect(pushMock).toHaveBeenCalledWith('/invoices');
  });
});

describe('InvoiceSection — nullable documentDate', () => {
  it('рендериться без помилки і без дати коли documentDate=null', () => {
    render(
      <InvoiceSection
        workOrderId={WO_ID}
        workOrderStatus="COMPLETED"
        invoiceRef={{ ...draftInvoice, documentDate: null }}
        onChange={vi.fn()}
      />,
    );
    // Номер + badge — рендеряться. Дати немає.
    expect(screen.getByText('Рахунок № INV-2026-0001')).toBeInTheDocument();
    expect(screen.getByText('Чернетка')).toBeInTheDocument();
    // fmtDate ніде не викликався — інакше отримали б "Invalid Date".
  });
});

// BR-WO-012: наряд позначено на видалення — секція лише показує рахунок. Контроль «для звичайного
// наряду кнопки є» — кейси вище («Виставити рахунок», «Оновити з наряду»).
describe('InvoiceSection — наряд позначено на видалення (readOnly)', () => {
  it('рахунку немає → «Виставити рахунок» сховано, порожній стан лишається', () => {
    render(
      <InvoiceSection
        workOrderId={WO_ID}
        workOrderStatus="COMPLETED"
        invoiceRef={null}
        onChange={vi.fn()}
        readOnly
      />,
    );
    expect(screen.getByText('Рахунок не виставлено')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Виставити рахунок' })).not.toBeInTheDocument();
  });

  it('чернетка рахунку → «Оновити з наряду» сховано; PDF рахунку і перехід до списку лишаються', () => {
    render(
      <InvoiceSection
        workOrderId={WO_ID}
        workOrderStatus="COMPLETED"
        invoiceRef={draftInvoice}
        onChange={vi.fn()}
        readOnly
      />,
    );
    expect(screen.getByText('Рахунок № INV-2026-0001')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Оновити з наряду' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'PDF рахунку' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Відкрити рахунки ↗' })).toBeInTheDocument();
  });
});

describe('InvoiceSection — «Друк рахунку»', () => {
  it('рахунок є і роль може друкувати → кнопка є; клік відкриває вікно і запитує PDF рахунку', async () => {
    const win = {
      document: document.implementation.createHTMLDocument(''),
      closed: false,
      close: vi.fn(),
      addEventListener: vi.fn(),
    };
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
    apiBlobFetchMock.mockResolvedValue(new Blob(['%PDF'], { type: 'application/pdf' }));
    render(
      <InvoiceSection
        workOrderId={WO_ID}
        workOrderStatus="INVOICED"
        invoiceRef={draftInvoice}
        onChange={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Друк рахунку' }));

    await waitFor(() => expect(apiBlobFetchMock).toHaveBeenCalledWith(`/invoices/${INV_ID}/pdf`));
    expect(openSpy).toHaveBeenCalledWith('', '_blank');
    expect(win.document.title).toBe('Рахунок INV-2026-0001');
    openSpy.mockRestore();
  });

  it('PDF рахунку не отримано → вікно друку закривається', async () => {
    const win = {
      document: document.implementation.createHTMLDocument(''),
      closed: false,
      close: vi.fn(),
      addEventListener: vi.fn(),
    };
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(win as unknown as Window);
    apiBlobFetchMock.mockRejectedValue(new Error('Рахунок не знайдено'));
    render(
      <InvoiceSection
        workOrderId={WO_ID}
        workOrderStatus="PAID"
        invoiceRef={draftInvoice}
        onChange={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Друк рахунку' }));

    await waitFor(() => expect(win.close).toHaveBeenCalledTimes(1));
    // Тости вимкнено (мок useUiFeatures) — причина видна в самій секції, а не зникає мовчки.
    expect(await screen.findByRole('alert')).toHaveTextContent('Рахунок не знайдено');
    openSpy.mockRestore();
  });

  // Сервер дозволяє `GET /invoices/:id/pdf` лише OWNER, ADMIN, ACCOUNTANT, RECEPTIONIST.
  it.each([['MECHANIC'], [undefined]])(
    'роль %s без доступу до рахунку → кнопки «Друк рахунку» немає, «PDF рахунку» лишається',
    r => {
      role = r;
      render(
        <InvoiceSection
          workOrderId={WO_ID}
          workOrderStatus="INVOICED"
          invoiceRef={draftInvoice}
          onChange={vi.fn()}
        />,
      );
      expect(screen.queryByRole('button', { name: 'Друк рахунку' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'PDF рахунку' })).toBeInTheDocument();
    },
  );

  it.each([['OWNER'], ['ADMIN'], ['ACCOUNTANT'], ['RECEPTIONIST']])(
    'роль %s → «Друк рахунку» є',
    r => {
      role = r;
      render(
        <InvoiceSection
          workOrderId={WO_ID}
          workOrderStatus="PAID"
          invoiceRef={draftInvoice}
          onChange={vi.fn()}
        />,
      );
      expect(screen.getByRole('button', { name: 'Друк рахунку' })).toBeInTheDocument();
    },
  );

  it('рахунку немає → кнопки немає', () => {
    render(
      <InvoiceSection
        workOrderId={WO_ID}
        workOrderStatus="COMPLETED"
        invoiceRef={null}
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Друк рахунку' })).not.toBeInTheDocument();
  });

  it('наряд видалено (readOnly) → «Друк рахунку» лишається: рахунок окремий документ', () => {
    render(
      <InvoiceSection
        workOrderId={WO_ID}
        workOrderStatus="INVOICED"
        invoiceRef={draftInvoice}
        onChange={vi.fn()}
        readOnly
      />,
    );
    expect(screen.getByRole('button', { name: 'Друк рахунку' })).toBeInTheDocument();
  });
});

// Bug #1033: два кліки в одному такті слали два POST — другий («рахунок уже існує») давав тост
// помилки поруч зі щойно створеним рахунком. Mutation-verify: без `busyRef` → два POST.
describe('InvoiceSection — подвійний клік', () => {
  it('«Виставити рахунок» двічі в одному такті — один POST', async () => {
    let release: (v: unknown) => void = () => {};
    apiFetchMock.mockImplementation(
      () =>
        new Promise(resolve => {
          release = resolve;
        }),
    );
    render(
      <InvoiceSection
        workOrderId={WO_ID}
        workOrderStatus="PAID"
        invoiceRef={null}
        onChange={vi.fn()}
      />,
    );
    const btn = screen.getByRole('button', { name: 'Виставити рахунок' });
    act(() => {
      btn.click();
      btn.click();
    });
    await act(async () => {
      release({ id: INV_ID, number: 'INV-1', status: 'DRAFT', amount: 10, documentDate: null });
      await Promise.resolve();
    });
    expect(
      apiFetchMock.mock.calls.filter(c => c[0] === `/invoices/from-work-order/${WO_ID}`),
    ).toHaveLength(1);
  });
});
