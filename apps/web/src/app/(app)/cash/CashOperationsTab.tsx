'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  DoorOpen,
  DoorClosed,
  AlertTriangle,
  ArrowDownCircle,
  ArrowUpCircle,
  Wallet,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { toast } from '@/lib/toast';
import { fmtMoney, fmtDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { useCurrentShift, useOpenShift, useCloseShift } from '@/hooks/api/useCashShift';
import {
  useCashRegisters,
  useCashOperations,
  useCreateCashOperation,
  CASH_REASON_LABELS,
  MANUAL_IN_REASONS,
  MANUAL_OUT_REASONS,
} from '@/hooks/api/useCash';
import { useExpenseCategories, flattenActiveByType } from '@/hooks/api/useExpenseCategories';

export default function CashOperationsTab({ canOperate = false }: { canOperate?: boolean }) {
  const { data: registers, isLoading: regLoading } = useCashRegisters();
  const [selectedId, setSelectedId] = useState('');
  const selected = useMemo(
    () => registers?.find(r => r.id === selectedId) ?? null,
    [registers, selectedId],
  );

  // Автовибір першої каси.
  useEffect(() => {
    if (!selectedId && registers?.length) setSelectedId(registers[0].id);
  }, [registers, selectedId]);

  const { data: shift, isLoading: shiftLoading } = useCurrentShift(selected?.branchId ?? null);
  const openShift = useOpenShift();
  const closeShift = useCloseShift();
  const { data: operations, isLoading: opsLoading } = useCashOperations(selectedId || null);
  // Статті витрат потрібні лише для модалки IN/OUT (привід EXPENSE), доступної тим, хто canOperate.
  // GET /expense-categories вимагає ACCOUNTANT+ — RECEPTIONIST (лише перегляд) інакше отримав би 403.
  const { data: expenseCats } = useExpenseCategories(false, canOperate);
  const createOp = useCreateCashOperation();

  const [opModal, setOpModal] = useState<null | 'IN' | 'OUT'>(null);
  const [opForm, setOpForm] = useState({
    amount: '',
    reason: '',
    expenseCategoryId: '',
    notes: '',
  });
  const [opError, setOpError] = useState('');

  const openOpModal = (dir: 'IN' | 'OUT') => {
    setOpForm({
      amount: '',
      reason: dir === 'IN' ? 'MANUAL_IN' : 'MANUAL_OUT',
      expenseCategoryId: '',
      notes: '',
    });
    setOpError('');
    setOpModal(dir);
  };

  const submitOp = async () => {
    if (!opModal || !selected) return;
    const amount = Number(opForm.amount);
    if (!(amount > 0)) {
      setOpError('Вкажіть суму більше 0');
      return;
    }
    if (opForm.reason === 'EXPENSE' && !opForm.expenseCategoryId) {
      setOpError('Оберіть статтю витрат');
      return;
    }
    try {
      await createOp.mutateAsync({
        cashRegisterId: selected.id,
        direction: opModal,
        amount,
        reason: opForm.reason,
        expenseCategoryId: opForm.expenseCategoryId || undefined,
        notes: opForm.notes || undefined,
      });
      setOpModal(null);
      toast.success(opModal === 'IN' ? 'Готівку внесено' : 'Готівку видано');
    } catch (e) {
      setOpError(e instanceof Error ? e.message : 'Помилка операції');
    }
  };

  const onOpenShift = async () => {
    if (!selected) return;
    try {
      await openShift.mutateAsync(selected.branchId);
      toast.success('Зміну відкрито');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не вдалося відкрити зміну');
    }
  };
  const onCloseShift = async () => {
    if (!shift) return;
    try {
      await closeShift.mutateAsync(shift.id);
      toast.success('Зміну закрито (Z-звіт)');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не вдалося закрити зміну');
    }
  };

  // Фіскальна каса без відкритої зміни → операції заблоковані.
  const fiscalBlocked = !!selected?.isFiscal && !shift;

  if (regLoading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="md" />
      </div>
    );
  }
  if ((registers?.length ?? 0) === 0) {
    return (
      <EmptyState
        icon={Wallet}
        title="Кас немає"
        description="Створіть касу у вкладці «Каси», щоб проводити операції"
      />
    );
  }

  const reasonOptions = opModal === 'IN' ? MANUAL_IN_REASONS : MANUAL_OUT_REASONS;
  // Статті відповідного напряму: IN → оприбуткування (INCOME), OUT → витрати (EXPENSE). Сплощене
  // дерево з відступами для читабельності ієрархії у Select.
  const categoryOptions = flattenActiveByType(expenseCats, opModal === 'IN' ? 'INCOME' : 'EXPENSE');

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3">
      {/* Каса + баланс */}
      <div className="flex flex-wrap items-center gap-3 shrink-0">
        <Select value={selectedId} onChange={e => setSelectedId(e.target.value)} className="w-56">
          {registers?.map(r => (
            <option key={r.id} value={r.id}>
              {r.name} {r.isFiscal ? '(фіскальна)' : ''}
            </option>
          ))}
        </Select>
        {selected && (
          <div className="bg-surface border border-border rounded-lg px-4 py-2">
            <span className="text-[12px] text-muted-foreground">Залишок: </span>
            <span className="text-lg font-bold tabular-nums">
              {fmtMoney(selected.balance)} {selected.currencySymbol ?? selected.currencyCode}
            </span>
          </div>
        )}
        {canOperate && (
          <div className="ml-auto flex items-center gap-2">
            <Button
              leftIcon={<ArrowDownCircle className="h-4 w-4" />}
              onClick={() => openOpModal('IN')}
              disabled={fiscalBlocked}
            >
              Внести
            </Button>
            <Button
              variant="outline"
              leftIcon={<ArrowUpCircle className="h-4 w-4" />}
              onClick={() => openOpModal('OUT')}
              disabled={fiscalBlocked}
            >
              Видати
            </Button>
          </div>
        )}
      </div>

      {/* Зміна (для фіскальної каси) */}
      {selected?.isFiscal && (
        <div className="bg-surface border border-border rounded-lg px-4 py-2.5 flex items-center gap-3 shrink-0">
          {shiftLoading ? (
            <Spinner size="sm" />
          ) : shift ? (
            <>
              <span className="inline-block w-2.5 h-2.5 rounded-full bg-success" />
              <span className="text-[13px] font-medium">Зміна відкрита</span>
              {!!shift.pendingReceipts && shift.pendingReceipts > 0 && (
                <span className="flex items-center gap-1 text-[12px] text-warning-text">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Чеків очікує: {shift.pendingReceipts}
                </span>
              )}
              <Button
                variant="outline"
                size="sm"
                className="ml-auto"
                onClick={() => void onCloseShift()}
                loading={closeShift.isPending}
              >
                <DoorClosed className="h-3.5 w-3.5 mr-1" />
                Закрити зміну (Z-звіт)
              </Button>
            </>
          ) : (
            <>
              <span className="inline-block w-2.5 h-2.5 rounded-full bg-muted-foreground" />
              <span className="text-[13px] text-muted-foreground">
                Зміну закрито — операції з готівкою недоступні
              </span>
              <Button
                size="sm"
                className="ml-auto"
                onClick={() => void onOpenShift()}
                loading={openShift.isPending}
              >
                <DoorOpen className="h-3.5 w-3.5 mr-1" />
                Відкрити зміну
              </Button>
            </>
          )}
        </div>
      )}

      {/* Історія операцій */}
      <div className="flex-1 min-h-0 border border-border rounded-xl bg-surface overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Дата</TableHead>
              <TableHead>Операція</TableHead>
              <TableHead>Привід</TableHead>
              <TableHead className="text-right">Сума</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {opsLoading && (
              <TableRow>
                <TableCell colSpan={4} className="py-10 text-center">
                  <div className="flex justify-center">
                    <Spinner size="md" />
                  </div>
                </TableCell>
              </TableRow>
            )}
            {!opsLoading && (operations?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="p-0">
                  <EmptyState
                    icon={Wallet}
                    title="Операцій немає"
                    description="Внесіть або видайте готівку"
                  />
                </TableCell>
              </TableRow>
            )}
            {operations?.map(op => (
              <TableRow key={op.id}>
                <TableCell className="text-[13px] text-muted-foreground whitespace-nowrap">
                  {fmtDateTime(op.createdAt)}
                </TableCell>
                <TableCell>
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 text-[13px] font-medium',
                      op.direction === 'IN' ? 'text-success' : 'text-destructive',
                    )}
                  >
                    {op.direction === 'IN' ? (
                      <ArrowDownCircle className="h-3.5 w-3.5" />
                    ) : (
                      <ArrowUpCircle className="h-3.5 w-3.5" />
                    )}
                    {op.direction === 'IN' ? 'Внесення' : 'Видача'}
                  </span>
                </TableCell>
                <TableCell className="text-[13px] text-muted-foreground">
                  {CASH_REASON_LABELS[op.reason] ?? op.reason}
                  {op.expenseCategoryName ? ` · ${op.expenseCategoryName}` : ''}
                  {op.notes ? ` · ${op.notes}` : ''}
                </TableCell>
                <TableCell
                  className={cn(
                    'text-right tabular-nums font-semibold',
                    op.direction === 'IN' ? 'text-success' : 'text-destructive',
                  )}
                >
                  {op.direction === 'IN' ? '+' : '−'}
                  {fmtMoney(op.amount)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Модалка внести/видати */}
      <Modal
        open={!!opModal}
        onClose={() => setOpModal(null)}
        title={opModal === 'IN' ? 'Внести готівку' : 'Видати готівку'}
        footer={
          <Button
            onClick={submitOp}
            loading={createOp.isPending}
            disabled={!(Number(opForm.amount) > 0)}
            className="w-full"
          >
            {opModal === 'IN' ? 'Внести' : 'Видати'}
          </Button>
        }
      >
        {opError && (
          <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">
            {opError}
          </div>
        )}
        <div className="space-y-4">
          <Input
            label="Сума"
            type="number"
            required
            value={opForm.amount}
            onChange={e => setOpForm(f => ({ ...f, amount: e.target.value }))}
            placeholder="0"
            autoFocus
            className="h-8 text-[13px]"
          />
          <Select
            label="Привід"
            value={opForm.reason}
            onChange={e => setOpForm(f => ({ ...f, reason: e.target.value }))}
          >
            {reasonOptions.map(r => (
              <option key={r} value={r}>
                {CASH_REASON_LABELS[r]}
              </option>
            ))}
          </Select>
          <Select
            label={
              opForm.reason === 'EXPENSE'
                ? 'Стаття витрат'
                : opModal === 'IN'
                  ? 'Стаття оприбуткування (необовʼязково)'
                  : 'Стаття витрат (необовʼязково)'
            }
            value={opForm.expenseCategoryId}
            onChange={e => setOpForm(f => ({ ...f, expenseCategoryId: e.target.value }))}
          >
            <option value="">— без статті —</option>
            {categoryOptions.map(c => (
              <option key={c.id} value={c.id}>
                {'  '.repeat(c.depth)}
                {c.name}
              </option>
            ))}
          </Select>
          <Input
            label="Нотатка"
            value={opForm.notes}
            onChange={e => setOpForm(f => ({ ...f, notes: e.target.value }))}
            placeholder="необов'язково"
            className="h-8 text-[13px]"
          />
        </div>
      </Modal>
    </div>
  );
}
