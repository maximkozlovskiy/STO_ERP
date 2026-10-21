import type { ReactNode } from 'react';
import { Plus, Trash2, Pencil, Check, X, Package } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import {
  DocumentSection,
  DocumentSectionEmpty,
  SectionActionButton,
} from '@/components/ui/document-section';
import { type GoodPickerItem } from '@/components/ui/GoodPickerModal';
import { calcVatOnBase, lineAmount } from '@/lib/utils';
import { fmtQty } from '@/lib/format';
import type { LocalPart, Warehouse, Unit } from './types';
import type { WarehouseFree } from '@/lib/part-warehouse';
import { ProcurementBadge } from '@/components/ui/purchase-list/ProcurementBadge';
import type { WorkOrderProcurementState } from '@/components/ui/purchase-list/WorkOrderProcurement';

/** Рядок, у якому обирають товар і склад: рядок введення або незбережений рядок у правці. */
export type PartRow = 'new' | 'edit';

export interface PartsTableProps {
  // Parts state
  parts: LocalPart[];
  setParts: React.Dispatch<React.SetStateAction<LocalPart[]>>;
  newPart: Omit<LocalPart, '_key'>;
  setNewPart: React.Dispatch<React.SetStateAction<Omit<LocalPart, '_key'>>>;
  showPartInput: boolean;
  setShowPartInput: (v: boolean) => void;
  editingPartKey: string | null;
  setEditingPartKey: (k: string | null) => void;
  editingPart: Omit<LocalPart, '_key'>;
  setEditingPart: React.Dispatch<React.SetStateAction<Omit<LocalPart, '_key'>>>;
  deletedPartIds: React.MutableRefObject<string[]>;
  addPart: () => void;
  // Ref-data
  warehouses: Warehouse[];
  warehousesById: Map<string, Warehouse>;
  units: Unit[];
  unitsById: Map<string, Unit>;
  // Stock
  stockTotalsMap: Map<string, number>;
  stockWarehouseMap: Map<string, number>;
  /** Вільна кількість по складах для обраних товарів (BR-WO-029); запису немає — ще не отримано. */
  stockFreeByGood: Map<string, WarehouseFree[]>;
  /** Товар обрано пошуком у рядку — картка ставить поля товару й підбирає склад (BR-WO-029). */
  onGoodPicked: (row: PartRow, good: GoodPickerItem) => void;
  /** Склад обрано вручну — автовибір його вже не перезапише, доки не змінено товар. */
  onWarehousePicked: (row: PartRow, warehouseId: string) => void;
  // VAT / totals
  vatMode: 'NONE' | 'EXCLUSIVE' | 'INCLUSIVE';
  vatRate: number;
  partsTotals: { total: number; vat: number };
  // Gating / helpers
  canEdit: boolean;
  saving: boolean;
  EMPTY_PART: Omit<LocalPart, '_key'>;
  toNumberOrUndefined: (raw: string) => number | undefined;
  fetchGoods: (q: string) => Promise<GoodPickerItem[]>;
  // Pickers
  setGoodPickerOpen: (v: boolean) => void;
  setEditGoodPickerOpen: (v: boolean) => void;
  /** Стан закупівлі збережених рядків (списки купівлі, замовлення, нестача) — бейдж біля залишку. */
  procurement?: WorkOrderProcurementState;
  /** Дія поруч із «Додати» — «До списку купівлі». */
  headerAction?: ReactNode;
}

/** Заголовок колонки: звичайний регістр на сірій смузі (варіант A, рішення власника 2026-10-22). */
const TH = 'px-2 py-2 text-left text-xs font-semibold text-foreground/80 whitespace-nowrap';
const TH_FIRST =
  'pl-5 pr-3 py-2 text-left text-xs font-semibold text-foreground/80 whitespace-nowrap';

export function PartsTable(props: PartsTableProps) {
  const { t } = useTranslation('workOrders');
  const {
    parts,
    setParts,
    newPart,
    setNewPart,
    showPartInput,
    setShowPartInput,
    editingPartKey,
    setEditingPartKey,
    editingPart,
    setEditingPart,
    deletedPartIds,
    addPart,
    warehouses,
    warehousesById,
    units,
    unitsById,
    stockTotalsMap,
    stockWarehouseMap,
    stockFreeByGood,
    onGoodPicked,
    onWarehousePicked,
    vatMode,
    vatRate,
    partsTotals,
    canEdit,
    saving,
    EMPTY_PART,
    toNumberOrUndefined,
    fetchGoods,
    setGoodPickerOpen,
    setEditGoodPickerOpen,
    procurement,
    headerAction,
  } = props;

  // Залишок — сума Float по рухах: без округлення в комірці стояло «294.96500000000003» і число
  // заходило на сусідні колонки (Bug #841). fmtQty округлює до 3 знаків, як у вікні вибору товару.
  const warehouseStock = (goodId: string, warehouseId: string): string =>
    fmtQty(stockWarehouseMap.get(`${goodId}:${warehouseId}`) ?? 0);
  const totalStock = (goodId: string): string => fmtQty(stockTotalsMap.get(goodId) ?? 0);

  // BR-WO-029: коли товар обрано і його залишки отримано — біля складу вільна кількість товару.
  const warehouseLabel = (w: Warehouse, goodId: string): string => {
    const free = goodId ? stockFreeByGood.get(goodId) : undefined;
    if (!free) return w.name;
    return `${w.name} — ${fmtQty(free.find(f => f.warehouseId === w.id)?.available ?? 0)}`;
  };

  const actions = (
    <>
      {headerAction}
      {canEdit && !showPartInput && (
        <SectionActionButton
          variant="accent"
          onClick={() => {
            setNewPart(EMPTY_PART);
            setShowPartInput(true);
          }}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Додати
        </SectionActionButton>
      )}
    </>
  );

  return (
    <DocumentSection
      icon={Package}
      title={t('card.parts')}
      count={parts.length}
      actions={headerAction || (canEdit && !showPartInput) ? actions : undefined}
      flush
      data-testid="wo-parts-section"
    >
      {parts.length === 0 && !showPartInput ? (
        <DocumentSectionEmpty>Натисніть «Додати» щоб додати товар</DocumentSectionEmpty>
      ) : (
        <div className="overflow-visible pb-2">
          <table className="w-full table-fixed text-[13px]">
            <colgroup>
              <col />
              {/* Склад — «Назва — N» (BR-WO-029): частка ширини, а не 11rem, щоб підпис не обрізався */}
              <col className="w-[20%]" />
              <col className="w-20" />
              <col className="w-20" />
              <col className="w-20" />
              <col className="w-24" />
              <col className="w-24" />
              {vatMode !== 'NONE' && <col className="w-20" />}
              <col className="w-24" />
              <col className="w-16" />
            </colgroup>
            <thead>
              <tr className="border-y border-border bg-secondary">
                <th className={TH_FIRST}>Назва товару</th>
                <th className={TH}>Склад</th>
                <th className={TH}>На складі</th>
                <th className={TH}>К-сть</th>
                <th className={TH}>ОВ</th>
                <th className={TH}>Собів., ₴</th>
                <th className={TH}>Ціна, ₴</th>
                {vatMode !== 'NONE' && <th className={TH}>ПДВ, ₴</th>}
                <th className={TH}>Сума, ₴</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {parts.map(part => {
                const wh = warehousesById.get(part.warehouseId);
                const qty = toNumberOrUndefined(part.quantity);
                const p = toNumberOrUndefined(part.price);
                const sum = qty != null && p != null ? lineAmount(qty, p) : null;
                return (
                  <tr
                    key={part._key}
                    className={
                      editingPartKey === part._key
                        ? 'bg-primary/5'
                        : 'bg-surface hover:bg-secondary/30 transition-colors'
                    }
                  >
                    {editingPartKey === part._key ? (
                      <>
                        {/* Збережений рядок: товар і склад лише для читання — сервер їх не змінює
                          (PATCH рядка міняє кількість, ціну й одиницю), а резерв і позиції списків
                          купівлі прив'язані до цього рядка (BR-WO-021). */}
                        {part.id ? (
                          <td className="pl-5 pr-3 py-1.5 text-foreground">
                            <div className="truncate" data-testid="part-good-readonly">
                              {editingPart.goodName}
                            </div>
                          </td>
                        ) : (
                          <td className="pl-4 pr-2 py-1.5">
                            <EntityPickerField<GoodPickerItem>
                              display={editingPart.goodName}
                              placeholder="Пошук товару..."
                              ariaLabel="Товар"
                              onPick={() => setEditGoodPickerOpen(true)}
                              onSearch={fetchGoods}
                              onSearchSelect={g => onGoodPicked('edit', g)}
                              onClear={() =>
                                setEditingPart(p => ({
                                  ...p,
                                  goodId: '',
                                  goodName: '',
                                  goodInternalCode: null,
                                  goodSku: null,
                                  goodBrandName: null,
                                  unitOfMeasureId: '',
                                  unitShortName: '',
                                }))
                              }
                            />
                          </td>
                        )}
                        {part.id ? (
                          <td
                            className="px-2 py-1.5 text-muted-foreground truncate"
                            data-testid="part-warehouse-readonly"
                          >
                            {warehousesById.get(editingPart.warehouseId)?.name ?? '—'}
                          </td>
                        ) : (
                          <td className="px-2 py-1.5">
                            <Select
                              aria-label="Склад"
                              value={editingPart.warehouseId}
                              onChange={e => onWarehousePicked('edit', e.target.value)}
                            >
                              <option value="">Склад</option>
                              {warehouses.map(w => (
                                <option key={w.id} value={w.id}>
                                  {warehouseLabel(w, editingPart.goodId)}
                                </option>
                              ))}
                            </Select>
                          </td>
                        )}
                        <td className="px-2 py-1.5 text-left tabular-nums text-[12px] text-muted-foreground">
                          {editingPart.goodId ? (
                            <>
                              <span>
                                {editingPart.warehouseId
                                  ? warehouseStock(editingPart.goodId, editingPart.warehouseId)
                                  : '—'}
                              </span>
                              <span className="opacity-40">/</span>
                              <span className="opacity-60">{totalStock(editingPart.goodId)}</span>
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="px-2 py-1.5">
                          <Input
                            placeholder="0"
                            type="number"
                            value={editingPart.quantity}
                            onChange={e =>
                              setEditingPart(p => ({ ...p, quantity: e.target.value }))
                            }
                            min="0.001"
                            step="any"
                          />
                        </td>
                        <td className="px-1 py-1.5">
                          <Select
                            value={editingPart.unitOfMeasureId}
                            onChange={e => {
                              const u = unitsById.get(e.target.value);
                              setEditingPart(p => ({
                                ...p,
                                unitOfMeasureId: e.target.value,
                                unitShortName: u?.shortName ?? '',
                              }));
                            }}
                          >
                            <option value="">шт</option>
                            {units.map(u => (
                              <option key={u.id} value={u.id}>
                                {u.shortName}
                              </option>
                            ))}
                          </Select>
                        </td>
                        {/* Собівартість — read-only у edit mode (фіксується при надходженні) */}
                        <td className="px-2 py-1.5 text-left tabular-nums text-muted-foreground text-[12px]">
                          —
                        </td>
                        <td className="px-2 py-1.5">
                          <Input
                            placeholder="0"
                            type="number"
                            value={editingPart.price}
                            onChange={e => setEditingPart(p => ({ ...p, price: e.target.value }))}
                            min="0"
                          />
                        </td>
                        {vatMode !== 'NONE' && (
                          <td className="px-2 py-1.5 text-left tabular-nums text-[12px] text-muted-foreground">
                            {(() => {
                              const q = toNumberOrUndefined(editingPart.quantity);
                              const pr = toNumberOrUndefined(editingPart.price);
                              return q != null && pr != null && vatRate > 0
                                ? calcVatOnBase(q * pr, vatRate, vatMode).toFixed(2)
                                : '—';
                            })()}
                          </td>
                        )}
                        <td className="px-2 py-1.5 text-left tabular-nums text-[12px] text-muted-foreground">
                          {(() => {
                            const q = toNumberOrUndefined(editingPart.quantity);
                            const pr = toNumberOrUndefined(editingPart.price);
                            return q != null && pr != null ? (q * pr).toFixed(2) : '—';
                          })()}
                        </td>
                        <td className="px-1.5 py-1.5">
                          <div className="flex flex-row gap-2 items-center">
                            <button
                              type="button"
                              onClick={() => {
                                if (!editingPart.goodId || !editingPart.warehouseId) return;
                                // (parallel fix): spread `pt` first to preserve `id`.
                                // Same merge bug as for lines — editingPart never carries `id`,
                                // тому без `...pt` save() filter не побачив би existing part
                                // → POST дублікат + duplicate-key fail.
                                // Bug #837: збережений рядок (є `id`) після правки треба донести
                                // до сервера — save() шле POST лише рядкам без `id`: змінені
                                // кількість / ціна / одиниця → `_dirty`, save() надішле PATCH.
                                // Товар і склад збереженого рядка не змінюються (лише для читання).
                                setParts(prev =>
                                  prev.map(pt => {
                                    if (pt._key !== part._key) return pt;
                                    return {
                                      ...pt,
                                      ...editingPart,
                                      _key: pt._key,
                                      _dirty: pt.id ? true : undefined,
                                    };
                                  }),
                                );
                                setEditingPartKey(null);
                              }}
                              disabled={!editingPart.goodId || !editingPart.warehouseId}
                              title="Зберегти"
                              className="p-1 rounded text-primary hover:bg-primary/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                            >
                              <Check className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingPartKey(null)}
                              title="Скасувати"
                              className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="pl-5 pr-3 py-2 text-foreground">
                          <div className="truncate">{part.goodName}</div>
                          {(part.goodInternalCode || part.goodSku || part.goodBrandName) && (
                            <div className="text-[11px] text-muted-foreground truncate">
                              {[part.goodInternalCode, part.goodSku, part.goodBrandName]
                                .filter(Boolean)
                                .join(' · ')}
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-1.5 text-muted-foreground truncate">
                          {wh?.name ?? '—'}
                        </td>
                        <td className="px-2 py-1.5 text-left tabular-nums text-muted-foreground">
                          {part.goodId ? (
                            <>
                              <span>{warehouseStock(part.goodId, part.warehouseId)}</span>
                              <span className="opacity-40">/</span>
                              <span className="opacity-60">{totalStock(part.goodId)}</span>
                            </>
                          ) : (
                            '—'
                          )}
                          {part.id && procurement && (
                            <ProcurementBadge
                              items={procurement.itemsByPart.get(part.id) ?? []}
                              shortage={procurement.shortageByPart.get(part.id) ?? 0}
                              unit={procurement.unitByPart.get(part.id)}
                            />
                          )}
                        </td>
                        <td className="px-2 py-1.5 text-left tabular-nums text-muted-foreground">
                          {part.quantity}
                        </td>
                        <td className="px-2 py-1.5 text-left text-muted-foreground text-[12px]">
                          {part.unitShortName || 'шт'}
                        </td>
                        <td className="px-2 py-1.5 text-left tabular-nums text-muted-foreground">
                          {part.costPrice != null ? part.costPrice.toFixed(2) : '—'}
                        </td>
                        <td className="px-2 py-1.5 text-left tabular-nums text-muted-foreground">
                          {part.price || '—'}
                        </td>
                        {vatMode !== 'NONE' && (
                          <td className="px-2 py-1.5 text-left tabular-nums text-muted-foreground">
                            {qty != null && p != null && vatRate > 0
                              ? calcVatOnBase(lineAmount(qty, p), vatRate, vatMode).toFixed(2)
                              : '—'}
                          </td>
                        )}
                        <td className="px-2 py-1.5 text-left tabular-nums font-medium text-foreground">
                          {sum != null ? sum.toFixed(2) : '—'}
                        </td>
                        <td className="px-1.5 py-1.5 text-left">
                          <div className="flex flex-row gap-2 items-center">
                            <button
                              type="button"
                              onClick={() => {
                                setEditingPartKey(part._key);
                                setEditingPart({
                                  goodId: part.goodId,
                                  goodName: part.goodName,
                                  warehouseId: part.warehouseId,
                                  quantity: part.quantity,
                                  price: part.price,
                                  unitOfMeasureId: part.unitOfMeasureId,
                                  unitShortName: part.unitShortName,
                                });
                              }}
                              disabled={saving || !canEdit}
                              aria-label="Редагувати товар"
                              title="Редагувати"
                              className="p-1 rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors disabled:opacity-50"
                            >
                              <Pencil className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                if (part.id) deletedPartIds.current.push(part.id);
                                setParts(prev => prev.filter(pt => pt._key !== part._key));
                              }}
                              disabled={saving || !canEdit}
                              aria-label="Видалити товар"
                              title="Видалити"
                              className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </div>
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}

              {/* Рядок вводу */}
              {showPartInput && (
                <tr className="bg-primary/5 border-t-2 border-primary/20">
                  <td className="pl-4 pr-2 py-1.5">
                    <EntityPickerField<GoodPickerItem>
                      display={newPart.goodName}
                      placeholder="Пошук товару..."
                      ariaLabel="Товар"
                      onPick={() => setGoodPickerOpen(true)}
                      onSearch={fetchGoods}
                      onSearchSelect={g => onGoodPicked('new', g)}
                      onClear={() =>
                        setNewPart(p => ({ ...EMPTY_PART, warehouseId: p.warehouseId }))
                      }
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <Select
                      aria-label="Склад"
                      value={newPart.warehouseId}
                      onChange={e => onWarehousePicked('new', e.target.value)}
                    >
                      <option value="">Склад</option>
                      {warehouses.map(w => (
                        <option key={w.id} value={w.id}>
                          {warehouseLabel(w, newPart.goodId)}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="px-2 py-1.5 text-left tabular-nums text-[12px] text-muted-foreground">
                    {newPart.goodId ? (
                      <>
                        <span>
                          {newPart.warehouseId
                            ? warehouseStock(newPart.goodId, newPart.warehouseId)
                            : '—'}
                        </span>
                        <span className="opacity-40">/</span>
                        <span className="opacity-60">{totalStock(newPart.goodId)}</span>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    <Input
                      placeholder="0"
                      type="number"
                      value={newPart.quantity}
                      onChange={e => setNewPart(p => ({ ...p, quantity: e.target.value }))}
                      min="0.001"
                      step="any"
                    />
                  </td>
                  <td className="px-1 py-1.5">
                    <Select
                      value={newPart.unitOfMeasureId}
                      onChange={e => {
                        const u = unitsById.get(e.target.value);
                        setNewPart(p => ({
                          ...p,
                          unitOfMeasureId: e.target.value,
                          unitShortName: u?.shortName ?? '',
                        }));
                      }}
                    >
                      <option value="">шт</option>
                      {units.map(u => (
                        <option key={u.id} value={u.id}>
                          {u.shortName}
                        </option>
                      ))}
                    </Select>
                  </td>
                  {/* Собівартість нового товару невідома до надходження — read-only */}
                  <td className="px-2 py-1.5 text-left tabular-nums text-muted-foreground text-[12px]">
                    —
                  </td>
                  <td className="px-2 py-1.5">
                    <Input
                      placeholder="0"
                      type="number"
                      value={newPart.price}
                      onChange={e => setNewPart(p => ({ ...p, price: e.target.value }))}
                      min="0"
                    />
                  </td>
                  {vatMode !== 'NONE' && (
                    <td className="px-2 py-1.5 text-left tabular-nums text-[12px] text-muted-foreground">
                      {(() => {
                        const qty = toNumberOrUndefined(newPart.quantity);
                        const p = toNumberOrUndefined(newPart.price);
                        return qty != null && p != null && vatRate > 0
                          ? calcVatOnBase(lineAmount(qty, p), vatRate, vatMode).toFixed(2)
                          : '—';
                      })()}
                    </td>
                  )}
                  <td className="px-2 py-1.5 text-left tabular-nums text-[12px] text-muted-foreground">
                    {(() => {
                      const qty = toNumberOrUndefined(newPart.quantity);
                      const p = toNumberOrUndefined(newPart.price);
                      return qty != null && p != null ? lineAmount(qty, p).toFixed(2) : '—';
                    })()}
                  </td>
                  <td className="px-1.5 py-1.5">
                    <div className="flex flex-row gap-2 items-center">
                      <button
                        type="button"
                        onClick={addPart}
                        disabled={!newPart.goodId || !newPart.warehouseId || saving}
                        title="Зберегти рядок"
                        className="p-1 rounded text-primary hover:bg-primary/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setNewPart(EMPTY_PART);
                          setShowPartInput(false);
                        }}
                        title="Скасувати"
                        className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
            {parts.length > 0 && (
              <tfoot>
                <tr className="bg-secondary/50 border-t border-border">
                  <td
                    colSpan={vatMode !== 'NONE' ? 6 : 7}
                    className="pl-5 pr-3 py-2 text-left text-xs font-medium text-muted-foreground"
                  >
                    Разом товарів:
                  </td>
                  {vatMode !== 'NONE' && (
                    <td className="px-2 py-1.5 text-left tabular-nums text-xs font-semibold text-foreground" />
                  )}
                  {vatMode !== 'NONE' && (
                    <td className="px-2 py-1.5 text-left tabular-nums text-xs font-semibold text-foreground">
                      {partsTotals.vat.toFixed(2)}
                    </td>
                  )}
                  <td className="px-2 py-1.5 text-left tabular-nums text-xs font-semibold text-foreground">
                    {partsTotals.total.toFixed(2)}
                  </td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </DocumentSection>
  );
}
