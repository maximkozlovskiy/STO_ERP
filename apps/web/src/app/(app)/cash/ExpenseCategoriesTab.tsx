'use client';

import { useState } from 'react';
import { Plus, Pencil, Trash2, Tag } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState } from '@/components/ui/empty-state';
import { useConfirm } from '@/hooks/useConfirm';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toast } from '@/lib/toast';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import {
  useExpenseCategories,
  useCreateExpenseCategory,
  useUpdateExpenseCategory,
  useDeleteExpenseCategory,
  type ExpenseCategory,
} from '@/hooks/api/useExpenseCategories';

export default function ExpenseCategoriesTab() {
  const { confirm, dialogProps } = useConfirm();
  const { data: categories, isLoading } = useExpenseCategories();
  const createMut = useCreateExpenseCategory();
  const updateMut = useUpdateExpenseCategory();
  const deleteMut = useDeleteExpenseCategory();

  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<ExpenseCategory | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  const openCreate = () => {
    setEditing(null);
    setName('');
    setError('');
    setModal(true);
  };
  const openEdit = (c: ExpenseCategory) => {
    setEditing(c);
    setName(c.name);
    setError('');
    setModal(true);
  };

  const save = async () => {
    if (!name.trim()) {
      setError("Назва є обов'язковою");
      return;
    }
    try {
      if (editing) await updateMut.mutateAsync({ id: editing.id, name: name.trim() });
      else await createMut.mutateAsync(name.trim());
      setModal(false);
      toast.success('Збережено');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Помилка збереження');
    }
  };

  const remove = async (c: ExpenseCategory) => {
    if (
      !(await confirm({
        title: 'Видалити статтю витрат?',
        message: `Статтю «${c.name}» буде видалено.`,
        variant: 'destructive',
      }))
    )
      return;
    try {
      await deleteMut.mutateAsync(c.id);
      toast.success('Видалено');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка видалення');
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-2">
      <div className="flex items-center justify-between gap-3 shrink-0">
        <p className="text-[13px] text-muted-foreground">
          Статті витрат для касових видач (Оренда, Комунальні, Господарські тощо)
        </p>
        <Button leftIcon={<Plus className="h-4 w-4" />} onClick={openCreate}>
          Стаття
        </Button>
      </div>

      <div className="flex-1 min-h-0 border border-border rounded-xl bg-surface overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Назва статті</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={2} className="py-10 text-center">
                  <div className="flex justify-center">
                    <Spinner size="md" />
                  </div>
                </TableCell>
              </TableRow>
            )}
            {!isLoading && (categories?.length ?? 0) === 0 && (
              <TableRow>
                <TableCell colSpan={2} className="p-0">
                  <EmptyState icon={Tag} title="Статей немає" description="Додайте першу статтю" />
                </TableCell>
              </TableRow>
            )}
            {categories?.map(c => (
              <TableRow key={c.id} className="group">
                <TableCell className="font-medium">{c.name}</TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => openEdit(c)}
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void remove(c)}
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                      title="Видалити"
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
        title={editing ? 'Редагувати статтю' : 'Нова стаття витрат'}
        footer={
          <Button
            onClick={save}
            loading={createMut.isPending || updateMut.isPending}
            disabled={!name.trim()}
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
        <Input
          label="Назва статті"
          required
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="наприклад: Оренда"
          autoFocus
          className="h-8 text-[13px]"
        />
      </Modal>
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
