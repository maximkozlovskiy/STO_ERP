'use client';

import { useEffect, useMemo, useState, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { keepPreviousData } from '@tanstack/react-query';
import { pricingRulesKeys } from '@/hooks/api/usePricingRules';
import { Plus, Pencil, Trash2, Upload, Tag } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch, apiMultipartFetch } from '@/lib/api-client';
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
import { useDebounce } from '@/hooks/useDebounce';
import { cn } from '@/lib/utils';
import { getCached, setCache } from '@/lib/ref-cache';
import {
  type Good,
  type Brand,
  type PricingRule,
  type RuleForm,
  EMPTY_FORM,
  TYPE_LABELS,
  GOOD_TYPE_OPTIONS,
} from './types';

// Heavy form modal — лише при першому відкритті (Створити/Редагувати правило).
// Виносимо у окремий chunk: Modal + 8+ Input/Select/Tier rows = ~350 LOC JSX, не
// потрібні поки користувач переглядає таблицю правил.
const RuleFormModal = dynamic(() => import('./RuleFormModal'), { ssr: false });

function valueLabel(rule: PricingRule): string {
  switch (rule.type) {
    case 'PERCENT':
    case 'COMPETITOR_PLUS':
      return rule.percentValue != null ? `+${rule.percentValue}%` : '—';
    case 'FIXED_AMOUNT':
      return rule.fixedAmount != null ? `+${fmtMoney(rule.fixedAmount)} ₴` : '—';
    case 'FIXED_PRICE':
      return rule.fixedPrice != null ? `${fmtMoney(rule.fixedPrice)} ₴` : '—';
    case 'COST_TIER':
      return rule.tiers && rule.tiers.length > 0 ? `${rule.tiers.length} грейд(ів)` : '—';
    default:
      return '—';
  }
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function PricingRulesClient() {
  useRequireAuth(['OWNER', 'ADMIN', 'STOREKEEPER']);

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
  const invalidateRules = () => qc.invalidateQueries({ queryKey: pricingRulesKeys.all });
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search);
  const [goods, setGoods] = useState<Good[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(false);
  const [editRule, setEditRule] = useState<PricingRule | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

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

  // Bug #30: tracking mounted state — refetch після create/update/delete не повинен setState
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
        (r.goodCategory ?? '').toLowerCase().includes(q) ||
        (r.good?.name ?? '').toLowerCase().includes(q),
    );
  }, [rules, debouncedSearch]);

  useEffect(() => {
    let cancelled = false;
    // sto-optimize: seed brands from ref-cache (used by catalog/BrandsTab + goods).
    // Brand modal opens instantly if cache hot from prior session navigation.
    // goods is not in ref-cache — too high cardinality (could be 1000+).
    const cachedBrands = getCached<Brand[]>('cache:brands');
    if (cachedBrands?.length) setBrands(cachedBrands);

    // Bug #32: `/goods?limit=500` валиться на ValidationPipe (GoodQueryDto.@Max(200)).
    // Узгоджуємо з рештою сторінок (dashboard, work-orders, invoices використовують limit=200).
    Promise.all([
      apiFetch<{ items: Good[] }>('/goods?limit=200'),
      apiFetch<{ items: Brand[]; total: number }>('/brands'),
    ])
      .then(([goodsRes, brandsRes]) => {
        if (!cancelled) {
          setGoods(goodsRes.items);
          setBrands(brandsRes.items);
          setCache('cache:brands', brandsRes.items);
        }
      })
      .catch((e: unknown) => {
        // Bug #29: не ковтаємо помилку мовчки. Логуємо для діагностики,
        // але не блокуємо UI (правила можна редагувати без списку товарів/брендів).
        console.warn('Не вдалося завантажити довідники для форми правила:', e);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Bug #23: надсилаємо лише значення, релевантне для обраного type, щоб не зберігати
  // "сміттєві" поля з минулої редакції форми.
  const buildPayload = (form: RuleForm) => {
    const isPercent = form.type === 'PERCENT' || form.type === 'COMPETITOR_PLUS';
    const isFixedAmount = form.type === 'FIXED_AMOUNT';
    const isFixedPrice = form.type === 'FIXED_PRICE';
    const isCostTier = form.type === 'COST_TIER';
    return {
      name: form.name,
      type: form.type,
      priority: Number(form.priority) || 10,
      goodId: form.goodId || undefined,
      goodCategory: form.goodId ? undefined : form.goodCategory || undefined,
      goodType: form.goodId || form.goodCategory ? undefined : form.goodType || undefined,
      brandId: form.brandId || undefined,
      supplierId: form.supplierId || undefined,
      percentValue: isPercent && form.percentValue ? Number(form.percentValue) : undefined,
      fixedAmount: isFixedAmount && form.fixedAmount ? Number(form.fixedAmount) : undefined,
      fixedPrice: isFixedPrice && form.fixedPrice ? Number(form.fixedPrice) : undefined,
      roundTo: form.roundTo ? Number(form.roundTo) : undefined,
      tiers: isCostTier ? form.tiers.map((t, i) => ({ ...t, sortOrder: i })) : undefined,
    };
  };

  const createRule = async (form: RuleForm) => {
    await apiFetch<PricingRule>('/pricing-rules', {
      method: 'POST',
      body: JSON.stringify(buildPayload(form)),
    });
    load();
  };

  const updateRule = async (form: RuleForm) => {
    if (!editRule) return;
    await apiFetch<PricingRule>(`/pricing-rules/${editRule.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ ...buildPayload(form), isActive: form.isActive }),
    });
    if (mountedRef.current) setEditRule(null);
    load();
  };

  const deleteRule = async (id: string) => {
    if (!(await confirm({ title: 'Видалити правило ціноутворення?', variant: 'destructive' })))
      return;
    setDeletingId(id);
    try {
      await apiFetch<void>(`/pricing-rules/${id}`, { method: 'DELETE' });
      load();
    } catch (e: unknown) {
      if (mountedRef.current) setError(e instanceof Error ? e.message : 'Помилка видалення');
    } finally {
      if (mountedRef.current) setDeletingId(null);
    }
  };

  const editFormInitial: RuleForm = editRule
    ? {
        name: editRule.name,
        type: editRule.type,
        priority: String(editRule.priority),
        goodId: editRule.goodId ?? '',
        goodCategory: editRule.goodCategory ?? '',
        goodType: editRule.goodType ?? '',
        percentValue: editRule.percentValue != null ? String(editRule.percentValue) : '',
        fixedAmount: editRule.fixedAmount != null ? String(editRule.fixedAmount) : '',
        fixedPrice: editRule.fixedPrice != null ? String(editRule.fixedPrice) : '',
        roundTo: editRule.roundTo != null ? String(editRule.roundTo) : '',
        isActive: editRule.isActive,
        brandId: editRule.brandId ?? '',
        supplierId: editRule.supplierId ?? '',
        supplierName: editRule.supplierName ?? '',
        tiers: editRule.tiers ?? [],
      }
    : EMPTY_FORM;

  return (
    <div className="page-fill p-4 md:p-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Правила ціноутворення</h1>
          <p className="page-subtitle">
            Автоматичне розрахування ціни продажу при оприбуткуванні товарів
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap shrink-0">
        <Input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Пошук по назві, постачальнику, бренду…"
          className="w-72 h-8 text-[13px]"
        />
        <div className="flex items-center gap-2 ml-auto">
          <Button
            type="button"
            variant="outline"
            leftIcon={<Upload className="h-4 w-4" />}
            onClick={() => {
              setShowPricingImport(s => !s);
              setPricingImportResult(null);
            }}
          >
            Розцінити список
          </Button>
          <Button
            leftIcon={<Plus className="h-4 w-4" />}
            onClick={() => {
              setError('');
              setModal(true);
            }}
          >
            Правило
          </Button>
        </div>
      </div>

      {showPricingImport && (
        <AnimatedBody className="mb-6 rounded-xl border border-border bg-secondary/30 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-foreground">
              Розцінити товари за списком
            </span>
            <button
              type="button"
              className="text-[12px] text-primary hover:underline"
              onClick={async () => {
                try {
                  const data = await apiFetch<{ file: string; filename: string }>(
                    '/xlsx/templates/pricing-list',
                  );
                  const bytes = Uint8Array.from(atob(data.file), c => c.charCodeAt(0));
                  const blob = new Blob([bytes], { type: 'text/csv; charset=utf-8' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = data.filename;
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(url), 100);
                } catch (e: unknown) {
                  setError(e instanceof Error ? e.message : 'Помилка завантаження шаблону');
                }
              }}
            >
              Завантажити шаблон CSV
            </button>
          </div>
          <p className="text-[12px] text-muted-foreground">
            Завантажте XLSX або CSV файл з колонками: <code>sku</code>, <code>barcode</code>,{' '}
            <code>name</code>
          </p>
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
              onClick={async () => {
                if (!pricingFile) return;
                setPricingImporting(true);
                try {
                  const fd = new FormData();
                  fd.append('file', pricingFile);
                  // Bug #197: FormData потребує multipart/form-data Content-Type з boundary,
                  // що `apiFetch` перетирає на application/json → 400 "не multipart". Використовуємо apiMultipartFetch.
                  const result = await apiMultipartFetch<PricingImportResult>(
                    '/xlsx/apply-pricing-from-list',
                    fd,
                  );
                  setPricingImportResult(result);
                  if (result.updated > 0) setError('');
                } catch (e: unknown) {
                  setError(e instanceof Error ? e.message : 'Помилка розцінки');
                } finally {
                  setPricingImporting(false);
                }
              }}
            >
              Розцінити
            </Button>
          </div>
          {pricingImportResult && (
            <div className="space-y-2">
              <div className="flex gap-4 text-[12px]">
                <span className="text-muted-foreground">
                  Знайдено: <strong className="text-foreground">{pricingImportResult.found}</strong>
                </span>
                <span className="text-muted-foreground">
                  Оновлено: <strong className="text-success">{pricingImportResult.updated}</strong>
                </span>
                {pricingImportResult.notFound.length > 0 && (
                  <span className="text-muted-foreground">
                    Не знайдено:{' '}
                    <strong className="text-destructive">
                      {pricingImportResult.notFound.length}
                    </strong>
                  </span>
                )}
              </div>
              {pricingImportResult.notFound.length > 0 && (
                <p className="text-[11px] text-destructive">
                  Не знайдено: {pricingImportResult.notFound.join(', ')}
                </p>
              )}
              {pricingImportResult.details.length > 0 && (
                <div className="rounded-lg border border-border overflow-hidden">
                  <table className="w-full text-[12px]">
                    <thead className="bg-secondary border-b border-border">
                      <tr>
                        <th className="text-left px-3 py-1.5 text-muted-foreground font-medium">
                          Товар
                        </th>
                        <th className="text-left px-3 py-1.5 text-muted-foreground font-medium">
                          SKU
                        </th>
                        <th className="text-right px-3 py-1.5 text-muted-foreground font-medium">
                          Собів.
                        </th>
                        <th className="text-right px-3 py-1.5 text-muted-foreground font-medium">
                          Стара
                        </th>
                        <th className="text-right px-3 py-1.5 text-muted-foreground font-medium">
                          Нова
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
              <TableHead>Дата</TableHead>
              <TableHead>Назва</TableHead>
              <TableHead>Тип</TableHead>
              <TableHead>Постачальник</TableHead>
              <TableHead>Бренд</TableHead>
              <TableHead>Область</TableHead>
              <TableHead>Значення</TableHead>
              <TableHead>Пріоритет</TableHead>
              <TableHead>Статус</TableHead>
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
                    title="Правил немає"
                    description="Створіть перше правило ціноутворення щоб автоматизувати встановлення цін при оприбуткуванні"
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
                        Округлення до {rule.roundTo} ₴
                      </p>
                    )}
                  </TableCell>
                  <TableCell className="text-[13px] text-muted-foreground">
                    {TYPE_LABELS[rule.type] ?? rule.type}
                  </TableCell>
                  <TableCell className="text-[13px] text-muted-foreground">
                    {rule.supplierId ? (rule.supplierName ?? '—') : 'Весь асортимент'}
                  </TableCell>
                  <TableCell className="text-[13px] text-muted-foreground">
                    {rule.brandName ? (
                      <Badge variant="secondary">{rule.brandName}</Badge>
                    ) : (
                      <span className="text-muted-foreground/40">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-[13px] text-muted-foreground">
                    {rule.goodId && rule.good
                      ? `Товар: ${rule.good.name}`
                      : rule.goodType
                        ? (GOOD_TYPE_OPTIONS.find(o => o.value === rule.goodType)?.label ??
                          rule.goodType)
                        : rule.goodCategory
                          ? `Категорія: ${rule.goodCategory}`
                          : 'Весь асортимент'}
                  </TableCell>
                  <TableCell className="text-[13px] font-medium text-foreground">
                    {rule.type === 'COST_TIER' && rule.tiers && rule.tiers.length > 0 ? (
                      <div className="text-[12px] text-muted-foreground space-y-0.5">
                        {rule.tiers.map((t, i) => (
                          <div key={i}>
                            {t.costMin}–{t.costMax ?? '∞'} ₴ → {t.percentValue}%
                          </div>
                        ))}
                      </div>
                    ) : (
                      valueLabel(rule)
                    )}
                  </TableCell>
                  <TableCell className="text-[13px] text-muted-foreground text-center">
                    {rule.priority}
                  </TableCell>
                  <TableCell>
                    <Badge variant={rule.isActive ? 'success' : 'secondary'}>
                      {rule.isActive ? 'Активне' : 'Вимкнено'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setEditRule(rule)}
                        title="Редагувати"
                        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => deleteRule(rule.id)}
                        disabled={deletingId === rule.id}
                        title="Видалити"
                        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
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
        goods={goods}
        brands={brands}
      />

      {/* Edit rule modal */}
      <RuleFormModal
        open={!!editRule}
        onClose={() => setEditRule(null)}
        onSave={updateRule}
        initial={editFormInitial}
        initialCreatedAt={editRule?.createdAt ?? null}
        goods={goods}
        brands={brands}
      />
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
