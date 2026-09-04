'use client';

import { Fragment, memo, useEffect, useState, useCallback, useMemo } from 'react';
import { useDebounce } from '@/hooks/useDebounce';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronRight, Package, Search } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { getCached, setCache } from '@/lib/ref-cache';
import {
  useStockItems,
  useLowStockItems,
  useStockByDocument,
  useStockByBatch,
  StockItem,
  GoodWithDocuments,
  BatchGroup,
  inventoryKeys,
} from '@/hooks/api/useInventory';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  SortableHead,
  TableCell,
} from '@/components/ui/table';
import { useSortState } from '@/hooks/useSortState';
import { DetailPanel, PanelField, type DetailPanelTab } from '@/components/ui/detail-panel';
import { DetailPanelToggle } from '@/components/ui/detail-panel-toggle';
import { useDetailPanelConfig } from '@/hooks/useDetailPanelConfig';
import { useDetailPanel } from '@/hooks/useDetailPanel';
import {
  STOCK_ITEM_PANEL_SCHEMA,
  buildPanelFields,
  schemaToPanelConfigFields,
} from '@/lib/panel-schema';
import { cn } from '@/lib/utils';
import { fmtMoney, fmtDate, fmtDateTime } from '@/lib/format';

type PanelConfigHook = ReturnType<typeof useDetailPanelConfig>;

interface Warehouse {
  id: string;
  name: string;
}

type ViewMode = 'goods' | 'documents' | 'batches';

const VIEW_LABELS: Record<ViewMode, string> = {
  goods: 'По товарах',
  documents: 'По документах',
  batches: 'По партіях',
};

function fmt(n: number) {
  return `${fmtMoney(n)} ₴`;
}

// Matches Prisma StockMovementType enum (schema.prisma)
const MOVEMENT_TYPE_LABELS: Record<string, string> = {
  RECEIPT: 'Надходження',
  WRITEOFF: 'Списання',
  TRANSFER: 'Переміщення',
  RESERVATION: 'Резерв',
  RESERVATION_RELEASE: 'Зняття резерву',
  OPENING_BALANCE: 'Початковий залишок',
};

function toggle(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export default function InventoryPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'STOREKEEPER', 'RECEPTIONIST']);

  const queryClient = useQueryClient();
  const panelConfig = useDetailPanelConfig('inventory-panel');
  // Тогл бокової панелі — стандарт для всіх списків (enabled персиститься у localStorage).
  const detailPanel = useDetailPanel('inventory');

  // View mode
  const [viewMode, setViewMode] = useState<ViewMode>('goods');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Filters
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [q, setQ] = useState('');
  const debouncedQ = useDebounce(q);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [showLow, setShowLow] = useState(false);
  const [error, setError] = useState('');

  // Detail panel state (goods mode only)
  const [selectedItem, setSelectedItem] = useState<StockItem | null>(null);
  const [editingMinStock, setEditingMinStock] = useState(false);
  const [minStockVal, setMinStockVal] = useState('');
  const [savingMinStock, setSavingMinStock] = useState(false);

  // sto-optimize: stable handler ref — без useCallback inline arrow recreated
  // на кожен render, що дає false-positive prop change для ByDocumentsView/ByBatchesView.
  // ВАЖЛИВО: handlers оголошені ПІСЛЯ useState — інакше TDZ (Bug #N: 'Cannot access
  // selectedItem before initialization' при першому рендері).
  const handleToggleExpanded = useCallback((key: string) => {
    setExpanded(prev => toggle(prev, key));
  }, []);

  // sto-optimize: setViewMode resets expanded — також стабільний.
  const handleSwitchView = useCallback((m: ViewMode) => {
    setViewMode(m);
    setExpanded(new Set());
  }, []);

  // sto-optimize: stable handlers для InventoryDetailPanel — без них panel re-mount-ить
  // tabs[].content на КОЖЕН render батька (typing у фільтрі, scroll, query refetch),
  // що скидає Input focus при редагуванні minStock.
  const handleCloseDetail = useCallback(() => setSelectedItem(null), []);
  const handleStartEditMinStock = useCallback(() => {
    if (!selectedItem) return;
    setMinStockVal(selectedItem.minStock != null ? String(selectedItem.minStock) : '');
    setEditingMinStock(true);
  }, [selectedItem]);
  const handleCancelEditMinStock = useCallback(() => setEditingMinStock(false), []);

  // Low stock modal
  const [showLowModal, setShowLowModal] = useState(false);

  const { sort: invSort, toggle: toggleInvSort } = useSortState('goodName', 'asc');

  // --- Data hooks ---
  const {
    data: rawItems = [],
    isLoading: loadingGoods,
    error: queryError,
  } = useStockItems({ warehouseId, q: debouncedQ });

  const items = useMemo(() => {
    if (!rawItems.length) return rawItems;
    const dir = invSort.sortDir === 'asc' ? 1 : -1;
    return [...rawItems].sort((a, b) => {
      if (invSort.sortBy === 'quantity') return (a.quantity - b.quantity) * dir;
      if (invSort.sortBy === 'available') return (a.available - b.available) * dir;
      if (invSort.sortBy === 'salePrice') return (a.salePrice - b.salePrice) * dir;
      return a.goodName.localeCompare(b.goodName, 'uk') * dir;
    });
  }, [rawItems, invSort]);

  const viewFilters = {
    warehouseId: warehouseId || undefined,
    from: from || undefined,
    to: to || undefined,
  };

  // gate за viewMode — без enabled три hooks тригерили запити
  // одразу при mount, агрегуючи до 5500 рядків навіть коли user у режимі 'goods'.
  const { data: byDocData, isLoading: loadingDoc } = useStockByDocument(
    viewFilters,
    viewMode === 'documents',
  );
  const { data: byBatchData, isLoading: loadingBatch } = useStockByBatch(
    viewFilters,
    viewMode === 'batches',
  );

  const { data: lowItems = [], refetch: refetchLowItems } = useLowStockItems();

  // Reference data
  const loadWarehouses = useCallback(async () => {
    const cached = getCached<Warehouse[]>('cache:warehouses');
    if (cached) setWarehouses(cached);
    try {
      const data = await apiFetch<Warehouse[] | { items: Warehouse[] }>('/warehouses');
      const list = Array.isArray(data) ? data : data.items;
      setWarehouses(list);
      setCache('cache:warehouses', list);
    } catch (e: unknown) {
      if (!cached) setError(e instanceof Error ? e.message : 'Помилка завантаження складів');
    }
  }, []);

  useEffect(() => {
    loadWarehouses();
  }, [loadWarehouses]);

  const saveMinStock = async () => {
    if (!selectedItem) return;
    const val = minStockVal.trim() === '' ? null : Number(minStockVal);
    if (val !== null && (!Number.isFinite(val) || val < 0)) {
      setError('Некоректне значення мінімального залишку');
      return;
    }
    setSavingMinStock(true);
    try {
      await apiFetch(`/stock-items/${selectedItem.id}/min-stock`, {
        method: 'PATCH',
        body: JSON.stringify({ minStock: val }),
      });
      setSelectedItem(prev =>
        prev ? { ...prev, minStock: val, isLow: val !== null && prev.quantity <= val } : prev,
      );
      queryClient.invalidateQueries({ queryKey: inventoryKeys.items() });
      setEditingMinStock(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка збереження');
    } finally {
      setSavingMinStock(false);
    }
  };

  // sto-optimize: useMemo щоб filter не виконувався на КОЖЕН render (low-mode toggle
  // rarely changes vs typing у пошук, який already triggers items refresh).
  const displayed = useMemo(() => (showLow ? items.filter(i => i.isLow) : items), [items, showLow]);

  // Loading state for current mode
  const loading =
    viewMode === 'goods' ? loadingGoods : viewMode === 'documents' ? loadingDoc : loadingBatch;

  return (
    <div className="page-fill p-4 md:p-6">
      {(error || queryError) && (
        <div className="mb-4 text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">
          {error || (queryError instanceof Error ? queryError.message : '')}
        </div>
      )}
      <div className="page-header">
        <div>
          <h1 className="page-title">Залишки на складах</h1>
        </div>
        <Button
          variant="outline"
          onClick={async () => {
            await refetchLowItems();
            setShowLowModal(true);
          }}
          className="text-warning-text border-warning-border bg-warning-subtle hover:bg-warning-subtle/80"
        >
          <AlertTriangle className="h-4 w-4" />
          Нижче мінімуму
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 shrink-0 items-center">
        {/* View mode switcher */}
        <div className="flex rounded-lg border border-border overflow-hidden shrink-0">
          {(Object.keys(VIEW_LABELS) as ViewMode[]).map(m => (
            <button
              key={m}
              onClick={() => handleSwitchView(m)}
              className={cn(
                'px-3 py-1 text-[13px] transition-colors',
                viewMode === m
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-surface text-muted-foreground hover:bg-surface-hover',
              )}
            >
              {VIEW_LABELS[m]}
            </button>
          ))}
        </div>

        <Input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Пошук по назві..."
          leftElement={<Search />}
          className="w-64 h-8 text-[13px]"
        />
        <Select
          value={warehouseId}
          onChange={e => setWarehouseId(e.target.value)}
          className="h-8 text-[13px] py-0.5 px-2 pr-7"
        >
          <option value="">Всі склади</option>
          {warehouses.map(w => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>

        {/* Date range — only in documents/batches modes */}
        {viewMode !== 'goods' && (
          <>
            <Input
              type="date"
              value={from}
              onChange={e => setFrom(e.target.value)}
              className="h-8 text-[13px] w-36"
            />
            <span className="text-muted-foreground text-[13px]">—</span>
            <Input
              type="date"
              value={to}
              onChange={e => setTo(e.target.value)}
              className="h-8 text-[13px] w-36"
            />
          </>
        )}

        {/* Low stock filter — only in goods mode */}
        {viewMode === 'goods' && (
          <label className="flex items-center gap-2 text-[13px] text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={showLow}
              onChange={e => setShowLow(e.target.checked)}
              className="rounded"
            />
            Тільки з низьким залишком
          </label>
        )}

        {/* Тогл бокової панелі — лише у режимі «Товари» (DetailPanel goods-only). */}
        {viewMode === 'goods' && (
          <div className="ml-auto">
            <DetailPanelToggle enabled={detailPanel.enabled} onToggle={detailPanel.toggle} />
          </div>
        )}
      </div>

      {/* Content area */}
      <div className="flex flex-1 min-h-0 gap-3">
        <div className="table-scroll-container flex-1 min-h-0 min-w-0 overflow-auto bg-surface rounded-xl border border-border">
          {loading && (
            <div className="flex justify-center py-12">
              <Spinner size="md" />
            </div>
          )}

          {/* === MODE: BY GOODS === */}
          {!loading && viewMode === 'goods' && (
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead sortKey="goodName" currentSort={invSort} onSort={toggleInvSort}>
                    Товар
                  </SortableHead>
                  <TableHead>Артикул</TableHead>
                  <TableHead>Бренд</TableHead>
                  <TableHead>Склад</TableHead>
                  <SortableHead
                    sortKey="quantity"
                    currentSort={invSort}
                    onSort={toggleInvSort}
                    className="text-right"
                  >
                    Кількість
                  </SortableHead>
                  <TableHead className="text-right">Резерв</TableHead>
                  <SortableHead
                    sortKey="available"
                    currentSort={invSort}
                    onSort={toggleInvSort}
                    className="text-right"
                  >
                    Доступно
                  </SortableHead>
                  <SortableHead
                    sortKey="salePrice"
                    currentSort={invSort}
                    onSort={toggleInvSort}
                    className="text-right"
                  >
                    Ціна продажу
                  </SortableHead>
                  <TableHead>Мін. залишок</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {displayed.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={9} className="p-0">
                      <EmptyState icon={Package} title="Позицій не знайдено" />
                    </TableCell>
                  </TableRow>
                )}
                {displayed.map(item => (
                  <TableRow
                    key={item.id}
                    onClick={() => detailPanel.enabled && setSelectedItem(item)}
                    className={cn(
                      'group transition-colors',
                      detailPanel.enabled && 'cursor-pointer',
                      item.isLow && 'bg-warning-subtle/40',
                      selectedItem?.id === item.id && detailPanel.enabled && 'bg-primary/5',
                    )}
                  >
                    <TableCell className="font-medium text-foreground">
                      {item.isLow && (
                        <AlertTriangle className="inline h-3.5 w-3.5 text-warning mr-1" />
                      )}
                      {item.goodName}
                    </TableCell>
                    <TableCell className="text-muted-foreground font-mono text-xs">
                      {item.goodSku ?? '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-[13px]">
                      {(item as StockItem & { goodBrand?: string | null }).goodBrand ?? '—'}
                    </TableCell>
                    <TableCell className="text-foreground-muted">{item.warehouseName}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {item.quantity} {item.unit}
                    </TableCell>
                    <TableCell className="text-right text-warning-text tabular-nums">
                      {item.reserved > 0 ? item.reserved : '—'}
                    </TableCell>
                    <TableCell
                      className={cn(
                        'text-right font-semibold tabular-nums',
                        item.available <= 0 ? 'text-destructive' : 'text-success',
                      )}
                    >
                      {item.available} {item.unit}
                    </TableCell>
                    <TableCell className="text-right text-foreground-muted tabular-nums">
                      {fmt(item.salePrice)}
                    </TableCell>
                    <TableCell>
                      {item.minStock != null ? (
                        <Badge variant={item.isLow ? 'warning' : 'secondary'}>
                          ≥ {item.minStock} {item.unit}
                        </Badge>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {/* === MODE: BY DOCUMENTS === */}
          {!loading && viewMode === 'documents' && (
            <ByDocumentsView
              goods={byDocData?.goods ?? []}
              expanded={expanded}
              onToggle={handleToggleExpanded}
              q={debouncedQ}
            />
          )}

          {/* === MODE: BY BATCHES === */}
          {!loading && viewMode === 'batches' && (
            <ByBatchesView
              batches={byBatchData?.batches ?? []}
              expanded={expanded}
              onToggle={handleToggleExpanded}
              q={debouncedQ}
            />
          )}
        </div>

        {/* Detail panel — only in goods mode, and only when тогл увімкнено */}
        {viewMode === 'goods' && detailPanel.enabled && (
          <InventoryDetailPanel
            selectedItem={selectedItem}
            onClose={handleCloseDetail}
            panelConfig={panelConfig}
            editingMinStock={editingMinStock}
            minStockVal={minStockVal}
            savingMinStock={savingMinStock}
            onStartEditMinStock={handleStartEditMinStock}
            onCancelEditMinStock={handleCancelEditMinStock}
            onChangeMinStockVal={setMinStockVal}
            onSaveMinStock={saveMinStock}
          />
        )}
      </div>

      {/* Low stock modal */}
      <Modal
        open={showLowModal}
        onClose={() => setShowLowModal(false)}
        title="Товари нижче мінімального залишку"
      >
        {lowItems.length === 0 ? (
          <p className="text-muted-foreground text-center py-4">
            Все гаразд — критичних позицій немає
          </p>
        ) : (
          <div className="space-y-2">
            {lowItems.map(item => (
              <div
                key={`${item.goodId}-${item.warehouseName}`}
                className="flex items-center justify-between p-3 bg-warning-subtle rounded-lg border border-warning/20"
              >
                <div>
                  <div className="font-medium text-foreground text-sm">{item.goodName}</div>
                  <div className="text-xs text-muted-foreground">{item.warehouseName}</div>
                </div>
                <div className="text-right text-sm">
                  <div className="font-semibold text-destructive">
                    {item.quantity} {item.unit}
                  </div>
                  <div className="text-foreground-faint">мін: {item.minStock}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}

// ─── By Documents View ────────────────────────────────────────────────────────

function matchesQuery(
  g: { goodName: string; goodSku?: string | null; goodBrand?: string | null },
  lower: string,
) {
  return (
    g.goodName.toLowerCase().includes(lower) ||
    (g.goodSku ?? '').toLowerCase().includes(lower) ||
    (g.goodBrand ?? '').toLowerCase().includes(lower)
  );
}

interface ByDocumentsViewProps {
  goods: GoodWithDocuments[];
  expanded: Set<string>;
  onToggle: (key: string) => void;
  q: string;
}

const ByDocumentsView = memo(function ByDocumentsView({
  goods,
  expanded,
  onToggle,
  q,
}: ByDocumentsViewProps) {
  const filtered = useMemo(() => {
    if (!q) return goods;
    const lower = q.toLowerCase();
    return goods.filter(g => matchesQuery(g, lower));
  }, [goods, q]);

  if (filtered.length === 0) {
    return <EmptyState icon={Package} title="Позицій не знайдено" />;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-8" />
          <TableHead>Товар</TableHead>
          <TableHead>Артикул</TableHead>
          <TableHead>Бренд</TableHead>
          <TableHead className="text-right">На складі</TableHead>
          <TableHead>Документ</TableHead>
          <TableHead>Тип руху</TableHead>
          <TableHead className="text-right">Кількість</TableHead>
          <TableHead>Дата</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {filtered.map(good => {
          const isOpen = expanded.has(good.goodId);
          return (
            <Fragment key={good.goodId}>
              {/* Good row */}
              <TableRow
                onClick={() => onToggle(good.goodId)}
                className="cursor-pointer hover:bg-surface-hover font-medium bg-surface"
              >
                <TableCell className="w-8 pr-0">
                  <ChevronRight
                    className={cn(
                      'h-4 w-4 text-muted-foreground transition-transform',
                      isOpen && 'rotate-90',
                    )}
                  />
                </TableCell>
                <TableCell className="font-medium text-foreground">{good.goodName}</TableCell>
                <TableCell className="text-muted-foreground font-mono text-xs">
                  {good.goodSku ?? '—'}
                </TableCell>
                <TableCell className="text-muted-foreground text-[13px]">
                  {good.goodBrand ?? '—'}
                </TableCell>
                <TableCell className="text-right tabular-nums font-semibold">
                  {good.totalQuantity} {good.goodUnit}
                </TableCell>
                <TableCell colSpan={4} className="text-muted-foreground text-[12px]">
                  {good.documents.length > 0
                    ? `${good.documents.length} документ(ів)`
                    : 'Рухів не знайдено'}
                </TableCell>
              </TableRow>

              {/* Expanded: documents and their movements */}
              {isOpen &&
                good.documents.map(doc => (
                  <Fragment key={`${good.goodId}::${doc.documentId ?? doc.documentType}`}>
                    <TableRow className="bg-surface-hover/50">
                      <TableCell className="w-8" />
                      <TableCell
                        colSpan={4}
                        className="pl-6 text-[13px] font-medium text-foreground-muted"
                      >
                        {doc.docLabel}
                      </TableCell>
                      <TableCell colSpan={4} className="text-[12px] text-muted-foreground">
                        {doc.movements.length} рух(ів)
                      </TableCell>
                    </TableRow>
                    {doc.movements.map((mv, i) => (
                      <TableRow
                        key={`${good.goodId}::${doc.documentId ?? doc.documentType}::${i}`}
                        className="bg-surface-hover/20"
                      >
                        <TableCell className="w-8" />
                        <TableCell colSpan={4} className="pl-10" />
                        <TableCell className="text-[12px] text-muted-foreground">
                          {doc.docLabel}
                        </TableCell>
                        <TableCell className="text-[12px] text-foreground">
                          {MOVEMENT_TYPE_LABELS[mv.type] ?? mv.type}
                        </TableCell>
                        <TableCell
                          className={cn(
                            'text-right tabular-nums text-[12px] font-medium',
                            mv.quantity > 0 ? 'text-success' : 'text-destructive',
                          )}
                        >
                          {mv.quantity > 0 ? '+' : ''}
                          {mv.quantity} {good.goodUnit}
                        </TableCell>
                        <TableCell className="text-[12px] text-muted-foreground">
                          {fmtDateTime(mv.createdAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </Fragment>
                ))}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
});

// ─── By Batches View ──────────────────────────────────────────────────────────

interface ByBatchesViewProps {
  batches: BatchGroup[];
  expanded: Set<string>;
  onToggle: (key: string) => void;
  q: string;
}

const ByBatchesView = memo(function ByBatchesView({
  batches,
  expanded,
  onToggle,
  q,
}: ByBatchesViewProps) {
  const filtered = useMemo(() => {
    if (!q) return batches;
    const lower = q.toLowerCase();
    return batches
      .map(bg => ({ ...bg, goods: bg.goods.filter(g => matchesQuery(g, lower)) }))
      .filter(bg => bg.goods.length > 0 || (bg.poNumber ?? '').toLowerCase().includes(lower));
  }, [batches, q]);

  if (filtered.length === 0) {
    return <EmptyState icon={Package} title="Партій не знайдено" />;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-8" />
          <TableHead>Партія / Товар</TableHead>
          <TableHead>Артикул</TableHead>
          <TableHead>Бренд</TableHead>
          <TableHead>Склад</TableHead>
          <TableHead className="text-right">Отримано</TableHead>
          <TableHead className="text-right">Залишок</TableHead>
          <TableHead>Документ руху</TableHead>
          <TableHead className="text-right">К-ть</TableHead>
          <TableHead>Дата</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {filtered.map(bg => {
          const bgOpen = expanded.has(bg.batchGroupKey);
          const bgLabel = bg.poNumber
            ? `Замовлення ${bg.poNumber}${bg.poDate ? ` від ${fmtDate(bg.poDate)}` : ''}`
            : `Партія без ЗП`;

          return (
            <Fragment key={bg.batchGroupKey}>
              {/* Batch group row */}
              <TableRow
                onClick={() => onToggle(bg.batchGroupKey)}
                className="cursor-pointer hover:bg-surface-hover font-medium bg-surface"
              >
                <TableCell className="w-8 pr-0">
                  <ChevronRight
                    className={cn(
                      'h-4 w-4 text-muted-foreground transition-transform',
                      bgOpen && 'rotate-90',
                    )}
                  />
                </TableCell>
                <TableCell className="font-medium text-foreground" colSpan={3}>
                  {bgLabel}
                </TableCell>
                <TableCell className="text-muted-foreground text-[13px]">
                  {bg.warehouseName}
                </TableCell>
                <TableCell colSpan={5} className="text-muted-foreground text-[12px]">
                  {bg.goods.length} товар(ів)
                </TableCell>
              </TableRow>

              {/* Expanded: goods in batch */}
              {bgOpen &&
                bg.goods.map(g => {
                  const goodKey = `${bg.batchGroupKey}::${g.batchId}`;
                  const goodOpen = expanded.has(goodKey);
                  return (
                    <Fragment key={goodKey}>
                      <TableRow
                        onClick={e => {
                          e.stopPropagation();
                          onToggle(goodKey);
                        }}
                        className="cursor-pointer hover:bg-surface-hover/70 bg-surface-hover/30"
                      >
                        <TableCell className="w-8" />
                        <TableCell className="pl-6 font-medium text-foreground text-[13px]">
                          <ChevronRight
                            className={cn(
                              'inline h-3.5 w-3.5 text-muted-foreground mr-1.5 transition-transform',
                              goodOpen && 'rotate-90',
                            )}
                          />
                          {g.goodName}
                        </TableCell>
                        <TableCell className="text-muted-foreground font-mono text-xs">
                          {g.goodSku ?? '—'}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-[13px]">
                          {g.goodBrand ?? '—'}
                        </TableCell>
                        <TableCell />
                        <TableCell className="text-right tabular-nums text-[13px]">
                          {g.receivedQty}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-[13px] font-semibold text-foreground">
                          {g.remainingQty}
                        </TableCell>
                        <TableCell colSpan={3} className="text-muted-foreground text-[12px]">
                          {g.consumptions.length > 0
                            ? `${g.consumptions.length} рух(ів)`
                            : 'Не витрачалась'}
                        </TableCell>
                      </TableRow>

                      {/* Expanded: consumptions */}
                      {goodOpen &&
                        g.consumptions.map((c, i) => (
                          <TableRow key={`${goodKey}::${i}`} className="bg-surface-hover/10">
                            <TableCell colSpan={7} />
                            <TableCell className="text-[12px] text-muted-foreground pl-10">
                              {c.docLabel}
                            </TableCell>
                            <TableCell
                              className={cn(
                                'text-right tabular-nums text-[12px] font-medium',
                                c.quantity < 0 ? 'text-destructive' : 'text-success',
                              )}
                            >
                              {c.quantity > 0 ? '+' : ''}
                              {c.quantity}
                            </TableCell>
                            <TableCell className="text-[12px] text-muted-foreground">
                              {fmtDateTime(c.createdAt)}
                            </TableCell>
                          </TableRow>
                        ))}
                    </Fragment>
                  );
                })}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
});

// ─── Inventory Detail Panel ───────────────────────────────────────────────────
// sto-optimize: винесено з IIFE у тілі InventoryPage щоб (1) tabs не перебудовувались
// на КОЖЕН render батька (typing у пошук, refetch), (2) memo блокує re-render коли
// selectedItem не змінився, (3) handlers стабільні через useCallback у parent.

interface InventoryDetailPanelProps {
  selectedItem: StockItem | null;
  onClose: () => void;
  panelConfig: PanelConfigHook;
  editingMinStock: boolean;
  minStockVal: string;
  savingMinStock: boolean;
  onStartEditMinStock: () => void;
  onCancelEditMinStock: () => void;
  onChangeMinStockVal: (v: string) => void;
  onSaveMinStock: () => void;
}

const InventoryDetailPanel = memo(function InventoryDetailPanel({
  selectedItem,
  onClose,
  panelConfig,
  editingMinStock,
  minStockVal,
  savingMinStock,
  onStartEditMinStock,
  onCancelEditMinStock,
  onChangeMinStockVal,
  onSaveMinStock,
}: InventoryDetailPanelProps) {
  const tabs = useMemo<DetailPanelTab[] | undefined>(() => {
    if (!selectedItem) return undefined;
    const item = selectedItem;
    return [
      {
        key: 'info',
        label: 'Основне',
        content: (
          <div className="space-y-4">
            {item.isLow && (
              <div className="flex items-center gap-2 p-2.5 bg-warning-subtle border border-warning-border rounded-lg text-[13px] text-warning-text">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>Залишок нижче мінімального</span>
              </div>
            )}
            <div className="space-y-3">
              {buildPanelFields(item, STOCK_ITEM_PANEL_SCHEMA, panelConfig.config, {
                quantity: v => `${String(v)} ${item.unit}`,
                reserved: v =>
                  Number(v) > 0 ? (
                    <span className="text-warning-text tabular-nums">
                      {String(v)} {item.unit}
                    </span>
                  ) : undefined,
                available: v => (
                  <span
                    className={cn(
                      'font-semibold tabular-nums',
                      Number(v) <= 0 ? 'text-destructive' : 'text-success',
                    )}
                  >
                    {String(v)} {item.unit}
                  </span>
                ),
                minStock: () => undefined,
              })
                .filter(f => f.key !== 'minStock')
                .map(f => (
                  <PanelField
                    key={f.key}
                    fieldKey={f.key}
                    label={f.label}
                    value={f.value}
                    hidden={f.hidden}
                  />
                ))}
            </div>
            {!panelConfig.isFieldHidden('minStock') && (
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
                    Мінімальний залишок
                  </span>
                  {!editingMinStock && (
                    <button
                      className="text-xs text-primary hover:underline"
                      onClick={onStartEditMinStock}
                    >
                      змінити
                    </button>
                  )}
                </div>
                {editingMinStock ? (
                  <div className="flex gap-1.5 mt-1.5">
                    <Input
                      type="number"
                      value={minStockVal}
                      onChange={e => onChangeMinStockVal(e.target.value)}
                      placeholder="0"
                      min="0"
                      step="1"
                      className="h-7 text-sm"
                    />
                    <Button
                      size="sm"
                      onClick={onSaveMinStock}
                      loading={savingMinStock}
                      className="h-7 px-2 text-xs"
                    >
                      Зберегти
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={onCancelEditMinStock}
                      className="h-7 px-2 text-xs"
                    >
                      ✕
                    </Button>
                  </div>
                ) : (
                  <div className="mt-1">
                    {item.minStock != null ? (
                      <Badge variant={item.isLow ? 'warning' : 'secondary'}>
                        ≥ {item.minStock} {item.unit}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground text-[12px]">не встановлено</span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ),
      },
    ];
  }, [
    selectedItem,
    panelConfig,
    editingMinStock,
    minStockVal,
    savingMinStock,
    onStartEditMinStock,
    onCancelEditMinStock,
    onChangeMinStockVal,
    onSaveMinStock,
  ]);

  const configFields = useMemo(
    () => schemaToPanelConfigFields(STOCK_ITEM_PANEL_SCHEMA, panelConfig.config),
    [panelConfig.config],
  );

  return (
    <DetailPanel
      open={!!selectedItem}
      onClose={onClose}
      title={selectedItem?.goodName ?? ''}
      tabs={tabs}
      configFields={configFields}
      onToggleField={panelConfig.toggleField}
      onReorderFields={panelConfig.reorderFields}
      onReset={panelConfig.reset}
    />
  );
});
