'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { apiFetch } from '@/lib/api-client';
import { Modal } from './modal';
import { Button } from './button';
import { Input } from './input';
import { Spinner } from './spinner';
import { cn } from '@/lib/utils';
import { pickScannedGood } from '@/lib/barcode';
import { fmtQty } from '@/lib/format';
import { CategoryTree, collectDescendantIds } from './category-tree';
import type { CategoryNode } from './category-tree';

export interface GoodPickerItem {
  id: string;
  primary: string;
  secondary?: string;
  name: string;
  internalCode?: string | null;
  sku?: string | null;
  brandName?: string | null;
  salePrice: number;
  category?: string | null;
  unitId?: string | null;
  unitShortName?: string | null;
  barcode?: string | null;
  barcodes?: string[];
}

interface StockTotal {
  goodId: string;
  totalQuantity: number;
  byWarehouse: { warehouseId: string; quantity: number }[];
}

// sto-optimize: module-level stable refs — `new Map()` всередині `setStockMap(new Map())`
// alloc-ився на кожному close-/no-results- виклику. Тепер shared empty ref.
const EMPTY_STOCK_MAP: Map<string, number> = new Map();

interface Props {
  open: boolean;
  onClose: () => void;
  selectedId?: string | null;
  onSelect: (item: GoodPickerItem) => void;
  /**
   * Множинний вибір (список товарів правила ціноутворення): модалка НЕ закривається після
   * вибору, уже додані товари (`selectedIds`) позначені, внизу є кнопка «Готово». Повторний клік
   * по доданому товару знімає його, якщо передано `onDeselect`; без нього — нічого не робить.
   * Без пропа `multiple` поведінка модалки не змінюється.
   */
  multiple?: boolean;
  /** Лише для `multiple`: зняти позначку з уже доданого товару (клік по ньому). */
  onDeselect?: (id: string) => void;
  /** Лише для `multiple`: «Відмітити всі» — додати всі показані товари, яких ще немає у списку. */
  onSelectMany?: (items: GoodPickerItem[]) => void;
  /** Лише для `multiple`: «Зняти всі» — прибрати зі списку всі показані товари. */
  onDeselectMany?: (ids: string[]) => void;
  /** Лише для `multiple`: підписи кнопок «відмітити / зняти всі показані». */
  selectAllLabel?: string;
  deselectAllLabel?: string;
  /** Лише для `multiple`: текст лічильника для читача екрана («Додано 3 з 50 показаних»). */
  countLabel?: (added: number, shown: number) => string;
  /** Лише для `multiple`: id товарів, які вже у списку. */
  selectedIds?: readonly string[];
  /** Лише для `multiple`: підпис кнопки закриття. */
  doneLabel?: string;
  /** Лише для `multiple`: позначка вже доданого товару. */
  addedLabel?: string;
}

export function GoodPickerModal({
  open,
  onClose,
  selectedId,
  onSelect,
  multiple = false,
  selectedIds,
  doneLabel = 'Готово',
  addedLabel = 'додано',
  onDeselect,
  onSelectMany,
  onDeselectMany,
  selectAllLabel = 'Відмітити всі',
  deselectAllLabel = 'Зняти всі',
  countLabel = (added, shown) => `Додано ${added} з ${shown} показаних`,
}: Props) {
  // Множина, а не `includes` на кожен рядок і кожен рендер: у списку правила до 5000 товарів.
  const selectedSet = useMemo(() => new Set(selectedIds ?? []), [selectedIds]);
  const [query, setQuery] = useState('');
  const [selectedCatId, setSelectedCatId] = useState<string | null>(null);
  const [categories, setCategories] = useState<CategoryNode[]>([]);
  const [items, setItems] = useState<GoodPickerItem[]>([]);
  const [stockMap, setStockMap] = useState<Map<string, number>>(EMPTY_STOCK_MAP);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqRef = useRef(0);

  const categoriesLoadedRef = useRef(false);
  useEffect(() => {
    if (!open || categoriesLoadedRef.current) return;
    categoriesLoadedRef.current = true; // prevent concurrent fetches
    let cancelled = false;
    apiFetch<CategoryNode[] | { items: CategoryNode[] }>('/good-categories')
      .then(r => {
        if (cancelled) return;
        // Tolerate both array-of-categories and { items, total } envelope
        const arr = Array.isArray(r)
          ? r
          : Array.isArray((r as { items?: CategoryNode[] }).items)
            ? r.items
            : [];
        setCategories(arr);
      })
      .catch(() => {
        // allow retry on next open after failure
        if (!cancelled) categoriesLoadedRef.current = false;
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const fetchGoods = useCallback(
    (q: string, catId: string | null) => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      const reqId = ++reqRef.current;
      setLoading(true);
      setError('');
      timeoutRef.current = setTimeout(
        () => {
          timeoutRef.current = null;
          const params = new URLSearchParams({ limit: '50' });
          if (q) params.set('q', q);
          if (catId) {
            const ids = collectDescendantIds(categories, catId);
            ids.forEach(id => params.append('goodCategoryIds', id));
          }
          // /goods і /goods/stock-totals sequential — stock-totals потребує ids з
          // response /goods. sto-optimize: shared EMPTY_STOCK_MAP замість `new Map()`
          // на кожному 0-results call → стабільна reference (re-render skip downstream).
          apiFetch<{
            items: (Omit<GoodPickerItem, 'unitShortName'> & {
              unit?: string | null;
            })[];
          }>(`/goods?${params}`)
            .then(r => {
              if (reqId !== reqRef.current) return;
              // Backend (GoodResponseDto) returns `brandName` directly — spread preserves it.
              // `unitShortName` derives from `unit` (DTO has no separate short-name field).
              const goods = (Array.isArray(r.items) ? r.items : []).map(g => ({
                ...g,
                unitShortName: g.unit ?? null,
              }));
              setItems(goods);
              setLoading(false);
              // Fetch stock totals for the loaded goods batch
              if (goods.length > 0) {
                const ids = goods.map(g => g.id).join(',');
                apiFetch<StockTotal[]>(`/goods/stock-totals?ids=${ids}`)
                  .then(totals => {
                    if (reqId !== reqRef.current) return;
                    setStockMap(new Map(totals.map(t => [t.goodId, t.totalQuantity])));
                  })
                  .catch(() => {
                    /* non-critical — залишки не показуємо якщо помилка */
                  });
              } else {
                setStockMap(EMPTY_STOCK_MAP);
              }
            })
            .catch((e: unknown) => {
              if (reqId !== reqRef.current) return;
              setError(e instanceof Error ? e.message : 'Помилка завантаження');
              setLoading(false);
            });
        },
        q ? 300 : 0,
      );
    },
    [categories],
  );

  useEffect(() => {
    if (!open) {
      // Bump reqRef so any in-flight /goods response is discarded after close
      // (Modal unmounts content via useAnimatedPresence → setState would warn).
      reqRef.current++;
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      setQuery('');
      setSelectedCatId(null);
      setItems([]);
      setStockMap(EMPTY_STOCK_MAP);
      setError('');
      setLoading(false);
      return;
    }
    fetchGoods('', null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    fetchGoods(query, selectedCatId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, selectedCatId]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  // Єдина точка вибору товару — і для кліку по рядку, і для Enter зі сканера.
  // secondary дзеркалить sub-line у списку (internalCode + sku + ціна), щоб споживачі,
  // що читають лише secondary, бачили консистентну метадату.
  const toPicked = (item: GoodPickerItem): GoodPickerItem => {
    const meta = [item.internalCode, item.sku].filter(Boolean).join(' · ');
    return {
      ...item,
      primary: item.name,
      secondary: meta ? `${meta} · ${item.salePrice} ₴` : `${item.salePrice} ₴`,
    };
  };

  const selectGood = (item: GoodPickerItem) => {
    // Множинний режим: уже доданий товар удруге не віддаємо — список без дублів.
    if (multiple && selectedSet.has(item.id)) return;
    onSelect(toPicked(item));
    if (!multiple) onClose();
  };

  // Клік по рядку. У множинному режимі доданий товар знімається — але лише кліком: сканер
  // (Enter у полі пошуку) іде через selectGood і вже доданий товар не чіпає, щоб повторне
  // сканування тієї самої упаковки не прибирало її зі списку.
  const clickGood = (item: GoodPickerItem) => {
    if (multiple && selectedSet.has(item.id)) {
      onDeselect?.(item.id);
      return;
    }
    selectGood(item);
  };

  // «Усі» — це показані зараз товари (результат пошуку й категорії), а не весь каталог.
  const shownAdded = multiple ? items.filter(i => selectedSet.has(i.id)) : [];
  const shownFree = multiple ? items.filter(i => !selectedSet.has(i.id)) : [];
  const showBulk = multiple && !loading && items.length > 0 && !!(onSelectMany || onDeselectMany);
  // Кнопка, якій нема на що діяти, лишається у фокусі (`aria-disabled`, не `disabled`): після
  // «Відмітити всі» вона сама стає недіяльною, а атрибут `disabled` скинув би фокус клавіатури
  // на <body> — користувач без миші губив би місце у вікні.
  const bulkOffClass = 'aria-disabled:opacity-50 aria-disabled:cursor-not-allowed';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Оберіть товар"
      size="lg"
      footer={multiple ? <Button onClick={onClose}>{doneLabel}</Button> : undefined}
    >
      <div className="flex flex-col gap-3">
        <Input
          placeholder="Пошук товару / штрих-код..."
          value={query}
          autoFocus
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => {
            // Сканер ШК: Enter → авто-вибір за точним ШК або єдиним результатом.
            if (e.key !== 'Enter') return;
            e.preventDefault();
            // Сканер друкує ШК + Enter швидше за debounce (300ms), тож на момент Enter
            // `items` ще відображає ДО-скан-результати. Флашимо відкладений fetch і
            // підбираємо товар за свіжими результатами; якщо debounce вже відпрацював —
            // підбираємо одразу за поточними items.
            const pending = timeoutRef.current !== null;
            if (pending && query) {
              clearTimeout(timeoutRef.current!);
              timeoutRef.current = null;
              const reqId = ++reqRef.current;
              setLoading(true);
              setError('');
              const params = new URLSearchParams({ limit: '50' });
              params.set('q', query);
              if (selectedCatId) {
                collectDescendantIds(categories, selectedCatId).forEach(id =>
                  params.append('goodCategoryIds', id),
                );
              }
              apiFetch<{
                items: (Omit<GoodPickerItem, 'unitShortName'> & { unit?: string | null })[];
              }>(`/goods?${params}`)
                .then(r => {
                  if (reqId !== reqRef.current) return;
                  const goods = (Array.isArray(r.items) ? r.items : []).map(g => ({
                    ...g,
                    unitShortName: g.unit ?? null,
                  }));
                  setItems(goods);
                  setLoading(false);
                  const picked = pickScannedGood(goods, query);
                  if (picked) selectGood(picked);
                })
                .catch((err: unknown) => {
                  if (reqId !== reqRef.current) return;
                  setError(err instanceof Error ? err.message : 'Помилка завантаження');
                  setLoading(false);
                });
              return;
            }
            const picked = pickScannedGood(items, query);
            if (picked) selectGood(picked);
          }}
        />

        {showBulk && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {onSelectMany && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-disabled={shownFree.length === 0}
                className={bulkOffClass}
                onClick={() => {
                  if (shownFree.length > 0) onSelectMany(shownFree.map(toPicked));
                }}
              >
                {selectAllLabel}
              </Button>
            )}
            {onDeselectMany && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-disabled={shownAdded.length === 0}
                className={bulkOffClass}
                onClick={() => {
                  if (shownAdded.length > 0) onDeselectMany(shownAdded.map(i => i.id));
                }}
              >
                {deselectAllLabel}
              </Button>
            )}
            {/* Видимі цифри «3 / 50» читач екрана озвучив би як «три скісна п'ятдесят» — для нього
                окремий зрозумілий рядок; ввічливий (polite), щоб не перебивати назву рядка. */}
            <span className="tabular-nums" aria-hidden="true">
              {shownAdded.length} / {items.length}
            </span>
            <span className="sr-only" role="status">
              {countLabel(shownAdded.length, items.length)}
            </span>
          </div>
        )}

        <div className="flex gap-0 min-h-0" style={{ height: '420px' }}>
          {/* Results */}
          <div className="flex-1 overflow-y-auto pr-3">
            {error && (
              <p className="text-sm text-destructive-text bg-destructive-subtle border border-destructive/20 rounded-lg px-3 py-2 mb-2">
                {error}
              </p>
            )}
            {loading ? (
              <div className="flex justify-center py-10">
                <Spinner size="sm" />
              </div>
            ) : items.length === 0 ? (
              <p className="text-sm text-muted-foreground py-10 text-center">Нічого не знайдено</p>
            ) : (
              <div className="space-y-1">
                {items.map(item => {
                  const added = multiple && selectedSet.has(item.id);
                  const selected = multiple ? added : item.id === selectedId;
                  // sto-optimize: підняти qty lookup з IIFE у тілі JSX — раніше
                  // `(() => { const qty = stockMap.get(item.id) ?? 0; return <span>... })()`
                  // створював нову arrow на кожен render для КОЖНОГО row.
                  // fmtQty округлює до 3 знаків (хвости float-суми по складах) і форматує за
                  // локаллю; «0» після округлення — це «немає», як і раніше.
                  const qtyLabel = fmtQty(stockMap.get(item.id) ?? 0);
                  const qty = qtyLabel === '0' ? 0 : (stockMap.get(item.id) ?? 0);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => clickGood(item)}
                      aria-pressed={multiple ? added : undefined}
                      className={cn(
                        'w-full text-left px-3 py-2 rounded-lg border transition-colors',
                        selected
                          ? 'border-primary bg-primary/5'
                          : 'border-border bg-surface hover:border-primary hover:bg-primary/5',
                      )}
                    >
                      <div className="text-sm font-medium text-foreground">
                        {item.name}
                        {added && (
                          <span className="ml-2 text-[11px] font-normal text-success">
                            ✓ {addedLabel}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5 flex gap-3">
                        {(item.internalCode || item.sku || item.brandName) && (
                          <span className="text-[11px] text-muted-foreground/80">
                            {[item.internalCode, item.sku, item.brandName]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        )}
                        <span>{item.salePrice} ₴</span>
                        <span className={qty > 0 ? 'text-success' : 'text-destructive-text'}>
                          {qty > 0 ? `${qtyLabel} на складі` : 'немає на складі'}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Category tree sidebar */}
          <CategoryTree
            tree={categories}
            selectedId={selectedCatId}
            onSelect={setSelectedCatId}
            label="Категорії товарів"
            storageKey="sto:cat-tree:good-picker"
            hideInactive
            className="ml-0 border-l rounded-none rounded-r-xl"
          />
        </div>
      </div>
    </Modal>
  );
}
