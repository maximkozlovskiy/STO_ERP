'use client';

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import type { GoodRefRaw, ResolveGoodsFileResult, ResolvedGoodRef, RuleGood } from './types';

export type ImportMode = 'add' | 'replace';

/** Скільки неоднозначних рядків малюємо одразу: у файлі їх може бути тисячі. */
const AMBIGUOUS_RENDER_LIMIT = 100;
/** Більше — список не знайдених згортається у <details>. */
const NOT_FOUND_INLINE_LIMIT = 10;

const RAW_FIELDS = ['code', 'article', 'brand', 'barcode', 'name'] as const;

/** «код 123 · артикул OC90 · бренд Knecht» — лише заповнені клітинки рядка файла. */
function describeRaw(raw: GoodRefRaw, t: TFunction): string {
  const parts = RAW_FIELDS.filter(f => raw[f]).map(f => `${t(`goodsImport.raw.${f}`)} ${raw[f]}`);
  return parts.length > 0 ? parts.join(' · ') : t('goodsImport.rawEmpty');
}

function candidateLabel(good: ResolvedGoodRef): string {
  const meta = [good.sku, good.brandName, good.internalCode].filter(Boolean).join(' · ');
  return meta ? `${good.name} (${meta})` : good.name;
}

const toRuleGood = (g: ResolvedGoodRef): RuleGood => ({
  id: g.id,
  internalCode: g.internalCode,
  name: g.name,
  sku: g.sku,
  brandName: g.brandName,
});

/**
 * Результат розпізнавання файла зі списком товарів (`POST /xlsx/pricing-rule-goods/resolve`).
 * Панель НІЧОГО не зберігає: «Застосувати» віддає новий ЛОКАЛЬНИЙ список форми, у базу він
 * іде кнопкою «Зберегти» правила.
 */
export default function RuleGoodsImportPanel({
  result,
  current,
  maxGoods,
  onApply,
  onCancel,
}: {
  result: ResolveGoodsFileResult;
  current: RuleGood[];
  maxGoods: number;
  onApply: (next: RuleGood[], mode: ImportMode, affected: number) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('pricingRules');
  // Рішення власника: спосіб застосування питаємо ЩОРАЗУ, типово — «додати».
  const [mode, setMode] = useState<ImportMode>('add');
  // rowIndex неоднозначного рядка → id обраного кандидата ('' / відсутній = пропустити).
  const [picks, setPicks] = useState<Record<number, string>>({});
  const [error, setError] = useState('');

  const currentIds = useMemo(() => new Set(current.map(g => g.id)), [current]);

  /** Товари з файла без дублів: однозначні збіги + обрані кандидати неоднозначних рядків. */
  const chosen = useMemo(() => {
    const byId = new Map<string, RuleGood>();
    for (const row of result.matched) byId.set(row.good.id, toRuleGood(row.good));
    for (const row of result.ambiguous) {
      const picked = row.candidates.find(c => c.id === picks[row.rowIndex]);
      if (picked) byId.set(picked.id, toRuleGood(picked));
    }
    return [...byId.values()];
  }, [result, picks]);

  const fresh = useMemo(() => chosen.filter(g => !currentIds.has(g.id)), [chosen, currentIds]);
  const alreadyInList = chosen.length - fresh.length;
  const next = mode === 'add' ? [...current, ...fresh] : chosen;
  const hasRecognised = result.matched.length + result.ambiguous.length > 0;

  const apply = () => {
    if (next.length > maxGoods) {
      setError(t('goodsImport.limitExceeded', { total: next.length, max: maxGoods }));
      return;
    }
    onApply(next, mode, mode === 'add' ? fresh.length : chosen.length);
  };

  const notFoundItems = result.notFound.map(row => (
    <li key={row.rowIndex}>
      {t('goodsImport.rowLine', { row: row.rowIndex, raw: describeRaw(row.raw, t) })}
    </li>
  ));

  return (
    <section
      aria-label={t('goodsImport.heading')}
      className="rounded-lg border border-border bg-secondary/30 p-3 space-y-3"
    >
      <p className="text-[13px] font-medium text-foreground">{t('goodsImport.heading')}</p>

      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
        <div className="flex gap-1">
          <dt>{t('goodsImport.summaryTotal')}</dt>
          <dd className="font-semibold text-foreground tabular-nums">{result.total}</dd>
        </div>
        <div className="flex gap-1">
          <dt>{t('goodsImport.summaryFound')}</dt>
          <dd className="font-semibold text-success tabular-nums">{result.matched.length}</dd>
        </div>
        {mode === 'add' && (
          <div className="flex gap-1">
            <dt>{t('goodsImport.summaryAlready')}</dt>
            <dd className="font-semibold text-foreground tabular-nums">{alreadyInList}</dd>
          </div>
        )}
        <div className="flex gap-1">
          <dt>{t('goodsImport.summaryNotFound')}</dt>
          <dd className="font-semibold text-destructive tabular-nums">{result.notFound.length}</dd>
        </div>
        <div className="flex gap-1">
          <dt>{t('goodsImport.summaryAmbiguous')}</dt>
          <dd className="font-semibold text-foreground tabular-nums">{result.ambiguous.length}</dd>
        </div>
      </dl>

      {hasRecognised ? (
        <fieldset className="space-y-1">
          <legend className="text-[12px] font-medium text-foreground mb-1">
            {t('goodsImport.modeLegend')}
          </legend>
          {(['add', 'replace'] as const).map(m => (
            <label key={m} className="flex items-center gap-2 cursor-pointer text-[13px]">
              <input
                type="radio"
                name="pricing-rule-goods-import-mode"
                value={m}
                checked={mode === m}
                onChange={() => {
                  setMode(m);
                  setError('');
                }}
                className="h-4 w-4 border-border text-primary"
              />
              <span className="text-foreground">
                {t(m === 'add' ? 'goodsImport.modeAdd' : 'goodsImport.modeReplace')}
              </span>
            </label>
          ))}
          <p className="text-[12px] text-muted-foreground">
            {t('goodsImport.resultPreview')}{' '}
            <strong className="text-foreground tabular-nums">{next.length}</strong>
          </p>
        </fieldset>
      ) : (
        <p className="text-[12px] text-muted-foreground">{t('goodsImport.nothingToApply')}</p>
      )}

      {result.ambiguous.length > 0 && (
        <div className="space-y-2">
          <p className="text-[12px] font-medium text-foreground">
            {t('goodsImport.ambiguousHeading')}
          </p>
          <ul className="space-y-2 max-h-56 overflow-y-auto pr-1">
            {result.ambiguous.slice(0, AMBIGUOUS_RENDER_LIMIT).map(row => (
              <li key={row.rowIndex} className="space-y-1">
                <p className="text-[12px] text-muted-foreground">
                  {t('goodsImport.rowLine', { row: row.rowIndex, raw: describeRaw(row.raw, t) })}
                </p>
                <Select
                  aria-label={t('goodsImport.chooseFor', { row: row.rowIndex })}
                  value={picks[row.rowIndex] ?? ''}
                  onChange={e => {
                    setPicks(p => ({ ...p, [row.rowIndex]: e.target.value }));
                    setError('');
                  }}
                  className="h-8 text-[13px] py-0.5 px-2 pr-7"
                >
                  <option value="">{t('goodsImport.skip')}</option>
                  {row.candidates.map(c => (
                    <option key={c.id} value={c.id}>
                      {candidateLabel(c)}
                    </option>
                  ))}
                </Select>
              </li>
            ))}
          </ul>
          {result.ambiguous.length > AMBIGUOUS_RENDER_LIMIT && (
            <p className="text-[12px] text-muted-foreground tabular-nums">
              {t('goodsImport.ambiguousShown', {
                shown: AMBIGUOUS_RENDER_LIMIT,
                total: result.ambiguous.length,
              })}
            </p>
          )}
        </div>
      )}

      {result.notFound.length > 0 &&
        (result.notFound.length > NOT_FOUND_INLINE_LIMIT ? (
          <details className="text-[12px]">
            <summary className="cursor-pointer text-destructive-text">
              {t('goodsImport.notFoundToggle', { n: result.notFound.length })}
            </summary>
            <ul className="mt-1 max-h-40 overflow-y-auto list-disc list-inside text-muted-foreground space-y-0.5">
              {notFoundItems}
            </ul>
          </details>
        ) : (
          <div className="text-[12px]">
            <p className="font-medium text-destructive-text">{t('goodsImport.notFoundHeading')}</p>
            <ul className="mt-1 list-disc list-inside text-muted-foreground space-y-0.5">
              {notFoundItems}
            </ul>
          </div>
        ))}

      {error && (
        <p
          role="alert"
          className="text-[12px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded px-2 py-1"
        >
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <Button size="sm" onClick={apply} disabled={chosen.length === 0}>
          {t('goodsImport.apply')}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel}>
          {t('goodsImport.cancel')}
        </Button>
      </div>
    </section>
  );
}
