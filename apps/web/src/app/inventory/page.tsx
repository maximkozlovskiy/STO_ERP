'use client';

import { useEffect, useState, useCallback } from 'react';
import { AlertTriangle, Package, Search } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

interface Warehouse { id: string; name: string; }
interface StockItem {
  id: string; goodId: string; goodName: string; goodSku: string | null; unit: string;
  salePrice: number; warehouseId: string; warehouseName: string;
  quantity: number; reserved: number; available: number;
  minStock: number | null; isLow: boolean;
}

function fmt(n: number) {
  return n.toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₴';
}

export default function InventoryPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'STOREKEEPER', 'RECEPTIONIST']);

  const [items, setItems] = useState<StockItem[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [q, setQ] = useState('');
  const [showLow, setShowLow] = useState(false);
  const [loading, setLoading] = useState(true);
  const [lowItems, setLowItems] = useState<StockItem[]>([]);
  const [showLowModal, setShowLowModal] = useState(false);
  const [error, setError] = useState('');

  const loadWarehouses = useCallback(async () => {
    try {
      const data = await apiFetch<Warehouse[] | { items: Warehouse[] }>('/warehouses');
      setWarehouses(Array.isArray(data) ? data : data.items);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка завантаження складів'); }
  }, []);

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (warehouseId) params.set('warehouseId', warehouseId);
      if (q) params.set('q', q);
      const data = await apiFetch<StockItem[]>(`/stock-items?${params}`);
      setItems(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка завантаження');
    } finally {
      setLoading(false);
    }
  }, [warehouseId, q]);

  const loadLow = useCallback(async (): Promise<boolean> => {
    try {
      const data = await apiFetch<StockItem[]>('/stock-items/low');
      setLowItems(data);
      return true;
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка завантаження'); return false; }
  }, []);

  useEffect(() => { loadWarehouses(); }, [loadWarehouses]);
  useEffect(() => { loadItems(); }, [loadItems]);

  const displayed = showLow ? items.filter(i => i.isLow) : items;

  return (
    <div className="page-container">
      {error && (
        <div className="mb-4 text-sm text-[hsl(0_84%_42%)] bg-destructive-subtle border border-destructive/20 rounded-lg px-4 py-2.5">{error}</div>
      )}
      <div className="page-header">
        <div>
          <h1 className="page-title">Залишки на складах</h1>
          <p className="page-subtitle">{items.length} позицій</p>
        </div>
        <Button
          variant="outline"
          onClick={async () => { if (await loadLow()) setShowLowModal(true); }}
          className="text-[hsl(38_92%_30%)] border-warning/30 bg-warning-subtle hover:bg-warning-subtle/80"
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
        <Select
          value={warehouseId}
          onChange={e => setWarehouseId(e.target.value)}
        >
          <option value="">Всі склади</option>
          {warehouses.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
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

      {/* Table */}
      <div className="bg-surface rounded-xl border border-border overflow-hidden">
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
                  <div className="flex justify-center"><Spinner size="md" /></div>
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
            {!loading && displayed.map(item => (
              <TableRow key={item.id} className={cn(item.isLow && 'bg-warning-subtle/40')}>
                <TableCell className="font-medium text-foreground">
                  {item.isLow && <AlertTriangle className="inline h-3.5 w-3.5 text-warning mr-1" />}
                  {item.goodName}
                </TableCell>
                <TableCell className="text-muted-foreground font-mono text-xs">{item.goodSku ?? '—'}</TableCell>
                <TableCell className="text-foreground-muted">{item.warehouseName}</TableCell>
                <TableCell className="text-right font-medium">{item.quantity} {item.unit}</TableCell>
                <TableCell className="text-right text-[hsl(25_95%_53%)]">{item.reserved > 0 ? item.reserved : '—'}</TableCell>
                <TableCell className={cn('text-right font-semibold', item.available <= 0 ? 'text-destructive' : 'text-success')}>
                  {item.available} {item.unit}
                </TableCell>
                <TableCell className="text-right text-foreground-muted">{fmt(item.salePrice)}</TableCell>
                <TableCell>
                  {item.minStock != null ? (
                    <Badge variant={item.isLow ? 'warning' : 'secondary'}>
                      ≥ {item.minStock} {item.unit}
                    </Badge>
                  ) : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Low stock modal */}
      <Modal
        open={showLowModal}
        onClose={() => setShowLowModal(false)}
        title="Товари нижче мінімального залишку"
      >
        {lowItems.length === 0 ? (
          <p className="text-muted-foreground text-center py-4">Все гаразд — критичних позицій немає</p>
        ) : (
          <div className="space-y-2">
            {lowItems.map((item, i) => (
              <div key={i} className="flex items-center justify-between p-3 bg-warning-subtle rounded-lg border border-warning/20">
                <div>
                  <div className="font-medium text-foreground text-sm">{item.goodName}</div>
                  <div className="text-xs text-muted-foreground">{item.warehouseName}</div>
                </div>
                <div className="text-right text-sm">
                  <div className="font-semibold text-destructive">{item.quantity} {item.unit}</div>
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
