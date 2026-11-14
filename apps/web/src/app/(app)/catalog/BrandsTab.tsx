'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Pencil, Trash2, Tag, Eye, EyeOff, RotateCcw, X } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { XlsxImportButton } from '@/components/ui/xlsx-import-button';
import { useConfirm } from '@/hooks/useConfirm';
import { useDeletableRefList } from '@/hooks/useDeletableRefList';
import { useRemoveRestore } from '@/hooks/useRemoveRestore';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { cn } from '@/lib/utils';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Brand {
  id: string;
  name: string;
  synonyms: string[];
  deletedAt?: string | null;
  /** Лише у відповіді `POST /brands/:id/restore`: синоніми, що не повернулися (зайняті). */
  skippedSynonyms?: string[];
}

// ─── Brands Tab ───────────────────────────────────────────────────────────────

/**
 * Adds `raw` to the synonym list: trimmed, skipped when empty or already present
 * (case-insensitive). Shared by the "+" button, Enter and Save.
 */
export function withSynonym(list: string[], raw: string): string[] {
  const value = raw.trim();
  if (!value) return list;
  const lower = value.toLowerCase();
  return list.some(s => s.toLowerCase() === lower) ? list : [...list, value];
}

export default function BrandsTab() {
  const { t } = useTranslation('catalog');
  const { confirm, dialogProps } = useConfirm();
  const [showDeleted, setShowDeleted] = useState(false);
  const [modal, setModal] = useState(false);
  const [editBrand, setEditBrand] = useState<Brand | null>(null);
  const [form, setForm] = useState({ name: '', synonyms: [] as string[] });
  const [synonymInput, setSynonymInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Після відновлення: синоніми, яких бренд не отримав назад (BR-GOOD-007) — банер, а не лише тост,
  // щоб перелік не зник за кілька секунд.
  const [skippedNotice, setSkippedNotice] = useState('');
  const {
    items: brands,
    loading,
    reload: load,
  } = useDeletableRefList<Brand>({
    url: '/brands?limit=200',
    urlWithDeleted: '/brands?limit=200&showDeleted=true',
    cacheKey: 'cache:brands',
    showDeleted,
    setError,
    loadErrorText: t('common.loadError'),
  });

  const openCreate = () => {
    setEditBrand(null);
    setForm({ name: '', synonyms: [] });
    setSynonymInput('');
    setError('');
    setModal(true);
  };
  const openEdit = (b: Brand) => {
    setEditBrand(b);
    setForm({ name: b.name, synonyms: b.synonyms ?? [] });
    setSynonymInput('');
    setError('');
    setModal(true);
  };

  // Будь-яка правка форми знімає текст попередньої помилки (напр. 409 «синонім уже зайнятий»):
  // інакше банер висів над уже виправленим полем до наступного «Зберегти».
  const addSynonym = () => {
    setForm(f => ({ ...f, synonyms: withSynonym(f.synonyms, synonymInput) }));
    setSynonymInput('');
    setError('');
  };

  const removeSynonym = (s: string) => {
    setForm(f => ({ ...f, synonyms: f.synonyms.filter(x => x !== s) }));
    setError('');
  };

  // `void` в onClick: обробник сам ловить помилку у catch і показує її користувачу
  // (банер setError / toast.error) — проміс більше нікому не потрібен.
  const save = async () => {
    if (!form.name.trim()) {
      setError(t('brands.nameRequired'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      // The text still sitting in the input counts too: saving right after typing, without
      // pressing "+" or Enter, used to drop it silently (owner report 2026-10-12).
      const payload = {
        name: form.name.trim(),
        synonyms: withSynonym(form.synonyms, synonymInput),
      };
      if (editBrand) {
        await apiFetch<Brand>(`/brands/${editBrand.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch<Brand>('/brands', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      setSynonymInput('');
      setModal(false);
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('common.saveError'));
    } finally {
      setSaving(false);
    }
  };

  // Відновлення повертає синоніми, яких бренд не отримав назад: їх уже має інший бренд (BR-GOOD-007).
  const noteSkipped = (restored: Brand) =>
    setSkippedNotice(
      restored.skippedSynonyms?.length
        ? t('brands.restoredSkippedSynonyms', {
            name: restored.name,
            synonyms: restored.skippedSynonyms.join(', '),
          })
        : '',
    );

  const {
    deletingId,
    restoringIds,
    remove: removeItem,
    restore: restoreItem,
  } = useRemoveRestore({
    basePath: '/brands',
    confirm,
    afterChange: load,
    setError,
    fallbackError: { remove: t('common.deleteError'), restore: t('common.restoreError') },
  });
  const remove = (id: string) =>
    removeItem(id, {
      title: t('brands.removeConfirmTitle'),
      message: t('brands.removeConfirmMessage'),
      variant: 'destructive',
    });
  const restore = (id: string) =>
    restoreItem<Brand>(id, { successToast: t('brands.restored'), onRestored: noteSkipped });

  const activeCount = brands.filter(b => !b.deletedAt).length;
  const deletedCount = brands.filter(b => !!b.deletedAt).length;

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-2">
      {!modal && error && (
        <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">
          {error}
        </div>
      )}
      {skippedNotice && (
        <div
          role="status"
          className="flex items-start justify-between gap-2 text-[13px] text-warning-text bg-warning-subtle border border-warning/20 rounded-lg px-4 py-2.5"
        >
          <span>{skippedNotice}</span>
          <button
            type="button"
            onClick={() => setSkippedNotice('')}
            aria-label={t('common:close')}
            className="shrink-0 hover:opacity-70"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      <div className="flex items-center justify-between gap-3 shrink-0">
        <p className="text-[13px] text-muted-foreground">{t('brands.description')}</p>
        <div className="flex items-center gap-2">
          <XlsxImportButton
            templateType="brands"
            importUrl="/xlsx/import/brands"
            onImportComplete={() => load()}
          />
          <Button
            variant="outline"
            size="icon-sm"
            title={showDeleted ? t('common.hideDeleted') : t('common.showDeleted')}
            onClick={() => setShowDeleted(d => !d)}
            className={cn(showDeleted && 'border-primary text-primary')}
          >
            {showDeleted ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </Button>
          <Button leftIcon={<Plus className="h-4 w-4" />} onClick={openCreate}>
            {t('brands.addButton')}
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 border border-border rounded-xl bg-surface overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('brands.colName')}</TableHead>
              <TableHead>{t('brands.colSynonyms')}</TableHead>
              <TableHead className="text-right">
                {activeCount > 0 && (
                  <span className="text-[12px] text-muted-foreground font-normal">
                    {t('brands.active', { count: activeCount })}
                    {deletedCount > 0 &&
                      !showDeleted &&
                      t('brands.archived', { count: deletedCount })}
                  </span>
                )}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (
              <TableRow>
                <TableCell colSpan={3} className="py-10 text-center">
                  <div className="flex justify-center">
                    <Spinner size="md" />
                  </div>
                </TableCell>
              </TableRow>
            )}
            {!loading && brands.length === 0 && (
              <TableRow>
                <TableCell colSpan={3} className="p-0">
                  <EmptyState
                    icon={Tag}
                    title={t('brands.emptyTitle')}
                    description={t('brands.emptyDescription')}
                  />
                </TableCell>
              </TableRow>
            )}
            {!loading &&
              brands.map(b => {
                const isDeleted = !!b.deletedAt;
                const synonyms = b.synonyms ?? [];
                const visibleSynonyms = synonyms.slice(0, 3);
                const extraCount = synonyms.length - visibleSynonyms.length;
                return (
                  <TableRow
                    key={b.id}
                    className={cn('group', isDeleted && 'opacity-60 bg-secondary/30')}
                  >
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            'font-medium',
                            isDeleted ? 'line-through text-muted-foreground' : 'text-foreground',
                          )}
                        >
                          {b.name}
                        </span>
                        {isDeleted && <Badge variant="secondary">{t('common.deleted')}</Badge>}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {visibleSynonyms.map(s => (
                          <Badge key={s} variant="secondary" className="text-[11px]">
                            {s}
                          </Badge>
                        ))}
                        {extraCount > 0 && (
                          <Badge variant="secondary" className="text-[11px] text-muted-foreground">
                            +{extraCount}
                          </Badge>
                        )}
                        {synonyms.length === 0 && (
                          <span className="text-[12px] text-muted-foreground">—</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {isDeleted ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            loading={restoringIds.has(b.id)}
                            disabled={restoringIds.has(b.id)}
                            onClick={() => void restore(b.id)}
                            className="text-success/70 hover:text-success hover:bg-success/10"
                            title={t('common.restore')}
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                          </Button>
                        ) : (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openEdit(b)}
                              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              loading={deletingId === b.id}
                              onClick={() => void remove(b.id)}
                              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                              title={t('common.markForDeletion')}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
          </TableBody>
        </Table>
      </div>

      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title={editBrand ? t('brands.editTitle') : t('brands.createTitle')}
        footer={
          <Button
            onClick={() => void save()}
            loading={saving}
            disabled={!form.name.trim()}
            className="w-full"
          >
            {t('brands.save')}
          </Button>
        }
      >
        {error && (
          <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">
            {error}
          </div>
        )}
        <div className="space-y-4">
          <Input
            label={t('brands.fieldName')}
            required
            value={form.name}
            onChange={e => {
              setForm(f => ({ ...f, name: e.target.value }));
              setError('');
            }}
            placeholder={t('brands.fieldNamePlaceholder')}
            autoFocus
            className="h-8 text-[13px]"
          />

          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1.5">
              {t('brands.synonyms')}{' '}
              <span className="text-muted-foreground font-normal">
                {t('brands.synonymsOptional')}
              </span>
            </label>
            <p className="text-[12px] text-muted-foreground mb-2">{t('brands.synonymsHint')}</p>

            {/* Existing synonym chips */}
            {form.synonyms.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {form.synonyms.map(s => (
                  <span
                    key={s}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-secondary text-[12px] text-foreground"
                  >
                    {s}
                    <button
                      type="button"
                      onClick={() => removeSynonym(s)}
                      className="text-muted-foreground hover:text-destructive transition-colors"
                      aria-label={t('brands.removeSynonym', { synonym: s })}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}

            {/* Add synonym input */}
            <div className="flex gap-2">
              <input
                type="text"
                value={synonymInput}
                onChange={e => {
                  setSynonymInput(e.target.value);
                  setError('');
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addSynonym();
                  }
                }}
                placeholder={t('brands.synonymPlaceholder')}
                className="flex-1 h-8 rounded-lg border border-border bg-transparent px-3 text-[13px] placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addSynonym}
                disabled={!synonymInput.trim()}
                className="shrink-0"
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </div>
      </Modal>
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
