'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { ListChecks, Merge, Plus, Search } from 'lucide-react';
import { PURCHASE_LIST_ITEM_STATUS_BADGE, PURCHASE_LIST_STATUS_BADGE } from '@sto/shared';
import { useDebounce } from '@/hooks/useDebounce';
import { useBulkSelect } from '@/hooks/useBulkSelect';
import { useConfirm } from '@/hooks/useConfirm';
import { useWarehouses } from '@/hooks/api/useInfrastructure';
import {
  purchaseListsApi,
  usePurchaseListDetail,
  usePurchaseLists,
  type PurchaseList,
} from '@/hooks/api/usePurchaseLists';
import { invalidateProcurementSideEffects } from '@/lib/cache-invalidation';
import { FormDialog } from './FormDialog';
import { createOrdersFromItems, useProcurementAction } from './useProcurementAction';
import { purchaseListItemStatusLabel, purchaseListStatusLabel } from '@/i18n/enumLabel';
import { fmtDate, fmtQty } from '@/lib/format';
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
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import { fetchGoodPickerItems, type GoodPickerItem } from '@/components/ui/GoodPickerModal';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';

const PAGE_SIZE = 20;

/**
 * «Списки»: списки купівлі, новий список, об'єднання (BR-PL-006). Картка списку — позиції,
 * «Винести в новий список» (розділення, BR-PL-007), ручна позиція (BR-PL-004), «Створити
 * замовлення» (BR-PL-008), закриття, скасування, видалення.
 */
export function ListsView({
  canWrite,
  openListId,
}: {
  canWrite: boolean;
  openListId: string | null;
}) {
  const { t } = useTranslation('purchaseLists');
  const qc = useQueryClient();
  const [status, setStatus] = useState('OPEN');
  const [q, setQ] = useState('');
  const debouncedQ = useDebounce(q);
  const [page, setPage] = useState(1);
  const { data, isLoading, error, refetch } = usePurchaseLists({
    status: status || undefined,
    q: debouncedQ.trim() || undefined,
    page,
    limit: PAGE_SIZE,
  });
  const lists = useMemo(() => data?.items ?? [], [data]);
  const bulk = useBulkSelect(lists);
  const [detailId, setDetailId] = useState<string | null>(openListId);
  const [createOpen, setCreateOpen] = useState(false);
  const [mergeIds, setMergeIds] = useState<string[] | null>(null);

  useEffect(() => {
    if (openListId) setDetailId(openListId);
  }, [openListId]);

  const selectedOpen = lists.filter(l => bulk.isSelected(l.id) && l.status === 'OPEN');

  return (
    <div className="flex flex-col gap-3 flex-1 min-h-0">
      <div className="flex gap-3 flex-wrap items-end">
        <div className="w-64">
          <Input
            placeholder={t('filters.searchLists')}
            value={q}
            onChange={e => {
              setQ(e.target.value);
              setPage(1);
            }}
            leftElement={<Search className="h-4 w-4" />}
            aria-label={t('filters.searchLists')}
            // Сервер приймає q до 100 символів (@MaxLength) — довший дав би 400.
            maxLength={100}
          />
        </div>
        <div className="w-44">
          <Select
            value={status}
            onChange={e => {
              setStatus(e.target.value);
              setPage(1);
            }}
            aria-label={t('filters.status')}
          >
            <option value="">{t('filters.allStatuses')}</option>
            {(['OPEN', 'CLOSED', 'CANCELLED'] as const).map(s => (
              <option key={s} value={s}>
                {purchaseListStatusLabel(s)}
              </option>
            ))}
          </Select>
        </div>
        <div className="ml-auto flex gap-2">
          {canWrite && (
            <Button
              variant="outline"
              leftIcon={<Merge className="h-4 w-4" />}
              disabled={selectedOpen.length < 2}
              onClick={() => setMergeIds(selectedOpen.map(l => l.id))}
            >
              {t('lists.merge')}
            </Button>
          )}
          <Button
            variant="primary"
            leftIcon={<Plus className="h-4 w-4" />}
            onClick={() => setCreateOpen(true)}
          >
            {t('lists.create')}
          </Button>
        </div>
      </div>

      {error ? (
        <ListLoadError error={error} onRetry={() => void refetch()} />
      ) : isLoading || !data ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : lists.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title={t('lists.empty.title')}
          description={t('lists.empty.description')}
        />
      ) : (
        <div className="rounded-xl border border-border overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                {canWrite && <TableHead className="w-10" />}
                <TableHead>{t('columns.number')}</TableHead>
                <TableHead>{t('columns.name')}</TableHead>
                <TableHead>{t('columns.status')}</TableHead>
                <TableHead className="text-right">{t('columns.itemsCount')}</TableHead>
                <TableHead>{t('columns.warehouse')}</TableHead>
                <TableHead>{t('columns.created')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lists.map(l => (
                <TableRow
                  key={l.id}
                  className="cursor-pointer"
                  onClick={() => setDetailId(l.id)}
                  data-testid="purchase-list-row"
                >
                  {canWrite && (
                    <TableCell onClick={e => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={bulk.isSelected(l.id)}
                        onChange={() => bulk.toggle(l.id)}
                        disabled={l.status !== 'OPEN'}
                        aria-label={t('lists.selectRow', { number: l.number })}
                      />
                    </TableCell>
                  )}
                  <TableCell className="font-medium">{l.number}</TableCell>
                  <TableCell className="text-muted-foreground">{l.name ?? '—'}</TableCell>
                  <TableCell>
                    <Badge variant={PURCHASE_LIST_STATUS_BADGE[l.status] ?? 'secondary'}>
                      {purchaseListStatusLabel(l.status)}
                    </Badge>
                    {l.mergedIntoNumber && (
                      <div className="text-[11px] text-muted-foreground">
                        {t('lists.mergedInto', { number: l.mergedIntoNumber })}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {t('lists.counts', {
                      open: l.openCount,
                      ordered: l.orderedCount,
                      received: l.receivedCount,
                    })}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{l.warehouseName ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground">{fmtDate(l.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {data && data.total > PAGE_SIZE && (
        <Pagination page={page} totalPages={Math.ceil(data.total / PAGE_SIZE)} onChange={setPage} />
      )}

      <CreateListDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={list => {
          setCreateOpen(false);
          invalidateProcurementSideEffects(qc);
          toast.success(t('lists.created', { number: list.number }));
          setDetailId(list.id);
        }}
      />
      <MergeDialog
        lists={lists.filter(l => mergeIds?.includes(l.id))}
        open={mergeIds !== null}
        onClose={() => setMergeIds(null)}
        onMerged={number => {
          setMergeIds(null);
          bulk.clear();
          invalidateProcurementSideEffects(qc);
          toast.success(t('lists.merged', { number }));
        }}
      />
      <ListDetailModal listId={detailId} canWrite={canWrite} onClose={() => setDetailId(null)} />
    </div>
  );
}

// ─── Новий список і об'єднання ──────────────────────────────────────────────────

function CreateListDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (list: PurchaseList) => void;
}) {
  const { t } = useTranslation('purchaseLists');
  const [name, setName] = useState('');

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={t('lists.create')}
      submitLabel={t('lists.create')}
      errorAs="text"
      onSubmit={async () => {
        const list = await purchaseListsApi.createList(name.trim() ? { name: name.trim() } : {});
        setName('');
        onCreated(list);
      }}
    >
      <Input
        label={t('columns.name')}
        value={name}
        maxLength={120}
        onChange={e => setName(e.target.value)}
        placeholder={t('lists.namePlaceholder')}
      />
    </FormDialog>
  );
}

function MergeDialog({
  lists,
  open,
  onClose,
  onMerged,
}: {
  lists: PurchaseList[];
  open: boolean;
  onClose: () => void;
  onMerged: (targetNumber: string) => void;
}) {
  const { t } = useTranslation('purchaseLists');
  const [targetId, setTargetId] = useState('');

  useEffect(() => {
    if (open) setTargetId(lists[0]?.id ?? '');
  }, [open, lists]);

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={t('lists.mergeTitle', { count: lists.length })}
      description={t('lists.mergeHint')}
      submitLabel={t('lists.merge')}
      resetErrorOnOpen
      errorAs="text"
      onSubmit={async () => {
        const target = lists.find(l => l.id === targetId);
        if (!target) return;
        await purchaseListsApi.merge({
          targetListId: target.id,
          sourceListIds: lists.filter(l => l.id !== target.id).map(l => l.id),
        });
        onMerged(target.number);
      }}
    >
      <Select
        label={t('lists.mergeTarget')}
        value={targetId}
        onChange={e => setTargetId(e.target.value)}
      >
        {lists.map(l => (
          <option key={l.id} value={l.id}>
            {l.number}
            {l.name ? ` — ${l.name}` : ''}
          </option>
        ))}
      </Select>
    </FormDialog>
  );
}

// ─── Картка списку ──────────────────────────────────────────────────────────────

function ListDetailModal({
  listId,
  canWrite,
  onClose,
}: {
  listId: string | null;
  canWrite: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('purchaseLists');
  const qc = useQueryClient();
  const { confirm, dialogProps } = useConfirm();
  const { data: list, isLoading, error } = usePurchaseListDetail(listId);
  const items = useMemo(() => list?.items ?? [], [list]);
  const openItems = useMemo(() => items.filter(i => i.status === 'OPEN'), [items]);
  const bulk = useBulkSelect(openItems);
  // Відмова в підтвердженні тут повертає '' (а не null): вибір знімається й список перечитується.
  const { busy, run: act } = useProcurementAction(bulk.clear);
  const [addOpen, setAddOpen] = useState(false);
  const isOpen = list?.status === 'OPEN';

  const ids = Array.from(bulk.selected);
  const splitOut = () =>
    act(async () => {
      const res = await purchaseListsApi.move({
        itemIds: ids,
        newListName: list?.name ?? undefined,
      });
      return t('lists.splitDone', { count: res.count });
    });
  const createOrders = () => act(async () => (await createOrdersFromItems(ids, confirm, t)) ?? '');
  const closeList = () =>
    act(async () => {
      if (!list) return '';
      if (!(await confirm({ title: t('lists.closeConfirm', { number: list.number }) }))) return '';
      await purchaseListsApi.close(list.id);
      return t('lists.closed', { number: list.number });
    });
  const cancelList = () =>
    act(async () => {
      if (!list) return '';
      if (
        !(await confirm({
          title: t('lists.cancelConfirm', { number: list.number }),
          variant: 'destructive',
        }))
      )
        return '';
      await purchaseListsApi.cancel(list.id);
      return t('lists.cancelled', { number: list.number });
    });
  const removeList = () =>
    act(async () => {
      if (!list) return '';
      if (
        !(await confirm({
          title: t('lists.deleteConfirm', { number: list.number }),
          variant: 'destructive',
        }))
      )
        return '';
      await purchaseListsApi.remove(list.id);
      onClose();
      return t('lists.deleted', { number: list.number });
    });

  return (
    <>
      <Modal
        open={listId !== null}
        onClose={onClose}
        title={list ? t('lists.detailTitle', { number: list.number }) : t('lists.detailLoading')}
        description={list?.name ?? undefined}
        size="xl"
        footer={
          canWrite && list ? (
            <div className="flex flex-wrap justify-between gap-2">
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => void removeList()} disabled={busy}>
                  {t('lists.delete')}
                </Button>
                {isOpen && (
                  <Button variant="ghost" onClick={() => void cancelList()} disabled={busy}>
                    {t('lists.cancel')}
                  </Button>
                )}
              </div>
              {isOpen && (
                <Button variant="outline" onClick={() => void closeList()} disabled={busy}>
                  {t('lists.close')}
                </Button>
              )}
            </div>
          ) : undefined
        }
      >
        {error ? (
          <ListLoadError error={error} />
        ) : isLoading || !list ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={PURCHASE_LIST_STATUS_BADGE[list.status] ?? 'secondary'}>
                {purchaseListStatusLabel(list.status)}
              </Badge>
              {canWrite && isOpen && (
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto"
                  leftIcon={<Plus className="h-3.5 w-3.5" />}
                  onClick={() => setAddOpen(true)}
                >
                  {t('lists.addItem')}
                </Button>
              )}
            </div>
            {canWrite && bulk.count > 0 && (
              <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-primary-subtle border border-primary/20 rounded-lg">
                <span className="text-[13px] font-medium text-primary">
                  {t('common.selected', { count: bulk.count })}
                </span>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  onClick={() => void createOrders()}
                >
                  {t('items.createOrders')}
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void splitOut()}>
                  {t('lists.splitOut')}
                </Button>
              </div>
            )}
            {items.length === 0 ? (
              <p className="text-[13px] text-muted-foreground py-6 text-center">
                {t('lists.noItems')}
              </p>
            ) : (
              <div className="rounded-lg border border-border overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {canWrite && <TableHead className="w-10" />}
                      <TableHead>{t('columns.good')}</TableHead>
                      <TableHead>{t('columns.warehouse')}</TableHead>
                      <TableHead className="text-right">{t('columns.quantity')}</TableHead>
                      <TableHead>{t('columns.status')}</TableHead>
                      <TableHead>{t('columns.supplier')}</TableHead>
                      <TableHead>{t('columns.workOrder')}</TableHead>
                      <TableHead>{t('columns.order')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map(i => (
                      <TableRow key={i.id} data-testid="purchase-list-detail-row">
                        {canWrite && (
                          <TableCell>
                            {i.status === 'OPEN' && (
                              <input
                                type="checkbox"
                                checked={bulk.isSelected(i.id)}
                                onChange={() => bulk.toggle(i.id)}
                                aria-label={t('items.selectRow', { good: i.goodName })}
                              />
                            )}
                          </TableCell>
                        )}
                        <TableCell>{i.goodName}</TableCell>
                        <TableCell className="text-muted-foreground">{i.warehouseName}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {fmtQty(i.quantity)} {i.goodUnit ?? ''}
                        </TableCell>
                        <TableCell>
                          <Badge variant={PURCHASE_LIST_ITEM_STATUS_BADGE[i.status] ?? 'secondary'}>
                            {purchaseListItemStatusLabel(i.status)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {i.supplierName ?? '—'}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {i.workOrderNumber ?? t('items.manual')}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {i.purchaseOrderNumber ?? '—'}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        )}
      </Modal>
      {list && (
        <ManualItemDialog
          open={addOpen}
          listId={list.id}
          onClose={() => setTimeout(() => setAddOpen(false), 0)}
          onAdded={() => {
            setTimeout(() => setAddOpen(false), 0);
            invalidateProcurementSideEffects(qc);
            toast.success(t('lists.itemAdded'));
          }}
        />
      )}
      <ConfirmDialog {...dialogProps} />
    </>
  );
}

// ─── Ручна позиція (BR-PL-004) ──────────────────────────────────────────────────

function ManualItemDialog({
  open,
  listId,
  onClose,
  onAdded,
}: {
  open: boolean;
  listId: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { t } = useTranslation('purchaseLists');
  const { data: warehouses } = useWarehouses();
  const [good, setGood] = useState<GoodPickerItem | null>(null);
  const [warehouseId, setWarehouseId] = useState('');
  const [qty, setQty] = useState('1');
  const [price, setPrice] = useState('');

  useEffect(() => {
    if (!open) return;
    setGood(null);
    setQty('1');
    setPrice('');
  }, [open]);
  useEffect(() => {
    if (!warehouseId && warehouses?.length) {
      setWarehouseId((warehouses.find(w => w.isMain) ?? warehouses[0]).id);
    }
  }, [warehouses, warehouseId]);

  const quantity = Number(qty);

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={t('lists.addItem')}
      size="md"
      submitLabel={t('lists.addItem')}
      resetErrorOnOpen
      errorAs="text"
      validate={() => {
        if (!good || !warehouseId) return t('lists.manual.required');
        if (!Number.isFinite(quantity) || quantity <= 0) return t('addToList.errors.quantity');
        return undefined;
      }}
      onSubmit={async () => {
        if (!good) return;
        await purchaseListsApi.addItem(listId, {
          goodId: good.id,
          warehouseId,
          quantity,
          ...(price.trim() ? { expectedPrice: Number(price) } : {}),
        });
        onAdded();
      }}
    >
      <EntityPickerField<GoodPickerItem>
        label={t('columns.good')}
        required
        display={good?.name ?? ''}
        placeholder={t('lists.manual.goodPlaceholder')}
        ariaLabel={t('columns.good')}
        hidePick
        onSearch={fetchGoodPickerItems}
        onSearchSelect={g => setGood(g)}
        onClear={() => setGood(null)}
      />
      <Select
        label={t('columns.warehouse')}
        value={warehouseId}
        onChange={e => setWarehouseId(e.target.value)}
      >
        {(warehouses ?? []).map(w => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </Select>
      <div className="grid grid-cols-2 gap-3">
        <Input
          label={t('lists.manual.quantity')}
          type="number"
          min="0.001"
          step="any"
          value={qty}
          onChange={e => setQty(e.target.value)}
          hint={
            good?.unitShortName ? t('lists.manual.unit', { unit: good.unitShortName }) : undefined
          }
        />
        <Input
          label={t('items.dialogs.price')}
          type="number"
          min="0"
          step="0.01"
          value={price}
          onChange={e => setPrice(e.target.value)}
        />
      </div>
    </FormDialog>
  );
}
