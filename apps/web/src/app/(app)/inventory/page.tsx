'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useDebounce } from '@/hooks/useDebounce';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Package, Search } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { getCached, setCache } from '@/lib/ref-cache';
import {
  useStockItems,
  useLowStockItems,
  StockItem,
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
import { useDetailPanelConfig } from '@/hooks/useDetailPanelConfig';
import {
  STOCK_ITEM_PANEL_SCHEMA,
  buildPanelFields,
  schemaToPanelConfigFields,
} from '@/lib/panel-schema';
import { cn } from '@/lib/utils';
import { fmtMoney } from '@/lib/format';

interface Warehouse {
  id: string;
  name: string;
}

// Thin proxy над module-level Intl singleton (lib/format) — без локального форматера
// у кожному файлі. Inline toLocaleString створює новий Intl.NumberFormat на кожну
// комірку × ререндер; тут — один інстанс на весь модуль.
function fmt(n: number) {
  return `${fmtMoney(n)} ₴`;
}

export default function InventoryPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'STOREKEEPER', 'RECEPTIONIST']);

  const queryClient = useQueryClient();
  const panelConfig = useDetailPanelConfig('inventory-panel');

  // Local filter & UI state
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [q, setQ] = useState('');
  const debouncedQ = useDebounce(q);
  const [showLow, setShowLow] = useState(false);
  const [error, setError] = useState('');

  // Detail panel state
  const [selectedItem, setSelectedItem] = useState<StockItem | null>(null);
  const [editingMinStock, setEditingMinStock] = useState(false);
  const [minStockVal, setMinStockVal] = useState('');
  const [savingMinStock, setSavingMinStock] = useState(false);

  // Low stock modal state
  const [showLowModal, setShowLowModal] = useState(false);

  const { sort: invSort, toggle: toggleInvSort } = useSortState('goodName', 'asc');

  // React Query hooks
  const {
    data: rawItems = [],
    isLoading: loading,
    error: queryError,
  } = useStockItems({
    warehouseId,
    q: debouncedQ,
  });

  // Client-side sort (StockItem has no indexed date fields — sort on fetched page)
  const items = useMemo(() => {
    if (!rawItems.length) return rawItems;
    const dir = invSort.sortDir === 'asc' ? 1 : -1;
    return [...rawItems].sort((a, b) => {
      if (invSort.sortBy === 'quantity') return (a.quantity - b.quantity) * dir;
      if (invSort.sortBy === 'available') return (a.available - b.available) * dir;
      if (invSort.sortBy === 'salePrice') return (a.salePrice - b.salePrice) * dir;
      // default: goodName
      return a.goodName.localeCompare(b.goodName, 'uk') * dir;
    });
  }, [rawItems, invSort]);
  const { data: lowItems = [], refetch: refetchLowItems } = useLowStockItems();

  // Reference data — paint instantly from sessionStorage, refresh in background
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
      // Invalidate the query to refresh
      queryClient.invalidateQueries({ queryKey: inventoryKeys.items() });
      setEditingMinStock(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка збереження');
    } finally {
      setSavingMinStock(false);
    }
  };

  useEffect(() => {
    loadWarehouses();
  }, [loadWarehouses]);

  const displayed = showLow ? items.filter(i => i.isLow) : items;

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
          <p className="page-subtitle">{items.length} позицій</p>
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
      <div className="flex flex-wrap gap-3 shrink-0">
        <Input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Пошук по назві..."
          leftElement={<Search />}
          className="w-64"
        />
        <Select value={warehouseId} onChange={e => setWarehouseId(e.target.value)}>
          <option value="">Всі склади</option>
          {warehouses.map(w => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>
        <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={showLow}
            onChange={e => setShowLow(e.target.checked)}
            className="rounded"
          />
          Тільки з низьким залишком
        </label>
      </div>

      {/* Table + DetailPanel */}
      <div className="flex flex-1 min-h-0 gap-3">
        <div className="flex-1 min-h-0 min-w-0 overflow-auto bg-surface rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableHead sortKey="goodName" currentSort={invSort} onSort={toggleInvSort}>
                  Товар
                </SortableHead>
                <TableHead>Артикул</TableHead>
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
              {loading && (
                <TableRow>
                  <TableCell colSpan={8} className="py-10 text-center">
                    <div className="flex justify-center">
                      <Spinner size="md" />
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {!loading && displayed.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="p-0">
                    <EmptyState icon={Package} title="Позицій не знайдено" />
                  </TableCell>
                </TableRow>
              )}
              {!loading &&
                displayed.map(item => (
                  <TableRow
                    key={item.id}
                    onClick={() => setSelectedItem(item)}
                    className={cn(
                      item.isLow && 'bg-warning-subtle/40',
                      selectedItem?.id === item.id && 'bg-primary/5',
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
                    <TableCell className="text-foreground-muted">{item.warehouseName}</TableCell>
                    <TableCell className="text-right font-medium">
                      {item.quantity} {item.unit}
                    </TableCell>
                    <TableCell className="text-right text-warning-text">
                      {item.reserved > 0 ? item.reserved : '—'}
                    </TableCell>
                    <TableCell
                      className={cn(
                        'text-right font-semibold',
                        item.available <= 0 ? 'text-destructive' : 'text-success',
                      )}
                    >
                      {item.available} {item.unit}
                    </TableCell>
                    <TableCell className="text-right text-foreground-muted">
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
        </div>

        {(() => {
          const buildInventoryTabs = (item: StockItem): DetailPanelTab[] => [
            {
              key: 'info',
              label: 'Основне',
              content: (
                <div className="space-y-4">
                  {/* Low stock warning */}
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
                      // minStock rendered separately below — skip here
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
                            onClick={() => {
                              setMinStockVal(item.minStock != null ? String(item.minStock) : '');
                              setEditingMinStock(true);
                            }}
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
                            onChange={e => setMinStockVal(e.target.value)}
                            placeholder="0"
                            min="0"
                            step="1"
                            className="h-7 text-sm"
                          />
                          <Button
                            size="sm"
                            onClick={saveMinStock}
                            loading={savingMinStock}
                            className="h-7 px-2 text-xs"
                          >
                            Зберегти
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setEditingMinStock(false)}
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
                            <span className="text-muted-foreground text-[12px]">
                              не встановлено
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ),
            },
          ];
          return (
            <DetailPanel
              open={!!selectedItem}
              onClose={() => setSelectedItem(null)}
              title={selectedItem?.goodName ?? ''}
              tabs={selectedItem ? buildInventoryTabs(selectedItem) : undefined}
              configFields={schemaToPanelConfigFields(STOCK_ITEM_PANEL_SCHEMA, panelConfig.config)}
              onToggleField={panelConfig.toggleField}
              onReorderFields={panelConfig.reorderFields}
              onReset={panelConfig.reset}
            />
          );
        })()}
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
