'use client';

import { useState, useCallback } from 'react';
import { ChevronRight, ChevronDown, Settings2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
  const [expanded, setExpanded] = useState(defaultExpanded);
  const hasChildren = node.children.length > 0;
  const isSelected = selectedId === node.id;
  const isHighlighted = highlightedIds?.has(node.id) ?? false;
  const isInactive = node.isActive === false;

  const handleClick = useCallback(() => {
    if (isInactive) return;
    onSelect(isSelected ? null : node.id);
  }, [isInactive, isSelected, node.id, onSelect]);

  const handleToggle = useCallback((e: React.MouseEvent) => {
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
        className={cn(
          'flex items-center gap-1 rounded-md px-2 py-1 text-[13px] cursor-pointer select-none transition-colors',
          depth > 0 && `ml-${Math.min(depth * 3, 9)}`,
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
  return (
    <aside
      className={cn(
        'flex flex-col w-52 shrink-0 border-l border-border bg-surface overflow-hidden',
        className,
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-1 px-3 py-2 border-b border-border shrink-0">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground truncate">
          {label}
        </span>
        {onManage && (
          <Button
            variant="ghost"
            size="icon-sm"
            title="Управління категоріями"
            onClick={onManage}
            className="shrink-0"
          >
            <Settings2 className="h-3.5 w-3.5" />
          </Button>
        )}
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

      {/* Tree */}
      <nav className="flex-1 overflow-y-auto px-2 pb-2 pt-1">
        {tree.length === 0 ? (
          <p className="px-2 py-3 text-[12px] text-muted-foreground text-center">
            Категорій не знайдено
          </p>
        ) : (
          <ul>
            {tree.map(node => (
              <TreeNode
                key={node.id}
                node={node}
                selectedId={selectedId}
                onSelect={onSelect}
                highlightedIds={highlightedIds}
                depth={0}
                defaultExpanded={tree.length <= 20}
              />
            ))}
          </ul>
        )}
      </nav>
    </aside>
  );
}
