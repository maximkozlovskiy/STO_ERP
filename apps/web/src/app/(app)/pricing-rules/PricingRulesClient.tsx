'use client';

import { useEffect, useMemo, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import dynamic from 'next/dynamic';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { keepPreviousData } from '@tanstack/react-query';
import { pricingRulesKeys } from '@/hooks/api/usePricingRules';
import { Plus, Pencil, Trash2, Upload, Tag, RefreshCw, Search } from 'lucide-react';
import { useAuth, useRequireAuth } from '@/lib/auth';
import { apiFetch, apiMultipartFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { downloadBlob } from '@/lib/download';
import { Button } from '@/components/ui/button';
import { AnimatedBody } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useConfirm } from '@/hooks/useConfirm';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { fmtMoney, fmtDate } from '@/lib/format';
import { Input } from '@/components/ui/input';
import { ListFiltersRow } from '@/components/ui/list-toolbar';
import { useDebounce } from '@/hooks/useDebounce';
import { cn } from '@/lib/utils';
import { getCached, setCache } from '@/lib/ref-cache';
import {
  type Brand,
  type PricingRule,
  type RuleForm,
  EMPTY_FORM,
  TYPE_LABELS,
  GOOD_TYPE_OPTIONS,
  buildCreatePayload,
  buildUpdatePayload,
  ruleToForm,
} from './types';
import { CatalogHelp } from '@/components/ui/help-popover';

// Heavy form modal — лише при першому відкритті (Створити/Редагувати правило).
// Виносимо у окремий chunk: Modal + 8+ Input/Select/Tier rows = ~350 LOC JSX, не
// потрібні поки користувач переглядає таблицю правил.
const RuleFormModal = dynamic(() => import('./RuleFormModal'), { ssr: false });

function valueLabel(rule: PricingRule, t: TFunction): string {
  switch (rule.type) {
    case 'PERCENT':
    case 'COMPETITOR_PLUS':
      return rule.percentValue != null ? `+${rule.percentValue}%` : '—';
    case 'FIXED_AMOUNT':
      return rule.fixedAmount != null ? `+${fmtMoney(rule.fixedAmount)} ₴` : '—';
    case 'FIXED_PRICE':
      return rule.fixedPrice != null ? `${fmtMoney(rule.fixedPrice)} ₴` : '—';
    case 'COST_TIER':
      return rule.tiers && rule.tiers.length > 0
        ? t('value.grades', { count: rule.tiers.length })
        : '—';
    default:
      return '—';
  }
}

/** Колонка «Область»: список товарів > категорія (нова / стара текстова) > тип > усе. */
function scopeLabel(rule: PricingRule, t: TFunction): string {
  if (rule.goodsCount > 0) return t('row.goods', { n: rule.goodsCount });
  // Список є, але всі його товари видалені: правило ні на що не діє — це не «весь асортимент».
  if (rule.hasGoodsList) return t('row.goodsAllDeleted');
  if (rule.goodCategoryId) return t('row.category', { name: rule.goodCategoryName ?? '—' });
  if (rule.goodCategory) return t('row.categoryLegacy', { name: rule.goodCategory });
  if (rule.goodType) {
    const opt = GOOD_TYPE_OPTIONS.find(o => o.value === rule.goodType);
    return opt ? t(opt.labelKey) : rule.goodType;
  }
  return t('row.allAssortment');
}

/**
 * Хто керує правилами: створює, змінює, видаляє, перераховує, бере шаблон списку розцінки.
 * Сервер на ці дії пускає лише OWNER / ADMIN (шаблон — ще XLSX_MANAGER, але сторінка йому
 * закрита). Комірник бачить правила й розцінює список — кнопки, що дали б 403, йому не показуємо.
 */
const RULE_MANAGER_ROLES = ['OWNER', 'ADMIN'];

/** Підказка до «Товари: N»: назви, якщо всі вони вмістились у `goodsPreview` (N ≤ 3). */
function scopeTitle(rule: PricingRule): string | undefined {
  if (rule.goodsCount === 0 || rule.goodsCount > rule.goodsPreview.length) return undefined;
  return rule.goodsPreview.map(g => g.name).join(', ');
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function PricingRulesClient() {
  useRequireAuth(['OWNER', 'ADMIN', 'STOREKEEPER']);
  const { employee } = useAuth();
  const canManage = RULE_MANAGER_ROLES.includes(employee?.role ?? '');

  const { t } = useTranslation('pricingRules');
  const { confirm, dialogProps } = useConfirm();
  const qc = useQueryClient();
  const { data: rules = [], isLoading: loading } = useQuery<PricingRule[]>({
    queryKey: pricingRulesKeys.list(),
    queryFn: ({ signal }) =>
      apiFetch<{ items: PricingRule[]; total: number }>('/pricing-rules', { signal }).then(
        d => d.items,
      ),
    enabled: true,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
  // Фонова інвалідація: TanStack сам перезапитує активні queries і сам тримає їхній
  // error-стан (його показує таблиця правил). Чекати нічого — тому `: void`, щоб усі
  // виклики `load()` разом перестали світитись no-floating-promises.
  const invalidateRules = (): void => void qc.invalidateQueries({ queryKey: pricingRulesKeys.all });
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(false);
  const [editRule, setEditRule] = useState<PricingRule | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [applyingId, setApplyingId] = useState<string | null>(null);

  const [showPricingImport, setShowPricingImport] = useState(false);
  const [pricingFile, setPricingFile] = useState<File | null>(null);
  const [pricingImporting, setPricingImporting] = useState(false);
  interface PricingImportResult {
    found: number;
    updated: number;
    notFound: string[];
    details: {
      goodId: string;
      goodName: string;
      sku: string | null;
      costPrice: number;
      oldSalePrice: number;
      newSalePrice: number;
    }[];
  }
  const [pricingImportResult, setPricingImportResult] = useState<PricingImportResult | null>(null);

  // tracking mounted state — refetch після create/update/delete не повинен setState
  // на unmounted компонент (race коли користувач перейшов на іншу сторінку).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = invalidateRules;

  // sto-optimize: memoize filter — typing in `search` re-renders parent on every
  // keystroke, але реальний `debouncedSearch` змінюється раз на ~300ms; без useMemo
  // `.filter()` біжить по всіх правилах на КОЖЕН keystroke навіть коли predicate
  // ідентичний. Identity-стабільний masaв тримає `.map(rule => ...)` chain pure.
  const filteredRules = useMemo(() => {
    if (!debouncedSearch) return rules;
    const q = debouncedSearch.toLowerCase();
    return rules.filter(
      r =>
        r.name.toLowerCase().includes(q) ||
        (r.supplierName ?? '').toLowerCase().includes(q) ||
        (r.brandName ?? '').toLowerCase().includes(q) ||
        (r.goodCategoryName ?? '').toLowerCase().includes(q) ||
        (r.goodCategory ?? '').toLowerCase().includes(q) ||
        r.goodsPreview.some(g => g.name.toLowerCase().includes(q)),
    );
  }, [rules, debouncedSearch]);

  useEffect(() => {
    let cancelled = false;
    // sto-optimize: seed brands from ref-cache (used by catalog/BrandsTab + goods).
    // Brand modal opens instantly if cache hot from prior session navigation.
    // Товари сюди НЕ вантажимо: список товарів правила форма тягне сама
    // (GET /pricing-rules/:id/goods), а нові обираються через GoodPickerModal.
    const cachedBrands = getCached<Brand[]>('cache:brands');
    if (cachedBrands?.length) setBrands(cachedBrands);

    apiFetch<{ items: Brand[]; total: number }>('/brands')
      .then(brandsRes => {
        if (!cancelled) {
          setBrands(brandsRes.items);
          setCache('cache:brands', brandsRes.items);
        }
      })
      .catch((e: unknown) => {
        // не ковтаємо помилку мовчки. Логуємо для діагностики,
        // але не блокуємо UI (правила можна редагувати без списку брендів).
        console.warn(t('errors.refDataLoad'), e);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  const createRule = async (form: RuleForm) => {
    await apiFetch<PricingRule>('/pricing-rules', {
      method: 'POST',
      body: JSON.stringify(buildCreatePayload(form)),
    });
    load();
  };

  const updateRule = async (form: RuleForm) => {
    if (!editRule) return;
    await apiFetch<PricingRule>(`/pricing-rules/${editRule.id}`, {
      method: 'PATCH',
      // Область іде ЯВНО І ЦІЛКОМ (null / [] для знятого) — див. buildUpdatePayload.
      body: JSON.stringify(buildUpdatePayload(form)),
    });
    if (mountedRef.current) setEditRule(null);
    load();
  };

  const deleteRule = async (id: string) => {
    if (!(await confirm({ title: t('confirm.deleteTitle'), variant: 'destructive' }))) return;
    setDeletingId(id);
    try {
      await apiFetch<void>(`/pricing-rules/${id}`, { method: 'DELETE' });
      load();
    } catch (e: unknown) {
      if (mountedRef.current) setError(e instanceof Error ? e.message : t('errors.delete'));
    } finally {
      if (mountedRef.current) setDeletingId(null);
    }
  };

  // POST /pricing-rules/:id/apply-all — негайно перерахувати ціни всіх товарів,
  // що підпадають під це правило (без очікування наступного PO/nightly job).
  const applyRule = async (rule: PricingRule) => {
    if (
      !(await confirm({
        title: t('confirm.applyTitle', { name: rule.name }),
        message: t('confirm.applyMessage'),
      }))
    )
      return;
    setApplyingId(rule.id);
    try {
      const res = await apiFetch<{ updated: number; message: string }>(
        `/pricing-rules/${rule.id}/apply-all`,
        { method: 'POST' },
      );
      if (mountedRef.current) setError('');
      toast.success(res.message);
    } catch (e: unknown) {
      if (mountedRef.current) setError(e instanceof Error ? e.message : t('errors.apply'));
    } finally {
      if (mountedRef.current) setApplyingId(null);
    }
  };

  // useMemo — НЕ оптимізація: форма скидає свій стан щоразу, коли змінюється `initial`
  // (useEffect([open, initial])). Новий об'єкт на кожен рендер сторінки (наприклад, після
  // фонового refetch правил) стирав би незбережені правки форми разом зі списком товарів.
  const editFormInitial = useMemo<RuleForm>(
    () => (editRule ? ruleToForm(editRule) : EMPTY_FORM),
    [editRule],
  );

  return (
    <div className="page-fill p-4 md:p-6">
      <div className="page-header">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="page-title">{t('title')}</h1>
            {/* Ієрархія правил — good.md «Ціноутворення», BR-GOOD-009..011 */}
            <CatalogHelp ns="pricingRules" topic="help" align="start" width="lg" />
          </div>
          <p className="page-subtitle">{t('subtitle')}</p>
        </div>
      </div>

      {/* Filters */}
      <ListFiltersRow
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              leftIcon={<Upload className="h-4 w-4" />}
              onClick={() => {
                setShowPricingImport(s => !s);
                setPricingImportResult(null);
              }}
            >
              {t('actions.priceList')}
            </Button>
            {canManage && (
              <Button
                leftIcon={<Plus className="h-4 w-4" />}
                onClick={() => {
                  setError('');
                  setModal(true);
                }}
              >
                {t('actions.rule')}
              </Button>
            )}
          </>
        }
      >
        <Input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={t('searchPlaceholder')}
          leftElement={<Search />}
          className="w-72 h-8 text-[13px]"
        />
      </ListFiltersRow>

      {showPricingImport && (
        <AnimatedBody className="mb-6 rounded-xl border border-border bg-secondary/30 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-foreground">{t('import.heading')}</span>
            {canManage && (
              <button
                type="button"
                className="text-[12px] text-primary hover:underline"
                onClick={() => {
                  // (А) Увесь async-блок має власний try/catch із setError —
                  // відмова видна користувачу в банері помилки вище.
                  void (async () => {
                    try {
                      const data = await apiFetch<{ file: string; filename: string }>(
                        '/xlsx/templates/pricing-list',
                      );
                      const bytes = Uint8Array.from(atob(data.file), c => c.charCodeAt(0));
                      const blob = new Blob([bytes], { type: 'text/csv; charset=utf-8' });
                      downloadBlob(blob, data.filename);
                    } catch (e: unknown) {
                      setError(e instanceof Error ? e.message : t('errors.template'));
                    }
                  })();
                }}
              >
                {t('import.downloadTemplate')}
              </button>
            )}
          </div>
          <p className="text-[12px] text-muted-foreground">
            {t('import.hint')} <code>code</code>, <code>sku</code>, <code>brand</code>,{' '}
            <code>barcode</code>, <code>name</code>
          </p>
          <p className="text-[12px] text-muted-foreground">{t('import.hintLookup')}</p>
          <div className="flex items-center gap-3">
            <input
              type="file"
              accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
              onChange={e => {
                setPricingFile(e.target.files?.[0] ?? null);
                setPricingImportResult(null);
              }}
              className="text-[13px] text-foreground"
            />
            <Button
              type="button"
              size="sm"
              loading={pricingImporting}
              disabled={!pricingFile}
              onClick={() => {
                void (async () => {
                  if (!pricingFile) return;
                  setPricingImporting(true);
                  try {
                    const fd = new FormData();
                    fd.append('file', pricingFile);
                    // FormData потребує multipart/form-data Content-Type з boundary,
                    // що `apiFetch` перетирає на application/json → 400 "не multipart". Використовуємо apiMultipartFetch.
                    const result = await apiMultipartFetch<PricingImportResult>(
                      '/xlsx/apply-pricing-from-list',
                      fd,
                    );
                    setPricingImportResult(result);
                    if (result.updated > 0) setError('');
                  } catch (e: unknown) {
                    setError(e instanceof Error ? e.message : t('errors.import'));
                  } finally {
                    setPricingImporting(false);
                  }
                })();
              }}
            >
              {t('import.run')}
            </Button>
          </div>
          {pricingImportResult && (
            <div className="space-y-2">
              <div className="flex gap-4 text-[12px]">
                <span className="text-muted-foreground">
                  {t('import.found')}{' '}
                  <strong className="text-foreground">{pricingImportResult.found}</strong>
                </span>
                <span className="text-muted-foreground">
                  {t('import.updated')}{' '}
                  <strong className="text-success">{pricingImportResult.updated}</strong>
                </span>
                {pricingImportResult.notFound.length > 0 && (
                  <span className="text-muted-foreground">
                    {t('import.notFoundLabel')}{' '}
                    <strong className="text-destructive">
                      {pricingImportResult.notFound.length}
                    </strong>
                  </span>
                )}
              </div>
              {pricingImportResult.notFound.length > 0 && (
                <p className="text-[11px] text-destructive">
                  {t('import.notFoundList', { items: pricingImportResult.notFound.join(', ') })}
                </p>
              )}
              {pricingImportResult.details.length > 0 && (
                <div className="rounded-lg border border-border overflow-hidden">
                  <table className="w-full text-[12px]">
                    <thead className="bg-secondary border-b border-border">
                      <tr>
                        <th className="text-left px-3 py-1.5 text-muted-foreground font-medium">
                          {t('import.columns.good')}
                        </th>
                        <th className="text-left px-3 py-1.5 text-muted-foreground font-medium">
                          {t('import.columns.sku')}
                        </th>
                        <th className="text-right px-3 py-1.5 text-muted-foreground font-medium">
                          {t('import.columns.cost')}
                        </th>
                        <th className="text-right px-3 py-1.5 text-muted-foreground font-medium">
                          {t('import.columns.old')}
                        </th>
                        <th className="text-right px-3 py-1.5 text-muted-foreground font-medium">
                          {t('import.columns.new')}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {pricingImportResult.details.map(d => (
                        <tr
                          key={d.goodId}
                          className={
                            Math.abs(d.oldSalePrice - d.newSalePrice) >= 0.001
                              ? 'bg-surface'
                              : 'bg-surface opacity-60'
                          }
                        >
                          <td className="px-3 py-1.5 text-foreground">{d.goodName}</td>
                          <td className="px-3 py-1.5 text-muted-foreground">{d.sku ?? '—'}</td>
                          <td className="px-3 py-1.5 text-right text-muted-foreground">
                            {fmtMoney(d.costPrice)}
                          </td>
                          <td className="px-3 py-1.5 text-right text-muted-foreground">
                            {fmtMoney(d.oldSalePrice)}
                          </td>
                          <td
                            className={`px-3 py-1.5 text-right font-medium ${Math.abs(d.oldSalePrice - d.newSalePrice) >= 0.001 ? 'text-foreground' : 'text-muted-foreground'}`}
                          >
                            {fmtMoney(d.newSalePrice)} ₴
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </AnimatedBody>
      )}

      {error && (
        <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">
          {error}
        </div>
      )}

      <div className="table-scroll-container flex-1 min-h-0 overflow-auto bg-surface border border-border rounded-xl">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('table.date')}</TableHead>
              <TableHead>{t('table.name')}</TableHead>
              <TableHead>{t('table.type')}</TableHead>
              <TableHead>{t('table.supplier')}</TableHead>
              <TableHead>{t('table.brand')}</TableHead>
              <TableHead>{t('table.scope')}</TableHead>
              <TableHead>{t('table.value')}</TableHead>
              <TableHead>{t('table.priority')}</TableHead>
              <TableHead>{t('table.status')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (
              <TableRow>
                <TableCell colSpan={10} className="py-12 text-center">
                  <div className="flex justify-center">
                    <Spinner size="md" />
                  </div>
                </TableCell>
              </TableRow>
            )}
            {!loading && rules.length === 0 && (
              <TableRow>
                <TableCell colSpan={10} className="p-0">
                  <EmptyState
                    icon={Tag}
                    title={t('empty.title')}
                    description={t('empty.description')}
                  />
                </TableCell>
              </TableRow>
            )}
            {!loading &&
              filteredRules.map(rule => (
                <TableRow
                  key={rule.id}
                  className={cn('group transition-colors', !rule.isActive && 'opacity-60')}
                >
                  <TableCell className="text-[13px] text-muted-foreground whitespace-nowrap">
                    {fmtDate(rule.createdAt)}
                  </TableCell>
                  <TableCell>
                    <p className="text-[13px] font-medium text-foreground">{rule.name}</p>
                    {rule.roundTo != null && (
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        {t('row.roundTo', { value: rule.roundTo })}
                      </p>
                    )}
                  </TableCell>
                  <TableCell className="text-[13px] text-muted-foreground">
                    {TYPE_LABELS[rule.type] ? t(TYPE_LABELS[rule.type]) : rule.type}
                  </TableCell>
                  <TableCell className="text-[13px] text-muted-foreground">
                    {rule.supplierId ? (rule.supplierName ?? '—') : t('row.allAssortment')}
                  </TableCell>
                  <TableCell className="text-[13px] text-muted-foreground">
                    {rule.brandName ? (
                      <Badge variant="secondary">{rule.brandName}</Badge>
                    ) : (
                      <span className="text-muted-foreground/40">—</span>
                    )}
                  </TableCell>
                  <TableCell
                    className="text-[13px] text-muted-foreground tabular-nums"
                    title={scopeTitle(rule)}
                  >
                    {scopeLabel(rule, t)}
                  </TableCell>
                  <TableCell className="text-[13px] font-medium text-foreground">
                    {rule.type === 'COST_TIER' && rule.tiers && rule.tiers.length > 0 ? (
                      <div className="text-[12px] text-muted-foreground space-y-0.5">
                        {rule.tiers.map((tier, i) => (
                          <div key={i}>
                            {tier.costMin}–{tier.costMax ?? '∞'} ₴ → {tier.percentValue}%
                          </div>
                        ))}
                      </div>
                    ) : (
                      valueLabel(rule, t)
                    )}
                  </TableCell>
                  <TableCell className="text-[13px] text-muted-foreground text-center">
                    {rule.priority}
                  </TableCell>
                  <TableCell>
                    <Badge variant={rule.isActive ? 'success' : 'secondary'}>
                      {rule.isActive ? t('row.active') : t('row.inactive')}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                    {canManage && (
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => void applyRule(rule)}
                          disabled={applyingId === rule.id}
                          title={t('rowActions.apply')}
                          aria-label={`${t('rowActions.apply')}: ${rule.name}`}
                          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                        >
                          <RefreshCw
                            className={cn('h-3.5 w-3.5', applyingId === rule.id && 'animate-spin')}
                          />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => setEditRule(rule)}
                          title={t('rowActions.edit')}
                          aria-label={`${t('rowActions.edit')}: ${rule.name}`}
                          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => void deleteRule(rule.id)}
                          disabled={deletingId === rule.id}
                          title={t('rowActions.delete')}
                          aria-label={`${t('rowActions.delete')}: ${rule.name}`}
                          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </div>

      {/* Create rule modal */}
      <RuleFormModal
        open={modal}
        onClose={() => setModal(false)}
        onSave={createRule}
        initial={EMPTY_FORM}
        brands={brands}
      />

      {/* Edit rule modal */}
      <RuleFormModal
        open={!!editRule}
        onClose={() => setEditRule(null)}
        onSave={updateRule}
        initial={editFormInitial}
        initialCreatedAt={editRule?.createdAt ?? null}
        ruleId={editRule?.id ?? null}
        brands={brands}
      />
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
