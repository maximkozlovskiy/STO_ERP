'use client';

import { useState } from 'react';
import { Calculator, Wallet, Trash2, ChevronRight, ChevronDown } from 'lucide-react';
import { useRequireAuth, useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Modal } from '@/components/ui/modal';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
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
import { useConfirm } from '@/hooks/useConfirm';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toast } from '@/lib/toast';
import { fmtMoney, kyivToday } from '@/lib/format';
import {
  usePayrollPreview,
  usePayrollPeriods,
  useCreatePayrollPeriod,
  useComputePayrollPeriod,
  usePayPayrollPeriod,
  useDeletePayrollPeriod,
  PAYROLL_STATUS_LABELS,
  RATE_SCHEME_LABELS,
  type PayrollPeriod,
} from '@/hooks/api/usePayroll';
import { useCashRegisters } from '@/hooks/api/useCash';

const STATUS_BADGE: Record<PayrollPeriod['status'], BadgeVariant> = {
  DRAFT: 'secondary',
  COMPUTED: 'warning',
  PAID: 'success',
  CANCELLED: 'secondary',
};

export default function PayrollPage() {
  useRequireAuth(['OWNER', 'ADMIN', 'ACCOUNTANT']);
  const { employee } = useAuth();
  const canPay = ['OWNER', 'ADMIN'].includes(employee?.role ?? '');
  const { confirm, dialogProps } = useConfirm();

  const [from, setFrom] = useState(() => `${kyivToday().slice(0, 7)}-01`);
  const [to, setTo] = useState(() => kyivToday());
  const [previewEnabled, setPreviewEnabled] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Модалка виплати: обрати касу (готівкою) або без каси (лише фіксація).
  const [payPeriod, setPayPeriod] = useState<PayrollPeriod | null>(null);
  const [payCashRegisterId, setPayCashRegisterId] = useState('');
  const { data: cashRegisters } = useCashRegisters();

  const preview = usePayrollPreview(from, to, '', previewEnabled);
  const periodsQuery = usePayrollPeriods();
  const createMut = useCreatePayrollPeriod();
  const computeMut = useComputePayrollPeriod();
  const payMut = usePayPayrollPeriod();
  const deleteMut = useDeletePayrollPeriod();

  const periods = periodsQuery.data ?? [];

  const runPreview = () => setPreviewEnabled(true);

  const createPeriod = async () => {
    try {
      await createMut.mutateAsync({ periodStart: from, periodEnd: to });
      toast.success('Період створено (чернетка)');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка створення');
    }
  };

  const compute = async (id: string) => {
    try {
      await computeMut.mutateAsync(id);
      toast.success('Нарахування розраховано');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка розрахунку');
    }
  };

  const pay = (p: PayrollPeriod) => {
    setPayCashRegisterId('');
    setPayPeriod(p);
  };

  const confirmPay = async () => {
    if (!payPeriod) return;
    try {
      await payMut.mutateAsync({
        id: payPeriod.id,
        cashRegisterId: payCashRegisterId || undefined,
      });
      setPayPeriod(null);
      toast.success('Виплату проведено');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка виплати');
    }
  };

  const remove = async (p: PayrollPeriod) => {
    if (
      !(await confirm({
        title: 'Видалити період?',
        message: 'Чернетку буде видалено.',
        variant: 'destructive',
      }))
    )
      return;
    try {
      await deleteMut.mutateAsync(p.id);
      toast.success('Період видалено');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка видалення');
    }
  };

  return (
    <div className="page-container max-w-5xl space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Зарплата</h1>
        </div>
      </div>

      {/* Розрахунок за період */}
      <div className="bg-surface rounded-xl border border-border p-5 space-y-4">
        <h2 className="text-[15px] font-semibold text-foreground">Розрахунок за період</h2>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-[12px] text-muted-foreground mb-1">Період з</label>
            <Input
              type="date"
              value={from}
              onChange={e => setFrom(e.target.value)}
              className="h-9 w-40"
            />
          </div>
          <div>
            <label className="block text-[12px] text-muted-foreground mb-1">по</label>
            <Input
              type="date"
              value={to}
              onChange={e => setTo(e.target.value)}
              className="h-9 w-40"
            />
          </div>
          <Button leftIcon={<Calculator className="h-4 w-4" />} onClick={runPreview}>
            Розрахувати
          </Button>
          {previewEnabled && preview.data && preview.data.lines.length > 0 && (
            <Button
              variant="outline"
              onClick={createPeriod}
              loading={createMut.isPending}
              className="ml-auto"
            >
              Створити період
            </Button>
          )}
        </div>

        {previewEnabled && preview.isLoading && (
          <div className="flex justify-center py-6">
            <Spinner size="md" />
          </div>
        )}
        {previewEnabled && preview.data && (
          <div className="border border-border rounded-lg overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Співробітник</TableHead>
                  <TableHead>Схема</TableHead>
                  <TableHead className="text-right">Нормо-год</TableHead>
                  <TableHead className="text-right">Сума робіт, ₴</TableHead>
                  <TableHead className="text-right">Нараховано, ₴</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.data.lines.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="p-0">
                      <EmptyState
                        icon={Calculator}
                        title="Немає нарахувань"
                        description="За цей період немає завершених робіт із виконавцями"
                      />
                    </TableCell>
                  </TableRow>
                )}
                {preview.data.lines.map(l => (
                  <TableRow key={l.employeeId}>
                    <TableCell className="font-medium">{l.employeeName}</TableCell>
                    <TableCell className="text-[13px] text-muted-foreground">
                      {RATE_SCHEME_LABELS[l.rateSchemeType] ?? l.rateSchemeType}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{l.normoHours}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmtMoney(l.baseAmount)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-semibold">
                      {fmtMoney(l.accruedAmount)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {preview.data.lines.length > 0 && (
              <div className="flex justify-between items-center px-4 py-2.5 border-t border-border bg-secondary/30 text-[13px]">
                <span className="text-muted-foreground">Всього до нарахування</span>
                <span className="font-bold tabular-nums">
                  {fmtMoney(preview.data.totalAccrued)} ₴
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Періоди */}
      <div className="bg-surface rounded-xl border border-border p-5 space-y-3">
        <h2 className="text-[15px] font-semibold text-foreground">Зарплатні періоди</h2>
        {periodsQuery.isLoading && (
          <div className="flex justify-center py-6">
            <Spinner size="md" />
          </div>
        )}
        {!periodsQuery.isLoading && periods.length === 0 && (
          <EmptyState
            icon={Wallet}
            title="Періодів немає"
            description="Розрахуйте період вище і натисніть «Створити період»"
          />
        )}
        {periods.map(p => {
          const isOpen = expanded === p.id;
          return (
            <div
              key={p.id}
              data-testid={`payroll-period-${p.id}`}
              className="border border-border rounded-lg"
            >
              <div className="flex items-center gap-3 px-4 py-2.5">
                <button
                  onClick={() => setExpanded(isOpen ? null : p.id)}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label={isOpen ? 'Згорнути' : 'Розгорнути'}
                >
                  {isOpen ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronRight className="h-4 w-4" />
                  )}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium">
                    {p.periodStart} — {p.periodEnd}
                    {p.note ? <span className="text-muted-foreground"> · {p.note}</span> : null}
                  </div>
                </div>
                <Badge variant={STATUS_BADGE[p.status]}>{PAYROLL_STATUS_LABELS[p.status]}</Badge>
                <span className="text-[13px] tabular-nums font-semibold w-28 text-right">
                  {fmtMoney(p.status === 'PAID' ? p.totalPaid : p.totalAccrued)} ₴
                </span>
                <div className="flex items-center gap-1">
                  {p.status === 'DRAFT' && (
                    <Button
                      size="sm"
                      onClick={() => void compute(p.id)}
                      loading={computeMut.isPending && computeMut.variables === p.id}
                    >
                      Розрахувати
                    </Button>
                  )}
                  {p.status === 'COMPUTED' && canPay && (
                    <Button
                      size="sm"
                      onClick={() => void pay(p)}
                      loading={payMut.isPending && payMut.variables?.id === p.id}
                    >
                      Виплатити
                    </Button>
                  )}
                  {p.status !== 'PAID' && canPay && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => void remove(p)}
                      title="Видалити"
                      className="text-destructive/70 hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>

              {isOpen && (
                <div className="border-t border-border px-4 py-2">
                  {!p.lines || p.lines.length === 0 ? (
                    <p className="text-[12px] text-muted-foreground py-2">
                      {p.status === 'DRAFT'
                        ? 'Ще не розраховано — натисніть «Розрахувати».'
                        : 'Немає нарахувань.'}
                    </p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Співробітник</TableHead>
                          <TableHead>Схема</TableHead>
                          <TableHead className="text-right">Нормо-год</TableHead>
                          <TableHead className="text-right">Нараховано, ₴</TableHead>
                          <TableHead className="text-right">Виплачено, ₴</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {p.lines.map(l => (
                          <TableRow key={l.employeeId}>
                            <TableCell className="font-medium">{l.employeeName}</TableCell>
                            <TableCell className="text-[13px] text-muted-foreground">
                              {RATE_SCHEME_LABELS[l.rateSchemeType] ?? l.rateSchemeType}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {l.normoHours}
                            </TableCell>
                            <TableCell className="text-right tabular-nums font-semibold">
                              {fmtMoney(l.accruedAmount)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {fmtMoney(l.paidAmount ?? 0)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Модалка виплати */}
      <Modal
        open={!!payPeriod}
        onClose={() => setPayPeriod(null)}
        title="Провести виплату"
        footer={
          <Button onClick={confirmPay} loading={payMut.isPending} className="w-full">
            Виплатити {payPeriod ? fmtMoney(payPeriod.totalAccrued) : ''} ₴
          </Button>
        }
      >
        {payPeriod && (
          <div className="space-y-4">
            <p className="text-[13px] text-muted-foreground">
              Період {payPeriod.periodStart} — {payPeriod.periodEnd}, до виплати{' '}
              <b>{fmtMoney(payPeriod.totalAccrued)} ₴</b>. Дію не можна скасувати.
            </p>
            <Select
              label="Виплатити з каси (готівкою)"
              value={payCashRegisterId}
              onChange={e => setPayCashRegisterId(e.target.value)}
            >
              <option value="">— без каси (лише фіксація) —</option>
              {cashRegisters?.map(r => (
                <option key={r.id} value={r.id}>
                  {r.name} — залишок {fmtMoney(r.balance)} {r.currencySymbol ?? r.currencyCode}
                </option>
              ))}
            </Select>
            <p className="text-[12px] text-muted-foreground">
              Якщо обрати касу — сума видається з неї (cash-out по кожному співробітнику). Фіскальна
              каса вимагає відкриту зміну.
            </p>
          </div>
        )}
      </Modal>

      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
