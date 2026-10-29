'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PNL_DOUBLE_COUNT_INCOME_REASONS,
  PNL_EXPENSE_CASH_REASON_OPTIONS,
  PNL_EXPENSE_CASH_REASON_REQUIRED,
  PNL_INCOME_CASH_REASON_OPTIONS,
  type ApiSchema,
  type CashReasonValue,
} from '@sto/shared';
import { AlertTriangle } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { toast } from '@/lib/toast';
import { useUpdatePnlSettings } from '@/hooks/api/useReports';

type PnlSettings = ApiSchema<'PnlSettingsDto'>;

const DOUBLE_COUNT: readonly string[] = PNL_DOUBLE_COUNT_INCOME_REASONS;

interface Props {
  open: boolean;
  onClose: () => void;
  /** Налаштування, за якими пораховано звіт (`PnlReportDto.settings`). */
  settings: PnlSettings;
}

/**
 * «Налаштування звіту» P&L (BR-RPT-030, рішення власника 2026-10-29): які касові надходження зі
 * статтею доходу — «інший дохід», які видачі зі статтею витрат — витрата («Витрата» завжди), і чи
 * попереджати про зарплату місяців, що ще не почалися. Лише OWNER / ADMIN (кнопку показує звіт).
 * Escape і вкладені шари — стандартний `Modal`.
 */
export function PnlSettingsModal({ open, onClose, settings }: Props) {
  const { t } = useTranslation(['reports', 'cash']);
  const mut = useUpdatePnlSettings();
  const warnId = useId();

  const [income, setIncome] = useState<CashReasonValue[]>([]);
  const [expense, setExpense] = useState<CashReasonValue[]>([]);
  const [warnFuture, setWarnFuture] = useState(false);
  const [error, setError] = useState('');
  // `mut.isPending` — знімок рендера: два кліки в одному кадрі обидва бачать `false`.
  const submittingRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    setIncome([...settings.incomeCashReasons]);
    setExpense([...settings.expenseCashReasons]);
    setWarnFuture(settings.warnFuturePayroll);
    setError('');
    submittingRef.current = false;
  }, [open, settings]);

  const toggle = (list: CashReasonValue[], value: CashReasonValue, on: boolean) =>
    on ? (list.includes(value) ? list : [...list, value]) : list.filter(v => v !== value);

  const doubleCount = income.some(r => DOUBLE_COUNT.includes(r));

  const handleSubmit = async () => {
    if (mut.isPending || submittingRef.current) return;
    submittingRef.current = true;
    setError('');
    try {
      await mut.mutateAsync({
        // Порядок — як у переліку дозволених (стабільний diff і однаковий підпис «Пораховано»).
        pnlIncomeCashReasons: PNL_INCOME_CASH_REASON_OPTIONS.filter(r => income.includes(r)),
        pnlExpenseCashReasons: PNL_EXPENSE_CASH_REASON_OPTIONS.filter(
          r => r === PNL_EXPENSE_CASH_REASON_REQUIRED || expense.includes(r),
        ),
        pnlWarnFuturePayroll: warnFuture,
      });
      toast.success(t('page.pnl.settings.saved'));
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error && e.message ? e.message : t('page.pnl.settings.saveError'));
    } finally {
      submittingRef.current = false;
    }
  };

  const close = () => {
    if (!mut.isPending) onClose();
  };

  const reason = (r: CashReasonValue) => t(`cash:reasons.${r}`, { defaultValue: r });

  return (
    <Modal
      open={open}
      onClose={close}
      onSubmit={() => void handleSubmit()}
      title={t('page.pnl.settings.title')}
      size="md"
      footer={
        <div className="flex gap-2 items-center justify-end w-full">
          <Button variant="outline" size="sm" onClick={close} disabled={mut.isPending}>
            {t('page.pnl.settings.cancel')}
          </Button>
          <Button size="sm" onClick={() => void handleSubmit()} loading={mut.isPending}>
            {t('page.pnl.settings.save')}
          </Button>
        </div>
      }
    >
      <div className="space-y-5 text-[13px]" data-testid="pnl-settings-modal">
        <fieldset className="space-y-2">
          <legend className="font-medium text-foreground mb-1">
            {t('page.pnl.settings.incomeTitle')}
          </legend>
          <p className="text-muted-foreground">{t('page.pnl.settings.incomeHint')}</p>
          {PNL_INCOME_CASH_REASON_OPTIONS.map(r => (
            <label key={r} className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-border cursor-pointer"
                checked={income.includes(r)}
                onChange={e => setIncome(list => toggle(list, r, e.target.checked))}
                aria-describedby={DOUBLE_COUNT.includes(r) && doubleCount ? warnId : undefined}
              />
              <span className="text-foreground">{reason(r)}</span>
            </label>
          ))}
          {doubleCount && (
            <div
              id={warnId}
              role="note"
              data-testid="pnl-settings-double-count"
              className="flex items-start gap-2 text-warning-text bg-warning-subtle border border-warning/20 rounded-lg px-3 py-2"
            >
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
              {t('page.pnl.settings.doubleCount')}
            </div>
          )}
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="font-medium text-foreground mb-1">
            {t('page.pnl.settings.expenseTitle')}
          </legend>
          <p className="text-muted-foreground">{t('page.pnl.settings.expenseHint')}</p>
          {PNL_EXPENSE_CASH_REASON_OPTIONS.map(r => {
            const required = r === PNL_EXPENSE_CASH_REASON_REQUIRED;
            return (
              <label
                key={r}
                className={
                  required ? 'flex items-center gap-2' : 'flex items-center gap-2 cursor-pointer'
                }
              >
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-border cursor-pointer disabled:cursor-default"
                  checked={required || expense.includes(r)}
                  disabled={required}
                  onChange={e => setExpense(list => toggle(list, r, e.target.checked))}
                />
                <span className="text-foreground">{reason(r)}</span>
                {required && (
                  <span className="text-muted-foreground">{t('page.pnl.settings.always')}</span>
                )}
              </label>
            );
          })}
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="font-medium text-foreground mb-1">
            {t('page.pnl.settings.payrollTitle')}
          </legend>
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="h-4 w-4 mt-0.5 rounded border-border cursor-pointer"
              checked={warnFuture}
              onChange={e => setWarnFuture(e.target.checked)}
            />
            <span className="text-foreground">{t('page.pnl.settings.warnFuturePayroll')}</span>
          </label>
        </fieldset>

        {error && (
          <div
            role="alert"
            className="text-destructive bg-destructive-subtle border border-destructive/30 rounded-lg px-3 py-2"
          >
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
