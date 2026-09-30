'use client';

import { Fragment, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
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
  usePayrollPeriod,
  useCreatePayrollPeriod,
  useComputePayrollPeriod,
  usePayPayrollPeriod,
  useDeletePayrollPeriod,
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
  const { t } = useTranslation('payroll');
  useRequireAuth(['OWNER', 'ADMIN', 'ACCOUNTANT']);
  const { employee } = useAuth();
  const canPay = ['OWNER', 'ADMIN'].includes(employee?.role ?? '');
  const { confirm, dialogProps } = useConfirm();

  const STATUS_LABELS = useMemo<Record<PayrollPeriod['status'], string>>(
    () => ({
      DRAFT: t('status.DRAFT'),
      COMPUTED: t('status.COMPUTED'),
      PAID: t('status.PAID'),
      CANCELLED: t('status.CANCELLED'),
    }),
    [t],
  );
  const RATE_LABELS = useMemo<Record<string, string>>(
    () => ({
      percent_normo: t('rateScheme.percent_normo'),
      per_normo_hour: t('rateScheme.per_normo_hour'),
      fixed_plus_bonus: t('rateScheme.fixed_plus_bonus'),
      unknown: t('rateScheme.unknown'),
    }),
    [t],
  );

  const [from, setFrom] = useState(() => `${kyivToday().slice(0, 7)}-01`);
  const [to, setTo] = useState(() => kyivToday());
  const [previewEnabled, setPreviewEnabled] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Вкладене розкриття рядка співробітника → розшифровка по нарядах (`${periodId}:${employeeId}`).
  const [expandedEmployee, setExpandedEmployee] = useState<string | null>(null);
  // Модалка виплати: обрати касу (готівкою) або без каси (лише фіксація).
  const [payPeriod, setPayPeriod] = useState<PayrollPeriod | null>(null);
  const [payCashRegisterId, setPayCashRegisterId] = useState('');
  const { data: cashRegisters } = useCashRegisters();

  const preview = usePayrollPreview(from, to, '', previewEnabled);
  const periodsQuery = usePayrollPeriods();
  // Розкритий період вантажиться детально (список не несе розшифровки по нарядах — важко).
  const expandedDetail = usePayrollPeriod(expanded);
  const createMut = useCreatePayrollPeriod();
  const computeMut = useComputePayrollPeriod();
  const payMut = usePayPayrollPeriod();
  const deleteMut = useDeletePayrollPeriod();

  const periods = periodsQuery.data ?? [];

  const runPreview = () => setPreviewEnabled(true);

  const createPeriod = async () => {
    try {
      await createMut.mutateAsync({ periodStart: from, periodEnd: to });
      toast.success(t('toast.periodCreated'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('toast.createError'));
    }
  };

  const compute = async (id: string) => {
    try {
      await computeMut.mutateAsync(id);
      toast.success(t('toast.computed'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('toast.computeError'));
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
      toast.success(t('toast.paid'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('toast.payError'));
    }
  };

  const remove = async (p: PayrollPeriod) => {
    if (
      !(await confirm({
        title: t('confirm.deleteTitle'),
        message: t('confirm.deleteMessage'),
        variant: 'destructive',
      }))
    )
      return;
    try {
      await deleteMut.mutateAsync(p.id);
      toast.success(t('toast.periodDeleted'));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('toast.deleteError'));
    }
  };

  return (
    <div className="page-container max-w-5xl space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('title')}</h1>
        </div>
      </div>

      {/* Розрахунок за період */}
      <div className="bg-surface rounded-xl border border-border p-5 space-y-4">
        <h2 className="text-[15px] font-semibold text-foreground">{t('preview.heading')}</h2>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-[12px] text-muted-foreground mb-1">
              {t('preview.from')}
            </label>
            <Input
              type="date"
              value={from}
              onChange={e => setFrom(e.target.value)}
              className="h-9 w-40"
            />
          </div>
          <div>
            <label className="block text-[12px] text-muted-foreground mb-1">
              {t('preview.to')}
            </label>
            <Input
              type="date"
              value={to}
              onChange={e => setTo(e.target.value)}
              className="h-9 w-40"
            />
          </div>
          <Button leftIcon={<Calculator className="h-4 w-4" />} onClick={runPreview}>
            {t('preview.calculate')}
          </Button>
          {previewEnabled && preview.data && preview.data.lines.length > 0 && (
            <Button
              variant="outline"
              onClick={createPeriod}
              loading={createMut.isPending}
              className="ml-auto"
            >
              {t('preview.createPeriod')}
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
                  <TableHead>{t('columns.employee')}</TableHead>
                  <TableHead>{t('columns.scheme')}</TableHead>
                  <TableHead className="text-right">{t('columns.normoHours')}</TableHead>
                  <TableHead className="text-right">{t('columns.baseAmount')}</TableHead>
                  <TableHead className="text-right">{t('columns.accrued')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.data.lines.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="p-0">
                      <EmptyState
                        icon={Calculator}
                        title={t('empty.previewTitle')}
                        description={t('empty.previewDescription')}
                      />
                    </TableCell>
                  </TableRow>
                )}
                {preview.data.lines.map(l => (
                  <TableRow key={l.employeeId}>
                    <TableCell className="font-medium">{l.employeeName}</TableCell>
                    <TableCell className="text-[13px] text-muted-foreground">
                      {RATE_LABELS[l.rateSchemeType] ?? l.rateSchemeType}
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
                <span className="text-muted-foreground">{t('preview.totalToAccrue')}</span>
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
        <h2 className="text-[15px] font-semibold text-foreground">{t('periods.heading')}</h2>
        {periodsQuery.isLoading && (
          <div className="flex justify-center py-6">
            <Spinner size="md" />
          </div>
        )}
        {!periodsQuery.isLoading && periods.length === 0 && (
          <EmptyState
            icon={Wallet}
            title={t('empty.periodsTitle')}
            description={t('empty.periodsDescription')}
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
                  aria-label={isOpen ? t('periods.collapse') : t('periods.expand')}
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
                <Badge variant={STATUS_BADGE[p.status]}>{STATUS_LABELS[p.status]}</Badge>
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
                      {t('periods.compute')}
                    </Button>
                  )}
                  {p.status === 'COMPUTED' && canPay && (
                    <Button
                      size="sm"
                      onClick={() => void pay(p)}
                      loading={payMut.isPending && payMut.variables?.id === p.id}
                    >
                      {t('periods.pay')}
                    </Button>
                  )}
                  {p.status !== 'PAID' && canPay && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => void remove(p)}
                      title={t('periods.delete')}
                      className="text-destructive/70 hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>

              {isOpen && (
                <div className="border-t border-border px-4 py-2">
                  {(() => {
                    // Детальний запит несе workOrders; поки вантажиться — показуємо дані зі списку.
                    const lines =
                      expandedDetail.data?.id === p.id ? expandedDetail.data.lines : p.lines;
                    if (!lines || lines.length === 0)
                      return (
                        <p className="text-[12px] text-muted-foreground py-2">
                          {p.status === 'DRAFT'
                            ? t('periods.notComputed')
                            : t('periods.noAccruals')}
                        </p>
                      );
                    return (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-8" />
                            <TableHead>{t('columns.employee')}</TableHead>
                            <TableHead>{t('columns.scheme')}</TableHead>
                            <TableHead className="text-right">{t('columns.normoHours')}</TableHead>
                            <TableHead className="text-right">{t('columns.accrued')}</TableHead>
                            <TableHead className="text-right">{t('columns.paid')}</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {lines.map(l => {
                            const empKey = `${p.id}:${l.employeeId}`;
                            const empOpen = expandedEmployee === empKey;
                            const wos = l.workOrders;
                            return (
                              <Fragment key={l.employeeId}>
                                <TableRow>
                                  <TableCell className="w-8 p-0 pl-2">
                                    <button
                                      onClick={() => setExpandedEmployee(empOpen ? null : empKey)}
                                      className="text-muted-foreground hover:text-foreground"
                                      aria-label={
                                        empOpen ? t('breakdown.collapse') : t('breakdown.expand')
                                      }
                                      title={
                                        empOpen ? t('breakdown.collapse') : t('breakdown.expand')
                                      }
                                    >
                                      {empOpen ? (
                                        <ChevronDown className="h-3.5 w-3.5" />
                                      ) : (
                                        <ChevronRight className="h-3.5 w-3.5" />
                                      )}
                                    </button>
                                  </TableCell>
                                  <TableCell className="font-medium">{l.employeeName}</TableCell>
                                  <TableCell className="text-[13px] text-muted-foreground">
                                    {RATE_LABELS[l.rateSchemeType] ?? l.rateSchemeType}
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
                                {empOpen && (
                                  <TableRow>
                                    <TableCell colSpan={6} className="bg-secondary/20 p-0">
                                      {expandedDetail.isLoading ? (
                                        <div className="flex justify-center py-4">
                                          <Spinner size="sm" />
                                        </div>
                                      ) : !wos || wos.length === 0 ? (
                                        <p className="text-[12px] text-muted-foreground px-4 py-3">
                                          {t('breakdown.empty')}
                                        </p>
                                      ) : (
                                        <div className="px-4 py-2">
                                          <p className="text-[12px] font-medium text-muted-foreground mb-1.5">
                                            {t('breakdown.heading')}
                                          </p>
                                          <table className="w-full text-[13px]">
                                            <colgroup>
                                              <col className="w-32" />
                                              <col />
                                              <col className="w-20" />
                                              <col className="w-24" />
                                              <col className="w-28" />
                                            </colgroup>
                                            <thead>
                                              <tr className="text-[12px] text-muted-foreground">
                                                <th className="text-left font-medium py-1">
                                                  {t('breakdown.workOrder')}
                                                </th>
                                                <th className="text-left font-medium py-1">
                                                  {t('breakdown.vehicle')}
                                                </th>
                                                <th className="text-right font-medium py-1">
                                                  {t('breakdown.works')}
                                                </th>
                                                <th className="text-right font-medium py-1">
                                                  {t('columns.normoHours')}
                                                </th>
                                                <th className="text-right font-medium py-1">
                                                  {t('columns.baseAmount')}
                                                </th>
                                              </tr>
                                            </thead>
                                            <tbody>
                                              {wos.map(w => (
                                                <tr
                                                  key={w.workOrderId}
                                                  className="border-t border-border/50"
                                                >
                                                  <td className="py-1.5">
                                                    <Link
                                                      href={`/work-orders/${w.workOrderId}`}
                                                      className="text-primary hover:underline"
                                                    >
                                                      {w.workOrderNumber}
                                                    </Link>
                                                  </td>
                                                  <td className="py-1.5 text-muted-foreground">
                                                    {w.vehicleName ?? '—'}
                                                  </td>
                                                  <td className="py-1.5 text-right tabular-nums">
                                                    {w.worksCount}
                                                  </td>
                                                  <td className="py-1.5 text-right tabular-nums">
                                                    {w.normoHours}
                                                  </td>
                                                  <td className="py-1.5 text-right tabular-nums">
                                                    {fmtMoney(w.baseAmount)}
                                                  </td>
                                                </tr>
                                              ))}
                                            </tbody>
                                            <tfoot>
                                              <tr className="border-t border-border font-semibold">
                                                <td colSpan={3} className="py-1.5">
                                                  {t('breakdown.total')}
                                                </td>
                                                <td className="py-1.5 text-right tabular-nums">
                                                  {l.normoHours}
                                                </td>
                                                <td className="py-1.5 text-right tabular-nums">
                                                  {fmtMoney(l.baseAmount)}
                                                </td>
                                              </tr>
                                            </tfoot>
                                          </table>
                                          <p className="text-[11px] text-muted-foreground mt-1.5">
                                            {t('breakdown.note')}
                                          </p>
                                        </div>
                                      )}
                                    </TableCell>
                                  </TableRow>
                                )}
                              </Fragment>
                            );
                          })}
                        </TableBody>
                      </Table>
                    );
                  })()}
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
        title={t('payModal.title')}
        footer={
          <Button onClick={confirmPay} loading={payMut.isPending} className="w-full">
            {t('periods.pay')} {payPeriod ? fmtMoney(payPeriod.totalAccrued) : ''} ₴
          </Button>
        }
      >
        {payPeriod && (
          <div className="space-y-4">
            <p className="text-[13px] text-muted-foreground">
              {t('payModal.periodInfo', {
                from: payPeriod.periodStart,
                to: payPeriod.periodEnd,
              })}
              <b>{fmtMoney(payPeriod.totalAccrued)} ₴</b>
              {t('payModal.cannotUndo')}
            </p>
            <Select
              label={t('payModal.cashRegisterLabel')}
              value={payCashRegisterId}
              onChange={e => setPayCashRegisterId(e.target.value)}
            >
              <option value="">{t('payModal.noCashRegister')}</option>
              {cashRegisters?.map(r => (
                <option key={r.id} value={r.id}>
                  {t('payModal.cashRegisterOption', {
                    name: r.name,
                    balance: fmtMoney(r.balance),
                    currency: r.currencySymbol ?? r.currencyCode,
                  })}
                </option>
              ))}
            </Select>
            <p className="text-[12px] text-muted-foreground">{t('payModal.note')}</p>
          </div>
        )}
      </Modal>

      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
