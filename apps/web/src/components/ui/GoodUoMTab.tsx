'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Star, X, Check } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { AnimatedBody } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useConfirm } from '@/hooks/useConfirm';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useUiFeatures } from '@/hooks/useUiFeatures';

interface Unit {
  id: string;
  name: string;
  shortName: string;
  isSystem: boolean;
  coefficient: number;
}

interface GoodUoM {
  id: string;
  unitOfMeasureId: string;
  unitName: string;
  unitShortName: string;
  coefficient: number;
  isDefault: boolean;
  width?: number | null;
  height?: number | null;
  depth?: number | null;
  volume?: number | null;
  weight?: number | null;
}

interface UoMEditForm {
  coefficient: string;
  width: string;
  height: string;
  depth: string;
  volume: string;
  weight: string;
}

interface GoodUoMTabProps {
  goodId: string;
  /** Reference list of available units (passed from parent — already fetched) */
  units: Unit[];
  /** Optional — reserved for future tenant-scoped endpoints */
  orgId?: string;
  /** Notifies parent when count changes (for tabs strip badge) */
  onCountChange?: (count: number) => void;
  /** Optional — notify parent that something changed (used for backwards-compat hooks) */
  onChanged?: () => void;
}

const EMPTY_ADD_UOM_FORM = {
  unitOfMeasureId: '',
  coefficient: '1',
  width: '',
  height: '',
  depth: '',
  volume: '',
  weight: '',
};

export function GoodUoMTab({ goodId, units, onCountChange, onChanged }: GoodUoMTabProps) {
  const features = useUiFeatures();
  const { confirm, dialogProps: confirmDialogProps } = useConfirm();

  const [modalUoMs, setModalUoMs] = useState<GoodUoM[]>([]);
  const [modalUoMsLoading, setModalUoMsLoading] = useState(false);
  const [uomError, setUomError] = useState('');
  const [showAddUoM, setShowAddUoM] = useState(false);
  const [addUoMForm, setAddUoMForm] = useState(EMPTY_ADD_UOM_FORM);
  const [addingUoM, setAddingUoM] = useState(false);
  const [deletingUoMId, setDeletingUoMId] = useState<string | null>(null);
  const [editingUoMId, setEditingUoMId] = useState<string | null>(null);
  const [editUoMForm, setEditUoMForm] = useState<UoMEditForm>({
    coefficient: '1',
    width: '',
    height: '',
    depth: '',
    volume: '',
    weight: '',
  });
  const [savingUoMId, setSavingUoMId] = useState<string | null>(null);
  const modalUoMReqRef = useRef(0);
  const uomRefDefault = useRef(0);

  // Notify parent of count changes (tab badge)
  useEffect(() => {
    onCountChange?.(modalUoMs.length);
  }, [modalUoMs.length, onCountChange]);

  useEffect(() => {
    if (!goodId) {
      setModalUoMs([]);
      return;
    }
    const reqId = ++modalUoMReqRef.current;
    setModalUoMs([]);
    setModalUoMsLoading(true);
    setUomError('');
    setShowAddUoM(false);
    setAddUoMForm(EMPTY_ADD_UOM_FORM);
    setEditingUoMId(null);

    apiFetch<GoodUoM[]>(`/goods/${goodId}/uoms`)
      .then(data => {
        if (modalUoMReqRef.current === reqId) setModalUoMs(data);
      })
      .catch(err => {
        if (modalUoMReqRef.current === reqId)
          setUomError(err instanceof Error ? err.message : 'Помилка завантаження одиниць виміру');
      })
      .finally(() => {
        if (modalUoMReqRef.current === reqId) setModalUoMsLoading(false);
      });
  }, [goodId]);

  const refreshUoMs = useCallback(() => {
    const reqId = ++modalUoMReqRef.current;
    apiFetch<GoodUoM[]>(`/goods/${goodId}/uoms`)
      .then(data => {
        if (modalUoMReqRef.current === reqId) setModalUoMs(data);
      })
      .catch(() => {
        /* silent — toast already shown */
      });
  }, [goodId]);

  const addUoM = async () => {
    if (!addUoMForm.unitOfMeasureId) return;
    const coeff = addUoMForm.coefficient ? Number(addUoMForm.coefficient) : 1;
    if (!Number.isFinite(coeff) || coeff <= 0) {
      setUomError('Коефіцієнт має бути більший 0');
      return;
    }
    setUomError('');
    setAddingUoM(true);
    try {
      const created = await apiFetch<GoodUoM>(`/goods/${goodId}/uoms`, {
        method: 'POST',
        body: JSON.stringify({
          unitOfMeasureId: addUoMForm.unitOfMeasureId,
          coefficient: coeff,
          width: addUoMForm.width ? Number(addUoMForm.width) : undefined,
          height: addUoMForm.height ? Number(addUoMForm.height) : undefined,
          depth: addUoMForm.depth ? Number(addUoMForm.depth) : undefined,
          volume: addUoMForm.volume ? Number(addUoMForm.volume) : undefined,
          weight: addUoMForm.weight ? Number(addUoMForm.weight) : undefined,
        }),
      });
      setModalUoMs(prev => [...prev, created]);
      setAddUoMForm(EMPTY_ADD_UOM_FORM);
      setShowAddUoM(false);
      onChanged?.();
      if (features.toastEnabled) toast.success('Одиницю виміру додано');
    } catch (e: unknown) {
      if (features.toastEnabled) {
        toast.error(e instanceof Error ? e.message : 'Помилка додавання одиниці');
      }
    } finally {
      setAddingUoM(false);
    }
  };

  const setDefaultUoM = async (uomId: string) => {
    const reqId = ++uomRefDefault.current;
    try {
      await apiFetch<GoodUoM>(`/goods/${goodId}/uoms/${uomId}/default`, { method: 'PATCH' });
      if (uomRefDefault.current === reqId) {
        setModalUoMs(prev => prev.map(u => ({ ...u, isDefault: u.id === uomId })));
        onChanged?.();
        if (features.toastEnabled) toast.success('Основну одиницю змінено');
      }
    } catch (e: unknown) {
      if (uomRefDefault.current === reqId && features.toastEnabled) {
        toast.error(e instanceof Error ? e.message : 'Помилка встановлення основної одиниці');
      }
    }
  };

  const deleteUoM = async (uomId: string) => {
    if (!(await confirm({ title: 'Видалити одиницю виміру?', variant: 'destructive' }))) return;
    setDeletingUoMId(uomId);
    try {
      await apiFetch<void>(`/goods/${goodId}/uoms/${uomId}`, { method: 'DELETE' });
      refreshUoMs();
      onChanged?.();
      if (features.toastEnabled) toast.success('Одиницю видалено');
    } catch (e: unknown) {
      if (features.toastEnabled) {
        toast.error(e instanceof Error ? e.message : 'Помилка видалення');
      }
    } finally {
      setDeletingUoMId(null);
    }
  };

  const openEditUoM = (u: GoodUoM) => {
    setEditingUoMId(u.id);
    setEditUoMForm({
      coefficient: String(u.coefficient),
      width: u.width != null ? String(u.width) : '',
      height: u.height != null ? String(u.height) : '',
      depth: u.depth != null ? String(u.depth) : '',
      volume: u.volume != null ? String(u.volume) : '',
      weight: u.weight != null ? String(u.weight) : '',
    });
    setUomError('');
  };

  const cancelEditUoM = () => {
    setEditingUoMId(null);
    setUomError('');
  };

  const saveUoMEdit = async (uomId: string) => {
    if (!editUoMForm.coefficient.trim()) {
      setUomError('Коефіцієнт є обовʼязковим');
      return;
    }
    const coeff = Number(editUoMForm.coefficient);
    if (!Number.isFinite(coeff) || coeff <= 0) {
      setUomError('Коефіцієнт має бути більший 0');
      return;
    }
    setSavingUoMId(uomId);
    setUomError('');
    try {
      await apiFetch<GoodUoM>(`/goods/${goodId}/uoms/${uomId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          coefficient: coeff,
          width: editUoMForm.width ? Number(editUoMForm.width) : undefined,
          height: editUoMForm.height ? Number(editUoMForm.height) : undefined,
          depth: editUoMForm.depth ? Number(editUoMForm.depth) : undefined,
          volume: editUoMForm.volume ? Number(editUoMForm.volume) : undefined,
          weight: editUoMForm.weight ? Number(editUoMForm.weight) : undefined,
        }),
      });
      setEditingUoMId(null);
      refreshUoMs();
      onChanged?.();
      if (features.toastEnabled) toast.success('Одиницю виміру оновлено');
    } catch (e: unknown) {
      setUomError(e instanceof Error ? e.message : 'Помилка збереження');
    } finally {
      setSavingUoMId(null);
    }
  };

  return (
    <div className="space-y-3">
      {modalUoMsLoading && (
        <div className="py-6 text-center text-sm text-muted-foreground">Завантаження...</div>
      )}
      {!modalUoMsLoading && uomError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive-subtle px-3 py-2 text-sm text-destructive-text">
          {uomError}
        </div>
      )}
      {!modalUoMsLoading && !uomError && (
        <>
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-muted-foreground">{modalUoMs.length} одиниці</span>
            {!showAddUoM && (
              <Button
                size="sm"
                variant="outline"
                leftIcon={<Plus className="h-3.5 w-3.5" />}
                onClick={() => setShowAddUoM(true)}
              >
                Додати
              </Button>
            )}
          </div>
          {showAddUoM && (
            <AnimatedBody className="rounded-lg border border-border bg-secondary/40 p-3 space-y-3">
              <Select
                label="Одиниця виміру"
                required
                value={addUoMForm.unitOfMeasureId}
                onChange={e => setAddUoMForm(f => ({ ...f, unitOfMeasureId: e.target.value }))}
              >
                <option value="">— Виберіть одиницю —</option>
                {units.map(u => (
                  <option key={u.id} value={u.id}>
                    {u.shortName} ({u.name})
                  </option>
                ))}
              </Select>
              <Input
                label="Коефіцієнт"
                type="number"
                min="0"
                step="any"
                value={addUoMForm.coefficient}
                onChange={e => setAddUoMForm(f => ({ ...f, coefficient: e.target.value }))}
                hint="Скільки базових одиниць в одній цій"
              />
              <div className="grid grid-cols-3 gap-2">
                <Input
                  label="Ширина, м"
                  type="number"
                  min="0"
                  step="any"
                  value={addUoMForm.width}
                  onChange={e => setAddUoMForm(f => ({ ...f, width: e.target.value }))}
                  placeholder="—"
                />
                <Input
                  label="Висота, м"
                  type="number"
                  min="0"
                  step="any"
                  value={addUoMForm.height}
                  onChange={e => setAddUoMForm(f => ({ ...f, height: e.target.value }))}
                  placeholder="—"
                />
                <Input
                  label="Глибина, м"
                  type="number"
                  min="0"
                  step="any"
                  value={addUoMForm.depth}
                  onChange={e => setAddUoMForm(f => ({ ...f, depth: e.target.value }))}
                  placeholder="—"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  label="Об'єм, м³"
                  type="number"
                  min="0"
                  step="any"
                  value={addUoMForm.volume}
                  onChange={e => setAddUoMForm(f => ({ ...f, volume: e.target.value }))}
                  placeholder="—"
                />
                <Input
                  label="Вага, кг"
                  type="number"
                  min="0"
                  step="any"
                  value={addUoMForm.weight}
                  onChange={e => setAddUoMForm(f => ({ ...f, weight: e.target.value }))}
                  placeholder="—"
                />
              </div>
              <div className="flex gap-2 justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setShowAddUoM(false);
                    setAddUoMForm(EMPTY_ADD_UOM_FORM);
                  }}
                >
                  Скасувати
                </Button>
                <Button
                  size="sm"
                  loading={addingUoM}
                  disabled={!addUoMForm.unitOfMeasureId}
                  onClick={() => void addUoM()}
                >
                  Додати
                </Button>
              </div>
            </AnimatedBody>
          )}
          {modalUoMs.length > 0 && (
            <div className="rounded-xl border border-border overflow-hidden">
              <table className="w-full text-[13px]">
                <thead className="bg-secondary border-b border-border">
                  <tr>
                    <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                      Одиниця
                    </th>
                    <th className="text-left px-3 py-2 text-muted-foreground font-medium">
                      Коефіцієнт
                    </th>
                    <th className="w-10 px-3 py-2 text-muted-foreground" title="Основна">
                      <Star className="h-3.5 w-3.5" />
                    </th>
                    <th className="w-12" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {modalUoMs.map(u =>
                    editingUoMId === u.id ? (
                      <tr key={u.id} className="bg-primary/5">
                        <td className="px-3 py-2 text-foreground">
                          <div>
                            <p className="font-medium">{u.unitShortName}</p>
                            <p className="text-[12px] text-muted-foreground">{u.unitName}</p>
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <input
                            autoFocus
                            type="number"
                            min="0"
                            step="any"
                            value={editUoMForm.coefficient}
                            onChange={e =>
                              setEditUoMForm(f => ({ ...f, coefficient: e.target.value }))
                            }
                            onKeyDown={e => {
                              if (e.key === 'Escape') cancelEditUoM();
                              if (e.key === 'Enter') void saveUoMEdit(u.id);
                            }}
                            className="w-24 rounded border border-primary/40 bg-surface px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                          />
                        </td>
                        <td className="px-3 py-2 text-center">
                          {u.isDefault ? (
                            <Star className="h-3.5 w-3.5 text-warning-text fill-warning-text mx-auto" />
                          ) : (
                            <Star className="h-3.5 w-3.5 text-muted-foreground mx-auto" />
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center justify-end gap-1">
                            <button
                              type="button"
                              disabled={savingUoMId === u.id}
                              onClick={() => void saveUoMEdit(u.id)}
                              className="text-success/80 hover:text-success hover:bg-success/10 p-1 rounded transition-colors"
                              title="Зберегти (Enter)"
                            >
                              {savingUoMId === u.id ? (
                                <span className="text-[11px]">...</span>
                              ) : (
                                <Check className="h-3.5 w-3.5" />
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={cancelEditUoM}
                              className="text-muted-foreground hover:text-foreground p-1 rounded transition-colors"
                              title="Скасувати (Esc)"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      <tr
                        key={u.id}
                        className="bg-surface hover:bg-secondary/50 transition-colors cursor-pointer group"
                        onClick={() => openEditUoM(u)}
                      >
                        <td className="px-3 py-2 text-foreground">
                          <div>
                            <p className="font-medium">{u.unitShortName}</p>
                            <p className="text-[12px] text-muted-foreground">{u.unitName}</p>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-muted-foreground tabular-nums">
                          {u.coefficient !== 1 ? u.coefficient : '—'}
                        </td>
                        <td className="px-3 py-2 text-center">
                          {u.isDefault ? (
                            <Star className="h-3.5 w-3.5 text-warning-text fill-warning-text mx-auto" />
                          ) : (
                            <button
                              type="button"
                              onClick={e => {
                                e.stopPropagation();
                                void setDefaultUoM(u.id);
                              }}
                              className="text-muted-foreground hover:text-warning-text transition-colors mx-auto block"
                              title="Встановити основною"
                            >
                              <Star className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <button
                            type="button"
                            disabled={deletingUoMId === u.id}
                            onClick={e => {
                              e.stopPropagation();
                              void deleteUoM(u.id);
                            }}
                            className="text-destructive/70 hover:text-destructive hover:bg-destructive/10 p-1 rounded transition-colors opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                            title="Видалити"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
          )}
          {modalUoMs.length === 0 && !showAddUoM && (
            <p className="text-[13px] text-muted-foreground text-center py-4">
              Додаткових одиниць не додано
            </p>
          )}
        </>
      )}

      <ConfirmDialog {...confirmDialogProps} />
    </div>
  );
}
