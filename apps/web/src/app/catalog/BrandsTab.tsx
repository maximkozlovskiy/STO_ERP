'use client';

import { useEffect, useState, useCallback } from 'react';
import { Plus, Pencil, Trash2, Tag } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { getCached, setCache } from '@/lib/ref-cache';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useConfirm } from '@/hooks/useConfirm';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Brand { id: string; name: string; }

// ─── Brands Tab ───────────────────────────────────────────────────────────────

export default function BrandsTab() {
  const { confirm, dialogProps } = useConfirm();
  const [brands, setBrands] = useState<Brand[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [editBrand, setEditBrand] = useState<Brand | null>(null);
  const [form, setForm] = useState({ name: '' });
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback((opts?: { fromCache?: boolean }) => {
    // Seed from cache for instant first-paint; пропускати кеш після mutations щоб
    // не показати STALE список між POST/DELETE та фінальним fetch.
    const fromCache = opts?.fromCache ?? false;
    const cached = fromCache ? getCached<Brand[]>('cache:brands') : null;
    if (cached) { setBrands(cached); setLoading(false); }
    else setLoading(true);
    apiFetch<{ items: Brand[]; total: number }>('/brands?limit=200')
      .then(r => { setBrands(r.items); setCache('cache:brands', r.items); })
      .catch((e: unknown) => { if (!cached) setError(e instanceof Error ? e.message : 'Помилка завантаження'); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load({ fromCache: true }); }, [load]);

  const openCreate = () => { setEditBrand(null); setForm({ name: '' }); setError(''); setModal(true); };
  const openEdit = (b: Brand) => { setEditBrand(b); setForm({ name: b.name }); setError(''); setModal(true); };

  const save = async () => {
    if (!form.name.trim()) { setError('Назва є обов\'язковою'); return; }
    setSaving(true); setError('');
    try {
      if (editBrand) {
        await apiFetch<Brand>(`/brands/${editBrand.id}`, { method: 'PATCH', body: JSON.stringify({ name: form.name.trim() }) });
      } else {
        await apiFetch<Brand>('/brands', { method: 'POST', body: JSON.stringify({ name: form.name.trim() }) });
      }
      setModal(false);
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка збереження'); }
    finally { setSaving(false); }
  };

  const remove = async (id: string) => {
    if (!(await confirm({ title: 'Видалити бренд?', message: 'Товари з цим брендом не будуть видалені.', variant: 'destructive' }))) return;
    setDeletingId(id);
    try {
      await apiFetch<void>(`/brands/${id}`, { method: 'DELETE' });
      load();
    } catch (e: unknown) { setError(e instanceof Error ? e.message : 'Помилка видалення'); }
    finally { setDeletingId(null); }
  };

  return (
    <div>
      {!modal && error && (
        <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">{error}</div>
      )}
      <div className="flex items-center justify-between gap-3 mb-4">
        <p className="text-[13px] text-muted-foreground">Бренди та виробники запчастин і товарів</p>
        <Button leftIcon={<Plus className="h-4 w-4" />} onClick={openCreate}>
          Бренд
        </Button>
      </div>

      <div className="border border-border rounded-xl bg-surface overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Назва бренду</TableHead>
              <TableHead className="text-right">Дії</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (
              <TableRow>
                <TableCell colSpan={2} className="py-10 text-center">
                  <div className="flex justify-center"><Spinner size="md" /></div>
                </TableCell>
              </TableRow>
            )}
            {!loading && brands.length === 0 && (
              <TableRow>
                <TableCell colSpan={2} className="p-0">
                  <EmptyState icon={Tag} title="Бренди відсутні" description="Додайте перший бренд" />
                </TableCell>
              </TableRow>
            )}
            {!loading && brands.map(b => (
              <TableRow key={b.id}>
                <TableCell className="font-medium text-foreground">{b.name}</TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    <Button variant="ghost" size="sm" onClick={() => openEdit(b)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={deletingId === b.id}
                      onClick={() => remove(b.id)}
                      className="text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
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
          <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-3 py-2">{error}</div>
        )}
        <Input
          label="Назва бренду"
          required
          value={form.name}
          onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
          placeholder="наприклад: Bosch, NGK, Brembo"
          autoFocus
        />
      </Modal>
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
