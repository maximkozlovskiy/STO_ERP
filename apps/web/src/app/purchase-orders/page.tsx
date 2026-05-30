'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useDebounce } from '@/hooks/useDebounce';
import { Plus, ShoppingCart, Search, Eye, EyeOff } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { getCached, setCache } from '@/lib/ref-cache';
import { Button } from '@/components/ui/button';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DirtyConfirmDialog } from '@/components/ui/dirty-confirm-dialog';
import { useConfirm } from '@/hooks/useConfirm';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { SearchCombobox } from '@/components/ui/search-combobox';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { DetailPanel, PanelField, type DetailPanelTab } from '@/components/ui/detail-panel';
import { DetailPanelToggle } from '@/components/ui/detail-panel-toggle';
import { SavedFiltersBar, SaveFilterButton } from '@/components/ui/saved-filters-bar';
import { BulkActionsBar, type BulkAction } from '@/components/ui/bulk-actions-bar';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';
import { ColumnsDropdown } from '@/components/ui/columns-dropdown';
import { useSavedFilters } from '@/hooks/useSavedFilters';
import { useBulkSelect } from '@/hooks/useBulkSelect';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import { useDetailPanel } from '@/hooks/useDetailPanel';
import { useTableColumns } from '@/hooks/useTableColumns';
import { useColumnDrag } from '@/hooks/useColumnDrag';
import { useDirtyForm } from '@/hooks/useDirtyForm';
import { toast } from '@/lib/toast';
import { cn, displayCounterpartyName } from '@/lib/utils';
import { fmtMoney, fmtDate } from '@/lib/format';

interface Supplier { id: string; firstName?: string; lastName?: string; companyName?: string; }
interface Warehouse { id: string; name: string; isMain: boolean; }
interface Good { id: string; name: string; sku: string | null; unit: string; purchasePrice: number | null; }
interface POLine {
  id?: string; goodId: string; goodName?: string; goodSku?: string | null; unit?: string;
  quantity: number; price: number; amount?: number; receivedQty?: number;
}
interface PurchaseOrder {
  id: string; number: string; status: string;
  supplierId: string; supplierName?: string;
  warehouseId: string; warehouseName?: string;
  totalAmount: number; notes: string | null;
  linesCount: number;
  lines: POLine[]; // empty in list — loaded on demand via findOne
  createdAt: string; updatedAt: string;
  deletedAt?: string | null;
}
interface Paginated { items: PurchaseOrder[]; total: number; page: number; limit: number; }

interface PoFilters extends Record<string, unknown> {
  status: string;
  q: string;
  showDeleted: boolean;
}

const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Чернетка', ORDERED: 'Замовлено', PARTIAL: 'Частково', RECEIVED: 'Отримано', CANCELLED: 'Скасовано',
};
const STATUS_BADGE: Record<string, BadgeVariant> = {
  DRAFT: 'secondary', ORDERED: 'default', PARTIAL: 'warning', RECEIVED: 'success', CANCELLED: 'destructive',
};
const STATUS_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['ORDERED', 'CANCELLED'],
  ORDERED: ['RECEIVED', 'CANCELLED'],
  PARTIAL: ['RECEIVED', 'CANCELLED'],
  RECEIVED: [], CANCELLED: [],
};
const STATUS_ACTION_LABELS: Record<string, string> = {
  ORDERED: 'Підтвердити замовлення', RECEIVED: 'Позначити отриманим',
  CANCELLED: 'Скасувати', PARTIAL: 'Часткове отримання',
};

function fmt(n: number) {
  return fmtMoney(n) + ' ₴';
}

export default function PurchaseOrdersPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'STOREKEEPER']);

  const { confirm, dialogProps } = useConfirm();
  const features = useUiFeatures();

  const COLUMNS = useMemo(() => [
    { key: 'number',    label: 'Номер',        defaultVisible: true },
    { key: 'supplier',  label: 'Постачальник', defaultVisible: true },
    { key: 'warehouse', label: 'Склад',        defaultVisible: true },
    { key: 'status',    label: 'Статус',       defaultVisible: true },
    { key: 'amount',    label: 'Сума',         defaultVisible: true },
    { key: 'date',      label: 'Дата',         defaultVisible: true },
  ], []);

  const { visibleKeys: colVisible, visibleColumns, orderedColumns, order, customLabels, toggle: toggleCol, reorder, renameColumn, resetConfig } = useTableColumns('purchase-orders', COLUMNS);
  const { dragProps } = useColumnDrag(visibleColumns, reorder, orderedColumns);

  const detailPanel = useDetailPanel('purchase-orders');

  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const debouncedQ = useDebounce(q);
  const [showDeleted, setShowDeleted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Saved filters
  const [activeSavedFilterId, setActiveSavedFilterId] = useState<string | null>(null);
  const { saved: savedFilters, save: saveFilter, remove: removeFilter } = useSavedFilters<PoFilters>('purchase-orders');

  const applyFilter = useCallback((preset: { id: string; filters: PoFilters }) => {
    setStatus(preset.filters.status ?? '');
    setQ(preset.filters.q ?? '');
    setShowDeleted(preset.filters.showDeleted ?? false);
    setPage(1);
    setActiveSavedFilterId(preset.id);
  }, []);

  const handleSaveFilter = useCallback((name: string) => {
    const preset = saveFilter(name, { status, q, showDeleted });
    setActiveSavedFilterId(preset.id);
    if (features.toastEnabled) toast.success(`Фільтр "${name}" збережено`);
  }, [saveFilter, status, q, showDeleted, features.toastEnabled]);

  // Bulk select
  const bulkSelect = useBulkSelect(orders);

  const selectAllRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = bulkSelect.someSelected;
  }, [bulkSelect.someSelected]);

  // Unsaved guard for create/receive modals
  const dirty = useDirtyForm({ enabled: features.unsavedGuardEnabled });

  const [selectedPO, setSelectedPO] = useState<PurchaseOrder | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showDetail, setShowDetail] = useState<PurchaseOrder | null>(null);
  const [showReceive, setShowReceive] = useState<PurchaseOrder | null>(null);

  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [supplierDisplayName, setSupplierDisplayName] = useState('');
  const [form, setForm] = useState({ supplierId: '', warehouseId: '', notes: '' });
  const [lines, setLines] = useState<{ goodId: string; goodName: string; quantity: string; price: string }[]>([]);
  const [saving, setSaving] = useState(false);

  const [receiveLines, setReceiveLines] = useState<{ lineId: string; receivedQty: string }[]>([]);

  interface PricingResult {
    updated: number;
    details: { goodId: string; goodName: string; costPrice: number; oldSalePrice: number; newSalePrice: number }[];
  }
  const [pricingResult, setPricingResult] = useState<Record<string, PricingResult>>({});
  const [applyingPricingId, setApplyingPricingId] = useState<string | null>(null);

  const limit = 20;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (status) params.set('status', status);
      if (debouncedQ) params.set('q', debouncedQ);
      if (showDeleted) params.set('showDeleted', 'true');
      const data = await apiFetch<Paginated>(`/purchase-orders?${params}`);
      setOrders(data.items);
      setTotal(data.total);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка завантаження');
    } finally {
      setLoading(false);
    }
  }, [page, status, debouncedQ, showDeleted]);

  useEffect(() => { load(); }, [load]);

  const bulkDeleteSelected = useCallback(async (ids: string[]) => {
    if (!(await confirm({ title: `Видалити ${ids.length} замовлень?`, confirmLabel: 'Видалити', variant: 'destructive' }))) return;
    const results = await Promise.allSettled(
      ids.map(id => apiFetch(`/purchase-orders/${id}`, { method: 'DELETE' })),
    );
    const succeeded = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.length - succeeded;
    bulkSelect.clear();
    load();
    if (features.toastEnabled) {
      if (succeeded > 0 && failed === 0) toast.success(`Видалено ${succeeded} замовлень`);
      else if (succeeded > 0) toast.warning(`Видалено ${succeeded} з ${results.length}. ${failed} не вдалось`);
      else toast.error('Не вдалося видалити замовлення');
    }
  }, [confirm, bulkSelect, features.toastEnabled, load]);

  const bulkActions = useMemo<BulkAction[]>(() => [
    { id: 'delete', label: 'Видалити вибрані', variant: 'destructive', onClick: bulkDeleteSelected },
  ], [bulkDeleteSelected]);

  useEffect(() => {
    if (!showCreate) return;
    let cancelled = false;

    const apply = (wList: Warehouse[]) => {
      if (cancelled) return;
      setWarehouses(wList);
      const mainW = wList.find(x => x.isMain) ?? (wList.length === 1 ? wList[0] : null);
      // Auto-select main warehouse only if the user hasn't already picked one
      // (e.g. modal re-opened after a slow fetch — preserves manual choice).
      if (mainW) setForm(f => (f.warehouseId ? f : { ...f, warehouseId: mainW.id }));
    };

    // Reference data — paint instantly from sessionStorage, refresh in background.
    const cached = getCached<Warehouse[]>('cache:warehouses');
    if (cached) apply(cached);

    apiFetch<Warehouse[] | { items: Warehouse[] }>('/warehouses')
      .then(w => {
        const wList = Array.isArray(w) ? w : w.items;
        setCache('cache:warehouses', wList);
        apply(wList);
      }).catch((e: unknown) => {
        if (!cancelled && !cached) setError(e instanceof Error ? e.message : 'Помилка завантаження довідників');
      });

    return () => { cancelled = true; };
  }, [showCreate]);

  const handleCreate = async () => {
    const validLines = lines.filter(l => l.goodId);
    for (const l of validLines) {
      const qty = parseFloat(l.quantity); const price = parseFloat(l.price);
      if (!Number.isFinite(qty) || qty <= 0) { setError('Вкажіть коректну кількість для всіх позицій'); return; }
      if (!Number.isFinite(price) || price < 0) { setError('Вкажіть коректну ціну для всіх позицій'); return; }
    }
    setSaving(true);
    try {
      await apiFetch<PurchaseOrder>('/purchase-orders', {
        method: 'POST',
        body: JSON.stringify({
          supplierId: form.supplierId, warehouseId: form.warehouseId, notes: form.notes || undefined,
          lines: validLines.map(l => ({
            goodId: l.goodId,
            quantity: parseFloat(l.quantity),
            price: parseFloat(l.price),
          })),
        }),
      });
      setShowCreate(false);
      setForm({ supplierId: '', warehouseId: '', notes: '' });
      setSupplierDisplayName('');
      setLines([]);
      dirty.resetDirty();
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка збереження');
    } finally { setSaving(false); }
  };

  const handleTransition = async (po: PurchaseOrder, newStatus: string) => {
    if (!(await confirm({ title: `Перевести замовлення ${po.number} → ${STATUS_LABELS[newStatus]}?` }))) return;
    setSaving(true); setError('');
    try {
      await apiFetch<PurchaseOrder>(`/purchase-orders/${po.id}/transition`, {
        method: 'POST', body: JSON.stringify({ status: newStatus }),
      });
      setShowDetail(null);
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка переходу статусу'); }
    finally { setSaving(false); }
  };

  const loadDetail = async (po: PurchaseOrder, mode: 'detail' | 'receive') => {
    // Lines are not included in list response — fetch full PO on demand
    if (po.lines.length > 0 || po.linesCount === 0) {
      mode === 'detail' ? setShowDetail(po) : openReceiveWithLines(po);
      return;
    }
    setDetailLoading(true);
    try {
      const full = await apiFetch<PurchaseOrder>(`/purchase-orders/${po.id}`);
      mode === 'detail' ? setShowDetail(full) : openReceiveWithLines(full);
    } catch { /* show partial data */ mode === 'detail' ? setShowDetail(po) : openReceiveWithLines(po); }
    finally { setDetailLoading(false); }
  };

  const openReceiveWithLines = (po: PurchaseOrder) => {
    setReceiveLines(po.lines.map(l => ({ lineId: l.id!, receivedQty: '' })));
    setShowReceive(po);
  };

  const openReceive = (po: PurchaseOrder) => { void loadDetail(po, 'receive'); };

  const applyPricing = async (po: PurchaseOrder) => {
    setApplyingPricingId(po.id);
    setError('');
    try {
      const result = await apiFetch<PricingResult>(`/purchase-orders/${po.id}/apply-pricing`, { method: 'POST' });
      setPricingResult(prev => ({ ...prev, [po.id]: result }));
      if (features.toastEnabled) toast.success(`Розцінено ${result.updated} товарів`);
    } catch (e: unknown) {
      // Bug #199: помилка має бути видимою навіть з toastEnabled=false. Toast — додаток, не заміна setError.
      const msg = e instanceof Error ? e.message : 'Помилка розцінки';
      setError(msg);
      if (features.toastEnabled) toast.error(msg);
    } finally {
      setApplyingPricingId(null);
    }
  };

  const handleReceive = async () => {
    if (!showReceive) return;
    const receivedLines = receiveLines
      .filter(l => parseFloat(l.receivedQty) > 0)
      .map(l => ({ lineId: l.lineId, receivedQty: parseFloat(l.receivedQty) }));
    if (!receivedLines.length) { setError('Вкажіть кількість для хоча б однієї позиції'); return; }
    setSaving(true); setError('');
    try {
      await apiFetch<PurchaseOrder>(`/purchase-orders/${showReceive.id}/receive`, {
        method: 'POST', body: JSON.stringify({ lines: receivedLines }),
      });
      setShowReceive(null);
      dirty.resetDirty();
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка прийому товару'); }
    finally { setSaving(false); }
  };

  const addLine = () => { setLines(l => [...l, { goodId: '', goodName: '', quantity: '1', price: '' }]); dirty.markDirty(); };
  const updateLine = (i: number, field: string, value: string) => {
    setLines(l => l.map((x, idx) => idx === i ? { ...x, [field]: value } : x));
    dirty.markDirty();
  };
  const removeLine = (i: number) => { setLines(l => l.filter((_, idx) => idx !== i)); dirty.markDirty(); };

  const statuses = ['', 'DRAFT', 'ORDERED', 'PARTIAL', 'RECEIVED', 'CANCELLED'];

  const buildPOTabs = (po: PurchaseOrder): DetailPanelTab[] => [
    {
      key: 'info',
      label: 'Основне',
      content: (
        <div className="space-y-3">
          <PanelField label="Статус" value={<Badge variant={STATUS_BADGE[po.status] ?? 'secondary'}>{STATUS_LABELS[po.status]}</Badge>} />
          <PanelField label="Постачальник" value={po.supplierName} />
          <PanelField label="Склад" value={po.warehouseName} />
          <PanelField label="Сума" value={po.totalAmount != null ? `${fmtMoney(po.totalAmount)} ₴` : undefined} />
          <PanelField label="Позицій" value={po.linesCount != null ? String(po.linesCount) : undefined} />
          {po.notes && <PanelField label="Нотатки" value={po.notes} />}
          <PanelField label="Дата" value={fmtDate(po.createdAt)} />
          {(po.status === 'RECEIVED' || po.status === 'PARTIAL') && (
            <div className="pt-1 space-y-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="w-full"
                loading={applyingPricingId === po.id}
                onClick={() => void applyPricing(po)}
              >
                Розцінити товари
              </Button>
              {pricingResult[po.id] && (
                <div className="rounded-lg border border-border bg-secondary/30 p-3 space-y-2">
                  <p className="text-[12px] text-muted-foreground">
                    Оновлено: <span className="font-medium text-foreground">{pricingResult[po.id].updated}</span> товарів
                  </p>
                  {pricingResult[po.id].details.length > 0 && (
                    <div className="space-y-1.5">
                      {pricingResult[po.id].details.map(d => (
                        <div key={d.goodId} className="text-[12px]">
                          <p className="font-medium text-foreground truncate">{d.goodName}</p>
                          <p className="text-muted-foreground">
                            {fmtMoney(d.costPrice)} ₴ →{' '}
                            <span className="line-through">{fmtMoney(d.oldSalePrice)}</span>{' '}
                            <span className="text-success-text font-medium">{fmtMoney(d.newSalePrice)} ₴</span>
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'lines',
      label: 'Позиції',
      content: !po.lines || po.lines.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">Немає позицій</p>
      ) : (
        <div className="space-y-2">
          {po.lines.map((line, i) => (
            <div key={line.id ?? i} className="rounded-lg border border-border px-3 py-2 text-[13px]">
              <p className="font-medium text-foreground">{line.goodName ?? line.goodId}</p>
              {line.goodSku && <p className="text-muted-foreground text-[12px]">{line.goodSku}</p>}
              <p className="text-muted-foreground text-[12px] mt-0.5">
                {line.quantity} {line.unit ?? ''} × {fmtMoney(line.price)} ₴
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
          <h1 className="page-title">Замовлення постачальникам</h1>
          <p className="page-subtitle">{total} замовлень</p>
        </div>
        <Button onClick={() => setShowCreate(true)} leftIcon={<Plus className="h-4 w-4" />}>
          Нове замовлення
        </Button>
      </div>

      {/* Saved filters */}
      {features.savedFiltersEnabled && (
        <SavedFiltersBar<PoFilters>
          saved={savedFilters}
          activeId={activeSavedFilterId}
          onApply={applyFilter}
          onSave={handleSaveFilter}
          onRemove={removeFilter}
          className="mb-3"
          hideSaveButton
        />
      )}

      {/* Filters row */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        {/* Search */}
        <div className="relative w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            value={q}
            onChange={e => { setQ(e.target.value); setPage(1); setActiveSavedFilterId(null); }}
            placeholder="Пошук за номером, постачальником..."
            className="pl-9"
          />
        </div>

        {/* Show deleted toggle */}
        <button
          onClick={() => { setShowDeleted(v => !v); setPage(1); setActiveSavedFilterId(null); }}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors',
            showDeleted
              ? 'bg-destructive/10 text-destructive border-destructive/30'
              : 'border-border text-muted-foreground bg-surface hover:bg-secondary',
          )}
        >
          {showDeleted ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          Показати видалені
        </button>

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
                  hasCustomization={JSON.stringify(order) !== JSON.stringify(COLUMNS.map(c=>c.key)) || Object.keys(customLabels).length > 0}
                />
        </div>
      </div>

      {/* Status filters */}
      <div className="flex flex-wrap gap-1.5 mb-5">
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
      <div className="flex gap-0">
        <div className="flex-1 min-w-0 overflow-auto border border-border rounded-xl">
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
                    ? <TableHead key={col.key} className="text-right" {...dragProps(col.key)}>{col.label}</TableHead>
                    : <TableHead key={col.key} {...dragProps(col.key)}>{col.label}</TableHead>
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
              {!loading && orders.length === 0 && (
                <TableRow>
                  <TableCell colSpan={visibleColumns.length + (features.bulkActionsEnabled ? 2 : 1)} className="p-0">
                    <EmptyState icon={ShoppingCart} title="Замовлень не знайдено" />
                  </TableCell>
                </TableRow>
              )}
              {!loading && orders.map(po => (
                <TableRow
                  key={po.id}
                  className={cn(
                    detailPanel.enabled && 'cursor-pointer',
                    'transition-colors',
                    selectedPO?.id === po.id && 'bg-secondary',
                    bulkSelect.isSelected(po.id) && 'bg-primary/5',
                    po.deletedAt && 'opacity-60',
                  )}
                  onClick={() => { if (detailPanel.enabled) setSelectedPO(prev => prev?.id === po.id ? null : po); }}
                >
                  {features.bulkActionsEnabled && (
                    <TableCell className="w-9 pr-0" onClick={e => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={bulkSelect.isSelected(po.id)}
                        onChange={() => bulkSelect.toggle(po.id)}
                        className="h-3.5 w-3.5 rounded border-border"
                        aria-label={`Вибрати замовлення ${po.number}`}
                      />
                    </TableCell>
                  )}
                  {visibleColumns.map(col => {
                    if (col.key === 'number') return (
                      <TableCell key="number" className="font-medium text-[13px]">
                        {po.number}
                        {po.deletedAt && (
                          <Badge variant="destructive" className="ml-2 text-[10px] px-1 py-0">видалено</Badge>
                        )}
                      </TableCell>
                    );
                    if (col.key === 'supplier') return <TableCell key="supplier" className="text-[13px]">{po.supplierName ?? '—'}</TableCell>;
                    if (col.key === 'warehouse') return <TableCell key="warehouse" className="text-[13px] text-muted-foreground">{po.warehouseName ?? '—'}</TableCell>;
                    if (col.key === 'status') return <TableCell key="status"><Badge variant={STATUS_BADGE[po.status] ?? 'secondary'}>{STATUS_LABELS[po.status]}</Badge></TableCell>;
                    if (col.key === 'amount') return <TableCell key="amount" className="text-right font-semibold text-[13px]">{fmtMoney(po.totalAmount)} ₴</TableCell>;
                    if (col.key === 'date') return <TableCell key="date" className="text-[13px] text-muted-foreground">{fmtDate(po.createdAt)}</TableCell>;
                    return null;
                  })}
                  <TableCell>
                    <div className="flex items-center gap-1 flex-wrap">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={e => { e.stopPropagation(); void loadDetail(po, 'detail'); }}
                      >
                        Деталі
                      </Button>
                      {(po.status === 'RECEIVED' || po.status === 'PARTIAL') && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          loading={applyingPricingId === po.id}
                          onClick={e => { e.stopPropagation(); void applyPricing(po); }}
                          title="Розцінити товари за правилами"
                        >
                          Розцінити
                        </Button>
                      )}
                    </div>
                    {pricingResult[po.id] && (
                      <div className="mt-2 rounded-lg border border-border bg-secondary/30 p-3">
                        <div className="text-[12px] text-muted-foreground mb-2">
                          Оновлено: {pricingResult[po.id].updated} товарів
                        </div>
                        {pricingResult[po.id].details.length > 0 && (
                          <table className="w-full text-[12px]">
                            <thead>
                              <tr className="text-muted-foreground">
                                <th className="text-left py-1">Товар</th>
                                <th className="text-right py-1">Собів.</th>
                                <th className="text-right py-1">Стара ціна</th>
                                <th className="text-right py-1">Нова ціна</th>
                              </tr>
                            </thead>
                            <tbody>
                              {pricingResult[po.id].details.map(d => (
                                <tr key={d.goodId}>
                                  <td className="py-0.5 text-foreground">{d.goodName}</td>
                                  <td className="py-0.5 text-right text-muted-foreground">{fmtMoney(d.costPrice)}</td>
                                  <td className="py-0.5 text-right text-muted-foreground line-through">{fmtMoney(d.oldSalePrice)}</td>
                                  <td className="py-0.5 text-right font-medium text-foreground">{fmtMoney(d.newSalePrice)} ₴</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {/* Detail panel */}
        <DetailPanel
          open={!!selectedPO && detailPanel.enabled}
          onClose={() => setSelectedPO(null)}
          title={selectedPO?.number ?? ''}
          subtitle={selectedPO?.supplierName}
          tabs={selectedPO ? buildPOTabs(selectedPO) : undefined}
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
          setShowCreate(false);
          setForm({ supplierId: '', warehouseId: '', notes: '' });
          setSupplierDisplayName('');
          setLines([]);
          dirty.resetDirty();
        }}
        title="Нове замовлення постачальнику"
        size="xl"
        footer={
          <Button
            onClick={handleCreate}
            loading={saving}
            disabled={!form.supplierId || !form.warehouseId}
            className="w-full"
          >
            Створити замовлення
          </Button>
        }
      >
        <div className="space-y-4">
          <SearchCombobox<Supplier>
            label="Постачальник"
            required
            placeholder="Назва компанії, телефон..."
            value={form.supplierId}
            displayValue={supplierDisplayName}
            onSelect={s => {
              // Bug #139: helper повертає '(без імені)' fallback замість порожнього рядка.
              setSupplierDisplayName(displayCounterpartyName(s));
              setForm(f => ({ ...f, supplierId: s.id }));
              dirty.markDirty();
            }}
            onClear={() => { setSupplierDisplayName(''); setForm(f => ({ ...f, supplierId: '' })); }}
            fetchItems={q => apiFetch<{ items: Supplier[] }>(`/counterparties?type=SUPPLIER&q=${encodeURIComponent(q)}&limit=10`).then(r => r.items.map(s => ({
              ...s,
              primary: displayCounterpartyName(s),
            })))}
          />
          <Select
            label="Склад"
            required
            value={form.warehouseId}
            onChange={e => { setForm(f => ({ ...f, warehouseId: e.target.value })); dirty.markDirty(); }}
            placeholder="Оберіть склад"
          >
            {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </Select>
          <Input
            label="Примітки"
            value={form.notes}
            onChange={e => { setForm(f => ({ ...f, notes: e.target.value })); dirty.markDirty(); }}
            placeholder="Необов'язково"
          />

          {/* Lines */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-foreground">Позиції</span>
              <Button variant="ghost" size="sm" onClick={addLine}>+ Додати</Button>
            </div>
            <div className="space-y-2">
              {lines.map((l, i) => (
                <div key={i} className="flex gap-2 items-start">
                  <div className="flex-1">
                    <SearchCombobox<Good>
                      placeholder="Товар..."
                      value={l.goodId}
                      displayValue={l.goodName}
                      onSelect={g => setLines(ls => ls.map((x, idx) => idx === i ? { ...x, goodId: g.id, goodName: g.name, price: g.purchasePrice ? String(g.purchasePrice) : x.price } : x))}
                      onClear={() => setLines(ls => ls.map((x, idx) => idx === i ? { ...x, goodId: '', goodName: '' } : x))}
                      fetchItems={q => apiFetch<{ items: Good[] }>(`/goods?q=${encodeURIComponent(q)}&limit=10`).then(r => r.items.map(g => ({ ...g, primary: g.name, secondary: g.sku ?? undefined })))}
                    />
                  </div>
                  <Input
                    type="number"
                    value={l.quantity}
                    onChange={e => updateLine(i, 'quantity', e.target.value)}
                    placeholder="Кіл."
                    min="0.001"
                    step="0.001"
                    className="w-20 text-xs"
                  />
                  <Input
                    type="number"
                    value={l.price}
                    onChange={e => updateLine(i, 'price', e.target.value)}
                    placeholder="Ціна"
                    min="0"
                    step="0.01"
                    className="w-24 text-xs"
                  />
                  <button onClick={() => removeLine(i)} className="text-destructive/60 hover:text-destructive text-sm px-1">×</button>
                </div>
              ))}
              {lines.length === 0 && (
                <p className="text-xs text-muted-foreground">Замовлення можна створити без позицій і додати їх пізніше</p>
              )}
            </div>
          </div>
        </div>
      </Modal>

      {/* Detail modal */}
      <Modal
        open={!!showDetail}
        onClose={() => setShowDetail(null)}
        title={showDetail ? `Замовлення ${showDetail.number}` : ''}
        size="lg"
        footer={
          showDetail && STATUS_TRANSITIONS[showDetail.status]?.length > 0 ? (
            <div className="flex flex-wrap gap-2 w-full">
              {STATUS_TRANSITIONS[showDetail.status]?.map(s => (
                <Button
                  key={s}
                  variant={s === 'CANCELLED' ? 'destructive' : 'default'}
                  size="sm"
                  onClick={() => s === 'RECEIVED' && ['ORDERED', 'PARTIAL'].includes(showDetail.status)
                    ? openReceive(showDetail)
                    : handleTransition(showDetail, s)}
                  loading={saving}
                >
                  {STATUS_ACTION_LABELS[s] ?? STATUS_LABELS[s]}
                </Button>
              ))}
            </div>
          ) : undefined
        }
      >
        {showDetail && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 flex-wrap">
              <Badge variant={STATUS_BADGE[showDetail.status] ?? 'secondary'}>
                {STATUS_LABELS[showDetail.status]}
              </Badge>
              <span className="text-muted-foreground text-sm">{showDetail.supplierName}</span>
              <span className="text-foreground-faint text-sm">→ {showDetail.warehouseName}</span>
            </div>

            {/* Lines table */}
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-xs">
                <thead className="bg-secondary">
                  <tr>
                    <th className="text-left px-3 py-2 text-muted-foreground">Товар</th>
                    <th className="text-right px-3 py-2 text-muted-foreground">Замовлено</th>
                    <th className="text-right px-3 py-2 text-muted-foreground">Отримано</th>
                    <th className="text-right px-3 py-2 text-muted-foreground">Ціна</th>
                    <th className="text-right px-3 py-2 text-muted-foreground">Сума</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {showDetail.lines.map((l, i) => (
                    <tr key={i}>
                      <td className="px-3 py-2 text-foreground">{l.goodName}</td>
                      <td className="px-3 py-2 text-right">{l.quantity} {l.unit}</td>
                      <td className={cn('px-3 py-2 text-right font-medium', (l.receivedQty ?? 0) >= l.quantity ? 'text-success' : 'text-warning')}>
                        {l.receivedQty ?? 0}
                      </td>
                      <td className="px-3 py-2 text-right">{fmt(l.price)}</td>
                      <td className="px-3 py-2 text-right font-medium">{fmt(l.amount ?? l.quantity * l.price)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-secondary">
                  <tr>
                    <td colSpan={4} className="px-3 py-2 text-right font-medium text-foreground-muted">Разом:</td>
                    <td className="px-3 py-2 text-right font-bold text-foreground">{fmt(showDetail.totalAmount)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {showDetail.notes && (
              <p className="text-sm text-muted-foreground italic">{showDetail.notes}</p>
            )}
          </div>
        )}
      </Modal>

      {/* Receive modal */}
      <Modal
        open={!!showReceive}
        onClose={async () => { if (!(await dirty.confirmClose())) return; setShowReceive(null); dirty.resetDirty(); }}
        title={showReceive ? `Прийом по замовленню ${showReceive.number}` : ''}
        size="lg"
        footer={
          <Button onClick={handleReceive} loading={saving} className="w-full">
            Підтвердити прийом
          </Button>
        }
      >
        {showReceive && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">Вкажіть кількість, яку фактично отримано по кожній позиції</p>
            <div className="space-y-3">
              {showReceive.lines.map((line, i) => (
                <div key={i} className="flex items-center gap-3 p-3 bg-secondary rounded-lg">
                  <div className="flex-1">
                    <div className="text-sm font-medium text-foreground">{line.goodName}</div>
                    <div className="text-xs text-muted-foreground">
                      Замовлено: {line.quantity} {line.unit} · Отримано раніше: {line.receivedQty ?? 0}
                    </div>
                  </div>
                  <Input
                    type="number"
                    value={receiveLines[i]?.receivedQty ?? ''}
                    onChange={e => { setReceiveLines(ls => ls.map((l, idx) => idx === i ? { ...l, receivedQty: e.target.value } : l)); dirty.markDirty(); }}
                    placeholder={`макс. ${line.quantity - (line.receivedQty ?? 0)}`}
                    min="0"
                    max={line.quantity - (line.receivedQty ?? 0)}
                    step="0.001"
                    className="w-28 text-right"
                  />
                  <span className="text-xs text-muted-foreground">{line.unit}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Modal>
      <DirtyConfirmDialog {...dirty.dialogProps} />
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
