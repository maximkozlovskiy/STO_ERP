'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Plus, Pencil, Trash2, Zap, Upload } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch, apiMultipartFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Modal, AnimatedBody } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useConfirm } from '@/hooks/useConfirm';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
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
import { fmtMoney } from '@/lib/format';
import { getCached, setCache } from '@/lib/ref-cache';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Good {
  id: string;
  name: string;
  sku: string | null;
}
interface Brand {
  id: string;
  name: string;
}

interface PricingRuleTier {
  id?: string;
  costMin: number;
  costMax: number | null;
  percentValue: number;
  sortOrder: number;
}

interface PricingRule {
  id: string;
  name: string;
  type: 'PERCENT' | 'FIXED_AMOUNT' | 'FIXED_PRICE' | 'COMPETITOR_PLUS' | 'COST_TIER';
  priority: number;
  goodId: string | null;
  good: Good | null;
  goodCategory: string | null;
  goodType: string | null;
  percentValue: number | null;
  fixedAmount: number | null;
  fixedPrice: number | null;
  roundTo: number | null;
  isActive: boolean;
  createdAt: string;
  brandId?: string | null;
  brandName?: string | null;
  tiers?: PricingRuleTier[];
}

type RuleForm = {
  name: string;
  type: PricingRule['type'];
  priority: string;
  goodId: string;
  goodCategory: string;
  goodType: string;
  percentValue: string;
  fixedAmount: string;
  fixedPrice: string;
  roundTo: string;
  isActive: boolean;
  brandId: string;
  tiers: PricingRuleTier[];
};

const EMPTY_FORM: RuleForm = {
  name: '',
  type: 'PERCENT',
  priority: '10',
  goodId: '',
  goodCategory: '',
  goodType: '',
  percentValue: '',
  fixedAmount: '',
  fixedPrice: '',
  roundTo: '',
  isActive: true,
  brandId: '',
  tiers: [],
};

const TYPE_LABELS: Record<string, string> = {
  PERCENT: 'Відсоток від собівартості',
  FIXED_AMOUNT: 'Фіксована надбавка',
  FIXED_PRICE: 'Фіксована ціна',
  COMPETITOR_PLUS: 'Від ціни конкурента',
  COST_TIER: 'Грейди (за собівартістю)',
};

const GOOD_TYPE_OPTIONS = [
  { value: '', label: '— Будь-який —' },
  { value: 'SPARE_PART', label: 'Запчастина' },
  { value: 'CONSUMABLE', label: 'Витратний матеріал' },
  { value: 'MATERIAL', label: 'Матеріал' },
  { value: 'TOOL', label: 'Інструмент' },
];

function scopeLabel(rule: PricingRule): string {
  if (rule.goodId && rule.good) return `Товар: ${rule.good.name}`;
  if (rule.goodType)
    return `Тип: ${GOOD_TYPE_OPTIONS.find(o => o.value === rule.goodType)?.label ?? rule.goodType}`;
  if (rule.goodCategory) return `Категорія: ${rule.goodCategory}`;
  return 'Весь асортимент';
}

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

// ─── Rule Form Modal ──────────────────────────────────────────────────────────

function RuleFormModal({
  open,
  onClose,
  onSave,
  initial,
  goods,
  brands,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (form: RuleForm) => Promise<void>;
  initial: RuleForm;
  goods: Good[];
  brands: Brand[];
}) {
  const [form, setForm] = useState<RuleForm>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setForm(initial);
      setError('');
    }
  }, [open, initial]);

  const set = (patch: Partial<RuleForm>) => setForm(f => ({ ...f, ...patch }));

  // ─── Tier management ───────────────────────────────────────────────────────

  const addTier = () => {
    const prev = form.tiers;
    const lastMax = prev.length > 0 ? prev[prev.length - 1].costMax : 0;
    setForm(f => ({
      ...f,
      tiers: [
        ...f.tiers,
        {
          costMin: lastMax ?? 0,
          costMax: null,
          percentValue: 0,
          sortOrder: f.tiers.length,
        },
      ],
    }));
  };

  const updateTier = (idx: number, field: keyof PricingRuleTier, value: number | null) => {
    setForm(f => ({
      ...f,
      tiers: f.tiers.map((t, i) => (i === idx ? { ...t, [field]: value } : t)),
    }));
  };

  const removeTier = (idx: number) => {
    setForm(f => ({ ...f, tiers: f.tiers.filter((_, i) => i !== idx) }));
  };

  // ─── Submit ────────────────────────────────────────────────────────────────

  const submit = async () => {
    if (!form.name.trim()) {
      setError('Введіть назву правила');
      return;
    }
    if (form.type === 'PERCENT' || form.type === 'COMPETITOR_PLUS') {
      if (!form.percentValue || Number(form.percentValue) < 0) {
        setError('Введіть відсоток надбавки');
        return;
      }
    }
    if (form.type === 'FIXED_AMOUNT') {
      if (!form.fixedAmount || Number(form.fixedAmount) < 0) {
        setError('Введіть суму надбавки');
        return;
      }
    }
    if (form.type === 'FIXED_PRICE') {
      if (!form.fixedPrice || Number(form.fixedPrice) <= 0) {
        setError('Введіть фіксовану ціну');
        return;
      }
    }
    if (form.type === 'COST_TIER') {
      if (form.tiers.length === 0) {
        setError('Додайте хоча б один грейд');
        return;
      }
      for (let i = 0; i < form.tiers.length; i++) {
        const t = form.tiers[i];
        if (t.costMax !== null && t.costMin >= t.costMax) {
          setError(`Грейд ${i + 1}: значення "До" має бути більше "Від"`);
          return;
        }
        if (t.percentValue < 0 || t.percentValue > 999) {
          setError(`Грейд ${i + 1}: відсоток має бути від 0 до 999`);
          return;
        }
      }
    }
    setSaving(true);
    setError('');
    try {
      await onSave(form);
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка збереження');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={initial.name ? 'Редагування правила' : 'Нове правило ціноутворення'}
      size="xl"
      footer={
        <>
          <Button onClick={submit} loading={saving} disabled={!form.name}>
            Зберегти
          </Button>
          <Button variant="outline" onClick={onClose}>
            Скасувати
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && (
          <div className="text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        <Input
          label="Назва правила"
          required
          value={form.name}
          onChange={e => set({ name: e.target.value })}
          placeholder="Запчастини +35%"
        />

        <Select
          label="Тип"
          required
          value={form.type}
          onChange={e =>
            set({
              type: e.target.value as PricingRule['type'],
              tiers:
                e.target.value === 'COST_TIER' && form.tiers.length === 0
                  ? [{ costMin: 0, costMax: 100, percentValue: 30, sortOrder: 0 }]
                  : form.tiers,
            })
          }
        >
          {Object.entries(TYPE_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>

        {/* Brand selector — shown when no specific good is selected */}
        {!form.goodId && (
          <Select
            label="Бренд (для правила по бренду)"
            value={form.brandId}
            onChange={e => set({ brandId: e.target.value })}
          >
            <option value="">— Будь-який бренд —</option>
            {brands.map(b => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        )}

        {/* Dynamic value fields */}
        {(form.type === 'PERCENT' || form.type === 'COMPETITOR_PLUS') && (
          <Input
            label="Надбавка, %"
            required
            type="number"
            value={form.percentValue}
            onChange={e => set({ percentValue: e.target.value })}
            placeholder="35"
          />
        )}
        {form.type === 'FIXED_AMOUNT' && (
          <Input
            label="Надбавка, ₴"
            required
            type="number"
            value={form.fixedAmount}
            onChange={e => set({ fixedAmount: e.target.value })}
            placeholder="50"
          />
        )}
        {form.type === 'FIXED_PRICE' && (
          <Input
            label="Фіксована ціна, ₴"
            required
            type="number"
            value={form.fixedPrice}
            onChange={e => set({ fixedPrice: e.target.value })}
            placeholder="320"
          />
        )}

        {/* COST_TIER grade section */}
        {form.type === 'COST_TIER' && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-medium text-foreground">
                Грейди за собівартістю
              </span>
              <Button
                size="sm"
                variant="outline"
                leftIcon={<Plus className="h-3.5 w-3.5" />}
                onClick={addTier}
              >
                Додати грейд
              </Button>
            </div>
            {form.tiers.length === 0 && (
              <p className="text-[13px] text-muted-foreground text-center py-3">
                Додайте хоча б один грейд
              </p>
            )}
            {form.tiers.map((tier, idx) => (
              <div key={idx} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-end">
                <Input
                  label={idx === 0 ? 'Від (₴)' : ''}
                  type="number"
                  min="0"
                  value={idx === 0 ? '0' : String(tier.costMin)}
                  disabled={idx === 0}
                  onChange={e => updateTier(idx, 'costMin', Number(e.target.value))}
                />
                <Input
                  label={idx === 0 ? 'До (₴)' : ''}
                  type="number"
                  min="0"
                  placeholder={idx === form.tiers.length - 1 ? '∞' : ''}
                  value={tier.costMax == null ? '' : String(tier.costMax)}
                  onChange={e =>
                    updateTier(
                      idx,
                      'costMax',
                      e.target.value === '' ? null : Number(e.target.value),
                    )
                  }
                />
                <Input
                  label={idx === 0 ? 'Націнка (%)' : ''}
                  type="number"
                  min="0"
                  max="999"
                  value={String(tier.percentValue)}
                  onChange={e => updateTier(idx, 'percentValue', Number(e.target.value))}
                />
                <button
                  type="button"
                  onClick={() => removeTier(idx)}
                  className="text-destructive/70 hover:text-destructive p-1.5 rounded mb-0.5"
                  aria-label="Видалити грейд"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        <Input
          label="Округлення до, ₴ (необов'язково)"
          type="number"
          value={form.roundTo}
          onChange={e => set({ roundTo: e.target.value })}
          hint="Напр. 0.5 → до 50 коп, 1 → до гривні"
          placeholder="0.5"
        />

        <div className="border-t border-border pt-3 space-y-3">
          <p className="text-[12px] font-semibold text-muted-foreground uppercase tracking-wide">
            Область застосування
          </p>
          <p className="text-[12px] text-muted-foreground">
            Пріоритет: Товар {'>'} Тип товару {'>'} Весь асортимент
          </p>

          <Select
            label="Конкретний товар (необов'язково)"
            value={form.goodId}
            onChange={e => set({ goodId: e.target.value })}
          >
            <option value="">— Не вказано —</option>
            {goods.map(g => (
              <option key={g.id} value={g.id}>
                {g.name}
                {g.sku ? ` (${g.sku})` : ''}
              </option>
            ))}
          </Select>

          <Select
            label="Тип товару (необов'язково)"
            value={form.goodType}
            onChange={e => set({ goodType: e.target.value })}
          >
            {GOOD_TYPE_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>

          <Input
            label="Категорія (необов'язково)"
            value={form.goodCategory}
            onChange={e => set({ goodCategory: e.target.value })}
            placeholder="Гальмівна система"
            hint="Текстова категорія з картки товару"
          />
        </div>

        <div className="flex items-center gap-2">
          <Input
            label="Пріоритет"
            type="number"
            value={form.priority}
            onChange={e => set({ priority: e.target.value })}
            hint="Менше число = вищий пріоритет"
          />
        </div>

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={form.isActive}
            onChange={e => set({ isActive: e.target.checked })}
            className="h-4 w-4 rounded border-border text-primary"
          />
          <span className="text-[13px] text-foreground">Активне правило</span>
        </label>
      </div>
    </Modal>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function PricingRulesClient() {
  useRequireAuth(['OWNER', 'ADMIN', 'STOREKEEPER']);

  const { confirm, dialogProps } = useConfirm();
  const [rules, setRules] = useState<PricingRule[]>([]);
  const [goods, setGoods] = useState<Good[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(false);
  const [editRule, setEditRule] = useState<PricingRule | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<{ ruleId: string; message: string } | null>(null);

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

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{ items: PricingRule[]; total: number }>('/pricing-rules');
      if (mountedRef.current) setRules(data.items);
    } catch (e: unknown) {
      if (mountedRef.current) setError(e instanceof Error ? e.message : 'Помилка завантаження');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

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

  const applyAll = async (rule: PricingRule) => {
    if (
      !(await confirm({
        title: `Застосувати правило "${rule.name}"?`,
        message: 'Правило буде застосовано до всіх відповідних товарів. Ціни буде перераховано.',
      }))
    )
      return;
    setApplyingId(rule.id);
    setApplyResult(null);
    try {
      const result = await apiFetch<{ updated: number; message: string }>(
        `/pricing-rules/${rule.id}/apply-all`,
        { method: 'POST' },
      );
      if (mountedRef.current) setApplyResult({ ruleId: rule.id, message: result.message });
    } catch (e: unknown) {
      if (mountedRef.current) setError(e instanceof Error ? e.message : 'Помилка застосування');
    } finally {
      if (mountedRef.current) setApplyingId(null);
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
        tiers: editRule.tiers ?? [],
      }
    : EMPTY_FORM;

  return (
    <div className="page-container">
      <div className="page-header mb-6">
        <div>
          <h1 className="page-title">Правила ціноутворення</h1>
          <p className="page-subtitle">
            Автоматичне розрахування ціни продажу при оприбуткуванні товарів
          </p>
        </div>
        <div className="flex items-center gap-2">
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
            Додати правило
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

      {applyResult && (
        <div className="mb-4 text-[13px] text-success bg-success-subtle border border-success/20 rounded-lg px-4 py-2.5 flex items-center justify-between">
          <span>{applyResult.message}</span>
          <button
            onClick={() => setApplyResult(null)}
            aria-label="Закрити сповіщення"
            className="text-muted-foreground hover:text-foreground ml-4"
          >
            ×
          </button>
        </div>
      )}

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Назва</TableHead>
              <TableHead>Тип</TableHead>
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
                <TableCell colSpan={7} className="py-10 text-center">
                  <div className="flex justify-center">
                    <Spinner size="md" />
                  </div>
                </TableCell>
              </TableRow>
            )}
            {!loading && rules.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="p-0">
                  <EmptyState
                    icon={Zap}
                    title="Правил немає"
                    description="Створіть перше правило ціноутворення щоб автоматизувати встановлення цін при оприбуткуванні"
                  />
                </TableCell>
              </TableRow>
            )}
            {!loading &&
              rules.map(rule => (
                <TableRow key={rule.id} className={!rule.isActive ? 'opacity-50' : ''}>
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
                    <div className="space-y-0.5">
                      <div>{scopeLabel(rule)}</div>
                      {rule.brandName && <Badge variant="secondary">{rule.brandName}</Badge>}
                    </div>
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
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => applyAll(rule)}
                        disabled={applyingId === rule.id || !rule.isActive}
                        loading={applyingId === rule.id}
                        title="Застосувати до всіх товарів"
                        aria-label="Застосувати правило до всіх товарів"
                      >
                        <Zap className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditRule(rule)}
                        title="Редагувати"
                        aria-label="Редагувати правило"
                      >
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => deleteRule(rule.id)}
                        disabled={deletingId === rule.id}
                        className="text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                        title="Видалити"
                        aria-label="Видалити правило"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
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
        goods={goods}
        brands={brands}
      />
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
