'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useDebounce } from '@/hooks/useDebounce';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Receipt, Search, Eye, EyeOff, Pencil, Trash2 } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch, apiBlobFetch } from '@/lib/api-client';
import { getCached, setCache } from '@/lib/ref-cache';
import { useInvoices, invoicesKeys, Invoice } from '@/hooks/api/useInvoices';
import { EMPTY_ITEMS } from '@/hooks/api/usePaginatedList';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  INVOICE_STATUS_LABELS,
  INVOICE_STATUS_BADGE,
  INVOICE_STATUS_TRANSITIONS,
  INVOICE_TYPE_LABELS,
} from '@sto/shared';
import { Modal } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useConfirm } from '@/hooks/useConfirm';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { SearchCombobox } from '@/components/ui/search-combobox';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import {
  DetailPanel,
  PanelField,
  PanelSection,
  type DetailPanelTab,
} from '@/components/ui/detail-panel';
import { DetailPanelToggle } from '@/components/ui/detail-panel-toggle';
import { useDetailPanel } from '@/hooks/useDetailPanel';
import { useDetailPanelConfig } from '@/hooks/useDetailPanelConfig';
import {
  INVOICE_PANEL_SCHEMA,
  buildPanelFields,
  schemaToPanelConfigFields,
} from '@/lib/panel-schema';
import { SavedFiltersBar, SaveFilterButton } from '@/components/ui/saved-filters-bar';
import { BulkActionsBar, type BulkAction } from '@/components/ui/bulk-actions-bar';
import { useSavedFilters } from '@/hooks/useSavedFilters';
import { useBulkSelect } from '@/hooks/useBulkSelect';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useTableColumns } from '@/hooks/useTableColumns';
import { useColumnDrag } from '@/hooks/useColumnDrag';
import { ColumnsDropdown } from '@/components/ui/columns-dropdown';
import { toast } from '@/lib/toast';
import { cn, displayCounterpartyName } from '@/lib/utils';
import { fmtMoney, fmtDate } from '@/lib/format';

interface Counterparty {
  id: string;
  firstName?: string;
  lastName?: string;
  companyName?: string;
}
interface InvoiceLine {
  id: string;
  invoiceId: string;
  goodId?: string | null;
  workId?: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  vatRate: number;
  priceWithoutVat: number;
  vatAmount: number;
  priceWithVat: number;
  sortOrder: number;
  unitShortName?: string;
  coefficient?: number;
}

interface InvoiceFilters extends Record<string, unknown> {
  search: string;
  status: string;
}

// Extend Invoice from hook with optional fields used in this page
interface InvoiceWithOptionals extends Invoice {
  lines?: InvoiceLine[];
}

// Status/badge/transition/type constants imported from @sto/shared
const STATUS_LABELS = INVOICE_STATUS_LABELS;
const STATUS_BADGE = INVOICE_STATUS_BADGE;
const STATUS_TRANSITIONS = INVOICE_STATUS_TRANSITIONS;

function fmt(n: number) {
  return fmtMoney(n) + ' ₴';
}

export default function InvoicesPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST']);

  const queryClient = useQueryClient();
  const { confirm, dialogProps } = useConfirm();
  const features = useUiFeatures();
  const panelConfig = useDetailPanelConfig('invoices-panel');

  const INVOICE_COLUMNS = useMemo(
    () => [
      { key: 'number', label: 'Номер', defaultVisible: true },
      { key: 'counterparty', label: 'Контрагент', defaultVisible: true },
      { key: 'workOrder', label: 'Наряд', defaultVisible: true },
      { key: 'status', label: 'Статус', defaultVisible: true },
      { key: 'amount', label: 'Сума', defaultVisible: true },
      { key: 'dueDate', label: 'Термін оплати', defaultVisible: true },
    ],
    [],
  );

  const {
    visibleKeys: colVisible,
    visibleColumns,
    orderedColumns,
    order,
    customLabels,
    toggle: toggleCol,
    reorder,
    renameColumn,
    resetConfig,
  } = useTableColumns('invoices', INVOICE_COLUMNS);
  const { dragProps } = useColumnDrag(visibleColumns, reorder, orderedColumns);
  const detailPanel = useDetailPanel('invoices');

  // Local filter & pagination state
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search);
  const [error, setError] = useState('');
  const [showDeleted, setShowDeleted] = useState(false);

  // React Query hooks
  const limit = 20;
  const {
    data: queryData,
    isLoading: loading,
    error: queryError,
  } = useInvoices({
    page,
    limit,
    status,
    q: debouncedSearch,
    showDeleted,
  });
  // Bug #328 regression guard — stable empty array reference.
  const invoices = queryData?.items ?? (EMPTY_ITEMS as unknown as Invoice[]);
  const total = queryData?.total ?? 0;

  const [selectedInv, setSelectedInv] = useState<InvoiceWithOptionals | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [showPayment, setShowPayment] = useState<InvoiceWithOptionals | null>(null);

  const [payMethods, setPayMethods] = useState<{ code: string; name: string }[]>([]);
  const [form, setForm] = useState({ counterpartyId: '', amount: '', dueDate: '' });
  const [counterpartyDisplayName, setCounterpartyDisplayName] = useState('');
  const [payForm, setPayForm] = useState({ method: 'cash', amount: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  // Saved filters
  const [activeSavedFilterId, setActiveSavedFilterId] = useState<string | null>(null);
  const {
    saved: savedFilters,
    save: saveFilter,
    remove: removeFilter,
  } = useSavedFilters<InvoiceFilters>('invoices');

  const applyFilter = useCallback((preset: { id: string; filters: InvoiceFilters }) => {
    setSearch(preset.filters.search ?? '');
    setStatus(preset.filters.status ?? '');
    setPage(1);
    setActiveSavedFilterId(preset.id);
  }, []);

  const handleSaveFilter = useCallback(
    (name: string) => {
      const preset = saveFilter(name, { search, status });
      setActiveSavedFilterId(preset.id);
      if (features.toastEnabled) toast.success(`Фільтр "${name}" збережено`);
    },
    [saveFilter, search, status, features.toastEnabled],
  );

  // Bulk select
  const bulkSelect = useBulkSelect(invoices);

  const selectAllRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = bulkSelect.someSelected;
  }, [bulkSelect.someSelected]);

  const bulkCancel = useCallback(
    async (ids: string[]) => {
      const results = await Promise.allSettled(
        ids.map(id =>
          apiFetch(`/invoices/${id}/transition`, {
            method: 'POST',
            body: JSON.stringify({ status: 'CANCELLED' }),
          }),
        ),
      );
      const succeeded = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.length - succeeded;
      bulkSelect.clear();
      queryClient.invalidateQueries({ queryKey: invoicesKeys.all });
      if (features.toastEnabled) {
        if (succeeded > 0 && failed === 0) {
          toast.success(`Скасовано ${succeeded} ${succeeded === 1 ? 'рахунок' : 'рахунків'}`);
        } else if (succeeded > 0 && failed > 0) {
          toast.warning(
            `Скасовано ${succeeded} з ${results.length}. ${failed} не змінено (статус не дозволяє)`,
          );
        } else {
          toast.error('Жоден рахунок не скасовано (статус не дозволяє)');
        }
      } else if (failed > 0) {
        setError(`${succeeded} з ${results.length} рахунків змінено, ${failed} не вдалось`);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [bulkSelect, features.toastEnabled, queryClient],
  );

  const bulkActions = useMemo<BulkAction[]>(
    () => [
      { id: 'cancel', label: 'Скасувати вибрані', variant: 'destructive', onClick: bulkCancel },
    ],
    [bulkCancel],
  );

  // Unsaved guard for create modal
  const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });

  useEffect(() => {
    if (!showPayment) return;
    let cancelled = false;
    // Reference data — paint instantly from sessionStorage, refresh in background.
    const cached = getCached<{ code: string; name: string }[]>('cache:payment-methods');
    if (cached) setPayMethods(cached);
    apiFetch<{ code: string; name: string; isActive: boolean }[]>('/payment-methods')
      .then(d => {
        const active = d.filter(m => m.isActive).map(m => ({ code: m.code, name: m.name }));
        setCache('cache:payment-methods', active);
        if (!cancelled) setPayMethods(active);
      })
      .catch((e: unknown) => {
        if (!cancelled && !cached) {
          setError(e instanceof Error ? e.message : 'Помилка завантаження способів оплати');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [showPayment]);

  // Bug #143: async-init Select race condition. payForm.method defaults to 'cash'
  // and the payment modal can open BEFORE /payment-methods resolves. If 'cash' is
  // deactivated (admin can disable it via PaymentMethodConfig), the loaded list
  // won't contain it — the Select visually jumps to the first active method
  // while state still holds 'cash'. POST /payments would then submit an inactive
  // method code. Sync payForm.method to payMethods[0].code when the current
  // value is missing from the loaded list.
  // payForm.method excluded from deps intentionally: we only need to sync when
  // payMethods or showPayment changes, not on every keystroke in the form.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!showPayment || payMethods.length === 0) return;
    setPayForm(f =>
      payMethods.some(m => m.code === f.method) ? f : { ...f, method: payMethods[0].code },
    );
  }, [payMethods, showPayment]);

  const handleCreate = async () => {
    const amt = parseFloat(form.amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError('Введіть коректну суму');
      return;
    }
    setSaving(true);
    try {
      await apiFetch<Invoice>('/invoices', {
        method: 'POST',
        body: JSON.stringify({
          counterpartyId: form.counterpartyId,
          amount: amt,
          dueDate: form.dueDate || undefined,
        }),
      });
      dirty.resetDirty();
      setShowCreate(false);
      setForm({ counterpartyId: '', amount: '', dueDate: '' });
      setCounterpartyDisplayName('');
      queryClient.invalidateQueries({ queryKey: invoicesKeys.all });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка збереження');
    } finally {
      setSaving(false);
    }
  };

  const handleTransition = async (inv: InvoiceWithOptionals, newStatus: string) => {
    if (
      !(await confirm({ title: `Перевести рахунок ${inv.number} → ${STATUS_LABELS[newStatus]}?` }))
    )
      return;
    setSavingId(inv.id);
    setError('');
    try {
      await apiFetch<void>(`/invoices/${inv.id}/transition`, {
        method: 'POST',
        body: JSON.stringify({ status: newStatus }),
      });
      // Sync selectedInv if it still matches the transitioned invoice.
      // Check via functional setter to avoid stale-closure: panel could be
      // switched to another row between click and response — without this guard
      // the new selectedInv would get the wrong status applied.
      setSelectedInv(prev => (prev && prev.id === inv.id ? { ...prev, status: newStatus } : prev));
      queryClient.invalidateQueries({ queryKey: invoicesKeys.all });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка зміни статусу');
    } finally {
      setSavingId(null);
    }
  };

  const handlePay = async () => {
    if (!showPayment) return;
    const rawAmt = parseFloat(payForm.amount);
    const amt = !payForm.amount || !Number.isFinite(rawAmt) ? showPayment.amount : rawAmt;
    setSaving(true);
    try {
      await apiFetch<{ id: string }>('/payments', {
        method: 'POST',
        body: JSON.stringify({
          counterpartyId: showPayment.counterpartyId,
          invoiceId: showPayment.id,
          amount: amt,
          method: payForm.method,
          notes: payForm.notes || undefined,
        }),
      });
      const paidInvoiceId = showPayment.id;
      setShowPayment(null);
      setPayForm({ method: 'cash', amount: '', notes: '' });
      // PaymentsService transitions invoice → PAID on payment creation.
      // Reflect that immediately in the open DetailPanel so the user does not
      // see a stale SENT status with an «Оплатити» button that would 400 on click.
      setSelectedInv(prev =>
        prev && prev.id === paidInvoiceId ? { ...prev, status: 'PAID' } : prev,
      );
      queryClient.invalidateQueries({ queryKey: invoicesKeys.all });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка оплати');
    } finally {
      setSaving(false);
    }
  };

  const selectInvoice = useCallback(async (inv: InvoiceWithOptionals) => {
    setSelectedInv(inv);
    try {
      const detail = await apiFetch<InvoiceWithOptionals>(`/invoices/${inv.id}`);
      setSelectedInv(detail);
    } catch {
      // keep basic inv data if detail fetch fails
    }
  }, []);

  const [cloning, setCloning] = useState(false);

  const downloadPdf = async (inv: InvoiceWithOptionals) => {
    // Bug #77: use apiBlobFetch which does silent refresh on 401 — direct fetch
    // breaks when access token expired (~15min) requiring full page reload.
    setError('');
    try {
      const blob = await apiBlobFetch(`/invoices/${inv.id}/pdf`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `invoice-${inv.number}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Defer revoke — Chromium can drop the download if revoke fires before the browser starts reading.
      setTimeout(() => URL.revokeObjectURL(url), 100);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка завантаження PDF');
    }
  };

  const handleClone = async (inv: InvoiceWithOptionals) => {
    setCloning(true);
    setError('');
    try {
      const cloned = await apiFetch<{ id: string }>(`/invoices/${inv.id}/clone`, {
        method: 'POST',
      });
      // Reload data to show cloned invoice
      queryClient.invalidateQueries({ queryKey: invoicesKeys.all });
      // Select and show the cloned invoice - fetch it first
      const clonedInvoice = await apiFetch<InvoiceWithOptionals>(`/invoices/${cloned.id}`);
      selectInvoice(clonedInvoice);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка дублювання');
    } finally {
      setCloning(false);
    }
  };

  const markDeleted = async (inv: InvoiceWithOptionals) => {
    if (
      !(await confirm({
        title: `Позначити рахунок ${inv.number} на видалення?`,
        variant: 'destructive',
      }))
    )
      return;
    try {
      await apiFetch(`/invoices/${inv.id}`, { method: 'DELETE' });
      if (selectedInv?.id === inv.id) setSelectedInv(null);
      queryClient.invalidateQueries({ queryKey: invoicesKeys.all });
      toast.success('Рахунок позначено на видалення');
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Помилка видалення');
    }
  };

  const statuses = ['', 'DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED'];

  const buildInvoiceTabs = (inv: InvoiceWithOptionals): DetailPanelTab[] => [
    {
      key: 'info',
      label: 'Основне',
      content: (
        <div className="space-y-3">
          {/* Schema-driven fields — order + visibility from useDetailPanelConfig */}
          {buildPanelFields(inv, INVOICE_PANEL_SCHEMA, panelConfig.config, {
            status: v => (
              <Badge variant={STATUS_BADGE[String(v)] ?? 'secondary'}>
                {STATUS_LABELS[String(v)]}
              </Badge>
            ),
            invoiceType: v => (v ? (INVOICE_TYPE_LABELS[String(v)] ?? String(v)) : undefined),
            // Bug #274: hide zero VAT breakdown rows
            totalWithoutVat: v =>
              v != null && Number(v) > 0 ? `${fmtMoney(Number(v))} ₴` : undefined,
            totalVat: v => (v != null && Number(v) !== 0 ? `${fmtMoney(Number(v))} ₴` : undefined),
            totalWithVat: (v, r) =>
              v != null && Number(v) > 0 && Number(v) !== r.amount
                ? `${fmtMoney(Number(v))} ₴`
                : undefined,
          }).map(f => (
            <PanelField
              key={f.key}
              fieldKey={f.key}
              label={f.label}
              value={f.value}
              hidden={f.hidden}
            />
          ))}
          <PanelSection title="Дії">
            <div className="flex flex-col gap-2">
              {STATUS_TRANSITIONS[inv.status]?.map(s => (
                <Button
                  key={s}
                  variant={s === 'CANCELLED' ? 'destructive' : s === 'PAID' ? 'default' : 'outline'}
                  size="sm"
                  className="w-full"
                  onClick={() => (s === 'PAID' ? setShowPayment(inv) : handleTransition(inv, s))}
                  loading={savingId === inv.id}
                >
                  {s === 'SENT' ? 'Надіслати' : s === 'PAID' ? 'Оплатити' : 'Скасувати'}
                </Button>
              ))}
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => void downloadPdf(inv)}
              >
                Завантажити PDF
              </Button>
              <Button variant="outline" size="sm" className="w-full" onClick={() => window.print()}>
                Друк
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => void handleClone(inv)}
                loading={cloning}
                disabled={cloning}
              >
                Дублювати
              </Button>
            </div>
          </PanelSection>
        </div>
      ),
    },
    {
      key: 'lines',
      label: 'Позиції',
      content:
        !inv.lines || inv.lines.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">Немає позицій</p>
        ) : (
          <div className="space-y-2">
            {inv.lines.map((line, i) => (
              <div
                key={line.id ?? i}
                className="rounded-lg border border-border px-3 py-2 text-[13px]"
              >
                <p className="font-medium text-foreground">{line.description}</p>
                <p className="text-muted-foreground text-[12px] mt-0.5">
                  {line.quantity} {line.unitShortName ?? ''} × {fmtMoney(line.unitPrice)} ₴{' = '}
                  <span className="text-foreground font-medium">
                    {fmtMoney(line.priceWithVat)} ₴
                  </span>
                </p>
                {line.vatRate > 0 && (
                  <p className="text-muted-foreground text-[11px] mt-0.5">
                    Без ПДВ: {fmtMoney(line.priceWithoutVat)} ₴ · ПДВ {line.vatRate}%:{' '}
                    {fmtMoney(line.vatAmount)} ₴
                  </p>
                )}
              </div>
            ))}
          </div>
        ),
    },
  ];

  return (
    <div className="page-fill p-4 md:p-6 gap-4">
      {(error || queryError) && (
        <div className="mb-4 text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">
          {error || (queryError instanceof Error ? queryError.message : '')}
        </div>
      )}
      <div className="page-header">
        <div>
          <h1 className="page-title">Рахунки</h1>
          <p className="page-subtitle">{total} рахунків</p>
        </div>
      </div>

      {/* Saved filters */}
      {features.savedFiltersEnabled && (
        <SavedFiltersBar<InvoiceFilters>
          saved={savedFilters}
          activeId={activeSavedFilterId}
          onApply={applyFilter}
          onSave={handleSaveFilter}
          onRemove={removeFilter}
          className="mb-3"
          hideSaveButton
        />
      )}

      {/* Status filters */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {statuses.map(s => (
          <button
            key={s}
            onClick={() => {
              setStatus(s);
              setPage(1);
              setActiveSavedFilterId(null);
            }}
            className={cn(
              'px-3 py-1 rounded-full text-sm font-medium border transition-colors',
              status === s
                ? 'bg-primary text-primary-foreground border-primary'
                : 'border-border text-muted-foreground bg-surface hover:bg-secondary',
            )}
          >
            {s ? STATUS_LABELS[s] : 'Всі'}
          </button>
        ))}
      </div>

      {/* Search + Columns */}
      <div className="mb-3 flex items-center gap-3">
        <Input
          value={search}
          onChange={e => {
            setSearch(e.target.value);
            setPage(1);
            setActiveSavedFilterId(null);
          }}
          placeholder="Пошук за номером або контрагентом..."
          leftElement={<Search />}
          className="w-72"
        />
        <div className="flex items-center gap-2 ml-auto">
          <Button
            variant="outline"
            size="icon-sm"
            title={showDeleted ? 'Сховати видалені' : 'Показати видалені'}
            onClick={() => {
              setShowDeleted(d => !d);
              setPage(1);
            }}
            className={showDeleted ? 'border-primary text-primary' : ''}
          >
            {showDeleted ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </Button>
          {features.savedFiltersEnabled && <SaveFilterButton onSave={handleSaveFilter} />}
          <ColumnsDropdown
            columns={orderedColumns}
            visibleKeys={colVisible}
            onToggle={toggleCol}
            onReorder={reorder}
            onRename={renameColumn}
            onReset={resetConfig}
            hasCustomization={
              JSON.stringify(order) !== JSON.stringify(INVOICE_COLUMNS.map(c => c.key)) ||
              Object.keys(customLabels).length > 0
            }
          />
          <DetailPanelToggle enabled={detailPanel.enabled} onToggle={detailPanel.toggle} />
          <Button onClick={() => setShowCreate(true)} leftIcon={<Plus className="h-4 w-4" />}>
            Рахунок
          </Button>
        </div>
      </div>

      {/* Bulk actions */}
      {features.bulkActionsEnabled && bulkSelect.count > 0 && (
        <BulkActionsBar
          count={bulkSelect.count}
          selectedIds={Array.from(bulkSelect.selected)}
          actions={bulkActions}
          onClear={bulkSelect.clear}
          className="mb-3"
        />
      )}

      {/* Table + DetailPanel */}
      <div className="flex">
        <div className="flex-1 min-h-0 min-w-0 overflow-auto bg-surface rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                {features.bulkActionsEnabled && (
                  <TableHead className="w-9 pr-0">
                    <input
                      type="checkbox"
                      checked={bulkSelect.allSelected}
                      ref={selectAllRef}
                      onChange={bulkSelect.toggleAll}
                      className="h-3.5 w-3.5 rounded border-border"
                      aria-label="Вибрати всі"
                    />
                  </TableHead>
                )}
                {visibleColumns.map(col =>
                  col.key === 'amount' ? (
                    <TableHead key={col.key} className="text-right" {...dragProps(col.key)}>
                      {col.label}
                    </TableHead>
                  ) : (
                    <TableHead key={col.key} {...dragProps(col.key)}>
                      {col.label}
                    </TableHead>
                  ),
                )}
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell
                    colSpan={visibleColumns.length + (features.bulkActionsEnabled ? 2 : 1)}
                    className="py-10 text-center"
                  >
                    <div className="flex justify-center">
                      <Spinner size="md" />
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {!loading && invoices.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={visibleColumns.length + (features.bulkActionsEnabled ? 2 : 1)}
                    className="p-0"
                  >
                    <EmptyState icon={Receipt} title="Рахунків не знайдено" />
                  </TableCell>
                </TableRow>
              )}
              {!loading &&
                invoices.map(inv => (
                  <TableRow
                    key={inv.id}
                    onClick={() => {
                      if (detailPanel.enabled) selectInvoice(inv);
                    }}
                    className={cn(
                      'group transition-colors',
                      detailPanel.enabled && 'cursor-pointer',
                      inv.deletedAt && 'opacity-60',
                      selectedInv?.id === inv.id && detailPanel.enabled && 'bg-primary/5',
                      bulkSelect.isSelected(inv.id) && 'bg-primary/5',
                    )}
                  >
                    {features.bulkActionsEnabled && (
                      <TableCell className="w-9 pr-0" onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={bulkSelect.isSelected(inv.id)}
                          onChange={() => bulkSelect.toggle(inv.id)}
                          className="h-3.5 w-3.5 rounded border-border"
                          aria-label={`Вибрати рахунок ${inv.number}`}
                        />
                      </TableCell>
                    )}
                    {visibleColumns.map(col => {
                      if (col.key === 'number')
                        return (
                          <TableCell key="number" className="font-medium text-[13px]">
                            {inv.number}
                          </TableCell>
                        );
                      if (col.key === 'counterparty')
                        return (
                          <TableCell key="counterparty" className="text-[13px]">
                            {inv.counterpartyName ?? '—'}
                          </TableCell>
                        );
                      if (col.key === 'workOrder')
                        return (
                          <TableCell key="workOrder" className="text-[13px] text-muted-foreground">
                            {(inv as InvoiceWithOptionals).workOrderNumber ?? '—'}
                          </TableCell>
                        );
                      if (col.key === 'status')
                        return (
                          <TableCell key="status">
                            <Badge variant={STATUS_BADGE[inv.status] ?? 'secondary'}>
                              {STATUS_LABELS[inv.status]}
                            </Badge>
                          </TableCell>
                        );
                      if (col.key === 'amount')
                        return (
                          <TableCell key="amount" className="text-right font-semibold text-[13px]">
                            {fmt(inv.amount)}
                          </TableCell>
                        );
                      if (col.key === 'dueDate')
                        return (
                          <TableCell key="dueDate" className="text-[13px] text-muted-foreground">
                            {inv.dueDate ? fmtDate(inv.dueDate) : '—'}
                          </TableCell>
                        );
                      return null;
                    })}
                    <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="Відкрити деталі"
                          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                          onClick={() => selectInvoice(inv)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        {!inv.deletedAt && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            title="Позначити на видалення"
                            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                            onClick={() => void markDeleted(inv)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </div>

        <DetailPanel
          open={!!selectedInv && detailPanel.enabled}
          onClose={() => setSelectedInv(null)}
          title={selectedInv?.number ?? ''}
          subtitle={selectedInv?.counterpartyName}
          tabs={selectedInv ? buildInvoiceTabs(selectedInv) : undefined}
          configFields={schemaToPanelConfigFields(INVOICE_PANEL_SCHEMA, panelConfig.config)}
          onToggleField={panelConfig.toggleField}
          onReorderFields={panelConfig.reorderFields}
          onReset={panelConfig.reset}
        />
      </div>

      {/* Pagination */}
      {total > limit && (
        <div className="shrink-0 flex justify-center gap-1.5 pt-1">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 1}
            onClick={() => setPage(p => p - 1)}
          >
            ← Назад
          </Button>
          <span className="h-8 w-8 flex items-center justify-center text-sm text-muted-foreground">
            {page}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page * limit >= total}
            onClick={() => setPage(p => p + 1)}
          >
            Вперед →
          </Button>
        </div>
      )}

      {/* Create modal */}
      <Modal
        open={showCreate}
        onClose={async () => {
          if (!(await dirty.confirmClose())) return;
          dirty.resetDirty();
          setShowCreate(false);
          setForm({ counterpartyId: '', amount: '', dueDate: '' });
          setCounterpartyDisplayName('');
        }}
        title="Новий рахунок"
        footer={
          <Button
            onClick={handleCreate}
            loading={saving}
            disabled={!form.counterpartyId || !form.amount}
            className="w-full"
          >
            Створити рахунок
          </Button>
        }
      >
        <div className="space-y-4">
          <SearchCombobox<Counterparty>
            label="Контрагент"
            required
            placeholder="Ім'я, телефон, держ. номер авто..."
            value={form.counterpartyId}
            displayValue={counterpartyDisplayName}
            onSelect={c => {
              // Bug #139: helper повертає '(без імені)' fallback замість порожнього рядка.
              setCounterpartyDisplayName(displayCounterpartyName(c));
              setForm(f => ({ ...f, counterpartyId: c.id }));
              dirty.markDirty();
            }}
            onClear={() => {
              setCounterpartyDisplayName('');
              setForm(f => ({ ...f, counterpartyId: '' }));
              dirty.markDirty();
            }}
            fetchItems={q =>
              apiFetch<{ items: Counterparty[] }>(
                `/counterparties?q=${encodeURIComponent(q)}&limit=10`,
              ).then(r =>
                r.items.map(c => ({
                  ...c,
                  primary: displayCounterpartyName(c),
                })),
              )
            }
          />
          <Input
            label="Сума, ₴"
            required
            type="number"
            min="0.01"
            value={form.amount}
            onChange={e => {
              setForm(f => ({ ...f, amount: e.target.value }));
              dirty.markDirty();
            }}
            step="0.01"
            placeholder="0.00"
          />
          <DatePickerInput
            label="Термін оплати"
            value={form.dueDate}
            onChange={v => {
              setForm(f => ({ ...f, dueDate: v }));
              dirty.markDirty();
            }}
          />
        </div>
      </Modal>

      {/* Payment modal */}
      <Modal
        open={!!showPayment}
        onClose={() => setShowPayment(null)}
        title={showPayment ? `Реєстрація оплати по рахунку ${showPayment.number}` : ''}
        footer={
          <Button onClick={handlePay} loading={saving} className="w-full">
            Підтвердити оплату
          </Button>
        }
      >
        {showPayment && (
          <div className="space-y-4">
            <div className="p-3 bg-info-subtle rounded-lg text-sm text-info-text">
              Сума до оплати: <strong>{fmt(showPayment.amount)}</strong>
            </div>
            <Select
              label="Метод оплати"
              required
              value={payForm.method}
              onChange={e => setPayForm(f => ({ ...f, method: e.target.value }))}
            >
              {payMethods.length > 0 ? (
                payMethods.map(m => (
                  <option key={m.code} value={m.code}>
                    {m.name}
                  </option>
                ))
              ) : (
                <>
                  <option value="cash">Готівка</option>
                  <option value="card_terminal">Термінал</option>
                  <option value="bank_transfer">Банківський переказ</option>
                </>
              )}
            </Select>
            <Input
              label="Сума, ₴"
              type="number"
              value={payForm.amount}
              onChange={e => setPayForm(f => ({ ...f, amount: e.target.value }))}
              placeholder={String(showPayment.amount)}
              min="0.01"
              step="0.01"
            />
            <Input
              label="Примітки"
              value={payForm.notes}
              onChange={e => setPayForm(f => ({ ...f, notes: e.target.value }))}
            />
          </div>
        )}
      </Modal>
      <DirtyConfirmDialog {...dirty.dialogProps} />
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
