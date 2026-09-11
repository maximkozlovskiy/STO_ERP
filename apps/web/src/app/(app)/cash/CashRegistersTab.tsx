'use client';

import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, Landmark } from 'lucide-react';
import { apiFetch } from '@/lib/api-client';
import { getCached, setCache } from '@/lib/ref-cache';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { useConfirm } from '@/hooks/useConfirm';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toast } from '@/lib/toast';
import { fmtMoney } from '@/lib/format';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import {
  useCashRegisters,
  useCreateCashRegister,
  useUpdateCashRegister,
  useDeleteCashRegister,
  type CashRegister,
} from '@/hooks/api/useCash';
import { type BranchInfo } from '../settings/shared';

interface CurrencyOpt {
  id: string;
  code: string;
}

export default function CashRegistersTab({ canManage = false }: { canManage?: boolean }) {
  const { confirm, dialogProps } = useConfirm();
  const { data: registers, isLoading } = useCashRegisters();
  const createMut = useCreateCashRegister();
  const updateMut = useUpdateCashRegister();
  const deleteMut = useDeleteCashRegister();

  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [currencies, setCurrencies] = useState<CurrencyOpt[]>([]);
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<CashRegister | null>(null);
  const [form, setForm] = useState({
    name: '',
    branchId: '',
    currencyId: '',
    isFiscal: false,
    initialBalance: '0',
  });
  const [error, setError] = useState('');

  useEffect(() => {
    const cb = getCached<BranchInfo[]>('cache:branches');
    if (cb?.length) setBranches(cb);
    apiFetch<{ items: BranchInfo[] } | BranchInfo[]>('/branches')
      .then(d => {
        const arr = Array.isArray(d) ? d : d.items;
        setBranches(arr);
        setCache('cache:branches', arr);
      })
      .catch(() => undefined);
    apiFetch<{ items: CurrencyOpt[] } | CurrencyOpt[]>('/currencies')
      .then(d => setCurrencies(Array.isArray(d) ? d : d.items))
      .catch(() => undefined);
  }, []);

  const openCreate = () => {
    setEditing(null);
    setForm({
      name: '',
      branchId: branches[0]?.id ?? '',
      currencyId: currencies[0]?.id ?? '',
      isFiscal: false,
      initialBalance: '0',
    });
    setError('');
    setModal(true);
  };

  const openEdit = (r: CashRegister) => {
    setEditing(r);
    setForm({
      name: r.name,
      branchId: r.branchId,
      currencyId: r.currencyId,
      isFiscal: r.isFiscal,
      initialBalance: String(r.initialBalance),
    });
    setError('');
    setModal(true);
  };

  const save = async () => {
    if (!form.name.trim()) {
      setError("Назва є обов'язковою");
      return;
    }
    try {
      if (editing) {
        await updateMut.mutateAsync({
          id: editing.id,
          name: form.name.trim(),
          isFiscal: form.isFiscal,
          initialBalance: Number(form.initialBalance) || 0,
        });
      } else {
        await createMut.mutateAsync({
          name: form.name.trim(),
          branchId: form.branchId,
          currencyId: form.currencyId,
          isFiscal: form.isFiscal,
          initialBalance: Number(form.initialBalance) || 0,
        });
      }
      setModal(false);
      toast.success('Збережено');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Помилка збереження');
    }
  };

  const remove = async (r: CashRegister) => {
    if (
      !(await confirm({
        title: 'Видалити касу?',
        message: `Касу «${r.name}» буде видалено. Історія операцій залишиться.`,
        variant: 'destructive',
      }))
    )
      return;
    try {
      await deleteMut.mutateAsync(r.id);
      toast.success('Касу видалено');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка видалення');
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-2">
      <div className="flex items-center justify-between gap-3 shrink-0">
        <p className="text-[13px] text-muted-foreground">
          Каси організації. Фіскальна каса вимагає відкриту зміну для операцій з готівкою.
        </p>
        {canManage && (
          <Button leftIcon={<Plus className="h-4 w-4" />} onClick={openCreate}>
            Каса
          </Button>
        )}
      </div>

      <div className="flex-1 min-h-0 border border-border rounded-xl bg-surface overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Назва</TableHead>
              <TableHead>Філія</TableHead>
              <TableHead>Тип</TableHead>
              <TableHead className="text-right">Залишок</TableHead>
              {canManage && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={canManage ? 5 : 4} className="py-10 text-center">
                  <div className="flex justify-center">
                    <Spinner size="md" />
                  </div>
                </TableCell>
              </TableRow>
            )}
            {!isLoading && (registers?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={canManage ? 5 : 4} className="p-0">
                  <EmptyState icon={Landmark} title="Кас немає" description="Додайте першу касу" />
                </TableCell>
              </TableRow>
            )}
            {registers?.map(r => (
              <TableRow key={r.id} className="group">
                <TableCell className="font-medium">{r.name}</TableCell>
                <TableCell className="text-[13px] text-muted-foreground">{r.branchName}</TableCell>
                <TableCell>
                  {r.isFiscal ? (
                    <Badge variant="warning">Фіскальна</Badge>
                  ) : (
                    <Badge variant="secondary">Звичайна</Badge>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums font-semibold">
                  {fmtMoney(r.balance)} {r.currencySymbol ?? r.currencyCode}
                </TableCell>
                {canManage && (
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEdit(r)}
                        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void remove(r)}
                        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                        title="Видалити"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title={editing ? 'Редагувати касу' : 'Нова каса'}
        footer={
          <Button
            onClick={save}
            loading={createMut.isPending || updateMut.isPending}
            disabled={!form.name.trim()}
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
            label="Назва каси"
            required
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="наприклад: Головна каса"
            autoFocus
            className="h-8 text-[13px]"
          />
          {!editing && (
            <>
              <Select
                label="Філія"
                value={form.branchId}
                onChange={e => setForm(f => ({ ...f, branchId: e.target.value }))}
              >
                {branches.map(b => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
              <Select
                label="Валюта"
                value={form.currencyId}
                onChange={e => setForm(f => ({ ...f, currencyId: e.target.value }))}
              >
                {currencies.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.code}
                  </option>
                ))}
              </Select>
            </>
          )}
          <Input
            label="Стартовий залишок"
            type="number"
            value={form.initialBalance}
            onChange={e => setForm(f => ({ ...f, initialBalance: e.target.value }))}
            className="h-8 text-[13px]"
          />
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={form.isFiscal}
              onChange={e => setForm(f => ({ ...f, isFiscal: e.target.checked }))}
              className="h-4 w-4 rounded border-border accent-primary"
            />
            <span className="text-sm text-foreground">Фіскальна каса (ПРРО, вимагає зміну)</span>
          </label>
        </div>
      </Modal>
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
