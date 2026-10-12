'use client';

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import { SearchPickerModal, type SearchPickerItem } from '@/components/ui/search-picker-modal';
import {
  CounterpartyEditModal,
  type CounterpartyForModal,
} from '@/components/ui/CounterpartyEditModal';
import { flattenCategoryTree, type CategoryNode } from '@/components/ui/category-tree';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { displayCounterpartyName } from '@/lib/utils';
import { fmtDate, kyivToday } from '@/lib/format';
import { getCached, setCache } from '@/lib/ref-cache';
import { usePricingRuleGoods } from '@/hooks/api/usePricingRules';
import RuleGoodsField, { type RuleGoodsLoad } from './RuleGoodsField';
import type { Brand, PricingRule, PricingRuleTier, RuleForm } from './types';
import { TYPE_LABELS, GOOD_TYPE_OPTIONS, scopeDimension } from './types';

const GOODS_READY: RuleGoodsLoad = { status: 'ready' };
const NBSP = String.fromCharCode(160);

export default function RuleFormModal({
  open,
  onClose,
  onSave,
  initial,
  initialCreatedAt,
  ruleId,
  brands,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (form: RuleForm) => Promise<void>;
  initial: RuleForm;
  initialCreatedAt?: string | null;
  /** Редагування: id правила — щоб довантажити повний список його товарів. */
  ruleId?: string | null;
  brands: Brand[];
}) {
  const { t } = useTranslation('pricingRules');
  const [form, setForm] = useState<RuleForm>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [supplierPickerOpen, setSupplierPickerOpen] = useState(false);
  const [supplierDetailOpen, setSupplierDetailOpen] = useState(false);
  const [supplierDetailData, setSupplierDetailData] = useState<CounterpartyForModal | null>(null);

  const openSupplierDetail = useCallback(async () => {
    if (!form.supplierId) return;
    try {
      const cp = await apiFetch<CounterpartyForModal>(`/counterparties/${form.supplierId}`);
      setSupplierDetailData(cp);
      setSupplierDetailOpen(true);
    } catch (e: unknown) {
      // Раніше тут був порожній `catch { /* ignore */ }`: при збої картка постачальника
      // просто не відкривалась, і користувач не розумів, чи клік зареєструвався.
      toast.error(e instanceof Error ? e.message : t('formErrors.supplierDetailLoad'));
    }
  }, [form.supplierId, t]);

  useEffect(() => {
    if (open) {
      setForm(initial);
      setError('');
    }
  }, [open, initial]);

  // ─── Список товарів правила (довантаження при редагуванні) ─────────────────
  // У списку правил приходять лише `goodsCount` і перші 3 товари — повний список тягнемо
  // окремо. Поки він не завантажений, «Зберегти» вимкнено: інакше порожній локальний
  // список затер би справжній на сервері.
  // Запитуємо й тоді, коли `goodsCount` у рядку таблиці 0: рядок — знімок, який міг застаріти
  // (щойно збережене правило, інша вкладка, невдалий refetch), а форма з хибно порожнім
  // списком після «додати товар» замінила б ним справжній.
  const { state: goodsState, retry: retryGoods } = usePricingRuleGoods(
    open && ruleId ? ruleId : null,
  );
  const goodsLoad: RuleGoodsLoad = !ruleId
    ? GOODS_READY
    : goodsState.status === 'ready'
      ? GOODS_READY
      : goodsState.status === 'error'
        ? goodsState
        : { status: 'loading' };
  const goodsReady = goodsLoad.status === 'ready';

  // Оголошено ПІСЛЯ ефекту скидання форми: якщо `initial` зміниться при відкритій формі,
  // скидання і повторне підставлення завантаженого списку відбудуться в одному проході.
  useEffect(() => {
    if (open && goodsState.status === 'ready') {
      const items = goodsState.items;
      setForm(f => ({ ...f, goods: items }));
    }
  }, [open, initial, goodsState]);

  // ─── Довідник категорій товарів ────────────────────────────────────────────
  const [categoryTree, setCategoryTree] = useState<CategoryNode[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(false);
  const [categoriesError, setCategoriesError] = useState(false);
  const [categoriesAttempt, setCategoriesAttempt] = useState(0);

  useEffect(() => {
    if (!open) return;
    // Миттєво з ref-кешу (той самий ключ, що в каталозі товарів), далі — свіже дерево.
    const cached = getCached<CategoryNode[]>('cache:good-categories');
    if (Array.isArray(cached)) setCategoryTree(cached);
    const ac = new AbortController();
    setCategoriesLoading(true);
    setCategoriesError(false);
    apiFetch<CategoryNode[]>('/good-categories', { signal: ac.signal })
      .then(tree => {
        if (ac.signal.aborted) return;
        const list = Array.isArray(tree) ? tree : [];
        setCategoryTree(list);
        setCache('cache:good-categories', list);
        setCategoriesLoading(false);
      })
      .catch(() => {
        if (ac.signal.aborted) return;
        setCategoriesError(true);
        setCategoriesLoading(false);
      });
    return () => ac.abort();
  }, [open, categoriesAttempt]);

  // Вимкнені категорії не пропонуємо — окрім тієї, що вже стоїть у правилі.
  const categoryOptions = useMemo(
    () =>
      flattenCategoryTree(categoryTree).filter(
        c => c.isActive !== false || c.id === form.goodCategoryId,
      ),
    [categoryTree, form.goodCategoryId],
  );
  const categoryMissing =
    !!form.goodCategoryId && !categoryOptions.some(c => c.id === form.goodCategoryId);

  // Область має один вимір: товари > бренд > категорія > тип.
  const dimension = scopeDimension(form);
  const categoryOverridden = dimension === 'brand';
  const typeOverridden = dimension === 'brand' || dimension === 'category';

  // Escape закриває КОЖНУ відкриту модалку (слухач на document у кожної). Поки над формою
  // відкрито вибір товару, підтвердження чи картку постачальника, саму форму не закриваємо —
  // інакше Escape у вкладеній модалці забрав би разом із собою незбережений список товарів.
  // Прапорець знімається ПІСЛЯ поточної події (setTimeout): якщо слухач вкладеної модалки
  // спрацьовує першим, React встигає перерендерити форму ще до її слухача, і синхронно знятий
  // прапорець пропускав той самий Escape до форми (у браузері: додати товар → Escape).
  const overlayOpenRef = useRef(false);
  const overlayTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const goodsOverlayRef = useRef(false);
  const supplierOverlayRef = useRef(false);
  const syncOverlay = useCallback(() => {
    clearTimeout(overlayTimerRef.current);
    if (goodsOverlayRef.current || supplierOverlayRef.current) {
      overlayOpenRef.current = true;
      return;
    }
    overlayTimerRef.current = setTimeout(() => {
      overlayOpenRef.current = false;
    }, 0);
  }, []);
  useEffect(() => {
    supplierOverlayRef.current = supplierPickerOpen || supplierDetailOpen;
    syncOverlay();
  }, [supplierPickerOpen, supplierDetailOpen, syncOverlay]);
  useEffect(() => () => clearTimeout(overlayTimerRef.current), []);
  const closeForm = () => {
    if (overlayOpenRef.current) return;
    onClose();
  };

  const set = (patch: Partial<RuleForm>) => setForm(f => ({ ...f, ...patch }));

  type SupplierItem = SearchPickerItem;

  const searchSuppliers = useCallback(async (q: string): Promise<SupplierItem[]> => {
    const url = q.trim()
      ? `/counterparties?q=${encodeURIComponent(q.trim())}&types=SUPPLIER&types=BOTH&limit=30`
      : `/counterparties?types=SUPPLIER&types=BOTH&limit=30`;
    const res = await apiFetch<{
      items: {
        id: string;
        firstName: string | null;
        lastName: string | null;
        companyName: string | null;
      }[];
    }>(url);
    return res.items.map(s => ({
      id: s.id,
      primary: displayCounterpartyName(s),
    }));
  }, []);

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
      setError(t('formErrors.name'));
      return;
    }
    if (form.type === 'PERCENT' || form.type === 'COMPETITOR_PLUS') {
      if (!form.percentValue || Number(form.percentValue) < 0) {
        setError(t('formErrors.percent'));
        return;
      }
    }
    if (form.type === 'FIXED_AMOUNT') {
      if (!form.fixedAmount || Number(form.fixedAmount) < 0) {
        setError(t('formErrors.fixedAmount'));
        return;
      }
    }
    if (form.type === 'FIXED_PRICE') {
      if (!form.fixedPrice || Number(form.fixedPrice) <= 0) {
        setError(t('formErrors.fixedPrice'));
        return;
      }
    }
    if (form.type === 'COST_TIER') {
      if (form.tiers.length === 0) {
        setError(t('formErrors.tierRequired'));
        return;
      }
      for (let i = 0; i < form.tiers.length; i++) {
        const tier = form.tiers[i];
        if (tier.costMax !== null && tier.costMin >= tier.costMax) {
          setError(t('formErrors.tierMaxGtMin', { index: i + 1 }));
          return;
        }
        if (tier.percentValue < 0 || tier.percentValue > 999) {
          setError(t('formErrors.tierPercentRange', { index: i + 1 }));
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
      setError(e instanceof Error ? e.message : t('formErrors.save'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Modal
        open={open}
        onClose={closeForm}
        title={initial.name ? t('form.editTitle') : t('form.createTitle')}
        size="xl"
        footer={
          <>
            {/* (А) submit має власний try/catch із setError — проміс нікому не потрібен. */}
            <Button
              onClick={() => void submit()}
              loading={saving}
              disabled={!form.name || !goodsReady}
            >
              {t('form.save')}
            </Button>
            <Button variant="outline" onClick={onClose}>
              {t('form.cancel')}
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
            label={t('form.createdAt')}
            value={initialCreatedAt ? fmtDate(initialCreatedAt) : fmtDate(kyivToday())}
            readOnly
            disabled
            className="h-8 text-[13px] w-40"
          />

          <Input
            label={t('form.name')}
            required
            value={form.name}
            onChange={e => set({ name: e.target.value })}
            placeholder={t('form.namePlaceholder')}
            className="h-8 text-[13px]"
          />

          <Select
            label={t('form.type')}
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
            className="h-8 text-[13px] py-0.5 px-2 pr-7"
          >
            {Object.entries(TYPE_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {t(l)}
              </option>
            ))}
          </Select>

          {/* Dynamic value fields */}
          {(form.type === 'PERCENT' || form.type === 'COMPETITOR_PLUS') && (
            <Input
              label={t('form.percentValue')}
              required
              type="number"
              min="0"
              value={form.percentValue}
              onChange={e => set({ percentValue: e.target.value })}
              placeholder={t('form.percentPlaceholder')}
              className="h-8 text-[13px]"
            />
          )}
          {form.type === 'FIXED_AMOUNT' && (
            <Input
              label={t('form.fixedAmount')}
              required
              type="number"
              min="0"
              value={form.fixedAmount}
              onChange={e => set({ fixedAmount: e.target.value })}
              placeholder={t('form.fixedAmountPlaceholder')}
              className="h-8 text-[13px]"
            />
          )}
          {form.type === 'FIXED_PRICE' && (
            <Input
              label={t('form.fixedPrice')}
              required
              type="number"
              min="0"
              value={form.fixedPrice}
              onChange={e => set({ fixedPrice: e.target.value })}
              placeholder={t('form.fixedPricePlaceholder')}
              className="h-8 text-[13px]"
            />
          )}

          {/* COST_TIER grade section */}
          {form.type === 'COST_TIER' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-medium text-foreground">
                  {t('form.tiersHeading')}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  leftIcon={<Plus className="h-3.5 w-3.5" />}
                  onClick={addTier}
                >
                  {t('form.addTier')}
                </Button>
              </div>
              {form.tiers.length === 0 && (
                <p className="text-[13px] text-muted-foreground text-center py-3">
                  {t('form.tierEmpty')}
                </p>
              )}
              {form.tiers.map((tier, idx) => (
                <div key={idx} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-end">
                  <Input
                    label={idx === 0 ? t('form.tierFrom') : ''}
                    type="number"
                    min="0"
                    value={idx === 0 ? '0' : String(tier.costMin)}
                    disabled={idx === 0}
                    onChange={e => updateTier(idx, 'costMin', Number(e.target.value))}
                    className="h-8 text-[13px]"
                  />
                  <Input
                    label={idx === 0 ? t('form.tierTo') : ''}
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
                    className="h-8 text-[13px]"
                  />
                  <Input
                    label={idx === 0 ? t('form.tierMarkup') : ''}
                    type="number"
                    min="0"
                    max="999"
                    value={String(tier.percentValue)}
                    onChange={e => updateTier(idx, 'percentValue', Number(e.target.value))}
                    className="h-8 text-[13px]"
                  />
                  <button
                    type="button"
                    onClick={() => removeTier(idx)}
                    className="text-destructive/70 hover:text-destructive p-1.5 rounded mb-0.5"
                    aria-label={t('form.removeTier')}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <Input
            label={t('form.roundTo')}
            type="number"
            min="0"
            value={form.roundTo}
            onChange={e => set({ roundTo: e.target.value })}
            hint={t('form.roundToHint')}
            placeholder={t('form.roundToPlaceholder')}
            className="h-8 text-[13px]"
          />

          <div className="border-t border-border pt-3 space-y-3">
            <p className="text-[12px] font-semibold text-muted-foreground uppercase tracking-wide">
              {t('form.scopeTitle')}
            </p>
            <p className="text-[12px] text-muted-foreground">{t('form.scopeOrder', { gt: '>' })}</p>

            <div>
              <label className="block text-[13px] font-medium text-foreground mb-1">
                {t('form.supplier')}
              </label>
              <EntityPickerField<SupplierItem>
                display={form.supplierName}
                placeholder={t('form.supplierSearchPlaceholder')}
                onPick={() => setSupplierPickerOpen(true)}
                onOpenDetail={form.supplierId ? () => void openSupplierDetail() : undefined}
                onSearch={searchSuppliers}
                onSearchSelect={item => set({ supplierId: item.id, supplierName: item.primary })}
                onClear={() => set({ supplierId: '', supplierName: '' })}
              />
              {form.supplierId && (
                <p className="text-[11px] text-primary mt-1">{t('form.supplierScopeHint')}</p>
              )}
            </div>

            <RuleGoodsField
              goods={form.goods}
              onChange={goods => set({ goods, goodsTouched: true })}
              load={goodsLoad}
              onRetry={retryGoods}
              onOverlayOpenChange={isOpen => {
                goodsOverlayRef.current = isOpen;
                syncOverlay();
              }}
            />

            {dimension === 'goods' ? (
              <p className="text-[12px] text-muted-foreground">{t('form.scopeGoodsOnly')}</p>
            ) : (
              <>
                <Select
                  label={t('form.brand')}
                  value={form.brandId}
                  onChange={e => set({ brandId: e.target.value })}
                  className="h-8 text-[13px] py-0.5 px-2 pr-7"
                >
                  <option value="">{t('form.brandAny')}</option>
                  {brands.map(b => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>

                <div className="space-y-1">
                  <Select
                    label={t('form.category')}
                    value={form.goodCategoryId}
                    onChange={e => {
                      const id = e.target.value;
                      set({
                        goodCategoryId: id,
                        goodCategoryName: categoryOptions.find(c => c.id === id)?.name ?? '',
                        categoryTouched: true,
                      });
                    }}
                    disabled={categoryOverridden}
                    hint={categoryOverridden ? t('form.overriddenByBrand') : t('form.categoryHint')}
                    className="h-8 text-[13px] py-0.5 px-2 pr-7"
                  >
                    <option value="">{t('form.categoryAny')}</option>
                    {categoryMissing && (
                      <option value={form.goodCategoryId}>
                        {form.goodCategoryName || form.goodCategoryId}
                      </option>
                    )}
                    {categoryOptions.map(c => (
                      <option key={c.id} value={c.id}>
                        {NBSP.repeat(c.depth * 2) + c.name}
                      </option>
                    ))}
                  </Select>
                  {form.legacyGoodCategory && !form.categoryTouched && (
                    <p className="text-[12px] text-muted-foreground">
                      {t('form.categoryLegacy', { name: form.legacyGoodCategory })}
                    </p>
                  )}
                  {categoriesLoading && categoryTree.length === 0 && (
                    <p role="status" className="text-[12px] text-muted-foreground">
                      {t('form.categoriesLoading')}
                    </p>
                  )}
                  {categoriesError && (
                    <p role="alert" className="text-[12px] text-destructive-text">
                      {t('form.categoriesError')}{' '}
                      <button
                        type="button"
                        className="underline hover:no-underline"
                        onClick={() => setCategoriesAttempt(n => n + 1)}
                      >
                        {t('form.retry')}
                      </button>
                    </p>
                  )}
                </div>

                <Select
                  label={t('form.goodType')}
                  value={form.goodType}
                  onChange={e => set({ goodType: e.target.value })}
                  disabled={typeOverridden}
                  hint={
                    dimension === 'brand'
                      ? t('form.overriddenByBrand')
                      : dimension === 'category'
                        ? t('form.overriddenByCategory')
                        : undefined
                  }
                  className="h-8 text-[13px] py-0.5 px-2 pr-7"
                >
                  {GOOD_TYPE_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>
                      {t(o.labelKey)}
                    </option>
                  ))}
                </Select>
              </>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Input
              label={t('form.priority')}
              type="number"
              min="0"
              value={form.priority}
              onChange={e => set({ priority: e.target.value })}
              hint={t('form.priorityHint')}
              className="h-8 text-[13px]"
            />
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={e => set({ isActive: e.target.checked })}
              className="h-4 w-4 rounded border-border text-primary"
            />
            <span className="text-[13px] text-foreground">{t('form.isActive')}</span>
          </label>
        </div>
      </Modal>

      <SearchPickerModal<SupplierItem>
        open={supplierPickerOpen}
        onClose={() => setSupplierPickerOpen(false)}
        title={t('supplierPicker.title')}
        selectedId={form.supplierId}
        fetchItems={searchSuppliers}
        searchPlaceholder={t('supplierPicker.searchPlaceholder')}
        emptyText={t('supplierPicker.empty')}
        onSelect={item => {
          set({ supplierId: item.id, supplierName: item.primary });
          setSupplierPickerOpen(false);
        }}
      />
      <CounterpartyEditModal
        open={supplierDetailOpen}
        counterparty={supplierDetailData}
        onClose={() => setSupplierDetailOpen(false)}
        onSaved={updated => {
          setSupplierDetailData(updated);
          set({
            supplierName:
              [updated.lastName, updated.firstName].filter(Boolean).join(' ') ||
              updated.companyName ||
              form.supplierName,
          });
        }}
      />
    </>
  );
}
