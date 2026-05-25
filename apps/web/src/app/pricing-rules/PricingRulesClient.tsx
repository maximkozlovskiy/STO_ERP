'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Plus, Pencil, Trash2, Zap } from 'lucide-react';
import { useRequireAuth } from '@/lib/auth';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Good { id: string; name: string; sku: string | null; }

interface PricingRule {
  id: string;
  name: string;
  type: 'PERCENT' | 'FIXED_AMOUNT' | 'FIXED_PRICE' | 'COMPETITOR_PLUS';
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
};

const EMPTY_FORM: RuleForm = {
  name: '', type: 'PERCENT', priority: '10',
  goodId: '', goodCategory: '', goodType: '',
  percentValue: '', fixedAmount: '', fixedPrice: '',
  roundTo: '', isActive: true,
};

const TYPE_LABELS: Record<string, string> = {
  PERCENT: 'Відсоток від собівартості',
  FIXED_AMOUNT: 'Фіксована надбавка',
  FIXED_PRICE: 'Фіксована ціна',
  COMPETITOR_PLUS: 'Конкурент + %',
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
  if (rule.goodType) return `Тип: ${GOOD_TYPE_OPTIONS.find(o => o.value === rule.goodType)?.label ?? rule.goodType}`;
  if (rule.goodCategory) return `Категорія: ${rule.goodCategory}`;
  return 'Весь асортимент';
}

function valueLabel(rule: PricingRule): string {
  switch (rule.type) {
    case 'PERCENT':
    case 'COMPETITOR_PLUS':
      return rule.percentValue != null ? `+${rule.percentValue}%` : '—';
    case 'FIXED_AMOUNT':
      return rule.fixedAmount != null ? `+${rule.fixedAmount.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴` : '—';
    case 'FIXED_PRICE':
      return rule.fixedPrice != null ? `${rule.fixedPrice.toLocaleString('uk-UA', { minimumFractionDigits: 2 })} ₴` : '—';
    default:
      return '—';
  }
}

// ─── Rule Form Modal ──────────────────────────────────────────────────────────

function RuleFormModal({
  open, onClose, onSave, initial, goods,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (form: RuleForm) => Promise<void>;
  initial: RuleForm;
  goods: Good[];
}) {
  const [form, setForm] = useState<RuleForm>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { if (open) { setForm(initial); setError(''); } }, [open, initial]);

  const set = (patch: Partial<RuleForm>) => setForm(f => ({ ...f, ...patch }));

  const submit = async () => {
    if (!form.name.trim()) { setError('Введіть назву правила'); return; }
    if (form.type === 'PERCENT' || form.type === 'COMPETITOR_PLUS') {
      if (!form.percentValue || Number(form.percentValue) < 0) { setError('Введіть відсоток надбавки'); return; }
    }
    if (form.type === 'FIXED_AMOUNT') {
      if (!form.fixedAmount || Number(form.fixedAmount) < 0) { setError('Введіть суму надбавки'); return; }
    }
    if (form.type === 'FIXED_PRICE') {
      if (!form.fixedPrice || Number(form.fixedPrice) <= 0) { setError('Введіть фіксовану ціну'); return; }
    }
    setSaving(true); setError('');
    try { await onSave(form); onClose(); }
    catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка збереження'); }
    finally { setSaving(false); }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={initial.name ? 'Редагування правила' : 'Нове правило ціноутворення'}
      footer={
        <>
          <Button onClick={submit} loading={saving} disabled={!form.name}>Зберегти</Button>
          <Button variant="outline" onClick={onClose}>Скасувати</Button>
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
          onChange={e => set({ type: e.target.value as PricingRule['type'] })}
        >
          {Object.entries(TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>

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

        <Input
          label="Округлення до, ₴ (необов'язково)"
          type="number"
          value={form.roundTo}
          onChange={e => set({ roundTo: e.target.value })}
          hint="Напр. 0.5 → до 50 коп, 1 → до гривні"
          placeholder="0.5"
        />

        <div className="border-t border-border pt-3 space-y-3">
          <p className="text-[12px] font-semibold text-muted-foreground uppercase tracking-wide">Область застосування</p>
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
              <option key={g.id} value={g.id}>{g.name}{g.sku ? ` (${g.sku})` : ''}</option>
            ))}
          </Select>

          <Select
            label="Тип товару (необов'язково)"
            value={form.goodType}
            onChange={e => set({ goodType: e.target.value })}
          >
            {GOOD_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
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

  const [rules, setRules] = useState<PricingRule[]>([]);
  const [goods, setGoods] = useState<Good[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(false);
  const [editRule, setEditRule] = useState<PricingRule | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<{ ruleId: string; message: string } | null>(null);

  // Bug #30: tracking mounted state — refetch після create/update/delete не повинен setState
  // на unmounted компонент (race коли користувач перейшов на іншу сторінку).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
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
    apiFetch<{ items: Good[] }>('/goods?limit=500')
      .then(r => { if (!cancelled) setGoods(r.items); })
      .catch((e: unknown) => {
        // Bug #29: не ковтаємо помилку мовчки. Логуємо для діагностики,
        // але не блокуємо UI (правила можна редагувати без списку товарів).
        console.warn('Не вдалося завантажити товари для форми правила:', e);
      });
    return () => { cancelled = true; };
  }, []);

  // Bug #23: надсилаємо лише значення, релевантне для обраного type, щоб не зберігати
  // "сміттєві" поля з минулої редакції форми.
  const buildPayload = (form: RuleForm) => {
    const isPercent = form.type === 'PERCENT' || form.type === 'COMPETITOR_PLUS';
    const isFixedAmount = form.type === 'FIXED_AMOUNT';
    const isFixedPrice = form.type === 'FIXED_PRICE';
    return {
      name: form.name,
      type: form.type,
      priority: Number(form.priority) || 10,
      goodId: form.goodId || undefined,
      goodCategory: form.goodId ? undefined : (form.goodCategory || undefined),
      goodType: form.goodId || form.goodCategory ? undefined : (form.goodType || undefined),
      percentValue: isPercent && form.percentValue ? Number(form.percentValue) : undefined,
      fixedAmount: isFixedAmount && form.fixedAmount ? Number(form.fixedAmount) : undefined,
      fixedPrice: isFixedPrice && form.fixedPrice ? Number(form.fixedPrice) : undefined,
      roundTo: form.roundTo ? Number(form.roundTo) : undefined,
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
    setEditRule(null);
    load();
  };

  const deleteRule = async (id: string) => {
    if (!confirm('Видалити правило ціноутворення?')) return;
    setDeletingId(id);
    try {
      await apiFetch<void>(`/pricing-rules/${id}`, { method: 'DELETE' });
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка видалення');
    } finally {
      setDeletingId(null);
    }
  };

  const applyAll = async (rule: PricingRule) => {
    if (!confirm(`Застосувати правило "${rule.name}" до всіх відповідних товарів? Ціни буде перераховано.`)) return;
    setApplyingId(rule.id);
    setApplyResult(null);
    try {
      const result = await apiFetch<{ updated: number; message: string }>(`/pricing-rules/${rule.id}/apply-all`, { method: 'POST' });
      setApplyResult({ ruleId: rule.id, message: result.message });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка застосування');
    } finally {
      setApplyingId(null);
    }
  };

  const editFormInitial = editRule ? {
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
  } : EMPTY_FORM;

  return (
    <div className="page-container">
      <div className="page-header mb-6">
        <div>
          <h1 className="page-title">Правила ціноутворення</h1>
          <p className="page-subtitle">Автоматичне розрахування ціни продажу при оприбуткуванні товарів</p>
        </div>
        <Button leftIcon={<Plus className="h-4 w-4" />} onClick={() => { setError(''); setModal(true); }}>
          Додати правило
        </Button>
      </div>

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
                  <div className="flex justify-center"><Spinner size="md" /></div>
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
            {!loading && rules.map(rule => (
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
                  {scopeLabel(rule)}
                </TableCell>
                <TableCell className="text-[13px] font-medium text-foreground">
                  {valueLabel(rule)}
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
                      className="text-destructive/60 hover:text-destructive"
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
      />

      {/* Edit rule modal */}
      <RuleFormModal
        open={!!editRule}
        onClose={() => setEditRule(null)}
        onSave={updateRule}
        initial={editFormInitial}
        goods={goods}
      />
    </div>
  );
}
