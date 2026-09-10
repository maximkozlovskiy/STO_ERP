import { Plus, Trash2, Pencil, Check, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import { type GoodPickerItem } from '@/components/ui/GoodPickerModal';
import type { LocalPart, Warehouse, Unit } from './types';

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
}

export function PartsTable(props: PartsTableProps) {
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
  } = props;

  return (
    <div className="pt-4 pb-2">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-medium text-muted-foreground">Товари / Запчастини</p>
        {canEdit && !showPartInput && (
          <button
            type="button"
            onClick={() => {
              setNewPart(EMPTY_PART);
              setShowPartInput(true);
            }}
            className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 font-medium transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            Додати
          </button>
        )}
      </div>

      <div className="rounded-lg border border-border overflow-visible">
        <table className="w-full table-fixed text-[12px]">
          <colgroup>
            <col />
            <col className="w-44" />
            <col className="w-20" />
            <col className="w-20" />
            <col className="w-28" />
            <col className="w-24" />
            <col className="w-24" />
            {vatMode !== 'NONE' && <col className="w-20" />}
            <col className="w-24" />
            <col className="w-16" />
          </colgroup>
          <thead>
            <tr className="border-b border-border bg-secondary/40">
              <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                Назва товару
              </th>
              <th className="px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                Склад
              </th>
              <th className="px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                На складі
              </th>
              <th className="px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                К-сть
              </th>
              <th className="px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                ОВ
              </th>
              <th className="px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                Собів., ₴
              </th>
              <th className="px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                Ціна, ₴
              </th>
              {vatMode !== 'NONE' && (
                <th className="px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                  ПДВ, ₴
                </th>
              )}
              <th className="px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                Сума, ₴
              </th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {parts.length === 0 && !showPartInput && (
              <tr>
                <td
                  colSpan={vatMode !== 'NONE' ? 10 : 9}
                  className="px-3 py-4 text-center text-[12px] text-muted-foreground"
                >
                  Натисніть «Додати» щоб додати товар
                </td>
              </tr>
            )}
            {parts.map(part => {
              const wh = warehousesById.get(part.warehouseId);
              const qty = toNumberOrUndefined(part.quantity);
              const p = toNumberOrUndefined(part.price);
              const sum = qty != null && p != null ? qty * p : null;
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
                      <td className="px-2 py-1.5">
                        <EntityPickerField<GoodPickerItem>
                          display={editingPart.goodName}
                          placeholder="Пошук товару..."
                          ariaLabel="Товар"
                          onPick={() => setEditGoodPickerOpen(true)}
                          onSearch={fetchGoods}
                          onSearchSelect={g =>
                            setEditingPart(p => ({
                              ...p,
                              goodId: g.id,
                              goodName: g.name,
                              goodInternalCode: g.internalCode ?? null,
                              goodSku: g.sku ?? null,
                              goodBrandName: g.brandName ?? null,
                              price: String(g.salePrice),
                              unitOfMeasureId: g.unitId ?? '',
                              unitShortName: g.unitShortName ?? '',
                            }))
                          }
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
                      <td className="px-2 py-1.5">
                        <Select
                          value={editingPart.warehouseId}
                          onChange={e =>
                            setEditingPart(p => ({ ...p, warehouseId: e.target.value }))
                          }
                        >
                          <option value="">Склад</option>
                          {warehouses.map(w => (
                            <option key={w.id} value={w.id}>
                              {w.name}
                            </option>
                          ))}
                        </Select>
                      </td>
                      <td className="px-2 py-1.5 text-left tabular-nums text-[12px] text-muted-foreground">
                        {editingPart.goodId ? (
                          <>
                            <span>
                              {editingPart.warehouseId
                                ? (stockWarehouseMap.get(
                                    `${editingPart.goodId}:${editingPart.warehouseId}`,
                                  ) ?? 0)
                                : '—'}
                            </span>
                            <span className="opacity-40">/</span>
                            <span className="opacity-60">
                              {stockTotalsMap.get(editingPart.goodId) ?? 0}
                            </span>
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
                          onChange={e => setEditingPart(p => ({ ...p, quantity: e.target.value }))}
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
                              ? ((q * pr * vatRate) / 100).toFixed(2)
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
                              setParts(prev =>
                                prev.map(pt =>
                                  pt._key === part._key
                                    ? { ...pt, ...editingPart, _key: pt._key }
                                    : pt,
                                ),
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
                      <td className="px-3 py-1.5 text-foreground">
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
                            <span>
                              {stockWarehouseMap.get(`${part.goodId}:${part.warehouseId}`) ?? 0}
                            </span>
                            <span className="opacity-40">/</span>
                            <span className="opacity-60">
                              {stockTotalsMap.get(part.goodId) ?? 0}
                            </span>
                          </>
                        ) : (
                          '—'
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
                            ? ((qty * p * vatRate) / 100).toFixed(2)
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
                <td className="px-2 py-1.5">
                  <EntityPickerField<GoodPickerItem>
                    display={newPart.goodName}
                    placeholder="Пошук товару..."
                    ariaLabel="Товар"
                    onPick={() => setGoodPickerOpen(true)}
                    onSearch={fetchGoods}
                    onSearchSelect={g =>
                      setNewPart(p => ({
                        ...p,
                        goodId: g.id,
                        goodName: g.name,
                        price: String(g.salePrice),
                        unitOfMeasureId: g.unitId ?? '',
                        unitShortName: g.unitShortName ?? '',
                      }))
                    }
                    onClear={() => setNewPart(p => ({ ...EMPTY_PART, warehouseId: p.warehouseId }))}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <Select
                    value={newPart.warehouseId}
                    onChange={e => setNewPart(p => ({ ...p, warehouseId: e.target.value }))}
                  >
                    <option value="">Склад</option>
                    {warehouses.map(w => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </Select>
                </td>
                <td className="px-2 py-1.5 text-left tabular-nums text-[12px] text-muted-foreground">
                  {newPart.goodId ? (
                    <>
                      <span>
                        {newPart.warehouseId
                          ? (stockWarehouseMap.get(`${newPart.goodId}:${newPart.warehouseId}`) ?? 0)
                          : '—'}
                      </span>
                      <span className="opacity-40">/</span>
                      <span className="opacity-60">{stockTotalsMap.get(newPart.goodId) ?? 0}</span>
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
                        ? ((qty * p * vatRate) / 100).toFixed(2)
                        : '—';
                    })()}
                  </td>
                )}
                <td className="px-2 py-1.5 text-left tabular-nums text-[12px] text-muted-foreground">
                  {(() => {
                    const qty = toNumberOrUndefined(newPart.quantity);
                    const p = toNumberOrUndefined(newPart.price);
                    return qty != null && p != null ? (qty * p).toFixed(2) : '—';
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
                  className="px-3 py-1.5 text-left text-xs font-medium text-muted-foreground"
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
    </div>
  );
}
