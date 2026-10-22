'use client';

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Calculator } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { DateRangeFilter } from '@/components/ui/date-range-filter';
import { ListLoadError } from '@/components/ui/list-load-error';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { toast } from '@/lib/toast';
import { CALENDAR_DATE_RE, fmtMoney, fmtQty, kyivToday } from '@/lib/format';
import { usePayrollPreview, useCreatePayrollPeriod } from '@/hooks/api/usePayroll';

interface PayrollPreviewModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Вікно «Розрахунок за період» сторінки «Зарплата»: межі періоду → попередній розрахунок по
 * співробітниках → «Створити період» (чернетка у списку). Відкривається основною кнопкою рядка
 * фільтрів, як «+ Наряд» відкриває картку наряду (рішення власника 2026-10-22: ЗП на весь екран).
 */
export function PayrollPreviewModal({ open, onClose }: PayrollPreviewModalProps) {
  const { t } = useTranslation('payroll');
  const [from, setFrom] = useState(() => `${kyivToday().slice(0, 7)}-01`);
  const [to, setTo] = useState(() => kyivToday());
  const [previewEnabled, setPreviewEnabled] = useState(false);
  const createMut = useCreatePayrollPeriod();

  const RATE_LABELS = useMemo<Record<string, string>>(
    () => ({
      percent_normo: t('rateScheme.percent_normo'),
      per_normo_hour: t('rateScheme.per_normo_hour'),
      fixed_plus_bonus: t('rateScheme.fixed_plus_bonus'),
      unknown: t('rateScheme.unknown'),
    }),
    [t],
  );

  // API приймає лише `YYYY-MM-DD`; порожню межу («×» у полі дати) не шлемо — інакше 400.
  const datesValid = CALENDAR_DATE_RE.test(from) && CALENDAR_DATE_RE.test(to);
  const preview = usePayrollPreview(from, to, '', previewEnabled && datesValid);
  const shown = previewEnabled && datesValid;
  const canCreate = shown && !!preview.data && preview.data.lines.length > 0;

  // Розрахунок не переживає закриття вікна: інакше повторне відкриття пропонувало б «Створити
  // період» за вже створеним розрахунком.
  const close = () => {
    setPreviewEnabled(false);
    onClose();
  };

  const createPeriod = async () => {
    if (!datesValid) return;
    try {
      await createMut.mutateAsync({ periodStart: from, periodEnd: to });
      toast.success(t('toast.periodCreated'));
      close();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('toast.createError'));
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={t('preview.heading')}
      size="lg"
      // Тіло вікна прокручується (overflow) і обрізало б календар поля дати, поки розрахунку ще
      // немає: висоти вистачає на поле з відкритим календарем.
      bodyMinHeight={400}
      footer={
        canCreate ? (
          <Button onClick={() => void createPeriod()} loading={createMut.isPending}>
            {t('preview.createPeriod')}
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <DateRangeFilter
            from={from}
            to={to}
            onFromChange={setFrom}
            onToChange={setTo}
            fromLabel={t('preview.from')}
            toLabel={t('preview.to')}
          />
          <Button
            leftIcon={<Calculator className="h-4 w-4" />}
            onClick={() => setPreviewEnabled(true)}
            disabled={!datesValid}
          >
            {t('preview.calculate')}
          </Button>
        </div>

        {/* Bug #824: without retry the only way out of a failed calculation was to change a date -
            the "calculate" button does nothing once the preview is already enabled. */}
        {shown && <ListLoadError error={preview.error} onRetry={() => void preview.refetch()} />}

        {shown && preview.isLoading && (
          <div className="flex justify-center py-6">
            <Spinner size="md" />
          </div>
        )}
        {shown && preview.data && (
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
                    <TableCell className="text-right tabular-nums">
                      {fmtQty(l.normoHours)}
                    </TableCell>
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
    </Modal>
  );
}
