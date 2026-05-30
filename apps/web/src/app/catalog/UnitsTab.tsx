'use client';

import { useEffect, useState, useCallback } from 'react';
import { Plus, Trash2, Ruler } from 'lucide-react';
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
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Unit {
  id: string;
  name: string;
  shortName: string;
  isSystem: boolean;
  coefficient: number;
  width?: number | null;
  height?: number | null;
  depth?: number | null;
  volume?: number | null;
  weight?: number | null;
}

// ─── Units Tab ────────────────────────────────────────────────────────────────

export default function UnitsTab() {
  const { confirm, dialogProps } = useConfirm();
  const [units, setUnits] = useState<Unit[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({
    name: '',
    shortName: '',
    coefficient: '1',
    width: '',
    height: '',
    depth: '',
    volume: '',
    weight: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback((opts?: { fromCache?: boolean }) => {
    // Seed from cache for instant first-paint; пропускати кеш після mutations щоб
    // не показати STALE список між POST/DELETE та фінальним fetch.
    const fromCache = opts?.fromCache ?? false;
    const cached = fromCache ? getCached<Unit[]>('cache:units') : null;
    if (cached) {
      setUnits(cached);
      setLoading(false);
    } else setLoading(true);
    apiFetch<Unit[]>('/units')
      .then(d => {
        setUnits(d);
        setCache('cache:units', d);
      })
      .catch((e: unknown) => {
        if (!cached) setError(e instanceof Error ? e.message : 'Помилка завантаження');
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load({ fromCache: true });
  }, [load]);

  const create = async () => {
    if (!form.name.trim() || !form.shortName.trim()) {
      setError("Усі поля є обов'язковими");
      return;
    }
    setSaving(true);
    setError('');
    try {
      await apiFetch<Unit>('/units', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name.trim(),
          shortName: form.shortName.trim(),
          coefficient: form.coefficient ? Number(form.coefficient) : undefined,
          width: form.width ? Number(form.width) : undefined,
          height: form.height ? Number(form.height) : undefined,
          depth: form.depth ? Number(form.depth) : undefined,
          volume: form.volume ? Number(form.volume) : undefined,
          weight: form.weight ? Number(form.weight) : undefined,
        }),
      });
      setModal(false);
      setForm({
        name: '',
        shortName: '',
        coefficient: '1',
        width: '',
        height: '',
        depth: '',
        volume: '',
        weight: '',
      });
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    if (!(await confirm({ title: 'Видалити одиницю виміру?', variant: 'destructive' }))) return;
    try {
      await apiFetch<void>(`/units/${id}`, { method: 'DELETE' });
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Помилка видалення');
    }
  };

  return (
    <div>
      {!modal && error && (
        <div className="mb-4 text-[13px] text-destructive-text bg-destructive-subtle border border-destructive-border rounded-lg px-4 py-2.5">
          {error}
        </div>
      )}
      <div className="flex items-center justify-between gap-3 mb-4">
        <p className="text-[13px] text-muted-foreground">
          Одиниці виміру, що використовуються в каталозі товарів
        </p>
        <Button
          leftIcon={<Plus className="h-4 w-4" />}
          onClick={() => {
            setError('');
            setModal(true);
          }}
        >
          Одиниця
        </Button>
      </div>

      <div className="border border-border rounded-xl bg-surface overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Скорочення</TableHead>
              <TableHead>Назва</TableHead>
              <TableHead>Тип</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (
              <TableRow>
                <TableCell colSpan={4} className="py-10 text-center">
                  <div className="flex justify-center">
                    <Spinner size="md" />
                  </div>
                </TableCell>
              </TableRow>
            )}
            {!loading && units.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="p-0">
                  <EmptyState icon={Ruler} title="Одиниці відсутні" />
                </TableCell>
              </TableRow>
            )}
            {!loading &&
              units.map(u => (
                <TableRow key={u.id}>
                  <TableCell className="font-medium text-foreground">{u.shortName}</TableCell>
                  <TableCell className="text-muted-foreground">{u.name}</TableCell>
                  <TableCell>
                    {u.isSystem ? (
                      <span className="text-[11px] px-1.5 py-0.5 bg-info-subtle text-info rounded">
                        системна
                      </span>
                    ) : (
                      <span className="text-[11px] px-1.5 py-0.5 bg-secondary text-muted-foreground rounded">
                        власна
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {!u.isSystem && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => remove(u.id)}
                        className="text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </div>

      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title="Нова одиниця виміру"
        footer={
          <Button
            onClick={create}
            loading={saving}
            disabled={!form.name || !form.shortName}
            className="w-full"
          >
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
            label="Скорочення"
            required
            value={form.shortName}
            onChange={e => setForm(f => ({ ...f, shortName: e.target.value }))}
            placeholder="шт"
          />
          <Input
            label="Повна назва"
            required
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="штука"
          />
          <Input
            label="Коефіцієнт"
            type="number"
            value={form.coefficient}
            onChange={e => setForm(f => ({ ...f, coefficient: e.target.value }))}
            placeholder="1"
            hint="Коефіцієнт перерахунку до базової одиниці"
          />
          <div className="grid grid-cols-3 gap-2">
            <Input
              label="Ширина, м"
              type="number"
              value={form.width}
              onChange={e => setForm(f => ({ ...f, width: e.target.value }))}
              placeholder="0.0"
            />
            <Input
              label="Висота, м"
              type="number"
              value={form.height}
              onChange={e => setForm(f => ({ ...f, height: e.target.value }))}
              placeholder="0.0"
            />
            <Input
              label="Глибина, м"
              type="number"
              value={form.depth}
              onChange={e => setForm(f => ({ ...f, depth: e.target.value }))}
              placeholder="0.0"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Input
              label="Об'єм, м³"
              type="number"
              value={form.volume}
              onChange={e => setForm(f => ({ ...f, volume: e.target.value }))}
              placeholder="0.0"
            />
            <Input
              label="Вага, кг"
              type="number"
              value={form.weight}
              onChange={e => setForm(f => ({ ...f, weight: e.target.value }))}
              placeholder="0.0"
            />
          </div>
        </div>
      </Modal>
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
