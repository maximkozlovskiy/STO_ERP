// BR-SUPPAY-010 (UI-половина) — drill-down графіка оплат: синтетичний рядок «борг без
// документа» (poId === '') НЕ клікабельний, а рядок справжнього замовлення відкриває PO.
//
// API-тест (`supplier-payments.schedule.spec.ts`) стереже лише маркер `poId=''`. Що саме
// вкладка робить із цим маркером — тут: без role="button", без tabIndex, без aria-label,
// клік і Enter нічого не відкривають. Якби рядок став кнопкою, касир відкривав би модалку
// замовлення з порожнім id.

import { render, screen, fireEvent, within } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';
import type {
  SupplierPaymentSchedule,
  SupplierPaymentScheduleDocument,
  SupplierPaymentDocumentsParams,
} from '@/hooks/api/useSupplierPayments';

let scheduleData: SupplierPaymentSchedule | undefined;
let docsData: SupplierPaymentScheduleDocument[] = [];
const docsParamsSeen: (SupplierPaymentDocumentsParams | null)[] = [];

vi.mock('@/hooks/api/useSupplierPayments', () => ({
  useSupplierPaymentsSchedule: () => ({ data: scheduleData, error: null }),
  useSupplierPaymentDocuments: (params: SupplierPaymentDocumentsParams | null) => {
    docsParamsSeen.push(params);
    return { data: params ? docsData : undefined, isFetching: false, error: null };
  },
}));

// Модалка замовлення — важка (форми, довідники); тут важить лише «відкрита чи ні і з яким id».
vi.mock('@/components/ui/PurchaseOrderCreateModal', () => ({
  PurchaseOrderCreateModal: ({
    open,
    purchaseOrderId,
  }: {
    open: boolean;
    purchaseOrderId?: string;
  }) => (open ? <div data-testid="po-modal">{purchaseOrderId}</div> : null),
}));

import { SupplierPaymentScheduleTab } from '../SupplierPaymentScheduleTab';

const SUPPLIER_ID = 's-1';
const SYNTHETIC_NUMBER = 'Борг без документа';

function doc(over: Partial<SupplierPaymentScheduleDocument>): SupplierPaymentScheduleDocument {
  return {
    poId: 'po-1',
    number: 'ЗАМ-1',
    supplierId: SUPPLIER_ID,
    supplierName: 'Acme',
    paymentDate: null,
    totalAmount: 1000,
    outstanding: 1000,
    allocated: 1000,
    ...over,
  } as SupplierPaymentScheduleDocument;
}

/** Рендерить вкладку і відкриває панель документів кліком по «прострочено» постачальника. */
function openOverduePanel() {
  render(<SupplierPaymentScheduleTab />);
  const supplierRow = screen.getByText('Acme').closest('tr') as HTMLElement;
  fireEvent.click(within(supplierRow).getByRole('button'));
}

describe('SupplierPaymentScheduleTab — drill-down документів клітинки', () => {
  beforeEach(() => {
    docsParamsSeen.length = 0;
    scheduleData = {
      dates: [],
      suppliers: [
        { supplierId: SUPPLIER_ID, supplierName: 'Acme', overdue: 1200, byDate: {}, planned: 0 },
      ],
      totals: { overdue: 1200, byDate: {}, planned: 0, total: 1200 },
    } as unknown as SupplierPaymentSchedule;
    docsData = [
      doc({}),
      doc({
        poId: '',
        number: SYNTHETIC_NUMBER,
        totalAmount: 200,
        outstanding: 200,
        allocated: 200,
      }),
    ];
  });

  it('клік по клітинці постачальника запитує документи саме цього бакета', () => {
    openOverduePanel();
    expect(docsParamsSeen.at(-1)).toMatchObject({ supplierId: SUPPLIER_ID, target: 'overdue' });
    expect(screen.getByText('ЗАМ-1')).toBeInTheDocument();
    expect(screen.getByText(SYNTHETIC_NUMBER)).toBeInTheDocument();
  });

  // guards: BR-SUPPAY-010
  it('синтетичний рядок «борг без документа» (poId порожній) не є кнопкою і нічого не відкриває', () => {
    openOverduePanel();
    const row = screen.getByText(SYNTHETIC_NUMBER).closest('tr') as HTMLElement;

    expect(row).not.toHaveAttribute('role');
    expect(row).not.toHaveAttribute('tabindex');
    expect(row).not.toHaveAttribute('aria-label');
    expect(row.querySelector('svg')).toBeNull(); // шеврон «відкрити» лише у справжніх PO

    fireEvent.click(row);
    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(row, { key: ' ' });
    expect(screen.queryByTestId('po-modal')).not.toBeInTheDocument();
  });

  it('рядок справжнього замовлення — кнопка: клік і Enter відкривають саме це замовлення', () => {
    openOverduePanel();
    const row = screen.getByRole('button', { name: 'Відкрити замовлення ЗАМ-1' });
    expect(row).toHaveAttribute('tabindex', '0');

    fireEvent.keyDown(row, { key: 'Enter' });
    expect(screen.getByTestId('po-modal')).toHaveTextContent('po-1');
  });
});
