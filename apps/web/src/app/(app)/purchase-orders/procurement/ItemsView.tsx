'use client';

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ClipboardList,
  Search,
  ShoppingCart,
  Truck,
  ArrowRightLeft,
  XCircle,
  Wand2,
} from 'lucide-react';
import { PURCHASE_LIST_ITEM_STATUS_BADGE, WO_PROCUREMENT_ACTIVE_STATUSES } from '@sto/shared';
import { useAuth } from '@/lib/auth';
import { canOpenRoute } from '@/lib/nav';
import { useDebounce } from '@/hooks/useDebounce';
import { useBulkSelect } from '@/hooks/useBulkSelect';
import { useNow } from '@/hooks/useNow';
import { useConfirm } from '@/hooks/useConfirm';
import { useWarehouses } from '@/hooks/api/useInfrastructure';
import {
  purchaseListsApi,
  usePurchaseListItems,
  usePurchaseLists,
  type PurchaseListItem,
} from '@/hooks/api/usePurchaseLists';
import { useSupplierProcurementSettings } from '@/hooks/api/useSupplierOffers';
import { PURCHASE_DOCUMENT_ROLES } from '../purchase-roles';
import { FormDialog } from './FormDialog';
import { SupplierOptionsSelect } from './SupplierOptionsSelect';
import { createOrdersFromItems, useProcurementAction } from './useProcurementAction';
import { useLinkedNav } from '@/lib/linked-nav';
import { purchaseListItemStatusLabel, poStatusLabel } from '@/i18n/enumLabel';
import { fmtMoney, fmtQty } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { ListLoadError } from '@/components/ui/list-load-error';
import { Pagination } from '@/components/ui/pagination';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { BulkActionsBar, type BulkAction } from '@/components/ui/bulk-actions-bar';
import { SupplierOffersDialog } from '@/components/ui/purchase-list/SupplierOffersDialog';
import { AutoAllocateDialog } from '@/components/ui/purchase-list/AutoAllocateDialog';
import { OfferBadge } from '@/components/ui/purchase-list/OfferBadge';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';

const PAGE_SIZE = 50;
const NONE = 'none';

/**
 * Хто створює контрагентів (`POST /counterparties`). Решті — зокрема комірнику (BR-CP-014: лише
 * читання постачальників) — підказка «немає постачальників» радить звернутися до них, а не
 * «додайте контрагента», чого вони зробити не можуть.
 */
const COUNTERPARTY_CREATE_ROLES: readonly string[] = ['OWNER', 'ADMIN', 'RECEPTIONIST'];

/**
 * «Позиції»: що закуповуємо — з нарядів і вручну. Фільтри: статус, постачальник (зокрема «без
 * постачальника»), склад, список, пошук. Масові дії (власник, адміністратор, комірник —
 * BR-PL-015): постачальник і ціна, перенесення, «Створити замовлення» (BR-PL-008), скасування;
 * у рядку — «Розділити» й «Зняти резерв» (BR-PL-016).
 */

/**
 * «Зняти резерв» (BR-PL-016) має сенс, лише поки наряд позиції тримає резерв: на «Виконано»
 * резерв списано, на «Скасовано» / видаленні — знято (BR-WO-021), і кнопка давала б 400
 * `nothingToRelease` (Bug #913). `reservedQty` завершеного наряду лишається як історія.
 */
function reservationReleasable(i: PurchaseListItem): boolean {
  return (
    i.workOrderId === null ||
    (i.workOrderStatus != null && WO_PROCUREMENT_ACTIVE_STATUSES.includes(i.workOrderStatus))
  );
}

export function ItemsView({ canWrite }: { canWrite: boolean }) {
  const { t } = useTranslation('purchaseLists');
  const nav = useLinkedNav();
  const { confirm, dialogProps } = useConfirm();
  const [status, setStatus] = useState('OPEN');
  const [supplierId, setSupplierId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [listId, setListId] = useState('');
  const [q, setQ] = useState('');
  const debouncedQ = useDebounce(q);
  const [page, setPage] = useState(1);

  const { data: warehouses } = useWarehouses();
  const { employee } = useAuth();
  const canCreateSupplier = COUNTERPARTY_CREATE_ROLES.includes(employee?.role ?? '');
  // Комірник сторінки нарядів не має (Bug #900): номер наряду — текст, а не посилання на 403.
  const canOpenWorkOrder = canOpenRoute('/work-orders', employee?.role);
  // Приймальня відкриває «Купівлю» лише на вкладці «Управління купівлями» (BR-PL-015), картки
  // замовлення їй не відкрити (`GET /purchase-orders/:id` — 403): номер — текст (Bug #914).
  const canOpenPurchaseOrder = PURCHASE_DOCUMENT_ROLES.includes(employee?.role ?? '');
  // Постачальників понад перші 200 — пошуком на сервері (Bug #918), тому вибір — окремий компонент.
  const suppliersNoneHint = t(
    canCreateSupplier ? 'items.dialogs.suppliersNone' : 'items.dialogs.suppliersNoneAsk',
  );
  const { data: openLists } = usePurchaseLists({ status: 'OPEN', page: 1, limit: 100 });
  const { data, isLoading, error, refetch } = usePurchaseListItems({
    status: status || undefined,
    supplierId: supplierId || undefined,
    warehouseId: warehouseId || undefined,
    listId: listId || undefined,
    q: debouncedQ.trim() || undefined,
    page,
    limit: PAGE_SIZE,
  });
  const items = useMemo(() => data?.items ?? [], [data]);
  const bulk = useBulkSelect(items);
  const { busy, run, done } = useProcurementAction(bulk.clear);
  const [supplierDialog, setSupplierDialog] = useState<string[] | null>(null);
  const [moveDialog, setMoveDialog] = useState<string[] | null>(null);
  const [splitItem, setSplitItem] = useState<PurchaseListItem | null>(null);
  const [offersItem, setOffersItem] = useState<PurchaseListItem | null>(null);
  const [allocateIds, setAllocateIds] = useState<string[] | null>(null);
  // TTL пропозиції — для позначки «застаріла»; приймальні запит закритий (Bug #729), тож лише canWrite.
  const { data: offerSettings } = useSupplierProcurementSettings(canWrite);
  // Давність і «застаріла» в бейджах пропозицій — один щохвилинний таймер на таблицю.
  const now = useNow(60_000);

  const resetPage = () => setPage(1);
  const createOrders = (ids: string[]) => run(() => createOrdersFromItems(ids, confirm, t));
  const cancelItems = (ids: string[]) =>
    run(async () => {
      if (
        !(await confirm({
          title: t('items.cancelConfirm', { count: ids.length }),
          variant: 'destructive',
        }))
      )
        return null;
      await purchaseListsApi.bulkCancel(ids);
      return t('items.cancelled', { count: ids.length });
    });
  const releaseReservation = (item: PurchaseListItem) =>
    run(async () => {
      if (
        !(await confirm({
          title: t('items.releaseConfirm', { good: item.goodName }),
          message: t('items.releaseHint'),
        }))
      )
        return null;
      const res = await purchaseListsApi.releaseReservation(item.id);
      return t('items.released', { qty: fmtQty(res.released) });
    });

  const bulkActions: BulkAction[] = [
    {
      id: 'auto-allocate',
      label: t('supplierApi:allocate.action'),
      icon: <Wand2 className="h-3.5 w-3.5" />,
      disabled: busy,
      onClick: ids => setAllocateIds(ids),
    },
    {
      id: 'orders',
      label: t('items.createOrders'),
      variant: 'default',
      icon: <ShoppingCart className="h-3.5 w-3.5" />,
      disabled: busy,
      onClick: ids => void createOrders(ids),
    },
    {
      id: 'supplier',
      label: t('items.setSupplier'),
      icon: <Truck className="h-3.5 w-3.5" />,
      disabled: busy,
      onClick: ids => setSupplierDialog(ids),
    },
    {
      id: 'move',
      label: t('items.move'),
      icon: <ArrowRightLeft className="h-3.5 w-3.5" />,
      disabled: busy,
      onClick: ids => setMoveDialog(ids),
    },
    {
      id: 'cancel',
      label: t('items.cancel'),
      variant: 'destructive',
      icon: <XCircle className="h-3.5 w-3.5" />,
      disabled: busy,
      onClick: ids => void cancelItems(ids),
    },
  ];
  // Масові дії — лише над незамовленими позиціями (BR-PL-005); у фільтрі «Не замовлено» вони є.
  const selectable = canWrite && status === 'OPEN';

  return (
    <div className="flex flex-col gap-3 flex-1 min-h-0">
      <div className="flex gap-3 flex-wrap items-end">
        <div className="w-64">
          <Input
            placeholder={t('filters.search')}
            value={q}
            onChange={e => {
              setQ(e.target.value);
              resetPage();
            }}
            leftElement={<Search className="h-4 w-4" />}
            aria-label={t('filters.search')}
            // Сервер приймає q до 100 символів (@MaxLength) — довший дав би 400.
            maxLength={100}
          />
        </div>
        <div className="w-44">
          <Select
            value={status}
            onChange={e => {
              setStatus(e.target.value);
              resetPage();
              bulk.clear();
            }}
            aria-label={t('filters.status')}
          >
            <option value="">{t('filters.allStatuses')}</option>
            {(['OPEN', 'ORDERED', 'RECEIVED', 'CANCELLED'] as const).map(s => (
              <option key={s} value={s}>
                {purchaseListItemStatusLabel(s)}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <SupplierOptionsSelect
            layout="row"
            value={supplierId}
            onChange={id => {
              setSupplierId(id);
              resetPage();
            }}
            ariaLabel={t('filters.supplier')}
            enabled={!!employee}
            leading={
              <>
                <option value="">{t('filters.allSuppliers')}</option>
                <option value={NONE}>{t('filters.noSupplier')}</option>
              </>
            }
          />
        </div>
        <div className="w-44">
          <Select
            value={warehouseId}
            onChange={e => {
              setWarehouseId(e.target.value);
              resetPage();
            }}
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
        <div className="w-44">
          <Select
            value={listId}
            onChange={e => {
              setListId(e.target.value);
              resetPage();
            }}
            aria-label={t('filters.list')}
          >
            <option value="">{t('filters.allLists')}</option>
            {(openLists?.items ?? []).map(l => (
              <option key={l.id} value={l.id}>
                {l.number}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {selectable && (
        <BulkActionsBar
          count={bulk.count}
          selectedIds={Array.from(bulk.selected)}
          actions={bulkActions}
          onClear={bulk.clear}
        />
      )}

      {error ? (
        <ListLoadError error={error} onRetry={() => void refetch()} />
      ) : isLoading || !data ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title={t('items.empty.title')}
          description={t('items.empty.description')}
        />
      ) : (
        <div className="rounded-xl border border-border overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                {selectable && (
                  <TableHead className="w-10">
                    <input
                      type="checkbox"
                      checked={bulk.allSelected}
                      onChange={bulk.toggleAll}
                      aria-label={t('common.selectAll')}
                    />
                  </TableHead>
                )}
                <TableHead>{t('columns.good')}</TableHead>
                <TableHead>{t('columns.warehouse')}</TableHead>
                <TableHead className="text-right">{t('columns.quantity')}</TableHead>
                <TableHead className="text-right">{t('columns.receivedReserved')}</TableHead>
                <TableHead>{t('columns.status')}</TableHead>
                <TableHead>{t('columns.supplier')}</TableHead>
                <TableHead className="text-right">{t('columns.price')}</TableHead>
                <TableHead>{t('columns.workOrder')}</TableHead>
                <TableHead>{t('columns.list')}</TableHead>
                <TableHead>{t('columns.order')}</TableHead>
                {canWrite && <TableHead className="w-28" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map(i => (
                <TableRow key={i.id} data-testid="purchase-list-item-row">
                  {selectable && (
                    <TableCell>
                      <input
                        type="checkbox"
                        checked={bulk.isSelected(i.id)}
                        onChange={() => bulk.toggle(i.id)}
                        aria-label={t('items.selectRow', { good: i.goodName })}
                      />
                    </TableCell>
                  )}
                  <TableCell>
                    <div className="truncate max-w-72">{i.goodName}</div>
                    {i.goodSku && (
                      <div className="text-[11px] text-muted-foreground">{i.goodSku}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{i.warehouseName}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fmtQty(i.quantity)} {i.goodUnit ?? ''}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {fmtQty(i.receivedQty)} / {fmtQty(i.reservedQty)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={PURCHASE_LIST_ITEM_STATUS_BADGE[i.status] ?? 'secondary'}>
                      {purchaseListItemStatusLabel(i.status)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {i.supplierName ?? <span className="italic">{t('items.noSupplier')}</span>}
                    {i.offerKey && (
                      <div>
                        <OfferBadge
                          item={i}
                          ttlMinutes={offerSettings?.offerTtlMinutes}
                          now={now}
                        />
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {i.expectedPrice != null ? fmtMoney(i.expectedPrice) : '—'}
                  </TableCell>
                  <TableCell>
                    {i.workOrderId && !canOpenWorkOrder ? (
                      <span>{i.workOrderNumber}</span>
                    ) : i.workOrderId ? (
                      <button
                        type="button"
                        className="text-primary hover:underline"
                        onClick={() => nav.toWorkOrder(i.workOrderId as string)}
                      >
                        {i.workOrderNumber}
                      </button>
                    ) : (
                      <span className="text-muted-foreground">{t('items.manual')}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{i.listNumber}</TableCell>
                  <TableCell>
                    {i.purchaseOrderId && !canOpenPurchaseOrder ? (
                      <span>{i.purchaseOrderNumber}</span>
                    ) : i.purchaseOrderId ? (
                      <button
                        type="button"
                        className="text-primary hover:underline"
                        onClick={() => nav.toPurchaseOrder(i.purchaseOrderId as string)}
                      >
                        {i.purchaseOrderNumber}
                      </button>
                    ) : (
                      '—'
                    )}
                    {i.purchaseOrderStatus && (
                      <div className="text-[11px] text-muted-foreground">
                        {poStatusLabel(i.purchaseOrderStatus)}
                      </div>
                    )}
                  </TableCell>
                  {canWrite && (
                    <TableCell className="text-right whitespace-nowrap">
                      {i.status === 'OPEN' && (
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => setOffersItem(i)}
                          aria-label={t('supplierApi:offers.actionAria', { good: i.goodName })}
                        >
                          {t('supplierApi:offers.action')}
                        </Button>
                      )}
                      {i.status === 'OPEN' && (
                        <Button size="xs" variant="ghost" onClick={() => setSplitItem(i)}>
                          {t('items.split')}
                        </Button>
                      )}
                      {i.reservedQty > 0 && reservationReleasable(i) && (
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void releaseReservation(i)}
                        >
                          {t('items.release')}
                        </Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {data && data.total > PAGE_SIZE && (
        <Pagination page={page} totalPages={Math.ceil(data.total / PAGE_SIZE)} onChange={setPage} />
      )}

      <SupplierPriceDialog
        ids={supplierDialog}
        suppliersNoneHint={suppliersNoneHint}
        enabled={!!employee}
        onClose={() => setSupplierDialog(null)}
        onSaved={count => {
          setSupplierDialog(null);
          done(t('items.updated', { count }));
        }}
      />
      <MoveDialog
        ids={moveDialog}
        lists={openLists?.items ?? []}
        onClose={() => setMoveDialog(null)}
        onSaved={count => {
          setMoveDialog(null);
          done(t('items.moved', { count }));
        }}
      />
      <SplitDialog
        item={splitItem}
        onClose={() => setSplitItem(null)}
        onSaved={() => {
          setSplitItem(null);
          done(t('items.splitDone'));
        }}
      />
      <SupplierOffersDialog item={offersItem} onClose={() => setOffersItem(null)} />
      <AutoAllocateDialog
        ids={allocateIds}
        onClose={() => setAllocateIds(null)}
        onApplied={() => {
          setAllocateIds(null);
          bulk.clear();
        }}
      />
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}

// ─── Діалоги масових дій ─────────────────────────────────────────────────────────

function SupplierPriceDialog({
  ids,
  suppliersNoneHint,
  enabled,
  onClose,
  onSaved,
}: {
  ids: string[] | null;
  suppliersNoneHint: string;
  enabled: boolean;
  onClose: () => void;
  onSaved: (count: number) => void;
}) {
  const { t } = useTranslation('purchaseLists');
  const [supplier, setSupplier] = useState('');
  const [price, setPrice] = useState('');

  const body: { itemIds: string[]; supplierId?: string | null; expectedPrice?: number | null } = {
    itemIds: ids ?? [],
  };
  if (supplier === NONE) body.supplierId = null;
  else if (supplier) body.supplierId = supplier;
  if (price.trim()) body.expectedPrice = Number(price);

  return (
    <FormDialog
      open={ids !== null}
      onClose={onClose}
      title={t('items.dialogs.supplierTitle', { count: ids?.length ?? 0 })}
      submitLabel={t('common.save')}
      validate={() =>
        body.supplierId === undefined && body.expectedPrice === undefined
          ? t('items.dialogs.nothingToChange')
          : undefined
      }
      onSubmit={async () => {
        if (!ids) return;
        const res = await purchaseListsApi.bulkUpdate(body);
        setSupplier('');
        setPrice('');
        onSaved(res.count);
      }}
    >
      <SupplierOptionsSelect
        label={t('columns.supplier')}
        value={supplier}
        onChange={setSupplier}
        noneHint={suppliersNoneHint}
        enabled={enabled && ids !== null}
        leading={
          <>
            <option value="">{t('items.dialogs.keep')}</option>
            <option value={NONE}>{t('filters.noSupplier')}</option>
          </>
        }
      />
      <Input
        label={t('items.dialogs.price')}
        type="number"
        min="0"
        step="0.01"
        value={price}
        onChange={e => setPrice(e.target.value)}
        placeholder={t('items.dialogs.keep')}
      />
    </FormDialog>
  );
}

function MoveDialog({
  ids,
  lists,
  onClose,
  onSaved,
}: {
  ids: string[] | null;
  lists: Array<{ id: string; number: string; name: string | null }>;
  onClose: () => void;
  onSaved: (count: number) => void;
}) {
  const { t } = useTranslation('purchaseLists');
  const [targetId, setTargetId] = useState('');
  const [newName, setNewName] = useState('');

  return (
    <FormDialog
      open={ids !== null}
      onClose={onClose}
      title={t('items.dialogs.moveTitle', { count: ids?.length ?? 0 })}
      submitLabel={t('items.move')}
      onSubmit={async () => {
        if (!ids) return;
        const res = await purchaseListsApi.move(
          targetId
            ? { itemIds: ids, targetListId: targetId }
            : { itemIds: ids, newListName: newName.trim() || undefined },
        );
        setTargetId('');
        setNewName('');
        onSaved(res.count);
      }}
    >
      <Select
        label={t('items.dialogs.targetList')}
        value={targetId}
        onChange={e => setTargetId(e.target.value)}
      >
        <option value="">{t('items.dialogs.newList')}</option>
        {lists.map(l => (
          <option key={l.id} value={l.id}>
            {l.number}
            {l.name ? ` — ${l.name}` : ''}
          </option>
        ))}
      </Select>
      {!targetId && (
        <Input
          label={t('items.dialogs.newListName')}
          value={newName}
          maxLength={120}
          onChange={e => setNewName(e.target.value)}
        />
      )}
    </FormDialog>
  );
}

function SplitDialog({
  item,
  onClose,
  onSaved,
}: {
  item: PurchaseListItem | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation('purchaseLists');
  const [qty, setQty] = useState('');
  const n = Number(qty);

  return (
    <FormDialog
      open={item !== null}
      onClose={onClose}
      title={t('items.dialogs.splitTitle', { good: item?.goodName ?? '' })}
      submitLabel={t('items.split')}
      validate={() =>
        item && (!Number.isFinite(n) || n <= 0 || n >= item.quantity)
          ? t('items.dialogs.splitInvalid', { max: fmtQty(item.quantity) })
          : undefined
      }
      onSubmit={async () => {
        if (!item) return;
        await purchaseListsApi.split(item.id, n);
        setQty('');
        onSaved();
      }}
    >
      <p className="text-[13px] text-muted-foreground">
        {t('items.dialogs.splitHint', { qty: fmtQty(item?.quantity ?? 0) })}
      </p>
      <Input
        label={t('items.dialogs.splitQuantity')}
        type="number"
        min="0.001"
        step="any"
        value={qty}
        onChange={e => setQty(e.target.value)}
      />
    </FormDialog>
  );
}
