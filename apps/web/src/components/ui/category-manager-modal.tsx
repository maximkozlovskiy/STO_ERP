'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { ChevronRight, ChevronDown, Plus, Pencil, Trash2, RotateCcw } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiFetch } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useUiFeatures } from '@/hooks/useUiFeatures';
import type { CategoryNode } from '@/components/ui/category-tree';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CategoryManagerModalProps {
  open: boolean;
  onClose: () => void;
  /** 'work' | 'good' */
  type: 'work' | 'good';
  /** Повне дерево з API */
  tree: CategoryNode[];
  onChanged: () => void;
}

// ─── ManagerNode (рядок дерева) ───────────────────────────────────────────────

function ManagerNode({
  node,
  depth,
  type,
  onChanged,
  onToggleActive,
  saving,
  setSaving,
}: {
  node: CategoryNode;
  depth: number;
  type: 'work' | 'good';
  onChanged: () => void;
  onToggleActive: (id: string, isActive: boolean) => Promise<void>;
  saving: string | null;
  setSaving: (id: string | null) => void;
}) {
  const features = useUiFeatures();
  const [expanded, setExpanded] = useState(depth < 1);
  const [editMode, setEditMode] = useState(false);
  const [editName, setEditName] = useState(node.name);
  const [addMode, setAddMode] = useState(false);
  const [newName, setNewName] = useState('');
  const hasChildren = node.children.length > 0;
  const endpoint = type === 'work' ? '/work-categories' : '/good-categories';

  const handleRename = useCallback(async () => {
    if (!editName.trim() || editName === node.name) {
      setEditMode(false);
      return;
    }
    setSaving(node.id);
    try {
      await apiFetch(`${endpoint}/${node.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: editName.trim() }),
      });
      if (features.toastEnabled) toast.success('Категорію перейменовано');
      onChanged();
    } catch (e) {
      if (features.toastEnabled) toast.error(e instanceof Error ? e.message : 'Помилка');
      setEditName(node.name);
    } finally {
      setSaving(null);
      setEditMode(false);
    }
  }, [editName, node.id, node.name, endpoint, features.toastEnabled, onChanged, setSaving]);

  const handleAddChild = useCallback(async () => {
    if (!newName.trim()) {
      setAddMode(false);
      return;
    }
    setSaving(node.id + '-add');
    try {
      await apiFetch(endpoint, {
        method: 'POST',
        body: JSON.stringify({ name: newName.trim(), parentId: node.id }),
      });
      if (features.toastEnabled) toast.success('Категорію додано');
      setNewName('');
      setAddMode(false);
      setExpanded(true);
      onChanged();
    } catch (e) {
      if (features.toastEnabled) toast.error(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setSaving(null);
    }
  }, [newName, node.id, endpoint, features.toastEnabled, onChanged, setSaving]);

  const handleDelete = useCallback(async () => {
    if (!window.confirm(`Видалити "${node.name}"? Товари/роботи стануть без категорії.`)) return;
    setSaving(node.id + '-del');
    try {
      await apiFetch(`${endpoint}/${node.id}`, { method: 'DELETE' });
      if (features.toastEnabled) toast.success('Категорію видалено');
      onChanged();
    } catch (e) {
      if (features.toastEnabled) toast.error(e instanceof Error ? e.message : 'Помилка');
      setSaving(null);
    }
  }, [node.id, node.name, endpoint, features.toastEnabled, onChanged, setSaving]);

  const isSavingThis =
    saving === node.id || saving === node.id + '-add' || saving === node.id + '-del';

  return (
    <li>
      <div
        className={cn(
          'group flex items-center gap-1 rounded-md px-2 py-1 text-[13px] transition-colors hover:bg-secondary',
          node.isActive === false && 'opacity-50',
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {/* Expand toggle */}
        <button
          type="button"
          className="shrink-0 w-3.5 h-3.5 flex items-center justify-center text-muted-foreground"
          onClick={() => setExpanded(p => !p)}
          tabIndex={hasChildren ? 0 : -1}
        >
          {hasChildren ? (
            expanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )
          ) : null}
        </button>

        {/* Toggle active checkbox */}
        <input
          type="checkbox"
          checked={node.isActive !== false}
          title={node.isActive !== false ? 'Вимкнути категорію' : 'Увімкнути категорію'}
          disabled={isSavingThis}
          onChange={e => void onToggleActive(node.id, e.target.checked)}
          className="shrink-0 h-3.5 w-3.5 rounded border-border cursor-pointer"
        />

        {/* Name / edit input */}
        {editMode ? (
          <input
            autoFocus
            value={editName}
            onChange={e => setEditName(e.target.value)}
            onBlur={() => void handleRename()}
            onKeyDown={e => {
              if (e.key === 'Enter') void handleRename();
              if (e.key === 'Escape') {
                setEditMode(false);
                setEditName(node.name);
              }
            }}
            className="flex-1 min-w-0 bg-transparent border-b border-primary text-[13px] outline-none"
          />
        ) : (
          <span className="flex-1 min-w-0 truncate">{node.name}</span>
        )}

        {/* System badge */}
        {node.isSystem && (
          <span className="shrink-0 text-[10px] text-muted-foreground bg-muted px-1 rounded">
            системна
          </span>
        )}

        {/* Actions */}
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 shrink-0">
          {!node.isSystem && (
            <Button
              variant="ghost"
              size="icon-sm"
              title="Перейменувати"
              disabled={isSavingThis}
              onClick={() => setEditMode(true)}
              className="h-5 w-5"
            >
              <Pencil className="h-3 w-3" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            title="Додати підкатегорію"
            disabled={isSavingThis || depth >= 2}
            onClick={() => {
              setAddMode(p => !p);
              setExpanded(true);
            }}
            className="h-5 w-5"
          >
            <Plus className="h-3 w-3" />
          </Button>
          {!node.isSystem && (
            <Button
              variant="ghost"
              size="icon-sm"
              title="Видалити"
              disabled={isSavingThis}
              onClick={() => void handleDelete()}
              className="h-5 w-5 text-destructive/70 hover:text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>

      {/* Add child input */}
      {addMode && (
        <div
          className="flex items-center gap-2 px-3 py-1"
          style={{ paddingLeft: `${(depth + 1) * 16 + 8 + 16}px` }}
        >
          <input
            autoFocus
            placeholder="Назва нової категорії..."
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') void handleAddChild();
              if (e.key === 'Escape') {
                setAddMode(false);
                setNewName('');
              }
            }}
            className="flex-1 text-[13px] bg-transparent border-b border-primary outline-none py-0.5"
          />
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void handleAddChild()}
            disabled={saving === node.id + '-add'}
            className="h-5 w-5"
          >
            <Plus className="h-3 w-3" />
          </Button>
        </div>
      )}

      {/* Children */}
      {hasChildren && expanded && (
        <ul>
          {node.children.map(child => (
            <ManagerNode
              key={child.id}
              node={child}
              depth={depth + 1}
              type={type}
              onChanged={onChanged}
              onToggleActive={onToggleActive}
              saving={saving}
              setSaving={setSaving}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// ─── CategoryManagerModal ─────────────────────────────────────────────────────

export function CategoryManagerModal({
  open,
  onClose,
  type,
  tree,
  onChanged,
}: CategoryManagerModalProps) {
  const features = useUiFeatures();
  const [newRootName, setNewRootName] = useState('');
  const [saving, setSaving] = useState<string | null>(null);
  const endpoint = type === 'work' ? '/work-categories' : '/good-categories';
  const label = type === 'work' ? 'Категорії робіт' : 'Категорії товарів';

  const handleToggleActive = useCallback(
    async (id: string, isActive: boolean) => {
      setSaving(id + '-toggle');
      try {
        await apiFetch(`${endpoint}/${id}/toggle-active`, {
          method: 'PATCH',
          body: JSON.stringify({ isActive }),
        });
        if (features.toastEnabled)
          toast.success(isActive ? 'Категорію увімкнено' : 'Категорію вимкнено');
        onChanged();
      } catch (e) {
        if (features.toastEnabled) toast.error(e instanceof Error ? e.message : 'Помилка');
      } finally {
        setSaving(null);
      }
    },
    [endpoint, features.toastEnabled, onChanged],
  );

  const handleAddRoot = useCallback(async () => {
    if (!newRootName.trim()) return;
    setSaving('root-add');
    try {
      await apiFetch(endpoint, {
        method: 'POST',
        body: JSON.stringify({ name: newRootName.trim() }),
      });
      if (features.toastEnabled) toast.success('Категорію створено');
      setNewRootName('');
      onChanged();
    } catch (e) {
      if (features.toastEnabled) toast.error(e instanceof Error ? e.message : 'Помилка');
    } finally {
      setSaving(null);
    }
  }, [newRootName, endpoint, features.toastEnabled, onChanged]);

  return (
    <Modal open={open} onClose={onClose} title={`Управління — ${label}`} size="lg">
      <div className="flex flex-col gap-4">
        {/* Add root category */}
        <div className="flex items-center gap-2">
          <Input
            placeholder="Нова коренева категорія..."
            value={newRootName}
            onChange={e => setNewRootName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') void handleAddRoot();
            }}
            className="flex-1"
          />
          <Button
            onClick={() => void handleAddRoot()}
            disabled={!newRootName.trim() || saving === 'root-add'}
            loading={saving === 'root-add'}
            size="sm"
          >
            <Plus className="h-4 w-4 mr-1" />
            Додати
          </Button>
        </div>

        {/* Legend */}
        <p className="text-[12px] text-muted-foreground">
          Чекбокс — увімк./вимкн. категорію. Системні категорії не можна видалити або перейменувати.
        </p>

        {/* Tree */}
        <div className="max-h-[60vh] overflow-y-auto rounded-lg border border-border">
          {tree.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Категорій не знайдено</p>
          ) : (
            <ul className="py-1">
              {tree.map(node => (
                <ManagerNode
                  key={node.id}
                  node={node}
                  depth={0}
                  type={type}
                  onChanged={onChanged}
                  onToggleActive={handleToggleActive}
                  saving={saving}
                  setSaving={setSaving}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
