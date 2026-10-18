'use client';

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ClipboardList,
  Search,
  ShoppingCart,
  Truck,
  ArrowRightLeft,
  XCircle,
  Wand2,
} from 'lucide-react';
import { PURCHASE_LIST_ITEM_STATUS_BADGE } from '@sto/shared';
import { apiFetch } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { useDebounce } from '@/hooks/useDebounce';
import { useBulkSelect } from '@/hooks/useBulkSelect';
import { useConfirm } from '@/hooks/useConfirm';
import { useWarehouses } from '@/hooks/api/useInfrastructure';
import {
  purchaseListsApi,
  usePurchaseListItems,
  usePurchaseLists,
  type PurchaseListItem,
} from '@/hooks/api/usePurchaseLists';
import { useSupplierProcurementSettings } from '@/hooks/api/useSupplierOffers';
import { invalidateProcurementSideEffects } from '@/lib/cache-invalidation';
import { useLinkedNav } from '@/lib/linked-nav';
import { purchaseListItemStatusLabel, poStatusLabel } from '@/i18n/enumLabel';
import { fmtMoney, fmtQty } from '@/lib/format';
import { toast } from '@/lib/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Modal } from '@/components/ui/modal';
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

interface SupplierOption {
  id: string;
  name: string;
}

/**
 * Постачальники для фільтра й масової зміни. `GET /counterparties` закритий комірнику (ролі
 * контрагентів), тож для нього список порожній — постачальник позиції лишається тим, що дав
 * товар (бажаний постачальник), а змінює його власник чи адміністратор.
 */
function useSupplierOptions() {
  const { employee } = useAuth();
  return useQuery<SupplierOption[]>({
    queryKey: ['purchase-lists', 'supplier-options'],
    queryFn: ({ signal }) =>
      apiFetch<{
        items: Array<{
          id: string;
          companyName?: string | null;
          firstName?: string | null;
          lastName?: string | null;
        }>;
      }>('/counterparties?types=SUPPLIER&types=BOTH&limit=200', { signal }).then(r =>
        (r.items ?? []).map(c => ({
          id: c.id,
          name: c.companyName || [c.lastName, c.firstName].filter(Boolean).join(' ') || c.id,
        })),
      ),
    enabled: !!employee && employee.role !== 'STOREKEEPER',
    staleTime: 5 * 60_000,
  });
}

/**
 * «Позиції»: що закуповуємо — з нарядів і вручну. Фільтри: статус, постачальник (зокрема «без
 * постачальника»), склад, список, пошук. Масові дії (власник, адміністратор, комірник —
 * BR-PL-015): постачальник і ціна, перенесення, «Створити замовлення» (BR-PL-008), скасування;
 * у рядку — «Розділити» й «Зняти резерв» (BR-PL-016).
 */
export function ItemsView({ canWrite }: { canWrite: boolean }) {
  const { t } = useTranslation('purchaseLists');
  const qc = useQueryClient();
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
  const { data: suppliers } = useSupplierOptions();
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
  const [busy, setBusy] = useState(false);
  const [supplierDialog, setSupplierDialog] = useState<string[] | null>(null);
  const [moveDialog, setMoveDialog] = useState<string[] | null>(null);
  const [splitItem, setSplitItem] = useState<PurchaseListItem | null>(null);
  const [offersItem, setOffersItem] = useState<PurchaseListItem | null>(null);
  const [allocateIds, setAllocateIds] = useState<string[] | null>(null);
  // TTL пропозиції — для позначки «застаріла»; приймальні запит закритий (Bug #729), тож лише canWrite.
  const { data: offerSettings } = useSupplierProcurementSettings(canWrite);

  const resetPage = () => setPage(1);
  const done = (message: string) => {
    toast.success(message);
    bulk.clear();
    invalidateProcurementSideEffects(qc);
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : t('errors.action'));
      invalidateProcurementSideEffects(qc);
    } finally {
      setBusy(false);
    }
  };

  const createOrders = (ids: string[]) =>
    run(async () => {
      if (!(await confirm({ title: t('items.createOrdersConfirm', { count: ids.length }) })))
        return;
      const res = await purchaseListsApi.createOrders(ids);
      done(t('items.ordersCreated', { numbers: res.orders.map(o => o.number).join(', ') }));
    });
  const cancelItems = (ids: string[]) =>
    run(async () => {
      if (
        !(await confirm({
          title: t('items.cancelConfirm', { count: ids.length }),
          variant: 'destructive',
        }))
      )
        return;
      await purchaseListsApi.bulkCancel(ids);
      done(t('items.cancelled', { count: ids.length }));
    });
  const releaseReservation = (item: PurchaseListItem) =>
    run(async () => {
      if (
        !(await confirm({
          title: t('items.releaseConfirm', { good: item.goodName }),
          message: t('items.releaseHint'),
        }))
      )
        return;
      const res = await purchaseListsApi.releaseReservation(item.id);
      done(t('items.released', { qty: fmtQty(res.released) }));
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
        <div className="w-52">
          <Select
            value={supplierId}
            onChange={e => {
              setSupplierId(e.target.value);
              resetPage();
            }}
            aria-label={t('filters.supplier')}
          >
            <option value="">{t('filters.allSuppliers')}</option>
            <option value={NONE}>{t('filters.noSupplier')}</option>
            {(suppliers ?? []).map(s => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
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
                        <OfferBadge item={i} ttlMinutes={offerSettings?.offerTtlMinutes} />
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {i.expectedPrice != null ? fmtMoney(i.expectedPrice) : '—'}
                  </TableCell>
                  <TableCell>
                    {i.workOrderId ? (
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
                    {i.purchaseOrderId ? (
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
                      {i.reservedQty > 0 && (
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
        suppliers={suppliers ?? []}
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

function DialogError({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div className="text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">
      {message}
    </div>
  );
}

function SupplierPriceDialog({
  ids,
  suppliers,
  onClose,
  onSaved,
}: {
  ids: string[] | null;
  suppliers: SupplierOption[];
  onClose: () => void;
  onSaved: (count: number) => void;
}) {
  const { t } = useTranslation('purchaseLists');
  const [supplier, setSupplier] = useState('');
  const [price, setPrice] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const open = ids !== null;

  const save = async () => {
    if (!ids) return;
    const body: { itemIds: string[]; supplierId?: string | null; expectedPrice?: number | null } = {
      itemIds: ids,
    };
    if (supplier === NONE) body.supplierId = null;
    else if (supplier) body.supplierId = supplier;
    if (price.trim()) body.expectedPrice = Number(price);
    if (body.supplierId === undefined && body.expectedPrice === undefined) {
      setErr(t('items.dialogs.nothingToChange'));
      return;
    }
    setSaving(true);
    setErr('');
    try {
      const res = await purchaseListsApi.bulkUpdate(body);
      setSupplier('');
      setPrice('');
      onSaved(res.count);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : t('errors.action'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('items.dialogs.supplierTitle', { count: ids?.length ?? 0 })}
      size="sm"
      onSubmit={() => void save()}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void save()} loading={saving}>
            {t('common.save')}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Select
          label={t('columns.supplier')}
          value={supplier}
          onChange={e => setSupplier(e.target.value)}
          hint={suppliers.length === 0 ? t('items.dialogs.suppliersUnavailable') : undefined}
        >
          <option value="">{t('items.dialogs.keep')}</option>
          <option value={NONE}>{t('filters.noSupplier')}</option>
          {suppliers.map(s => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        <Input
          label={t('items.dialogs.price')}
          type="number"
          min="0"
          step="0.01"
          value={price}
          onChange={e => setPrice(e.target.value)}
          placeholder={t('items.dialogs.keep')}
        />
        <DialogError message={err} />
      </div>
    </Modal>
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
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    if (!ids) return;
    setSaving(true);
    setErr('');
    try {
      const res = await purchaseListsApi.move(
        targetId
          ? { itemIds: ids, targetListId: targetId }
          : { itemIds: ids, newListName: newName.trim() || undefined },
      );
      setTargetId('');
      setNewName('');
      onSaved(res.count);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : t('errors.action'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={ids !== null}
      onClose={onClose}
      title={t('items.dialogs.moveTitle', { count: ids?.length ?? 0 })}
      size="sm"
      onSubmit={() => void save()}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void save()} loading={saving}>
            {t('items.move')}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
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
        <DialogError message={err} />
      </div>
    </Modal>
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
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    if (!item) return;
    const n = Number(qty);
    if (!Number.isFinite(n) || n <= 0 || n >= item.quantity) {
      setErr(t('items.dialogs.splitInvalid', { max: fmtQty(item.quantity) }));
      return;
    }
    setSaving(true);
    setErr('');
    try {
      await purchaseListsApi.split(item.id, n);
      setQty('');
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : t('errors.action'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={item !== null}
      onClose={onClose}
      title={t('items.dialogs.splitTitle', { good: item?.goodName ?? '' })}
      size="sm"
      onSubmit={() => void save()}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void save()} loading={saving}>
            {t('items.split')}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
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
        <DialogError message={err} />
      </div>
    </Modal>
  );
}
