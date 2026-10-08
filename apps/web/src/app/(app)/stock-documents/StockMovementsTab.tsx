'use client';

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PackageSearch, Search } from 'lucide-react';
import { STOCK_MOVEMENT_TYPE_LABELS } from '@sto/shared';
import { stockMovementTypeLabel } from '@/i18n/enumLabel';
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
import { useDebounce } from '@/hooks/useDebounce';

// Колір/знак — СТРОГО за знаком записаної кількості (StockMovement.quantity), не за типом.
// Backend-конвенція знаку (createMovement): RECEIPT/OPENING_BALANCE/RETURN/RESERVATION → qty > 0;
// WRITEOFF/RESERVATION_RELEASE → qty < 0; TRANSFER — парні рухи (out < 0, in > 0). Тип-набори
// розходились із цим знаком (RESERVATION зберігається додатнім, але фарбувався червоним як
// «витрата»; RESERVATION_RELEASE/TRANSFER не класифікувались зовсім → нейтральні при від'ємному
// числі). Знак displayed-числа — єдине джерело правди: додатнє → зелене, від'ємне → червоне,
// нуль → нейтральне. Самоузгоджено з `{m.quantity}` і стійке до нових enum-значень.

const PAGE_SIZE = 50;

export function StockMovementsTab() {
  const { t } = useTranslation('stockDocuments');
  const { data: warehouses } = useWarehouses();
  const [warehouseId, setWarehouseId] = useState('');
  const [type, setType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search);
  const [page, setPage] = useState(1);

  const filters = useMemo(
    () => ({
      warehouseId: warehouseId || undefined,
      type: type || undefined,
      from: from || undefined,
      to: to || undefined,
      q: debouncedSearch.trim() || undefined,
      page,
      limit: PAGE_SIZE,
    }),
    [warehouseId, type, from, to, debouncedSearch, page],
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
          <label className="block text-[12px] text-muted-foreground mb-1">
            {t('movements.filterWarehouse')}
          </label>
          <Select
            value={warehouseId}
            onChange={e => resetAnd(() => setWarehouseId(e.target.value))}
            className="w-44 h-8 text-[13px]"
          >
            <option value="">{t('movements.allWarehouses')}</option>
            {warehouses?.map(w => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <label className="block text-[12px] text-muted-foreground mb-1">
            {t('movements.filterType')}
          </label>
          <Select
            value={type}
            onChange={e => resetAnd(() => setType(e.target.value))}
            className="w-44 h-8 text-[13px]"
          >
            <option value="">{t('movements.allTypes')}</option>
            {Object.keys(STOCK_MOVEMENT_TYPE_LABELS).map(k => (
              <option key={k} value={k}>
                {stockMovementTypeLabel(k)}
              </option>
            ))}
          </Select>
        </div>
        <Input
          value={search}
          onChange={e => resetAnd(() => setSearch(e.target.value))}
          placeholder={t('movements.searchPlaceholder')}
          aria-label={t('movements.searchPlaceholder')}
          leftElement={<Search />}
          className="w-64 h-8 text-[13px]"
        />
        <div>
          <label className="block text-[12px] text-muted-foreground mb-1">
            {t('movements.dateFrom')}
          </label>
          <Input
            type="date"
            value={from}
            onChange={e => resetAnd(() => setFrom(e.target.value))}
            className="w-36 h-8 text-[13px]"
          />
        </div>
        <div>
          <label className="block text-[12px] text-muted-foreground mb-1">
            {t('movements.dateTo')}
          </label>
          <Input
            type="date"
            value={to}
            onChange={e => resetAnd(() => setTo(e.target.value))}
            className="w-36 h-8 text-[13px]"
          />
        </div>
        {(warehouseId || type || from || to || search) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              resetAnd(() => {
                setWarehouseId('');
                setType('');
                setFrom('');
                setTo('');
                setSearch('');
              })
            }
          >
            {t('movements.reset')}
          </Button>
        )}
      </div>

      {/* Таблиця */}
      <div className="flex-1 min-h-0 border border-border rounded-xl bg-surface overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('movements.colDate')}</TableHead>
              <TableHead>{t('movements.colType')}</TableHead>
              <TableHead>{t('movements.colGood')}</TableHead>
              <TableHead>{t('movements.colWarehouse')}</TableHead>
              <TableHead className="text-right">{t('movements.colQuantity')}</TableHead>
              <TableHead className="text-right">{t('movements.colPrice')}</TableHead>
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
                    title={t('movements.emptyTitle')}
                    description={t('movements.emptyDescription')}
                  />
                </TableCell>
              </TableRow>
            )}
            {items.map(m => {
              const incoming = m.quantity > 0;
              const outgoing = m.quantity < 0;
              return (
                <TableRow key={m.id}>
                  <TableCell className="text-[13px] text-muted-foreground whitespace-nowrap">
                    {fmtDateTime(m.createdAt)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{stockMovementTypeLabel(m.type)}</Badge>
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
          {t('movements.total')} <b className="tabular-nums">{total}</b>
          {isFetching ? t('movements.updating') : ''}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage(p => Math.max(1, p - 1))}
          >
            {t('movements.prev')}
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
            {t('movements.next')}
          </Button>
        </div>
      </div>
    </div>
  );
}
