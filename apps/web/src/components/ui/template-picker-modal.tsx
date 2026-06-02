'use client';

import { useEffect, useState, useMemo } from 'react';
import { Search, Check } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Modal } from '@/components/ui/modal';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SystemTemplate {
  id: string;
  entityType: string;
  key: string;
  name: string;
  data: Record<string, unknown>;
  sortOrder: number;
}

export type TemplateEntityType =
  | 'currency'
  | 'unit_of_measure'
  | 'payment_method'
  | 'work_category';

interface Props {
  open: boolean;
  onClose: () => void;
  entityType: TemplateEntityType;
  title: string;
  existingKeys: string[];
  onImport: (templates: SystemTemplate[]) => Promise<void>;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function TemplatePickerModal({
  open,
  onClose,
  entityType,
  title,
  existingKeys,
  onImport,
}: Props) {
  const [templates, setTemplates] = useState<SystemTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Load templates when modal opens
  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setQ('');
    setError('');
    setLoading(true);
    apiFetch<SystemTemplate[]>(`/system-templates?entityType=${entityType}`)
      .then(setTemplates)
      .catch(() => setError('Не вдалось завантажити шаблони'))
      .finally(() => setLoading(false));
  }, [open, entityType]);

  const filtered = useMemo(() => {
    if (!q.trim()) return templates;
    const lq = q.toLowerCase();
    return templates.filter(
      t => t.name.toLowerCase().includes(lq) || t.key.toLowerCase().includes(lq),
    );
  }, [templates, q]);

  const toggle = (key: string) => {
    if (existingKeys.includes(key)) return;
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAll = () => {
    const newItems = filtered.filter(t => !existingKeys.includes(t.key)).map(t => t.key);
    setSelected(prev => {
      const next = new Set(prev);
      newItems.forEach(k => next.add(k));
      return next;
    });
  };

  const clearAll = () => setSelected(new Set());

  const handleImport = async () => {
    const toImport = templates.filter(t => selected.has(t.key));
    if (toImport.length === 0) return;
    setImporting(true);
    setError('');
    try {
      await onImport(toImport);
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка імпорту');
    } finally {
      setImporting(false);
    }
  };

  const newCount = filtered.filter(t => !existingKeys.includes(t.key)).length;
  const selectedCount = selected.size;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="md"
      footer={
        <div className="flex items-center justify-between w-full gap-3">
          <span className="text-[13px] text-muted-foreground">
            {selectedCount > 0 ? `Вибрано: ${selectedCount}` : 'Нічого не вибрано'}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={importing}>
              Скасувати
            </Button>
            <Button onClick={handleImport} loading={importing} disabled={selectedCount === 0}>
              Додати ({selectedCount})
            </Button>
          </div>
        </div>
      }
    >
      {error && (
        <div className="mb-3 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      <Input
        placeholder="Пошук..."
        leftElement={<Search />}
        value={q}
        onChange={e => setQ(e.target.value)}
        className="mb-3"
      />

      {loading ? (
        <div className="flex justify-center py-8">
          <Spinner size="md" />
        </div>
      ) : (
        <>
          {/* Select all / clear */}
          {newCount > 0 && (
            <div className="flex items-center justify-between mb-2">
              <span className="text-[12px] text-muted-foreground">
                {filtered.length} шаблонів
                {existingKeys.length > 0 && `, ${existingKeys.length} вже додано`}
              </span>
              <div className="flex gap-2">
                {selectedCount > 0 && (
                  <button
                    type="button"
                    onClick={clearAll}
                    className="text-[12px] text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Зняти всі
                  </button>
                )}
                {selectedCount < newCount && (
                  <button
                    type="button"
                    onClick={selectAll}
                    className="text-[12px] text-primary hover:text-primary/80 transition-colors"
                  >
                    Вибрати всі ({newCount})
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="space-y-1 max-h-72 overflow-y-auto pr-1">
            {filtered.length === 0 && (
              <p className="text-center text-[13px] text-muted-foreground py-6">
                Нічого не знайдено
              </p>
            )}
            {filtered.map(t => {
              const isExisting = existingKeys.includes(t.key);
              const isSelected = selected.has(t.key);
              return (
                <button
                  key={t.key}
                  type="button"
                  disabled={isExisting}
                  onClick={() => toggle(t.key)}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors ${
                    isExisting
                      ? 'opacity-50 cursor-not-allowed bg-secondary/30'
                      : isSelected
                        ? 'bg-primary/10 border border-primary/30'
                        : 'hover:bg-secondary border border-transparent'
                  }`}
                >
                  {/* Checkbox */}
                  <span
                    className={`shrink-0 h-4 w-4 rounded border flex items-center justify-center transition-colors ${
                      isExisting
                        ? 'border-muted bg-muted'
                        : isSelected
                          ? 'border-primary bg-primary'
                          : 'border-border bg-surface'
                    }`}
                  >
                    {(isSelected || isExisting) && <Check className="h-2.5 w-2.5 text-white" />}
                  </span>

                  {/* Content */}
                  <span className="flex-1 min-w-0">
                    <span className="text-[13px] font-medium text-foreground block truncate">
                      {t.name}
                    </span>
                    <span className="text-[11px] text-muted-foreground">{t.key}</span>
                  </span>

                  {/* Symbol / extra info */}
                  {typeof t.data.symbol === 'string' && t.data.symbol && (
                    <span className="text-[13px] text-muted-foreground font-mono shrink-0">
                      {t.data.symbol}
                    </span>
                  )}
                  {typeof t.data.shortName === 'string' && t.data.shortName && !t.data.symbol && (
                    <span className="text-[13px] text-muted-foreground shrink-0">
                      {t.data.shortName}
                    </span>
                  )}

                  {isExisting && (
                    <span className="text-[11px] text-success shrink-0 bg-success/10 px-1.5 py-0.5 rounded">
                      є
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}
    </Modal>
  );
}
