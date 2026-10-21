'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { fmtQty } from '@/lib/format';
import { groupBy } from '@/lib/group-by';
import { toast } from '@/lib/toast';
import { invalidateProcurementSideEffects } from '@/lib/cache-invalidation';
import { purchaseListsApi, usePurchaseLists } from '@/hooks/api/usePurchaseLists';

/** Рядок товару наряду, який можна надіслати до списку купівлі (BR-PL-003). */
export interface AddToListRow {
  workOrderId: string;
  workOrderPartId: string;
  /** Назва товару (і номер наряду, якщо рядки з різних нарядів). */
  label: string;
  sublabel?: string;
  /** Непокрита потреба в базових одиницях — кількість за замовчуванням. */
  shortage: number;
  unit?: string | null;
}

interface AddToListDialogProps {
  open: boolean;
  onClose: () => void;
  rows: AddToListRow[];
  onDone?: (result: { listId: string; listNumber: string; count: number }) => void;
}

type Target = 'new' | 'existing';

/** Той самий ключ кешу, що й фільтр «Список» на вкладці «Позиції» — спільний запит. */
const OPEN_LISTS_FILTER = { status: 'OPEN', page: 1, limit: 100 } as const;

/**
 * «До списку купівлі»: вибрані товари нарядів → новий або наявний відкритий список. Спільний для
 * картки наряду й вкладки «Нестача». Кількість — у базових одиницях товару (BR-PL-002), за
 * замовчуванням — непокрита потреба. Рядки різних нарядів надсилаються по наряду: перший запит
 * створює новий список, решта додає в нього.
 */
export function AddToListDialog({ open, onClose, rows, onDone }: AddToListDialogProps) {
  const { t } = useTranslation('purchaseLists');
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [qty, setQty] = useState<Record<string, string>>({});
  const [target, setTarget] = useState<Target>('new');
  const [newName, setNewName] = useState('');
  const [listId, setListId] = useState('');
  const [saving, setSaving] = useState(false);
  // Запит уже йде: Ctrl+Enter (Modal onSubmit) кнопка `loading` не блокує — повтор надіслав би
  // ті самі товари вдруге (кількість позиції подвоїлась би).
  const savingRef = useRef(false);
  const [formError, setFormError] = useState('');

  // Відкриті списки потрібні лише відкритому діалогу: сам діалог змонтований у картці наряду й на
  // вкладці «Нестача» постійно, тож без `open` кожне відкриття картки читало списки (і перечитувало
  // їх після кожного скидання кешу закупівель) — sto-optimize.
  const { data: openLists } = usePurchaseLists(OPEN_LISTS_FILTER, open);
  const lists = openLists?.items ?? [];

  // Скидання форми при кожному відкритті: усі рядки вибрані, кількість — непокрита потреба.
  useEffect(() => {
    if (!open) return;
    setSelected(new Set(rows.map(r => r.workOrderPartId)));
    // Округлення до 6 знаків (епсилон кількостей BR-PL-002): дробовий коефіцієнт одиниці дає
    // Float-хвіст — без нього в полі стояло б «0.30000000000000004» (Bug #886).
    setQty(
      Object.fromEntries(
        rows.map(r => [r.workOrderPartId, String(Math.round(r.shortage * 1e6) / 1e6)]),
      ),
    );
    setTarget('new');
    setNewName('');
    setListId('');
    setFormError('');
  }, [open, rows]);

  const chosen = useMemo(() => rows.filter(r => selected.has(r.workOrderPartId)), [rows, selected]);

  const toggle = (id: string) =>
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = async () => {
    if (savingRef.current) return;
    if (chosen.length === 0) {
      setFormError(t('addToList.errors.nothingSelected'));
      return;
    }
    if (target === 'existing' && !listId) {
      setFormError(t('addToList.errors.listRequired'));
      return;
    }
    const parsed = chosen.map(r => ({ row: r, quantity: Number(qty[r.workOrderPartId]) }));
    if (parsed.some(p => !Number.isFinite(p.quantity) || p.quantity <= 0)) {
      setFormError(t('addToList.errors.quantity'));
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setFormError('');
    try {
      const byWo = groupBy(parsed, p => p.row.workOrderId);
      let targetListId = target === 'existing' ? listId : '';
      let listNumber = lists.find(l => l.id === listId)?.number ?? '';
      let count = 0;
      for (const [workOrderId, group] of byWo) {
        const res = await purchaseListsApi.fromWorkOrder({
          workOrderId,
          ...(targetListId
            ? { listId: targetListId }
            : { newList: newName.trim() ? { name: newName.trim() } : {} }),
          parts: group.map(p => ({
            workOrderPartId: p.row.workOrderPartId,
            quantity: p.quantity,
          })),
        });
        targetListId = res.list.id;
        listNumber = res.list.number;
        count += res.items.length;
      }
      invalidateProcurementSideEffects(qc);
      toast.success(t('addToList.done', { count, number: listNumber }));
      onDone?.({ listId: targetListId, listNumber, count });
      onClose();
    } catch (e: unknown) {
      // Частину нарядів могло вже бути надіслано — кеш скидаємо й тоді.
      invalidateProcurementSideEffects(qc);
      setFormError(e instanceof Error ? e.message : t('addToList.errors.failed'));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('addToList.title')}
      description={t('addToList.description')}
      size="lg"
      onSubmit={() => void submit()}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={saving}>
            {t('addToList.submit')}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-[12px]">
            <colgroup>
              <col className="w-8" />
              <col />
              <col className="w-24" />
              <col className="w-28" />
            </colgroup>
            <thead>
              <tr className="border-b border-border bg-secondary/40 text-[11px] uppercase tracking-[0.06em] text-foreground-muted">
                <th className="px-2 py-2" />
                <th className="px-2 py-2 text-left font-semibold">{t('addToList.columns.good')}</th>
                <th className="px-2 py-2 text-right font-semibold">
                  {t('addToList.columns.shortage')}
                </th>
                <th className="px-2 py-2 text-right font-semibold">
                  {t('addToList.columns.quantity')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-4 text-center text-muted-foreground">
                    {t('addToList.empty')}
                  </td>
                </tr>
              )}
              {rows.map(r => (
                <tr key={r.workOrderPartId}>
                  <td className="px-2 py-1.5">
                    <input
                      type="checkbox"
                      checked={selected.has(r.workOrderPartId)}
                      onChange={() => toggle(r.workOrderPartId)}
                      aria-label={t('addToList.selectRow', { good: r.label })}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="truncate text-foreground">{r.label}</div>
                    {r.sublabel && (
                      <div className="truncate text-[11px] text-muted-foreground">{r.sublabel}</div>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                    {fmtQty(r.shortage)} {r.unit ?? ''}
                  </td>
                  <td className="px-2 py-1.5">
                    <Input
                      type="number"
                      min="0.001"
                      step="any"
                      className="text-right"
                      value={qty[r.workOrderPartId] ?? ''}
                      onChange={e =>
                        setQty(prev => ({ ...prev, [r.workOrderPartId]: e.target.value }))
                      }
                      aria-label={t('addToList.quantityFor', { good: r.label })}
                      disabled={!selected.has(r.workOrderPartId)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-muted-foreground">{t('addToList.baseUnitsHint')}</p>

        <fieldset className="space-y-2">
          <legend className="text-[13px] font-medium text-foreground mb-1">
            {t('addToList.target')}
          </legend>
          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="radio"
              name="pl-target"
              checked={target === 'new'}
              onChange={() => setTarget('new')}
            />
            {t('addToList.targetNew')}
          </label>
          {target === 'new' && (
            <Input
              placeholder={t('addToList.newNamePlaceholder')}
              value={newName}
              onChange={e => setNewName(e.target.value)}
              maxLength={120}
              aria-label={t('addToList.newName')}
            />
          )}
          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="radio"
              name="pl-target"
              checked={target === 'existing'}
              onChange={() => setTarget('existing')}
              disabled={lists.length === 0}
            />
            {t('addToList.targetExisting')}
          </label>
          {target === 'existing' && (
            <Select
              value={listId}
              onChange={e => setListId(e.target.value)}
              aria-label={t('addToList.existingList')}
            >
              <option value="">{t('addToList.chooseList')}</option>
              {lists.map(l => (
                <option key={l.id} value={l.id}>
                  {l.number}
                  {l.name ? ` — ${l.name}` : ''}
                </option>
              ))}
            </Select>
          )}
        </fieldset>

        {formError && (
          <div className="text-sm text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">
            {formError}
          </div>
        )}
      </div>
    </Modal>
  );
}
