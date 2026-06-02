'use client';

import { useState, useCallback } from 'react';
import type { MouseEvent } from 'react';
import { ChevronRight, ChevronDown, Settings2, X, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CategoryNode {
  id: string;
  name: string;
  code?: string | null;
  isSystem?: boolean;
  isActive?: boolean;
  sortOrder?: number;
  children: CategoryNode[];
}

export interface CategoryTreeProps {
  tree: CategoryNode[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onManage?: () => void;
  label: string;
  /** IDs категорій що підсвічуються як "пов'язані" */
  highlightedIds?: Set<string>;
  className?: string;
}

// ─── TreeNode (рекурсивний вузол) ─────────────────────────────────────────────

function TreeNode({
  node,
  selectedId,
  onSelect,
  highlightedIds,
  depth,
  defaultExpanded,
}: {
  node: CategoryNode;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  highlightedIds?: Set<string>;
  depth: number;
  defaultExpanded: boolean;
}) {
  // defaultExpanded змінюється ззовні при collapse/expand all → useState скидається
  const [expanded, setExpanded] = useState(defaultExpanded);
  const hasChildren = node.children.length > 0;
  const isSelected = selectedId === node.id;
  const isHighlighted = highlightedIds?.has(node.id) ?? false;
  const isInactive = node.isActive === false;

  const handleClick = useCallback(() => {
    if (isInactive) return;
    onSelect(isSelected ? null : node.id);
  }, [isInactive, isSelected, node.id, onSelect]);

  const handleToggle = useCallback((e: MouseEvent) => {
    e.stopPropagation();
    setExpanded(p => !p);
  }, []);

  return (
    <li>
      <div
        role="button"
        tabIndex={isInactive ? -1 : 0}
        aria-selected={isSelected}
        onClick={handleClick}
        onKeyDown={e => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleClick();
          }
        }}
        // Inline style замість динамічного `ml-${n}` — Tailwind JIT не сканує
        // інтерпольовані рядки, тож відступ не застосовувався б у production build.
        style={depth > 0 ? { marginLeft: `${Math.min(depth * 12, 36)}px` } : undefined}
        className={cn(
          'flex items-center gap-1 rounded-md px-2 py-1 text-[13px] cursor-pointer select-none transition-colors',
          isSelected && 'bg-primary text-primary-foreground',
          !isSelected && isHighlighted && 'bg-primary/10 text-primary',
          !isSelected && !isHighlighted && !isInactive && 'hover:bg-secondary text-foreground',
          isInactive && 'text-muted-foreground cursor-default opacity-50',
        )}
      >
        {/* Expand/collapse icon */}
        <span
          className="shrink-0 w-3.5 h-3.5 flex items-center justify-center"
          onClick={hasChildren ? handleToggle : undefined}
        >
          {hasChildren ? (
            expanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )
          ) : null}
        </span>
        <span className="flex-1 truncate leading-5">{node.name}</span>
      </div>

      {hasChildren && expanded && (
        <ul className="mt-0.5">
          {node.children.map(child => (
            <TreeNode
              key={child.id}
              node={child}
              selectedId={selectedId}
              onSelect={onSelect}
              highlightedIds={highlightedIds}
              depth={depth + 1}
              defaultExpanded={false}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// ─── Helper: всі ID вузла + нащадків (для фільтрації по піддереву) ────────────

export function collectDescendantIds(tree: CategoryNode[], id: string): string[] {
  const ids: string[] = [];
  function walk(nodes: CategoryNode[]) {
    for (const n of nodes) {
      if (n.id === id) {
        // знайшли — збираємо цей вузол і всіх нащадків
        function collect(node: CategoryNode) {
          ids.push(node.id);
          for (const c of node.children) collect(c);
        }
        collect(n);
        return true;
      }
      if (walk(n.children)) return true;
    }
    return false;
  }
  walk(tree);
  return ids;
}

// ─── CategoryTree ─────────────────────────────────────────────────────────────

export function CategoryTree({
  tree,
  selectedId,
  onSelect,
  onManage,
  label,
  highlightedIds,
  className,
}: CategoryTreeProps) {
  // allExpanded: true = всі розгорнуті, false = всі згорнуті, null = початковий стан
  const [allExpanded, setAllExpanded] = useState<boolean | null>(null);

  const toggleAll = useCallback(() => {
    setAllExpanded(p => (p === false ? true : false));
  }, []);

  // defaultExpanded для кожного TreeNode — визначається глобальним станом або авто-логікою
  const nodeDefault = allExpanded !== null ? allExpanded : tree.length <= 20;

  return (
    <aside
      className={cn(
        'flex flex-col w-48 shrink-0 rounded-xl border border-border bg-surface overflow-hidden ml-2',
        className,
      )}
    >
      {/* Header — висота та стилі як у TableHead (py-2 + text-[11px]) */}
      <div className="flex items-center justify-between gap-1 px-4 py-2 bg-secondary border-b border-border shrink-0">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-foreground-muted truncate">
          {label}
        </span>
        <div className="flex items-center gap-0.5 shrink-0 -mr-1">
          <button
            type="button"
            title={allExpanded === false ? 'Розгорнути всі' : 'Згорнути всі'}
            onClick={toggleAll}
            className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <ChevronsUpDown className="h-3.5 w-3.5" />
          </button>
          {onManage && (
            <button
              type="button"
              title="Управління категоріями"
              onClick={onManage}
              className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <Settings2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* "Всі" row */}
      <div className="px-2 pt-1.5 shrink-0">
        <div
          role="button"
          tabIndex={0}
          aria-selected={selectedId === null}
          onClick={() => onSelect(null)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onSelect(null);
            }
          }}
          className={cn(
            'flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] cursor-pointer select-none transition-colors',
            selectedId === null
              ? 'bg-primary text-primary-foreground'
              : 'hover:bg-secondary text-foreground',
          )}
        >
          <span className="w-3.5 shrink-0" />
          <span>Всі</span>
          {selectedId !== null && (
            <X
              className="h-3 w-3 ml-auto opacity-40 hover:opacity-100"
              onClick={e => {
                e.stopPropagation();
                onSelect(null);
              }}
            />
          )}
        </div>
      </div>

      {/* Tree — key на ul форсує remount TreeNode при зміні allExpanded */}
      <nav className="flex-1 overflow-y-auto px-2 pb-2 pt-1">
        {tree.length === 0 ? (
          <p className="px-2 py-3 text-[12px] text-muted-foreground text-center">
            Категорій не знайдено
          </p>
        ) : (
          <ul key={String(allExpanded)}>
            {tree.map(node => (
              <TreeNode
                key={node.id}
                node={node}
                selectedId={selectedId}
                onSelect={onSelect}
                highlightedIds={highlightedIds}
                depth={0}
                defaultExpanded={nodeDefault}
              />
            ))}
          </ul>
        )}
      </nav>
    </aside>
  );
}
