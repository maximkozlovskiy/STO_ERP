import { Plus, Trash2, Pencil, Check, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { EntityPickerField } from '@/components/ui/entity-picker-field';
import { type WorkPickerItem } from '@/components/ui/WorkPickerModal';
import type { LocalLine, Employee, WorkOrderFormState } from './types';

export interface WorksTableProps {
  // Lines state
  lines: LocalLine[];
  setLines: React.Dispatch<React.SetStateAction<LocalLine[]>>;
  newLine: Omit<LocalLine, '_key'>;
  setNewLine: React.Dispatch<React.SetStateAction<Omit<LocalLine, '_key'>>>;
  showLineInput: boolean;
  setShowLineInput: (v: boolean) => void;
  editingLineKey: string | null;
  setEditingLineKey: (k: string | null) => void;
  editingLine: Omit<LocalLine, '_key'>;
  setEditingLine: React.Dispatch<React.SetStateAction<Omit<LocalLine, '_key'>>>;
  deletedLineIds: React.MutableRefObject<string[]>;
  addLine: () => void;
  // Ref-data
  employees: Employee[];
  employeesById: Map<string, Employee>;
  // VAT / totals
  vatMode: 'NONE' | 'EXCLUSIVE' | 'INCLUSIVE';
  vatRate: number;
  linesTotals: { total: number; vat: number };
  actualTotals: { total: number; hasAny: boolean };
  // Gating / helpers
  canEdit: boolean;
  canEditActual: boolean;
  EMPTY_LINE: Omit<LocalLine, '_key'>;
  toNumberOrUndefined: (raw: string) => number | undefined;
  saving: boolean;
  fetchWorks: (q: string) => Promise<(WorkPickerItem & { primary: string; secondary: string })[]>;
  // Recalc planned-hours side-effect (delete handler)
  recalcPlannedHoursEnabled: boolean;
  setForm: React.Dispatch<React.SetStateAction<WorkOrderFormState>>;
  calcPlannedHoursFromLines: (currentVal: string, linesArr: { normoHours: string }[]) => string;
  calcEndFromHours: (start: string, hours: number) => string;
  // Pickers-trigger
  setWorkPickerOpen: (v: boolean) => void;
  setEditWorkPickerOpen: (v: boolean) => void;
  setServicePickerOpen: (v: boolean) => void;
}

export function WorksTable(props: WorksTableProps) {
  const {
    lines,
    setLines,
    newLine,
    setNewLine,
    showLineInput,
    setShowLineInput,
    editingLineKey,
    setEditingLineKey,
    editingLine,
    setEditingLine,
    deletedLineIds,
    addLine,
    employees,
    employeesById,
    vatMode,
    vatRate,
    linesTotals,
    actualTotals,
    canEdit,
    canEditActual,
    EMPTY_LINE,
    toNumberOrUndefined,
    saving,
    fetchWorks,
    recalcPlannedHoursEnabled,
    setForm,
    calcPlannedHoursFromLines,
    calcEndFromHours,
    setWorkPickerOpen,
    setEditWorkPickerOpen,
    setServicePickerOpen,
  } = props;

  return (
    <div className="pt-4 pb-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-medium text-muted-foreground">Роботи</p>
        {canEdit && !showLineInput && (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setServicePickerOpen(true)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground font-medium transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              Послуга
            </button>
            <button
              type="button"
              onClick={() => {
                setNewLine(EMPTY_LINE);
                setShowLineInput(true);
              }}
              className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 font-medium transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              Додати
            </button>
          </div>
        )}
      </div>

      <div className="rounded-lg border border-border overflow-visible">
        <table className="w-full table-fixed text-[12px]">
          <colgroup>
            <col />
            <col className="w-44" />
            <col className="w-20" />
            <col className="w-20" />
            <col className="w-24" />
            {vatMode !== 'NONE' && <col className="w-20" />}
            <col className="w-24" />
            <col className="w-24" />
            <col className="w-16" />
          </colgroup>
          <thead>
            <tr className="border-b border-border bg-secondary/40">
              <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                Назва роботи
              </th>
              <th className="px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                Виконавець
              </th>
              <th className="px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                Год (план)
              </th>
              <th className="px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                Год (факт.)
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
              <th className="px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted whitespace-nowrap">
                Сума (факт.), ₴
              </th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {lines.length === 0 && !showLineInput && (
              <tr>
                <td
                  // VAT-колонка умовна (vatMode !== 'NONE'), тож
                  // загальна кількість колонок 6 або 7. Парна таблиця "Товари"
                  // вже робить умовний colSpan; для works був хардкод 6 →
                  // visual drift коли VAT-колонка є.
                  colSpan={vatMode !== 'NONE' ? 9 : 8}
                  className="px-3 py-4 text-center text-[12px] text-muted-foreground"
                >
                  Натисніть «Додати» щоб додати роботу
                </td>
              </tr>
            )}
            {lines.map(line => {
              const emp = employeesById.get(line.employeeId);
              const h = toNumberOrUndefined(line.normoHours);
              const p = toNumberOrUndefined(line.price);
              const sum = h != null && p != null ? h * p : null;
              return (
                <tr
                  key={line._key}
                  className={
                    editingLineKey === line._key
                      ? 'bg-primary/5'
                      : 'bg-surface hover:bg-secondary/30 transition-colors'
                  }
                >
                  {editingLineKey === line._key ? (
                    <>
                      <td className="px-2 py-1.5">
                        <EntityPickerField<WorkPickerItem>
                          display={editingLine.workName}
                          placeholder="Пошук роботи..."
                          ariaLabel="Робота"
                          onPick={() => canEdit && setEditWorkPickerOpen(true)}
                          onSearch={fetchWorks}
                          onSearchSelect={w =>
                            setEditingLine(l => ({
                              ...l,
                              workId: w.id,
                              workName: w.name,
                              normoHours: String(w.normoHours),
                              price: String(w.price),
                            }))
                          }
                          onClear={() => setEditingLine(l => ({ ...l, workId: '', workName: '' }))}
                          disabled={!canEdit}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Select
                          value={editingLine.employeeId}
                          onChange={e =>
                            setEditingLine(l => ({ ...l, employeeId: e.target.value }))
                          }
                          disabled={!canEdit}
                        >
                          <option value="">— Механік —</option>
                          {employees.map(e => (
                            <option key={e.id} value={e.id}>
                              {e.lastName} {e.firstName}
                            </option>
                          ))}
                        </Select>
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          placeholder="0"
                          type="number"
                          value={editingLine.normoHours}
                          onChange={e =>
                            setEditingLine(l => ({ ...l, normoHours: e.target.value }))
                          }
                          min="0"
                          step="0.1"
                          disabled={!canEdit}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          placeholder="—"
                          type="number"
                          value={editingLine.actualHours}
                          onChange={e =>
                            setEditingLine(l => ({
                              ...l,
                              actualHours: e.target.value,
                            }))
                          }
                          min="0"
                          step="0.1"
                          disabled={!canEditActual}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          placeholder="0"
                          type="number"
                          value={editingLine.price}
                          onChange={e => setEditingLine(l => ({ ...l, price: e.target.value }))}
                          min="0"
                          disabled={!canEdit}
                        />
                      </td>
                      {vatMode !== 'NONE' && (
                        <td className="px-2 py-1.5 text-left tabular-nums text-[12px] text-muted-foreground">
                          {(() => {
                            const h = toNumberOrUndefined(editingLine.normoHours);
                            const p = toNumberOrUndefined(editingLine.price);
                            return h != null && p != null && vatRate > 0
                              ? ((h * p * vatRate) / 100).toFixed(2)
                              : '—';
                          })()}
                        </td>
                      )}
                      <td className="px-2 py-1.5 text-left tabular-nums text-[12px] text-muted-foreground">
                        {(() => {
                          const h = toNumberOrUndefined(editingLine.normoHours);
                          const p = toNumberOrUndefined(editingLine.price);
                          return h != null && p != null ? (h * p).toFixed(2) : '—';
                        })()}
                      </td>
                      <td className="px-2 py-1.5 text-left tabular-nums text-[12px] text-muted-foreground">
                        {(() => {
                          const ah = toNumberOrUndefined(editingLine.actualHours);
                          const nh = toNumberOrUndefined(editingLine.normoHours);
                          const h = ah ?? nh;
                          const p = toNumberOrUndefined(editingLine.price);
                          return h != null && p != null ? (h * p).toFixed(2) : '—';
                        })()}
                      </td>
                      <td className="px-1.5 py-1.5">
                        <div className="flex flex-row gap-2 items-center">
                          <button
                            type="button"
                            onClick={() => {
                              if (!editingLine.workId || !editingLine.employeeId) return;
                              // spread `l` first to preserve `id` (DB-only).
                              // editingLine ніколи не містить `id` (виставляється лише
                              // workId/workName/employeeId/normoHours/actualHours/price);
                              // без `...l` merge зкидав `id` → save() filter `!!l.id` пропускав
                              // рядок → PATCH /work-orders/:id/lines/:lineId не надсилався
                              // → actualHours = null у БД попри «1.5» у UI.
                              setLines(prev =>
                                prev.map(l =>
                                  l._key === line._key ? { ...l, ...editingLine, _key: l._key } : l,
                                ),
                              );
                              setEditingLineKey(null);
                            }}
                            disabled={!editingLine.workId || !editingLine.employeeId}
                            title="Зберегти"
                            className="p-1 rounded text-primary hover:bg-primary/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                          >
                            <Check className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingLineKey(null)}
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
                      <td className="px-3 py-1.5 text-foreground truncate">{line.workName}</td>
                      <td className="px-2 py-1.5 text-muted-foreground truncate">
                        {emp ? `${emp.lastName} ${emp.firstName}` : '—'}
                      </td>
                      <td className="px-2 py-1.5 text-left tabular-nums text-muted-foreground">
                        {line.normoHours || '—'}
                      </td>
                      <td className="px-2 py-1.5 text-left tabular-nums text-muted-foreground">
                        {line.actualHours || '—'}
                      </td>
                      <td className="px-2 py-1.5 text-left tabular-nums text-muted-foreground">
                        {line.price || '—'}
                      </td>
                      {vatMode !== 'NONE' && (
                        <td className="px-2 py-1.5 text-left tabular-nums text-muted-foreground">
                          {h != null && p != null && vatRate > 0
                            ? ((h * p * vatRate) / 100).toFixed(2)
                            : '—'}
                        </td>
                      )}
                      <td className="px-2 py-1.5 text-left tabular-nums font-medium text-foreground">
                        {sum != null ? sum.toFixed(2) : '—'}
                      </td>
                      <td className="px-2 py-1.5 text-left tabular-nums text-muted-foreground">
                        {(() => {
                          const ah = toNumberOrUndefined(line.actualHours);
                          const nh = toNumberOrUndefined(line.normoHours);
                          const h = ah ?? nh;
                          return h != null && p != null ? (h * p).toFixed(2) : '—';
                        })()}
                      </td>
                      <td className="px-1.5 py-1.5 text-left">
                        <div className="flex flex-row gap-2 items-center">
                          <button
                            type="button"
                            onClick={() => {
                              setEditingLineKey(line._key);
                              setEditingLine({
                                workId: line.workId,
                                workName: line.workName,
                                employeeId: line.employeeId,
                                normoHours: line.normoHours,
                                actualHours: line.actualHours,
                                price: line.price,
                              });
                            }}
                            disabled={saving || (!canEdit && !canEditActual)}
                            aria-label="Редагувати роботу"
                            title={canEditActual && !canEdit ? 'Ввести год (факт.)' : 'Редагувати'}
                            className="p-1 rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors disabled:opacity-50"
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (line.id) deletedLineIds.current.push(line.id);
                              setLines(prev => {
                                const updated = prev.filter(l => l._key !== line._key);
                                if (recalcPlannedHoursEnabled) {
                                  setForm(f => {
                                    const newHours = calcPlannedHoursFromLines(
                                      f.plannedHours,
                                      updated,
                                    );
                                    const newEnd =
                                      newHours !== f.plannedHours && f.plannedStartAt
                                        ? calcEndFromHours(
                                            f.plannedStartAt,
                                            Number(newHours.replace(',', '.')),
                                          )
                                        : f.plannedEndAt;
                                    return {
                                      ...f,
                                      plannedHours: newHours,
                                      plannedEndAt: newEnd || f.plannedEndAt,
                                    };
                                  });
                                }
                                return updated;
                              });
                            }}
                            disabled={saving || !canEdit}
                            aria-label="Видалити роботу"
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

            {/* Рядок вводу — з'являється після кліку "+ Додати" */}
            {showLineInput && (
              <tr className="bg-primary/5 border-t-2 border-primary/20">
                <td className="px-2 py-1.5">
                  <EntityPickerField<WorkPickerItem>
                    display={newLine.workName}
                    placeholder="Пошук роботи..."
                    ariaLabel="Робота"
                    onPick={() => setWorkPickerOpen(true)}
                    onSearch={fetchWorks}
                    onSearchSelect={w =>
                      setNewLine(l => ({
                        ...l,
                        workId: w.id,
                        workName: w.name,
                        normoHours: String(w.normoHours),
                        price: String(w.price),
                      }))
                    }
                    onClear={() => setNewLine(EMPTY_LINE)}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <Select
                    value={newLine.employeeId}
                    onChange={e => setNewLine(l => ({ ...l, employeeId: e.target.value }))}
                  >
                    <option value="">— Механік —</option>
                    {employees.map(e => (
                      <option key={e.id} value={e.id}>
                        {e.lastName} {e.firstName}
                      </option>
                    ))}
                  </Select>
                </td>
                <td className="px-2 py-1.5">
                  <Input
                    placeholder="0"
                    type="number"
                    value={newLine.normoHours}
                    onChange={e => setNewLine(l => ({ ...l, normoHours: e.target.value }))}
                    min="0"
                    step="0.1"
                  />
                </td>
                <td className="px-2 py-1.5 text-left tabular-nums text-[12px] text-muted-foreground">
                  —
                </td>
                <td className="px-2 py-1.5">
                  <Input
                    placeholder="0"
                    type="number"
                    value={newLine.price}
                    onChange={e => setNewLine(l => ({ ...l, price: e.target.value }))}
                    min="0"
                  />
                </td>
                {vatMode !== 'NONE' && (
                  <td className="px-2 py-1.5 text-left tabular-nums text-[12px] text-muted-foreground">
                    {(() => {
                      const h = toNumberOrUndefined(newLine.normoHours);
                      const p = toNumberOrUndefined(newLine.price);
                      return h != null && p != null && vatRate > 0
                        ? ((h * p * vatRate) / 100).toFixed(2)
                        : '—';
                    })()}
                  </td>
                )}
                <td className="px-2 py-1.5 text-left tabular-nums text-[12px] text-muted-foreground">
                  {(() => {
                    const h = toNumberOrUndefined(newLine.normoHours);
                    const p = toNumberOrUndefined(newLine.price);
                    return h != null && p != null ? (h * p).toFixed(2) : '—';
                  })()}
                </td>
                <td className="px-2 py-1.5 text-left tabular-nums text-[12px] text-muted-foreground">
                  —
                </td>
                <td className="px-1.5 py-1.5">
                  <div className="flex flex-row gap-2 items-center">
                    <button
                      type="button"
                      onClick={addLine}
                      disabled={!newLine.workId || !newLine.employeeId || saving}
                      title="Зберегти рядок"
                      className="p-1 rounded text-primary hover:bg-primary/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setNewLine(EMPTY_LINE);
                        setShowLineInput(false);
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
          {lines.length > 0 && (
            <tfoot>
              <tr className="bg-secondary/50 border-t border-border">
                <td
                  colSpan={5}
                  className="px-3 py-1.5 text-left text-xs font-medium text-muted-foreground"
                >
                  Разом робіт:
                </td>
                {vatMode !== 'NONE' && (
                  <td className="px-2 py-1.5 text-left tabular-nums text-xs font-semibold text-foreground">
                    {linesTotals.vat.toFixed(2)}
                  </td>
                )}
                <td className="px-2 py-1.5 text-left tabular-nums text-xs font-semibold text-foreground">
                  {linesTotals.total.toFixed(2)}
                </td>
                <td />
                <td />
              </tr>
              {actualTotals.hasAny && (
                <tr className="bg-secondary/30 border-t border-border/50">
                  <td
                    colSpan={vatMode !== 'NONE' ? 7 : 6}
                    className="px-3 py-1.5 text-left text-xs font-medium text-muted-foreground"
                  >
                    Факт. роботи:
                  </td>
                  <td className="px-2 py-1.5 text-left tabular-nums text-xs font-semibold text-foreground">
                    {actualTotals.total.toFixed(2)}
                  </td>
                  <td />
                </tr>
              )}
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
