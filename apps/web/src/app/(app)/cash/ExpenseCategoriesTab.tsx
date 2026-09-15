'use client';

import { useState } from 'react';
import {
  Plus,
  Pencil,
  Trash2,
  Tag,
  ChevronRight,
  ChevronDown,
  EyeOff,
  Eye,
  RotateCcw,
} from 'lucide-react';
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
  useExpenseCategories,
  useCreateExpenseCategory,
  useUpdateExpenseCategory,
  useDeleteExpenseCategory,
  useToggleExpenseCategoryActive,
  useRestoreExpenseCategory,
  EXPENSE_CATEGORY_TYPE_LABELS,
  type ExpenseCategory,
  type ExpenseCategoryType,
} from '@/hooks/api/useExpenseCategories';

const MAX_DEPTH = 2; // 3 рівні (0..2), як category-manager-modal

function CategoryNode({
  node,
  depth,
  canManage,
  restoringId,
  onAddChild,
  onEdit,
  onDelete,
  onToggle,
  onRestore,
}: {
  node: ExpenseCategory;
  depth: number;
  canManage: boolean;
  restoringId: string | null;
  onAddChild: (parent: ExpenseCategory) => void;
  onEdit: (c: ExpenseCategory) => void;
  onDelete: (c: ExpenseCategory) => void;
  onToggle: (c: ExpenseCategory) => void;
  onRestore: (c: ExpenseCategory) => void;
}) {
  const [open, setOpen] = useState(true);
  const hasChildren = node.children.length > 0;
  const isDeleted = !!node.deletedAt;
  return (
    <div>
      <div
        className={cn(
          'group flex items-center gap-1.5 py-1.5 pr-2 hover:bg-secondary/40 rounded',
          isDeleted && 'opacity-60',
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {hasChildren ? (
          <button
            onClick={() => setOpen(o => !o)}
            className="text-muted-foreground hover:text-foreground shrink-0"
            aria-label={open ? 'Згорнути' : 'Розгорнути'}
          >
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <span
          className={cn(
            'text-[13px] flex-1 min-w-0 truncate',
            node.isActive ? 'font-medium text-foreground' : 'text-muted-foreground line-through',
          )}
        >
          {node.name}
        </span>
        {isDeleted && <Badge variant="secondary">видалено</Badge>}
        {canManage && (
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 shrink-0">
            {isDeleted ? (
              <Button
                variant="ghost"
                size="icon-sm"
                loading={restoringId === node.id}
                disabled={restoringId === node.id}
                onClick={() => onRestore(node)}
                title="Відновити"
                className="text-success/70 hover:text-success hover:bg-success/10"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            ) : (
              <>
                {depth < MAX_DEPTH && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => onAddChild(node)}
                    title="Додати підстаттю"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => onEdit(node)}
                  title="Перейменувати"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => onToggle(node)}
                  title={node.isActive ? 'Вимкнути' : 'Увімкнути'}
                >
                  {node.isActive ? (
                    <EyeOff className="h-3.5 w-3.5" />
                  ) : (
                    <Eye className="h-3.5 w-3.5" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => onDelete(node)}
                  title="Видалити"
                  className="text-destructive/70 hover:text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </>
            )}
          </div>
        )}
      </div>
      {open &&
        node.children.map(child => (
          <CategoryNode
            key={child.id}
            node={child}
            depth={depth + 1}
            canManage={canManage}
            restoringId={restoringId}
            onAddChild={onAddChild}
            onEdit={onEdit}
            onDelete={onDelete}
            onToggle={onToggle}
            onRestore={onRestore}
          />
        ))}
    </div>
  );
}

export default function ExpenseCategoriesTab({ canManage = false }: { canManage?: boolean }) {
  const { confirm, dialogProps } = useConfirm();
  const [showDeleted, setShowDeleted] = useState(false);
  const { data: categories, isLoading } = useExpenseCategories(showDeleted);
  const createMut = useCreateExpenseCategory();
  const updateMut = useUpdateExpenseCategory();
  const deleteMut = useDeleteExpenseCategory();
  const toggleMut = useToggleExpenseCategoryActive();
  const restoreMut = useRestoreExpenseCategory();
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState<ExpenseCategory | null>(null);
  // Контекст створення: тип нового кореня, або батько для підстатті.
  const [newType, setNewType] = useState<ExpenseCategoryType>('EXPENSE');
  const [parent, setParent] = useState<ExpenseCategory | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  const roots = categories ?? [];
  const expenseRoots = roots.filter(c => c.type === 'EXPENSE');
  const incomeRoots = roots.filter(c => c.type === 'INCOME');

  const openCreateRoot = (type: ExpenseCategoryType) => {
    setEditing(null);
    setParent(null);
    setNewType(type);
    setName('');
    setError('');
    setModal(true);
  };
  const openAddChild = (p: ExpenseCategory) => {
    setEditing(null);
    setParent(p);
    setNewType(p.type); // дитина успадковує тип
    setName('');
    setError('');
    setModal(true);
  };
  const openEdit = (c: ExpenseCategory) => {
    setEditing(c);
    setParent(null);
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
      if (editing) {
        await updateMut.mutateAsync({ id: editing.id, name: name.trim() });
      } else {
        await createMut.mutateAsync({
          name: name.trim(),
          type: newType,
          parentId: parent?.id,
        });
      }
      setModal(false);
      toast.success('Збережено');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Помилка збереження');
    }
  };

  const remove = async (c: ExpenseCategory) => {
    if (
      !(await confirm({
        title: 'Видалити статтю?',
        message: `Статтю «${c.name}»${c.children.length ? ' та її підстатті' : ''} буде видалено.`,
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

  const toggle = async (c: ExpenseCategory) => {
    try {
      await toggleMut.mutateAsync({ id: c.id, isActive: !c.isActive });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка');
    }
  };

  const restore = async (c: ExpenseCategory) => {
    // in-flight guard: duplicate POSTs → 2nd+ returns 404 → false-error in UI.
    if (restoringId === c.id) return;
    setRestoringId(c.id);
    try {
      await restoreMut.mutateAsync(c.id);
      toast.success('Статтю відновлено');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Помилка відновлення');
    } finally {
      setRestoringId(null);
    }
  };

  const renderSection = (title: string, type: ExpenseCategoryType, nodes: ExpenseCategory[]) => (
    <div className="border border-border rounded-xl bg-surface overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border bg-secondary/30">
        <div className="flex items-center gap-2">
          <Badge variant={type === 'EXPENSE' ? 'warning' : 'success'}>{title}</Badge>
          <span className="text-[12px] text-muted-foreground">{nodes.length} кор.</span>
        </div>
        {canManage && (
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<Plus className="h-3.5 w-3.5" />}
            onClick={() => openCreateRoot(type)}
          >
            Стаття
          </Button>
        )}
      </div>
      <div className="p-1.5">
        {nodes.length === 0 ? (
          <p className="text-[12px] text-muted-foreground px-2 py-3">Статей немає</p>
        ) : (
          nodes.map(n => (
            <CategoryNode
              key={n.id}
              node={n}
              depth={0}
              canManage={canManage}
              restoringId={restoringId}
              onAddChild={openAddChild}
              onEdit={openEdit}
              onDelete={remove}
              onToggle={toggle}
              onRestore={restore}
            />
          ))
        )}
      </div>
    </div>
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3 overflow-auto">
      <div className="flex items-center justify-between gap-3 shrink-0">
        <p className="text-[13px] text-muted-foreground">
          Статті руху коштів для касових операцій. Витрати (для видач) та оприбуткування (для
          внесень), ієрархічні — з підстаттями.
        </p>
        {canManage && (
          <Button
            variant="outline"
            size="icon-sm"
            title={showDeleted ? 'Сховати видалені' : 'Показати видалені'}
            onClick={() => setShowDeleted(d => !d)}
            className={cn(showDeleted && 'border-primary text-primary', 'shrink-0')}
          >
            {showDeleted ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner size="md" />
        </div>
      ) : roots.length === 0 && !canManage ? (
        <EmptyState icon={Tag} title="Статей немає" description="Довідник порожній" />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {renderSection('Витрати', 'EXPENSE', expenseRoots)}
          {renderSection('Оприбуткування', 'INCOME', incomeRoots)}
        </div>
      )}

      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title={
          editing
            ? 'Перейменувати статтю'
            : parent
              ? `Підстаття до «${parent.name}»`
              : `Нова стаття · ${EXPENSE_CATEGORY_TYPE_LABELS[newType]}`
        }
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
        <div className="space-y-3">
          {!editing && (
            <p className="text-[12px] text-muted-foreground">
              Тип: <b>{EXPENSE_CATEGORY_TYPE_LABELS[newType]}</b>
              {parent ? ' (успадковано від батька)' : ''}
            </p>
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
        </div>
      </Modal>
      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
