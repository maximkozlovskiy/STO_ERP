'use client';

import { useEffect, useState, useCallback } from 'react';
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
  TableCell,
} from '@/components/ui/table';
import { DetailPanel } from '@/components/ui/detail-panel';
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

  // React Query hooks
  const {
    data: items = [],
    isLoading: loading,
    error: queryError,
  } = useStockItems({
    warehouseId,
    q: debouncedQ,
  });
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
    <div className="page-container">
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
      <div className="flex flex-wrap gap-3 mb-5">
        <div className="relative w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Пошук по назві..."
            className="pl-9"
          />
        </div>
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
      <div className="flex gap-3">
        <div className="flex-1 min-w-0 overflow-auto bg-surface rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Товар</TableHead>
                <TableHead>Артикул</TableHead>
                <TableHead>Склад</TableHead>
                <TableHead className="text-right">Кількість</TableHead>
                <TableHead className="text-right">Резерв</TableHead>
                <TableHead className="text-right">Доступно</TableHead>
                <TableHead className="text-right">Ціна продажу</TableHead>
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

        <DetailPanel
          open={!!selectedItem}
          onClose={() => setSelectedItem(null)}
          title={selectedItem?.goodName ?? ''}
        >
          {selectedItem && (
            <div className="space-y-4">
              {/* Low stock warning */}
              {selectedItem.isLow && (
                <div className="flex items-center gap-2 p-2.5 bg-warning-subtle border border-warning-border rounded-lg text-[13px] text-warning-text">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  <span>Залишок нижче мінімального</span>
                </div>
              )}

              <div className="space-y-2 text-[13px]">
                <div>
                  <span className="text-muted-foreground">Артикул (SKU)</span>
                  <p className="font-mono font-medium text-foreground mt-0.5">
                    {selectedItem.goodSku ?? '—'}
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">Склад</span>
                  <p className="font-medium text-foreground mt-0.5">{selectedItem.warehouseName}</p>
                </div>
              </div>

              {/* Stock quantities */}
              <div className="rounded-lg border border-border divide-y divide-border">
                <div className="flex items-center justify-between px-3 py-2 text-[13px]">
                  <span className="text-muted-foreground">Кількість</span>
                  <span className="font-medium text-foreground tabular-nums">
                    {selectedItem.quantity} {selectedItem.unit}
                  </span>
                </div>
                <div className="flex items-center justify-between px-3 py-2 text-[13px]">
                  <span className="text-muted-foreground">Резерв</span>
                  <span
                    className={cn(
                      'font-medium tabular-nums',
                      selectedItem.reserved > 0 ? 'text-warning-text' : 'text-muted-foreground',
                    )}
                  >
                    {selectedItem.reserved > 0
                      ? `${selectedItem.reserved} ${selectedItem.unit}`
                      : '—'}
                  </span>
                </div>
                <div className="flex items-center justify-between px-3 py-2 text-[13px]">
                  <span className="text-muted-foreground">Доступно</span>
                  <span
                    className={cn(
                      'font-semibold tabular-nums',
                      selectedItem.available <= 0 ? 'text-destructive' : 'text-success',
                    )}
                  >
                    {selectedItem.available} {selectedItem.unit}
                  </span>
                </div>
              </div>

              <div className="space-y-2 text-[13px]">
                <div>
                  <span className="text-muted-foreground">Ціна продажу</span>
                  <p className="font-semibold text-foreground mt-0.5">
                    {fmt(selectedItem.salePrice)}
                  </p>
                </div>
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Мінімальний залишок</span>
                    {!editingMinStock && (
                      <button
                        className="text-xs text-primary hover:underline"
                        onClick={() => {
                          setMinStockVal(
                            selectedItem.minStock != null ? String(selectedItem.minStock) : '',
                          );
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
                      {selectedItem.minStock != null ? (
                        <Badge variant={selectedItem.isLow ? 'warning' : 'secondary'}>
                          ≥ {selectedItem.minStock} {selectedItem.unit}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground text-[12px]">не встановлено</span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </DetailPanel>
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
            {lowItems.map((item, i) => (
              <div
                key={i}
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
