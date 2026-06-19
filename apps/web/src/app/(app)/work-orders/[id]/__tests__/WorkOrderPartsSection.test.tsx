// Bug #542 regression-guards for WorkOrderPartsSection sub-line render.
//
// Commit a50e1484 (sto-review 2026-06-19) додав muted sub-line під goodName що
// показує `goodInternalCode · goodSku · goodBrandName` (filter(Boolean).join).
// Раніше це поле читалось з backend toPartDto, але не рендерилось — користувач
// бачив лише name. Refactor:
//   - conditional render: only if at least one of 3 фієлдів задано
//   - separator: " · "
//   - order: internalCode → sku → brand
//
// Цей spec ловить 4 регресії якщо хтось зламає conditional/separator/order у
// наступному рефакторі (silent UX regression: TS green, тести зелені).

import { render, screen } from '@testing-library/react';
import { vi, it, expect, describe, beforeEach } from 'vitest';

import { WorkOrderPartsSection } from '../WorkOrderPartsSection';

// ─── Module mocks (mirror InvoiceSection.test.tsx setup) ─────────────────────

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn(),
  apiBlobFetch: vi.fn(),
}));

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

// WorkOrderAddPartModal завантажує важкий ланцюг (Select / SearchCombobox /
// EntityPickerField / useDirtyForm) — для регресії sub-line на partRow нам
// модал не потрібен. Стаб повертає null коли open=false (default у secції).
vi.mock('@/components/ui/WorkOrderAddPartModal', () => ({
  WorkOrderAddPartModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="add-part-modal" /> : null,
}));

vi.mock('@/components/ui/xlsx-import-button', () => ({
  XlsxImportButton: () => <button type="button">XLSX</button>,
}));

vi.mock('@/components/ui/confirm-dialog', () => ({
  ConfirmDialog: () => null,
}));

vi.mock('@/hooks/useConfirm', () => ({
  useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(false), dialogProps: {} }),
}));

// ─── Fixtures ────────────────────────────────────────────────────────────────

const WO_ID = '11111111-1111-4111-8111-111111111111';
const PART_ID_BASE = '33333333-3333-4333-8333-3333333333';

const baseWarehouses = [{ id: 'wh-1', name: 'Main', isMain: true }];

type WorkOrderPart = React.ComponentProps<typeof WorkOrderPartsSection>['parts'][number];

const makePart = (over: Partial<WorkOrderPart>, idx = 1): WorkOrderPart => ({
  id: `${PART_ID_BASE}${idx.toString().padStart(2, '0')}`,
  goodId: 'g-1',
  goodName: 'Масляний фільтр',
  warehouseId: 'wh-1',
  quantity: 1,
  price: 100,
  amount: 100,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Bug #542 — sub-line render ──────────────────────────────────────────────

describe('WorkOrderPartsSection — sub-line render (Bug #542)', () => {
  it('всі 3 поля задані → рендерить "INT-001 · SKU-1 · Toyota" з правильним separator', () => {
    const part = makePart({
      goodInternalCode: 'INT-001',
      goodSku: 'SKU-1',
      goodBrandName: 'Toyota',
    });

    render(
      <WorkOrderPartsSection
        woId={WO_ID}
        parts={[part]}
        warehouses={baseWarehouses}
        onChanged={vi.fn()}
      />,
    );

    expect(screen.getByText('INT-001 · SKU-1 · Toyota')).toBeInTheDocument();
  });

  it('лише goodBrandName → рендерить "Toyota" без зайвих separator-ів', () => {
    const part = makePart({
      goodInternalCode: null,
      goodSku: null,
      goodBrandName: 'Toyota',
    });

    render(
      <WorkOrderPartsSection
        woId={WO_ID}
        parts={[part]}
        warehouses={baseWarehouses}
        onChanged={vi.fn()}
      />,
    );

    expect(screen.getByText('Toyota')).toBeInTheDocument();
    // Не має "·" коли тільки одне значення
    expect(screen.queryByText(/·/)).not.toBeInTheDocument();
  });

  it('всі 3 поля null → sub-line взагалі не рендериться (conditional guard працює)', () => {
    const part = makePart({
      goodInternalCode: null,
      goodSku: null,
      goodBrandName: null,
    });

    const { container } = render(
      <WorkOrderPartsSection
        woId={WO_ID}
        parts={[part]}
        warehouses={baseWarehouses}
        onChanged={vi.fn()}
      />,
    );

    // Єдиний muted-text у partRow — це "1 шт × ..." (qty), sub-line має бути відсутня.
    expect(screen.queryByText(/·/)).not.toBeInTheDocument();
    // goodName рендериться
    expect(screen.getByText('Масляний фільтр')).toBeInTheDocument();
    // Sanity: row контейнер відрендерений (не плутаємо з empty-state).
    expect(container.querySelector('.divide-y')).toBeInTheDocument();
  });

  it('parts=[] → показує empty-state, без list контейнера', () => {
    render(
      <WorkOrderPartsSection
        woId={WO_ID}
        parts={[]}
        warehouses={baseWarehouses}
        onChanged={vi.fn()}
      />,
    );

    expect(screen.getByText('Запчастини не додані')).toBeInTheDocument();
  });
});
