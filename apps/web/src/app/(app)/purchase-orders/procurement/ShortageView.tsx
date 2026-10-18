'use client';

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PackageSearch, ListPlus } from 'lucide-react';
import { useShortage, type ShortageRow } from '@/hooks/api/usePurchaseLists';
import { useWarehouses } from '@/hooks/api/useInfrastructure';
import { useBulkSelect } from '@/hooks/useBulkSelect';
import { useLinkedNav } from '@/lib/linked-nav';
import { useAuth } from '@/lib/auth';
import { canOpenRoute } from '@/lib/nav';
import { woStatusLabel } from '@/i18n/enumLabel';
import { fmtDate, fmtQty } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { ListLoadError } from '@/components/ui/list-load-error';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { AddToListDialog, type AddToListRow } from '@/components/ui/purchase-list/AddToListDialog';

type Row = ShortageRow & { id: string };

/**
 * «Нестача»: товари нарядів, яких бракує після резерву, позицій списків і вільного залишку
 * (BR-PL-014). Вибрані рядки — «До списку купівлі» (BR-PL-003); надсилати можуть усі ролі
 * вкладки, зокрема приймальня (BR-PL-015).
 */
export function ShortageView() {
  const { t } = useTranslation('purchaseLists');
  const nav = useLinkedNav();
  const { employee } = useAuth();
  // Комірник сторінки нарядів не має (Bug #900): номер наряду — текст, а не посилання на 403.
  const canOpenWorkOrder = canOpenRoute('/work-orders', employee?.role);
  const [warehouseId, setWarehouseId] = useState('');
  const { data: warehouses } = useWarehouses();
  const { data, isLoading, error, refetch } = useShortage({
    warehouseId: warehouseId || undefined,
    limit: 200,
  });
  const rows = useMemo<Row[]>(
    () => (data?.items ?? []).map(r => ({ ...r, id: r.workOrderPartId })),
    [data],
  );
  const bulk = useBulkSelect(rows);
  const [dialogOpen, setDialogOpen] = useState(false);
  // Рядки діалогу фіксуються в момент відкриття: діалог скидає форму, коли змінюються рядки.
  const [dialogRows, setDialogRows] = useState<AddToListRow[]>([]);
  const openDialog = () => {
    setDialogRows(
      rows
        .filter(r => bulk.isSelected(r.id))
        .map(r => ({
          workOrderId: r.workOrderId,
          workOrderPartId: r.workOrderPartId,
          label: r.goodName,
          sublabel: `${r.workOrderNumber} · ${r.warehouseName}`,
          shortage: r.shortage,
          unit: r.goodUnit,
        })),
    );
    setDialogOpen(true);
  };

  return (
    <div className="flex flex-col gap-3 flex-1 min-h-0">
      <div className="flex gap-3 flex-wrap items-end">
        <div className="w-56">
          <Select
            value={warehouseId}
            onChange={e => setWarehouseId(e.target.value)}
            aria-label={t('filters.warehouse')}
          >
            <option value="">{t('filters.allWarehouses')}</option>
            {(warehouses ?? []).map(w => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </div>
        <Button
          variant="primary"
          className="ml-auto"
          leftIcon={<ListPlus className="h-4 w-4" />}
          disabled={bulk.count === 0}
          onClick={openDialog}
        >
          {t('shortage.addToList', { count: bulk.count })}
        </Button>
      </div>

      {data?.truncated && (
        <div className="text-[12px] text-warning bg-warning-subtle rounded-lg px-3 py-2">
          {t('shortage.truncated')}
        </div>
      )}

      {error ? (
        <ListLoadError error={error} onRetry={() => void refetch()} />
      ) : isLoading || !data ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={PackageSearch}
          title={t('shortage.empty.title')}
          description={t('shortage.empty.description')}
        />
      ) : (
        <div className="rounded-xl border border-border overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <input
                    type="checkbox"
                    checked={bulk.allSelected}
                    onChange={bulk.toggleAll}
                    aria-label={t('common.selectAll')}
                  />
                </TableHead>
                <TableHead>{t('columns.workOrder')}</TableHead>
                <TableHead>{t('columns.good')}</TableHead>
                <TableHead>{t('columns.warehouse')}</TableHead>
                <TableHead className="text-right">{t('columns.required')}</TableHead>
                <TableHead className="text-right">{t('columns.reserved')}</TableHead>
                <TableHead className="text-right">{t('columns.inLists')}</TableHead>
                <TableHead className="text-right">{t('columns.fromPool')}</TableHead>
                <TableHead className="text-right">{t('columns.shortage')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(r => (
                <TableRow key={r.id} data-testid="shortage-row">
                  <TableCell>
                    <input
                      type="checkbox"
                      checked={bulk.isSelected(r.id)}
                      onChange={() => bulk.toggle(r.id)}
                      aria-label={t('shortage.selectRow', {
                        good: r.goodName,
                        wo: r.workOrderNumber,
                      })}
                    />
                  </TableCell>
                  <TableCell>
                    {canOpenWorkOrder ? (
                      <button
                        type="button"
                        className="text-primary hover:underline"
                        onClick={() => nav.toWorkOrder(r.workOrderId)}
                      >
                        {r.workOrderNumber}
                      </button>
                    ) : (
                      <span>{r.workOrderNumber}</span>
                    )}
                    <div className="text-[11px] text-muted-foreground">
                      {woStatusLabel(r.workOrderStatus)}
                      {r.plannedAt ? ` · ${fmtDate(r.plannedAt)}` : ''}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="truncate max-w-72">{r.goodName}</div>
                    {r.goodSku && (
                      <div className="text-[11px] text-muted-foreground">{r.goodSku}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{r.warehouseName}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtQty(r.required)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {fmtQty(r.reserved)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {fmtQty(r.inLists)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {fmtQty(r.fromPool)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-semibold text-warning">
                    {fmtQty(r.shortage)} {r.goodUnit ?? ''}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <AddToListDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        rows={dialogRows}
        onDone={() => bulk.clear()}
      />
    </div>
  );
}
