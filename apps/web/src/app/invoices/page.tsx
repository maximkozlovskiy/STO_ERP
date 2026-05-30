'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useDebounce } from '@/hooks/useDebounce';
import { Plus, Receipt, Search } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch, apiBlobFetch } from '@/lib/api-client';
import { getCached, setCache } from '@/lib/ref-cache';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
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
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';
import { DetailPanel, PanelField, PanelSection, type DetailPanelTab } from '@/components/ui/detail-panel';
import { DetailPanelToggle } from '@/components/ui/detail-panel-toggle';
import { useDetailPanel } from '@/hooks/useDetailPanel';
import { SavedFiltersBar, SaveFilterButton } from '@/components/ui/saved-filters-bar';
import { BulkActionsBar, type BulkAction } from '@/components/ui/bulk-actions-bar';
import { useSavedFilters } from '@/hooks/useSavedFilters';
import { useBulkSelect } from '@/hooks/useBulkSelect';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useTableColumns } from '@/hooks/useTableColumns';
import { ColumnsDropdown } from '@/components/ui/columns-dropdown';
import { toast } from '@/lib/toast';
import { cn, displayCounterpartyName } from '@/lib/utils';

interface Counterparty { id: string; firstName?: string; lastName?: string; companyName?: string; }
interface InvoiceLine {
  id: string; invoiceId: string; goodId?: string | null; workId?: string | null;
  description: string; quantity: number; unitPrice: number; vatRate: number;
  priceWithoutVat: number; vatAmount: number; priceWithVat: number; sortOrder: number;
}
interface Invoice {
  id: string; number: string; status: string;
  counterpartyId: string; counterpartyName?: string;
  workOrderId?: string | null; workOrderNumber?: string | null;
  amount: number;
  totalWithoutVat?: number; totalVat?: number; totalWithVat?: number;
  paidAmount?: number;
  invoiceType?: string; notes?: string | null;
  dueDate?: string | null;
  lines?: InvoiceLine[];
  createdAt: string; updatedAt: string;
}
interface Paginated { items: Invoice[]; total: number; page: number; limit: number; }

interface InvoiceFilters extends Record<string, unknown> {
  search: string;
  status: string;
}

const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Чернетка', SENT: 'Надіслано', PAID: 'Оплачено',
  OVERDUE: 'Прострочено', CANCELLED: 'Скасовано',
};
const STATUS_BADGE: Record<string, BadgeVariant> = {
  DRAFT: 'secondary', SENT: 'default', PAID: 'success',
  OVERDUE: 'warning', CANCELLED: 'destructive',
};
const STATUS_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['SENT', 'CANCELLED'], SENT: ['PAID', 'CANCELLED'],
  OVERDUE: ['PAID', 'CANCELLED'], PAID: [], CANCELLED: [],
};

const INVOICE_TYPE_LABELS: Record<string, string> = {
  STANDARD: 'Стандартний', PREPAYMENT: 'Аванс', CREDIT_NOTE: 'Кредит-нота',
};

function fmt(n: number) {
  return n.toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₴';
}

export default function InvoicesPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'ACCOUNTANT', 'RECEPTIONIST']);

  const { confirm, dialogProps } = useConfirm();
  const features = useUiFeatures();

  const INVOICE_COLUMNS = useMemo(() => [
    { key: 'number', label: 'Номер', defaultVisible: true },
    { key: 'counterparty', label: 'Контрагент', defaultVisible: true },
    { key: 'workOrder', label: 'Наряд', defaultVisible: true },
    { key: 'status', label: 'Статус', defaultVisible: true },
    { key: 'amount', label: 'Сума', defaultVisible: true },
    { key: 'dueDate', label: 'Термін оплати', defaultVisible: true },
  ], []);

  const { visibleKeys: colVisible, visibleColumns, orderedColumns, order, customLabels, toggle: toggleCol, reorder, renameColumn, resetConfig } = useTableColumns('invoices', INVOICE_COLUMNS);
  const detailPanel = useDetailPanel('invoices');
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [selectedInv, setSelectedInv] = useState<Invoice | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [showPayment, setShowPayment] = useState<Invoice | null>(null);

  const [payMethods, setPayMethods] = useState<{ code: string; name: string }[]>([]);
  const [form, setForm] = useState({ counterpartyId: '', amount: '', dueDate: '' });
  const [counterpartyDisplayName, setCounterpartyDisplayName] = useState('');
  const [payForm, setPayForm] = useState({ method: 'cash', amount: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  // Saved filters
  const [activeSavedFilterId, setActiveSavedFilterId] = useState<string | null>(null);
  const { saved: savedFilters, save: saveFilter, remove: removeFilter } = useSavedFilters<InvoiceFilters>('invoices');

  const applyFilter = useCallback((preset: { id: string; filters: InvoiceFilters }) => {
    setSearch(preset.filters.search ?? '');
    setStatus(preset.filters.status ?? '');
    setPage(1);
    setActiveSavedFilterId(preset.id);
  }, []);

  const handleSaveFilter = useCallback((name: string) => {
    const preset = saveFilter(name, { search, status });
    setActiveSavedFilterId(preset.id);
    if (features.toastEnabled) toast.success(`Фільтр "${name}" збережено`);
  }, [saveFilter, search, status, features.toastEnabled]);

  // Bulk select
  const [data, setData] = useState<Paginated | null>(null);
  const bulkSelect = useBulkSelect(data?.items ?? []);

  const selectAllRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = bulkSelect.someSelected;
  }, [bulkSelect.someSelected]);

  const bulkCancel = useCallback(async (ids: string[]) => {
    const results = await Promise.allSettled(
      ids.map(id => apiFetch(`/invoices/${id}/transition`, {
        method: 'POST',
        body: JSON.stringify({ status: 'CANCELLED' }),
      })),
    );
    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.length - succeeded;
    bulkSelect.clear();
    load();
    if (features.toastEnabled) {
      if (succeeded > 0 && failed === 0) {
        toast.success(`Скасовано ${succeeded} ${succeeded === 1 ? 'рахунок' : 'рахунків'}`);
      } else if (succeeded > 0 && failed > 0) {
        toast.warning(`Скасовано ${succeeded} з ${results.length}. ${failed} не змінено (статус не дозволяє)`);
      } else {
        toast.error('Жоден рахунок не скасовано (статус не дозволяє)');
      }
    } else if (failed > 0) {
      setError(`${succeeded} з ${results.length} рахунків змінено, ${failed} не вдалось`);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulkSelect, features.toastEnabled]);

  const bulkActions = useMemo<BulkAction[]>(() => [
    { id: 'cancel', label: 'Скасувати вибрані', variant: 'destructive', onClick: bulkCancel },
  ], [bulkCancel]);

  // Unsaved guard for create modal
  const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });

  const limit = 20;

  const mountedRef = useRef(true);
  const selectTokenRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (status) params.set('status', status);
      if (debouncedSearch) params.set('q', debouncedSearch);
      const result = await apiFetch<Paginated>(`/invoices?${params}`);
      if (!mountedRef.current) return;
      setData(result);
      setInvoices(result.items);
      setTotal(result.total);
    } catch (e: unknown) {
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e.message : 'Помилка завантаження');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [page, status, debouncedSearch]);

  useEffect(() => { load(); }, [load]);


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
        if (!cancelled && mountedRef.current) setPayMethods(active);
      })
      .catch((e: unknown) => {
        if (!cancelled && mountedRef.current && !cached) {
          setError(e instanceof Error ? e.message : 'Помилка завантаження способів оплати');
        }
      });
    return () => { cancelled = true; };
  }, [showPayment]);

  // Bug #143: async-init Select race condition. payForm.method defaults to 'cash'
  // and the payment modal can open BEFORE /payment-methods resolves. If 'cash' is
  // deactivated (admin can disable it via PaymentMethodConfig), the loaded list
  // won't contain it — the Select visually jumps to the first active method
  // while state still holds 'cash'. POST /payments would then submit an inactive
  // method code. Sync payForm.method to payMethods[0].code when the current
  // value is missing from the loaded list.
  useEffect(() => {
    if (!showPayment || payMethods.length === 0) return;
    if (!payMethods.some(m => m.code === payForm.method)) {
      setPayForm(f => ({ ...f, method: payMethods[0].code }));
    }
  }, [payMethods, showPayment, payForm.method]);

  const handleCreate = async () => {
    const amt = parseFloat(form.amount);
    if (!Number.isFinite(amt) || amt <= 0) { setError('Введіть коректну суму'); return; }
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
      if (!mountedRef.current) return;
      dirty.resetDirty();
      setShowCreate(false);
      setForm({ counterpartyId: '', amount: '', dueDate: '' });
      setCounterpartyDisplayName('');
      load();
    } catch (e: unknown) {
      if (mountedRef.current) setError(e instanceof Error ? e.message : 'Помилка збереження');
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  const handleTransition = async (inv: Invoice, newStatus: string) => {
    if (!(await confirm({ title: `Перевести рахунок ${inv.number} → ${STATUS_LABELS[newStatus]}?` }))) return;
    setSavingId(inv.id);
    setError('');
    try {
      await apiFetch<void>(`/invoices/${inv.id}/transition`, {
        method: 'POST', body: JSON.stringify({ status: newStatus }),
      });
      if (!mountedRef.current) return;
      // Sync selectedInv if it still matches the transitioned invoice.
      // Check via functional setter to avoid stale-closure: panel could be
      // switched to another row between click and response — without this guard
      // the new selectedInv would get the wrong status applied.
      setSelectedInv(prev => prev && prev.id === inv.id ? { ...prev, status: newStatus } : prev);
      load();
    } catch (e: unknown) {
      if (mountedRef.current) setError(e instanceof Error ? e.message : 'Помилка зміни статусу');
    } finally {
      if (mountedRef.current) setSavingId(null);
    }
  };

  const handlePay = async () => {
    if (!showPayment) return;
    const rawAmt = parseFloat(payForm.amount);
    const amt = (!payForm.amount || !Number.isFinite(rawAmt)) ? showPayment.amount : rawAmt;
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
      if (!mountedRef.current) return;
      const paidInvoiceId = showPayment.id;
      setShowPayment(null);
      setPayForm({ method: 'cash', amount: '', notes: '' });
      // PaymentsService transitions invoice → PAID on payment creation.
      // Reflect that immediately in the open DetailPanel so the user does not
      // see a stale SENT status with an «Оплатити» button that would 400 on click.
      setSelectedInv(prev => prev && prev.id === paidInvoiceId ? { ...prev, status: 'PAID' } : prev);
      load();
    } catch (e: unknown) {
      if (mountedRef.current) setError(e instanceof Error ? e.message : 'Помилка оплати');
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  const selectInvoice = useCallback(async (inv: Invoice) => {
    const token = ++selectTokenRef.current;
    setSelectedInv(inv);
    try {
      const detail = await apiFetch<Invoice>(`/invoices/${inv.id}`);
      // Discard stale response if another row was clicked or unmounted
      if (!mountedRef.current || token !== selectTokenRef.current) return;
      setSelectedInv(detail);
    } catch {
      // keep basic inv data if detail fetch fails
    }
  }, []);

  const [cloning, setCloning] = useState(false);

  const downloadPdf = async (inv: Invoice) => {
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

  const handleClone = async (inv: Invoice) => {
    setCloning(true);
    setError('');
    try {
      const cloned = await apiFetch<{ id: string }>(`/invoices/${inv.id}/clone`, { method: 'POST' });
      // Reload data to show cloned invoice
      load();
      // Select and show the cloned invoice - fetch it first
      const clonedInvoice = await apiFetch<Invoice>(`/invoices/${cloned.id}`);
      selectInvoice(clonedInvoice);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка дублювання');
    } finally {
      setCloning(false);
    }
  };

  const statuses = ['', 'DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED'];

  const buildInvoiceTabs = (inv: Invoice): DetailPanelTab[] => [
    {
      key: 'info',
      label: 'Основне',
      content: (
        <div className="space-y-3">
          <PanelField label="Статус" value={<Badge variant={STATUS_BADGE[inv.status] ?? 'secondary'}>{STATUS_LABELS[inv.status]}</Badge>} />
          <PanelField label="Контрагент" value={inv.counterpartyName} />
          <PanelField label="Наряд" value={inv.workOrderNumber} />
          <PanelField label="Тип" value={inv.invoiceType ? INVOICE_TYPE_LABELS[inv.invoiceType] : undefined} />
          <PanelField label="Сума" value={inv.amount != null ? `${inv.amount.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴` : undefined} />
          <PanelField label="Сплачено" value={inv.paidAmount != null ? `${inv.paidAmount.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴` : undefined} />
          <PanelField label="Термін оплати" value={inv.dueDate ? new Date(inv.dueDate).toLocaleDateString('uk-UA') : undefined} />
          {inv.notes && <PanelField label="Нотатки" value={inv.notes} />}
          <PanelSection title="Дії">
            <div className="flex flex-col gap-2">
              {STATUS_TRANSITIONS[inv.status]?.map(s => (
                <Button
                  key={s}
                  variant={s === 'CANCELLED' ? 'destructive' : s === 'PAID' ? 'default' : 'outline'}
                  size="sm"
                  className="w-full"
                  onClick={() => s === 'PAID' ? setShowPayment(inv) : handleTransition(inv, s)}
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
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => window.print()}
              >
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
      content: !inv.lines || inv.lines.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">Немає позицій</p>
      ) : (
        <div className="space-y-2">
          {inv.lines.map((line, i) => (
            <div key={line.id ?? i} className="rounded-lg border border-border px-3 py-2 text-[13px]">
              <p className="font-medium text-foreground">{line.description}</p>
              <p className="text-muted-foreground text-[12px] mt-0.5">
                {line.quantity} × {line.unitPrice.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴
                {' = '}<span className="text-foreground font-medium">{line.priceWithVat.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴</span>
              </p>
            </div>
          ))}
        </div>
      ),
    },
  ];

  return (
    <div className="page-container">
      {error && (
        <div className="mb-4 text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">{error}</div>
      )}
      <div className="page-header">
        <div>
          <h1 className="page-title">Рахунки</h1>
          <p className="page-subtitle">{total} рахунків</p>
        </div>
        <Button onClick={() => setShowCreate(true)} leftIcon={<Plus className="h-4 w-4" />}>
          Новий рахунок
        </Button>
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
      <div className="flex flex-wrap gap-1.5 mb-4">
        {statuses.map(s => (
          <button
            key={s}
            onClick={() => { setStatus(s); setPage(1); setActiveSavedFilterId(null); }}
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
      <div className="mb-5 flex items-center gap-3">
        <div className="relative w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); setActiveSavedFilterId(null); }}
            placeholder="Пошук за номером або контрагентом..."
            className="pl-9"
          />
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <DetailPanelToggle enabled={detailPanel.enabled} onToggle={detailPanel.toggle} />
          {features.savedFiltersEnabled && (
            <SaveFilterButton onSave={handleSaveFilter} />
          )}
          <ColumnsDropdown
            columns={orderedColumns}
            visibleKeys={colVisible}
            onToggle={toggleCol}
            onReorder={reorder}
            onRename={renameColumn}
            onReset={resetConfig}
            hasCustomization={JSON.stringify(order) !== JSON.stringify(INVOICE_COLUMNS.map(c => c.key)) || Object.keys(customLabels).length > 0}
          />
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
      <div className="flex gap-0 rounded-xl border border-border overflow-hidden">
        <div className="flex-1 min-w-0 overflow-auto border-r border-border">
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
                {visibleColumns.map(col => (
                  col.key === 'amount'
                    ? <TableHead key={col.key} className="text-right">{col.label}</TableHead>
                    : <TableHead key={col.key}>{col.label}</TableHead>
                ))}
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell colSpan={visibleColumns.length + (features.bulkActionsEnabled ? 2 : 1)} className="py-10 text-center">
                    <div className="flex justify-center"><Spinner size="md" /></div>
                  </TableCell>
                </TableRow>
              )}
              {!loading && invoices.length === 0 && (
                <TableRow>
                  <TableCell colSpan={visibleColumns.length + (features.bulkActionsEnabled ? 2 : 1)} className="p-0">
                    <EmptyState icon={Receipt} title="Рахунків не знайдено" />
                  </TableCell>
                </TableRow>
              )}
              {!loading && invoices.map(inv => (
                <TableRow
                  key={inv.id}
                  onClick={() => { if (detailPanel.enabled) selectInvoice(inv); }}
                  className={cn(
                    detailPanel.enabled && 'cursor-pointer',
                    'transition-colors',
                    selectedInv?.id === inv.id && 'bg-primary/5',
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
                    if (col.key === 'number') return <TableCell key="number" className="font-medium text-[13px]">{inv.number}</TableCell>;
                    if (col.key === 'counterparty') return <TableCell key="counterparty" className="text-[13px]">{inv.counterpartyName ?? '—'}</TableCell>;
                    if (col.key === 'workOrder') return <TableCell key="workOrder" className="text-[13px] text-muted-foreground">{inv.workOrderNumber ?? '—'}</TableCell>;
                    if (col.key === 'status') return (
                      <TableCell key="status">
                        <Badge variant={STATUS_BADGE[inv.status] ?? 'secondary'}>{STATUS_LABELS[inv.status]}</Badge>
                      </TableCell>
                    );
                    if (col.key === 'amount') return <TableCell key="amount" className="text-right font-semibold text-[13px]">{fmt(inv.amount)}</TableCell>;
                    if (col.key === 'dueDate') return <TableCell key="dueDate" className="text-[13px] text-muted-foreground">{inv.dueDate ? new Date(inv.dueDate).toLocaleDateString('uk-UA') : '—'}</TableCell>;
                    return null;
                  })}
                  <TableCell>
                    <div
                      className="flex gap-1.5 justify-end"
                      onClick={e => e.stopPropagation()}
                    >
                      {STATUS_TRANSITIONS[inv.status]?.map(s => (
                        <Button
                          key={s}
                          variant={s === 'CANCELLED' ? 'destructive' : s === 'PAID' ? 'default' : 'outline'}
                          size="sm"
                          onClick={() => s === 'PAID' ? setShowPayment(inv) : handleTransition(inv, s)}
                          loading={savingId === inv.id}
                        >
                          {s === 'SENT' ? 'Надіслати' : s === 'PAID' ? 'Оплатити' : 'Скасувати'}
                        </Button>
                      ))}
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
        />
      </div>

      {/* Pagination */}
      {total > limit && (
        <div className="flex justify-center gap-1.5 mt-4">
          <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage(p => p - 1)}>← Назад</Button>
          <span className="h-8 w-8 flex items-center justify-center text-sm text-muted-foreground">{page}</span>
          <Button variant="outline" size="sm" disabled={page * limit >= total} onClick={() => setPage(p => p + 1)}>Вперед →</Button>
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
            fetchItems={q => apiFetch<{ items: Counterparty[] }>(`/counterparties?q=${encodeURIComponent(q)}&limit=10`).then(r => r.items.map(c => ({
              ...c,
              primary: displayCounterpartyName(c),
            })))}
          />
          <Input
            label="Сума, ₴"
            required
            type="number"
            value={form.amount}
            onChange={e => { setForm(f => ({ ...f, amount: e.target.value })); dirty.markDirty(); }}
            min="0.01"
            step="0.01"
            placeholder="0.00"
          />
          <DatePickerInput
            label="Термін оплати"
            value={form.dueDate}
            onChange={v => { setForm(f => ({ ...f, dueDate: v })); dirty.markDirty(); }}
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
              {payMethods.length > 0
                ? payMethods.map(m => <option key={m.code} value={m.code}>{m.name}</option>)
                : <>
                  <option value="cash">Готівка</option>
                  <option value="card_terminal">Термінал</option>
                  <option value="bank_transfer">Банківський переказ</option>
                </>
              }
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
