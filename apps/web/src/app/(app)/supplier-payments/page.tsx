'use client';

import { Suspense, useState, useCallback, useMemo } from 'react';
import { Plus, Wallet, Search, Eye, EyeOff, Trash2, Check, Ban } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { useDebounce } from '@/hooks/useDebounce';
import {
  useSupplierPayments,
  useConfirmSupplierPayment,
  useCancelSupplierPayment,
  useDeleteSupplierPayment,
  type SupplierPayment,
} from '@/hooks/api/useSupplierPayments';
import { EMPTY_ITEMS } from '@/hooks/api/usePaginatedList';
import {
  SUPPLIER_PAYMENT_STATUS_LABELS,
  SUPPLIER_PAYMENT_STATUS_BADGE,
  SUPPLIER_PAYMENT_STATUS_DESCRIPTIONS,
  PAYMENT_SOURCE_TYPE_LABELS,
} from '@sto/shared';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { DatePickerInput } from '@/components/ui/date-picker-input';
import { Pagination } from '@/components/ui/pagination';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useConfirm } from '@/hooks/useConfirm';
import { StatusPill } from '@/components/ui/status-pill';
import { DetailPanel, PanelField, PanelSection } from '@/components/ui/detail-panel';
import { SUPPLIER_PAYMENT_PANEL_SCHEMA, buildPanelFields } from '@/lib/panel-schema';
import { SupplierPaymentCreateModal } from '@/components/ui/SupplierPaymentCreateModal';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { fmtMoney, fmtDate } from '@/lib/format';

const STATUS_OPTIONS = ['DRAFT', 'CONFIRMED', 'CANCELLED'] as const;

function fmt(n: number) {
  return fmtMoney(n) + ' ₴';
}

function SupplierPaymentsPageInner() {
  useRequireAuth(['OWNER', 'ADMIN', 'ACCOUNTANT']);
  const { confirm, dialogProps } = useConfirm();

  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [showDeleted, setShowDeleted] = useState(false);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [selected, setSelected] = useState<SupplierPayment | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const debouncedQ = useDebounce(q, 300);

  const { data, isLoading, error } = useSupplierPayments({
    page,
    limit: 20,
    status: status || undefined,
    q: debouncedQ || undefined,
    showDeleted,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  });

  const items = data?.items ?? (EMPTY_ITEMS as unknown as SupplierPayment[]);
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / 20));

  const confirmMut = useConfirmSupplierPayment();
  const cancelMut = useCancelSupplierPayment();
  const deleteMut = useDeleteSupplierPayment();

  const resetPage = useCallback(() => setPage(1), []);

  const handleConfirm = useCallback(
    async (sp: SupplierPayment) => {
      const ok = await confirm({
        title: 'Провести оплату?',
        message: `Оплата ${sp.number} на суму ${fmt(sp.amount)} зменшить борг перед постачальником. Після проведення документ не можна редагувати.`,
        confirmLabel: 'Провести',
      });
      if (!ok) return;
      try {
        const updated = await confirmMut.mutateAsync(sp.id);
        setSelected(updated);
        toast.success('Оплату проведено');
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Помилка проведення');
      }
    },
    [confirm, confirmMut],
  );

  const handleCancel = useCallback(
    async (sp: SupplierPayment) => {
      const ok = await confirm({
        title: 'Скасувати оплату?',
        message: `Оплату ${sp.number} буде скасовано.`,
        confirmLabel: 'Скасувати оплату',
        variant: 'destructive',
      });
      if (!ok) return;
      try {
        const updated = await cancelMut.mutateAsync(sp.id);
        setSelected(updated);
        toast.success('Оплату скасовано');
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Помилка скасування');
      }
    },
    [confirm, cancelMut],
  );

  const handleDelete = useCallback(
    async (sp: SupplierPayment) => {
      const ok = await confirm({
        title: 'Помітити на видалення?',
        message: `Оплату ${sp.number} буде помічено як видалену.`,
        confirmLabel: 'Видалити',
        variant: 'destructive',
      });
      if (!ok) return;
      try {
        await deleteMut.mutateAsync(sp.id);
        setSelected(null);
        toast.success('Оплату видалено');
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Помилка видалення');
      }
    },
    [confirm, deleteMut],
  );

  const panelFields = useMemo(() => {
    if (!selected) return [];
    return buildPanelFields(
      selected,
      SUPPLIER_PAYMENT_PANEL_SCHEMA,
      { hiddenFields: [], fieldOrder: [] },
      {
        status: v => (
          <Badge
            variant={SUPPLIER_PAYMENT_STATUS_BADGE[String(v)] ?? 'secondary'}
            tooltip={SUPPLIER_PAYMENT_STATUS_DESCRIPTIONS[String(v)]}
          >
            {SUPPLIER_PAYMENT_STATUS_LABELS[String(v)] ?? String(v)}
          </Badge>
        ),
      },
    );
  }, [selected]);

  return (
    <div className="p-4 md:p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="page-title flex items-center gap-2">
          <Wallet className="h-5 w-5" />
          Оплати постачальникам
        </h1>
        <Button onClick={() => setShowCreate(true)} leftIcon={<Plus className="h-4 w-4" />}>
          Нова оплата
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <StatusPill
          value=""
          label="Усі"
          active={status === ''}
          onSelect={() => {
            setStatus('');
            resetPage();
          }}
        />
        {STATUS_OPTIONS.map(s => (
          <StatusPill
            key={s}
            value={s}
            label={SUPPLIER_PAYMENT_STATUS_LABELS[s]}
            description={SUPPLIER_PAYMENT_STATUS_DESCRIPTIONS[s]}
            active={status === s}
            onSelect={v => {
              setStatus(v);
              resetPage();
            }}
          />
        ))}
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={q}
              onChange={e => {
                setQ(e.target.value);
                resetPage();
              }}
              placeholder="Пошук за номером / постачальником…"
              className="h-8 w-64 pl-8 text-[13px]"
            />
          </div>
          <DatePickerInput
            value={dateFrom}
            onChange={v => {
              setDateFrom(v);
              resetPage();
            }}
            max={dateTo || undefined}
            className="w-36"
            placeholder="Від"
          />
          <DatePickerInput
            value={dateTo}
            onChange={v => {
              setDateTo(v);
              resetPage();
            }}
            min={dateFrom || undefined}
            className="w-36"
            placeholder="До"
          />
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => {
              setShowDeleted(d => !d);
              resetPage();
            }}
            title={showDeleted ? 'Сховати видалені' : 'Показати видалені'}
          >
            {showDeleted ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : error ? (
        <div className="text-destructive text-sm py-8 text-center">
          {error instanceof Error ? error.message : 'Помилка завантаження'}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Wallet}
          title="Оплат ще немає"
          description="Створіть першу оплату постачальнику для закриття боргу."
        />
      ) : (
        <>
          <div className="rounded-lg border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Номер</TableHead>
                  <TableHead>Постачальник</TableHead>
                  <TableHead>Джерело</TableHead>
                  <TableHead>Метод</TableHead>
                  <TableHead className="text-right">Сума</TableHead>
                  <TableHead>Дата</TableHead>
                  <TableHead>Статус</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map(sp => (
                  <TableRow
                    key={sp.id}
                    onClick={() => setSelected(sp)}
                    className={cn(
                      'cursor-pointer',
                      selected?.id === sp.id && 'bg-secondary/50',
                      sp.deletedAt && 'opacity-60',
                    )}
                  >
                    <TableCell className="font-medium">{sp.number}</TableCell>
                    <TableCell>{sp.supplierName ?? '—'}</TableCell>
                    <TableCell>
                      <span className="text-muted-foreground">
                        {PAYMENT_SOURCE_TYPE_LABELS[sp.sourceType] ?? sp.sourceType}
                      </span>
                      {sp.sourceName ? ` · ${sp.sourceName}` : ''}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{sp.method}</TableCell>
                    <TableCell className="text-right tabular-nums font-semibold">
                      {fmt(sp.amount)}
                    </TableCell>
                    <TableCell className="tabular-nums">{fmtDate(sp.documentDate)}</TableCell>
                    <TableCell>
                      <Badge
                        variant={SUPPLIER_PAYMENT_STATUS_BADGE[sp.status] ?? 'secondary'}
                        tooltip={SUPPLIER_PAYMENT_STATUS_DESCRIPTIONS[sp.status]}
                      >
                        {SUPPLIER_PAYMENT_STATUS_LABELS[sp.status] ?? sp.status}
                      </Badge>
                      {sp.deletedAt && (
                        <Badge variant="secondary" className="ml-1">
                          видалено
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="mt-3">
            <Pagination page={page} totalPages={totalPages} onChange={setPage} />
          </div>
        </>
      )}

      {/* Detail panel */}
      <DetailPanel
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.number ?? ''}
        subtitle={selected?.supplierName}
      >
        {selected && (
          <>
            {panelFields.map(f => (
              <PanelField
                key={f.key}
                fieldKey={f.key}
                label={f.label}
                value={f.value}
                hidden={f.hidden}
              />
            ))}

            {!selected.deletedAt && (
              <PanelSection title="Дії">
                <div className="flex flex-col gap-2">
                  {selected.status === 'DRAFT' && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        leftIcon={<Check className="h-4 w-4" />}
                        loading={confirmMut.isPending}
                        onClick={() => void handleConfirm(selected)}
                      >
                        Провести
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        leftIcon={<Ban className="h-4 w-4" />}
                        loading={cancelMut.isPending}
                        onClick={() => void handleCancel(selected)}
                      >
                        Скасувати
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        leftIcon={<Trash2 className="h-4 w-4" />}
                        loading={deleteMut.isPending}
                        onClick={() => void handleDelete(selected)}
                      >
                        Помітити на видалення
                      </Button>
                    </>
                  )}
                  {selected.status === 'CANCELLED' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      leftIcon={<Trash2 className="h-4 w-4" />}
                      loading={deleteMut.isPending}
                      onClick={() => void handleDelete(selected)}
                    >
                      Помітити на видалення
                    </Button>
                  )}
                </div>
              </PanelSection>
            )}
          </>
        )}
      </DetailPanel>

      <SupplierPaymentCreateModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onSaved={() => setPage(1)}
      />

      <ConfirmDialog {...dialogProps} />
    </div>
  );
}

export default function SupplierPaymentsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      }
    >
      <SupplierPaymentsPageInner />
    </Suspense>
  );
}
