'use client';

import { useMemo, useState } from 'react';
import { PackageSearch } from 'lucide-react';
import { STOCK_MOVEMENT_TYPE_LABELS } from '@sto/shared';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { fmtMoney, fmtDateTime } from '@/lib/format';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { useWarehouses } from '@/hooks/api/useInfrastructure';
import { useStockMovements } from '@/hooks/api/useInventory';

// Типи-надходження показуємо зеленим (+), витрати/резерв — червоним. RESERVATION нейтральний
// (резерв не змінює фізичний залишок), але для читабельності лишаємо нейтральним.
const INCOMING = new Set(['RECEIPT', 'RETURN', 'OPENING_BALANCE']);
const OUTGOING = new Set(['WRITEOFF', 'RESERVATION']);

const PAGE_SIZE = 50;

export function StockMovementsTab() {
  const { data: warehouses } = useWarehouses();
  const [warehouseId, setWarehouseId] = useState('');
  const [type, setType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

  const filters = useMemo(
    () => ({
      warehouseId: warehouseId || undefined,
      type: type || undefined,
      from: from || undefined,
      to: to || undefined,
      page,
      limit: PAGE_SIZE,
    }),
    [warehouseId, type, from, to, page],
  );

  const { data, isLoading, isFetching } = useStockMovements(filters);
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Скидання на 1-у сторінку при зміні будь-якого фільтра.
  const resetAnd = (fn: () => void) => {
    fn();
    setPage(1);
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3 pt-3">
      {/* Фільтри */}
      <div className="flex flex-wrap items-end gap-2 shrink-0">
        <div>
          <label className="block text-[12px] text-muted-foreground mb-1">Склад</label>
          <Select
            value={warehouseId}
            onChange={e => resetAnd(() => setWarehouseId(e.target.value))}
            className="w-44 h-8 text-[13px]"
          >
            <option value="">Усі склади</option>
            {warehouses?.map(w => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <label className="block text-[12px] text-muted-foreground mb-1">Тип руху</label>
          <Select
            value={type}
            onChange={e => resetAnd(() => setType(e.target.value))}
            className="w-44 h-8 text-[13px]"
          >
            <option value="">Усі типи</option>
            {Object.entries(STOCK_MOVEMENT_TYPE_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <label className="block text-[12px] text-muted-foreground mb-1">З</label>
          <Input
            type="date"
            value={from}
            onChange={e => resetAnd(() => setFrom(e.target.value))}
            className="w-36 h-8 text-[13px]"
          />
        </div>
        <div>
          <label className="block text-[12px] text-muted-foreground mb-1">По</label>
          <Input
            type="date"
            value={to}
            onChange={e => resetAnd(() => setTo(e.target.value))}
            className="w-36 h-8 text-[13px]"
          />
        </div>
        {(warehouseId || type || from || to) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              resetAnd(() => {
                setWarehouseId('');
                setType('');
                setFrom('');
                setTo('');
              })
            }
          >
            Скинути
          </Button>
        )}
      </div>

      {/* Таблиця */}
      <div className="flex-1 min-h-0 border border-border rounded-xl bg-surface overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Дата</TableHead>
              <TableHead>Тип</TableHead>
              <TableHead>Товар</TableHead>
              <TableHead>Склад</TableHead>
              <TableHead className="text-right">Кількість</TableHead>
              <TableHead className="text-right">Ціна</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center">
                  <div className="flex justify-center">
                    <Spinner size="md" />
                  </div>
                </TableCell>
              </TableRow>
            )}
            {!isLoading && items.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="p-0">
                  <EmptyState
                    icon={PackageSearch}
                    title="Рухів немає"
                    description="За обраними фільтрами рухів по складу не знайдено"
                  />
                </TableCell>
              </TableRow>
            )}
            {items.map(m => {
              const incoming = INCOMING.has(m.type);
              const outgoing = OUTGOING.has(m.type);
              return (
                <TableRow key={m.id}>
                  <TableCell className="text-[13px] text-muted-foreground whitespace-nowrap">
                    {fmtDateTime(m.createdAt)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">
                      {STOCK_MOVEMENT_TYPE_LABELS[m.type] ?? m.type}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-medium">
                    {m.goodName}
                    {m.goodSku ? (
                      <span className="text-[12px] text-muted-foreground"> · {m.goodSku}</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-[13px] text-muted-foreground">
                    {m.warehouseName}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'text-right tabular-nums font-semibold',
                      incoming ? 'text-success' : outgoing ? 'text-destructive' : '',
                    )}
                  >
                    {m.quantity}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {m.price != null ? `${fmtMoney(m.price)} ₴` : '—'}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* Пагінація */}
      <div className="flex items-center justify-between gap-3 shrink-0 text-[13px] text-muted-foreground">
        <span>
          Всього: <b className="tabular-nums">{total}</b>
          {isFetching ? ' · оновлення…' : ''}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage(p => Math.max(1, p - 1))}
          >
            Назад
          </Button>
          <span className="tabular-nums">
            {page} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
          >
            Далі
          </Button>
        </div>
      </div>
    </div>
  );
}
