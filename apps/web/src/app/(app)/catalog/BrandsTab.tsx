'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Plus, Pencil, Trash2, Tag, Eye, EyeOff, RotateCcw, X } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { getCached, setCache } from '@/lib/ref-cache';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { useConfirm } from '@/hooks/useConfirm';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toast } from '@/lib/toast';
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
}

// ─── Brands Tab ───────────────────────────────────────────────────────────────

export default function BrandsTab() {
  const { confirm, dialogProps } = useConfirm();
  const [brands, setBrands] = useState<Brand[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDeleted, setShowDeleted] = useState(false);
  const [modal, setModal] = useState(false);
  const [editBrand, setEditBrand] = useState<Brand | null>(null);
  const [form, setForm] = useState({ name: '', synonyms: [] as string[] });
  const [synonymInput, setSynonymInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [restoringIds, setRestoringIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  // Bug #307: race-guard для swiftest showDeleted toggles — outdated response відкидається.
  const loadReqRef = useRef(0);

  const load = useCallback(
    (opts?: { fromCache?: boolean; withDeleted?: boolean }) => {
      const fromCache = opts?.fromCache ?? false;
      const withDeleted = opts?.withDeleted ?? showDeleted;
      const cached = fromCache && !withDeleted ? getCached<Brand[]>('cache:brands') : null;
      if (cached) {
        setBrands(cached);
        setLoading(false);
      } else setLoading(true);
      const url = withDeleted ? '/brands?limit=200&showDeleted=true' : '/brands?limit=200';
      const reqId = ++loadReqRef.current;
      apiFetch<{ items: Brand[]; total: number }>(url)
        .then(r => {
          if (loadReqRef.current !== reqId) return;
          setBrands(r.items);
          if (!withDeleted) setCache('cache:brands', r.items);
        })
        .catch((e: unknown) => {
          if (loadReqRef.current !== reqId) return;
          if (!cached) setError(e instanceof Error ? e.message : 'Помилка завантаження');
        })
        .finally(() => {
          if (loadReqRef.current === reqId) setLoading(false);
        });
    },
    [showDeleted],
  );

  useEffect(() => {
    load({ fromCache: !showDeleted });
  }, [load, showDeleted]);

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

  const addSynonym = () => {
    const val = synonymInput.trim();
    if (!val) return;
    const lower = val.toLowerCase();
    if (form.synonyms.some(s => s.toLowerCase() === lower)) {
      setSynonymInput('');
      return;
    }
    setForm(f => ({ ...f, synonyms: [...f.synonyms, val] }));
    setSynonymInput('');
  };

  const removeSynonym = (s: string) => {
    setForm(f => ({ ...f, synonyms: f.synonyms.filter(x => x !== s) }));
  };

  const save = async () => {
    if (!form.name.trim()) {
      setError("Назва є обов'язковою");
      return;
    }
    setSaving(true);
    setError('');
    try {
      const payload = { name: form.name.trim(), synonyms: form.synonyms };
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
      setModal(false);
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка збереження');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    if (
      !(await confirm({
        title: 'Помітити бренд на видалення?',
        message: 'Товари з цим брендом не будуть видалені. Можна відновити.',
        variant: 'destructive',
      }))
    )
      return;
    setDeletingId(id);
    try {
      await apiFetch<void>(`/brands/${id}`, { method: 'DELETE' });
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка видалення');
    } finally {
      setDeletingId(null);
    }
  };

  const restore = async (id: string) => {
    // Bug #308: in-flight guard — повторні кліки на restore призводили б до 2..N паралельних
    // POST; перший update встановлює deletedAt=null, наступні updateMany повертають count=0 →
    // NotFoundException → false-error у UI. Також ловимо stale error перед action.
    if (restoringIds.has(id)) return;
    setError('');
    setRestoringIds(prev => new Set(prev).add(id));
    try {
      await apiFetch<Brand>(`/brands/${id}/restore`, { method: 'POST' });
      load();
      toast.success('Бренд відновлено');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка відновлення');
    } finally {
      setRestoringIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const activeCount = brands.filter(b => !b.deletedAt).length;
  const deletedCount = brands.filter(b => !!b.deletedAt).length;

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-2">
      {!modal && error && (
        <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">
          {error}
        </div>
      )}
      <div className="flex items-center justify-between gap-3 shrink-0">
        <p className="text-[13px] text-muted-foreground">Бренди та виробники запчастин і товарів</p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon-sm"
            title={showDeleted ? 'Сховати видалені' : 'Показати видалені'}
            onClick={() => setShowDeleted(d => !d)}
            className={cn(showDeleted && 'border-primary text-primary')}
          >
            {showDeleted ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </Button>
          <Button leftIcon={<Plus className="h-4 w-4" />} onClick={openCreate}>
            Бренд
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 border border-border rounded-xl bg-surface overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Назва бренду</TableHead>
              <TableHead>Синоніми</TableHead>
              <TableHead className="text-right">
                {activeCount > 0 && (
                  <span className="text-[12px] text-muted-foreground font-normal">
                    {activeCount} активних
                    {deletedCount > 0 && !showDeleted && ` · ${deletedCount} архів`}
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
                    title="Бренди відсутні"
                    description="Додайте перший бренд"
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
                        {isDeleted && <Badge variant="secondary">видалено</Badge>}
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
                            title="Відновити"
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
                              title="Помітити на видалення"
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
        title={editBrand ? 'Редагувати бренд' : 'Новий бренд'}
        footer={
          <Button onClick={save} loading={saving} disabled={!form.name.trim()} className="w-full">
            Зберегти
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
            label="Назва бренду"
            required
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="наприклад: Bosch, NGK, Brembo"
            autoFocus
            className="h-8 text-[13px]"
          />

          <div>
            <label className="block text-[13px] font-medium text-foreground mb-1.5">
              Синоніми <span className="text-muted-foreground font-normal">(необов'язково)</span>
            </label>
            <p className="text-[12px] text-muted-foreground mb-2">
              Альтернативні написання бренду від різних постачальників (Bosh, БОШ, BOSCH)
            </p>

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
                      aria-label={`Видалити синонім ${s}`}
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
                onChange={e => setSynonymInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addSynonym();
                  }
                }}
                placeholder="Введіть синонім і натисніть Enter або +"
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
