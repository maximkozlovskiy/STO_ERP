'use client';

import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { fmtMoney, fmtQty } from '@/lib/format';
import type { PayrollLine } from '@/hooks/api/usePayroll';

type SchemeLine = Pick<PayrollLine, 'rateSchemeType' | 'rateParams' | 'rateDerived'>;

/**
 * BR-PAYR-016: умови схеми рядка відомості чи попереднього розрахунку текстом
 * («% від суми робіт · 40 %», «за нормо-годину · 250,00 ₴/год», «оклад 20 000,00 ₴ + бонус 5 %»).
 * Виведені з нарахування (рядок без знімка, `rateDerived`) — з «≈»; невідомі умови — лише назва
 * схеми. Одне місце правди для колонки «Схема» відомості й вікна розрахунку.
 */
export function formatSchemeTerms(l: SchemeLine, t: TFunction<'payroll'>): string {
  const p = l.rateParams;
  const approx = l.rateDerived ? t('rateTerms.approx') : '';
  if (l.rateSchemeType === 'percent_normo' && p?.percent != null)
    return t('rateTerms.percent_normo', { approx, percent: fmtQty(p.percent) });
  if (l.rateSchemeType === 'per_normo_hour' && p?.ratePerHour != null)
    return t('rateTerms.per_normo_hour', { approx, rate: fmtMoney(p.ratePerHour) });
  if (l.rateSchemeType === 'fixed_plus_bonus' && p?.fixedMonthly != null && p.bonusPercent != null)
    return t('rateTerms.fixed_plus_bonus', {
      approx,
      fixed: fmtMoney(p.fixedMonthly),
      bonus: fmtQty(p.bonusPercent),
    });
  const labelKey = `rateScheme.${l.rateSchemeType}` as const;
  return t(labelKey, { defaultValue: l.rateSchemeType });
}

/**
 * Умови схеми в клітинці таблиці. Причину «≈» дає `title` (миша) і прихований текст: `title` на
 * нефокусованому span не чує читач екрана й не бачить клавіатура.
 */
export function PayrollSchemeTerms({ line }: { line: SchemeLine }) {
  const { t } = useTranslation('payroll');
  return (
    <>
      <span title={line.rateDerived ? t('rateTerms.derivedTitle') : undefined}>
        {formatSchemeTerms(line, t)}
      </span>
      {line.rateDerived && <span className="sr-only">{` (${t('rateTerms.derivedTitle')})`}</span>}
    </>
  );
}
