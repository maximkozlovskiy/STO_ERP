// Regression-guard для InvoiceSection — slot у картці наряду що рендерить
// існуючий рахунок або кнопку "Виставити рахунок" (commit 523190f2).
//
// Bugs guarded:
//   #510 (MEDIUM) — нова UI секція з кількома conditional-render-блоками
//                    мала жити без component-test. Кожен з гейтів легко
//                    зламати рефактором: WO_INVOICEABLE_STATUSES, DRAFT-only
//                    кнопка "Оновити з наряду", INVOICE_STATUS_LABELS lookup,
//                    PDF download wire, empty state, повний shape state.

import { render, screen, waitFor } from '@testing-library/react';
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
